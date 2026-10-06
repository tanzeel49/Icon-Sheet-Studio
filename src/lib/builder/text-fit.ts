"use client";

/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (R34) · text auto-fit engine.
 *
 * §13 "Auto Fit Text": when a text layer's autoFit is ON, the rendered
 * font size is the LARGEST size ≤ the user's specified fontSize that fits
 * the text inside its own box, using the SAME real-measurement engine the
 * studio's title fitter uses (canvas measureText — never glyph stretching,
 * never box scaling). Manual line breaks are structural: each line wraps
 * independently and every break is preserved.
 *
 * The specified fontSize acts as the MAXIMUM (short text is never blown up
 * "as large as mathematically possible" — §13). A floor of 6px keeps
 * degenerate boxes debuggable instead of invisible.
 *
 * Pure + cached (measureTextWidth's internal cache) → cheap per render.
 */

import { measureTextWidth, wrapLinesToWidth } from "@/lib/studio/title-fit";
import type { TextElementProperties } from "./types";

export interface BuilderTextFit {
  /** the size the element should RENDER at (autoFit off → fontSize) */
  fontSize: number;
  /** measured/wrapped lines at the final size (display reference) */
  lines: string[];
  /** true when the fit actually reduced the size below fontSize */
  shrunk: boolean;
}

/** Safe inset — text never touches the exact box edge (§13 safe padding). */
const SAFE_INSET = 0.04;
const MIN_FONT_SIZE = 6;

function measureOpts(p: TextElementProperties, size: number) {
  return {
    fontFamily: p.fontFamily,
    fontSize: size,
    fontWeight: p.fontWeight,
    letterSpacing: p.letterSpacing,
  };
}

function fitsAtSize(
  p: TextElementProperties,
  content: string,
  size: number,
  boxW: number,
  boxH: number
): string[] | null {
  const lines = wrapLinesToWidth(content, boxW, measureOpts(p, size));
  if (lines.length === 0) return lines;
  const widest = Math.max(...lines.map((l) => measureTextWidth(l, measureOpts(p, size))));
  if (widest > boxW) return null;
  const totalHeight = lines.length * size * p.lineHeight;
  if (totalHeight > boxH) return null;
  return lines;
}

/**
 * Fit `content` into a `boxW × boxH` region with the layer's typography.
 * autoFit OFF → the specified fontSize, unwrapped (exact manual behavior).
 */
export function fitBuilderText(
  p: TextElementProperties,
  content: string,
  boxW: number,
  boxH: number
): BuilderTextFit {
  if (!p.autoFit) {
    return { fontSize: p.fontSize, lines: (content || " ").split("\n"), shrunk: false };
  }
  const w = Math.max(8, boxW * (1 - 2 * SAFE_INSET));
  const h = Math.max(8, boxH * (1 - 2 * SAFE_INSET));

  /* fast path — the specified size already fits */
  const atSpec = fitsAtSize(p, content, p.fontSize, w, h);
  if (atSpec) return { fontSize: p.fontSize, lines: atSpec, shrunk: false };

  /* binary search the largest size that fits (bounded, deterministic) */
  let lo = MIN_FONT_SIZE;
  let hi = p.fontSize;
  let bestLines: string[] | null = null;
  let best = MIN_FONT_SIZE;
  for (let i = 0; i < 24 && hi - lo > 0.01; i++) {
    const mid = (lo + hi) / 2;
    const lines = fitsAtSize(p, content, mid, w, h);
    if (lines) {
      best = mid;
      bestLines = lines;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const fontSize = Math.round(best * 10) / 10;
  const lines =
    bestLines ?? fitsAtSize(p, content, fontSize, w, h) ?? (content || " ").split("\n");
  return { fontSize, lines, shrunk: true };
}
