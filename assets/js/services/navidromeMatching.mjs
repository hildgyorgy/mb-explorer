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

  if (uniqueRecording !== true || candidates.length !== 1) return null;

  const candidate = candidates[0];
  const candidateDisc = positiveInteger(candidate.discNumber);
  const candidateTrack = positiveInteger(candidate.trackNumber);

  // A recording-only fallback must never override contradictory positional
  // metadata. This is especially important for layered releases such as a
  // hybrid SACD, where the same source song must not become playable on both
  // the CD and the hi-res medium.
  if (candidateDisc && medium && candidateDisc !== medium) return null;
  if (candidateTrack && track && candidateTrack !== track) return null;

  return candidate;
}
