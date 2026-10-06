"use client";

/**
 * ICON SHEET STUDIO — Icon visual similarity (round 10).
 *
 * Finds icons that LOOK like the same glyph even when their file names
 * differ (the health report's "duplicate file names" check only catches
 * same-name imports; this catches renamed copies and near-identical
 * artwork — the other way sheets end up rendering "one glyph twice").
 *
 * Method — a rasterized geometry signature, computed from the SAME
 * immutable source SVGs every other engine reads:
 *   1. parse the icon (memoized `parseIcon`) → viewBox + inner markup;
 *   2. DOM-parse the fragment and sample every shape element into
 *      polygons via the measurement engine's `elementPolys` (paths,
 *      rects, circles, ellipses, polygons — plus local handling for
 *      polyline/line segments);
 *   3. normalize all points into the viewBox → a 32×32 fine EDGE grid
 *      (geometry crossings: the centerline of stroked icons and the
 *      boundary of filled ones — the shape itself), a 32×32 FILL grid
 *      (non-degenerate polygon interiors; degenerate centerline loops
 *      are skipped), and a 16×16 coarse edge+fill pair derived by
 *      2×2 block-OR;
 *   4. pair similarity runs in TWO stages — a cheap coarse blend
 *      (edge-weighted, fill-neutral when both fills are empty) that
 *      early-rejects obvious non-matches, then a fine edge Jaccard that
 *      separates look-alike simple shapes (circle vs rounded square vs
 *      hexagon diverge at 32×32 but blur together at 16×16). Both
 *      Jaccards use a SOFT intersection (a set bit counts when the
 *      other grid has a bit in its 3×3 neighborhood — tolerant of the
 *      ±1-cell raster jitter two hand-exported copies of the same
 *      glyph always have), clamped so it can never exceed a true
 *      intersection.
 *
 * Byte-identical sources short-circuit to score 1 (the classic renamed
 * copy). Pairs at/above the threshold are merged into groups with
 * union-find, so a triplet of copies reads as ONE finding.
 *
 * Round 14 — DIHEDRAL extension (opt-in): the scan can additionally
 * match copies someone also ROTATED (90°/180°/270°) or MIRRORED.
 * Off by default — arrow-up vs arrow-right are exact 90° rotations of
 * one another yet DIFFERENT glyphs, so orientation-insensitive matching
 * must never run silently. When enabled, every grid pair is scored
 * against all 8 dihedral orientations of one signature (rotations and
 * mirrors of a rasterized grid are exact INDEX PERMUTATIONS — no
 * re-rasterization needed) and the winning orientation is reported on
 * the pair ("rotated 90°", "mirrored", …) so the finding explains
 * itself. The store's consolidate actions work unchanged on the ids.
 *
 * MEASUREMENT ONLY — nothing here mutates icons, sheets or markup, and
 * nothing contributes to preview or export. Browser-only (DOMParser);
 * every entry point returns empty results when DOM APIs are absent.
 */

import { parseIcon, hashSvgContent } from "./svg";
import { elementPolys, splitSubpaths, type Poly } from "./path-geometry";
import type { IconEntry } from "./types";

/** Pairs at/above this score are reported (0..1). */
export const SIMILARITY_THRESHOLD = 0.84;
/** Pairs at/above this score are "near-identical" (filter chip in the dialog). */
export const NEAR_IDENTICAL_THRESHOLD = 0.9;

/** Grid resolutions — coarse is derived from fine by 2×2 block-OR. */
const FINE = 32;
const FINE_CELLS = FINE * FINE;
const COARSE = 16;
const COARSE_CELLS = COARSE * COARSE;

/** Coarse score below this rejects the pair before the fine stage. */
const COARSE_REJECT = 0.75;

/** Signature cache cap (svg source string → signature). */
const SIG_CACHE_CAP = 2000;

export interface IconSignature {
  /** 256 cells — coarse geometry crossings (2×2 block-OR of fine). */
  coarseEdge: Uint8Array;
  /** 256 cells — coarse interior coverage (2×2 block-OR of fine). */
  coarseFill: Uint8Array;
  /** 1024 cells — fine geometry crossings. */
  fineEdge: Uint8Array;
  popCoarseEdge: number;
  popCoarseFill: number;
  popFineEdge: number;
  /** fine-grid interior coverage (fill density) — used by the debug hook
   *  to verify the FILL-NEUTRAL scoring path. */
  popFineFill: number;
  /** ink bbox aspect (width/height, clamped 1/8..8) — the sheet fits
   *  icons to cells preserving aspect, so aspect is a first-class
   *  discriminator (a 3:2 glyph can never be a copy of a 1:1 glyph). */
  aspect: number;
}

export interface SimilarityPair {
  /** icon ids — a comes before b in iconOrder. */
  a: string;
  b: string;
  /** 0..1 — two-stage soft Jaccard blend. */
  score: number;
  /** Dihedral winning orientation of `b` relative to `a` — e.g.
   *  "rotated 90°", "mirrored". Absent when both sources share one
   *  orientation (identity) — the pre-round-14 case. */
  transform?: string;
}

export interface SimilarityGroup {
  /** member icon ids, in iconOrder order. */
  ids: string[];
  /** every intra-group pair above the threshold, score-desc. */
  pairs: SimilarityPair[];
  /** the group's highest pair score. */
  best: number;
}

/* ------------------------------------------------------------------ */
/* Signature computation                                               */
/* ------------------------------------------------------------------ */

const sigCache = new Map<string, IconSignature | null>();

function cachePut(key: string, v: IconSignature | null): void {
  if (sigCache.size >= SIG_CACHE_CAP) {
    // drop the oldest entry (insertion order = LRU-ish for this workload)
    const oldest = sigCache.keys().next().value;
    if (oldest !== undefined) sigCache.delete(oldest);
  }
  sigCache.set(key, v);
}

/** Deterministic local DOM parse of an svg fragment (children of <svg>). */
function parseFragmentRoot(inner: string): Element | null {
  if (typeof DOMParser === "undefined") return null;
  try {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`,
      "image/svg+xml"
    );
    if (doc.getElementsByTagName("parsererror").length > 0) return null;
    const root = doc.documentElement;
    if (!root || root.localName.toLowerCase() !== "svg") return null;
    return root;
  } catch {
    return null;
  }
}

/** Mark the cells crossed by one segment (fine-grid coords). */
function rasterSegment(edge: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len * 2)); // ~0.5-cell sampling
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    const cx = Math.min(FINE - 1, Math.max(0, Math.floor(x)));
    const cy = Math.min(FINE - 1, Math.max(0, Math.floor(y)));
    edge[cy * FINE + cx] = 1;
  }
}

/** Mark the cells crossed by a point sequence's segments. */
function markSequence(edge: Uint8Array, pts: [number, number][], close: boolean): void {
  for (let i = 0; i + 1 < pts.length; i++) {
    rasterSegment(edge, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
  }
  if (close && pts.length > 2) {
    const a = pts[pts.length - 1];
    const b = pts[0];
    rasterSegment(edge, a[0], a[1], b[0], b[1]);
  }
}

/** Scanline fill (even-odd) of one polygon into the fill layer.
 *  Degenerate (near-zero-area) polygons are skipped — those are the
 *  centerline loops of stroked paths, already captured by the edge layer. */
function fillPoly(fill: Uint8Array, pts: [number, number][]): void {
  const n = pts.length;
  if (n < 3) return;
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    area2 += x0 * y1 - x1 * y0;
  }
  if (Math.abs(area2) < 1e-6) return;
  for (let row = 0; row < FINE; row++) {
    const y = row + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % n];
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = xs[k];
      const xb = xs[k + 1];
      const c0 = Math.max(0, Math.floor(xa));
      const c1 = Math.min(FINE - 1, Math.floor(xb));
      for (let cx = c0; cx <= c1; cx++) {
        const center = cx + 0.5;
        if (center >= xa && center <= xb) fill[row * FINE + cx] = 1;
      }
    }
  }
}

/** polyline/line elements are not handled by elementPolys — sample them
 *  here as open point sequences (edge layer only). */
function sequencePoints(el: Element): [number, number][] | null {
  const tag = el.localName?.toLowerCase() ?? "";
  if (tag === "line") {
    const x1 = parseFloat(el.getAttribute("x1") ?? "0");
    const y1 = parseFloat(el.getAttribute("y1") ?? "0");
    const x2 = parseFloat(el.getAttribute("x2") ?? "0");
    const y2 = parseFloat(el.getAttribute("y2") ?? "0");
    if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return null;
    return [[x1, y1], [x2, y2]];
  }
  if (tag === "polyline") {
    const raw = (el.getAttribute("points") ?? "").trim();
    if (!raw) return null;
    const nums: number[] = [];
    const re = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) nums.push(parseFloat(m[0]));
    const pts: [number, number][] = [];
    for (let k = 0; k + 1 < nums.length; k += 2) pts.push([nums[k], nums[k + 1]]);
    return pts.length >= 2 ? pts : null;
  }
  return null;
}

/* --- degenerate subpath endpoint extraction ------------------------
 * splitSubpaths/parsePathD only emit SAMPLED POLYGONS for subpaths with
 * ≥3 points — every 2-point segment ("M12 2v2", "M20 20l-4-4", the
 * v.01 dots…) drops out of the poly list. Those spans are straight
 * segments by construction (any curve flattens to more points), so a
 * tiny line-command parser recovers their endpoints exactly. Returns
 * null for anything it doesn't understand — that geometry is skipped
 * honestly rather than guessed. */
const NUM_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;
const WS_RE = /[\s,]*/y;

function readNumAt(s: string, i: number): [number, number] | null {
  NUM_RE.lastIndex = i;
  const m = NUM_RE.exec(s);
  if (!m) return null;
  return [parseFloat(m[0]), NUM_RE.lastIndex];
}

function skipSep(s: string, i: number): number {
  WS_RE.lastIndex = i;
  const m = WS_RE.exec(s);
  return m ? WS_RE.lastIndex : i;
}

function isNumStart(ch: string | undefined): boolean {
  return ch !== undefined && (ch === "-" || ch === "+" || ch === "." || (ch >= "0" && ch <= "9"));
}

function spanEndpoints(src: string, start: [number, number]): [number, number][] | null {
  let i = skipSep(src, 0);
  const mc = src[i];
  if (mc !== "M" && mc !== "m") return null;
  const rel = mc === "m";
  i++;
  i = skipSep(src, i);
  const mx = readNumAt(src, i);
  if (!mx) return null;
  i = skipSep(src, mx[1]);
  const my = readNumAt(src, i);
  if (!my) return null;
  let x = rel ? start[0] + mx[0] : mx[0];
  let y = rel ? start[1] + my[0] : my[0];
  const pts: [number, number][] = [[x, y]];

  i = skipSep(src, my[1]);
  if (i >= src.length) return null; // moveto-only — renders nothing
  let cmd = src[i];
  if (cmd === "l" || cmd === "L" || cmd === "v" || cmd === "V" || cmd === "h" || cmd === "H") {
    i++;
  } else if (isNumStart(cmd)) {
    cmd = rel ? "l" : "L"; // implicit repetition of moveto = lineto
  } else {
    return null; // curve or closepath-only — out of scope for 2-point spans
  }
  i = skipSep(src, i);
  const n1 = readNumAt(src, i);
  if (!n1) return null;
  i = n1[1];
  let nx = x;
  let ny = y;
  if (cmd === "l" || cmd === "L") {
    i = skipSep(src, i);
    const n2 = readNumAt(src, i);
    if (!n2) return null;
    i = n2[1];
    if (cmd === "l") {
      nx = x + n1[0];
      ny = y + n2[0];
    } else {
      nx = n1[0];
      ny = n2[0];
    }
  } else if (cmd === "v" || cmd === "V") {
    ny = cmd === "v" ? y + n1[0] : n1[0];
  } else {
    nx = cmd === "h" ? x + n1[0] : n1[0];
  }
  pts.push([nx, ny]);
  /* more numeric data after the segment would have produced ≥3 sampled
   * points (and a poly) — inconsistency means the span is not the simple
   * segment this parser assumes; bail honestly */
  i = skipSep(src, i);
  if (i < src.length && isNumStart(src[i])) return null;
  return pts;
}

/** Compute (or fetch from cache) an icon's geometry signature. */
export function iconSignature(svg: string): IconSignature | null {
  const cached = sigCache.get(svg);
  if (cached !== undefined) return cached;
  const sig = computeSignature(svg);
  cachePut(svg, sig);
  return sig;
}

function computeSignature(svg: string): IconSignature | null {
  const parsed = parseIcon(svg);
  if (!parsed) return null;
  const [vbx, vby, vbw, vbh] = parsed.viewBox;
  if (!(vbw > 0) && !(vbh > 0)) return null;
  const w = vbw > 0 ? vbw : vbh;
  const h = vbh > 0 ? vbh : vbw;

  const root = parseFragmentRoot(parsed.inner);
  if (!root) return null;

  /* sampling tolerance — coarser than the stroke engine's (a 32×32 grid
   * cannot see sub-cell detail), same clamping philosophy. */
  const tol = Math.min(0.4, Math.max(0.02, Math.max(w, h) / 400));

  /* PASS 1 — collect every shape's sampled points (viewBox units) and
   * the INK bounding box they span. Normalization later maps the ink
   * box to the grid (uniform scale, centered): the sheet renderer fits
   * each icon to its cell the same way, so viewBox padding/scale must
   * NOT influence the comparison — two exports of one glyph at
   * different scales or padding render IDENTICALLY on a sheet. */
  interface Shape {
    pts: [number, number][];
    close: boolean;
    fillable: boolean;
  }
  const shapes: Shape[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const track = (pts: [number, number][]): void => {
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  };
  const els = root.querySelectorAll("path, rect, circle, ellipse, polygon, polyline, line");
  els.forEach((el) => {
    const tag = el.localName?.toLowerCase() ?? "";
    if (tag === "path") {
      /* splitSubpaths keeps EVERY subpath (including the 2-point segments
       * parsePathD's polygon list drops) with its own sampled poly + the
       * span source for degenerate-span endpoint recovery. */
      const spans = splitSubpaths(el.getAttribute("d") ?? "", tol);
      if (!spans) return;
      for (const span of spans) {
        if (span.poly && span.poly.pts.length >= 2) {
          shapes.push({ pts: span.poly.pts, close: span.closed, fillable: span.poly.pts.length >= 3 });
          track(span.poly.pts);
        } else {
          const seg = spanEndpoints(span.src, span.start);
          if (seg) {
            shapes.push({ pts: seg, close: false, fillable: false });
            track(seg);
          }
        }
      }
      return;
    }
    const seq = sequencePoints(el);
    if (seq) {
      shapes.push({ pts: seq, close: false, fillable: false });
      track(seq);
      return;
    }
    const polys: Poly[] | null = elementPolys(el, tol);
    if (!polys) return;
    for (const poly of polys) {
      if (poly.pts.length < 2) continue;
      shapes.push({ pts: poly.pts, close: true, fillable: poly.pts.length >= 3 });
      track(poly.pts);
    }
  });

  const bw = maxX - minX;
  const bh = maxY - minY;
  const span = Math.max(bw, bh);
  if (!(span > 0) || !Number.isFinite(span)) return null; // no recognizable geometry

  /* PASS 2 — rasterize with ink-box normalization: uniform scale (aspect
   * PRESERVED — the renderer letterboxes too) onto 92% of the fine grid,
   * centered. */
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const s = (FINE * 0.92) / span;
  const map = (p: [number, number]): [number, number] => [
    (p[0] - cx) * s + FINE / 2,
    (p[1] - cy) * s + FINE / 2,
  ];

  const fineEdge = new Uint8Array(FINE_CELLS);
  const fineFill = new Uint8Array(FINE_CELLS);
  for (const sh of shapes) {
    const gridPts = sh.pts.map(map);
    markSequence(fineEdge, gridPts, sh.close);
    if (sh.fillable) fillPoly(fineFill, gridPts);
  }

  /* coarse grids = 2×2 block-OR of the fine grids */
  const coarseEdge = new Uint8Array(COARSE_CELLS);
  const coarseFill = new Uint8Array(COARSE_CELLS);
  let popFineEdge = 0;
  let popFineFill = 0;
  for (let i = 0; i < FINE_CELLS; i++) {
    popFineEdge += fineEdge[i];
    popFineFill += fineFill[i];
  }
  if (popFineEdge === 0 && popFineFill === 0) return null;
  for (let cy2 = 0; cy2 < COARSE; cy2++) {
    for (let cx2 = 0; cx2 < COARSE; cx2++) {
      let e = 0;
      let f = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const idx = (cy2 * 2 + dy) * FINE + (cx2 * 2 + dx);
          e |= fineEdge[idx];
          f |= fineFill[idx];
        }
      }
      coarseEdge[cy2 * COARSE + cx2] = e;
      coarseFill[cy2 * COARSE + cx2] = f;
    }
  }
  let popCoarseEdge = 0;
  let popCoarseFill = 0;
  for (let i = 0; i < COARSE_CELLS; i++) {
    popCoarseEdge += coarseEdge[i];
    popCoarseFill += coarseFill[i];
  }

  return {
    coarseEdge,
    coarseFill,
    fineEdge,
    popCoarseEdge,
    popCoarseFill,
    popFineEdge,
    popFineFill,
    aspect: Math.min(8, Math.max(1 / 8, bw / Math.max(bh, span * 1e-4))),
  };
}

/* ------------------------------------------------------------------ */
/* Pair scoring                                                        */
/* ------------------------------------------------------------------ */

/** Soft intersection on the COARSE grid (3×3 neighborhood). */
function softInterCoarse(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let cy = 0; cy < COARSE; cy++) {
    for (let cx = 0; cx < COARSE; cx++) {
      if (a[cy * COARSE + cx] === 0) continue;
      const y0 = Math.max(0, cy - 1);
      const y1 = Math.min(COARSE - 1, cy + 1);
      const x0 = Math.max(0, cx - 1);
      const x1 = Math.min(COARSE - 1, cx + 1);
      let hit = false;
      outer: for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (b[yy * COARSE + xx] === 1) {
            hit = true;
            break outer;
          }
        }
      }
      if (hit) n++;
    }
  }
  return n;
}

/** Soft intersection on the FINE grid (3×3 neighborhood). */
function softInterFine(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let cy = 0; cy < FINE; cy++) {
    for (let cx = 0; cx < FINE; cx++) {
      if (a[cy * FINE + cx] === 0) continue;
      const y0 = Math.max(0, cy - 1);
      const y1 = Math.min(FINE - 1, cy + 1);
      const x0 = Math.max(0, cx - 1);
      const x1 = Math.min(FINE - 1, cx + 1);
      let hit = false;
      outer: for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (b[yy * FINE + xx] === 1) {
            hit = true;
            break outer;
          }
        }
      }
      if (hit) n++;
    }
  }
  return n;
}

/** Jaccard with a symmetric soft intersection, CLAMPED to a true
 *  intersection (the soft overlap of a sparse grid with a dense one
 *  could otherwise "intersect" more cells than the sparse grid holds),
 *  and with the symmetric difference counted TWICE in the denominator:
 *
 *    J' = inter / (2 · union − inter)  =  inter / (union + symDiff)
 *
 *  The doubling is what makes look-alikes with a shared big structure
 *  (a boundary circle with different interior marks — check-circle vs
 *  clock) score below the threshold while true copies (symDiff ≈ 0
 *  thanks to the ±1-cell softening) still land at ~1. 1 when both grids
 *  are empty, 0 when either is. */
function softJaccard(
  interAB: number,
  interBA: number,
  popA: number,
  popB: number
): number {
  if (popA === 0 && popB === 0) return 1;
  if (popA === 0 || popB === 0) return 0;
  const inter = Math.min(Math.max(interAB, interBA), popA, popB);
  const union = popA + popB - inter;
  return inter / (union + (popA + popB - 2 * inter));
}

function coarseScore(sa: IconSignature, sb: IconSignature): number {
  const jE = softJaccard(
    softInterCoarse(sa.coarseEdge, sb.coarseEdge),
    softInterCoarse(sb.coarseEdge, sa.coarseEdge),
    sa.popCoarseEdge,
    sb.popCoarseEdge
  );
  /* fill layer is NEUTRAL when both icons have no interior (outline
   * icons) — an empty-vs-empty match must not inflate the score */
  if (sa.popCoarseFill === 0 && sb.popCoarseFill === 0) return jE;
  const jF = softJaccard(
    softInterCoarse(sa.coarseFill, sb.coarseFill),
    softInterCoarse(sb.coarseFill, sa.coarseFill),
    sa.popCoarseFill,
    sb.popCoarseFill
  );
  return 0.8 * jE + 0.2 * jF;
}

export function pairScore(sa: IconSignature, sb: IconSignature): number {
  /* cheap prefilter 1 — aspect: the sheet fits icons to cells preserving
   * aspect, so a materially different aspect ratio can never be a copy
   * (0.35 in log2 ≈ a 27% aspect change). */
  const aspectDelta = Math.abs(Math.log2(sa.aspect / sb.aspect));
  if (aspectDelta > 0.35) return 0;
  /* cheap prefilter 2 — ink density (crossing count): wildly different
   * amounts of geometry can't match. */
  const densA = sa.popFineEdge;
  const densB = sb.popFineEdge;
  if (Math.min(densA, densB) / Math.max(densA, densB) < 0.6) return 0;

  /* stage 1 — coarse blend; below the reject line this can't be a match */
  const coarse = coarseScore(sa, sb);
  if (coarse < COARSE_REJECT) return 0;

  /* stage 2 — fine edge Jaccard. Look-alike simple shapes (circle vs
   * rounded square vs hexagon) blur together at 16×16 but diverge at
   * 32×32, where the ±1-cell softening no longer bridges their gaps. */
  const jF = softJaccard(
    softInterFine(sa.fineEdge, sb.fineEdge),
    softInterFine(sb.fineEdge, sa.fineEdge),
    sa.popFineEdge,
    sb.popFineEdge
  );
  return 0.5 * coarse + 0.5 * jF;
}

/* ------------------------------------------------------------------ */
/* Dihedral orientation variants (round 14)                           */
/* ------------------------------------------------------------------ */

/** The 8 elements of the dihedral group (4 rotations × mirror) as grid
 *  index permutations. Grids are square (32 fine / 16 coarse), so every
 *  element is an exact remap — no re-rasterization, no resampling error. */
type DihedralId =
  | "identity"
  | "rot90"
  | "rot180"
  | "rot270"
  | "mirror"
  | "mirror-rot90"
  | "mirror-rot180"
  | "mirror-rot270";

interface DihedralTransform {
  id: DihedralId;
  /** human label for the pair finding; identity carries none */
  label: string;
  /** 90°/270° rotations swap the ink aspect (a → 1/a). */
  swapsAspect: boolean;
  /** destination cell of source cell (x, y) on an n×n grid. */
  map: (x: number, y: number, n: number) => readonly [number, number];
}

const DIHEDRAL: readonly DihedralTransform[] = [
  { id: "identity", label: "", swapsAspect: false, map: (x, y) => [x, y] },
  /* clockwise rotations */
  { id: "rot90", label: "rotated 90°", swapsAspect: true, map: (x, y, n) => [n - 1 - y, x] },
  { id: "rot180", label: "rotated 180°", swapsAspect: false, map: (x, y, n) => [n - 1 - x, n - 1 - y] },
  { id: "rot270", label: "rotated 270°", swapsAspect: true, map: (x, y, n) => [y, n - 1 - x] },
  /* horizontal mirror, then the rotations on top of it */
  { id: "mirror", label: "mirrored", swapsAspect: false, map: (x, y, n) => [n - 1 - x, y] },
  {
    id: "mirror-rot90",
    label: "mirrored + rotated 90°",
    swapsAspect: true,
    map: (x, y, n) => [n - 1 - y, n - 1 - x],
  },
  {
    id: "mirror-rot180",
    label: "mirrored + rotated 180°",
    swapsAspect: false,
    map: (x, y, n) => [x, n - 1 - y],
  },
  {
    id: "mirror-rot270",
    label: "mirrored + rotated 270°",
    swapsAspect: true,
    map: (x, y, n) => [y, x],
  },
];

/** Remap an n×n grid under one dihedral element (cell permutation). */
function remapGrid(src: Uint8Array, n: number, tr: DihedralTransform): Uint8Array {
  const dst = new Uint8Array(src.length);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const [nx, ny] = tr.map(x, y, n);
      dst[ny * n + nx] = src[y * n + x];
    }
  }
  return dst;
}

/* Variant cache keyed on the BASE signature object — lives exactly as
 * long as the signature does (sigCache's LRU eviction drops both). */
const variantCache = new WeakMap<IconSignature, Partial<Record<DihedralId, IconSignature>>>();

/** The signature as it would rasterize if the source artwork were rotated
 *  and/or mirrored. Populations are permutation-invariant (same bits,
 *  relocated); only the grids and (for 90°/270°) the aspect change. */
function dihedralVariant(base: IconSignature, tr: DihedralTransform): IconSignature {
  if (tr.id === "identity") return base;
  let cached = variantCache.get(base);
  if (!cached) {
    cached = {};
    variantCache.set(base, cached);
  }
  const hit = cached[tr.id];
  if (hit) return hit;

  const fineEdge = remapGrid(base.fineEdge, FINE, tr);
  const coarseEdge = remapGrid(base.coarseEdge, COARSE, tr);
  const coarseFill = remapGrid(base.coarseFill, COARSE, tr);
  const variant: IconSignature = {
    fineEdge,
    coarseEdge,
    coarseFill,
    popFineEdge: base.popFineEdge,
    popFineFill: base.popFineFill,
    popCoarseEdge: base.popCoarseEdge,
    popCoarseFill: base.popCoarseFill,
    aspect: tr.swapsAspect ? 1 / base.aspect : base.aspect,
  };
  cached[tr.id] = variant;
  return variant;
}

/** Dihedral pair score: the best of the 8 orientations of `sb` against
 *  `sa`, reporting the winning transform. The density prefilter is
 *  permutation-invariant (one pass for all 8); the aspect prefilter and
 *  the two scoring stages run per orientation with early rejection. */
export function pairScoreDihedral(
  sa: IconSignature,
  sb: IconSignature
): { score: number; transform?: string } {
  /* density prefilter — identical for every orientation (same bits) */
  if (Math.min(sa.popFineEdge, sb.popFineEdge) / Math.max(sa.popFineEdge, sb.popFineEdge) < 0.6) {
    return { score: 0 };
  }

  let bestScore = 0;
  let bestLabel: string | undefined;
  for (const tr of DIHEDRAL) {
    const vb = dihedralVariant(sb, tr);
    /* aspect prefilter — rotation-aware */
    const aspectDelta = Math.abs(Math.log2(sa.aspect / vb.aspect));
    if (aspectDelta > 0.35) continue;

    const coarse = coarseScore(sa, vb);
    if (coarse < COARSE_REJECT) continue;

    const jF = softJaccard(
      softInterFine(sa.fineEdge, vb.fineEdge),
      softInterFine(vb.fineEdge, sa.fineEdge),
      sa.popFineEdge,
      vb.popFineEdge
    );
    const score = 0.5 * coarse + 0.5 * jF;
    if (score > bestScore) {
      bestScore = score;
      bestLabel = tr.label === "" ? undefined : tr.label;
    }
  }
  return { score: bestScore, transform: bestLabel };
}

/* ------------------------------------------------------------------ */
/* Scan + grouping                                                     */
/* ------------------------------------------------------------------ */

/** Find groups of visually similar icons. Pure computation over the
 *  library — returns [] when there are none (or no DOM APIs).
 *  opts.dihedral (round 14, default OFF) additionally matches rotated
 *  and mirrored copies — see the header for why it is never silent. */
export function findSimilarIcons(
  icons: Record<string, IconEntry>,
  iconOrder: string[],
  opts?: number | { threshold?: number; dihedral?: boolean }
): SimilarityGroup[] {
  /* legacy third parameter was a bare threshold number */
  const threshold =
    typeof opts === "number" ? opts : (opts?.threshold ?? SIMILARITY_THRESHOLD);
  const dihedral = typeof opts === "object" && opts.dihedral === true;
  if (iconOrder.length < 2 || typeof DOMParser === "undefined") return [];

  /* signatures + byte-hash shortcut (renamed exact copies) */
  const ids: string[] = [];
  const sigs: (IconSignature | null)[] = [];
  const hashes: string[] = [];
  for (const id of iconOrder) {
    const entry = icons[id];
    if (!entry) continue;
    ids.push(id);
    sigs.push(iconSignature(entry.svg));
    hashes.push(hashSvgContent(entry.svg));
  }

  const pairs: SimilarityPair[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const si = sigs[i];
      const sj = sigs[j];
      let score: number;
      let transform: string | undefined;
      if (hashes[i] === hashes[j]) {
        score = 1; // byte-identical source — the classic renamed copy
      } else if (si && sj) {
        if (dihedral) {
          const d = pairScoreDihedral(si, sj);
          score = d.score;
          transform = d.transform;
        } else {
          score = pairScore(si, sj);
        }
      } else {
        score = 0; // unrecognizable geometry — never guess
      }
      if (score >= threshold) {
        const pair: SimilarityPair = { a: ids[i], b: ids[j], score };
        if (transform) pair.transform = transform;
        pairs.push(pair);
      }
    }
  }

  /* union-find grouping so a triplet of copies reads as ONE finding */
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (x: string, y: string): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx === ry) return;
    if (rx < ry) parent.set(ry, rx);
    else parent.set(rx, ry);
  };
  for (const id of ids) parent.set(id, id);
  for (const p of pairs) union(p.a, p.b);

  const members = new Map<string, string[]>();
  for (const id of ids) {
    const r = find(id);
    const list = members.get(r) ?? [];
    list.push(id);
    members.set(r, list);
  }

  const groups: SimilarityGroup[] = [];
  for (const list of members.values()) {
    if (list.length < 2) continue;
    const set = new Set(list);
    const intra = pairs
      .filter((p) => set.has(p.a) && set.has(p.b))
      .sort((x, y) => y.score - x.score);
    groups.push({
      ids: list,
      pairs: intra,
      best: intra[0]?.score ?? 0,
    });
  }
  groups.sort((x, y) => y.ids.length - x.ids.length || y.best - x.best);
  return groups;
}

/* ------------------------------------------------------------------ */
/* Live group count (cached)                                           */
/* ------------------------------------------------------------------ */

/** Cache for similarityGroupCount — the membership key is the ordered id
 *  list (svg sources are immutable per id and tags never affect geometry,
 *  so membership is the ONLY thing that can change the answer). */
const groupCountCache: { key: string; count: number } = { key: "", count: 0 };

/** How many similar-icon groups the library currently holds — for live
 *  badges (the library toolbar chip). Membership-keyed cache: the O(n²)
 *  pair scan only reruns when icons are actually added or removed; tag
 *  edits and sheet changes return the cached count in O(n). */
export function similarityGroupCount(
  icons: Record<string, IconEntry>,
  iconOrder: string[]
): number {
  const ids = iconOrder.filter((id) => icons[id]);
  if (ids.length < 2) {
    groupCountCache.key = "";
    groupCountCache.count = 0;
    return 0;
  }
  const key = ids.join("\u0000");
  if (groupCountCache.key === key) return groupCountCache.count;
  const count = findSimilarIcons(icons, iconOrder).length;
  groupCountCache.key = key;
  groupCountCache.count = count;
  return count;
}
