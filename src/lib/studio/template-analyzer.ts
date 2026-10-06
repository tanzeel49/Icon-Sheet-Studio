/**
 * ICON SHEET STUDIO — Universal template analyzer (v2).
 * Parses an arbitrary icon-sheet SVG and detects the canvas, every icon slot
 * (exact x/y/width/height), row/column structure, spacing, margins, the
 * background, text elements, decorative shapes and an optional hero slot.
 * Runs in the browser (DOM measurement); the ORIGINAL SVG is never modified —
 * analysis only reads a throwaway rendered copy.
 *
 * v2 detection strategy (structure + geometry, not just rect matching):
 *  1. Parse + validate (DOMParser), canvas from width/height/viewBox. Canvas
 *     data is returned even when slot detection fails (manual fallback).
 *  2. Render a hidden copy at viewBox scale; measure EVERY visual element —
 *     shapes, groups and text — via getBoundingClientRect → viewBox units
 *     (transform-safe: nested translate/scale/rotate groups measure right).
 *     Inherited visibility/opacity, effective computed fill/stroke, ids,
 *     classes and DOM depth are captured per element.
 *  3. Classify: backgrounds (full-canvas coverage), text (never slots),
 *     noise (tiny/line shapes), slot candidates (incl. invisible guide rects
 *     as a fallback lattice — real templates use them).
 *  4. Cluster same-sized candidates (deterministic area-sorted seeding +
 *     merge pass). Score clusters by count × LATTICE FIT (members vs
 *     distinct rows×cols) × aspect fitness × structural hints (id/class
 *     vocabulary) × visibility. Absorb secondary sections with different
 *     cell sizes (mixed-capacity templates) when aligned & near the grid.
 *  5. De-duplicate stacked/contained shapes (cell drawn as fill + border +
 *     guide) preferring painted, hinted, shallower elements — every real
 *     slot is kept EXACTLY once; capacity always equals kept slots.
 *  6. Row bands via gap clustering → deterministic reading order (row, then
 *     x), grid description, median gaps, margins.
 *  7. Hero = distinct shape or composite group 1.2–10× a cell near the grid.
 *  8. Validation: internal consistency checks → warnings; composite
 *     confidence; everything travels to the import dialog so the user can
 *     confirm/adjust (toggle slots, add missed ones, mark manually) before
 *     the template is saved.
 */

import type { CustomTextRole, Rect, TextAlign } from "./types";

export interface SlotCandidate {
  rect: Rect;
  /** analyzer-include default (user can toggle in the dialog) */
  selected: boolean;
  /** true when the user placed this slot manually in the import dialog */
  manual?: boolean;
}

export interface HeroCandidate {
  rect: Rect;
  /** heuristic label, e.g. "500×500 · left of grid" */
  label: string;
  /** true when the candidate is a composite group of several shapes */
  composite?: boolean;
}

export interface TextElementInfo {
  rect: Rect;
  /** trimmed text snippet (max 40 chars) */
  snippet: string;
  /* ---- v3 additive (universal editing; optional, older callers
   * unaffected) — computed typography used for role guessing + review ---- */
  /** computed font size in viewBox units */
  fontSize?: number;
  /** analyzer's role guess for this text (reviewable in the import dialog) */
  guess?: CustomTextRole | "none";
}

export interface TemplateAnalysis {
  ok: boolean;
  /** failure reason when ok = false (canvas data still filled when known) */
  error?: string;
  width: number;
  height: number;
  viewBox: string;
  slots: SlotCandidate[];
  heroCandidates: HeroCandidate[];
  /** 0..1 */
  confidence: number;
  gridDescription: string;
  notes: string[];
  /* ---- v2 additive fields (all optional, older callers unaffected) ---- */
  /** detected background element (largest full-canvas shape), if any */
  background?: Rect | null;
  /** count of text elements found (editable text, never slots) */
  textElementCount?: number;
  /** first few text snippets for the review UI */
  textSnippets?: string[];
  /** v3: every detected text with computed size + role guess — the import
   *  dialog shows these for user-confirmed role mapping (universal editing) */
  texts?: TextElementInfo[];
  /** shapes that were measured but not classified as slots/hero/background */
  decorativeCount?: number;
  /** median horizontal / vertical gap between slots (viewBox units) */
  spacing?: { h: number; v: number } | null;
  /** grid bounding box vs canvas edges */
  margins?: { left: number; top: number; right: number; bottom: number };
  /** how many different cell-size sections contributed slots (1 = uniform) */
  sections?: number;
  /** validation issues — surfaced as notes in the dialog */
  warnings?: string[];
}

/* ------------------------------------------------------------------ */
/* Measurement                                                         */
/* ------------------------------------------------------------------ */

export interface MeasuredEl {
  rect: Rect;
  area: number;
  tag: string;
  id: string;
  cls: string;
  depth: number;
  docIndex: number;
  /** paints something visible (fill or stroke) */
  painted: boolean;
  /** visibility:hidden / opacity:0 on the element or an ancestor */
  hidden: boolean;
  /** id/class matches the slot vocabulary (cell/slot/icon/tile/frame) */
  hints: boolean;
  /** the measured element itself (v3 — lets the annotator mark the exact
   *  DOM node; analyzeTemplateSvg itself never uses it) */
  el: SVGElement;
  /* ---- v3: computed paint captured WHILE MOUNTED (viewBox units) ---- */
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

/** Computed typography snapshot of a measured text element. */
export interface TextComputedStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  letterSpacing: number;
  fill: string;
  anchor: TextAlign;
  fontStyle: "normal" | "italic";
  opacity: number;
}

/** A measured <text>/<textPath> element + its computed style. */
export interface MeasuredText {
  info: TextElementInfo;
  el: SVGTextElement;
  style: TextComputedStyle;
}

export interface RawMeasure {
  shapes: MeasuredEl[];
  groups: MeasuredEl[];
  texts: MeasuredText[];
}

const CONTAINER_ID = "iss-template-analyzer-mount";
const ANALYSIS_ERROR =
  "Template analysis could not determine the icon slots.";

/** id/class vocabulary that hints at icon slots (uniform bonus per cluster). */
const HINT_RE = /(slot|cell|icon|tile|frame|grid[-_ ]?item|box)/i;

/** structural containers whose children are never visual slots */
const STRUCTURAL_SELECTOR =
  "defs, clipPath, clippath, mask, marker, pattern, symbol, linearGradient, radialGradient, filter, style";

const SHAPE_SELECTOR =
  "rect, circle, ellipse, path, polygon, polyline, image, use";

const MAX_ELEMENTS = 8000; // hard cap for pathological exports

/** Parse a length-ish attribute ("3600", "3600px" → number|null). */
function parseLength(value: string | null): number | null {
  if (!value) return null;
  const m = value.trim().match(/^([-\d.]+)\s*(px)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** rgb()/rgba() → #rrggbb (null when the value isn't a plain rgb color). */
export function rgbToHex(value: string): string | null {
  const m = value.trim().match(
    /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/i
  );
  if (!m) return null;
  const r = Math.round(Number(m[1]));
  const g = Math.round(Number(m[2]));
  const b = Math.round(Number(m[3]));
  if ([r, g, b].some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toLowerCase()}`;
}

/** Computed typography of a mounted text element (viewBox units — the
 *  measurement host renders the SVG at exactly viewBox scale). */
function readTextStyle(el: SVGTextElement): TextComputedStyle {
  const cs = getComputedStyle(el);
  const fontSize = parseFloat(cs.fontSize) || 16;
  const rawWeight = parseInt(cs.fontWeight, 10);
  const rawLs = cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing) || 0;
  const fillHex = rgbToHex(cs.fill);
  const anchorRaw = cs.textAnchor;
  const anchor: TextAlign =
    anchorRaw === "middle" ? "middle" : anchorRaw === "end" ? "end" : "start";
  return {
    fontFamily: cs.fontFamily || "sans-serif",
    fontSize,
    fontWeight: Number.isFinite(rawWeight) ? rawWeight : 400,
    letterSpacing: Number.isFinite(rawLs) ? rawLs : 0,
    fill: fillHex ?? cs.fill,
    anchor,
    fontStyle: cs.fontStyle === "italic" || cs.fontStyle === "oblique" ? "italic" : "normal",
    opacity: parseFloat(cs.opacity) || 1,
  };
}

/** Parse an SVG string into its root element (null on parse errors).
 *  v3 export — the custom-template annotator re-uses the same document it
 *  measures so it can mark the exact elements it classified. */
export function parseSvgDocument(svgText: string): SVGElement | null {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (doc.querySelector("parsererror")) return null;
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return null;
  return root as unknown as SVGElement;
}

/** Render the SVG offscreen at viewBox scale and measure every element.
 *  v3: takes a pre-parsed root (measureDocument below keeps the old
 *  parse-and-measure signature for existing callers). The root is MOVED
 *  into the hidden measurement host (DOM adoption) and detached again
 *  before returning — callers keep ownership of the node. */
export function measureMountedSvg(
  root: SVGElement,
  vb: [number, number, number, number]
): RawMeasure | null {
  /* mount hidden (visibility:hidden keeps layout so measurement works) */
  let host = document.getElementById(CONTAINER_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = CONTAINER_ID;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;overflow:hidden;";
    document.body.appendChild(host);
  }
  host.replaceChildren();
  /* explicit pixel size = viewBox units so rects map 1:1 into viewBox space */
  root.setAttribute("width", String(vb[2]));
  root.setAttribute("height", String(vb[3]));
  /* inline style wins over attributes in some exports — pin both */
  root.style.width = `${vb[2]}px`;
  root.style.height = `${vb[3]}px`;
  host.appendChild(root);

  const svgRect = root.getBoundingClientRect();
  if (svgRect.width < 2 || svgRect.height < 2) {
    host.replaceChildren();
    return null;
  }
  const scaleX = vb[2] / svgRect.width;
  const scaleY = vb[3] / svgRect.height;

  const shapes: MeasuredEl[] = [];
  const groups: MeasuredEl[] = [];
  const texts: MeasuredText[] = [];

  const all = root.querySelectorAll<SVGElement>(
    `${SHAPE_SELECTOR}, text, textPath, g`
  );
  let docIndex = 0;
  for (const el of all) {
    if (docIndex++ > MAX_ELEMENTS) break;
    if (el.closest(STRUCTURAL_SELECTOR)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;

    const tag = el.tagName.toLowerCase();
    const depth = ancestorDepth(el, root);

    if (tag === "text" || tag === "textpath") {
      const info: TextElementInfo = {
        rect: {
          x: vb[0] + (r.left - svgRect.left) * scaleX,
          y: vb[1] + (r.top - svgRect.top) * scaleY,
          width: r.width * scaleX,
          height: r.height * scaleY,
        },
        snippet: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40),
      };
      texts.push({ info, el: el as SVGTextElement, style: readTextStyle(el as SVGTextElement) });
      continue;
    }

    /* NOTE: visibility/opacity are read from DECLARED values only, inside
     * the SVG tree — getComputedStyle would inherit the measurement host's
     * own visibility:hidden and mark everything hidden. Computed PAINT
     * (fill/stroke/opacity) is captured here, while mounted, for the
     * annotator's style snapshots. */
    const cs = getComputedStyle(el);
    const entry: MeasuredEl = {
      rect: {
        x: vb[0] + (r.left - svgRect.left) * scaleX,
        y: vb[1] + (r.top - svgRect.top) * scaleY,
        width: r.width * scaleX,
        height: r.height * scaleY,
      },
      area: 0,
      tag,
      id: el.getAttribute("id") ?? "",
      cls: el.getAttribute("class") ?? "",
      depth,
      docIndex,
      painted: isPaintedStyle(cs),
      hidden: isHidden(el, root),
      hints: false,
      el,
      fill: cs.fill,
      stroke: cs.stroke,
      strokeWidth: parseFloat(cs.strokeWidth) || 0,
      opacity: parseFloat(cs.opacity) || 1,
    };
    entry.area = entry.rect.width * entry.rect.height;
    entry.hints = HINT_RE.test(`${entry.id} ${entry.cls}`);

    if (tag === "g") groups.push(entry);
    else shapes.push(entry);
  }

  host.replaceChildren();
  return { shapes, groups, texts };
}

/** Parse + measure in one call (legacy signature used by the analyzer). */
function measureDocument(
  svgText: string,
  vb: [number, number, number, number]
): RawMeasure | null {
  const root = parseSvgDocument(svgText);
  if (!root) return null;
  return measureMountedSvg(root, vb);
}

/* ------------------------------------------------------------------ */
/* Text role guessing (v3 — universal editing)                        */
/* ------------------------------------------------------------------ */

const VOL_TEXT_RE = /\bvol\.?\s*\d|\bvolume\b|^v\s?\.?\s?\d/i;
const CATEGORY_TEXT_RE = /(icons?|icon collection|collection|category|edition|series|pack|sheet|set\b)/i;

/** Guess an editing role for every detected text element:
 *  · volume — content looks like a volume stamp ("VOL. 05", "Volume 3");
 *  · category — title-like vocabulary, else the largest remaining font;
 *  · caption — the longest remaining snippet (only when caption-sized);
 *  · everything else stays "none" (cell numbers, labels, decorations).
 *
 *  v3.1 category ranking (analyzer-only; official templates never pass
 *  through here): a TITLE is almost always the typographic dominant of
 *  its region, so vocabulary matches are ranked by size AND guarded by
 *  dominance — a small "…series"-style caption (e.g. 36 px) can never
 *  steal the category role from a text 2×+ its size (e.g. a 150 px
 *  title with no vocabulary words). Multi-match templates (title
 *  "Icon Collection" + footer "50 ICONS") resolve to the LARGEST match
 *  instead of the first in DOM order. */
export function guessTextRoles(
  texts: Array<{ snippet: string; fontSize?: number }>
): Array<CustomTextRole | "none"> {
  const roles: Array<CustomTextRole | "none"> = texts.map(() => "none");
  const usable = texts.map((t, i) => i).filter((i) => texts[i].snippet.length > 0);
  if (usable.length === 0) return roles;

  let volIdx = -1;
  for (const i of usable) {
    if (VOL_TEXT_RE.test(texts[i].snippet)) {
      volIdx = i;
      break;
    }
  }
  const rest = usable.filter((i) => i !== volIdx);

  const sizeOf = (i: number) => texts[i].fontSize ?? 0;
  const largest = rest.reduce((a, b) => (sizeOf(a) >= sizeOf(b) ? a : b), rest[0] ?? -1);
  const matches = rest.filter((i) => CATEGORY_TEXT_RE.test(texts[i].snippet));

  let catIdx = -1;
  if (rest.length > 0) {
    if (matches.length === 0) {
      /* historical fallback: no vocabulary evidence → largest font */
      catIdx = largest;
    } else {
      /* strongest vocabulary match = the largest matching text … */
      const bestMatch = matches.reduce((a, b) => (sizeOf(a) >= sizeOf(b) ? a : b));
      /* … but dominance wins: a match less than half the size of the
       * largest remaining text is caption/footer vocabulary, not a title */
      catIdx = sizeOf(bestMatch) * 2 <= sizeOf(largest) ? largest : bestMatch;
    }
  }

  const last = rest.filter((i) => i !== catIdx);
  let capIdx = -1;
  if (last.length > 0) {
    const cand = last.reduce((a, b) =>
      texts[a].snippet.length >= texts[b].snippet.length ? a : b
    );
    /* only map a caption when the snippet is genuinely caption-like —
     * short labels/cell numbers stay unmapped */
    if (texts[cand].snippet.length >= 12) capIdx = cand;
  }

  if (volIdx >= 0) roles[volIdx] = "volume";
  if (catIdx >= 0) roles[catIdx] = "category";
  if (capIdx >= 0) roles[capIdx] = "caption";
  return roles;
}

function ancestorDepth(el: Element, root: Element): number {
  let d = 0;
  let node: Element | null = el;
  while (node && node !== root) {
    node = node.parentElement;
    d++;
  }
  return d;
}

/** Element (or an ancestor INSIDE the SVG tree) hidden via declared
 *  visibility/opacity? Computed styles are deliberately NOT used — they
 *  would inherit the hidden measurement host. display:none yields a zero
 *  bbox and never reaches this check. */
function isHidden(el: Element, root: Element): boolean {
  let node: Element | null = el;
  while (node && node !== root) {
    const vis = node.getAttribute("visibility");
    if (vis === "hidden" || vis === "collapse") return true;
    const op = node.getAttribute("opacity");
    if (op !== null && Number(op) === 0) return true;
    const style = node.getAttribute("style") ?? "";
    if (/visibility\s*:\s*(hidden|collapse)\b/i.test(style)) return true;
    if (/(^|;)\s*opacity\s*:\s*0(?:\.0+)?\s*(;|$)/i.test(style)) return true;
    node = node.parentElement;
  }
  return false;
}

/** Does the element actually paint (fill or stroke) at its computed style? */
function isPaintedStyle(cs: CSSStyleDeclaration): boolean {
  const fillOpacity = Number(cs.fillOpacity);
  const strokeOpacity = Number(cs.strokeOpacity);
  const strokeWidth = parseFloat(cs.strokeWidth || "0") || 0;
  const fillPainted = cs.fill !== "none" && (Number.isNaN(fillOpacity) || fillOpacity > 0);
  const strokePainted =
    cs.stroke !== "none" && (Number.isNaN(strokeOpacity) || strokeOpacity > 0) && strokeWidth > 0;
  return fillPainted || strokePainted;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

function rectArea(r: Rect): number {
  return r.width * r.height;
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function overlapRatio(a: Rect, b: Rect): number {
  const small = Math.min(rectArea(a), rectArea(b));
  if (small <= 0) return 0;
  return overlapArea(a, b) / small;
}

/** Canvas-space coverage of a shape (0..1 per axis). */
function canvasCoverage(r: Rect, vb: [number, number, number, number]): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(r.x + r.width, vb[0] + vb[2]) - Math.max(r.x, vb[0])) / vb[2],
    y: Math.max(0, Math.min(r.y + r.height, vb[1] + vb[3]) - Math.max(r.y, vb[1])) / vb[3],
  };
}

/** Median of a numeric array (0 for empty). */
function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median cell dimensions of a member list. */
function medianDims(members: MeasuredEl[]): { w: number; h: number } {
  return {
    w: median(members.map((m) => m.rect.width)),
    h: median(members.map((m) => m.rect.height)),
  };
}

function withinTol(rep: { w: number; h: number }, r: Rect, tol: number): boolean {
  return (
    Math.abs(rep.w - r.width) <= Math.max(r.width, rep.w) * tol &&
    Math.abs(rep.h - r.height) <= Math.max(r.height, rep.h) * tol
  );
}

/* ------------------------------------------------------------------ */
/* Cluster scoring                                                     */
/* ------------------------------------------------------------------ */

/**
 * Lattice fit: the fraction of members that sit on the cluster's own
 * row/column lattice. A perfect n=r×c grid scores 1.0 (n members, r rows,
 * c columns); scattered shapes inflate rows×cols far beyond n and score low.
 */
function alignmentScore(members: MeasuredEl[]): number {
  if (members.length < 2) return 0;
  const med = medianDims(members);
  const rowTol = Math.max(med.h * 0.6, 4);
  const colTol = Math.max(med.w * 0.6, 4);
  const rows: number[] = [];
  const cols: number[] = [];
  for (const m of members) {
    const cy = m.rect.y + m.rect.height / 2;
    const cx = m.rect.x + m.rect.width / 2;
    if (!rows.some((r) => Math.abs(r - cy) < rowTol)) rows.push(cy);
    if (!cols.some((c) => Math.abs(c - cx) < colTol)) cols.push(cx);
  }
  if (rows.length * cols.length < 1) return 0;
  return Math.min(1, members.length / (rows.length * cols.length));
}

/** Structural quality of a candidate slot cluster (higher = more slot-like). */
function scoreCluster(members: MeasuredEl[]): number {
  const n = members.length;
  const align = alignmentScore(members);
  const med = medianDims(members);
  const aspect = med.h > 0 ? med.w / med.h : 1;
  /* square-ish cells are the icon-sheet norm; ribbons/pills get penalized */
  const aspectFit = Math.max(0.2, 1 - Math.abs(Math.log2(Math.max(aspect, 0.01))) / 2.2);
  const hintShare = members.filter((m) => m.hints).length / n;
  const paintShare = members.filter((m) => m.painted && !m.hidden).length / n;
  return (
    n *
    (0.3 + 0.5 * align + 0.2 * aspectFit) *
    (1 + 0.12 * hintShare) *
    (0.8 + 0.2 * paintShare)
  );
}

/* ------------------------------------------------------------------ */
/* Reading order + grid structure                                      */
/* ------------------------------------------------------------------ */

interface Band {
  meanY: number;
  slots: MeasuredEl[];
}

/** Group slots into row bands (gap clustering), deterministic. */
function rowBands(slots: MeasuredEl[]): Band[] {
  if (!slots.length) return [];
  const medH = Math.max(median(slots.map((s) => s.rect.height)), 1);
  const bandGap = Math.max(medH * 0.55, 6);
  const sorted = [...slots].sort((a, b) => a.rect.y - b.rect.y);
  const bands: MeasuredEl[][] = [];
  let prevY = Number.NaN;
  for (const s of sorted) {
    if (Number.isNaN(prevY) || s.rect.y - prevY >= bandGap) bands.push([s]);
    else bands[bands.length - 1].push(s);
    prevY = s.rect.y;
  }
  return bands.map((members) => ({
    meanY: median(members.map((m) => m.rect.y)),
    slots: members,
  }));
}

/** Deterministic visual reading order: row band, then x, then y. */
function sortReadingOrder(slots: MeasuredEl[]): MeasuredEl[] {
  const bands = rowBands(slots);
  const bandOf = new Map<MeasuredEl, number>();
  bands.forEach((b, i) => b.slots.forEach((s) => bandOf.set(s, i)));
  return [...slots].sort((a, b) => {
    const ba = bandOf.get(a) ?? 0;
    const bb = bandOf.get(b) ?? 0;
    if (ba !== bb) return ba - bb;
    if (Math.abs(a.rect.x - b.rect.x) > 2) return a.rect.x - b.rect.x;
    return a.rect.y - b.rect.y;
  });
}

function describeGrid(bands: Band[], total: number): string {
  return describeFromCounts(bands.map((b) => b.slots.length), total);
}

function describeFromCounts(counts: number[], total: number): string {
  if (total === 0) return "no slots";
  if (counts.length === 1) return `${total}-slot row`;
  const regular = counts.every((c) => c === counts[0]) && counts[0] >= 2;
  if (regular) return `${counts[0]} × ${counts.length} grid`;
  return `irregular layout · ${counts.join("/")}`;
}

/** Row-band counts of an arbitrary slot rect list (gap clustering). */
function slotRowCounts(rects: Rect[]): number[] {
  if (!rects.length) return [];
  const medH = Math.max(median(rects.map((r) => r.height)), 1);
  const bandGap = Math.max(medH * 0.55, 6);
  const sorted = [...rects].sort((a, b) => a.y - b.y);
  const bands: number[] = [];
  let prevY = Number.NaN;
  let band = 0;
  for (const r of sorted) {
    if (Number.isNaN(prevY) || r.y - prevY >= bandGap) {
      bands.push(1);
      band = bands.length - 1;
    } else {
      bands[band]++;
    }
    prevY = r.y;
  }
  return bands;
}

/** Describe an arbitrary slot rect list ("8 × 9 grid" | "irregular layout · …"
 *  | "12-slot row"). Used by the import dialog to keep the saved metadata
 *  consistent with the user's final slot selection. */
export function describeSlotRects(rects: Rect[]): string {
  return describeFromCounts(slotRowCounts(rects), rects.length);
}

/* ------------------------------------------------------------------ */
/* The analyzer                                                        */
/* ------------------------------------------------------------------ */

export function analyzeTemplateSvg(svgText: string): TemplateAnalysis {
  const fail = (error: string, width = 0, height = 0, viewBox = ""): TemplateAnalysis => ({
    ok: false,
    error,
    width,
    height,
    viewBox,
    slots: [],
    heroCandidates: [],
    confidence: 0,
    gridDescription: "",
    notes: [],
    warnings: [],
  });

  if (!svgText || !/<svg[\s>]/i.test(svgText) || /<script\b/i.test(svgText)) {
    return fail(ANALYSIS_ERROR);
  }

  /* -- canvas ------------------------------------------------------ */
  const openTag = svgText.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const vbMatch = openTag.match(
    /viewBox\s*=\s*["']\s*([-\d.]+)[ ,]+([-\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)\s*["']/i
  );
  const wAttr = parseLength(openTag.match(/width\s*=\s*["']([^"']+)["']/i)?.[1] ?? null);
  const hAttr = parseLength(openTag.match(/height\s*=\s*["']([^"']+)["']/i)?.[1] ?? null);
  let vb: [number, number, number, number] | null = null;
  if (vbMatch) {
    vb = [Number(vbMatch[1]), Number(vbMatch[2]), Number(vbMatch[3]), Number(vbMatch[4])];
  } else if (wAttr && hAttr) {
    vb = [0, 0, wAttr, hAttr];
  }
  if (!vb || vb[2] < 100 || vb[3] < 100) {
    return fail("Template has no usable canvas dimensions (viewBox or width/height).");
  }
  const [vbX, vbY, W, H] = vb;
  const viewBoxStr = `${vbX} ${vbY} ${W} ${H}`;
  const canvasArea = W * H;

  /* -- measure (structure + geometry) ------------------------------- */
  const raw = measureDocument(svgText, vb);
  if (!raw || raw.shapes.length === 0) {
    return fail(ANALYSIS_ERROR, W, H, viewBoxStr);
  }
  const { shapes, groups, texts } = raw;
  /* plain text infos + the analyzer's role guesses for the review UI */
  const textInfos: TextElementInfo[] = texts.map((t) => ({
    ...t.info,
    fontSize: Math.round(t.style.fontSize * 10) / 10,
  }));
  const textGuesses = guessTextRoles(textInfos);
  textInfos.forEach((t, i) => {
    t.guess = textGuesses[i];
  });

  /* -- background classification ------------------------------------- */
  const backgrounds: MeasuredEl[] = shapes.filter((s) => {
    const cov = canvasCoverage(s.rect, vb);
    return (cov.x >= 0.85 && cov.y >= 0.85) || s.area >= canvasArea * 0.6;
  });
  const background: MeasuredEl | null =
    backgrounds.length > 0
      ? [...backgrounds].sort((a, b) => b.area - a.area)[0]
      : null;

  /* -- noise filter --------------------------------------------------- */
  const candidates = shapes.filter((s) => {
    if (backgrounds.includes(s)) return false;
    if (s.area < canvasArea * 0.001) return false; // letters, dots, small decor
    if (s.area > canvasArea * 0.5) return false; // washes / huge plates
    const aspect = s.rect.width / s.rect.height;
    if (aspect < 0.25 || aspect > 4) return false; // ribbons, lines, bars
    return true;
  });

  /* -- size clustering (deterministic: area desc, doc order) ---------- */
  const SIZE_TOL = 0.12;
  const ordered = [...candidates].sort(
    (a, b) => b.area - a.area || a.docIndex - b.docIndex
  );
  const clusters: MeasuredEl[][] = [];
  for (const c of ordered) {
    let target: MeasuredEl[] | null = null;
    for (const cl of clusters) {
      if (withinTol(medianDims(cl), c.rect, SIZE_TOL)) {
        target = cl;
        break;
      }
    }
    if (target) target.push(c);
    else clusters.push([c]);
  }
  /* merge pass: clusters whose medians drifted within tolerance */
  for (let i = 0; i < clusters.length; i++) {
    for (let j = clusters.length - 1; j > i; j--) {
      const a = medianDims(clusters[i]);
      const b = medianDims(clusters[j]);
      const tolW = Math.max(a.w, b.w) * SIZE_TOL;
      const tolH = Math.max(a.h, b.h) * SIZE_TOL;
      if (Math.abs(a.w - b.w) <= tolW && Math.abs(a.h - b.h) <= tolH) {
        clusters[i].push(...clusters[j]);
        clusters.splice(j, 1);
      }
    }
  }

  const scored = clusters
    .map((members) => ({ members, score: scoreCluster(members) }))
    .sort((a, b) => b.score - a.score || a.members.length - b.members.length);

  const eligible = scored.filter((c) => c.members.length >= 3);
  if (eligible.length === 0) {
    return fail(
      `${ANALYSIS_ERROR} Only ${candidates.length} usable shape${candidates.length === 1 ? "" : "s"} were found — an icon sheet needs at least 3 similar cells. You can mark the slots manually instead.`,
      W,
      H,
      viewBoxStr
    );
  }

  /* -- primary grid + secondary section absorption -------------------- */
  const primary = eligible[0];
  const primaryMed = medianDims(primary.members);
  const primaryCellArea = primaryMed.w * primaryMed.h;
  const primaryBounds = boundsOf(primary.members);
  const marginX = primaryMed.w * 2;
  const marginY = primaryMed.h * 2;
  const expanded: Rect = {
    x: primaryBounds.x - marginX,
    y: primaryBounds.y - marginY,
    width: primaryBounds.width + marginX * 2,
    height: primaryBounds.height + marginY * 2,
  };

  const sections: MeasuredEl[][] = [primary.members];
  for (const cand of eligible.slice(1)) {
    const med = medianDims(cand.members);
    const ratio = (med.w * med.h) / Math.max(primaryCellArea, 1);
    if (ratio < 0.35 || ratio > 2.8) continue;
    if (alignmentScore(cand.members) < 0.5) continue;
    const cMed = med;
    const aspect = cMed.h > 0 ? cMed.w / cMed.h : 1;
    if (aspect < 0.4 || aspect > 2.5) continue;
    /* must not sit on top of primary cells */
    const clashes = cand.members.some((m) =>
      primary.members.some((p) => overlapRatio(m.rect, p.rect) > 0.5)
    );
    if (clashes) continue;
    /* must live near the primary grid (same visual sheet region) */
    const cBounds = boundsOf(cand.members);
    const near =
      cBounds.x < expanded.x + expanded.width &&
      cBounds.x + cBounds.width > expanded.x &&
      cBounds.y < expanded.y + expanded.height &&
      cBounds.y + cBounds.height > expanded.y;
    if (!near) continue;
    sections.push(cand.members);
  }

  const members = sections.flatMap((s) => s);

  /* -- de-duplicate stacked / contained shapes ------------------------ *
   * A cell is often drawn as several stacked shapes (fill + border + guide
   * rect). Preference: painted > hinted > shallower > earlier in document. */
  const pref = (m: MeasuredEl): number =>
    (m.painted && !m.hidden ? 8 : 0) + (m.hints ? 4 : 0) - m.depth * 0.1;
  const dedupOrder = [...members].sort(
    (a, b) => pref(b) - pref(a) || a.docIndex - b.docIndex
  );
  const kept: MeasuredEl[] = [];
  for (const m of dedupOrder) {
    const dup = kept.some((k) => overlapRatio(k.rect, m.rect) >= 0.55);
    if (!dup) kept.push(m);
  }
  if (kept.length === 0) {
    return fail(ANALYSIS_ERROR, W, H, viewBoxStr);
  }

  /* -- deterministic reading order ------------------------------------ */
  const sortedSlots = sortReadingOrder(kept);
  const bands = rowBands(sortedSlots);
  const gridDescription = describeGrid(bands, sortedSlots.length);

  /* -- spacing + margins ---------------------------------------------- */
  const gapDiffs: number[] = [];
  for (const b of bands) {
    const xs = b.slots.map((s) => s.rect.x).sort((p, q) => p - q);
    for (let i = 1; i < xs.length; i++) gapDiffs.push(xs[i] - xs[i - 1]);
  }
  const medH = median(sortedSlots.map((s) => s.rect.height));
  const medW = median(sortedSlots.map((s) => s.rect.width));
  const gapH = gapDiffs.length ? Math.max(0, median(gapDiffs) - medW) : 0;
  const gapV =
    bands.length > 1
      ? Math.max(
          0,
          median(bands.slice(1).map((b, i) => b.meanY - bands[i].meanY)) - medH
        )
      : 0;
  const spacing: { h: number; v: number } | null =
    gapH > 0 || gapV > 0
      ? { h: Math.round(gapH * 10) / 10, v: Math.round(gapV * 10) / 10 }
      : null;

  const gridBounds = boundsOf(sortedSlots);
  const margins = {
    left: Math.round(gridBounds.x - vbX),
    top: Math.round(gridBounds.y - vbY),
    right: Math.round(vbX + W - (gridBounds.x + gridBounds.width)),
    bottom: Math.round(vbY + H - (gridBounds.y + gridBounds.height)),
  };

  /* -- hero candidates ------------------------------------------------- */
  const usedSet = new Set<MeasuredEl>(members);
  const heroPool: { rect: Rect; composite: boolean; sort: number }[] = [];
  const heroMin = primaryCellArea * 1.2;
  const heroMax = primaryCellArea * 10;
  const heroTest = (rect: Rect, composite: boolean): boolean => {
    const area = rectArea(rect);
    if (area < heroMin || area > heroMax) return false;
    const aspect = rect.height > 0 ? rect.width / rect.height : 1;
    if (aspect < 0.5 || aspect > 2) return false;
    /* must not sit on top of detected cells */
    return !sortedSlots.some((s) => overlapRatio(rect, s.rect) >= 0.45);
  };
  for (const c of candidates) {
    if (usedSet.has(c)) continue;
    if (heroTest(c.rect, false)) {
      heroPool.push({ rect: c.rect, composite: false, sort: c.area });
    }
  }
  for (const g of groups) {
    if (g.area < canvasArea * 0.0015 || g.area > canvasArea * 0.5) continue;
    if (heroTest(g.rect, true)) {
      heroPool.push({ rect: g.rect, composite: true, sort: 1e9 + g.area });
    }
  }
  /* mutual dedup (a group and its child shape describe the same hero) */
  heroPool.sort((a, b) => b.sort - a.sort);
  const heroRects: { rect: Rect; composite: boolean }[] = [];
  for (const h of heroPool) {
    const dup = heroRects.some((k) => overlapRatio(k.rect, h.rect) >= 0.6);
    if (!dup) heroRects.push({ rect: h.rect, composite: h.composite });
  }
  const positionLabel = (r: Rect): string => {
    if (r.x + r.width < gridBounds.x) return "left of grid";
    if (r.y + r.height < gridBounds.y) return "above grid";
    if (r.x > gridBounds.x + gridBounds.width) return "right of grid";
    if (r.y > gridBounds.y + gridBounds.height) return "below grid";
    return "near grid";
  };
  const heroCandidates: HeroCandidate[] = heroRects.slice(0, 4).map((h) => ({
    rect: h.rect,
    composite: h.composite,
    label: `${Math.round(h.rect.width)}×${Math.round(h.rect.height)} · ${positionLabel(h.rect)}${h.composite ? " · group" : ""}`,
  }));

  /* -- validation (internal consistency) ------------------------------- */
  const warnings: string[] = [];
  const notes: string[] = [];

  let overlapWarned = false;
  for (let i = 0; i < sortedSlots.length && !overlapWarned; i++) {
    for (let j = i + 1; j < sortedSlots.length; j++) {
      if (overlapRatio(sortedSlots[i].rect, sortedSlots[j].rect) >= 0.4) {
        warnings.push("Two detected slots overlap — verify their outlines.");
        overlapWarned = true;
        break;
      }
    }
  }
  for (const s of sortedSlots) {
    if (
      s.rect.x < vbX - 1 ||
      s.rect.y < vbY - 1 ||
      s.rect.x + s.rect.width > vbX + W + 1 ||
      s.rect.y + s.rect.height > vbY + H + 1
    ) {
      warnings.push("A detected slot extends beyond the canvas — verify it.");
      break;
    }
  }
  /* competing unused cluster (possible missed slots) */
  const competing = scored.find(
    (c) =>
      !sections.includes(c.members) &&
      c.members.length >= 5 &&
      alignmentScore(c.members) >= 0.5 &&
      !c.members.some((m) => usedSet.has(m))
  );
  if (competing) {
    warnings.push(
      `${competing.members.length} other same-size shapes were left out — verify they are not icon slots.`
    );
  }
  const invisibleShare =
    sortedSlots.filter((s) => !s.painted || s.hidden).length / sortedSlots.length;
  if (invisibleShare >= 0.5) {
    warnings.push(
      "Most detected slots are invisible guide shapes — icons will float over the artwork there."
    );
  }
  if (sortedSlots.length < 6) {
    warnings.push(
      `Only ${sortedSlots.length} slots were detected — a small capacity; verify.`
    );
  }
  if (sections.length > 1) {
    warnings.push(
      `${sections.length} slot sections with different cell sizes were detected — verify the numbering.`
    );
  }

  /* -- confidence ------------------------------------------------------ */
  const primaryAlign = alignmentScore(primary.members);
  const hintShare =
    primary.members.filter((m) => m.hints).length / primary.members.length;
  let confidence = 0.4;
  if (primaryAlign >= 0.85 && sortedSlots.length >= 8) confidence = 0.9;
  else if (primaryAlign >= 0.6 && sortedSlots.length >= 5) confidence = 0.78;
  else if (primaryAlign >= 0.4) confidence = 0.6;
  if (hintShare > 0.5) confidence += 0.04;
  confidence -= Math.min(0.24, warnings.length * 0.08);
  if (sections.length > 1) confidence -= 0.08;
  confidence = Math.max(0.25, Math.min(0.95, confidence));

  if (confidence < 0.75) {
    notes.push(
      "Detection confidence is low — verify the highlighted slots before saving (click a slot to exclude or re-include it)."
    );
  }
  if (heroCandidates.length > 1) {
    notes.push("More than one possible hero slot was found — pick the right one (or none) below.");
  }
  for (const w of warnings) notes.push(w);

  const decorativeCount = Math.max(
    0,
    shapes.length - sortedSlots.length - backgrounds.length - heroRects.length
  );

  return {
    ok: true,
    width: W,
    height: H,
    viewBox: viewBoxStr,
    slots: sortedSlots.map((s) => ({ rect: s.rect, selected: true })),
    heroCandidates,
    confidence: Math.round(confidence * 100) / 100,
    gridDescription,
    notes,
    background: background ? background.rect : null,
    textElementCount: texts.length,
    textSnippets: texts.slice(0, 4).map((t) => t.info.snippet).filter(Boolean),
    /* v3: full text list with computed sizes + role guesses (the import
     * dialog lets the user review/adjust the mapping before saving) */
    texts: textInfos,
    decorativeCount,
    spacing,
    margins,
    sections: sections.length,
    warnings,
  };
}

function boundsOf(members: MeasuredEl[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const m of members) {
    minX = Math.min(minX, m.rect.x);
    minY = Math.min(minY, m.rect.y);
    maxX = Math.max(maxX, m.rect.x + m.rect.width);
    maxY = Math.max(maxY, m.rect.y + m.rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
