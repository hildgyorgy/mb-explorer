/* ============================================================
   Local library: user-approved folder access and file registry
   ============================================================ */

import {
  buildLibraryIndex,
  chooseWritableMusicFolder,
  collectInputFiles,
  downloadIndex,
  saveIndexToDirectory,
  saveIndexWithFilePicker,
} from "./browserIndexer.js";

let selectedFilesByPath = new Map();
let selectedLibrary = null;
let libraryError = "";
let localAlbumsByMbid = new Map();
let localTracksByRelease = new Map();

function mbidKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRelativePath(file) {
  const raw = String(file?.webkitRelativePath || file?.name || "");
  const parts = raw.split("/").filter(Boolean);

  // Folder inputs include the selected root folder as the first segment.
  return parts.length > 1 ? parts.slice(1).join("/") : parts.join("/");
}

function storeSelectedFiles(fileList) {
  const next = new Map();

  for (const file of Array.from(fileList || [])) {
    const path = normalizeRelativePath(file);
    if (path) next.set(path, file);
  }

  selectedFilesByPath = next;
  return selectedFilesByPath.size;
}

function storeSelectedFileMap(filesByPath) {
  selectedFilesByPath = new Map(filesByPath || []);
  return selectedFilesByPath.size;
}

function rebuildLocalIndex() {
  localAlbumsByMbid = new Map();
  localTracksByRelease = new Map();

  for (const album of selectedLibrary || []) {
    const releaseKey = mbidKey(album.album_mbid);
    if (!releaseKey) continue;

    localAlbumsByMbid.set(releaseKey, album);
    const tracksByRecording = new Map();
    const tracksByReleaseTrack = new Map();

    for (const track of album.tracks || []) {
      const recordingKey = mbidKey(track.track_mbid);
      const relativePath = [album.folder_path, track.filename]
        .filter(Boolean)
        .join("/");
      const localTrack = {
        album,
        track,
        relativePath,
        file: getLocalFile(relativePath),
      };

      const releaseTrackKey = mbidKey(track.release_track_mbid);
      if (releaseTrackKey && !tracksByReleaseTrack.has(releaseTrackKey)) {
        tracksByReleaseTrack.set(releaseTrackKey, localTrack);
      }
      if (recordingKey && !tracksByRecording.has(recordingKey)) {
        tracksByRecording.set(recordingKey, localTrack);
      }
    }

    localTracksByRelease.set(releaseKey, { tracksByReleaseTrack, tracksByRecording });
  }
}

function summarizeLibrary(albums) {
  const trackCount = albums.reduce(
    (total, album) => total + (Array.isArray(album?.tracks) ? album.tracks.length : 0),
    0
  );

  return { albumCount: albums.length, trackCount };
}

function validateLibrary(data) {
  if (!Array.isArray(data)) {
    throw new Error("library.json must contain an array of albums.");
  }

  const invalidAlbum = data.find(
    (album) => !album || typeof album !== "object" || !Array.isArray(album.tracks)
  );
  if (invalidAlbum) {
    throw new Error("At least one album in library.json has no valid tracks list.");
  }

  return data;
}

async function loadLibraryJson() {
  const file = selectedFilesByPath.get("library.json");
  if (!file) throw new Error("No library.json found in the selected folder.");

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("library.json is not valid JSON.");
  }

  return validateLibrary(data);
}

function statusText() {
  if (libraryError) return libraryError;
  if (!selectedLibrary) return "Your Music folder is not connected.";

  const { albumCount, trackCount } = summarizeLibrary(selectedLibrary);
  return `Connected: ${albumCount.toLocaleString()} albums, ${trackCount.toLocaleString()} tracks · ${selectedFilesByPath.size.toLocaleString()} files available for playing.`;
}

function renderStatus(status) {
  status.textContent = statusText();
  status.classList.toggle("err", !!libraryError);
}

function renderLibraryList(container) {
  container.replaceChildren();

  if (!selectedLibrary?.length) {
    container.hidden = true;
    return;
  }

  const albums = [...selectedLibrary].sort((a, b) => {
    const artistOrder = String(a.artist_name || "").localeCompare(
      String(b.artist_name || ""),
      undefined,
      { sensitivity: "base" }
    );
    if (artistOrder) return artistOrder;
    return String(a.album_name || "").localeCompare(
      String(b.album_name || ""),
      undefined,
      { sensitivity: "base" }
    );
  });

  const list = document.createElement("ul");
  for (const album of albums) {
    const item = document.createElement("li");
    const artist = String(album.artist_name || "Unknown artist");
    const title = String(album.album_name || "Untitled album");
    item.textContent = `${artist} : ${title}`;
    list.appendChild(item);
  }

  container.appendChild(list);
  container.hidden = false;
}

export function getLocalFile(relativePath) {
  return selectedFilesByPath.get(String(relativePath || "")) || null;
}

export function getLocalLibrary() {
  return selectedLibrary;
}

export function getLocalAlbum(releaseMbid) {
  return localAlbumsByMbid.get(mbidKey(releaseMbid)) || null;
}

export function getLocalTrack(releaseMbid, recordingMbid, releaseTrackMbid = "") {
  const tracks = localTracksByRelease.get(mbidKey(releaseMbid));
  if (!tracks) return null;

  return (
    tracks.tracksByReleaseTrack.get(mbidKey(releaseTrackMbid)) ||
    tracks.tracksByRecording.get(mbidKey(recordingMbid)) ||
    null
  );
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function searchTokens(value) {
  return normalizeSearchText(value).split(" ").filter(Boolean);
}

function includesEvery(haystack, tokens) {
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function scoreLocalAlbum(album, query) {
  const artist = normalizeSearchText(album.artist_name);
  const title = normalizeSearchText(album.album_name);
  const tracks = (album.tracks || []).map((track) => ({
    title: String(track?.title || track?.filename || ""),
    normalized: normalizeSearchText(track?.title || track?.filename),
  }));

  const commaIndex = query.indexOf(",");
  let matches = false;

  if (commaIndex !== -1) {
    const artistTokens = searchTokens(query.slice(0, commaIndex));
    const releaseTokens = searchTokens(query.slice(commaIndex + 1));
    const artistMatches = !artistTokens.length || includesEvery(artist, artistTokens);
    const releaseMatches =
      !releaseTokens.length ||
      includesEvery(title, releaseTokens) ||
      tracks.some((track) => includesEvery(track.normalized, releaseTokens));

    matches = artistMatches && releaseMatches && (artistTokens.length > 0 || releaseTokens.length > 0);
  } else {
    const tokens = searchTokens(query);
    const allText = `${artist} ${title} ${tracks.map((track) => track.normalized).join(" ")}`;
    matches = includesEvery(allText, tokens);
  }

  if (!matches) return null;

  const normalizedQuery = normalizeSearchText(query.replace(",", " "));
  let score = 10;
  if (title === normalizedQuery) score += 100;
  if (artist === normalizedQuery) score += 80;
  if (title.startsWith(normalizedQuery)) score += 40;
  if (artist.startsWith(normalizedQuery)) score += 30;

  const trackNeedle = normalizeSearchText(
    commaIndex !== -1 ? query.slice(commaIndex + 1) : query
  );
  const matchingTrack = trackNeedle
    ? tracks.find((track) => track.normalized.includes(trackNeedle))
    : null;
  if (matchingTrack) score += 20;

  return { score, matchingTrack: matchingTrack?.title || "" };
}

export function searchLocalLibrary(query, limit = 50) {
  if (!selectedLibrary) return [];

  return selectedLibrary
    .map((album) => ({ album, match: scoreLocalAlbum(album, String(query || "").trim()) }))
    .filter((item) => item.match && item.album.album_mbid)
    .sort((a, b) => b.match.score - a.match.score)
    .slice(0, limit)
    .map(({ album }) => {
      const artist = String(album.artist_name || "Unknown artist");
      const title = String(album.album_name || "Untitled album");
      const metadata = [
        album.release_year,
        album.country,
        album.label,
        album.media_format,
      ].filter(Boolean);

      return {
        mbid: album.album_mbid,
        title: `${artist} — ${title}`,
        sub: metadata.join(" · "),
        source: "local",
      };
    });
}

export function bindLocalLibraryPicker(root = document) {
  const button = root.getElementById("openMusicFolder");
  const indexButton = root.getElementById("createLibraryIndex");
  const input = root.getElementById("musicFolderInput");
  const indexInput = root.getElementById("indexMusicFolderInput");
  const status = root.getElementById("musicFolderStatus");
  const list = root.getElementById("localLibraryList");

  if (!button || !indexButton || !input || !indexInput || !status || !list || button.dataset.bound === "1") return;
  button.dataset.bound = "1";
  renderStatus(status);
  renderLibraryList(list);

  button.addEventListener("click", () => input.click());

  input.addEventListener("change", async () => {
    storeSelectedFiles(input.files);
    selectedLibrary = null;
    rebuildLocalIndex();
    libraryError = "";
    status.classList.remove("err");
    status.textContent = "Reading library.json…";

    try {
      selectedLibrary = await loadLibraryJson();
      rebuildLocalIndex();
    } catch (error) {
      rebuildLocalIndex();
      libraryError = error?.message || "Could not read library.json.";
    }

    renderStatus(status);
    renderLibraryList(list);
  });

  async function createIndex(filesByPath, directoryHandle = null) {
    libraryError = "";
    status.classList.remove("err");
    indexButton.disabled = true;

    try {
      const result = await buildLibraryIndex(filesByPath, (current, total) => {
        status.textContent = `Indexing ${current.toLocaleString()} of ${total.toLocaleString()} audio files…`;
      });
      const json = `${JSON.stringify(result.library, null, 4)}\n`;
      const reused = result.reusedAlbumCount
        ? ` ${result.reusedAlbumCount.toLocaleString()} unchanged albums reused.`
        : "";
      const summary = `${result.library.length.toLocaleString()} albums and ${result.audioFileCount.toLocaleString()} audio files indexed in ${result.elapsedSeconds.toFixed(2)} seconds.${reused}`;
      const approved = window.confirm(`${summary}\n\nSave library.json now?`);

      if (!approved) {
        status.textContent = `Index created but not saved.\n${summary}`;
        return;
      }

      if (directoryHandle) {
        await saveIndexToDirectory(directoryHandle, json);
        status.textContent = `library.json saved in the selected Music folder.\n${summary}`;
      } else {
        const savedWithPicker = await saveIndexWithFilePicker(json);
        if (savedWithPicker) {
          status.textContent = `library.json saved. Keep it in the selected Music folder.\n${summary}`;
        } else {
          downloadIndex(json);
          status.textContent = `Place the downloaded library.json file in the selected Music folder.\n${summary}`;
        }
      }

      storeSelectedFileMap(filesByPath);
      selectedLibrary = validateLibrary(result.library);
      rebuildLocalIndex();
      renderLibraryList(list);
      if (result.warnings.length) console.warn("Library index warnings:", result.warnings);
    } catch (error) {
      if (error?.name === "AbortError") return;
      libraryError = error?.message || "Could not create library.json.";
      renderStatus(status);
    } finally {
      indexButton.disabled = false;
      indexInput.value = "";
    }
  }

  indexButton.addEventListener("click", async () => {
    if (typeof window.showDirectoryPicker !== "function") {
      indexInput.click();
      return;
    }
    try {
      const selection = await chooseWritableMusicFolder();
      if (selection) await createIndex(selection.filesByPath, selection.directoryHandle);
    } catch (error) {
      if (error?.name !== "AbortError") {
        libraryError = error?.message || "Could not open the Music folder.";
        renderStatus(status);
      }
    }
  });

  indexInput.addEventListener("change", async () => {
    if (indexInput.files?.length) {
      await createIndex(collectInputFiles(indexInput.files));
    }
  });
}
