const sourceState = {
  active: "local",
};

const listeners = new Set();

export function getActiveLibrarySource() {
  return sourceState.active;
}

export function setActiveLibrarySource(source) {
  const next = source === "navidrome" ? "navidrome" : "local";
  if (sourceState.active === next) return;
  sourceState.active = next;
  listeners.forEach((listener) => listener(next));
}

export function onLibrarySourceChange(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}
