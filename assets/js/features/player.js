/* ============================================================
   Local audio playback
   ============================================================ */

const audio = new Audio();
let objectUrl = "";
let currentIndex = -1;
let currentOut = null;
let currentTracks = [];
let viewedTracks = [];
let miniPlayer = null;
let viewedCoverUrl = "";
let currentCoverUrl = "";

const ICONS = {
  previous: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14M18 6l-8 6 8 6V6z"/></svg>`,
  play: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM14 5h4v14h-4z"/></svg>`,
  next: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 5v14M6 6l8 6-8 6V6z"/></svg>`,
};

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

/* ============================================================
   Media Session — surfaces now-playing info to the OS
   (Control Center, lock screen, AirPlay receivers, etc.)
   ============================================================ */

function mediaSessionSupported() {
  return "mediaSession" in navigator;
}

function buildArtwork(coverUrl) {
  if (!coverUrl) return [];
  return [{ src: coverUrl, sizes: "512x512", type: "image/jpeg" }];
}

function updateMediaSessionMetadata(entry) {
  if (!mediaSessionSupported()) return;

  const title = entry?.title || entry?.localTrack?.track?.title || entry?.localTrack?.file?.name || "";
  const artist = entry?.localTrack?.album?.artist_name || "";
  const album = entry?.localTrack?.album?.album_name || "";

  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist,
    album,
    artwork: buildArtwork(currentCoverUrl),
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

  navigator.mediaSession.setActionHandler("play", () => {
    if (currentIndex >= 0) playIndex(currentIndex);
  });
  navigator.mediaSession.setActionHandler("pause", () => {
    if (currentIndex >= 0) playIndex(currentIndex);
  });
  navigator.mediaSession.setActionHandler("previoustrack", playPreviousLocalTrack);
  navigator.mediaSession.setActionHandler("nexttrack", playNextLocalTrack);
  navigator.mediaSession.setActionHandler("seekto", (event) => {
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
      <div class="mini-player-copy">
        <span class="mini-player-title"></span>
        <span class="mini-player-artist"></span>
        <span class="mini-player-quality"></span>
      </div>
      <div class="mini-player-timeline">
        <input class="mini-player-progress" type="range" min="0" max="0" value="0" step="0.1" aria-label="Track position">
        <span class="mini-player-time">0:00 / 0:00</span>
      </div>
    </div>`;

  miniPlayer.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-player-action]")?.dataset.playerAction;
    if (action === "previous") playPreviousLocalTrack();
    if (action === "next") playNextLocalTrack();
    if (action === "toggle") {
      if (currentIndex >= 0) await playIndex(currentIndex);
      else {
        const firstPlayableIndex = viewedTracks.findIndex((entry) => entry?.localTrack?.file);
        if (firstPlayableIndex >= 0) await playViewedIndex(firstPlayableIndex);
      }
    }
  });

  miniPlayer.querySelector(".mini-player-progress").addEventListener("input", (event) => {
    const nextTime = Number(event.target.value);
    if (Number.isFinite(nextTime)) audio.currentTime = nextTime;
  });

  document.body.appendChild(miniPlayer);
  return miniPlayer;
}

function syncMiniPlayer() {
  const player = ensureMiniPlayer();
  const entry = currentTracks[currentIndex];
  const hasTrack = currentIndex >= 0 && !!entry?.localTrack?.file;
  const playableTrackCount = viewedTracks.reduce(
    (count, item) => count + (item?.localTrack?.file ? 1 : 0),
    0
  );
  const hasPlayableTracks = playableTrackCount > 0;
  const shouldShowPlayer = hasTrack || hasPlayableTracks;

  player.hidden = !shouldShowPlayer;
  document.body.classList.toggle("has-mini-player", shouldShowPlayer);
  if (!shouldShowPlayer) return;

  const isPlaying = hasTrack && !audio.paused && !audio.ended;
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
      `${playableTrackCount.toLocaleString()} local ${playableTrackCount === 1 ? "track" : "tracks"}`;
    player.querySelector(".mini-player-quality").textContent = "";
    progress.max = "0";
    progress.value = "0";
    progress.style.setProperty("--player-progress", "0%");
    const time = player.querySelector(".mini-player-time");
    time.textContent = "0:00 / 0:00";
    time.dataset.currentTime = "0:00";
    return;
  }

  player.querySelector(".mini-player-title").textContent =
    entry.title || entry.localTrack.track?.title || entry.localTrack.file.name;
  player.querySelector(".mini-player-artist").textContent =
    entry.localTrack.album?.artist_name || "";
  player.querySelector(".mini-player-quality").textContent =
    formatSourceQuality(entry.localTrack.track);

  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
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
      const isCurrent = !!activeEntry && (
        (activePath && viewedPath === activePath) ||
        (!activePath && activeFile && viewedFile === activeFile)
      );
      const isPlaying = isCurrent && !audio.paused && !audio.ended;
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
  syncPlayerUi();
  updateMediaSessionPlaybackState("none");
  if (mediaSessionSupported()) navigator.mediaSession.metadata = null;
}

async function playIndex(index) {
  const entry = currentTracks[index];
  const file = entry?.localTrack?.file;
  if (!file) return;

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

  objectUrl = URL.createObjectURL(file);
  currentIndex = index;
  audio.src = objectUrl;
  syncPlayerUi();
  updateMediaSessionMetadata(entry);

  try {
    await audio.play();
  } catch (error) {
    console.warn("Could not play local track:", error);
    clearCurrentPlayback();
  }
}

async function playViewedIndex(index) {
  const entry = viewedTracks[index];
  const file = entry?.localTrack?.file;
  if (!file) return;

  const activeEntry = currentTracks[currentIndex];
  const activePath = activeEntry?.localTrack?.relativePath || "";
  const viewedPath = entry.localTrack?.relativePath || "";
  const isCurrentFile =
    (activePath && viewedPath === activePath) ||
    (!activePath && activeEntry?.localTrack?.file === file);

  if (isCurrentFile) {
    await playIndex(currentIndex);
    return;
  }

  audio.pause();
  releaseObjectUrl();
  currentTracks = [...viewedTracks];
  currentCoverUrl = viewedCoverUrl;
  currentIndex = -1;
  await playIndex(index);
}

function playNextLocalTrack() {
  for (let index = currentIndex + 1; index < currentTracks.length; index += 1) {
    if (currentTracks[index]?.localTrack?.file) {
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
    if (currentTracks[index]?.localTrack?.file) {
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
  updateMediaSessionPlaybackState("paused");
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

export function bindTrackPlayback(out, flatTracks, coverUrl = "") {
  currentOut = out;
  viewedTracks = flatTracks;
  viewedCoverUrl = coverUrl || "";

  // First-ever play on a freshly loaded page: nothing is queued yet, so the
  // playing queue's cover should track what's on screen until playback starts.
  if (currentIndex < 0) currentCoverUrl = viewedCoverUrl;

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