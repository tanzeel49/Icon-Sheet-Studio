/**
 * ICON SHEET STUDIO — Icon artwork styling engine (DOM-based).
 *
 * Renders-time transforms applied to COPIES of icon SVG fragments. The
 * original source SVG stored in the library is NEVER modified (the renderer
 * always re-renders from the pristine cached parse — adjustments can never
 * accumulate; every render derives the output from the ORIGINAL geometry).
 *
 * Why DOM instead of regex: real-world icon SVGs declare strokes/fills in
 * many places a blind string replace cannot see —
 *   · presentation attributes on nested elements  (path stroke-width="1.5")
 *   · inline style declarations                    (style="stroke-width:2")
 *   · internal <style> CSS rules                   (.cls-1 { stroke-width:2 })
 *   · inheritance from groups / the root <svg> tag (<g stroke="#000">)
 * This module parses the fragment into a real DOM tree, resolves the SVG
 * cascade (inline style > CSS rules > presentation attributes > inherited),
 * and rewrites stroke-width / fill / stroke through INLINE STYLES — which
 * beat both presentation attributes and internal CSS rules in the cascade,
 * so the adjustment always wins visually.
 *
 * Supported leaf elements: path, line, polyline, polygon, circle, rect,
 * ellipse, use, text, tspan. Groups (incl. nested groups) and transforms are
 * handled by the walk itself (stroke-width is interpreted in each element's
 * local coordinate system, so multiplying the local value scales the
 * rendered line exactly like the source author's intent).
 *
 * STROKED artwork — BIDIRECTIONAL: every active stroke (attribute, inline
 * style, CSS rule, group/root inheritance, currentColor) is multiplied by
 * the weight factor — factors BELOW 1 thin, ABOVE 1 thicken; 1 = untouched.
 * Each element's own native width is the baseline, so icons with different
 * original stroke widths all scale proportionally (2× on a 2-unit line and
 * on a 1-unit line alike). A stroke-width of 0 is author-disabled and never
 * "revived".
 *
 * FILL-BASED outline artwork (lines drawn as filled closed paths — very
 * common in real icon packs) — STRICTLY NON-DESTRUCTIVE, BIDIRECTIONAL,
 * and ILLUSTRATOR-SEMANTIC: a fill-based mark IS an outlined stroke, so
 * weight adjustment behaves exactly like Adobe Illustrator's stroke
 * weight on a stroked path — every mark keeps its own centerline and gets
 * symmetrically thinner / fatter, always ONE SINGLE LINE (never hollowed
 * into a double outline). The element's native outline thickness is
 * MEASURED from its own geometry (path-geometry.ts: polygon union +
 * T̂ = 2·A/P — exact for bars and rings; measurement only, the output
 * never contains generated geometry), then
 *   · factor > 1 → DILATION: the element's own fill paint is re-used as
 *     a stroke with round joins/caps and paint-order:stroke on the
 *     ORIGINAL, UNTOUCHED geometry (a true vector dilation stroke, per
 *     part width (factor−1)·W) — `d` and every shape attribute remain
 *     byte-identical to the source, and a plain fill+stroke path
 *     survives Illustrator's SVG import verbatim. Bands AND solids
 *     dilate alike (a solid's silhouette IS its stroke's width — growing
 *     it around its own contour is exactly what Illustrator does when a
 *     stroked path's weight increases).
 *   · factor < 1 → EROSION (the vector-safe thinning construction — what
 *     Illustrator does when a stroke's weight is reduced): ONE mask per
 *     thinned leaf paints white everywhere and subtracts a black stroke
 *     of width (1−factor)·W along each part's own contours (verbatim
 *     subpath substrings of the source `d` — never rebuilt), eroding
 *     every edge inward by (1−factor)·W/2 so every mark — band OR solid
 *     — keeps its midline and lands its visible width exactly on
 *     factor·W as ONE single thinner line (capsule bars stay single
 *     capsules, dots stay single dots, silhouettes shrink gracefully;
 *     continuous at every factor, never a hollow jump). The leaf element
 *     itself keeps `d`, fill, fill-rule and fill-opacity VERBATIM; it
 *     only gains a mask="url(#istN)" reference. Works on any background
 *     (only black/white mask luminance is used — no knockout, no
 *     background dependency). Leaves whose subpath structure cannot be
 *     analyzed safely (no measurable band or solid, or an existing mask
 *     attribute that must not be overwritten) honestly keep their
 *     native weight and are REPORTED limited.
 *   · factor = 1 → untouched.
 * VECTOR INTEGRITY > VISUAL SHORTCUT: this engine NEVER generates,
 * offsets, flattens, resamples or rebuilds path data (the only `d`
 * strings it ever emits are verbatim substrings of the source); the
 * only structural additions are ONE mask per thinned leaf (the erosion
 * mechanism itself — SVG's only subtractive primitive) and per-part
 * fill+stroke paths on multi-part thickened leaves. Curves stay
 * curves, compound paths stay compound paths, anchor counts never
 * change. Elements inside clipPath / mask / filter / marker / pattern /
 * gradients are never touched (they are geometry, not paint).
 *
 * Browser-only (DOMParser / XMLSerializer); every entry point falls back to
 * the legacy regex transformers when the DOM APIs are unavailable or a
 * fragment fails to parse — an icon can never be destroyed by styling.
 */

import { applyTint, hashSvgContent, parseIcon } from "./svg";
import { elementPolys, measureElementOutline, spanStandaloneSrc } from "./path-geometry";
import type { ElementOutlineReport, SubpathSpan } from "./path-geometry";
import type { SheetDesign } from "./types";
import {
  effectiveStrokeWeightPx,
  effectiveUniformStroke,
  effectiveUniformTargetPx,
  strokeWeightFactor,
  STROKE_WEIGHT_FACTOR_MAX,
  STROKE_WEIGHT_FACTOR_MIN,
} from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/* ------------------------------------------------------------------ */
/* Public target                                                       */
/* ------------------------------------------------------------------ */

/* The adjustment engine takes ONE scalar: a multiplicative weight FACTOR
 * (1 = native). It serves BOTH user controls — MUTUALLY EXCLUSIVE, exactly
 * one is active per rendering: the plain "Icon stroke weight" px delta
 * (uniform OFF: per icon factor = clamp(1 + delta / nativeVisual, 0.25, 4),
 * computed from THIS icon's measured native width and THIS embed's scale)
 * and the optional "Uniform stroke" absolute target (uniform ON: per icon
 * factor = target / nativeVisual — the target is what the stroke should
 * BECOME, never an amount to add; the stored weight delta is preserved but
 * ignored while uniform is active). Because the factor multiplies each
 * element's own effective width (and fill-based artwork against its own
 * measured thickness), every icon receives its OWN appropriate adjustment
 * — never one blind value applied to all. Legacy-support factor
 * derivations (dormant % records) flow through this SAME engine. ONE
 * engine = one source of truth for stroke adjustment (no competing
 * normalization implementations). */

/* ------------------------------------------------------------------ */
/* Fill-based outline artwork (non-destructive appearance only)        */
/* ------------------------------------------------------------------ */

/** Real-world icon packs often ship "outline" icons whose visible lines
 *  are FILLED closed paths with no stroke declarations at all (stroke
 *  multiplication alone would be a no-op on them). For such artwork the
 *  engine measures the element's own native outline thickness (pure
 *  measurement — path-geometry.ts polygon union + T̂ = 2·A/P, exact for
 *  bars and rings) and applies a STRICTLY NON-DESTRUCTIVE adjustment in
 *  BOTH directions with ILLUSTRATOR stroke-weight semantics (a fill-based
 *  mark IS an outlined stroke — thinner/heavier means ONE single line at
 *  factor·T̂, never a hollowed double outline):
 *   · factor > 1 → a TRUE SVG STROKE on the original, untouched geometry
 *     (fill paint mirrored, round joins/caps, paint-order:stroke so the
 *     fill stays on top) — genuinely thicker lines with byte-identical
 *     path data (`d`, and every shape attribute, never change). A plain
 *     fill+stroke path is fully Illustrator-compatible: ungroup just
 *     reveals the user's original path, now carrying a stroke. BANDS and
 *     SOLIDS dilate alike, each part at its own (factor−1)·W.
 *   · factor < 1 → EROSION thinning (see applyNativeFillThinning): ONE
 *     mask per thinned leaf subtracts a black stroke of (1−factor)·W
 *     along each part's own contours, so every mark keeps its own
 *     centerline and its visible width lands exactly on factor·T̂ as ONE
 *     single thinner line — Illustrator reducing a stroke's weight. The
 *     leaf's own element stays byte-identical apart from the mask
 *     reference; only the artwork's own geometry (verbatim subpath
 *     substrings) appears inside the mask. A mask is the only
 *     subtractive primitive SVG has — it IS the thinning mechanism, and
 *     it imports into Illustrator as an ordinary mask group.
 *  No rasterization, no scaling, no background-paint tricks, and above
 *  all NO geometry generation: no offsetting, no curve flattening into
 *  the output, no anchor-point explosion — Illustrator keeps seeing the
 *  user's own clean vectors and NOTHING ELSE. */

/** Direct geometry leaves that may receive fill weight adjustment
 *  (dilation strokes them — appearance only, geometry never changes).
 *  `use` (paints under its own context), `text`/`tspan` (labels must
 *  never change) are excluded. `line`/`polyline` are open shapes — fill
 *  on them is degenerate, they carry no measurable outline.
 *  Exported for the icon-fit bounds engine (dilation overhang math). */
export const FILL_DILATE_LEAF_TAGS = new Set([
  "path",
  "polyline",
  "polygon",
  "circle",
  "rect",
  "ellipse",
]);

/* ------------------------------------------------------------------ */
/* Element classification                                              */
/* ------------------------------------------------------------------ */

/** Leaf elements that actually RENDER stroke/fill geometry. Exported for
 *  the icon-fit bounds engine (same classification ⇒ same leaves counted). */
export const PAINTED_LEAF_TAGS = new Set([
  "path",
  "line",
  "polyline",
  "polygon",
  "circle",
  "rect",
  "ellipse",
  "use",
  "text",
  "tspan",
]);

/** Subtrees that must never be restyled: clip/mask/filter geometry, marker
 *  & pattern definitions, gradient stops, non-rendering metadata. Shared
 *  with the icon-fit bounds engine. */
export const SKIP_SUBTREE_TAGS = new Set([
  "clippath",
  "mask",
  "filter",
  "marker",
  "pattern",
  "lineargradient",
  "radialgradient",
  "style",
  "script",
  "metadata",
  "title",
  "desc",
  "foreignobject",
]);

/** Paint value is `none` (paints nothing). Shared with the icon-fit
 *  bounds engine (P7) so both walks classify paint identically. */
export function isNone(value: string): boolean {
  return value.trim().toLowerCase() === "none";
}

/** Paint value is a url(#…) reference (gradient/pattern — not solid). */
export function isUrl(value: string): boolean {
  return value.trim().toLowerCase().startsWith("url(");
}

/** First numeric value of a plain length declaration ("2" | "2px" | "2 4" → 2).
 *  Legacy helper for declarations already known to be unit-less (regex
 *  fallback paths); unit-AWARE resolution lives in parseStrokeWidth. */
function parseLen(raw: string | undefined): number | null {
  if (raw == null) return null;
  const first = raw.trim().split(/[\s,]+/)[0] ?? "";
  const n = parseFloat(first);
  return Number.isFinite(n) ? n : null;
}

/** Normalized diagonal of an icon viewBox — the SVG2 percentage reference
 *  (√(w² + h²) / √2 — equals the side length for SQUARE viewBoxes, the value
 *  browsers resolve percentage lengths against for a standalone icon). */
export function viewBoxDiagonal(vbW: number, vbH: number): number {
  const d = Math.sqrt(vbW * vbW + vbH * vbH) / Math.SQRT2;
  return Number.isFinite(d) && d > 0 ? d : 24;
}

/** Resolve a stroke-width declaration to ABSOLUTE icon-user units:
 *   · missing declaration → 1 (the SVG default stroke-width)
 *   · plain number / "px" → the number (user units)
 *   · "n%"                → n/100 · pctRef (the viewBox's normalized diagonal
 *                          — the reference a standalone icon would use)
 *   · em / ex / other font-relative units → null (unresolvable without a
 *     font context — the leaf is honestly left unmeasured / untouched
 *     instead of silently mis-measured as the raw number).
 * The old parseLen-only resolution read "8%" as 8 user units — a ~4×
 * mis-measurement on a 24-unit viewBox that corrupted the native-width
 * readout and the weight-path factor for percentage-stroked icons. */
export function parseStrokeWidth(raw: string | undefined, pctRef: number): number | null {
  if (raw == null) return 1; // SVG default stroke-width = 1
  const first = raw.trim().split(/[\s,]+/)[0] ?? "";
  const m = /^([+-]?[\d.]+)\s*([a-z%]*)$/i.exec(first);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  if (unit === "" || unit === "px") return n;
  if (unit === "%") return (n / 100) * (pctRef > 0 ? pctRef : 24);
  return null; // em / ex / rem / … — no font context to resolve against
}

/** Compact number for attribute output (≤3 decimals, no trailing zeros). */
function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/* ------------------------------------------------------------------ */
/* Document parsing + caches                                           */
/* ------------------------------------------------------------------ */

const parsedCache = new Map<string, SVGElement>();
const strokeCache = new Map<string, string>();
const tintCache = new Map<string, string>();
/* Large libraries (1,000–5,000+ icons) × several sheets render many
 * distinct (icon × factor) combinations; a small cache thrashed and
 * forced full DOM-walk re-execution every render. LRU-evicted. */
const CACHE_CAP = 4000;

function cachePut<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/** LRU-aware read: a hit refreshes the entry's recency. */
function cacheGet<T>(cache: Map<string, T>, key: string): T | undefined {
  const v = cache.get(key);
  if (v !== undefined) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

function hasDomApis(): boolean {
  return typeof DOMParser !== "undefined" && typeof XMLSerializer !== "undefined";
}

/** Deterministic fingerprint of the root <svg>'s presentation attrs (the
 *  INHERITANCE SEED for the walks). MUST be part of every output cache key:
 *  two icons can share IDENTICAL inner markup while their roots declare
 *  different stroke-width / fill / fill-rule (real-world example: an icon
 *  pack's thin & bold variants differing only in the root stroke-width) —
 *  without the fingerprint the second icon would silently reuse the first
 *  icon’s adjusted output and lose its own native weight. */
function rootStyleFingerprint(rootStyle: Record<string, string>): string {
  const keys = Object.keys(rootStyle).sort();
  if (keys.length === 0) return "-";
  return keys.map((k) => `${k}=${rootStyle[k]}`).join("&");
}

/** Parse a fragment (children of an <svg>) into a detached SVG root. */
function parseFragment(inner: string): SVGElement | null {
  if (!hasDomApis()) return null;
  try {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}">${inner}</svg>`,
      "image/svg+xml"
    );
    if (doc.getElementsByTagName("parsererror").length > 0) return null;
    const root = doc.documentElement;
    if (!root || root.localName.toLowerCase() !== "svg") return null;
    return root as unknown as SVGElement;
  } catch {
    return null;
  }
}

/** Pristine parsed root (cached) — returns a MUTABLE clone each call.
 *  Exported for the icon-fit bounds engine (one parser, one cache). */
export function acquireRoot(inner: string, hash: string): SVGElement | null {
  const cached = cacheGet(parsedCache, hash);
  if (cached) return cached.cloneNode(true) as SVGElement;
  const root = parseFragment(inner);
  if (!root) return null;
  cachePut(parsedCache, hash, root);
  return root.cloneNode(true) as SVGElement;
}

/** Serialize the transformed root back to fragment markup (root tag stripped). */
function serializeFragment(root: SVGElement): string {
  let xml = new XMLSerializer().serializeToString(root);
  if (/^<svg[\s>]/i.test(xml)) {
    const openEnd = xml.indexOf(">");
    const closeIdx = xml.toLowerCase().lastIndexOf("</svg>");
    if (openEnd >= 0) {
      xml = closeIdx > openEnd ? xml.slice(openEnd + 1, closeIdx) : xml.slice(openEnd + 1);
    }
  }
  return xml;
}

/* ------------------------------------------------------------------ */
/* Internal CSS (<style> blocks)                                       */
/* ------------------------------------------------------------------ */

/** Own resolved declarations for one element (inline style > CSS rule >
 *  presentation attribute). Exported for the icon-fit bounds engine. */
export interface OwnDecls {
  stroke?: string;
  strokeWidth?: string;
  fill?: string;
  fillOpacity?: string;
}


interface CssRule {
  sel: string;
  body: string;
}

/** Tiny CSS rule splitter (handles @media nesting, comments, braces). */
function parseCssRules(css: string, out: CssRule[] = []): CssRule[] {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  let i = 0;
  while (i < cleaned.length) {
    const brace = cleaned.indexOf("{", i);
    if (brace < 0) break;
    const sel = cleaned.slice(i, brace).trim();
    let depth = 1;
    let j = brace + 1;
    while (j < cleaned.length && depth > 0) {
      if (cleaned[j] === "{") depth++;
      else if (cleaned[j] === "}") depth--;
      j++;
    }
    const body = cleaned.slice(brace + 1, j - 1);
    if (sel.startsWith("@")) {
      parseCssRules(body, out); // at-rule (media…) → recurse into inner rules
    } else if (sel) {
      out.push({ sel, body });
    }
    i = j;
  }
  return out;
}

function parseDecls(body: string, into: OwnDecls): void {
  for (const decl of body.split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (!value) continue;
    if (prop === "stroke") into.stroke = value;
    else if (prop === "stroke-width") into.strokeWidth = value;
    else if (prop === "fill") into.fill = value;
    else if (prop === "fill-opacity") into.fillOpacity = value;
  }
}

/** Map element → CSS declarations that target it (document order).
 *  Exported for the icon-fit bounds engine (cascade parity). */
export function collectCssMap(root: SVGElement): Map<Element, OwnDecls> | null {
  const styleEls = root.querySelectorAll("style");
  if (styleEls.length === 0) return null;
  const rules: CssRule[] = [];
  for (const styleEl of styleEls) rules.push(...parseCssRules(styleEl.textContent ?? ""));
  if (rules.length === 0) return null;
  const map = new Map<Element, OwnDecls>();
  for (const rule of rules) {
    let matched: NodeListOf<Element>;
    try {
      matched = root.querySelectorAll(rule.sel);
    } catch {
      continue; // invalid/unsupported selector — ignore the rule
    }
    for (const el of matched) {
      let decls = map.get(el);
      if (!decls) {
        decls = {};
        map.set(el, decls);
      }
      parseDecls(rule.body, decls);
    }
  }
  return map.size > 0 ? map : null;
}

/* ------------------------------------------------------------------ */
/* Own declarations (inline style > CSS rule > presentation attribute) */
/* ------------------------------------------------------------------ */

/** Exported for the icon-fit bounds engine — the ONE cascade reader. */
export function readOwn(el: Element, cssMap: Map<Element, OwnDecls> | null): OwnDecls {
  const own: OwnDecls = {};
  const aStroke = el.getAttribute("stroke");
  if (aStroke) own.stroke = aStroke;
  const aWidth = el.getAttribute("stroke-width");
  if (aWidth) own.strokeWidth = aWidth;
  const aFill = el.getAttribute("fill");
  if (aFill) own.fill = aFill;
  const aFillOpacity = el.getAttribute("fill-opacity");
  if (aFillOpacity) own.fillOpacity = aFillOpacity;
  const css = cssMap?.get(el);
  if (css) {
    if (css.stroke !== undefined) own.stroke = css.stroke;
    if (css.strokeWidth !== undefined) own.strokeWidth = css.strokeWidth;
    if (css.fill !== undefined) own.fill = css.fill;
    if (css.fillOpacity !== undefined) own.fillOpacity = css.fillOpacity;
  }
  const styleAttr = el.getAttribute("style");
  if (styleAttr) parseDecls(styleAttr, own);
  return own;
}

/* ------------------------------------------------------------------ */
/* Inline-style writes (beat attrs AND internal CSS)                   */
/* ------------------------------------------------------------------ */

function writeInline(el: Element, prop: string, value: string): void {
  const style = (el as SVGElement).style as CSSStyleDeclaration | undefined;
  if (style) {
    try {
      // hyphenated setProperty — covers every declaration form incl.
      // paint-order / stroke-linejoin / stroke-opacity
      style.setProperty(prop, value);
      if (style.getPropertyValue(prop) !== "") return;
    } catch {
      /* fall through to attribute rewrite */
    }
  }
  // Manual fallback: rewrite the style attribute string
  const styleAttr = el.getAttribute("style") ?? "";
  const re = new RegExp(`${prop}\\s*:\\s*[^;]*`, "i");
  const decl = `${prop}:${value}`;
  el.setAttribute("style", re.test(styleAttr) ? styleAttr.replace(re, decl) : `${styleAttr ? styleAttr + ";" : ""}${decl}`);
}

/* ------------------------------------------------------------------ */
/* Walk                                                                */
/* ------------------------------------------------------------------ */

interface WalkState {
  /** resolved inherited stroke declaration (raw value) */
  stroke?: string;
  /** resolved inherited stroke-width declaration (raw value) */
  widthRaw?: string;
  /** resolved inherited fill declaration (raw value) */
  fill?: string;
  /** resolved inherited fill-opacity declaration (raw value) */
  fillOpacity?: string;
  /** resolved inherited even-odd fill rule (root <svg> / ancestors) —
   *  measurement must match what the browser actually renders. */
  frEvenOdd: boolean;
  /** accumulated transform scale of the ancestors + this element's own
   *  transform (geometric mean for non-uniform scales). Used to keep the
   *  native measurement and the fill-dilation width visually uniform
   *  across scaled/nested groups. */
  scale: number;
  /** inside <defs>/<symbol>: default-black fill patching is disabled there
   *  (referenced content may rely on the <use> context's fill). */
  inDefs: boolean;
  /** normalized viewBox diagonal — the percentage reference for
   *  stroke-width declarations expressed in % (SVG2). */
  pctRef: number;
}

/** Length scale introduced by a transform attribute (uniform-length
 *  approximation): scale → geometric mean, matrix → sqrt(|det|),
 *  translate/rotate/skew → 1 (skew distorts directionally only).
 *  Multiple functions in one attribute multiply. */
function transformScale(attr: string | null): number {
  if (!attr) return 1;
  let s = 1;
  const re = /(matrix|scale)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attr)) !== null) {
    const args = m[2].split(/[\s,]+/).map(parseFloat);
    if (m[1] === "scale") {
      const sx = Number.isFinite(args[0]) ? args[0] : 1;
      const sy = Number.isFinite(args[1]) ? args[1] : sx;
      s *= Math.sqrt(Math.abs(sx * sy));
    } else {
      const [a, b, c, d] = args;
      if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d)) {
        s *= Math.sqrt(Math.abs(a * d - b * c));
      }
    }
  }
  return s > 0 && Number.isFinite(s) ? s : 1;
}

/* ---------- fill-based artwork: non-destructive native weight ---------- */

/** fill-rule of an element (inline style > presentation attribute),
 *  UNDEFINED when the element does not declare its own — the caller then
 *  falls back to the INHERITED resolved value (root <svg> / wrapper attrs).
 *  Correct inheritance matters for measurement: an icon declaring
 *  fill-rule="evenodd" on the ROOT renders holes even when no leaf
 *  re-declares it, so measuring such a leaf with the nonzero default
 *  would count holes as filled area and throw T̂ (and every derived
 *  dilation width) off badly. */
function ownFillRuleEvenOdd(el: Element): boolean | undefined {
  const style = el.getAttribute("style") ?? "";
  const m = /fill-rule\s*:\s*(nonzero|evenodd)/i.exec(style);
  if (m) return m[1].toLowerCase() === "evenodd";
  const attr = (el.getAttribute("fill-rule") ?? "").trim().toLowerCase();
  if (attr === "evenodd") return true;
  if (attr === "nonzero") return false;
  return undefined;
}

/** Apply the native weight to one fill-based leaf — DILATION ONLY, and
 *  strictly as a NON-DESTRUCTIVE appearance override. PER-PART widths:
 *  the leaf's outline structure is measured part by part
 *  (measureElementOutline — each band group = outer contour + its direct
 *  holes at Wᵢ = 2·Aᵢ/Pᵢ, each SOLID subshape at its own Wₛ) and EVERY
 *  part receives its own stroke width
 *      dᵢ = (factor − 1) · Wᵢ        → part lands exactly on factor · Wᵢ
 *  (multiplicative per part — the same relative semantics true strokes
 *  get; NEVER the leaf-global average, which mis-lands mixed-width
 *  leaves). BANDS AND SOLIDS dilate alike — Illustrator stroke-weight
 *  growth: a solid IS an outlined stroke (its silhouette IS the stroke's
 *  width), so growing it by (factor−1)·Wₛ/2 around its own contour is
 *  exactly what Illustrator does when a stroked path's weight increases
 *  (the mark keeps its centerline and gets symmetrically fatter — one
 *  single line, never a hollow construction).
 *
 *  Construction (the element's own fill paint re-used as a stroke, round
 *  joins/caps, paint-order:stroke on ORIGINAL, UNTOUCHED geometry):
 *   · one part, nothing else (the common case — lone band, lone solid OR
 *     a primitive leaf) — pure in-place appearance override; `d` and
 *     every shape attribute stay byte-identical;
 *   · multi-part leaves — the leaf is SPLIT into one path per part
 *     (verbatim outer+holes / solid subpath substrings, original order)
 *     plus one path for the unmeasurable leftovers; each part path
 *     carries its own stroke width. Splitting is pure re-grouping of
 *     VERBATIM source subpaths — no offsetting, no flattening, no
 *     generated anchors; Illustrator sees the user's own curves,
 *     nothing else. */
function applyNativeFillDilation(
  el: Element,
  factor: number,
  tol: number,
  fillVal: string | undefined,
  fillOpacityVal: string | undefined,
  evenodd: boolean
): boolean {
  if (!(factor > 1)) return false;
  const report: ElementOutlineReport | null = measureElementOutline(el, evenodd, tol);
  if (!report) return false;
  if (report.bands.length === 0 && report.solids.length === 0) {
    return false; // nothing measurable to dilate → keep native
  }
  const cls = report.classification;
  const paint = fillVal !== undefined ? fillVal : "#000";
  const strokeOpacity =
    fillOpacityVal !== undefined && !isUrl(fillOpacityVal) ? fillOpacityVal : null;

  const applyPartStroke = (target: Element, width: number, kappa: number): void => {
    writeInline(target, "stroke", paint);
    /* SHAPE-AWARE for solids (κ — see SolidShape.kappa): compact marks
     *  grow from their single boundary, so they need twice the stroke to
     *  land the same multiplicative width; bands and capsule-like marks
     *  grow from two opposing edges (κ = 1). */
    writeInline(target, "stroke-width", fmt(kappa * (factor - 1) * width));
    writeInline(target, "stroke-linejoin", "round");
    writeInline(target, "stroke-linecap", "round");
    writeInline(target, "paint-order", "stroke");
    /* dashes inherited from the icon's root could otherwise break the
     * added ring into dashes — pin the added stroke to a solid line. */
    writeInline(target, "stroke-dasharray", "none");
    writeInline(target, "stroke-dashoffset", "0");
    if (strokeOpacity != null) {
      // semi-transparent fills: mirror alpha so the added ring does not
      // render more opaque than the artwork it thickens
      writeInline(target, "stroke-opacity", strokeOpacity);
    }
  };

  const d = el.getAttribute("d");
  if (d == null) {
    /* PRIMITIVE leaf (circle/rect/ellipse/polygon) — the element itself
     * is ONE measurable solid: pure appearance override, GEOMETRY IS
     * NEVER TOUCHED. The solid grows by (factor−1)·Wₛ/2 around its own
     * contour — Illustrator stroke growth, single line semantics. */
    const solid = report.solids[0];
    if (!solid) return false;
    applyPartStroke(el, solid.width, solid.kappa);
    return true;
  }

  /* PATH leaf — parts: one per band (outer + direct holes) and one per
   * measurable solid, each at its OWN width. Precompute EVERY emitted d
   * string BEFORE any DOM mutation — a malformed span aborts the whole
   * leaf (kept native, reported limited) instead of leaving a
   * half-split element behind. */
  const partSrcs: string[] = [];
  const partWidths: number[] = [];
  const partKappas: number[] = [];
  for (const band of report.bands) {
    const src = joinStandalone([
      cls.spans[band.outerIdx],
      ...band.holeIdx.map((h) => cls.spans[h]),
    ]);
    if (src == null) return false;
    partSrcs.push(src);
    partWidths.push(band.width);
    partKappas.push(1);
  }
  for (const s of report.solids) {
    const src = spanStandaloneSrc(cls.spans[s.idx]);
    if (src == null) return false;
    partSrcs.push(src);
    partWidths.push(s.width);
    partKappas.push(s.kappa);
  }
  /* Unmeasurable solids (open / degenerate spans) keep rendering
   * verbatim as filled paths — they are the leaf's leftover group. */
  const leftoverIdx = cls.solidIdx.filter((i) => !report.solids.some((s) => s.idx === i));
  const leftoverSrc = joinStandalone(leftoverIdx.map((i) => cls.spans[i]));
  if (leftoverSrc == null && leftoverIdx.length > 0) return false;

  if (partSrcs.length === 1 && !leftoverSrc) {
    /* Common case — one part, nothing else (a lone band OR a lone solid):
     * pure appearance override, GEOMETRY IS NEVER TOUCHED (the original
     * `d` stays byte-identical — no re-emission needed at all). */
    applyPartStroke(el, partWidths[0], partKappas[0]);
    return true;
  }

  /* Multi-part leaf — one stroked path per part + the leftover fill
   * clone. Clones are taken BEFORE the original is modified so they
   * carry the element's pristine attributes (fill, fill-rule, class,
   * transform…); ids are stripped (the original element keeps its own). */
  const doc = el.ownerDocument;
  const parent = el.parentNode;
  if (!doc || !parent) return false;
  const extraEls = partSrcs.slice(1).map(() => el.cloneNode(false) as Element);
  const leftoverEl = leftoverSrc ? (el.cloneNode(false) as Element) : null;
  if (leftoverEl) leftoverEl.removeAttribute("id");
  let anchor: Element = el;
  for (let p = 0; p < partSrcs.length; p++) {
    let target: Element;
    if (p === 0) {
      target = el; // keeps the original id
    } else {
      target = extraEls[p - 1];
      parent.insertBefore(target, anchor.nextSibling);
    }
    target.setAttribute("d", partSrcs[p]);
    applyPartStroke(target, partWidths[p], partKappas[p]);
    anchor = target;
  }
  /* leftoverEl only exists when leftoverSrc was truthy — the joint guard
   * keeps the narrowing honest for TS without changing behavior */
  if (leftoverEl && leftoverSrc != null) {
    leftoverEl.setAttribute("d", leftoverSrc);
    /* leftovers keep their exact native size — no stroke, fill untouched */
    parent.insertBefore(leftoverEl, anchor.nextSibling);
  }
  return true;
}

/** Join subpath spans into ONE standalone-safe `d` string: every span is
 *  re-anchored through spanStandaloneSrc (a relative-'m' start becomes an
 *  absolute 'M' at the SAME resolved point), so the joined group renders
 *  exactly the sub-regions it selects from the source — regrouping can
 *  never relocate geometry. null = malformed span (caller keeps native). */
function joinStandalone(spans: SubpathSpan[]): string | null {
  let out = "";
  for (const span of spans) {
    const s = spanStandaloneSrc(span);
    if (s == null) return null;
    out += s;
  }
  return out;
}

/* ---------- fill-based artwork: non-destructive THINNING ---------- */

/** Per-walk context shared by every leaf of ONE adjustIconStrokes call:
 *  collects the mask defs generated by thinning (appended to the
 *  fragment root before serialization) and hands out DETERMINISTIC ids
 *  (ist1, ist2, … — same input ⇒ same output, so the stroke cache stays
 *  correct; the renderer's namespaceIds() then prefixes them per embed,
 *  making every reference collision-free across preview, export, overview
 *  cards and multi-sheet artboards). */
interface StrokeWalkContext {
  defs: Element[];
  nextMaskId: () => string;
}

/** Apply the native weight to one fill-based leaf — THINNING (factor < 1)
 *  via the EROSION construction: the vector equivalent of REDUCING a
 *  stroke's weight in Adobe Illustrator. A fill-based mark (band or
 *  solid) IS an outlined stroke, so thinning must keep it ONE SINGLE
 *  LINE centered on the mark's own midline and land its visible width
 *  exactly on factor·W — never hollow it into a double outline (the old
 *  clipped inner-band construction did exactly that on bold capsule /
 *  silhouette artwork: every segment rendered as two parallel hairlines
 *  — the “weight reduction converts icons to outlines” regression).
 *
 *  Math (mirrors applyNativeFillDilation per part): each BAND group
 *  (outer + direct holes) and each SOLID subshape is measured at its OWN
 *  width Wᵢ and eroded by
 *      ρᵢ = (1 − factor) · Wᵢ / 2     (every edge moves inward by ρᵢ)
 *  so the mark keeps its centerline and its visible width lands on
 *      Wᵢ − 2ρᵢ = factor · Wᵢ
 *  exactly — the same multiplicative result true strokes get, never a
 *  leaf-global average. Continuous at every factor (no hollow jump, no
 *  coverage cliff): f→1 returns the verbatim original, f→0 erodes every
 *  mark to a hairline.
 *
 *  In SVG, erosion = fill ∩ complement(stroke(contour, 2ρ)) — and the
 *  ONLY subtractive primitive SVG has is a mask, so the construction
 *  emits exactly ONE mask per thinned leaf:
 *
 *    <defs>
 *      <mask id="istN" maskUnits="userSpaceOnUse" x y width height>
 *        <rect x y width height fill="#fff"/>          ← white = visible
 *        <path d="«band outer+holes / solid contour — VERBATIM subpath
 *                 substrings, standalone-anchored»" fill="none"
 *              stroke="#000" stroke-width="(1−factor)·Wᵢ"
 *              stroke-linejoin="round" stroke-linecap="round"/>  ← per part
 *      </mask>
 *    </defs>
 *    … the leaf itself keeps `d`, fill, fill-rule, fill-opacity VERBATIM
 *        and only gains mask="url(#istN)" (a presentation attribute, so
 *        the renderer's id-namespacing can rewrite the reference
 *        verbatim — the same contract the old clip-path used).
 *
 *  · The black erase strokes follow each mark's own contours with ROUND
 *    joins (round = the true inward offset curve), so the remaining ink
 *    is ONE thinner mark centered on the original: capsule bars stay
 *    single capsules, dots stay single dots, silhouettes shrink
 *    gracefully around their own midlines — exactly what a stroked path
 *    does in Illustrator when its weight is reduced.
 *  · Every emitted `d` inside the mask is a VERBATIM SUBSTRING of the
 *    source data — no offsetting, no flattening, no rebuilding, no
 *    generated anchors; curves stay curves, anchor counts never change.
 *    The leaf's own element is not modified at all beyond the mask
 *    reference (its `d` is never rewritten — strictly better than the
 *    old clip construction, which re-emitted part srcs onto the leaf).
 *  · Unmeasurable subpaths (open / degenerate spans) simply get NO erase
 *    stroke → they keep rendering verbatim at native weight inside the
 *    SAME element (no leftover-splitting machinery needed at all).
 *  · The mask coordinates live in the element's own user space (the same
 *    space its `d` lives in), so ancestor/own transforms carry geometry
 *    and mask together — the construction is transform-proof. The mask
 *    children carry their paint as INLINE STYLES so neither the wrapper's
 *    inherited presentation attributes (stroke-dasharray & friends) nor
 *    the icon's internal CSS rules (tag selectors) can corrupt the erase
 *    geometry, and the black/white paint is never touched by tinting
 *    (walkTint skips mask subtrees).
 *  · Honest limits: leaves with no measurable part, or leaves already
 *    carrying their own mask attribute (which must not be overwritten),
 *    return false and keep their exact native weight (reported limited
 *    upstream).
 *  · A mask imports into Illustrator as an ordinary mask group —
 *    releasing it reveals the user's own untouched path plus the two
 *    black/white helper strokes; the artwork geometry is never damaged. */
function applyNativeFillThinning(
  el: Element,
  factor: number,
  tol: number,
  ctx: StrokeWalkContext
): boolean {
  if (!(factor > 0) || factor >= 1) return false;
  const report: ElementOutlineReport | null = measureElementOutline(el, false, tol);
  if (!report) return false;
  if (report.bands.length === 0 && report.solids.length === 0) {
    return false; // nothing measurable to thin → keep native
  }
  const doc = el.ownerDocument;
  const parent = el.parentNode;
  if (!doc || !parent) return false;
  /* The leaf must not already carry a mask (attribute or style) — the
   * erosion reference would overwrite it. Keep native (honest limited). */
  if (el.hasAttribute("mask") || /(^|;)\s*mask\s*:/i.test(el.getAttribute("style") ?? "")) {
    return false;
  }

  const cls = report.classification;
  const d = el.getAttribute("d");
  /* Per-part erase width — SHAPE-AWARE for solids (κ): stroke-like marks
   *  (capsules/bars, κ=1) erode from two opposing edges so
   *  erase = (1−f)·W lands the width on f·W exactly; compact marks
   *  (dots/squares, κ=2) erode from their single boundary, so the SAME
   *  multiplicative landing needs twice the stroke. Bands are outlined
   *  strokes by definition — κ = 1. */
  const eraseWidthOf = (width: number, kappa: number): number =>
    kappa * (1 - factor) * width;

  /* The mask region / white-rect bounds: the leaf's own render area (all
   * sampled subpath / primitive points) padded by the widest erase stroke
   * — the mask must stay fully WHITE (visible) everywhere the leaf can
   * paint, or the artwork would be clipped away at the region edge. */
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const accrue = (pts: readonly [number, number][] | null): void => {
    if (!pts) return;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  };
  if (d == null) {
    const polys = elementPolys(el, tol);
    if (polys) for (const p of polys) accrue(p.pts);
  } else {
    for (const span of cls.spans) accrue(span.poly ? span.poly.pts : null);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return false;

  let maxErase = 0;
  for (const band of report.bands) maxErase = Math.max(maxErase, eraseWidthOf(band.width, 1));
  for (const s of report.solids) maxErase = Math.max(maxErase, eraseWidthOf(s.width, s.kappa));
  const margin = maxErase + 1;
  const rx = fmt(minX - margin);
  const ry = fmt(minY - margin);
  const rw = fmt(maxX - minX + 2 * margin);
  const rh = fmt(maxY - minY + 2 * margin);

  const maskId = ctx.nextMaskId();
  const mask = doc.createElementNS(SVG_NS, "mask");
  mask.setAttribute("id", maskId);
  /* userSpaceOnUse for the REGION too (the default is objectBoundingBox,
   * which would clip the mask to the referencing element's bbox ±10% and
   * can mis-place it under nested transforms) — region and content share
   * the leaf's own user space, the same space its `d` lives in. */
  mask.setAttribute("maskUnits", "userSpaceOnUse");
  mask.setAttribute("maskContentUnits", "userSpaceOnUse");
  mask.setAttribute("x", rx);
  mask.setAttribute("y", ry);
  mask.setAttribute("width", rw);
  mask.setAttribute("height", rh);

  const white = doc.createElementNS(SVG_NS, "rect");
  white.setAttribute("x", rx);
  white.setAttribute("y", ry);
  white.setAttribute("width", rw);
  white.setAttribute("height", rh);
  /* INLINE STYLES on the mask children: they beat both the wrapper's
   * inherited presentation attributes AND the icon's internal CSS rules
   * (a tag selector like `path { stroke-width:2 }` must never corrupt the
   * erase width), and the black/white paint never gets tinted. */
  writeInline(white, "fill", "#fff");
  writeInline(white, "fill-opacity", "1");
  mask.appendChild(white);

  const addEraseStroke = (target: Element, width: number, kappa: number): void => {
    writeInline(target, "fill", "none");
    writeInline(target, "fill-opacity", "1");
    writeInline(target, "stroke", "#000");
    writeInline(target, "stroke-width", fmt(eraseWidthOf(width, kappa)));
    writeInline(target, "stroke-opacity", "1");
    /* round joins = the true inward offset curve (the exact erosion
     * boundary at convex corners); round caps are inert on closed
     * contours but keep open degenerate spans safe if ever emitted. */
    writeInline(target, "stroke-linejoin", "round");
    writeInline(target, "stroke-linecap", "round");
    writeInline(target, "stroke-dasharray", "none");
    writeInline(target, "stroke-dashoffset", "0");
  };

  if (d == null) {
    /* PRIMITIVE leaf (circle/rect/ellipse/polygon): the erase stroke is a
     * VERBATIM CLONE of the element (same geometry attributes; transform
     * stripped — the mask lives in the leaf's own user space, exactly like
     * the old clip child was). */
    const solid = report.solids[0];
    if (!solid) return false;
    const erase = el.cloneNode(false) as Element;
    erase.removeAttribute("id");
    erase.removeAttribute("transform");
    addEraseStroke(erase, solid.width, solid.kappa);
    mask.appendChild(erase);
  } else {
    /* PATH leaf — one erase stroke per part (band outer+holes / solid
     * contour), each at its OWN width; the emitted `d` strings are
     * VERBATIM substrings of the source (standalone-anchored). */
    for (const band of report.bands) {
      const src = joinStandalone([
        cls.spans[band.outerIdx],
        ...band.holeIdx.map((h) => cls.spans[h]),
      ]);
      if (src == null) return false; // malformed span — abort, keep native
      const erase = doc.createElementNS(SVG_NS, "path");
      erase.setAttribute("d", src);
      addEraseStroke(erase, band.width, 1);
      mask.appendChild(erase);
    }
    for (const s of report.solids) {
      const src = spanStandaloneSrc(cls.spans[s.idx]);
      if (src == null) return false; // malformed span — abort, keep native
      const erase = doc.createElementNS(SVG_NS, "path");
      erase.setAttribute("d", src);
      addEraseStroke(erase, s.width, s.kappa);
      mask.appendChild(erase);
    }
  }
  ctx.defs.push(mask);

  /* The leaf itself: `d`, fill, fill-rule, fill-opacity — ALL VERBATIM.
   * Only the mask reference is added, as a PRESENTATION ATTRIBUTE (not
   * inline style): the CSSOM would re-serialize a style-declared url()
   * with quotes (url("#ist1")), and the renderer's id-namespacing must
   * be able to match the reference verbatim. */
  el.setAttribute("mask", `url(#${maskId})`);
  return true;
}

/* ---------- stroke-width adjustment ---------- */

function walkStroke(
  el: Element,
  state: WalkState,
  cssMap: Map<Element, OwnDecls> | null,
  /** multiplicative weight factor (1 = untouched) — the SAME engine for
   *  the plain px weight delta and for uniform-to-target (the renderer
   *  computes the per-icon factor from the measured native weight, the
   *  embed's scale and the user's px value / target). BIDIRECTIONAL:
   *  factors below 1 THIN (true strokes multiply; fill-based outlines use
   *  the clipped outer-contour stroke), above 1 THICKEN. */
  factor: number,
  /** curve-flattening tolerance for fill-based geometry work (icon units) */
  tol: number,
  /** thinning context (mask defs collector + deterministic ids) */
  ctx: StrokeWalkContext
): void {
  const tag = el.localName?.toLowerCase() ?? "";
  if (SKIP_SUBTREE_TAGS.has(tag)) return;

  const own = readOwn(el, cssMap);
  const strokeVal = own.stroke !== undefined ? own.stroke : state.stroke;
  const widthRaw = own.strokeWidth !== undefined ? own.strokeWidth : state.widthRaw;
  const fillVal = own.fill !== undefined ? own.fill : state.fill;
  const fillOpacityVal = own.fillOpacity !== undefined ? own.fillOpacity : state.fillOpacity;
  /* fill-rule resolves like every other inherited paint property: own
   *  declaration (inline style > attribute) beats the inherited value —
   *  measurement and adjustment always agree with what renders. */
  const frEvenOdd = ownFillRuleEvenOdd(el) ?? state.frEvenOdd;

  /* The element's own transform applies to itself AND its children, so
   * its stroke-width is interpreted in the post-own-transform space. */
  const elScale = state.scale * transformScale(el.getAttribute("transform"));

  /* vector-effect="non-scaling-stroke" pins the stroke to SCREEN space —
   *  its width cannot be scaled reliably through the embed pipeline, so
   *  such leaves are honestly skipped (and reported unmeasurable). */
  const nonScalingStroke = /non-scaling/i.test(el.getAttribute("vector-effect") ?? "");

  const activeStroke = strokeVal !== undefined && !isNone(strokeVal);
  if (PAINTED_LEAF_TAGS.has(tag) && activeStroke) {
    /* Unit-aware resolution: % widths resolve against the icon viewBox's
     * normalized diagonal; em/ex-like units are unresolvable → the leaf
     * honestly keeps its native declaration (no rewrite, no fake number). */
    const eff = parseStrokeWidth(widthRaw, state.pctRef);
    if (
      eff != null &&
      eff > 0 &&
      factor !== 1 &&
      !nonScalingStroke
    ) {
      // 0 = author-disabled hairline — leave untouched (never "revives" it);
      // multiply the element's own local width → line hierarchy kept
      writeInline(el, "stroke-width", fmt(eff * factor));
    }
  } else if (
    /* Fill-based outline artwork: no active stroke, but a solid color
     * fill (declared, inherited, or the SVG default black). Adjust the
     *  artwork's native weight around its OWN measured thickness —
     *  DILATION above ×1 (mirrored-fill paint-order stroke, bands AND
     *  solids), EROSION thinning below ×1 (one mask per thinned leaf:
     *  every mark keeps its centerline as ONE single thinner line —
     *  Illustrator stroke-weight semantics; both strictly non-destructive
     *  appearance overrides). Elements with an active stroke (even width
     *  0 — author-disabled) are never double-treated; url() paints and
     *  fill="none" containers are skipped; nothing inside defs/symbol
     *  (their paint may come from the <use> context); text/tspan labels
     *  never change. */
    FILL_DILATE_LEAF_TAGS.has(tag) &&
    !activeStroke &&
    !nonScalingStroke &&
    (fillVal !== undefined ? !isNone(fillVal) && !isUrl(fillVal) : !state.inDefs)
  ) {
    if (factor > 1) {
      /* THICKER — non-destructive dilation stroke on the original,
       * untouched geometry (appearance override only; bands and solids
       * alike — each part grows around its own contour). */
      applyNativeFillDilation(el, factor, tol, fillVal, fillOpacityVal, frEvenOdd);
    } else if (factor < 1) {
      /* THINNER — non-destructive erosion mask: every mark (band or
       *  solid) keeps its own centerline and lands on factor·T̂ as ONE
       *  single thinner line (Illustrator stroke-weight reduction); the
       *  leaf's own geometry and paint stay byte-identical apart from the
       *  mask reference. Leaves without a measurable part honestly keep
       *  their native weight (reported limited). */
      applyNativeFillThinning(el, factor, tol, ctx);
    }
  }

  const nextState: WalkState = {
    stroke: strokeVal,
    widthRaw,
    fill: fillVal,
    fillOpacity: fillOpacityVal,
    frEvenOdd,
    scale: elScale,
    inDefs: state.inDefs || tag === "defs" || tag === "symbol",
    pctRef: state.pctRef,
  };
  for (const child of Array.from(el.children)) {
    walkStroke(child, nextState, cssMap, factor, tol, ctx);
  }
}

/* ---------- monochrome tint ---------- */

function walkTint(
  el: Element,
  state: WalkState,
  cssMap: Map<Element, OwnDecls> | null,
  color: string
): void {
  const tag = el.localName?.toLowerCase() ?? "";
  if (SKIP_SUBTREE_TAGS.has(tag)) return;

  const own = readOwn(el, cssMap);
  const strokeVal = own.stroke !== undefined ? own.stroke : state.stroke;
  const widthRaw = own.strokeWidth !== undefined ? own.strokeWidth : state.widthRaw;
  const fillVal = own.fill !== undefined ? own.fill : state.fill;
  const fillOpacityVal = own.fillOpacity !== undefined ? own.fillOpacity : state.fillOpacity;

  if (PAINTED_LEAF_TAGS.has(tag)) {
    // fill: declared paints (≠ none/url) are recolored; UNDECLARED fills
    // default to BLACK per the SVG spec — recolor them too, except inside
    // defs/symbol where the paint may come from the <use> context.
    if (fillVal !== undefined) {
      if (!isNone(fillVal) && !isUrl(fillVal)) writeInline(el, "fill", color);
    } else if (!state.inDefs) {
      writeInline(el, "fill", color);
    }
    if (strokeVal !== undefined && !isNone(strokeVal) && !isUrl(strokeVal)) {
      // includes the stroke added by the fill-dilation pass (it runs
      // before the tint and mirrors the fill paint) → color + weight
      // always compose consistently
      writeInline(el, "stroke", color);
    }
  }

  /* fill-rule resolution mirrors walkStroke so tinting state stays
   *  structurally identical (the tint never depends on it — it only
   *  recolors paint — but keeping the walks uniform prevents drift). */
  const nextState: WalkState = { stroke: strokeVal, widthRaw, fill: fillVal, fillOpacity: fillOpacityVal, frEvenOdd: ownFillRuleEvenOdd(el) ?? state.frEvenOdd, scale: state.scale, inDefs: state.inDefs || tag === "defs" || tag === "symbol", pctRef: state.pctRef };
  for (const child of Array.from(el.children)) {
    walkTint(child, nextState, cssMap, color);
  }
}

/* ------------------------------------------------------------------ */
/* Root <svg> tag style helpers (used by the embedding wrapper)        */
/* ------------------------------------------------------------------ */

/** Seed state from the source root <svg>'s captured presentation attrs. */
function seedFromRootStyle(rootStyle: Record<string, string>, pctRef: number): WalkState {
  return {
    stroke: rootStyle.stroke,
    widthRaw: rootStyle["stroke-width"],
    fill: rootStyle.fill,
    fillOpacity: rootStyle["fill-opacity"],
    frEvenOdd: (rootStyle["fill-rule"] ?? "").trim().toLowerCase() === "evenodd",
    scale: 1,
    inDefs: false,
    pctRef,
  };
}

/** Resolve a PERCENTAGE root stroke-width declaration to absolute user
 *  units (mutates the WORKING rootStyle copy the embedder owns — the
 *  pristine parse cache is never touched). Percentages resolve against
 *  the nearest VIEWPORT diagonal: once the icon is embedded as a <g> in a
 *  6000×2400 sheet, a root "8%" would silently resolve against the SHEET's
 *  diagonal and render ~17× too thick — resolving it against the icon's
 *  OWN viewBox diagonal (the reference the author meant) keeps the embed
 *  visually identical to the standalone original. Runs on EVERY embed
 *  (factor 1 included): it is embedding correctness, not adjustment. */
export function resolveRootStrokeWidthUnits(
  rootStyle: Record<string, string>,
  viewBox: readonly number[] | null
): void {
  const raw = rootStyle["stroke-width"];
  if (raw == null || !raw.includes("%")) return;
  const vbW = viewBox != null && Number.isFinite(viewBox[2]) ? viewBox[2] : 24;
  const vbH = viewBox != null && Number.isFinite(viewBox[3]) ? viewBox[3] : 24;
  const resolved = parseStrokeWidth(raw, viewBoxDiagonal(vbW, vbH));
  if (resolved != null && resolved > 0) rootStyle["stroke-width"] = fmt(resolved);
}

/** Scale the root-declared stroke width (wrapper carries the root's attrs).
 *  Unresolvable units (em/ex) keep their native declaration verbatim. */
export function scaleRootStrokeWidth(
  rootStyle: Record<string, string>,
  factor: number,
  viewBox: readonly number[] | null = null
): void {
  if (factor === 1) return;
  const stroke = rootStyle.stroke;
  if (!stroke || isNone(stroke)) return;
  const vbW = viewBox != null && Number.isFinite(viewBox[2]) ? viewBox[2] : 24;
  const vbH = viewBox != null && Number.isFinite(viewBox[3]) ? viewBox[3] : 24;
  const current = parseStrokeWidth(rootStyle["stroke-width"], viewBoxDiagonal(vbW, vbH));
  if (current == null) return; // unresolvable unit — keep the native declaration
  const base = current; // missing declaration already resolved to the SVG default 1
  rootStyle["stroke-width"] = fmt(base * factor);
}

/** Recolor the root-declared stroke/fill (wrapper carries the root's attrs). */
export function applyRootTint(rootStyle: Record<string, string>, color: string): void {
  if (rootStyle.stroke && !isNone(rootStyle.stroke) && !isUrl(rootStyle.stroke)) {
    rootStyle.stroke = color;
  }
  if (rootStyle.fill && !isNone(rootStyle.fill) && !isUrl(rootStyle.fill)) {
    rootStyle.fill = color;
  }
}

/* ------------------------------------------------------------------ */
/* Regex fallbacks (no DOM / unparseable fragment)                     */
/* ------------------------------------------------------------------ */

function scaleStrokeWidthsRegex(inner: string, factor: number): string {
  if (factor === 1) return inner;
  let out = inner.replace(
    /stroke-width\s*=\s*"([\d.]+)"/gi,
    (full, num) => `stroke-width="${fmt(parseFloat(num) * factor)}"`
  );
  out = out.replace(
    /([:;]\s*stroke-width\s*:\s*)([\d.]+)/gi,
    (full, pre, num) => `${pre}${fmt(parseFloat(num) * factor)}`
  );
  return out;
}

function tintRegex(inner: string, color: string): string {
  return applyTint(inner, color);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Adjust the stroke widths of an icon fragment (rendered copy only —
 * every call starts from the pristine cached parse, so adjustments never
 * accumulate). Handles attributes, inline styles, internal CSS rules,
 * groups, nested groups, inheritance and every leaf shape.
 * STRICTLY NON-DESTRUCTIVE and ILLUSTRATOR-CLEAN — adjustments are
 * expressed purely as appearance overrides on the user's own geometry:
 *   · true strokes multiply by the factor (native baseline, THINNER
 *     below 1 / thicker above) — inline-style overrides;
 *   · fill-based outline artwork: a dilation stroke (factor > 1) on the
 *     original geometry (paint-order:stroke) OR the erosion mask
 *     (factor < 1) — Illustrator stroke-weight semantics in BOTH
 *     directions: every mark (band or solid) keeps its own centerline
 *     and lands its visible width exactly on factor·T̂ as ONE single
 *     line. Every emitted `d` is a verbatim substring of the source; the
 *     only structural addition is ONE mask per thinned leaf (the erosion
 *     mechanism itself — SVG's only subtractive primitive), and the
 *     leaf's own element stays byte-identical apart from the mask
 *     reference. Structurally unmeasurable leaves honestly keep their
 *     native weight and are reported limited.
 * The factor comes from either user control — the plain px weight delta
 * (per icon: 1 + delta / nativeVisual, clamped) or the uniform-stroke
 * target (per icon: target / nativeVisual); legacy-support derivations
 * (dormant % records) flow through this same entry point. Intra-icon
 * hierarchy is preserved either way (every element of an icon multiplies
 * by the same factor).
 */
export function adjustIconStrokes(
  inner: string,
  rootStyle: Record<string, string>,
  /** the icon's viewBox [x, y, w, h] — drives BOTH the measurement
   *  tolerance (identically to analyzeNativeStroke) and the percentage
   *  reference for % stroke-width declarations. null → [0,0,24,24]. */
  viewBox: readonly number[] | null,
  factor: number
): string {
  if (!(factor > 0) || !Number.isFinite(factor) || factor === 1) return inner;

  const vbW = viewBox != null && Number.isFinite(viewBox[2]) ? viewBox[2] : 24;
  const vbH = viewBox != null && Number.isFinite(viewBox[3]) ? viewBox[3] : 24;
  const viewBoxSize = Math.max(vbW, vbH) || 24;
  const pctRef = viewBoxDiagonal(vbW, vbH);

  /* Measurement tolerance for the fill weight computation — pure math
   * on the parsed copy; nothing sampled here ever enters the output
   * markup (emitted `d` strings are verbatim source substrings).
   * IDENTICAL formula to analyzeNativeStroke so the measured bands always
   * match what the adjustment will compute for the same element. */
  const tol = Math.min(0.25, Math.max(0.01, viewBoxSize / 1200));

  const hash = hashSvgContent(inner);
  const cacheKey = `${hash}|s${fmt(factor)}|v${vbW || 24}x${vbH || 24}|r${rootStyleFingerprint(rootStyle)}`;
  const cached = cacheGet(strokeCache, cacheKey);
  if (cached !== undefined) return cached;

  let result: string;
  const root = hasDomApis() ? acquireRoot(inner, hash) : null;
  if (root) {
    try {
      const cssMap = collectCssMap(root);
      const seed = seedFromRootStyle(rootStyle, pctRef);
      /* Deterministic per-walk mask ids (same input ⇒ same output, so the
       * cache stays correct); the renderer's namespaceIds() renames them
       * per embed afterwards (collision-free across every view). */
      let maskCounter = 0;
      const ctx: StrokeWalkContext = {
        defs: [],
        nextMaskId: () => `ist${(maskCounter += 1)}`,
      };
      for (const child of Array.from(root.children)) {
        walkStroke(child, seed, cssMap, factor, tol, ctx);
      }
      if (ctx.defs.length > 0) {
        /* Thinning generated mask defs — insert them at the front of the
         * fragment (creation order preserved). Valid SVG anywhere; the
         * references resolve regardless of position. */
        for (let i = ctx.defs.length - 1; i >= 0; i--) {
          root.insertBefore(ctx.defs[i], root.firstChild);
        }
      }
      result = serializeFragment(root);
    } catch {
      result = scaleStrokeWidthsRegex(inner, factor);
    }
  } else {
    result = scaleStrokeWidthsRegex(inner, factor);
  }
  cachePut(strokeCache, cacheKey, result);
  return result;
}

/* ------------------------------------------------------------------ */
/* Native stroke analysis (per-icon measurement intelligence)          */
/* ------------------------------------------------------------------ */

/** Native-weight measurement for ONE icon (pure analysis — no mutation).
 *  This is the per-icon intelligence behind the stroke system: the
 *  inspector reports it, the migration helper derives legacy equivalents
 *  from it, and the renderer divides the user's px value / target by
 *  `rootWidth`·embedScale to obtain that icon's OWN correction factor
 *  (never the same numeric adjustment for every icon) before applying it
 *  through the same adjustIconStrokes engine. */
export interface NativeStrokeReport {
  /** Representative native outline weight in ICON ROOT units (viewBox
   *  coordinate space): the WIDEST measured stroked / fill-outline band —
   *  the icon's DOMINANT look. Fill-outline leaves measure PER BAND
   *  (Wᵢ = 2·Aᵢ/Pᵢ per outer+holes group — exact for bars and rings),
   *  never a leaf-global average, so leaves mixing solids with bands or
   *  bands of different weights report the artwork's true dominant
   *  weight (the old leaf-global T̂ under-reported solid-dotted artwork
   *  by ~2× and averaged mixed-width leaves — the root cause behind the
   *  “native 0.3–0.9 px but visually thick”, “target 2 px renders
   *  over-bold” and “thick icon unchanged at target 1 px” bugs).
   *  0 = no measurable adjustable artwork (the icon honestly reports as
   *  "limited" and is left untouched rather than faked). */
  rootWidth: number;
  /** leaf elements painting an ACTIVE stroke whose width was measured. */
  strokedLeaves: number;
  /** fill-outline leaves with ≥ 1 measurable outline BAND (these adjust
   *  in BOTH directions — dilation and thinning are per-band). */
  fillOutlineLeaves: number;
  /** fill leaves with ≥ 1 measured part (band OR solid) — they adjust in
   *  BOTH directions exactly like true strokes: erosion thinning below
   *  ×1 (one mask per leaf — every mark keeps its centerline as ONE
   *  single thinner line) and paint-order dilation above ×1 (per-part
   * mirrored-fill stroke). This is why a uniform-stroke request reaches
   *  the bold filled marks of real packs in both directions. */
  thinSupportedLeaves: number;
  /** fill leaves that are SOLID shapes only (measurable solids, no
   *  bands) — counted separately for diagnostics/capability labels;
   *  they adjust in BOTH directions exactly like band leaves (erosion
   *  thinning / dilation stroke around their own contours). */
  solidFillLeaves: number;
  /** fill-outline leaves that could NOT be measured safely (open or
   *  degenerate shapes, unsafe subpath structure) — they stay untouched
   *  at render time. */
  unmeasurableLeaves: number;
}

interface MeasureState {
  stroke?: string;
  widthRaw?: string;
  fill?: string;
  frEvenOdd: boolean;
  inDefs: boolean;
  scale: number;
  /** normalized viewBox diagonal — percentage reference (mirrors WalkState). */
  pctRef: number;
}

function walkMeasure(
  el: Element,
  state: MeasureState,
  cssMap: Map<Element, OwnDecls> | null,
  tol: number,
  report: NativeStrokeReport
): void {
  const tag = el.localName?.toLowerCase() ?? "";
  if (SKIP_SUBTREE_TAGS.has(tag)) return;
  const own = readOwn(el, cssMap);
  const strokeVal = own.stroke !== undefined ? own.stroke : state.stroke;
  const widthRaw = own.strokeWidth !== undefined ? own.strokeWidth : state.widthRaw;
  const fillVal = own.fill !== undefined ? own.fill : state.fill;
  const frEvenOdd = ownFillRuleEvenOdd(el) ?? state.frEvenOdd;
  const activeStroke = strokeVal !== undefined && !isNone(strokeVal);
  /* Mirrors walkStroke exactly: the element's own transform applies to
   * itself AND its children, so its stroke-width is interpreted in the
   * post-own-transform space (root units = local × elScale). */
  const elScale = state.scale * transformScale(el.getAttribute("transform"));
  /* Mirrors walkStroke's guard: screen-pinned strokes cannot be scaled
   * reliably — honestly unmeasurable. */
  const nonScalingStroke = /non-scaling/i.test(el.getAttribute("vector-effect") ?? "");
  if (PAINTED_LEAF_TAGS.has(tag)) {
    if (activeStroke) {
      /* Unit-aware resolution (mirrors walkStroke): % widths resolve
       * against the viewBox diagonal; unresolvable units (em/ex) count as
       * unmeasurable — never silently mis-measured as the raw number. */
      const eff = parseStrokeWidth(widthRaw, state.pctRef);
      if (eff != null && eff > 0 && !nonScalingStroke) {
        report.strokedLeaves++;
        report.rootWidth = Math.max(report.rootWidth, eff * elScale);
      }
    } else if (
      FILL_DILATE_LEAF_TAGS.has(tag) &&
      !nonScalingStroke &&
      (fillVal !== undefined ? !isNone(fillVal) && !isUrl(fillVal) : !state.inDefs)
    ) {
      /* PER-PART outline measurement — the SAME report the adjustment
       * engine derives its per-band / per-solid stroke widths from (one
       * source of truth: the panel can never disagree with the render).
       * Solids count toward the representative width too — they are the
       * icon's boldest marks, and the native readout must reflect the
       * artwork's true dominant look. */
      const outline = measureElementOutline(el, frEvenOdd, tol);
      if (outline) {
        if (outline.bands.length > 0) {
          report.fillOutlineLeaves++;
          /* bands thin (clipped contour stroke) AND dilate (mirrored-fill
           * stroke) — capability and measurement are derived from the
           * SAME per-band analysis. */
          report.thinSupportedLeaves++;
          report.rootWidth = Math.max(report.rootWidth, outline.representative * elScale);
        } else if (outline.solids.length > 0) {
          /* measured SOLID-only leaf — bidirectional like every other
           * measured fill leaf: erosion thinning below ×1 (single thinner
           * line at factor·Wₛ, centerline kept), paint-order dilation
           * above ×1 (the solid grows around its own contour). */
          report.solidFillLeaves++;
          report.thinSupportedLeaves++;
          report.rootWidth = Math.max(report.rootWidth, outline.representative * elScale);
        } else {
          /* measured, but nothing adjustable at all (open / degenerate
           * subpaths only) — honestly unmeasurable, kept native. */
          report.unmeasurableLeaves++;
        }
      } else {
        report.unmeasurableLeaves++;
      }
    }
  }
  const nextState: MeasureState = {
    stroke: strokeVal,
    widthRaw,
    fill: fillVal,
    frEvenOdd,
    inDefs: state.inDefs || tag === "defs" || tag === "symbol",
    scale: elScale,
    pctRef: state.pctRef,
  };
  for (const child of Array.from(el.children)) {
    walkMeasure(child, nextState, cssMap, tol, report);
  }
}

const nativeCache = new Map<string, NativeStrokeReport>();

const EMPTY_REPORT: Readonly<NativeStrokeReport> = Object.freeze({
  rootWidth: 0,
  strokedLeaves: 0,
  fillOutlineLeaves: 0,
  thinSupportedLeaves: 0,
  solidFillLeaves: 0,
  unmeasurableLeaves: 0,
});

/**
 * Analyze a FULL icon SVG source ("<svg …>…</svg>") and measure its NATIVE
 * stroke weight — the SAME classification + transform rules the adjustment
 * engine uses (single source of truth: any element this walk measures is
 * an element adjustIconStrokes adjusts). Pure, cached by content hash,
 * deterministic (the same icon always measures the same), never mutates
 * the source, never emits geometry. Stroked leaves measure their declared
 * width (attr / inline style / CSS / inherited / currentColor, SVG default
 * 1) in root units; fill-based outline leaves measure their own thickness
 * T̂ = 2·A/P (exact for bars and rings). The representative rootWidth is
 * the widest measured weight — the icon's dominant look.
 */
export function analyzeNativeStroke(source: string): NativeStrokeReport {
  if (!source) return EMPTY_REPORT;
  const hash = hashSvgContent(source);
  const cached = cacheGet(nativeCache, hash);
  if (cached) return cached;
  let report: NativeStrokeReport = EMPTY_REPORT;
  if (hasDomApis()) {
    const parsed = parseIcon(source);
    if (parsed) {
      const innerHash = hashSvgContent(parsed.inner);
      const root = acquireRoot(parsed.inner, innerHash);
      if (root) {
        try {
          const cssMap = collectCssMap(root);
          const viewBoxSize = Math.max(parsed.viewBox[2], parsed.viewBox[3]) || 24;
          /* IDENTICAL tolerance formula to adjustIconStrokes so the
           * measured bands always match what the adjustment will
           * compute for the same element. */
          const tol = Math.min(0.25, Math.max(0.01, viewBoxSize / 1200));
          const seed: MeasureState = {
            stroke: parsed.rootStyle.stroke,
            widthRaw: parsed.rootStyle["stroke-width"],
            fill: parsed.rootStyle.fill,
            frEvenOdd: (parsed.rootStyle["fill-rule"] ?? "").trim().toLowerCase() === "evenodd",
            inDefs: false,
            scale: 1,
            pctRef: viewBoxDiagonal(parsed.viewBox[2], parsed.viewBox[3]),
          };
          report = {
            rootWidth: 0,
            strokedLeaves: 0,
            fillOutlineLeaves: 0,
            thinSupportedLeaves: 0,
            solidFillLeaves: 0,
            unmeasurableLeaves: 0,
          };
          for (const child of Array.from(root.children)) {
            walkMeasure(child, seed, cssMap, tol, report);
          }
        } catch {
          report = EMPTY_REPORT;
        }
      }
    }
  }
  cachePut(nativeCache, hash, report);
  return report;
}

/* ------------------------------------------------------------------ */
/* Per-icon adjustment plan (renderer + status share ONE computation)   */
/* ------------------------------------------------------------------ */

/** What ONE icon embed will actually receive, derived from the SAME
 *  per-icon analysis + design state the renderer applies — so the status
 *  UI and the SVG output can never disagree. */
export interface StrokeAdjustmentPlan {
  /** Multiplicative weight factor for this embed (1 = untouched).
   *  BIDIRECTIONAL: < 1 thins, > 1 thickens, both directions fully
   *  supported for true strokes AND fill-based outlines. */
  factor: number;
  /** Measured native weight in CANVAS px (0 = unmeasurable icon). */
  nativeVisualPx: number;
  /** Fill-outline leaves that stay at their native weight under THIS
   *  request — the structurally unmeasurable ones only (open /
   *  degenerate subpaths, unsafe structure, or an existing mask that
   *  must not be overwritten): measured bands AND solids adjust in
   *  both directions. */
  limitedFillLeaves: number;
  /** Fill-outline leaves that DO thin at factor < 1 (erosion mask —
   *  bands AND solids, one single thinner line per mark). */
  thinnedFillLeaves: number;
  /** Leaves that will actually change (stroked leaves always multiply;
   *  measured fill-outline leaves adjust in both directions). */
  adjustedLeaves: number;
}

/** THE per-icon factor computation — the single source of truth shared by
 *  the sheet renderer (embedIcon), the panel previews and the diagnostics
 *  tool. Pure function of (icon analysis, embed geometry, design); legacy
 *  designs map onto the same math exactly as the renderer does. MUTUALLY
 *  EXCLUSIVE CONTROLS — exactly ONE stroke system can affect a rendering
 *  at a time (the renderer-level guarantee the UI mirrors by disabling the
 *  weight control while uniform is ON):
 *
 *  Uniform path (uniform ON — the ONLY active system):
 *      factor = targetPx / nativeVisualPx
 *  The target is an ABSOLUTE target: the required per-icon correction is
 *  target − native (Icon A native 1 → +4 at target 5; Icon B native 8 →
 *  −3), NEVER target + native and NEVER one shared adjustment. The stored
 *  weight delta is deliberately NOT composed into the target (the old
 *  `target + delta` hidden composition produced exactly the "the target
 *  looks additive / over-bold" regression: weight +8 with target 5 silently
 *  rendered 13 px). The value stays STORED (preserved for when uniform is
 *  switched back OFF) but is never read on this path.
 *
 *  Weight path (uniform OFF):
 *      factor = clamp(1 + deltaPx / nativeVisualPx, 0.25, 4)
 *
 *  Legacy %    : factor = strokeWeightFactor (dormant look preservation)
 *  Unmeasurable icons keep factor 1 (never faked).
 *
 *  The `uniformOn` derivation is the ONE shared helper the UI checkbox
 *  uses (effectiveUniformStroke) — the engine can never pick the weight
 *  branch while the UI shows Uniform ON (the old inline derivation
 *  disagreed for hybrid legacy records: strokeWeightPx present +
 *  strokeMode "normalize" + uniformStroke absent). */
export function computeStrokeAdjustment(
  native: NativeStrokeReport,
  viewBoxMaxDim: number,
  boxSize: number,
  iconStyle: SheetDesign["icon"]
): StrokeAdjustmentPlan {
  const uniformOn = effectiveUniformStroke(iconStyle);
  /* dormant % path — only for pre-px records with no uniform state */
  const legacyPct =
    iconStyle.strokeWeightPx == null && iconStyle.uniformStroke == null && !uniformOn;

  let factor = 1;
  let nativeVisualPx = 0;
  if (legacyPct) {
    factor = strokeWeightFactor(iconStyle);
  } else {
    /* The native visual width is reported for EVERY measurable icon —
     * including "no active request" states — so the status UI and the
     * diagnostics table can never mislabel a measurable icon as
     * "unmeasurable" merely because nothing was requested (the old
     * weight-path guard skipped the computation at delta 0). */
    const measurable = native.rootWidth > 0 && Number.isFinite(native.rootWidth);
    if (measurable) {
      const embedScale = boxSize / Math.max(viewBoxMaxDim, 1e-6); // root → canvas units
      nativeVisualPx = native.rootWidth * Math.max(embedScale, 1e-6);
    }
    if (uniformOn) {
      if (measurable) {
        /* ABSOLUTE target — mutual exclusion: the weight delta is NEVER
         * composed into the target (uniform ON ⇒ uniform alone controls
         * the result; the stored weight is preserved but ignored).
         * effectiveUniformTargetPx already clamps to ≥ 0.5 px. */
        const targetPx = effectiveUniformTargetPx(iconStyle);
        const f = targetPx / Math.max(nativeVisualPx, 1e-6);
        if (Number.isFinite(f) && f > 0) factor = f;
      }
    } else {
      const deltaPx = effectiveStrokeWeightPx(iconStyle);
      if (deltaPx !== 0 && measurable) {
        const f = 1 + deltaPx / Math.max(nativeVisualPx, 1e-6);
        if (Number.isFinite(f)) {
          factor = Math.min(STROKE_WEIGHT_FACTOR_MAX, Math.max(STROKE_WEIGHT_FACTOR_MIN, f));
        }
      }
    }
  }

  /* DIRECTION-SYMMETRIC honest limits: measured fill leaves (bands AND
   *  solids) adjust in BOTH directions — erosion thinning below ×1,
   *  paint-order dilation above ×1 — so the only leaves that keep their
   *  native weight under ANY active request are the structurally
   *  unmeasurable ones (open / degenerate subpaths, unsafe structure). */
  const limitedFillLeaves = factor !== 1 ? native.unmeasurableLeaves : 0;
  const thinnedFillLeaves = factor < 1 ? native.thinSupportedLeaves : 0;
  const adjustedLeaves =
    factor === 1 ? 0 : native.strokedLeaves + native.thinSupportedLeaves;
  return { factor, nativeVisualPx, limitedFillLeaves, thinnedFillLeaves, adjustedLeaves };
}

/** Whether ANY stroke system currently requests an adjustment for this
 *  style — the ONE shared branch derivation the renderer and the panel
 *  previews gate their computeStrokeAdjustment call on (previously each
 *  consumer re-derived uniformOn/legacyPct/deltaPx inline — three copies
 *  that could drift; now there is exactly one next to the engine it
 *  guards). Pure; covers all three eras:
 *   · current px model — uniform ON, or a non-zero weight delta
 *   · dormant % model — a legacy multiplicative factor ≠ 1
 *  · anything else   — false (factor 1, byte-exact original) */
export function strokeRequestActive(iconStyle: SheetDesign["icon"]): boolean {
  const uniformOn = effectiveUniformStroke(iconStyle);
  const legacyPct =
    iconStyle.strokeWeightPx == null && iconStyle.uniformStroke == null && !uniformOn;
  if (legacyPct) return strokeWeightFactor(iconStyle) !== 1;
  return uniformOn || effectiveStrokeWeightPx(iconStyle) !== 0;
}

/**
 * Recolor an icon fragment to a single color (rendered copy only) —
 * strokes AND fills, including CSS-declared and *default* black fills
 * (fill-based icon packs finally tint correctly). url() paints and
 * fill="none" outlines are respected.
 */
export function tintIconArtwork(
  inner: string,
  rootStyle: Record<string, string>,
  color: string
): string {
  const hash = hashSvgContent(inner);
  const cacheKey = `${hash}|${rootStyleFingerprint(rootStyle)}|${color.toLowerCase()}`;
  const cached = cacheGet(tintCache, cacheKey);
  if (cached !== undefined) return cached;

  let result: string;
  const root = hasDomApis() ? acquireRoot(inner, hash) : null;
  if (root) {
    try {
      const cssMap = collectCssMap(root);
      /* pctRef is irrelevant to tinting (widths are never resolved here) —
       * a neutral reference keeps the shared seed signature. */
      const seed = seedFromRootStyle(rootStyle, 24);
      for (const child of Array.from(root.children)) {
        walkTint(child, seed, cssMap, color);
      }
      result = serializeFragment(root);
    } catch {
      result = tintRegex(inner, color);
    }
  } else {
    result = tintRegex(inner, color);
  }
  cachePut(tintCache, cacheKey, result);
  return result;
}
