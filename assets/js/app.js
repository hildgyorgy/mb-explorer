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

// ------------------------------
// Loading / navigation
// ------------------------------

async function goFallback() {
  // Reserved fallback hook for empty searches.
}

// ------------------------------
// App init
// ------------------------------
export const App = Object.freeze({
  init() {
    applyTheme(getPreferredTheme());
    bindThemeToggleOnce(document);

    const emptyStateHtml = document.getElementById("emptyState")?.outerHTML || "";

    const bindHomeActions = () => {
      bindLocalLibraryPicker(document);
      bindNavidromePicker(document);

      const helpDialog = document.getElementById("searchHelpDialog");
      const helpOpen = document.getElementById("searchHelpOpen");
      const findReleases = document.getElementById("findReleases");

      helpOpen?.addEventListener("click", () => helpDialog?.showModal());
      findReleases?.addEventListener("click", () => {
        const omni = document.getElementById("omni");
        omni?.focus({ preventScroll: true });
      });
    };

    bindHomeActions();

    const helpDialog = document.getElementById("searchHelpDialog");
    const helpClose = document.getElementById("searchHelpClose");
    helpClose?.addEventListener("click", () => helpDialog?.close());
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
