// Module-scoped counter backed unique IDs.  Used everywhere we need a
// per-render-fresh DOM id for an SVG <filter>, <clipPath>, <linearGradient>,
// <pattern>, etc.  Counter starts at 0 and increments forever, so two
// renders won't collide as long as the first batch is removed before the
// second renders (which `clear()` already guarantees).
let _counter = 0;

export function uid(prefix: string): string {
  _counter += 1;
  return `${prefix}-${_counter}`;
}
