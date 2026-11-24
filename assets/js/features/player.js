/* ============================================================
   Browser and remote playback
   ============================================================ */

import { getActiveLibrarySource, onLibrarySourceChange } from "../core/librarySource.js";
import { getRenderer, setCurrentAndNext, setNext, playRenderer, callRenderer, getRendererState, getRendererVolume, setRendererVolume, stopBridgeRenderer, didlMetadata } from "../services/upnpRenderer.js";

const audio = new Audio();
let objectUrl = "";
let currentIndex = -1;
let currentOut = null;
let currentTracks = [];
let viewedTracks = [];
let miniPlayer = null;
let viewedCoverImages = null;
let currentCoverImages = null;
let remotePlaying = false;
let remoteStateTimer = null;
let remoteCurrentTime = 0;
let remoteDuration = 0;
let activeRemoteRenderer = null;
let activeLocalSource = null;
let remoteSessionId = 0;
let pendingRemoteStop = Promise.resolve();
let remoteCommandInFlight = Promise.resolve();
let remoteSeekPreview = null;
let volumeRequestId = 0;
let volumeLevel = null;

function playbackSource(entry) {
  const localTrack = entry?.localTrack;
  if (localTrack?.file) return { kind: "file", value: localTrack.file };
  if (localTrack?.playbackUrl) return { kind: "url", value: localTrack.playbackUrl };
  return null;
}

function remotePlaybackEnabled(entry) {
  return getActiveLibrarySource() === "navidrome" &&
    getRenderer()?.mode === "bridge" &&
    !!entry?.localTrack?.playbackUrl;
}

function remoteItem(entry) {
  const track = entry.localTrack?.track || {};
  const album = entry.localTrack?.album || {};
  const uri = entry.localTrack.playbackUrl;
  const rendererUri = entry.localTrack.rendererPlaybackUrl || "";
  return {
    uri,
    ...(rendererUri ? { rendererUri } : {}),
    metadata: didlMetadata({
      id: track.providerItemId || track.track_mbid || track.recording_mbid || uri,
      title: entry.title || track.title || "Navidrome track",
      artist: entry.artist || album.artist_name || track.artist || "",
      album: album.album_name || track.album || "",
      mime: track.contentType || "audio/flac",
      duration: didlDuration(track.duration),
    }, uri),
  };
}

function didlDuration(value) {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

const ICONS = {
  previous: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14M18 6l-8 6 8 6V6z"/></svg>`,
  play: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM14 5h4v14h-4z"/></svg>`,
  next: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 5v14M6 6l8 6-8 6V6z"/></svg>`,
  volume: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3zm12.5-1.5-1.4 1.4a4.5 4.5 0 0 1 0 6.2l1.4 1.4a6.5 6.5 0 0 0 0-9zm2.8-2.8-1.4 1.4a8.5 8.5 0 0 1 0 11.8l1.4 1.4a10.5 10.5 0 0 0 0-14.6z"/></svg>`,
};

function volumePercent(value, minimum, maximum) {
  return Math.round((value - minimum) * 100 / (maximum - minimum));
}

function closeRendererVolume() {
  volumeRequestId += 1;
  volumeLevel = null;
  const control = miniPlayer?.querySelector(".mini-player-volume");
  if (!control) return;
  control.querySelector(".mini-player-volume-popover").hidden = true;
  control.querySelector(".mini-player-volume-button").setAttribute("aria-expanded", "false");
}

async function openRendererVolume() {
  const target = getRenderer();
  if (target?.mode !== "bridge" || !target.renderingControlUrl) return;
  const control = miniPlayer.querySelector(".mini-player-volume");
  const slider = control.querySelector(".mini-player-volume-range");
  const status = control.querySelector(".mini-player-volume-status");
  const popover = control.querySelector(".mini-player-volume-popover");
  const requestId = ++volumeRequestId;
  popover.hidden = false;
  control.querySelector(".mini-player-volume-button").setAttribute("aria-expanded", "true");
  slider.disabled = true;
  status.textContent = "Loading volume…";
  try {
    const result = await getRendererVolume(target);
    if (requestId !== volumeRequestId) return;
    const minimum = Number(result.min);
    const maximum = Number(result.max);
    const current = Number(result.volume);
    if (!Number.isInteger(minimum) || !Number.isInteger(maximum) ||
        !Number.isInteger(current) || minimum >= maximum) {
      throw new Error("Invalid volume response");
    }
    slider.min = String(minimum);
    slider.max = String(maximum);
    slider.value = String(Math.max(minimum, Math.min(maximum, current)));
    volumeLevel = Number(slider.value);
    slider.disabled = false;
    control.querySelector(".mini-player-volume-value").textContent =
      `${volumePercent(volumeLevel, minimum, maximum)}%`;
    status.textContent = "";
  } catch (error) {
    if (requestId !== volumeRequestId) return;
    status.textContent = "Volume unavailable";
    console.warn("Could not read UPnP volume:", error);
  }
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatSampleRate(sampleRate) {
  const value = Number(sampleRate);
  if (!Number.isFinite(value) || value <= 0) return "";
  const kilohertz = value / 1000;
  return `${Number.isInteger(kilohertz) ? kilohertz : kilohertz.toFixed(1)} kHz`;
}

function formatChannels(channels) {
  const value = Number(channels);
  if (!Number.isInteger(value) || value <= 0) return "";
  if (value === 1) return "MONO";
  if (value === 2) return "STEREO";
  return `${value} CHANNELS`;
}

function formatSourceQuality(track) {
  const codec = String(track?.codec || "").toUpperCase();
  const sampleRate = formatSampleRate(track?.sample_rate);
  const bitDepth = Number(track?.bit_depth);
  const bitrate = Number(track?.bitrate);
  const channels = formatChannels(track?.channels);
  const details = [];

  if (codec === "AAC") {
    if (Number.isFinite(bitrate) && bitrate > 0) {
      details.push(`${Math.round(bitrate / 1000)} kbps`);
    }
  } else if (Number.isFinite(bitDepth) && bitDepth > 0) {
    details.push(`${bitDepth}-bit`);
  }
  if (sampleRate) details.push(sampleRate);

  const quality = [codec, details.join(" / ")].filter(Boolean).join(" · ");
  return [quality, channels].filter(Boolean).join(" • ");
}

function formatArtistAlbum(entry) {
  const artist = entry?.artist || entry?.localTrack?.album?.artist_name ||
    entry?.localTrack?.track?.artist || "";
  const album = entry?.localTrack?.album?.album_name ||
    entry?.localTrack?.track?.album || "";
  return [artist, album].filter(Boolean).join(": ");
}

function formatOutput(entry) {
  if (remotePlaybackEnabled(entry)) {
    return getRenderer()?.friendlyName || "UPnP renderer";
  }
  return "System audio";
}

/* ============================================================
   Media Session — surfaces now-playing info to the OS
   (Control Center, lock screen, AirPlay receivers, etc.)
   ============================================================ */

function mediaSessionSupported() {
  return "mediaSession" in navigator;
}

function buildArtwork(coverImages) {
  const thumb = coverImages?.thumb || "";
  const large = coverImages?.large || coverImages?.full || "";
  const full = coverImages?.full || "";
  const artwork = [];
  const sources = new Set();

  const addArtwork = (src, sizes = "") => {
    if (!src || sources.has(src)) return;
    sources.add(src);
    artwork.push({
      src,
      ...(sizes ? { sizes, type: "image/jpeg" } : {}),
    });
  };

  // Cover Art Archive's deprecated small/large aliases are 250 and 500 px.
  // When an API fallback points at the original image, omit the size hint.
  if (thumb !== large && thumb !== full) addArtwork(thumb, "250x250");
  if (large !== full) addArtwork(large, "500x500");
  addArtwork(full);
  if (!artwork.length) addArtwork(large || thumb);

  return artwork;
}

function updateMediaSessionMetadata(entry) {
  if (!mediaSessionSupported() || typeof MediaMetadata !== "function") return;

  const title = entry?.title || entry?.localTrack?.track?.title || entry?.localTrack?.file?.name || "";
  const artist = entry?.artist || entry?.localTrack?.album?.artist_name || "";
  const album = entry?.localTrack?.album?.album_name || "";

  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist,
    album,
    artwork: buildArtwork(currentCoverImages),
  });
}

function updateMediaSessionPlaybackState(state) {
  if (!mediaSessionSupported()) return;
  navigator.mediaSession.playbackState = state;
}

function updateMediaSessionPositionState() {
  if (!mediaSessionSupported() || !("setPositionState" in navigator.mediaSession)) return;

  const duration = audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;

  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, duration),
    });
  } catch (error) {
    // Some browsers reject calls made while metadata/duration is still settling — safe to ignore.
  }
}

function bindMediaSessionActionsOnce() {
  if (!mediaSessionSupported() || bindMediaSessionActionsOnce.bound) return;
  bindMediaSessionActionsOnce.bound = true;

  const register = (action, handler) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (error) {
      console.debug(`Media Session action is not supported: ${action}`, error);
    }
  };

  register("play", () => {
    if (currentIndex < 0 || !audio.src) return;
    audio.play().catch((error) => {
      console.warn("Could not resume from the system media controls:", error);
    });
  });
  register("pause", () => {
    if (currentIndex >= 0) audio.pause();
  });
  register("previoustrack", playPreviousLocalTrack);
  register("nexttrack", playNextLocalTrack);
  register("seekto", (event) => {
    if (Number.isFinite(event.seekTime)) audio.currentTime = event.seekTime;
  });
}

function ensureMiniPlayer() {
  if (miniPlayer?.isConnected) return miniPlayer;

  miniPlayer = document.createElement("section");
  miniPlayer.className = "mini-player";
  miniPlayer.setAttribute("aria-label", "Now playing");
  miniPlayer.hidden = true;
  miniPlayer.innerHTML = `
    <div class="mini-player-controls">
      <button class="mini-player-button" type="button" data-player-action="previous" aria-label="Previous track">${ICONS.previous}</button>
      <button class="mini-player-button mini-player-toggle" type="button" data-player-action="toggle" aria-label="Play">${ICONS.play}</button>
      <button class="mini-player-button" type="button" data-player-action="next" aria-label="Next track">${ICONS.next}</button>
    </div>
    <div class="mini-player-main">
      <span class="mini-player-title"></span>
      <span class="mini-player-quality"></span>
      <div class="mini-player-timeline">
        <input class="mini-player-progress" type="range" min="0" max="0" value="0" step="0.1" aria-label="Track position">
        <span class="mini-player-time">0:00 / 0:00</span>
      </div>
      <span class="mini-player-artist"></span>
      <span class="mini-player-output"></span>
    </div>
    <div class="mini-player-volume" hidden>
      <button class="mini-player-button mini-player-volume-button" type="button" aria-label="UPnP volume" aria-controls="miniPlayerVolume" aria-expanded="false" title="UPnP volume">${ICONS.volume}</button>
      <div class="mini-player-volume-popover" id="miniPlayerVolume" role="group" aria-label="UPnP volume" hidden>
        <div class="mini-player-volume-heading"><span>Volume</span><span class="mini-player-volume-value">—</span></div>
        <input class="mini-player-volume-range" type="range" min="0" max="100" value="0" step="1" aria-label="UPnP renderer volume" disabled>
        <span class="mini-player-volume-status" role="status" aria-live="polite"></span>
      </div>
    </div>`;

  miniPlayer.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-player-action]")?.dataset.playerAction;
    if (action === "previous") playPreviousLocalTrack();
    if (action === "next") playNextLocalTrack();
    if (action === "toggle") {
      if (playbackSource(currentTracks[currentIndex])) await playIndex(currentIndex);
      else {
        const firstPlayableIndex = viewedTracks.findIndex((entry) => playbackSource(entry));
        if (firstPlayableIndex >= 0) await playViewedIndex(firstPlayableIndex);
      }
    }
  });

  miniPlayer.querySelector(".mini-player-progress").addEventListener("input", (event) => {
    const nextTime = Number(event.target.value);
    if (!Number.isFinite(nextTime)) return;
    if (remotePlaybackEnabled(currentTracks[currentIndex])) remoteSeekPreview = nextTime;
    else audio.currentTime = nextTime;
  });
  miniPlayer.querySelector(".mini-player-progress").addEventListener("change", async (event) => {
    if (!remotePlaybackEnabled(currentTracks[currentIndex])) return;
    const nextTime = Number(event.target.value);
    remoteSeekPreview = null;
    const remote = getRenderer();
    if (!Number.isFinite(nextTime) || remote?.mode !== "bridge") return;
    const sessionId = remoteSessionId;
    try {
      const response = await fetch(`${remote.bridgeUrl}/renderers/${encodeURIComponent(remote.id)}/seek`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seconds: nextTime }),
      });
      if (!response.ok) throw new Error(`Seek returned HTTP ${response.status}.`);
      if (sessionId === remoteSessionId) remoteCurrentTime = nextTime;
    } catch (error) {
      console.warn("Could not seek on remote renderer:", error);
    }
    if (sessionId === remoteSessionId) syncMiniPlayer();
  });

  const volumeControl = miniPlayer.querySelector(".mini-player-volume");
  volumeControl.querySelector(".mini-player-volume-button").addEventListener("click", () => {
    const popover = volumeControl.querySelector(".mini-player-volume-popover");
    if (popover.hidden) openRendererVolume();
    else closeRendererVolume();
  });
  const volumeSlider = volumeControl.querySelector(".mini-player-volume-range");
  volumeSlider.addEventListener("input", () => {
    volumeControl.querySelector(".mini-player-volume-value").textContent =
      `${volumePercent(Number(volumeSlider.value), Number(volumeSlider.min), Number(volumeSlider.max))}%`;
  });
  volumeSlider.addEventListener("change", async () => {
    const target = getRenderer();
    if (target?.mode !== "bridge" || !target.renderingControlUrl) return;
    const requested = Number(volumeSlider.value);
    const previous = volumeLevel;
    const requestId = volumeRequestId;
    const status = volumeControl.querySelector(".mini-player-volume-status");
    volumeSlider.disabled = true;
    try {
      await setRendererVolume(target, requested);
      if (requestId !== volumeRequestId) return;
      volumeLevel = requested;
      status.textContent = "";
    } catch (error) {
      if (requestId !== volumeRequestId) return;
      if (previous !== null) volumeSlider.value = String(previous);
      volumeControl.querySelector(".mini-player-volume-value").textContent =
        `${volumePercent(Number(volumeSlider.value), Number(volumeSlider.min), Number(volumeSlider.max))}%`;
      status.textContent = "Volume change failed";
      console.warn("Could not change UPnP volume:", error);
    } finally {
      if (requestId === volumeRequestId) volumeSlider.disabled = false;
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!volumeControl.contains(event.target)) closeRendererVolume();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeRendererVolume();
  });

  document.body.appendChild(miniPlayer);
  return miniPlayer;
}

function syncMiniPlayer() {
  const player = ensureMiniPlayer();
  const entry = currentTracks[currentIndex];
  const hasTrack = currentIndex >= 0 && !!playbackSource(entry);
  const playableTrackCount = viewedTracks.reduce(
    (count, item) => count + (playbackSource(item) ? 1 : 0),
    0
  );
  const hasPlayableTracks = playableTrackCount > 0;
  const shouldShowPlayer = hasTrack || hasPlayableTracks;

  player.hidden = !shouldShowPlayer;
  document.body.classList.toggle("has-mini-player", shouldShowPlayer);
  if (!shouldShowPlayer) {
    closeRendererVolume();
    return;
  }

  const volumeControl = player.querySelector(".mini-player-volume");
  const volumeAvailable = hasTrack && remotePlaybackEnabled(entry) && !!getRenderer()?.renderingControlUrl;
  if (!volumeAvailable && !volumeControl.hidden) closeRendererVolume();
  volumeControl.hidden = !volumeAvailable;

  const isPlaying = hasTrack && (remotePlaybackEnabled(entry) ? remotePlaying : (!audio.paused && !audio.ended));
  const toggle = player.querySelector(".mini-player-toggle");
  toggle.innerHTML = isPlaying ? ICONS.pause : ICONS.play;
  toggle.setAttribute("aria-label", isPlaying ? "Pause" : "Play");

  const previous = player.querySelector('[data-player-action="previous"]');
  const next = player.querySelector('[data-player-action="next"]');
  previous.disabled = !hasTrack;
  next.disabled = !hasTrack;

  const progress = player.querySelector(".mini-player-progress");
  progress.disabled = !hasTrack;

  if (!hasTrack) {
    player.querySelector(".mini-player-title").textContent = "Ready to play";
    player.querySelector(".mini-player-artist").textContent =
      `${playableTrackCount.toLocaleString()} available ${playableTrackCount === 1 ? "track" : "tracks"}`;
    player.querySelector(".mini-player-quality").textContent = "";
    player.querySelector(".mini-player-output").textContent = "";
    progress.max = "0";
    progress.value = "0";
    progress.style.setProperty("--player-progress", "0%");
    const time = player.querySelector(".mini-player-time");
    time.textContent = "0:00 / 0:00";
    time.dataset.currentTime = "0:00";
    return;
  }

  player.querySelector(".mini-player-title").textContent =
    entry.title || entry.localTrack.track?.title || entry.localTrack.file?.name || "";
  player.querySelector(".mini-player-artist").textContent =
    formatArtistAlbum(entry);
  player.querySelector(".mini-player-quality").textContent =
    formatSourceQuality(entry.localTrack.track);
  player.querySelector(".mini-player-output").textContent = formatOutput(entry);

  const duration = remotePlaybackEnabled(entry) ? remoteDuration : (Number.isFinite(audio.duration) ? audio.duration : 0);
  const currentTime = remotePlaybackEnabled(entry) ? (remoteSeekPreview ?? remoteCurrentTime) : (Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
  progress.max = String(duration);
  progress.value = String(Math.min(currentTime, duration || currentTime));
  progress.style.setProperty(
    "--player-progress",
    duration ? `${(currentTime / duration) * 100}%` : "0%"
  );
  const time = player.querySelector(".mini-player-time");
  time.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
  time.dataset.currentTime = formatTime(currentTime);
}

function releaseObjectUrl() {
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  objectUrl = "";
}

function syncPlayerUi() {
  if (currentOut) {
    const activeEntry = currentTracks[currentIndex];
    const activePath = activeEntry?.localTrack?.relativePath || "";
    const activeFile = activeEntry?.localTrack?.file || null;

    currentOut.querySelectorAll(".track-play").forEach((button) => {
      const index = Number(button.dataset.playTrack);
      const viewedEntry = viewedTracks[index];
      const viewedPath = viewedEntry?.localTrack?.relativePath || "";
      const viewedFile = viewedEntry?.localTrack?.file || null;
      const activeUrl = activeEntry?.localTrack?.playbackUrl || "";
      const viewedUrl = viewedEntry?.localTrack?.playbackUrl || "";
      const isCurrent = !!activeEntry && (
        (activePath && viewedPath === activePath) ||
        (!activePath && activeFile && viewedFile === activeFile) ||
        (!activePath && !activeFile && activeUrl && viewedUrl === activeUrl)
      );
      const isPlaying = isCurrent && (remotePlaybackEnabled(activeEntry)
        ? remotePlaying : !audio.paused && !audio.ended);
      const row = button.closest("tr.track");

      button.classList.toggle("is-current", isCurrent);
      button.classList.toggle("is-playing", isPlaying);
      button.setAttribute("aria-label", isPlaying ? "Pause track" : "Play track");
      button.setAttribute("title", isPlaying ? "Pause" : "Play");
      row?.classList.toggle("is-current", isCurrent);
      row?.classList.toggle("is-playing", isPlaying);
    });
  }
  syncMiniPlayer();
}

function clearCurrentPlayback() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  releaseObjectUrl();
  currentIndex = -1;
  activeLocalSource = null;
  syncPlayerUi();
  updateMediaSessionPlaybackState("none");
  if (mediaSessionSupported()) navigator.mediaSession.metadata = null;
}

async function playIndex(index) {
  const entry = currentTracks[index];
  const source = playbackSource(entry);
  if (!source) return;

  if (remotePlaybackEnabled(entry)) {
    await pendingRemoteStop;
    if (!remotePlaybackEnabled(entry)) return;
    if (currentIndex === index) {
      try {
        if (remotePlaying) { await callRenderer("Pause"); remotePlaying = false; }
        else { await playRenderer(); remotePlaying = true; }
      } catch (error) { console.warn("Could not control remote renderer:", error); }
      syncPlayerUi();
      return;
    }
    const nextEntry = currentTracks.slice(index + 1).find((item) => remotePlaybackEnabled(item));
    const remoteItems = currentTracks.slice(index).filter((item) => remotePlaybackEnabled(item)).map(remoteItem);
    const sessionId = ++remoteSessionId;
    activeRemoteRenderer = { ...getRenderer() };
    audio.pause();
    const queueRequest = setCurrentAndNext(remoteItem(entry), nextEntry ? remoteItem(nextEntry) : null, remoteItems);
    remoteCommandInFlight = queueRequest.catch(() => {});
    await queueRequest;
    if (sessionId !== remoteSessionId) return;
    activeLocalSource = null;
    currentIndex = index;
    remotePlaying = false;
    startRemoteStatePolling();
    syncPlayerUi();
    updateMediaSessionMetadata(entry);
    try {
      const playRequest = playRenderer();
      remoteCommandInFlight = playRequest.catch(() => {});
      await playRequest;
      remotePlaying = true;
    }
    catch (error) { console.warn("Could not start remote playback:", error); }
    if (sessionId !== remoteSessionId) return;
    syncPlayerUi();
    return;
  }

  if (currentIndex === index) {
    try {
      if (audio.paused) await audio.play();
      else audio.pause();
    } catch (error) {
      console.warn("Could not resume local track:", error);
      clearCurrentPlayback();
    }
    return;
  }

  audio.pause();
  releaseObjectUrl();

  objectUrl = source.kind === "file" ? URL.createObjectURL(source.value) : "";
  currentIndex = index;
  activeLocalSource = getActiveLibrarySource();
  audio.src = source.kind === "file" ? objectUrl : source.value;
  syncPlayerUi();
  updateMediaSessionMetadata(entry);

  try {
    await audio.play();
  } catch (error) {
    console.warn("Could not play local track:", error);
    clearCurrentPlayback();
  }
}

function startRemoteStatePolling() {
  if (remoteStateTimer) return;
  remoteStateTimer = window.setInterval(async () => {
    if (!activeRemoteRenderer || currentIndex < 0) return;
    const sessionId = remoteSessionId;
    try {
      const state = await getRendererState();
      if (sessionId !== remoteSessionId) return;
      remotePlaying = state.CurrentTransportState === "PLAYING";
      remoteCurrentTime = parseClock(state.RelTime);
      remoteDuration = parseClock(state.TrackDuration);
      const remoteUri = state.CurrentURI || "";
      const remoteIndex = currentTracks.findIndex((item) => item?.localTrack?.playbackUrl === remoteUri);
      if (remoteIndex >= 0 && remoteIndex !== currentIndex) {
        currentIndex = remoteIndex;
        const nextEntry = currentTracks.slice(remoteIndex + 1).find((item) => remotePlaybackEnabled(item));
        if (nextEntry) {
          const nextRequest = setNext(remoteItem(nextEntry));
          remoteCommandInFlight = nextRequest.catch(() => {});
          await nextRequest;
          if (sessionId !== remoteSessionId) return;
        }
        if (!remotePlaying) {
          try {
            const playRequest = playRenderer();
            remoteCommandInFlight = playRequest.catch(() => {});
            await playRequest;
            remotePlaying = true;
          } catch (error) { console.debug("Could not resume remote queue:", error); }
          if (sessionId !== remoteSessionId) return;
        }
        updateMediaSessionMetadata(currentTracks[remoteIndex]);
      }
      syncPlayerUi();
    } catch (error) { console.debug("Remote renderer state unavailable:", error); }
  }, 1000);
}

function handlePlaybackContextChange() {
  const selected = getRenderer();
  const source = getActiveLibrarySource();
  const previous = activeRemoteRenderer;
  if (previous) {
    const sameRenderer = source === "navidrome" && selected?.mode === "bridge" &&
      selected.id === previous.id && selected.bridgeUrl === previous.bridgeUrl;
    if (sameRenderer) return;
    activeRemoteRenderer = null;
    remoteSessionId += 1;
    window.clearInterval(remoteStateTimer);
    remoteStateTimer = null;
    remotePlaying = false;
    remoteCurrentTime = 0;
    remoteDuration = 0;
    remoteSeekPreview = null;
    clearCurrentPlayback();
    pendingRemoteStop = remoteCommandInFlight.then(() => stopBridgeRenderer(previous)).catch((error) => {
      console.warn("Could not stop the previous UPnP renderer:", error);
    });
    return;
  }
  if (currentIndex >= 0 && activeLocalSource &&
      (source !== activeLocalSource || (source === "navidrome" && selected?.mode === "bridge"))) {
    clearCurrentPlayback();
  }
}

function parseClock(value) {
  const parts = String(value || "").split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

async function playViewedIndex(index) {
  const entry = viewedTracks[index];
  const source = playbackSource(entry);
  if (!source) return;

  const activeEntry = currentTracks[currentIndex];
  const activePath = activeEntry?.localTrack?.relativePath || "";
  const viewedPath = entry.localTrack?.relativePath || "";
  const activeUrl = activeEntry?.localTrack?.playbackUrl || "";
  const viewedUrl = entry.localTrack?.playbackUrl || "";
  const isCurrentFile =
    (activePath && viewedPath === activePath) ||
    (!activePath && activeEntry && playbackSource(activeEntry)?.value === source.value) ||
    (!activePath && !activeEntry?.localTrack?.file && activeUrl && activeUrl === viewedUrl);

  if (isCurrentFile) {
    await playIndex(currentIndex);
    return;
  }

  audio.pause();
  releaseObjectUrl();
  currentTracks = [...viewedTracks];
  currentCoverImages = viewedCoverImages;
  currentIndex = -1;
  await playIndex(index);
}

function playNextLocalTrack() {
  for (let index = currentIndex + 1; index < currentTracks.length; index += 1) {
    if (playbackSource(currentTracks[index])) {
      playIndex(index);
      return;
    }
  }

  clearCurrentPlayback();
}

function playPreviousLocalTrack() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (playbackSource(currentTracks[index])) {
      playIndex(index);
      return;
    }
  }
  audio.currentTime = 0;
}

audio.addEventListener("play", () => {
  syncPlayerUi();
  updateMediaSessionPlaybackState("playing");
});
audio.addEventListener("pause", () => {
  syncPlayerUi();
  updateMediaSessionPlaybackState(currentIndex >= 0 ? "paused" : "none");
});
audio.addEventListener("ended", playNextLocalTrack);
audio.addEventListener("timeupdate", () => {
  syncMiniPlayer();
  updateMediaSessionPositionState();
});
audio.addEventListener("durationchange", syncMiniPlayer);
audio.addEventListener("loadedmetadata", () => {
  syncMiniPlayer();
  updateMediaSessionPositionState();
});

bindMediaSessionActionsOnce();
onLibrarySourceChange(handlePlaybackContextChange);
window.addEventListener("playback-output-change", handlePlaybackContextChange);

export function bindTrackPlayback(out, flatTracks, coverImages = null) {
  currentOut = out;
  viewedTracks = flatTracks;
  viewedCoverImages = coverImages || null;

  // First-ever play on a freshly loaded page: nothing is queued yet, so the
  // playing queue's cover should track what's on screen until playback starts.
  if (currentIndex < 0) currentCoverImages = viewedCoverImages;

  out.querySelectorAll(".track-play").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const index = Number(button.dataset.playTrack);
      if (Number.isInteger(index)) await playViewedIndex(index);
    });
  });

  syncPlayerUi();
}

export function leaveTrackPlaybackView() {
  currentOut = null;
  viewedTracks = [];
  syncMiniPlayer();
}
