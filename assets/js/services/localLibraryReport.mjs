const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value) {
  return String(value || "").trim();
}

function isMbid(value) {
  return MBID_PATTERN.test(text(value));
}

function fieldSummary(metadata, field) {
  const values = metadata.map((item) => text(item?.[field])).filter(Boolean);
  const normalized = new Set(values.map((value) => value.toLocaleLowerCase()));
  return {
    value: values[0] || "",
    complete: values.length === metadata.length,
    consistent: normalized.size <= 1,
  };
}

function missingCount(metadata, field) {
  return metadata.reduce((count, item) => count + (isMbid(item?.[field]) ? 0 : 1), 0);
}

export function buildLocalAlbumReport(folderEntries) {
  const readable = (folderEntries || []).filter((entry) => entry?.metadata).map((entry) => entry.metadata);
  const unreadableCount = Math.max(0, (folderEntries || []).length - readable.length);
  const artist = fieldSummary(readable, "artist_name");
  const title = fieldSummary(readable, "album_name");
  const rawReleaseIds = readable.map((item) => text(item.album_mbid)).filter(Boolean);
  const releaseIds = [...new Set(rawReleaseIds.filter(isMbid).map((value) => value.toLowerCase()))];
  const missingReleaseCount = missingCount(readable, "album_mbid");
  const missingRecordingCount = missingCount(readable, "track_mbid");
  const missingReleaseTrackCount = missingCount(readable, "release_track_mbid");
  const hasReleaseTag = rawReleaseIds.length > 0;
  const displayMetadataComplete = readable.length > 0 && artist.complete && artist.consistent &&
    title.complete && title.consistent && !!artist.value && !!title.value;
  const fullyTagged = displayMetadataComplete && unreadableCount === 0 && releaseIds.length === 1 &&
    missingReleaseCount === 0 && missingRecordingCount === 0 && missingReleaseTrackCount === 0;

  let category = "incomplete";
  if (fullyTagged) category = "ready";
  else if (hasReleaseTag) category = "partial";
  else if (displayMetadataComplete) category = "untagged";

  const issues = [];
  if (unreadableCount) issues.push(`${unreadableCount} unreadable audio file${unreadableCount === 1 ? "" : "s"}`);
  if (releaseIds.length > 1) issues.push("multiple Release MBIDs");
  if (hasReleaseTag && missingReleaseCount) issues.push(`${missingReleaseCount} missing or invalid Release MBID${missingReleaseCount === 1 ? "" : "s"}`);
  if (!hasReleaseTag) issues.push("Release MBID missing");
  if (hasReleaseTag && missingRecordingCount) issues.push(`${missingRecordingCount} missing or invalid recording MBID${missingRecordingCount === 1 ? "" : "s"}`);
  if (hasReleaseTag && missingReleaseTrackCount) issues.push(`${missingReleaseTrackCount} missing or invalid release-track MBID${missingReleaseTrackCount === 1 ? "" : "s"}`);
  if (!artist.complete || !artist.value) issues.push("album artist missing");
  else if (!artist.consistent) issues.push("album artist differs between files");
  if (!title.complete || !title.value) issues.push("album title missing");
  else if (!title.consistent) issues.push("album title differs between files");

  return {
    category,
    artist: artist.consistent ? artist.value : "",
    title: title.consistent ? title.value : "",
    mbid: releaseIds.length === 1 ? releaseIds[0] : "",
    trackCount: readable.length,
    issues,
  };
}

export function reportEntryFromIndexedAlbum(album) {
  const tracks = Array.isArray(album?.tracks) ? album.tracks : [];
  return buildLocalAlbumReport(tracks.map((track) => ({
    metadata: {
      artist_name: album?.artist_name,
      album_name: album?.album_name,
      album_mbid: album?.album_mbid,
      track_mbid: track?.track_mbid,
      release_track_mbid: track?.release_track_mbid,
    },
  })));
}

export function createLocalLibraryReport(albums) {
  return {
    report_version: 1,
    generated_at: new Date().toISOString(),
    albums: Array.isArray(albums) ? albums : [],
  };
}

export function validateLocalLibraryReport(value) {
  if (!value || typeof value !== "object" || value.report_version !== 1 || !Array.isArray(value.albums)) {
    throw new Error("library-report.json is not a supported local-library report.");
  }
  return value;
}
