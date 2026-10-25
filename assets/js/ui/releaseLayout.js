const STORAGE_KEY = "mb-explorer-release-layout-v1";
const DEFAULT_LAYOUT = "focus";

function normalizeLayout(value) {
  return value === "desktop" ? "desktop" : DEFAULT_LAYOUT;
}

export function getReleaseLayout() {
  try {
    return normalizeLayout(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function applyReleaseLayout(layout = getReleaseLayout()) {
  const selected = normalizeLayout(layout);
  document.documentElement.dataset.releaseLayout = selected;
  return selected;
}

export function setReleaseLayout(layout) {
  const selected = applyReleaseLayout(layout);
  try {
    localStorage.setItem(STORAGE_KEY, selected);
  } catch {
    // The layout still applies for this page when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent("release-layout-change", {
    detail: { layout: selected },
  }));
}

function setSelected(button, selected) {
  button?.classList.toggle("is-selected", selected);
  button?.setAttribute("aria-pressed", String(selected));
}

export function refreshReleaseLayoutControls(root = document) {
  const selected = getReleaseLayout();
  setSelected(root.getElementById("homeLayoutFocus"), selected === "focus");
  setSelected(root.getElementById("homeLayoutDesktop"), selected === "desktop");
}

export function bindReleaseLayoutControls(root = document) {
  applyReleaseLayout();

  const focus = root.getElementById("homeLayoutFocus");
  const desktop = root.getElementById("homeLayoutDesktop");

  if (focus?.dataset.bound !== "1") {
    focus.dataset.bound = "1";
    focus.addEventListener("click", () => {
      setReleaseLayout("focus");
      refreshReleaseLayoutControls(root);
    });
  }

  if (desktop?.dataset.bound !== "1") {
    desktop.dataset.bound = "1";
    desktop.addEventListener("click", () => {
      setReleaseLayout("desktop");
      refreshReleaseLayoutControls(root);
    });
  }

  refreshReleaseLayoutControls(root);
}
