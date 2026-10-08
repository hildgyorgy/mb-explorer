import {
  buildLocalAlbumReport,
  createLocalLibraryReport,
  reportEntryFromIndexedAlbum,
  validateLocalLibraryReport,
} from "../assets/js/services/localLibraryReport.mjs";

function assertEqual(actual, expected) {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
}

const releaseId = "32dd9da1-f858-4f1b-b7df-35b839e2f9ed";
const recordingId = "11111111-1111-4111-8111-111111111111";
const releaseTrackId = "22222222-2222-4222-8222-222222222222";
const entry = (overrides = {}) => ({
  metadata: {
    artist_name: "Patricia Barber",
    album_name: "Companion",
    album_mbid: releaseId,
    track_mbid: recordingId,
    release_track_mbid: releaseTrackId,
    ...overrides,
  },
});

assertEqual(buildLocalAlbumReport([entry()]).category, "ready");
assertEqual(buildLocalAlbumReport([entry({ release_track_mbid: null })]).category, "partial");

const untagged = buildLocalAlbumReport([entry({
  album_mbid: null,
  track_mbid: null,
  release_track_mbid: null,
})]);
assertEqual(untagged.category, "untagged");
assertEqual(untagged.artist, "Patricia Barber");
assertEqual(untagged.title, "Companion");

assertEqual(buildLocalAlbumReport([entry({
  artist_name: null,
  album_mbid: null,
  track_mbid: null,
  release_track_mbid: null,
})]).category, "incomplete");
assertEqual(buildLocalAlbumReport([entry(), entry({ album_name: "Another album" })]).category, "partial");
assertEqual(buildLocalAlbumReport([{ metadata: null, error: new Error("broken") }]).category, "incomplete");

const indexed = reportEntryFromIndexedAlbum({
  artist_name: "Patricia Barber",
  album_name: "Companion",
  album_mbid: releaseId,
  tracks: [{ track_mbid: recordingId, release_track_mbid: releaseTrackId }],
});
assertEqual(indexed.category, "ready");

const report = createLocalLibraryReport([untagged]);
assertEqual(validateLocalLibraryReport(report), report);

if (typeof console !== "undefined") console.log("Local library report regressions passed.");
else if (typeof print === "function") print("Local library report regressions passed.");
