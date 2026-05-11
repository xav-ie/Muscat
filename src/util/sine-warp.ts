// Two-octave sine warp used by procedural caustic / lava generators. Maps a
// UV-space point through a low-frequency sin field with a higher-frequency
// secondary octave at one-third amplitude. Phase offsets are externalized so
// each layer can warp from the same noise field with its own amplitude.

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

// (wx, wy) UV-space offsets produced by the two-octave sin field for sample
// point (u, v) and amplitude `amp`. Callers apply these in whatever coord
// space they need (UV-space directly, or pixel-space scaled by W/H).
export function sineWarpOffsets(
  u: number,
  v: number,
  amp: number,
  phases: SineWarpPhases,
): [number, number] {
  const A2 = amp * 0.33;
  const wx =
    Math.sin(u * 8 + v * 6 + phases.ph1x) * amp + Math.sin(u * 21 - v * 11 + phases.ph2x) * A2;
  const wy =
    Math.sin(v * 8 + u * 6 + phases.ph1y) * amp + Math.sin(v * 21 - u * 11 + phases.ph2y) * A2;
  return [wx, wy];
}
