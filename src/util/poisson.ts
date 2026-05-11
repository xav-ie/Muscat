// @ts-nocheck

// Best-effort Poisson disk distribution by rejection sampling.  Generates
// up to `count` points in the rect [x, x+w] × [y, y+h] such that no two
// points are within `minDist` of each other.  Each candidate is rejected
// if any already-placed point lies within `minDist`; sampling stops at
// `count * attemptsPer` attempts even if `count` points haven't been reached.
//
// `rngFn` is a () => number returning [0, 1) — pass in `random` from rng.ts
// (or a local variant) so the caller controls determinism.
export function poissonDisk(
  x,
  y,
  w,
  h,
  minDist,
  count,
  rngFn,
  attemptsPer = 25,
) {
  const placed = [];
  const minDistSq = minDist * minDist;
  const maxAttempts = count * attemptsPer;
  let attempts = 0;
  while (placed.length < count && attempts < maxAttempts) {
    attempts++;
    const cx = x + rngFn() * w;
    const cy = y + rngFn() * h;
    let ok = true;
    for (let i = 0; i < placed.length; i++) {
      const dx = cx - placed[i][0],
        dy = cy - placed[i][1];
      if (dx * dx + dy * dy < minDistSq) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    placed.push([cx, cy]);
  }
  return placed;
}
