import { random } from "./rng.js";

// Parse a 6-digit hex color (with leading '#') to an [r, g, b] tuple.
function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

// Format a single 0-255 channel value as a 2-digit hex string, clamping
// out-of-range and rounding fractional inputs.
function channelHex(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v)))
    .toString(16)
    .padStart(2, "0");
}

// Format an [r, g, b] (or three numeric channels) back to a `#RRGGBB` string,
// clamping to 0-255 and rounding fractional values.
function rgbToHex(r: number, g: number, b: number): string {
  return `#${channelHex(r)}${channelHex(g)}${channelHex(b)}`;
}

// Multiplicative jitter — scales each RGB channel by 1 ± 12%·strength. Dark
// colors stay dark, bright colors get more noise; preserves perceived palette.
export function jitterColor(hex: string, strength = 1): string {
  const [r, g, b] = hexToRgb(hex);
  const factor = 1 + (random() - 0.5) * 0.24 * strength;
  return rgbToHex(r * factor, g * factor, b * factor);
}

// Linear interpolation between two hex colors.
export function mixColors(hexA: string, hexB: string, t: number): string {
  const [ra, ga, ba] = hexToRgb(hexA);
  const [rb, gb, bb] = hexToRgb(hexB);
  const m = (a: number, b: number) => a + (b - a) * t;
  return rgbToHex(m(ra, rb), m(ga, gb), m(ba, bb));
}
