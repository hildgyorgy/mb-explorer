// features/artistPanel.js
// Inline artist panel — opens between track row and credits when an artist name is clicked.

import {
  fetchWikipediaSummary,
  loadArtist,
  loadArtistReleaseGroups,
  loadArtistReleases,
} from "../services/api.js";
import { escHtml, escAttr } from "../core/util.js";
import { getActiveLibrarySource, onLibrarySourceChange } from "../core/librarySource.js";
import { isLocalReleasePlayable } from "../services/localLibrary.js";
import {
  getNavidromeAlbum,
  isNavidromeConnected,
  isNavidromeReleasePlayable,
  prepareNavidromeRelease,
} from "../services/navidrome.js";

let currentArtistId = null;
let currentAnchorEl = null;
let outsideClickHandler = null;
let currentDiscographyReleases = [];
let availabilityRefreshBound = false;

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/**
 * @param {string} artistId - MusicBrainz artist MBID
 * @param {HTMLElement} anchorEl - the .details-inner element to inject into
 * @param {(groupMbid: string, releaseMbid: string) => void} onLoadRelease - callback when user picks a release group
 */
export async function openArtistPanel(artistId, anchorEl, onLoadRelease) {
  if (!artistId || !anchorEl) return;

  if (currentArtistId === artistId && currentAnchorEl === anchorEl) return;

  closeArtistPanel();

  currentArtistId = artistId;
  currentAnchorEl = anchorEl;
  currentDiscographyReleases = [];
  bindAvailabilityRefreshOnce();

  const panel = createPanelShell();
  anchorEl.insertBefore(panel, anchorEl.firstChild);

  setTimeout(() => bindOutsideClick(panel), 0);

  try {
    const [artist, releaseGroups] = await Promise.all([
      loadArtist(artistId),
      loadArtistReleaseGroups(artistId),
    ]);

    const wikidataUrl = findWikidataUrl(artist);
    const wiki = wikidataUrl
      ? await fetchWikipediaSummary(wikidataUrl).catch(() => null)
      : null;

    if (currentArtistId !== artistId) return;

    renderPanelContent(panel, artist, wiki, releaseGroups, onLoadRelease);
  } catch {
    if (currentArtistId !== artistId) return;
    panel.querySelector(".ap-body").innerHTML =
      `<div class="muted">Could not load artist details.</div>`;
  }
}

export function closeArtistPanel() {
  if (outsideClickHandler) {
    document.removeEventListener("pointerdown", outsideClickHandler);
    outsideClickHandler = null;
  }

  if (currentAnchorEl) {
    const existing = currentAnchorEl.querySelector(".artist-panel");
    existing?.remove();
  }

  currentArtistId = null;
  currentAnchorEl = null;
  currentDiscographyReleases = [];
}

// ------------------------------------------------------------
// Panel shell
// ------------------------------------------------------------

function createPanelShell() {
  const panel = document.createElement("div");
  panel.className = "artist-panel";
  panel.innerHTML = `
    <div class="ap-header">
      <span class="ap-name muted">Loading…</span>
      <button class="ap-close" type="button" aria-label="Close artist panel">✕</button>
    </div>
    <div class="ap-body">
      <div class="muted ap-loading">Loading artist data…</div>
    </div>
  `;

  bindCloseButton(panel);
  return panel;
}

// ------------------------------------------------------------
// Render full panel content
// ------------------------------------------------------------

function renderPanelContent(panel, artist, wiki, releaseGroups, onLoadRelease) {
  const name = escHtml(artist?.name || "(unknown)");
  const years = buildLifeSpanYears(artist);
  const mbUrl = `https://musicbrainz.org/artist/${artist?.id || ""}`;
  const wikiHtml = buildWikiHtml(wiki);
  const discoHtml = buildDiscographyHtml(releaseGroups);

  panel.querySelector(".ap-header").innerHTML = `
    <span class="ap-name">
      <span class="ap-name-text">${name}${years ? ` <span class="ap-years">(${years})</span>` : ""}</span>
    </span>
    <a href="${escAttr(mbUrl)}" target="_blank" rel="noreferrer noopener" class="ap-mb-btn pill">
      MusicBrainz
    </a>
    <button class="ap-close" type="button" aria-label="Close artist panel">✕</button>
  `;

  bindCloseButton(panel);

  panel.querySelector(".ap-body").innerHTML = `
    ${wikiHtml}
    ${discoHtml}
  `;

  bindDiscographyRows(panel, onLoadRelease);
  loadArtistReleases(artist?.id).then((releases) => {
    if (!panel.isConnected || currentArtistId !== artist?.id) return;
    currentDiscographyReleases = releases;
    refreshDiscographyAvailability(panel);
  }).catch((error) => {
    console.warn("Could not load release versions for the artist discography:", error);
  });
}

// ------------------------------------------------------------
// Life span years: "1935–2002", "1943–", "–2030"
// ------------------------------------------------------------

function buildLifeSpanYears(artist) {
  const begin = artist?.["life-span"]?.begin || "";
  const end = artist?.["life-span"]?.end || "";

  const b = begin ? begin.slice(0, 4) : "";
  const e = end ? end.slice(0, 4) : "";

  if (b || e) return `${b}–${e}`;
  return "";
}

// ------------------------------------------------------------
// Wikipedia block
// ------------------------------------------------------------

function buildWikiHtml(wiki) {
  if (!wiki?.extract) return "";

  const MAX = 200;
  const text = wiki.extract.replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
  const shortened = text.length > MAX
    ? text.slice(0, MAX).trim() + "…"
    : text;

  const wikiUrl =
    wiki.url || `https://en.wikipedia.org/wiki/${encodeURIComponent(wiki.title || "")}`;

  return `
    <div class="ap-section ap-section--wiki">
      <div class="ap-wiki-text">
        ${escHtml(shortened)}
        <a href="${escAttr(wikiUrl)}" target="_blank" rel="noreferrer noopener"
           class="ap-wiki-link"> Read more on Wikipedia</a>
      </div>
    </div>
  `;
}

// ------------------------------------------------------------
// Discography block
// ------------------------------------------------------------

function buildDiscographyHtml(releaseGroups) {
  if (!releaseGroups?.length) return "";

  const groups = groupReleaseGroups(releaseGroups);
  const content =
    renderDiscographySection("Albums", groups.album) +
    renderDiscographySection("Live", groups.live) +
    renderDiscographySection("EPs", groups.ep) +
    renderDiscographySection("Other", groups.other);

  if (!content) return "";

  return `
    <div class="ap-section ap-discography">
      <div class="ap-section-label">DISCOGRAPHY</div>
      <div class="ap-disco-scroll">
        ${content}
      </div>
    </div>
  `;
}

function groupReleaseGroups(releaseGroups) {
  const groups = {
    album: [],
    live: [],
    ep: [],
    other: [],
  };

  releaseGroups.forEach((rg) => {
    const type = String(rg["primary-type"] || "").toLowerCase();
    const secondary = Array.isArray(rg["secondary-types"])
      ? rg["secondary-types"].map((t) => String(t).toLowerCase())
      : [];

    if (secondary.includes("live")) {
      groups.live.push(rg);
    } else if (type === "album") {
      groups.album.push(rg);
    } else if (type === "ep") {
      groups.ep.push(rg);
    } else {
      groups.other.push(rg);
    }
  });

  Object.values(groups).forEach((items) => items.sort(sortReleaseGroupsByDate));
  return groups;
}

function sortReleaseGroupsByDate(a, b) {
  const da = a?.["first-release-date"] || "9999";
  const db = b?.["first-release-date"] || "9999";
  return da.localeCompare(db);
}

function renderDiscographySection(label, items) {
  if (!items?.length) return "";

  const rows = items.map(renderDiscographyRow).join("");

  return `
    <div class="ap-disco-subsection">
      <div class="ap-disco-subhead">${escHtml(label)}</div>
      ${rows}
    </div>
  `;
}

function renderDiscographyRow(rg) {
  const year = String(rg?.["first-release-date"] || "").slice(0, 4);
  const title = escHtml(rg?.title || "(untitled)");
  const rgId = escAttr(rg?.id || "");

  return `
    <div class="ap-disco-row" data-rg-id="${rgId}">
      <span class="ap-disco-year muted">${escHtml(year)}</span>
      <span class="ap-disco-title">${title}</span>
      <span class="ap-disco-playable" role="img" title="A version is playable from your library" aria-label="A version is playable from your library" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>
      </span>
    </div>
  `;
}

function bindDiscographyRows(panel, onLoadRelease) {
  const section = panel.querySelector(".ap-discography");
  if (!section || typeof onLoadRelease !== "function") return;
  section.addEventListener("click", async (event) => {
    const row = event.target.closest(".ap-disco-row");
    if (!row?.dataset.rgId) return;
    await onLoadRelease(row.dataset.rgId, row.dataset.releaseId || "");
  });
}

function releaseGroupId(release) {
  return String(release?.["release-group"]?.id || "");
}

function sortReleasesByDate(releases) {
  return [...releases].sort((a, b) =>
    String(a?.date || "9999").localeCompare(String(b?.date || "9999"))
  );
}

function isReleasePlayable(releaseId) {
  return getActiveLibrarySource() === "navidrome"
    ? isNavidromeReleasePlayable(releaseId)
    : isLocalReleasePlayable(releaseId);
}

function applyDiscographyAvailability(panel = document.querySelector(".artist-panel")) {
  if (!panel) return;
  const releasesByGroup = new Map();
  currentDiscographyReleases.forEach((release) => {
    const rgId = releaseGroupId(release);
    if (!rgId) return;
    if (!releasesByGroup.has(rgId)) releasesByGroup.set(rgId, []);
    releasesByGroup.get(rgId).push(release);
  });

  panel.querySelectorAll(".ap-disco-row[data-rg-id]").forEach((row) => {
    const releases = sortReleasesByDate(releasesByGroup.get(row.dataset.rgId) || []);
    const playableRelease = releases.find((release) => isReleasePlayable(release.id));
    const preferredRelease = playableRelease || releases[0];
    if (preferredRelease?.id) row.dataset.releaseId = preferredRelease.id;
    else delete row.dataset.releaseId;
    const marker = row.querySelector(".ap-disco-playable");
    if (marker) marker.hidden = !playableRelease;
  });
}

async function refreshDiscographyAvailability(panel = document.querySelector(".artist-panel")) {
  applyDiscographyAvailability(panel);
  if (!panel || getActiveLibrarySource() !== "navidrome" || !isNavidromeConnected()) return;

  const releaseIds = currentDiscographyReleases
    .map((release) => release.id)
    .filter((releaseId) => {
      const album = getNavidromeAlbum(releaseId);
      return album && !album.detailsLoaded;
    });
  if (!releaseIds.length) return;

  await Promise.allSettled(releaseIds.map((releaseId) => prepareNavidromeRelease(releaseId)));
  if (panel.isConnected && getActiveLibrarySource() === "navidrome") {
    applyDiscographyAvailability(panel);
  }
}

function bindAvailabilityRefreshOnce() {
  if (availabilityRefreshBound) return;
  availabilityRefreshBound = true;
  onLibrarySourceChange(() => refreshDiscographyAvailability());
  window.addEventListener("music-library-state-change", () => refreshDiscographyAvailability());
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function bindCloseButton(panel) {
  panel.querySelector(".ap-close")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeArtistPanel();
  });
}

function findWikidataUrl(artist) {
  const rels = Array.isArray(artist?.relations) ? artist.relations : [];
  return rels.find((r) => r.type === "wikidata")?.url?.resource || null;
}

function bindOutsideClick(panel) {
  outsideClickHandler = (e) => {
    if (!panel.contains(e.target)) {
      closeArtistPanel();
    }
  };

  document.addEventListener("pointerdown", outsideClickHandler);
}
