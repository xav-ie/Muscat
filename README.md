# Muscat

A procedural generator for a 12×18 inch medieval-style board poster. Renders to
SVG in the browser with print-ready PNG export at 300 DPI.

The board layout is fixed (one castle with a title banner, four sections each
containing a quadlet row and a terrain banner, edge-numbered top to bottom),
but every procedural element — terrain textures, icon placement, hand-drawn
edge grain — is seeded by a single PRNG, so re-rolling reshuffles the whole
composition while preserving the layout.

## Output

A single self-contained `dist/board.html` file: HTML + inlined script + inlined
Kranky font (base64 woff2) + inlined SVG icons (base64). No runtime fetches, no
external assets, no network. Open it directly or serve it statically.

The page exposes three controls:

- **re-roll** — reseeds the PRNG and rerenders.
- **grain freq / grain scale** — live-tweak the SVG `feTurbulence` +
  `feDisplacementMap` edge grain (cheap; doesn't reshuffle the procedural shapes).
- **export 12×18 png · 300dpi** — rasterizes the current SVG through a canvas
  at 3600×5400 px and downloads it.

## Build

```sh
npm install
npm run build      # type-check, then bundle to dist/board.html
```

`build.ts` runs esbuild with `__ICONS__` and `__KRANKY_B64__` `define`
substitutions so the assets are baked in at bundle time, then stamps the
resulting IIFE into `board.template.html`.

## Develop

```sh
npm run check          # runs format, lint, knip, fallow, and types in parallel
npm run check:types    # tsc --noEmit
npm run check:lint     # eslint
npm run check:format   # oxfmt --check
npm run check:knip     # unused exports / files
npm run check:fallow   # dependency audit
npm run lint:fix       # eslint --fix
npm run format         # oxfmt write
```

There is no dev server — iterate by running `npm run build` and reloading
`dist/board.html`.

## Layout

```
src/
  main.ts              # entry: wires up controls, kicks off render()
  render.ts            # composes the board: castle, banner, 4 sections
  state.ts             # global PRNG seed, layer refs, line weight
  constants.ts         # build-time __ICONS__ / __KRANKY_B64__ injection
  components/          # castle, quadlets, icon squares, edge numbers
  terrain/             # cracked-desert, grass, magma, water, voronoi
  svg/                 # primitives, filters, inset shadow, svg`` template
  util/                # rng, canvas helpers, color, poisson, sine warp, uid
assets/                # source SVG icons + Kranky woff2 (inlined at build)
board.template.html    # HTML shell — __SCRIPT__ and __KRANKY_B64__ get substituted
```
