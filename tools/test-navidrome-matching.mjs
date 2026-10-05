import { matchNavidromeTrack, positiveInteger } from "../assets/js/services/navidromeMatching.mjs";

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

const sacd = { discNumber: 2, trackNumber: 1 };
assertEqual(matchNavidromeTrack([sacd], 1, 1, false), null);
assertEqual(matchNavidromeTrack([sacd], 1, 1, true), null);
assertEqual(matchNavidromeTrack([sacd], 2, 1, false), sacd);
assertEqual(matchNavidromeTrack([sacd], 2, 1, true), sacd);
assertEqual(matchNavidromeTrack([{ discNumber: null, trackNumber: null }], 1, 1, true)?.discNumber, null);
assertEqual(matchNavidromeTrack([sacd, { ...sacd }], 2, 1, false), null);
assertEqual(matchNavidromeTrack([{ discNumber: null, trackNumber: 1 }], 2, 1, false), null);
assertEqual(matchNavidromeTrack([{ discNumber: 2, trackNumber: null }], 2, 1, false), null);
assertEqual(matchNavidromeTrack([{ discNumber: 2, trackNumber: 1 }], 2, 2, true), null);
assertEqual(positiveInteger("2"), 2);
for (const invalid of [null, 0, -1, 1.5, "1.5", "2x", "", "0"]) {
  assertEqual(positiveInteger(invalid), null);
}

if (typeof console !== "undefined") console.log("Navidrome matching regressions passed.");
else if (typeof print === "function") print("Navidrome matching regressions passed.");
