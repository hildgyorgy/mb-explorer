import {
  getActiveLibrarySource,
  onLibrarySourceChange,
  setActiveLibrarySource,
} from "../core/librarySource.js";
import { getLocalLibrarySummary } from "../services/localLibrary.js";
import { getNavidromeSummary } from "../services/navidrome.js";
import {
  discoverBridgeRenderers,
  disconnectRenderer,
  getRenderer,
  selectBridgeRenderer,
} from "../services/upnpRenderer.js";

function rendererName(renderer) {
  return renderer?.friendlyName || renderer?.name || "UPnP renderer";
}

function setSelected(button, selected) {
  button?.classList.toggle("is-selected", selected);
  button?.setAttribute("aria-pressed", String(selected));
}

function openSettings(dialog, trigger) {
  trigger?.closest("dialog")?.close();
  dialog?.showModal();
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
  const compatibility = root.getElementById("homeCompatibilityStatus");
  const compatibilityLabel = root.getElementById("homeCompatibilityLabel");
  const compatibilityState = compatibilitySummary(source, local, navidrome);

  setSelected(root.getElementById("homeSourceLocal"), source === "local");
  setSelected(root.getElementById("homeSourceNavidrome"), source === "navidrome");
  setSelected(root.getElementById("homeOutputSystem"), !renderer);
  setSelected(root.getElementById("homeOutputRenderer"), !!renderer);
  if (compatibility) compatibility.textContent = compatibilityState.value;
  if (compatibilityLabel) compatibilityLabel.textContent = compatibilityState.label;

  const localChoice = root.getElementById("homeSourceLocal");
  const navidromeChoice = root.getElementById("homeSourceNavidrome");
  const rendererChoice = root.getElementById("homeOutputRenderer");
  if (localChoice) localChoice.title = source === "local" ? "Open local folder settings" : "Use the local music folder";
  if (navidromeChoice) navidromeChoice.title = source === "navidrome" ? "Open Navidrome settings" : "Use Navidrome";
  if (rendererChoice) rendererChoice.title = renderer ? `Configure ${rendererName(renderer)}` : "Choose a UPnP renderer";

  const localReport = root.getElementById("showLocalInventory");
  const navidromeReport = root.getElementById("showNavidromeInventory");
  if (localReport) localReport.hidden = !local.hasReport;
  if (navidromeReport) navidromeReport.hidden = !navidrome.connected;

  root.querySelectorAll(".output-option[data-renderer-id]").forEach((button) => {
    button.classList.toggle("is-selected", !!renderer && button.dataset.rendererId === String(renderer.id));
  });
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
  const discover = root.getElementById("discoverRenderers");
  const outputOptions = root.getElementById("outputOptions");
  const rendererStatus = root.getElementById("rendererStatus");

  bindDialogBackdrop(sourceDialog);
  bindDialogBackdrop(outputDialog);

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
          outputDialog?.querySelector(".search-help-close")?.click();
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

  onLibrarySourceChange(() => refreshPlaybackSetup(root));
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
  const navidromeDialog = root.getElementById("navidromeDialog");
  const localChoice = root.getElementById("homeSourceLocal");
  const navidromeChoice = root.getElementById("homeSourceNavidrome");
  const systemChoice = root.getElementById("homeOutputSystem");
  const rendererChoice = root.getElementById("homeOutputRenderer");
  const compatibility = root.getElementById("openCompatibilityReport");

  if (localChoice?.dataset.bound !== "1") {
    localChoice.dataset.bound = "1";
    localChoice.addEventListener("click", () => {
      if (getActiveLibrarySource() !== "local") setActiveLibrarySource("local");
      else openSettings(sourceDialog, localChoice);
    });
  }
  if (navidromeChoice?.dataset.bound !== "1") {
    navidromeChoice.dataset.bound = "1";
    navidromeChoice.addEventListener("click", () => {
      if (getActiveLibrarySource() !== "navidrome") setActiveLibrarySource("navidrome");
      else openSettings(navidromeDialog, navidromeChoice);
    });
  }
  if (systemChoice?.dataset.bound !== "1") {
    systemChoice.dataset.bound = "1";
    systemChoice.addEventListener("click", () => {
      if (getRenderer()) disconnectRenderer();
    });
  }
  if (rendererChoice?.dataset.bound !== "1") {
    rendererChoice.dataset.bound = "1";
    rendererChoice.addEventListener("click", () => {
      refreshPlaybackSetup(root);
      openSettings(outputDialog, rendererChoice);
    });
  }
  if (compatibility?.dataset.bound !== "1") {
    compatibility.dataset.bound = "1";
    compatibility.addEventListener("click", () => {
      compatibility.closest("dialog")?.close();
      const source = getActiveLibrarySource();
      const report = root.getElementById(source === "navidrome" ? "showNavidromeInventory" : "showLocalInventory");
      if (report && !report.hidden) report.click();
      else (source === "navidrome" ? navidromeDialog : sourceDialog)?.showModal();
    });
  }

  refreshPlaybackSetup(root);
}
