"use client";

/**
 * ICON SHEET STUDIO — THE shared icon-fit engine (effective visual bounds).
 *
 * P7 root-cause fix: the whole pipeline previously fitted every icon by its
 * DECLARED viewBox (`scale = box / max(vbW, vbH)`, centering the viewBox) and
 * the panel previews set their svg viewport to that same viewBox. Icons whose
 * ARTWORK is not exactly the viewBox therefore rendered wrong at factor 1
 * already — artwork smaller than the viewBox (e.g. 0–24-authored artwork on
 * a 48-unit viewBox) rendered undersized AND off-center (the hero icon lost
 * in the hero-card corner); artwork extending beyond the viewBox was clipped
 * by every viewport that clips at the viewBox (panel tiles, hero picker).
 * Stroke adjustment additionally changes the ink extent (native strokes ×
 * factor; fill dilation grows each mark by κ·(f−1)·W beyond its contour) —
 * with the fit never recomputed, thickened artwork bled outside its cell and
 * was hard-clipped in the previews: exactly the "uniform 7 px → partially
 * cut off, normal → fully visible" regression.
 *
 * This module is the ONE source of truth for the icon's EFFECTIVE VISUAL
 * BOUNDS — the artwork geometry ± the stroke expansion at the APPLIED
 * factor — and for the per-icon embed plan derived from it:
 *
 *   ICON CELL (unchanged geometry)  →  embed box (unchanged)
 *   → iconEmbedPlan(svg, box, style): factor (basis-corrected) + ink bounds
 *   → uniform scale = box / max(ink.w, ink.h)   (aspect preserved)
 *   → centered on BOTH axes                       (never distorted)
 *   → the COMPLETE visible artwork stays inside the box at every factor.
 *
 * Consumers: the sheet renderer's embedIcon (cells AND hero — one engine),
 * the panel previews (styledIconPreviewSvg sets its viewport to the same ink
 * bounds so previews can never disagree with the sheet), the stroke status /
 * diagnostics readouts and the library tiles. Slot, cell, card and template
 * geometry are NEVER touched — only the icon's own scale/translate inside
 * the existing box changes.
 *
 * Honesty rules (identical philosophy to icon-style.ts):
 *  · measurement only — nothing here ever mutates the source SVG;
 *  · icons whose ink cannot be measured safely (text/`use` labels, em/ex
 *    stroke units, empty artwork, pathological bounds) report null and the
 *    caller falls back to the EXACT previous viewBox fit — never a guess;
 *  · the per-leaf classification (painted tags, skip subtrees, cascade
 *    resolution, unit-aware stroke widths, transform handling) MIRRORS the
 *    stroke engine's own walk so bounds and adjustment always agree.
 */

import { parseIcon, hashSvgContent } from "./svg";
import { elementBoundsPts, measureElementOutline } from "./path-geometry";
import type { Rect, SheetDesign } from "./types";
import {
  analyzeNativeStroke,
  computeStrokeAdjustment,
  acquireRoot,
  collectCssMap,
  readOwn,
  parseStrokeWidth,
  SKIP_SUBTREE_TAGS,
  PAINTED_LEAF_TAGS,
  FILL_DILATE_LEAF_TAGS,
  isNone,
  isUrl,
  viewBoxDiagonal,
} from "./icon-style";
import type { OwnDecls, StrokeAdjustmentPlan } from "./icon-style";

/* ------------------------------------------------------------------ */
/* Transform matrices (full 2×3 — translate/rotate/skew aware)         */
/* ------------------------------------------------------------------ */

/** [a b c d e f] — maps local (x, y) to parent (a·x + c·y + e, b·x + d·y + f). */
type Matrix = readonly [number, number, number, number, number, number];

const IDENT: Matrix = [1, 0, 0, 1, 0, 0];

function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Angle with SVG unit suffix → radians (default unit = degrees). */
function angleRad(raw: string): number {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return 0;
  const s = raw.trim().toLowerCase();
  if (s.endsWith("grad")) return (v * Math.PI) / 200;
  if (s.endsWith("rad")) return v;
  if (s.endsWith("turn")) return v * 2 * Math.PI;
  return (v * Math.PI) / 180;
}

function args(raw: string): number[] {
  return raw
    .split(/[\s,]+/)
    .map(parseFloat)
    .filter((n) => Number.isFinite(n));
}

/** Full SVG transform attribute → one matrix (functions multiply left→right,
 *  exactly like the rendering model). Unknown/malformed primitives are
 *  skipped conservatively (identity for that primitive). */
function parseTransform(attr: string | null): Matrix {
  if (!attr) return IDENT;
  let m = IDENT;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attr)) !== null) {
    const a = args(match[2]);
    switch (match[1]) {
      case "matrix":
        if (a.length >= 6) {
          m = mul(m, [a[0], a[1], a[2], a[3], a[4], a[5]]);
        }
        break;
      case "translate":
        if (a.length >= 1) {
          m = mul(m, [1, 0, 0, 1, a[0], a[1] ?? 0]);
        }
        break;
      case "scale": {
        const sx = a[0] ?? 1;
        const sy = a.length >= 2 ? a[1] : sx;
        m = mul(m, [sx, 0, 0, sy, 0, 0]);
        break;
      }
      case "rotate": {
        const t = angleRad(match[2].trim().split(/[\s,]+/)[0] ?? "");
        const cos = Math.cos(t);
        const sin = Math.sin(t);
        let r: Matrix = [cos, sin, -sin, cos, 0, 0];
        if (a.length >= 3) {
          // rotate(a, cx, cy) ≡ translate(cx,cy) · rotate(a) · translate(−cx,−cy)
          r = mul(mul([1, 0, 0, 1, a[1], a[2]], r), [1, 0, 0, 1, -a[1], -a[2]]);
        }
        m = mul(m, r);
        break;
      }
      case "skewX": {
        const t = angleRad(match[2].trim().split(/[\s,]+/)[0] ?? "");
        m = mul(m, [1, 0, Math.tan(t), 1, 0, 0]);
        break;
      }
      case "skewY": {
        const t = angleRad(match[2].trim().split(/[\s,]+/)[0] ?? "");
        m = mul(m, [1, Math.tan(t), 0, 1, 0, 0]);
        break;
      }
    }
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* Leaf geometry points (local space — bounds semantics)               */
/* ------------------------------------------------------------------ */

/** Points of ONE painted leaf in its LOCAL user space — BOUNDS semantics
 *  (elementBoundsPts): every sampled geometry point INCLUDING open 2-point
 *  line subpaths (they paint stroke ink — the fill-measurement polygon
 *  output drops them, which previously shifted arrow-style icons' bounds
 *  toward their heads and broke centering). null = no measurable geometry
 *  (malformed path, degenerate shape → renders nothing). */
function leafPoints(el: Element, tol: number): [number, number][] | null {
  return elementBoundsPts(el, tol);
}

/* ------------------------------------------------------------------ */
/* The ink-bounds walk                                                 */
/* ------------------------------------------------------------------ */

interface BoundsState {
  stroke?: string;
  widthRaw?: string;
  fill?: string;
  frEvenOdd: boolean;
  inDefs: boolean;
  matrix: Matrix;
  pctRef: number;
}

interface BoundsAccum {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  painted: boolean;
  /** painted leaves we cannot measure honestly (text/`use`, em/ex widths) —
   *  the whole icon falls back to the viewBox fit (never a guess). */
  unmeasurable: boolean;
}

/** Style declaration read from a style attribute (tiny — the walk only needs
 *  display/visibility/opacity for paint gating). */
function styleDecl(styleAttr: string, prop: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]*)`, "i");
  const m = styleAttr.match(re);
  return m ? m[1].trim() : null;
}

function walkInkBounds(
  el: Element,
  state: BoundsState,
  cssMap: Map<Element, OwnDecls> | null,
  tol: number,
  factor: number,
  acc: BoundsAccum
): void {
  const tag = el.localName?.toLowerCase() ?? "";
  /* Non-rendering subtrees — identical skip set to the stroke engine, PLUS
   * defs/symbol (their content renders only through <use>, and a painted
   * <use> already flags the icon honestly unmeasurable). */
  if (SKIP_SUBTREE_TAGS.has(tag) || tag === "defs" || tag === "symbol") return;

  /* Elements that paint nothing contribute no ink. */
  const styleAttr = el.getAttribute("style") ?? "";
  const display = styleDecl(styleAttr, "display") ?? el.getAttribute("display");
  if (display != null && display.trim().toLowerCase() === "none") return;
  const visibility = styleDecl(styleAttr, "visibility") ?? el.getAttribute("visibility");
  if (visibility != null && visibility.trim().toLowerCase() === "hidden") return;
  const opacityRaw = styleDecl(styleAttr, "opacity") ?? el.getAttribute("opacity");
  if (opacityRaw != null) {
    const op = parseFloat(opacityRaw);
    if (op === 0) return; // fully transparent subtree paints nothing
  }

  const own = readOwn(el, cssMap);
  const strokeVal = own.stroke !== undefined ? own.stroke : state.stroke;
  const widthRaw = own.strokeWidth !== undefined ? own.strokeWidth : state.widthRaw;
  const fillVal = own.fill !== undefined ? own.fill : state.fill;
  const frEvenOdd = state.frEvenOdd; // inherited only — bounds never need own fill-rule resolution beyond band measurement
  const matrix = mul(state.matrix, parseTransform(el.getAttribute("transform")));
  const nonScalingStroke = /non-scaling/i.test(el.getAttribute("vector-effect") ?? "");
  const activeStroke = strokeVal !== undefined && !isNone(strokeVal);

  if (tag === "use" || tag === "text" || tag === "tspan") {
    /* Reference/font geometry cannot be measured honestly — flag the icon
     * (viewBox fallback) instead of guessing. Only counts when the leaf can
     * actually paint (stroke or fill visible in this context). */
    const paintsFill = fillVal !== undefined ? !isNone(fillVal) && !isUrl(fillVal) : !state.inDefs;
    if (activeStroke || paintsFill) acc.unmeasurable = true;
    return;
  }

  if (PAINTED_LEAF_TAGS.has(tag)) {
    const paintsFill = fillVal !== undefined ? !isNone(fillVal) && !isUrl(fillVal) : !state.inDefs;
    if (activeStroke || paintsFill) {
      const pts = leafPoints(el, tol);
      if (!pts) {
        /* painted but no measurable geometry (malformed d / degenerate) —
         * the browser renders nothing for it: no ink, no fallback flag. */
        return;
      }
      /* -- effective stroke overhang in the LEAF's LOCAL space ----------
       * EXACTLY the width the stroke engine will render there:
       *  · stroked leaf: the engine multiplies the resolved local width by
       *    the factor (walkStroke writes eff·factor) → overhang eff·f/2;
       *  · fill-based leaf under dilation (factor > 1): the added mirrored
       *    stroke is κᵢ·(f−1)·Wᵢ per measured part → the widest overhang is
       *    max(κᵢ·(f−1)·Wᵢ)/2 (bands κ=1, solids κ up to 2);
       *  · thinning only ever shrinks ink → geometry bounds already cover
       *    the thinned artwork (the erosion mask region itself is padded).
       * Unresolvable widths (em/ex) flag the icon honestly unmeasurable. */
      let overhang = 0;
      if (activeStroke && !nonScalingStroke) {
        const eff = parseStrokeWidth(widthRaw, state.pctRef);
        if (eff == null) {
          acc.unmeasurable = true;
          return;
        }
        if (eff > 0) overhang = (eff * factor) / 2;
      } else if (
        !activeStroke &&
        factor > 1 &&
        FILL_DILATE_LEAF_TAGS.has(tag) &&
        !nonScalingStroke &&
        paintsFill
      ) {
        const report = measureElementOutline(el, frEvenOdd, tol);
        if (report) {
          let grow = 0;
          for (const band of report.bands) {
            grow = Math.max(grow, ((factor - 1) * band.width) / 2);
          }
          for (const s of report.solids) {
            grow = Math.max(grow, (s.kappa * (factor - 1) * s.width) / 2);
          }
          overhang = grow;
        }
      }

      /* local bbox ± overhang, transformed through the accumulated matrix
       * (own transform included — the same space the geometry renders in). */
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of pts) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const corners: [number, number][] = [
        [minX - overhang, minY - overhang],
        [maxX + overhang, minY - overhang],
        [maxX + overhang, maxY + overhang],
        [minX - overhang, maxY + overhang],
      ];
      for (const [x, y] of corners) {
        const px = matrix[0] * x + matrix[2] * y + matrix[4];
        const py = matrix[1] * x + matrix[3] * y + matrix[5];
        if (px < acc.minX) acc.minX = px;
        if (py < acc.minY) acc.minY = py;
        if (px > acc.maxX) acc.maxX = px;
        if (py > acc.maxY) acc.maxY = py;
      }
      acc.painted = true;
    }
  }

  const nextState: BoundsState = {
    stroke: strokeVal,
    widthRaw,
    fill: fillVal,
    frEvenOdd,
    inDefs: state.inDefs || tag === "defs" || tag === "symbol",
    matrix,
    pctRef: state.pctRef,
  };
  for (const child of Array.from(el.children)) {
    walkInkBounds(child, nextState, cssMap, tol, factor, acc);
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Pathological-guard: artwork legitimately extends past the viewBox
 *  sometimes, but anything beyond 20× the declared canvas is measurement
 *  trouble (broken transform math) — fall back rather than shrink the icon
 *  to a dot. */
const INSANE_FACTOR = 20;

const inkCache = new Map<string, Rect | null>();
const INK_CACHE_CAP = 4000;

function inkCachePut(key: string, value: Rect | null): void {
  if (inkCache.size >= INK_CACHE_CAP) {
    const oldest = inkCache.keys().next().value;
    if (oldest !== undefined) inkCache.delete(oldest);
  }
  inkCache.set(key, value);
}

/**
 * The icon's EFFECTIVE VISUAL (ink) bounds in ROOT units — the artwork
 * geometry ± the stroke expansion at the given factor (native strokes ×
 * factor for stroked leaves; κ·(f−1)·W/2 max over measured parts for
 * dilated fill leaves; thinning shrinks — covered by the geometry).
 *
 * Pure, cached by (content hash, factor), deterministic, never mutates the
 * source. null = honestly unmeasurable (text/`use` artwork, em/ex stroke
 * units, empty/painted-nothing icons, pathological bounds) — callers fall
 * back to the EXACT previous viewBox fit.
 */
export function iconInkBounds(source: string, factor: number): Rect | null {
  if (!source || !Number.isFinite(factor) || factor <= 0) return null;
  const hash = hashSvgContent(source);
  const key = `${hash}|f${factor.toFixed(5)}`;
  const cached = inkCache.get(key);
  if (cached !== undefined) {
    inkCache.delete(key);
    inkCache.set(key, cached); // LRU refresh
    return cached;
  }

  let result: Rect | null = null;
  const parsed = parseIcon(source);
  if (parsed) {
    const innerHash = hashSvgContent(parsed.inner);
    const root = acquireRoot(parsed.inner, innerHash);
    if (root) {
      try {
        const cssMap = collectCssMap(root);
        const vbW = parsed.viewBox[2];
        const vbH = parsed.viewBox[3];
        const viewBoxSize = Math.max(vbW, vbH) || 24;
        const tol = Math.min(0.25, Math.max(0.01, viewBoxSize / 1200));
        const seed: BoundsState = {
          stroke: parsed.rootStyle.stroke,
          widthRaw: parsed.rootStyle["stroke-width"],
          fill: parsed.rootStyle.fill,
          frEvenOdd: (parsed.rootStyle["fill-rule"] ?? "").trim().toLowerCase() === "evenodd",
          inDefs: false,
          matrix: IDENT,
          pctRef: viewBoxDiagonal(vbW, vbH),
        };
        const acc: BoundsAccum = {
          minX: Infinity,
          minY: Infinity,
          maxX: -Infinity,
          maxY: -Infinity,
          painted: false,
          unmeasurable: false,
        };
        for (const child of Array.from(root.children)) {
          walkInkBounds(child, seed, cssMap, tol, factor, acc);
        }
        if (acc.painted && !acc.unmeasurable && Number.isFinite(acc.minX) && Number.isFinite(acc.maxX)) {
          const w = acc.maxX - acc.minX;
          const h = acc.maxY - acc.minY;
          const insane = INSANE_FACTOR * viewBoxSize;
          if (w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h) && Math.max(w, h) <= insane) {
            result = { x: acc.minX, y: acc.minY, width: w, height: h };
          }
        }
      } catch {
        result = null;
      }
    }
  }
  inkCachePut(key, result);
  return result;
}

/**
 * The icon's native FIT BASIS in root units — max(ink.w, ink.h) at factor 1,
 * falling back to the declared viewBox's larger dimension when the ink is
 * unmeasurable. This is the divisor the stroke factor math uses
 * (`nativeVisual = rootWidth · box / basis`) so a px target lands at the
 * TRUE visual weight of the artwork (icons whose ink ≠ viewBox previously
 * landed at scaled-off targets — a 48-unit viewBox with 24-unit artwork
 * rendered its "7 px" at 3.5 px).
 */
export function iconFitBasis(source: string): number {
  const parsed = parseIcon(source);
  const vbMax = parsed ? Math.max(parsed.viewBox[2], parsed.viewBox[3]) || 24 : 24;
  const ink = iconInkBounds(source, 1);
  if (!ink) return vbMax;
  const m = Math.max(ink.width, ink.height);
  return m > 0 && Number.isFinite(m) ? m : vbMax;
}

/** What ONE icon embed will actually receive — the shared plan every
 *  rendering surface (sheet cells, hero, panel previews, diagnostics)
 *  derives from, so the factor, the ink bounds and the fitted result can
 *  never disagree. */
export interface IconEmbedPlan {
  /** The stroke engine's plan with the BASIS-CORRECTED factor: the scale
   *  used for nativeVisualPx is the artwork's actual render scale
   *  (box / ink basis), refined once against the at-factor ink (dilation
   *  grows the artwork → the render scale shrinks; erosion shrinks it →
   *  the scale grows — one fixed-point step lands the visual target). */
  plan: StrokeAdjustmentPlan;
  /** The ink bounds AT the final factor — the region the embed must fit
   *  into its box (uniform scale, centered). null → unmeasurable: fit the
   *  declared viewBox exactly as before. */
  ink: Rect | null;
}

/**
 * THE per-icon embed plan — one source of truth for the renderer, the
 * panel previews and the diagnostics. Mirrors the previous
 * computeStrokeAdjustment(viewBoxMaxDim, boxSize, style) call sites with
 * the corrected basis; for icons whose ink ≈ viewBox the numbers are
 * IDENTICAL to the legacy computation (zero regression), and only icons
 * whose artwork ≠ viewBox get the honest correction.
 */
export function iconEmbedPlan(
  source: string,
  boxSize: number,
  iconStyle: SheetDesign["icon"]
): IconEmbedPlan {
  const parsed = parseIcon(source);
  const vbMax = parsed ? Math.max(parsed.viewBox[2], parsed.viewBox[3]) || 24 : 24;
  const native = analyzeNativeStroke(source);
  const nativeInk = iconInkBounds(source, 1);
  const basis0 = nativeInk ? Math.max(nativeInk.width, nativeInk.height) : vbMax;

  let plan = computeStrokeAdjustment(native, basis0 > 0 ? basis0 : vbMax, boxSize, iconStyle);
  /* One fixed-point refinement: the factor changes the ink extent, which
   *  changes the actual render scale, which re-anchors the px target. The
   *  iteration map is monotone (ink grows with the factor) — a single step
   *  lands within a few percent; containment itself is guaranteed by the
   *  at-factor fit below, this only sharpens the visual px landing. */
  if (plan.factor !== 1 && plan.nativeVisualPx > 0) {
    const inkF = iconInkBounds(source, plan.factor);
    if (inkF) {
      const basis1 = Math.max(inkF.width, inkF.height);
      if (basis1 > 0 && Math.abs(basis1 - basis0) > 1e-9) {
        plan = computeStrokeAdjustment(native, basis1, boxSize, iconStyle);
      }
    }
  }

  const ink = plan.factor === 1 ? nativeInk : iconInkBounds(source, plan.factor);
  return { plan, ink };
}

/**
 * The icon's NATIVE visual width (canvas px) at a given embed box — the
 * native look measured at the artwork's true render scale (box / ink basis).
 * Pure display helper (status ranges, library badges, popover readouts);
 * the render plan itself always comes from iconEmbedPlan. 0 = unmeasurable.
 */
export function iconNativeVisualPx(source: string, boxSize: number): number {
  const native = analyzeNativeStroke(source);
  if (!(native.rootWidth > 0 && Number.isFinite(native.rootWidth))) return 0;
  if (!(boxSize > 0 && Number.isFinite(boxSize))) return 0;
  const basis = iconFitBasis(source);
  const scale = boxSize / Math.max(basis, 1e-6);
  return native.rootWidth * Math.max(scale, 1e-6);
}
