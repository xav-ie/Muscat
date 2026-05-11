// Two-octave sine warp used by procedural caustic / lava generators.
// Now that magma and water both run in WGSL, the actual offset computation
// lives in shader code; this module only owns the per-layer phase draw so
// callers stay deterministic against the seeded RNG.

export interface SineWarpPhases {
  ph1x: number;
  ph1y: number;
  ph2x: number;
  ph2y: number;
}

// Draw four random phase offsets in [0, 2π). Call order matches existing
// per-layer ph1x → ph1y → ph2x → ph2y consumption so RNG sequences stay byte
// equivalent.
export function freshSineWarpPhases(rand: () => number): SineWarpPhases {
  const ph1x = rand() * Math.PI * 2;
  const ph1y = rand() * Math.PI * 2;
  const ph2x = rand() * Math.PI * 2;
  const ph2y = rand() * Math.PI * 2;
  return { ph1x, ph1y, ph2x, ph2y };
}
