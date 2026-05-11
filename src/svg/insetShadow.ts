// @ts-nocheck
import { SVG_NS } from "../state.js";
import { uid } from "../util/uid.js";

// ─────────────────────────────────────────────────────────────────────
// Box-gradient overlay (inset shadow / "frame" effect)
// ─────────────────────────────────────────────────────────────────────
// True "box gradient" = a CSS box-shadow inset.  SVG has no native
// equivalent, so we emulate it: draw a thick stroke just inside the
// shape's outline, clipped to the shape itself, then blur it.  The
// strokeWidth controls the frame thickness; the blur softens the edges.
// One pixel = one contribution, so there's no corner doubling.
//
// This is configured per-shape (rect, arch, anything) via `applyInsetShadow`.

// Build a single filter that gives shapes a soft inner shadow.  Returns
// just the filter ID — caller applies via `filter="url(#id)"`.  Unique
// per call so multiple shapes can have differently-tuned shadows.
export function makeInsetShadowFilter(defsParent, idPrefix, blur) {
  const f = document.createElementNS(SVG_NS, "filter");
  const id = uid(idPrefix);
  f.setAttribute("id", id);
  f.setAttribute("x", "-5%");
  f.setAttribute("y", "-5%");
  f.setAttribute("width", "110%");
  f.setAttribute("height", "110%");
  const blurNode = document.createElementNS(SVG_NS, "feGaussianBlur");
  blurNode.setAttribute("in", "SourceGraphic");
  blurNode.setAttribute("stdDeviation", blur);
  f.appendChild(blurNode);
  defsParent.appendChild(f);
  return id;
}

// Apply an inset shadow over a shape.  Caller provides:
//   parent     — where to append the resulting <g>
//   shapePath  — SVG path data for the shape (used both for clip and stroke)
//   defsParent — where to put per-call clipPath and filter
//   color      — shadow color (usually a darker shade of the fill)
//   thickness  — frame thickness in mm
//   blur       — Gaussian blur stdDeviation in mm (0 = sharp frame)
//   opacity    — overall shadow opacity
export function applyInsetShadow(
  parent,
  shapePath,
  defsParent,
  { color = "#000", thickness = 1.5, blur = 0.6, opacity = 0.6 } = {},
) {
  // Clip path so the thick stroke only renders INSIDE the shape (otherwise
  // half the stroke would extend outside the shape's edge).
  const clipId = uid("inset-clip");
  const clip = document.createElementNS(SVG_NS, "clipPath");
  clip.setAttribute("id", clipId);
  const clipPath = document.createElementNS(SVG_NS, "path");
  clipPath.setAttribute("d", shapePath);
  clip.appendChild(clipPath);
  defsParent.appendChild(clip);

  // Filter group — blur applied to the stroke
  const filterId = makeInsetShadowFilter(defsParent, "insetshadow", blur);

  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("clip-path", `url(#${clipId})`);
  g.setAttribute("opacity", opacity);
  if (blur > 0) g.setAttribute("filter", `url(#${filterId})`);
  // The thick stroke — half is outside the shape (clipped away) so the
  // visible band has thickness `thickness / 2`.
  const stroke = document.createElementNS(SVG_NS, "path");
  stroke.setAttribute("d", shapePath);
  stroke.setAttribute("fill", "none");
  stroke.setAttribute("stroke", color);
  stroke.setAttribute("stroke-width", thickness);
  stroke.setAttribute("stroke-linejoin", "round");
  g.appendChild(stroke);
  parent.appendChild(g);
  return g;
}
