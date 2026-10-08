import {
  getActiveLibrarySource,
  onLibrarySourceChange,
  setActiveLibrarySource,
} from "../core/librarySource.js";
import { getLocalLibrarySummary } from "../services/localLibrary.js";
import { getNavidromeStatus, getNavidromeSummary } from "../services/navidrome.js";
import {
  discoverBridgeRenderers,
  disconnectRenderer,
  getRenderer,
  selectBridgeRenderer,
} from "../services/upnpRenderer.js";

function rendererName(renderer) {
  return renderer?.friendlyName || renderer?.name || "UPnP renderer";
}

function showSourcePanel(source) {
  const local = source !== "navidrome";
  const localTab = document.getElementById("sourceLocalTab");
  const navidromeTab = document.getElementById("sourceNavidromeTab");
  const localPanel = document.getElementById("sourceLocalPanel");
  const navidromePanel = document.getElementById("sourceNavidromePanel");
  localTab?.classList.toggle("is-selected", local);
  navidromeTab?.classList.toggle("is-selected", !local);
  localTab?.setAttribute("aria-selected", String(local));
  navidromeTab?.setAttribute("aria-selected", String(!local));
  if (localPanel) localPanel.hidden = !local;
  if (navidromePanel) navidromePanel.hidden = local;
}

function compatibilitySummary(source, local, navidrome) {
  if (source === "navidrome" && navidrome.connected) {
    return {
      value: `${navidrome.identifiedAlbumCount.toLocaleString()} / ${navidrome.totalAlbumCount.toLocaleString()}`,
      label: "Albums identified as playable",
    };
  }
  if (source === "local" && local.connected) {
    if (local.hasReport) {
      const total = Object.values(local.reportCounts).reduce((sum, count) => sum + count, 0);
      return {
        value: `${local.reportCounts.ready.toLocaleString()} / ${total.toLocaleString()}`,
        label: "Albums identified as playable",
      };
    }
    return {
      value: local.identifiedAlbumCount.toLocaleString(),
      label: "Indexed albums",
    };
  }
  return { value: "—", label: "No library connected" };
}

export function refreshPlaybackSetup(root = document) {
  const source = getActiveLibrarySource();
  const local = getLocalLibrarySummary();
  const navidrome = getNavidromeSummary();
  const renderer = getRenderer();
  const sourceLabel = root.getElementById("homeSourceLabel");
  const outputLabel = root.getElementById("homeOutputLabel");
  const compatibility = root.getElementById("homeCompatibilityStatus");
  const compatibilityLabel = root.getElementById("homeCompatibilityLabel");
  const navidromeStatus = root.getElementById("navidromeSourceStatus");
  const compatibilityState = compatibilitySummary(source, local, navidrome);

  if (sourceLabel) {
    sourceLabel.textContent = source === "navidrome" && (navidrome.connected || navidrome.remembered)
      ? navidrome.name
      : source === "local" && (local.connected || local.remembered)
        ? "Local music folder"
        : "Choose a music library";
  }
  if (outputLabel) outputLabel.textContent = renderer ? rendererName(renderer) : "System audio";
  if (compatibility) compatibility.textContent = compatibilityState.value;
  if (compatibilityLabel) compatibilityLabel.textContent = compatibilityState.label;
  if (navidromeStatus) navidromeStatus.textContent = getNavidromeStatus();

  const localReport = root.getElementById("showLocalInventory");
  const navidromeReport = root.getElementById("showNavidromeInventory");
  if (localReport) localReport.hidden = !local.hasReport;
  if (navidromeReport) navidromeReport.hidden = !navidrome.connected;

  root.querySelectorAll(".output-option[data-renderer-id]").forEach((button) => {
    button.classList.toggle("is-selected", !!renderer && button.dataset.rendererId === String(renderer.id));
  });
  root.getElementById("systemOutput")?.classList.toggle("is-selected", !renderer);
}

function bindDialogBackdrop(dialog) {
  if (!dialog || dialog.dataset.backdropBound === "1") return;
  dialog.dataset.backdropBound = "1";
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

function bindPersistentSetup(root) {
  const sourceDialog = root.getElementById("sourceDialog");
  const outputDialog = root.getElementById("outputDialog");
  const localTab = root.getElementById("sourceLocalTab");
  const navidromeTab = root.getElementById("sourceNavidromeTab");
  const systemOutput = root.getElementById("systemOutput");
  const discover = root.getElementById("discoverRenderers");
  const outputOptions = root.getElementById("outputOptions");
  const rendererStatus = root.getElementById("rendererStatus");

  bindDialogBackdrop(sourceDialog);
  bindDialogBackdrop(outputDialog);

  localTab?.addEventListener("click", () => {
    showSourcePanel("local");
    setActiveLibrarySource("local");
  });
  navidromeTab?.addEventListener("click", () => {
    showSourcePanel("navidrome");
    setActiveLibrarySource("navidrome");
  });

  systemOutput?.addEventListener("click", () => {
    disconnectRenderer();
    if (rendererStatus) {
      rendererStatus.classList.remove("err");
      rendererStatus.textContent = "System audio selected.";
    }
    outputDialog?.close();
  });

  discover?.addEventListener("click", async () => {
    discover.disabled = true;
    if (rendererStatus) {
      rendererStatus.classList.remove("err");
      rendererStatus.textContent = "Looking for UPnP renderers through the local bridge…";
    }
    try {
      const renderers = await discoverBridgeRenderers();
      outputOptions?.querySelectorAll("[data-renderer-id]").forEach((button) => button.remove());
      for (const found of renderers) {
        const button = root.createElement("button");
        button.type = "button";
        button.className = "output-option";
        button.dataset.rendererId = String(found.id);
        const copy = root.createElement("span");
        const name = root.createElement("strong");
        const detail = root.createElement("small");
        const check = root.createElement("span");
        name.textContent = rendererName(found);
        detail.textContent = found.modelName || found.manufacturer || "UPnP network renderer";
        check.className = "output-check";
        check.setAttribute("aria-hidden", "true");
        check.textContent = "✓";
        copy.append(name, detail);
        button.append(copy, check);
        button.addEventListener("click", () => {
          selectBridgeRenderer(found);
          if (rendererStatus) rendererStatus.textContent = `${rendererName(found)} selected.`;
          outputDialog?.close();
        });
        outputOptions?.append(button);
      }
      if (rendererStatus) rendererStatus.textContent = `${renderers.length.toLocaleString()} renderer${renderers.length === 1 ? "" : "s"} found.`;
    } catch (error) {
      if (rendererStatus) {
        rendererStatus.textContent = error?.message || "The local bridge could not discover a renderer.";
        rendererStatus.classList.add("err");
      }
    } finally {
      discover.disabled = false;
      refreshPlaybackSetup(root);
    }
  });

  onLibrarySourceChange(() => {
    showSourcePanel(getActiveLibrarySource());
    refreshPlaybackSetup(root);
  });
  window.addEventListener("music-library-state-change", () => refreshPlaybackSetup(root));
  window.addEventListener("playback-output-change", () => refreshPlaybackSetup(root));
}

export function bindPlaybackSetup(root = document) {
  if (root.body?.dataset.playbackSetupBound !== "1") {
    root.body.dataset.playbackSetupBound = "1";
    bindPersistentSetup(root);
  }

  const sourceDialog = root.getElementById("sourceDialog");
  const outputDialog = root.getElementById("outputDialog");
  const sourceOpen = root.getElementById("openSourceSheet");
  const outputOpen = root.getElementById("openOutputSheet");
  const compatibility = root.getElementById("openCompatibilityReport");

  if (sourceOpen?.dataset.bound !== "1") {
    sourceOpen.dataset.bound = "1";
    sourceOpen.addEventListener("click", () => {
      sourceOpen.closest("dialog")?.close();
      showSourcePanel(getActiveLibrarySource());
      refreshPlaybackSetup(root);
      sourceDialog?.showModal();
    });
  }
  if (outputOpen?.dataset.bound !== "1") {
    outputOpen.dataset.bound = "1";
    outputOpen.addEventListener("click", () => {
      outputOpen.closest("dialog")?.close();
      refreshPlaybackSetup(root);
      outputDialog?.showModal();
    });
  }
  if (compatibility?.dataset.bound !== "1") {
    compatibility.dataset.bound = "1";
    compatibility.addEventListener("click", () => {
      compatibility.closest("dialog")?.close();
      const source = getActiveLibrarySource();
      const report = root.getElementById(source === "navidrome" ? "showNavidromeInventory" : "showLocalInventory");
      if (report && !report.hidden) report.click();
      else {
        showSourcePanel(source);
        sourceDialog?.showModal();
      }
    });
  }

  showSourcePanel(getActiveLibrarySource());
  refreshPlaybackSetup(root);
}
