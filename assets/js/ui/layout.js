import { CONFIG } from "../core/config.js";
import { $ } from "../core/util.js";

let coverSizerBound = false;

export function isMobileLayout() {
  return window.matchMedia(`(max-width: ${CONFIG.MOBILE_BP}px)`).matches;
}

export function lockCoverSquareToTabs(root = document) {
  const cover = $(".cover", root);
  const box = $(".cover-box", root);
  const navRow = $(".cover-nav-row", root);
  const tabs = $("#tabs", root);
  if (!cover || !box || !navRow || !tabs) return;

  const w = Math.ceil(tabs.getBoundingClientRect().width);
  cover.style.width = w + "px";
  navRow.style.width = w + "px";
  box.style.width = w + "px";
  box.style.height = w + "px";
}

export function positionThemeToggle(root = document) {
  const row = $(".row", root);
  const main = $(".main", root);
  const tabs = $("#tabs", root);
  const btn = $("#themeToggle", root);
  if (!row || !main || !tabs || !btn) return;

  const rowRect = row.getBoundingClientRect();
  const mainRect = main.getBoundingClientRect();
  const tabsRect = tabs.getBoundingClientRect();

  const bw = btn.offsetWidth || 38;
  const bh = btn.offsetHeight || 38;

  const x = (mainRect.left - rowRect.left) - bw / 2 + 15;
  const y = (tabsRect.top - rowRect.top) + (tabsRect.height - bh) / 2;

  btn.style.left = `${Math.round(x)}px`;
  btn.style.top = `${Math.round(y)}px`;
}

export function syncBrandToCover(root = document) {
  const box = $(".cover-box", root);
  const brand = document.getElementById("homeLink");
  if (!box || !brand) return;

  brand.style.removeProperty("letter-spacing");
  const targetWidth = box.getBoundingClientRect().width;
  const visibleCharacters = brand.textContent.trim().replace(/\s+/g, " ").length;
  if (!targetWidth || !visibleCharacters) return;

  // Preserve the typeface and widen only its tracking. A second pass removes
  // sub-pixel differences caused by the browser's glyph rounding.
  let spacing = Number.parseFloat(getComputedStyle(brand).letterSpacing) || 0;
  for (let pass = 0; pass < 2; pass += 1) {
    const currentWidth = brand.getBoundingClientRect().width;
    spacing = Math.max(0, spacing + (targetWidth - currentWidth) / visibleCharacters);
    brand.style.letterSpacing = `${spacing}px`;
  }
}

function clearDesktopPlayerColumn() {
  const page = document.documentElement;
  page.style.removeProperty("--mini-player-left");
  page.style.removeProperty("--mini-player-width");
  page.style.removeProperty("--mini-player-shift");
}

function syncDesktopPlayerColumn(root = document) {
  const tracksColumn = $(".release-page > .views", root);
  if (!tracksColumn) return;

  const rect = tracksColumn.getBoundingClientRect();
  if (!rect.width) return;

  const styles = getComputedStyle(tracksColumn);
  const contentInset =
    (Number.parseFloat(styles.borderLeftWidth) || 0) +
    (Number.parseFloat(styles.paddingLeft) || 0);
  const playerLeft = rect.left + contentInset;
  const playerWidth = Math.max(0, rect.right - playerLeft);

  const page = document.documentElement;
  page.style.setProperty("--mini-player-left", `${playerLeft}px`);
  page.style.setProperty("--mini-player-width", `${playerWidth}px`);
  page.style.setProperty("--mini-player-shift", "0px");
}

export function clearInlineLayout(root = document) {
  const cover = $(".cover", root);
  const box = $(".cover-box", root);
  const navRow = $(".cover-nav-row", root);
  const btn = $("#themeToggle", root);
  const brand = document.getElementById("homeLink");

  cover?.style.removeProperty("width");
  box?.style.removeProperty("width");
  box?.style.removeProperty("height");
  navRow?.style.removeProperty("width");
  brand?.style.removeProperty("letter-spacing");

  btn?.style.removeProperty("left");
  btn?.style.removeProperty("top");
}

export function layoutSync(root = document) {
  clearDesktopPlayerColumn();
  const desktopWorkspace = document.documentElement.dataset.releaseLayout === "desktop" &&
    window.matchMedia("(min-width: 1200px)").matches;
  if (isMobileLayout() || desktopWorkspace) {
    clearInlineLayout(root);
    if (desktopWorkspace) {
      syncBrandToCover(root);
      syncDesktopPlayerColumn(root);
    }
    return;
  }
  lockCoverSquareToTabs(root);
  syncBrandToCover(root);
  positionThemeToggle(root);
}

export function bindCoverSizerOnce() {
  if (coverSizerBound) return;
  coverSizerBound = true;

  const rerun = () => {
    const out = document.getElementById("out");
    if (!out) return;
    layoutSync(out);
  };

  window.addEventListener("resize", rerun);

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(rerun);
  }
}
