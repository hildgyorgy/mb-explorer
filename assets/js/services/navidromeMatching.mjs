export function positiveInteger(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function matchNavidromeTrack(candidates, mediumPosition, trackPosition, uniqueRecording) {
  const medium = positiveInteger(mediumPosition);
  const track = positiveInteger(trackPosition);
  if (medium && track) {
    const exact = candidates.filter((candidate) =>
      candidate.discNumber === medium && candidate.trackNumber === track);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
  }
  return uniqueRecording === true && candidates.length === 1 ? candidates[0] : null;
}
