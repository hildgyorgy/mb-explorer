export const APP_VERSION = "1.5.6";

export function isPhoneBrowser() {
  return navigator.userAgentData?.mobile === true ||
    /iPhone|iPod|Android.*Mobile/i.test(navigator.userAgent || "");
}

export const CONFIG = Object.freeze({
  // Responsive breakpoint (keep in sync with CSS @media)
  MOBILE_BP: 640,

  // Search behaviour
  SEARCH_LIMIT: 50,
  SEARCH_MIN_CHARS: 2,
  SEARCH_DEBOUNCE_MS: 250,
});
