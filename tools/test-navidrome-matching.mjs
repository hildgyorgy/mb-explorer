import assert from "node:assert/strict";
import { matchNavidromeTrack, positiveInteger } from "../assets/js/services/navidromeMatching.mjs";

const sacd = { discNumber: 2, trackNumber: 1 };
assert.equal(matchNavidromeTrack([sacd], 1, 1, false), null);
assert.equal(matchNavidromeTrack([sacd], 2, 1, false), sacd);
assert.equal(matchNavidromeTrack([{ discNumber: null, trackNumber: null }], 1, 1, true)?.discNumber, null);
assert.equal(matchNavidromeTrack([sacd, { ...sacd }], 2, 1, false), null);
assert.equal(matchNavidromeTrack([{ discNumber: null, trackNumber: 1 }], 2, 1, false), null);
assert.equal(matchNavidromeTrack([{ discNumber: 2, trackNumber: null }], 2, 1, false), null);
assert.equal(positiveInteger("2"), 2);
for (const invalid of [null, 0, -1, 1.5, "1.5", "2x", "", "0"]) {
  assert.equal(positiveInteger(invalid), null);
}
console.log("Navidrome matching regressions passed.");
