const SUPPORTED_EXTENSIONS = [".flac", ".m4a"];
const INDEX_VERSION = 2;

function extensionOf(name) {
  const dot = String(name || "").lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

function isAudioFile(name) {
  return SUPPORTED_EXTENSIONS.includes(extensionOf(name));
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes).replace(/\0+$/, "");
}

function decodeBoxType(bytes) {
  return String.fromCharCode(...bytes);
}

function first(tags, ...names) {
  for (const name of names) {
    const values = tags.get(name.toLowerCase());
    if (values?.length) return values[0];
  }
  return null;
}

function addTag(tags, name, value) {
  if (!value) return;
  const key = name.toLowerCase();
  if (!tags.has(key)) tags.set(key, []);
  tags.get(key).push(value);
}

function metadataFromTags(file, tags) {
  const date = first(tags, "date", "©day");
  return {
    filename: file.name,
    title: first(tags, "title", "©nam") || file.name.replace(/\.[^.]+$/, ""),
    track_mbid: first(tags, "musicbrainz_trackid", "musicbrainz track id"),
    release_track_mbid: first(
      tags,
      "musicbrainz_releasetrackid",
      "musicbrainz release track id"
    ),
    album_mbid: first(tags, "musicbrainz_albumid", "musicbrainz album id"),
    album_name: first(tags, "album", "©alb"),
    artist_name: first(tags, "albumartist", "aart", "artist", "©art"),
    release_year: date ? date.slice(0, 4) : null,
    country: first(tags, "releasecountry", "musicbrainz album release country"),
    label: first(tags, "label", "organization"),
    media_format: first(tags, "media"),
  };
}

async function readBytes(file, start, length) {
  const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
  if (bytes.length !== length) throw new Error("The file ended unexpectedly.");
  return bytes;
}

function uint32be(bytes, offset = 0) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function uint32le(bytes, offset = 0) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function uint64be(bytes, offset = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = (BigInt(view.getUint32(offset)) << 32n) | BigInt(view.getUint32(offset + 4));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("MP4 box is too large.");
  return Number(value);
}

async function readFlacTags(file) {
  const signature = decodeUtf8(await readBytes(file, 0, 4));
  if (signature !== "fLaC") throw new Error("Not a valid FLAC file.");

  const tags = new Map();
  const technical = { codec: "FLAC", bit_depth: null, sample_rate: null, bitrate: null, channels: null };
  let position = 4;
  let isLast = false;

  while (!isLast) {
    const header = await readBytes(file, position, 4);
    position += 4;
    isLast = Boolean(header[0] & 0x80);
    const blockType = header[0] & 0x7f;
    const blockSize = (header[1] << 16) | (header[2] << 8) | header[3];

    if (blockType === 0) {
      const block = await readBytes(file, position, blockSize);
      if (block.length >= 18) {
        let packed = 0n;
        for (const byte of block.subarray(10, 18)) packed = (packed << 8n) | BigInt(byte);
        technical.sample_rate = Number((packed >> 44n) & 0xfffffn);
        technical.channels = Number((packed >> 41n) & 0x7n) + 1;
        technical.bit_depth = Number((packed >> 36n) & 0x1fn) + 1;
      }
      position += blockSize;
      continue;
    }

    if (blockType !== 4) {
      // Includes PICTURE (type 6): advance by size without reading its bytes.
      position += blockSize;
      continue;
    }

    const block = await readBytes(file, position, blockSize);
    let offset = 0;
    const vendorSize = uint32le(block, offset);
    offset += 4 + vendorSize;
    const commentCount = uint32le(block, offset);
    offset += 4;

    for (let index = 0; index < commentCount; index += 1) {
      const commentSize = uint32le(block, offset);
      offset += 4;
      const comment = decodeUtf8(block.subarray(offset, offset + commentSize));
      offset += commentSize;
      const equals = comment.indexOf("=");
      if (equals > 0) addTag(tags, comment.slice(0, equals), comment.slice(equals + 1));
    }
    position += blockSize;
  }

  return { tags, technical };
}

async function readMp4Box(file, position, end) {
  if (position + 8 > end) return null;
  const header = await readBytes(file, position, 8);
  const size32 = uint32be(header);
  const type = decodeBoxType(header.subarray(4, 8));
  let headerSize = 8;
  let size = size32;

  if (size32 === 1) {
    size = uint64be(await readBytes(file, position + 8, 8));
    headerSize = 16;
  } else if (size32 === 0) {
    size = end - position;
  }

  if (size < headerSize || position + size > end) {
    throw new Error("Invalid MP4 box structure.");
  }
  return { type, start: position + headerSize, end: position + size, next: position + size };
}

async function findIlst(file, start = 0, end = file.size, containerType = "") {
  let position = containerType === "meta" ? start + 4 : start;
  while (position + 8 <= end) {
    const box = await readMp4Box(file, position, end);
    if (!box) break;
    if (box.type === "ilst") return box;
    if (["moov", "udta", "meta"].includes(box.type)) {
      const found = await findIlst(file, box.start, box.end, box.type);
      if (found) return found;
    }
    position = box.next;
  }
  return null;
}

async function findChildPayload(file, start, end, wantedType) {
  let position = start;
  while (position + 8 <= end) {
    const box = await readMp4Box(file, position, end);
    if (!box) break;
    if (box.type === wantedType) return readBytes(file, box.start, box.end - box.start);
    position = box.next;
  }
  return null;
}

async function listChildBoxes(file, start, end) {
  const boxes = [];
  let position = start;
  while (position + 8 <= end) {
    const box = await readMp4Box(file, position, end);
    if (!box) break;
    boxes.push(box);
    position = box.next;
  }
  return boxes;
}

async function findDirectChild(file, start, end, wantedType) {
  const boxes = await listChildBoxes(file, start, end);
  return boxes.find((box) => box.type === wantedType) || null;
}

async function readM4aTechnical(file) {
  const technical = { codec: null, bit_depth: null, sample_rate: null, bitrate: null, channels: null };
  const moov = await findDirectChild(file, 0, file.size, "moov");
  if (!moov) return technical;

  const tracks = (await listChildBoxes(file, moov.start, moov.end))
    .filter((box) => box.type === "trak");

  for (const track of tracks) {
    const mdia = await findDirectChild(file, track.start, track.end, "mdia");
    if (!mdia) continue;
    const handler = await findDirectChild(file, mdia.start, mdia.end, "hdlr");
    if (!handler || handler.end - handler.start < 12) continue;
    const handlerData = await readBytes(file, handler.start, 12);
    if (decodeBoxType(handlerData.subarray(8, 12)) !== "soun") continue;

    const minf = await findDirectChild(file, mdia.start, mdia.end, "minf");
    const stbl = minf ? await findDirectChild(file, minf.start, minf.end, "stbl") : null;
    const stsd = stbl ? await findDirectChild(file, stbl.start, stbl.end, "stsd") : null;
    if (!stsd || stsd.start + 16 > stsd.end) continue;

    const entry = await readMp4Box(file, stsd.start + 8, stsd.end);
    if (!entry) continue;
    technical.codec = entry.type === "alac" ? "ALAC" : entry.type === "mp4a" ? "AAC" : entry.type.toUpperCase();

    const sampleEntry = await readBytes(file, entry.start, Math.min(28, entry.end - entry.start));
    if (sampleEntry.length >= 28) {
      technical.channels = new DataView(sampleEntry.buffer, sampleEntry.byteOffset, sampleEntry.byteLength).getUint16(16) || null;
      technical.bit_depth = new DataView(sampleEntry.buffer, sampleEntry.byteOffset, sampleEntry.byteLength).getUint16(18) || null;
      technical.sample_rate = uint32be(sampleEntry, 24) >>> 16 || null;
    }

    if (entry.type === "alac" && entry.start + 28 < entry.end) {
      const alac = await findDirectChild(file, entry.start + 28, entry.end, "alac");
      if (alac) {
        const config = await readBytes(file, alac.start, Math.min(28, alac.end - alac.start));
        if (config.length >= 28 && config[8] === 0) {
          technical.bit_depth = config[9];
          technical.channels = config[13];
          technical.bitrate = uint32be(config, 20) || null;
          technical.sample_rate = uint32be(config, 24) || null;
        }
      }
    }
    return technical;
  }

  return technical;
}

function decodeMp4Data(payload) {
  return payload?.length >= 8 ? decodeUtf8(payload.subarray(8)) : null;
}

async function readM4aTags(file) {
  const tags = new Map();
  const [ilst, technical] = await Promise.all([findIlst(file), readM4aTechnical(file)]);
  if (!ilst) return { tags, technical };

  const textAtoms = new Map([
    ["©nam", "©nam"],
    ["©alb", "©alb"],
    ["aART", "aart"],
    ["©ART", "©art"],
    ["©day", "©day"],
  ]);

  let position = ilst.start;
  while (position + 8 <= ilst.end) {
    const atom = await readMp4Box(file, position, ilst.end);
    if (!atom) break;

    if (atom.type === "covr") {
      position = atom.next;
      continue;
    }

    if (textAtoms.has(atom.type)) {
      const payload = await findChildPayload(file, atom.start, atom.end, "data");
      addTag(tags, textAtoms.get(atom.type), decodeMp4Data(payload));
    } else if (atom.type === "----") {
      const children = await listChildBoxes(file, atom.start, atom.end);
      const nameBox = children.find((box) => box.type === "name");
      const dataBox = children.find((box) => box.type === "data");
      const [namePayload, dataPayload] = await Promise.all([
        nameBox ? readBytes(file, nameBox.start, nameBox.end - nameBox.start) : null,
        dataBox ? readBytes(file, dataBox.start, dataBox.end - dataBox.start) : null,
      ]);
      if (namePayload?.length >= 4) {
        addTag(tags, decodeUtf8(namePayload.subarray(4)), decodeMp4Data(dataPayload));
      }
    }
    position = atom.next;
  }

  return { tags, technical };
}

async function readMetadata(file) {
  const extension = extensionOf(file.name);
  const { tags, technical } = extension === ".flac"
    ? await readFlacTags(file)
    : await readM4aTags(file);
  return { ...metadataFromTags(file, tags), ...technical };
}

function folderOf(path) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
}

function fallbackAlbumNames(folderPath) {
  const parts = folderPath.split("/").filter((part) => part && part !== ".");
  return {
    album: parts.at(-1) || "Unknown album",
    artist: parts.at(-2) || "Unknown artist",
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function groupAudioEntries(filesByPath) {
  const folders = new Map();
  const audioEntries = [...filesByPath.entries()]
    .filter(([, file]) => isAudioFile(file.name))
    .sort(([pathA], [pathB]) => pathA.localeCompare(pathB));

  for (const [relativePath, file] of audioEntries) {
    const folderPath = folderOf(relativePath);
    if (!folders.has(folderPath)) folders.set(folderPath, []);
    folders.get(folderPath).push({ relativePath, file });
  }

  return { audioEntries, folders };
}

async function loadExistingLibrary(filesByPath) {
  const indexFile = filesByPath.get("library.json");
  if (!indexFile) return { albumsByFolder: new Map(), warning: "" };

  try {
    const library = JSON.parse(await indexFile.text());
    if (!Array.isArray(library)) {
      throw new Error("the top-level JSON value is not an array");
    }
    return {
      albumsByFolder: new Map(
        library
          .filter((album) => album && typeof album === "object" && album.folder_path)
          .map((album) => [album.folder_path, album])
      ),
      warning: "",
    };
  } catch (error) {
    return {
      albumsByFolder: new Map(),
      warning: `Existing index cannot be reused; rebuilding it (${error?.message || error})`,
    };
  }
}

function fileModifiedNs(file) {
  // File.lastModified has millisecond precision. Keep the v2 field in
  // nanoseconds so indexes made by the browser, Python and MusiCards share
  // the same schema. Values are compared with a one-millisecond tolerance.
  return Number(BigInt(Math.trunc(file.lastModified)) * 1_000_000n);
}

function albumIsUnchanged(album, audioEntries) {
  if (album?.index_version !== INDEX_VERSION) return false;
  if (!Array.isArray(album.tracks) || album.tracks.length !== audioEntries.length) return false;

  const tracksByName = new Map(
    album.tracks
      .filter((track) => track && typeof track === "object" && track.filename)
      .map((track) => [track.filename, track])
  );
  if (tracksByName.size !== audioEntries.length) return false;

  return audioEntries.every(({ file }) => {
    const track = tracksByName.get(file.name);
    if (!track || track.file_size !== file.size || track.modified_ns == null) return false;

    try {
      const oldNanoseconds = BigInt(Math.trunc(Number(track.modified_ns)));
      const newNanoseconds = BigInt(Math.trunc(file.lastModified)) * 1_000_000n;
      const difference = oldNanoseconds >= newNanoseconds
        ? oldNanoseconds - newNanoseconds
        : newNanoseconds - oldNanoseconds;
      return difference <= 1_000_000n;
    } catch {
      return false;
    }
  });
}

export async function buildLibraryIndex(filesByPath, onProgress = () => {}) {
  const startedAt = performance.now();
  const { audioEntries, folders } = groupAudioEntries(filesByPath);
  const existing = await loadExistingLibrary(filesByPath);
  const warnings = existing.warning ? [existing.warning] : [];
  const libraryByFolder = new Map();
  const entriesToIndex = [];
  let completed = 0;
  let reusedAlbumCount = 0;

  for (const [folderPath, folderEntries] of folders) {
    const existingAlbum = existing.albumsByFolder.get(folderPath);
    if (existingAlbum && albumIsUnchanged(existingAlbum, folderEntries)) {
      libraryByFolder.set(folderPath, existingAlbum);
      reusedAlbumCount += 1;
      for (const { relativePath } of folderEntries) {
        completed += 1;
        onProgress(completed, audioEntries.length, relativePath);
      }
    } else {
      entriesToIndex.push(...folderEntries);
    }
  }

  const concurrency = Math.min(8, Math.max(4, navigator.hardwareConcurrency || 4));
  const indexedFiles = await mapWithConcurrency(
    entriesToIndex,
    concurrency,
    async ({ relativePath, file }) => {
      let metadata = null;
      let error = null;
      try {
        metadata = await readMetadata(file);
      } catch (caughtError) {
        error = caughtError;
      }
      completed += 1;
      onProgress(completed, audioEntries.length, relativePath);
      return { relativePath, file, metadata, error };
    }
  );

  const indexedByFolder = new Map();
  for (const entry of indexedFiles) {
    const { relativePath } = entry;
    const folderPath = folderOf(relativePath);
    if (!indexedByFolder.has(folderPath)) indexedByFolder.set(folderPath, []);
    indexedByFolder.get(folderPath).push(entry);
  }

  for (const [folderPath, folderEntries] of indexedByFolder) {
    const readableEntries = folderEntries.filter(({ relativePath, error }) => {
      if (!error) return true;
      warnings.push(`Could not read, skipped: ${relativePath} (${error?.message || error})`);
      return false;
    });
    if (!readableEntries.length) continue;

    const album = readableEntries[0].metadata;
    if (!album.album_mbid) {
      warnings.push(`Skipped (Release MBID is missing): ${folderPath}`);
      continue;
    }

    const matchingEntries = readableEntries.filter(({ relativePath, metadata }) => {
      if (!metadata.album_mbid || metadata.album_mbid.toLowerCase() === album.album_mbid.toLowerCase()) {
        return true;
      }
      warnings.push(`Skipped (Release MBID differs from its folder): ${relativePath}`);
      return false;
    });
    const fallback = fallbackAlbumNames(folderPath);
    libraryByFolder.set(folderPath, {
      index_version: INDEX_VERSION,
      album_name: album.album_name || fallback.album,
      artist_name: album.artist_name || fallback.artist,
      album_mbid: album.album_mbid,
      release_year: album.release_year,
      country: album.country,
      label: album.label,
      media_format: album.media_format,
      folder_path: folderPath,
      tracks: matchingEntries.map(({ file, metadata }) => ({
        filename: metadata.filename,
        title: metadata.title,
        track_mbid: metadata.track_mbid,
        release_track_mbid: metadata.release_track_mbid,
        codec: metadata.codec,
        bit_depth: metadata.bit_depth,
        sample_rate: metadata.sample_rate,
        bitrate: metadata.bitrate,
        channels: metadata.channels,
        file_size: file.size,
        modified_ns: fileModifiedNs(file),
        modified_at: new Date(file.lastModified).toISOString(),
      })),
    });
  }

  const library = [...folders.keys()]
    .map((folderPath) => libraryByFolder.get(folderPath))
    .filter(Boolean);

  return {
    library,
    warnings,
    audioFileCount: audioEntries.length,
    reusedAlbumCount,
    elapsedSeconds: (performance.now() - startedAt) / 1000,
  };
}

async function collectDirectoryHandle(directoryHandle) {
  const files = new Map();
  async function walk(handle, prefix = "") {
    for await (const [name, entry] of handle.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === "directory") await walk(entry, path);
      else files.set(path, await entry.getFile());
    }
  }
  await walk(directoryHandle);
  return files;
}

export async function chooseWritableMusicFolder() {
  if (typeof window.showDirectoryPicker !== "function") return null;
  const directoryHandle = await window.showDirectoryPicker({
    id: "musicbrainz-explorer-music",
    mode: "readwrite",
    startIn: "music",
  });
  return { directoryHandle, filesByPath: await collectDirectoryHandle(directoryHandle) };
}

export function collectInputFiles(fileList) {
  const files = new Map();
  for (const file of Array.from(fileList || [])) {
    const parts = String(file.webkitRelativePath || file.name).split("/").filter(Boolean);
    const relativePath = parts.length > 1 ? parts.slice(1).join("/") : parts.join("/");
    if (relativePath) files.set(relativePath, file);
  }
  return files;
}

export async function saveIndexToDirectory(directoryHandle, json) {
  const fileHandle = await directoryHandle.getFileHandle("library.json", { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(json);
  await writable.close();
}

export async function saveIndexWithFilePicker(json) {
  if (typeof window.showSaveFilePicker !== "function") return false;
  const fileHandle = await window.showSaveFilePicker({
    id: "musicbrainz-explorer-library-index",
    suggestedName: "library.json",
    types: [{
      description: "MusicBrainz Explorer library index",
      accept: { "application/json": [".json"] },
    }],
  });
  const writable = await fileHandle.createWritable();
  await writable.write(json);
  await writable.close();
  return true;
}

export function downloadIndex(json) {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "library.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
