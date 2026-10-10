/* ============================================================
   App entry (ES modules)
   ============================================================ */

import { bootFromUrl } from "./core/boot.js";
import { createReleaseNavigator } from "./services/navigation.js";
import { applyTheme, getPreferredTheme, bindThemeToggleOnce } from "./ui/theme.js";
import { createSearchController } from "./ui/searchController.js";

import { loadRelease, loadFirstReleaseOfGroup } from "./services/api.js";
import { renderReleasePage } from "./features/releasePage.js";

import { createMobileHeaderController } from "./ui/mobileHeader.js";
import { bindLocalLibraryPicker } from "./services/localLibrary.js";
import { leaveTrackPlaybackView } from "./features/player.js";
import { bindNavidromePicker } from "./services/navidrome.js";
import { bindPlaybackSetup } from "./ui/playbackSetup.js";

// ------------------------------
// Loading / navigation
// ------------------------------

async function goFallback() {
  // Reserved fallback hook for empty searches.
}

function closeDialogAnimated(dialog, onClosed) {
  if (!dialog?.open || dialog.classList.contains("is-closing")) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    dialog.close();
    onClosed?.();
    return;
  }

  dialog.classList.add("is-closing");
  let fallback;
  const finish = () => {
    clearTimeout(fallback);
    dialog.removeEventListener("animationend", onAnimationEnd);
    dialog.classList.remove("is-closing");
    if (dialog.open) dialog.close();
    onClosed?.();
  };
  const onAnimationEnd = (event) => {
    if (event.target === dialog && event.animationName === "dialog-pop-out") finish();
  };
  dialog.addEventListener("animationend", onAnimationEnd);
  fallback = window.setTimeout(finish, 260);
}

function bindAnimatedDialogCloseButtons(root = document) {
  root.querySelectorAll(".search-help-close").forEach((button) => {
    if (button.dataset.closeMotionBound === "1") return;
    button.dataset.closeMotionBound = "1";
    button.addEventListener("click", () => {
      const dialog = button.closest("dialog");
      const returnDialog = document.getElementById(dialog?.dataset.returnDialog || "");
      closeDialogAnimated(dialog, () => {
        if (returnDialog && !returnDialog.open) returnDialog.showModal();
      });
    });
  });
}

// ------------------------------
// App init
// ------------------------------
export const App = Object.freeze({
  init() {
    applyTheme(getPreferredTheme());
    bindThemeToggleOnce(document);
    bindAnimatedDialogCloseButtons(document);

    const emptyStateHtml = document.getElementById("emptyState")?.outerHTML || "";

    const bindHomeActions = () => {
      bindLocalLibraryPicker(document);
      bindNavidromePicker(document);
      bindPlaybackSetup(document);

      const helpDialog = document.getElementById("searchHelpDialog");
      const helpOpen = document.getElementById("searchHelpOpen");
      const headerSetupOpen = document.getElementById("headerSetupOpen");

      [helpOpen, headerSetupOpen].forEach((button) => {
        if (!button || button.dataset.bound === "1") return;
        button.dataset.bound = "1";
        button.addEventListener("click", () => {
          if (helpDialog && !helpDialog.open) helpDialog.showModal();
        });
      });
    };

    bindHomeActions();

    const helpDialog = document.getElementById("searchHelpDialog");
    helpDialog?.addEventListener("click", (event) => {
      if (event.target === helpDialog) helpDialog.close();
    });

    const Nav = createReleaseNavigator({
      getOut: () => document.getElementById("out"),
      loadRelease,

      // Wrap renderReleasePage to inject the onLoadRelease callback
      // so the artist panel discography can navigate to a release
      renderReleasePage: (out, data) =>
        renderReleasePage(out, data,
          // onLoadRelease: artist panel passes a release GROUP id
          async (rgId) => {
            try {
              const release = await loadFirstReleaseOfGroup(rgId);
              if (release?.id) await goByMbidWrapped(release.id);
            } catch (err) {
              console.warn("Could not navigate to release group:", err);
            }
          },
          // onNavigateToRelease: versions tab passes a release id directly
          async (releaseId) => {
            try {
              await goByMbidWrapped(releaseId);
            } catch (err) {
              console.warn("Could not navigate to release:", err);
            }
          }
        ),
    });

    const MobileHdr = createMobileHeaderController();
    MobileHdr.bind();

    const goByMbidWrapped = async (mbid) => {
      await Nav.goByMbid(mbid);
      MobileHdr.onReleaseLoaded();
    };

    const Search = createSearchController({
      onGoByMbid: goByMbidWrapped,
      onGoFallback: goFallback,
    });
    Search.init();

    const homeLink = document.getElementById("homeLink");
homeLink?.addEventListener("click", () => {
  const out = document.getElementById("out");
  const omni = document.getElementById("omni");

  leaveTrackPlaybackView();

  if (out) {
    out.innerHTML = emptyStateHtml;
    bindHomeActions();
  }

  if (omni) {
    omni.value = "";
    omni.classList.remove("is-loaded");
  }

  history.replaceState({}, "", window.location.pathname);
});

    bootFromUrl({ onGoByMbid: goByMbidWrapped });
  },
});

document.addEventListener("DOMContentLoaded", App.init);
