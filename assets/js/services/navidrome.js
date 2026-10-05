import { setActiveLibrarySource } from "../core/librarySource.js";
import { loadBridgeRenderer } from "./upnpRenderer.js";
import { matchNavidromeTrack, positiveInteger } from "./navidromeMatching.mjs";

const API_VERSION = "1.16.1";
const CLIENT_NAME = "MusicBrainzExplorer";
const PAGE_SIZE = 500;
const SAVED_PROFILE_KEY = "musicards.navidrome.profile";

let profile = null;
let password = "";
let catalog = [];
let albumsByRelease = new Map();
let tracksByRelease = new Map();
let navidromeError = "";

function key(value) {
  return String(value || "").trim().toLowerCase();
}

function canonicalMbid(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)
    ? text
    : "";
}

function normalizeBaseUrl(value) {
  let text = String(value || "").trim();
  if (!text) throw new Error("Enter the Navidrome server URL.");
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) text = `https://${text}`;
  const url = new URL(text);
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".local") || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
    throw new Error("A remote Navidrome server must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The Navidrome URL must not contain credentials or query parameters.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

// OpenSubsonic authentication uses md5(password + salt). Web Crypto does not
// expose MD5, so this small implementation keeps the app dependency-free.
function md5(value) {
  const bytes = new TextEncoder().encode(value);
  const words = [];
  for (let i = 0; i < bytes.length; i += 1) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  words[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
  words[(((bytes.length + 8) >> 6) + 1) * 16 - 2] = bytes.length * 8;
  const rotate = (n, bits) => (n << bits) | (n >>> (32 - bits));
  const add = (a, b) => (a + b) | 0;
  let a0 = 0x67452301; let b0 = 0xefcdab89; let c0 = 0x98badcfe; let d0 = 0x10325476;
  const s = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const k = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));
  for (let offset = 0; offset < words.length; offset += 16) {
    let a = a0; let b = b0; let c = c0; let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f; let g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const next = add(a, add(f, add(k[i], words[offset + g] || 0)));
      const shift = s[(i >> 4) * 4 + (i % 4)];
      const rotated = add(b, rotate(next, shift));
      a = d; d = c; c = b; b = rotated;
    }
    a0 = add(a0, a); b0 = add(b0, b); c0 = add(c0, c); d0 = add(d0, d);
  }
  return [a0, b0, c0, d0].map((word) => Array.from({ length: 4 }, (_, i) => (word >>> (i * 8)) & 255).map((n) => n.toString(16).padStart(2, "0")).join("")).join("");
}

function authParameters(format = "json") {
  const salt = crypto.getRandomValues(new Uint8Array(8)).reduce((out, byte) => `${out}${byte.toString(16).padStart(2, "0")}`, "");
  return {
    u: profile.username,
    t: md5(password + salt),
    s: salt,
    v: API_VERSION,
    c: CLIENT_NAME,
    f: format,
  };
}

function endpoint(name) {
  const base = profile.baseUrl.toString().replace(/\/+$/, "");
  return `${base}/rest/${name}.view`;
}

async function request(name, params = {}) {
  const body = new URLSearchParams({ ...authParameters(), ...params });
  const response = await fetch(endpoint(name), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Accept: "application/json" },
    body,
  });
  if (!response.ok) throw new Error(`Navidrome returned HTTP ${response.status}.`);
  const payload = await response.json();
  const result = payload?.["subsonic-response"];
  if (!result || result.status !== "ok") throw new Error(result?.error?.message || "Navidrome rejected the request.");
  return result;
}

function albumFormat(album) {
  return [...new Set((album?.song || []).map((song) => String(song.suffix || "").toUpperCase()).filter(Boolean))].join("/");
}

function mapAlbum(album, songs = null) {
  const releaseMbid = canonicalMbid(album.musicBrainzId);
  if (!releaseMbid) return null;
  return {
    source: "navidrome",
    providerAlbumId: album.id,
    album_mbid: releaseMbid,
    album_name: album.name || album.title || "Untitled album",
    artist_name: album.artist || album.displayArtist || "Unknown artist",
    release_year: album.year || album.releaseDate?.year || null,
    media_format: albumFormat({ song: songs || album.song || [] }),
    tracks: (songs || album.song || []).map((song) => ({
      providerItemId: song.id,
      title: song.title || "Untitled track",
      track_mbid: canonicalMbid(song.musicBrainzId),
      discNumber: positiveInteger(song.discNumber),
      trackNumber: positiveInteger(song.track),
      release_track_mbid: null,
      codec: String(song.suffix || "").toUpperCase(),
      bit_depth: song.bitDepth,
      sample_rate: song.samplingRate,
      bitrate: song.bitRate ? Number(song.bitRate) * 1000 : null,
      channels: song.channelCount,
      duration: song.duration,
      contentType: song.contentType,
      playbackUrl: streamUrl(song.id),
    })),
  };
}

export function streamUrl(songId) {
  if (!profile || !password || !songId) return "";
  const params = new URLSearchParams({ ...authParameters("json"), id: songId, format: "raw", maxBitRate: "0" });
  return `${endpoint("stream")}?${params.toString()}`;
}

export function getNavidromeAlbum(releaseMbid) {
  return albumsByRelease.get(key(releaseMbid)) || null;
}

export function getNavidromeTrack(releaseMbid, recordingMbid, mediumPosition, trackPosition, uniqueRecording) {
  const candidates = tracksByRelease.get(key(releaseMbid))?.get(key(recordingMbid)) || [];
  const matched = matchNavidromeTrack(candidates, mediumPosition, trackPosition, uniqueRecording);
  if (!matched) return null;
  const album = getNavidromeAlbum(releaseMbid);
  return { album, track: matched, playbackUrl: matched.playbackUrl };
}

function normalizeText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

export function searchNavidromeLibrary(query, limit = 50) {
  const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  return catalog.filter((album) => {
    const text = normalizeText(`${album.artist_name} ${album.album_name} ${(album.tracks || []).map((track) => track.title).join(" ")}`);
    return tokens.every((token) => text.includes(token));
  }).slice(0, limit).map((album) => ({
    mbid: album.album_mbid,
    title: `${album.artist_name} — ${album.album_name}`,
    sub: [album.release_year, album.media_format, "NAVIDROME"].filter(Boolean).join(" · "),
    source: "navidrome",
  }));
}

export function isNavidromeConnected() {
  return !!profile;
}

export function getNavidromeStatus() {
  if (navidromeError) return navidromeError;
  if (!profile) return "Navidrome is not connected.";
  return `Connected to ${profile.name}. ${catalog.length.toLocaleString()} identified albums.`;
}

export async function connectNavidrome({ name, serverUrl, username, userPassword }) {
  const nextProfile = { name: String(name || "").trim(), baseUrl: normalizeBaseUrl(serverUrl), username: String(username || "").trim() };
  if (!nextProfile.username || !userPassword) throw new Error("Navidrome username and password are required.");
  profile = nextProfile;
  password = String(userPassword);
  navidromeError = "";
  catalog = [];
  albumsByRelease = new Map();
  tracksByRelease = new Map();

  try {
    const ping = await request("ping");
    if (ping.openSubsonic !== true || String(ping.type || "").toLowerCase() !== "navidrome") {
      throw new Error("This server did not identify itself as Navidrome with OpenSubsonic support.");
    }

    for (let offset = 0; ; offset += PAGE_SIZE) {
      const result = await request("getAlbumList2", { type: "alphabeticalByName", offset, size: PAGE_SIZE });
      const albums = result.albumList2?.album || [];
      albums.forEach((album) => {
        const mapped = mapAlbum(album);
        if (mapped && !albumsByRelease.has(mapped.album_mbid)) albumsByRelease.set(mapped.album_mbid, mapped);
      });
      if (albums.length < PAGE_SIZE) break;
    }
    catalog = [...albumsByRelease.values()];
    try { localStorage.setItem(SAVED_PROFILE_KEY, JSON.stringify(nextProfile)); } catch (error) { /* storage may be unavailable */ }
    setActiveLibrarySource("navidrome");
    return { profile, albumCount: catalog.length };
  } catch (error) {
    disconnectNavidrome();
    throw error;
  }
}

export async function prepareNavidromeRelease(releaseMbid) {
  const album = getNavidromeAlbum(releaseMbid);
  if (!album || !profile) return null;
  const detail = await request("getAlbum", { id: album.providerAlbumId });
  const mapped = mapAlbum(detail.album || {}, detail.album?.song || []);
  if (!mapped) return album;
  albumsByRelease.set(key(releaseMbid), mapped);
  const byRecording = new Map();
  mapped.tracks.forEach((track) => {
    if (!track.track_mbid) return;
    if (!byRecording.has(track.track_mbid)) byRecording.set(track.track_mbid, []);
    byRecording.get(track.track_mbid).push(track);
  });
  tracksByRelease.set(key(releaseMbid), byRecording);
  return mapped;
}

export function disconnectNavidrome() {
  profile = null; password = ""; catalog = []; albumsByRelease = new Map(); tracksByRelease = new Map(); navidromeError = "";
  setActiveLibrarySource("local");
}

export function bindNavidromePicker(root = document) {
  const open = root.getElementById("openNavidrome");
  const dialog = root.getElementById("navidromeDialog");
  const form = root.getElementById("navidromeForm");
  const status = root.getElementById("navidromeStatus");
  const probeButton = root.getElementById("probeAvm");
  const rendererUrl = root.getElementById("rendererDescriptionUrl");
  const rendererStatus = root.getElementById("rendererStatus");
  if (!open || !dialog || !form || !status || open.dataset.bound === "1") return;
  open.dataset.bound = "1";
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_PROFILE_KEY) || "null");
    if (saved) {
      form.elements.name.value = saved.name || "";
      form.elements.serverUrl.value = saved.baseUrl || "";
      form.elements.username.value = saved.username || "";
    }
  } catch (error) { /* ignore malformed or unavailable local storage */ }
  status.textContent = getNavidromeStatus();
  open.addEventListener("click", () => dialog.showModal());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true; status.textContent = "Connecting to Navidrome…";
    try {
      const data = new FormData(form);
      const result = await connectNavidrome({ name: data.get("name"), serverUrl: data.get("serverUrl"), username: data.get("username"), userPassword: data.get("password") });
      status.classList.remove("err");
      status.textContent = `Connected to ${result.profile.name}. ${result.albumCount.toLocaleString()} identified albums.`;
      dialog.close();
    } catch (error) {
      navidromeError = error?.message || "Could not connect to Navidrome.";
      status.textContent = navidromeError;
      status.classList.add("err");
    } finally { submit.disabled = false; }
  });
  probeButton?.addEventListener("click", async () => {
    rendererStatus.textContent = "Connecting to local UPnP bridge…";
    rendererStatus.classList.remove("err");
    try {
      const result = await loadBridgeRenderer();
      rendererStatus.textContent = `${result.friendlyName} · connected through local bridge.`;
    } catch (error) {
      rendererStatus.textContent = error?.message || "The browser could not reach the renderer (CORS, mixed content, or local-network access).";
      rendererStatus.classList.add("err");
    }
  });
}
