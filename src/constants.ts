// These two identifiers are substituted at build time by esbuild's `define`.
// See build.ts for the substitution config.
declare const __ICONS__: Record<string, string>;
declare const __KRANKY_B64__: string;

export const ICONS = __ICONS__;
export const KRANKY_B64 = __KRANKY_B64__;
