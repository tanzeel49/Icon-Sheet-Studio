/**
 * ICON SHEET STUDIO — Smart Auto-Fit Title engine (round 17).
 *
 * Professional "fit text to area" behavior for the sheet title/category:
 *
 *   title region (template units)
 *     ↓ safe-margin inset
 *     ↓ real text measurement (canvas measureText — NOT char-count heuristics)
 *     ↓ line layout (manual breaks preserved; natural word wrap otherwise)
 *     ↓ bounded binary search for the largest BALANCED font size
 *     ↓ whole-block centering (vertical; horizontal follows the align style)
 *
 * Design goals (per spec):
 * - NEVER overflow / clip / overlap neighbors — the block lives inside the
 *   safe inset of the template's own title region.
 * - SHORT titles grow, but only up to a controlled multiple of the design's
 *   preferred size (never "as large as mathematically possible").
 * - LONG titles shrink + wrap; words are never broken mid-word unless a
 *   single word is wider than the whole safe width (last resort).
 * - MANUAL line breaks (`\n`) are structural — auto-fit adapts the size
 *   around the user's line structure and never merges/splits their lines.
 * - Template-independent: everything derives from the region Rect in
 *   TEMPLATE units, so zoom (a viewBox scale) can never change the result,
 *   and the same fit drives preview, overview, PDF and SVG export.
 *
 * Pure functions + internal caches → cheap enough to call per render, and
 * identical across every consumer.
 */

import type { Rect, TextStyle } from "./types";

/* ------------------------------------------------------------------ */
/* Real text measurement (canvas 2D)                                   */
/* ------------------------------------------------------------------ */

/** Lazy offscreen canvas context. Null when unavailable (SSR / no DOM) —
 *  callers then fall back to the conservative character heuristic. */
let canvasCtx: CanvasRenderingContext2D | null | undefined;
/** Feature-detected once: ctx.letterSpacing (Chromium 99+). */
let supportsCtxLetterSpacing: boolean | undefined;

function getCtx(): CanvasRenderingContext2D | null {
  if (canvasCtx !== undefined) return canvasCtx;
  canvasCtx = null;
  try {
    if (typeof document === "undefined") return canvasCtx;
    const canvas = document.createElement("canvas");
    canvasCtx = canvas.getContext("2d");
    if (canvasCtx && supportsCtxLetterSpacing === undefined) {
      supportsCtxLetterSpacing = "letterSpacing" in canvasCtx;
    }
  } catch {
    canvasCtx = null;
  }
  return canvasCtx;
}

export interface MeasureOpts {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  letterSpacing: number; // template px
  italic?: boolean;
}

/** width cache: (font string | spacing | text) → px. Capped; measurements
 *  are stable for a font string, so this also dedupes panel + renderer. */
const widthCache = new Map<string, number>();
const WIDTH_CACHE_CAP = 4000;

/**
 * Measure one line of text with REAL font metrics (canvas measureText),
 * honoring family / size / weight / spacing / italic. Falls back to the
 * conservative 0.58-em heuristic only when canvas is unavailable.
 *
 * Letter-spacing note: SVG adds spacing BETWEEN glyphs (n−1 gaps). Canvas
 * letterSpacing (CSS semantics) adds it after every glyph. We prefer the
 * canvas measurement — over-estimating by one spacing unit is the SAFE
 * direction for fitting (never overflow).
 */
export function measureTextWidth(text: string, opts: MeasureOpts): number {
  if (!text) return 0;
  const font =
    `${opts.italic ? "italic " : ""}${opts.fontWeight} ${opts.fontSize}px ${opts.fontFamily}`;
  const key = `${font}|ls:${opts.letterSpacing}|${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;

  let w: number;
  const ctx = getCtx();
  if (ctx) {
    ctx.font = font;
    if (supportsCtxLetterSpacing) {
      ctx.letterSpacing = `${opts.letterSpacing}px`;
      w = ctx.measureText(text).width;
      ctx.letterSpacing = "0px";
    } else {
      w = ctx.measureText(text).width + opts.letterSpacing * Math.max(0, text.length - 1);
    }
  } else {
    // conservative fallback (also used outside the browser)
    w = text.length * (opts.fontSize * 0.58 + opts.letterSpacing);
  }

  if (widthCache.size >= WIDTH_CACHE_CAP) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

/* ------------------------------------------------------------------ */
/* Line layout                                                          */
/* ------------------------------------------------------------------ */

/**
 * Wrap text to a max width with REAL measurements. MANUAL line breaks
 * (`\n`) are structural: each paragraph wraps independently and every
 * break is preserved — wrapping may only ADD lines below a too-long
 * manual line, never remove or merge the user's breaks.
 *
 * Last resort: a single word wider than the whole max width is split by
 * characters (the only case where mid-word breaking is "absolutely
 * necessary" — it guarantees the never-overflow contract).
 */
export function wrapLinesToWidth(text: string, maxWidth: number, opts: MeasureOpts): string[] {
  if (text === "") return [];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push(""); // blank manual line — always kept
      continue;
    }
    let current = "";
    for (const word of words) {
      // a word that can NEVER fit on its own line → character-split it
      if (measureTextWidth(word, opts) > maxWidth && maxWidth > 0) {
        if (current) {
          lines.push(current);
          current = "";
        }
        for (const chunk of splitWordToWidth(word, maxWidth, opts)) lines.push(chunk);
        continue;
      }
      const candidate = current ? `${current} ${word}` : word;
      if (measureTextWidth(candidate, opts) <= maxWidth || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/** Character-level split of a single overlong word (last resort only). */
function splitWordToWidth(word: string, maxWidth: number, opts: MeasureOpts): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const ch of word) {
    const candidate = chunk + ch;
    if (measureTextWidth(candidate, opts) <= maxWidth || !chunk) {
      chunk = candidate;
    } else {
      chunks.push(chunk);
      chunk = ch;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/* ------------------------------------------------------------------ */
/* Safe region                                                          */
/* ------------------------------------------------------------------ */

/** Safe-margin ratio of the region's smaller dimension (4.5%). */
const MARGIN_RATIO = 0.045;
/** The title block may occupy at most this share of the safe height —
 *  the remainder is breathing room so the vertically centered block has
 *  balanced space above and below (never edge-to-edge). */
export const BLOCK_HEIGHT_RATIO = 0.82;
/** Short-title protection: the auto size never exceeds the preferred
 *  (design) size by more than this factor. */
const MAX_BOOST = 1.45;
/** Floor for the preferred size relative to the region, so a tiny stale
 *  manual value in the design cannot starve the boost. */
const PREFERRED_FLOOR_RATIO = 0.2;
/** Search precision (template px) — below one hundredth of the region,
 *  differences are invisible; keeps the result stable + cache-friendly. */
const SIZE_EPSILON = 0.25;

export function safeTitleRegion(region: Rect): Rect {
  const margin = Math.max(0.5, MARGIN_RATIO * Math.min(region.width, region.height));
  return {
    x: region.x + margin,
    y: region.y + margin,
    width: region.width - margin * 2,
    height: region.height - margin * 2,
  };
}

/* ------------------------------------------------------------------ */
/* The fitting algorithm                                               */
/* ------------------------------------------------------------------ */

export interface TitleFitResult {
  /** true when the size was computed by the fitting algorithm (region was
   *  usable). false → degenerate region/empty text: use legacy layout. */
  fitted: boolean;
  /** the auto-fit font size (template px). */
  fontSize: number;
  /** final line layout (uppercase applied, breaks preserved). */
  lines: string[];
  /** per-line advance height = fontSize × lineHeight. */
  lineHeightPx: number;
  /** height of the whole block = lines × lineHeightPx. */
  blockHeight: number;
  /** width of the widest line (px). */
  blockWidth: number;
  /** the safe (inset) region the block was fitted into. */
  safe: Rect;
}

function measureOpts(style: TextStyle, fontSize: number): MeasureOpts {
  return {
    fontFamily: style.fontFamily,
    fontSize,
    fontWeight: style.fontWeight,
    letterSpacing: style.letterSpacing,
    italic: style.fontStyle === "italic",
  };
}

/** fitTitle memo — the panel and the renderer compute the same result for
 *  the same inputs; keyed on every input that can change the outcome. */
const fitCache = new Map<string, TitleFitResult>();
const FIT_CACHE_CAP = 240;

/**
 * Fit a title into its region: the largest font size in
 * [minSize, maxSize] whose wrapped block satisfies BOTH
 *   maxLineWidth  ≤ safe.width   and
 *   blockHeight   ≤ BLOCK_HEIGHT_RATIO × safe.height,
 * found by bounded binary search (fits() is monotone in size: smaller
 * text never wraps to more lines or wider lines).
 *
 * Bounds:
 *   preferred = max(style.fontSize, safe.height × 0.2 / lineHeight) — the
 *               design's own size, floored so tiny stale values can't
 *               starve short titles.
 *   maxSize   = min(preferred × 1.45, height cap) — SHORT TITLE
 *               PROTECTION: controlled growth, never boundary-touching.
 *   minSize   = readable floor.
 */
export function fitTitle(text: string, region: Rect, style: TextStyle): TitleFitResult {
  const applied = style.uppercase ? text.toUpperCase() : text;
  const lineHeightMult = Math.max(0.5, style.lineHeight || 1);

  const key = [
    applied,
    region.x, region.y, region.width, region.height,
    style.fontFamily, style.fontWeight, style.letterSpacing, style.lineHeight,
    style.fontStyle === "italic" ? "i" : "n", style.fontSize,
  ].join("|");
  const hit = fitCache.get(key);
  if (hit) return hit;

  const safe = safeTitleRegion(region);
  const result = computeFit(applied, safe, style, lineHeightMult);

  if (fitCache.size >= FIT_CACHE_CAP) fitCache.clear();
  fitCache.set(key, result);
  return result;
}

function computeFit(
  text: string,
  safe: Rect,
  style: TextStyle,
  lineHeightMult: number
): TitleFitResult {
  const legacy = (fontSize: number, lines: string[]): TitleFitResult => ({
    fitted: false,
    fontSize,
    lines,
    lineHeightPx: fontSize * lineHeightMult,
    blockHeight: lines.length * fontSize * lineHeightMult,
    blockWidth: lines.reduce((w, l) => Math.max(w, measureTextWidth(l, measureOpts(style, fontSize))), 0),
    safe,
  });

  if (!text.trim() || safe.width <= 1 || safe.height <= 1) {
    return legacy(style.fontSize, text ? wrapLinesToWidth(text, Math.max(safe.width, 1), measureOpts(style, style.fontSize)) : []);
  }

  const preferred = Math.max(style.fontSize, (safe.height * PREFERRED_FLOOR_RATIO) / lineHeightMult);
  const heightCap = (safe.height * BLOCK_HEIGHT_RATIO) / lineHeightMult;
  const maxSize = Math.max(Math.min(preferred * MAX_BOOST, heightCap), 1);
  const minSize = Math.max(4, Math.min(safe.height * 0.045, preferred * 0.25), 1);

  const linesAt = (size: number): string[] =>
    wrapLinesToWidth(text, safe.width, measureOpts(style, size));
  const fits = (size: number): boolean => {
    const lines = linesAt(size);
    if (lines.length === 0) return true;
    let widest = 0;
    for (const line of lines) widest = Math.max(widest, measureTextWidth(line, measureOpts(style, size)));
    return (
      widest <= safe.width &&
      lines.length * size * lineHeightMult <= safe.height * BLOCK_HEIGHT_RATIO + 1e-6
    );
  };

  let size: number;
  if (fits(maxSize)) {
    size = maxSize;
  } else if (!fits(minSize)) {
    // pathological (region too small for even the floor): accept the floor —
    // the wrap's last-resort char-splitting still bounds the width
    size = minSize;
  } else {
    let lo = minSize;
    let hi = maxSize;
    while (hi - lo > SIZE_EPSILON) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    size = lo;
  }

  size = Math.round(size * 100) / 100;
  /* FINAL VALIDATION — the search converges to the exact flip point where
   * canvas sub-pixel measurement noise can flip the wrap AFTER the size
   * is rounded (the checked size and the emitted size differ by <0.01).
   * Re-check the constraints at the OUTPUT size and step down until the
   * block that will actually be emitted satisfies both — the emitted
   * result can never violate its own bounds. */
  let guard = 0;
  while (size > minSize && !fits(size) && guard++ < 12) {
    size = Math.max(minSize, Math.round((size - 0.25) * 100) / 100);
  }
  const lines = linesAt(size);
  const lineHeightPx = size * lineHeightMult;
  return {
    fitted: true,
    fontSize: size,
    lines,
    lineHeightPx,
    blockHeight: lines.length * lineHeightPx,
    blockWidth: lines.reduce((w, l) => Math.max(w, measureTextWidth(l, measureOpts(style, size))), 0),
    safe,
  };
}

/** Baseline convention shared with the classic renderer: the first line's
 *  baseline sits 0.8 × fontSize below the line-box top (≈ cap height).
 *  Returns the per-line baseline y positions for a block whose top edge is
 *  `blockTop` (template units). */
export function titleBaselines(blockTop: number, fit: TitleFitResult): number[] {
  return fit.lines.map((_, i) => blockTop + i * fit.lineHeightPx + 0.8 * fit.fontSize);
}

/** Vertical block center: the top edge that centers the whole block inside
 *  the safe region (respecting the user's offsetY). */
export function centeredBlockTop(fit: TitleFitResult, offsetY = 0): number {
  return fit.safe.y + (fit.safe.height - fit.blockHeight) / 2 + offsetY;
}
