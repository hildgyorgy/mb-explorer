/* ============================================================
   Release page pipeline: render + hydrate + state prep
   ============================================================ */

import { STATE, setCoverState, setViewsState } from "../core/state.js";
import { artistCreditToText, fmtMs } from "../core/util.js";

import { bindThemeToggleOnce } from "../ui/theme.js";
import { bindCoverSizerOnce, layoutSync } from "../ui/layout.js";
import { bindCoverGalleryOnce } from "../ui/coverGallery.js";
import {
  renderHeader,
  renderTracksView,
  renderAnnotation,
  renderReleaseLevelCredits,
  renderVersionsViewShell,
} from "../ui/render.js";

import { bindTabsOnce, setActiveView } from "../ui/tabs.js";
import { buildVersionsView } from "./versions.js";
import { bindTrackToggles } from "./tracks.js";
import { bindComposerHeadersOnce } from "../ui/composerHeaders.js";
import { getLocalAlbum, getLocalTrack } from "../services/localLibrary.js";
import { bindTrackPlayback } from "./player.js";
import { getActiveLibrarySource } from "../core/librarySource.js";
import { getNavidromeAlbum, getNavidromeTrack, isNavidromeConnected, prepareNavidromeRelease } from "../services/navidrome.js";

// ------------------------------------------------------------
// Streaming links (moved to module level from Fix 4)
// ------------------------------------------------------------

function normalizeQobuzToPlay(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch { return s; }
  const host = u.hostname.toLowerCase();
  if (host === "play.qobuz.com") return u.toString();
  if (host.endsWith("qobuz.com")) {
    const m = u.pathname.match(/\/album\/[^/]+\/([a-z0-9]+)$/i);
    if (m && m[1]) return `https://play.qobuz.com/album/${m[1]}`;
  }
  return s;
}

function pickStreamingLinksFromRelease(rel) {
  const rels = Array.isArray(rel?.relations) ? rel.relations : [];

  let spotifyUrl = "";
  let appleMusicUrl = "";
  let tidalUrl = "";
  let qobuzUrl = "";
  let discogsUrl = "";

  for (const r of rels) {
    const tt = r.target_type ?? r["target-type"];
    if (tt !== "url") continue;
    const u = r.url?.resource || r.target?.resource || "";
    const url = String(u || "").trim();
    if (!url) continue;
    const low = url.toLowerCase();
    if (!spotifyUrl && low.includes("spotify.com")) spotifyUrl = url;
    if (!appleMusicUrl && low.includes("music.apple.com")) appleMusicUrl = url;
    if (!tidalUrl && low.includes("tidal.com")) tidalUrl = url;
    if (low.includes("qobuz.com")) {
      if (low.includes("play.qobuz.com")) qobuzUrl = url;
      else if (!qobuzUrl) qobuzUrl = url;
    }
    if (!discogsUrl && low.includes("discogs.com")) {
      discogsUrl = url;
    }
    if (spotifyUrl && appleMusicUrl && tidalUrl && qobuzUrl) break;
  }

  qobuzUrl = normalizeQobuzToPlay(qobuzUrl);
  return { spotifyUrl, appleMusicUrl, tidalUrl, qobuzUrl, discogsUrl };
}

// ------------------------------------------------------------
// UI hydration
// ------------------------------------------------------------

function hydrateUI(out, flatTracks, onLoadRelease, onNavigateToRelease, coverImages) {
  bindThemeToggleOnce(document);

  bindTabsOnce({
    onViewActivated: async (view) => {
      if (view === "versions" && !STATE.views.versionsBuilt) {
        setViewsState({ versionsBuilt: true });
        await buildVersionsView(onNavigateToRelease);
      }
    },
  });

  setActiveView("tracks");

  // Track toggles — pass onLoadRelease so artist panel can navigate
  bindTrackToggles(out, flatTracks, onLoadRelease);
  bindTrackPlayback(out, flatTracks, coverImages);

  bindComposerHeadersOnce(out);

  bindCoverGalleryOnce(out);
  bindCoverSizerOnce();
}

// ------------------------------------------------------------
// Main export
// ------------------------------------------------------------

/**
 * Render the whole release page into #out, update STATE, then hydrate UI.
 *
 * @param {HTMLElement} out
 * @param {{rel:Object, cover:string|null, covers:Array}} data
 * @param {(rgId:string)=>Promise<void>} [onLoadRelease] - called when artist panel discography item is clicked
 */
export async function renderReleasePage(out, { rel, cover, covers }, onLoadRelease, onNavigateToRelease) {
  const title = rel.title || "(untitled)";
  const artist = artistCreditToText(rel["artist-credit"]);
  const date = rel.date || rel["release-events"]?.[0]?.date || "";
  const country = rel.country || rel["release-events"]?.[0]?.area?.name || "";

  const labelInfo = (rel["label-info"] || [])[0];
  const label = labelInfo?.label?.name || "";
  const labelId = labelInfo?.label?.id || "";
  const catno = labelInfo?.["catalog-number"] || "";
  const barcode = rel.barcode || "";
  const releaseNotes = String(rel.disambiguation || "").trim();

  const annotation = (rel.annotation || "").trim();
  const mbLink = `https://musicbrainz.org/release/${rel.id}`;
  const streaming = pickStreamingLinksFromRelease(rel);

  console.log("Streaming links:", streaming);

  // Cover gallery state
  const gallery = Array.isArray(covers) ? covers : [];
  let idx = gallery.findIndex((x) => x.front);
  if (idx < 0) idx = 0;
  setCoverState({ gallery, index: idx });

  // Small + large variants of the same front cover, for Media Session artwork
  // (some OS "now playing" surfaces render blank if only a large image is given).
  const frontCover = gallery[idx] || null;
  const coverImages = frontCover
    ? { thumb: frontCover.thumb, large: frontCover.large, full: frontCover.full }
    : null;

  // Build flat track list for toggle binding
  const media = rel.media || [];
  const recordingCounts = new Map();
  media.forEach((medium) => (medium.tracks || []).forEach((track) => {
    const recordingId = track.recording?.id;
    if (recordingId) recordingCounts.set(recordingId, (recordingCounts.get(recordingId) || 0) + 1);
  }));
  const flatTracks = [];
  let localAlbum = getLocalAlbum(rel.id);
  const activeSource = getActiveLibrarySource();
  if (activeSource === "navidrome" && isNavidromeConnected()) {
    localAlbum = await prepareNavidromeRelease(rel.id) || getNavidromeAlbum(rel.id);
  }
  let localTrackCount = 0;

  const mediaWithTracks = media.map((m, mi) => {
    const mt = (m.tracks || []).map((t) => {
      // On multi-medium releases (including hybrid SACDs), recording identity
      // alone cannot identify the physical layer. Require disc + track there.
      const allowRecordingFallback = media.length === 1 &&
        recordingCounts.get(t.recording?.id) === 1;
      const localTrack = localAlbum
        ? activeSource === "navidrome"
          ? getNavidromeTrack(rel.id, t.recording?.id, m.position ?? mi + 1, t.position,
            allowRecordingFallback)
          : getLocalTrack(rel.id, t.recording?.id, t.id)
        : null;
      const isLocal = !!(localTrack?.file || localTrack?.playbackUrl);
      if (isLocal) localTrackCount += 1;

      const obj = {
        pos: t.position,
        title: t.title,
        artist: artistCreditToText(
          t["artist-credit"] || t.recording?.["artist-credit"] || []
        ),
        len: fmtMs(t.length),
        rec: t.recording,
        isLocal,
        localTrack,
        _i: flatTracks.length,
      };
      flatTracks.push(obj);
      return obj;
    });

    return {
      index: mi + 1,
      format: m.format || "",
      title: m.title || "",
      trackCount: mt.length,
      tracks: mt,
    };
  });

  // Recordings + Versions tab data source
  const releaseGroupId = rel["release-group"]?.id || "";
  setViewsState({
    versionsBuilt: false,
    releaseGroupId,
    currentReleaseId: rel.id || "",
    localRelease: !!localAlbum,
    localTrackCount,
  });

  out.innerHTML = `
    ${renderHeader({
      title,
      cover,
      mbLink,
      artist,
      date,
      country,
      label,
      labelId,
      catno,
      barcode,
      releaseNotes,
      streaming,
      localRelease: STATE.views.localRelease,
      localTrackCount: STATE.views.localTrackCount,
      totalTrackCount: flatTracks.length,
    })}
    <div class="views">
  ${renderTracksView(
    mediaWithTracks,
    renderReleaseLevelCredits(rel),
    renderAnnotation(annotation)
  )}
      ${renderVersionsViewShell()}
    </div>
  `;

  hydrateUI(out, flatTracks, onLoadRelease, onNavigateToRelease, coverImages);

  layoutSync(out);

  const img = out.querySelector("#coverImg");
  if (img) {
    const relock = () => layoutSync(out);
    img.addEventListener("load", relock, { once: true });
    if (img.complete) relock();
  }
}
