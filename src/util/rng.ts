// Mulberry32 — small, fast PRNG with good distribution. Same seed → same sequence.
function mulberry32(a: number): () => number {
  return function () {
    // mulberry32 mixes int32 state. `Math.imul(x, 1)` coerces the result to
    // a signed 32-bit integer (preserving overflow wrap), matching the
    // original `(... ) | 0` idiom without tripping unicorn/prefer-math-trunc.
    a = Math.imul(a + 0x6d_2b_79_f5, 1);
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// True-entropy seed source for the re-roll button. Independent of the seeded
// rng so a re-roll click always advances to a genuinely new layout.
export function freshSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

let _rng = mulberry32(1);

export function reseed(seed: number): void {
  _rng = mulberry32(seed);
}

export function random(): number {
  return _rng();
}
