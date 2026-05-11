// Best-effort Poisson disk distribution by rejection sampling.  Generates
// up to `count` points in the rect [x, x+w] × [y, y+h] such that no two
// points are within `minDist` of each other.  Each candidate is rejected
// if any already-placed point lies within `minDist`; sampling stops at
// `count * attemptsPer` attempts even if `count` points haven't been reached.
//
// `rngFunction` is a () => number returning [0, 1) — pass in `random` from rng.ts
// (or a local variant) so the caller controls determinism.
export function poissonDisk(
  x: number,
  y: number,
  w: number,
  h: number,
  minDistribution: number,
  count: number,
  rngFunction: () => number,
  attemptsPer = 25,
): [number, number][] {
  const placed: [number, number][] = [];
  const minDistributionSq = minDistribution * minDistribution;
  const maxAttempts = count * attemptsPer;
  let attempts = 0;
  while (placed.length < count && attempts < maxAttempts) {
    attempts++;
    const cx = x + rngFunction() * w;
    const cy = y + rngFunction() * h;
    let ok = true;
    for (const [px, py] of placed) {
      const dx = cx - px,
        dy = cy - py;
      if (dx * dx + dy * dy < minDistributionSq) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    placed.push([cx, cy]);
  }
  return placed;
}
