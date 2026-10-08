const ACTIVE_SOURCE_KEY = "musicbrainz-explorer.active-source";

function savedSource() {
  try {
    return localStorage.getItem(ACTIVE_SOURCE_KEY) === "navidrome" ? "navidrome" : "local";
  } catch (error) {
    return "local";
  }
}

const sourceState = {
  active: typeof localStorage === "undefined" ? "local" : savedSource(),
};

const listeners = new Set();

export function getActiveLibrarySource() {
  return sourceState.active;
}

export function setActiveLibrarySource(source) {
  const next = source === "navidrome" ? "navidrome" : "local";
  if (sourceState.active === next) return;
  sourceState.active = next;
  try { localStorage.setItem(ACTIVE_SOURCE_KEY, next); } catch (error) { /* storage may be unavailable */ }
  listeners.forEach((listener) => listener(next));
}

export function onLibrarySourceChange(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}
