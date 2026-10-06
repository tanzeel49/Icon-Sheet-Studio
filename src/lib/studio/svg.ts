/**
 * ICON SHEET STUDIO — SVG utilities.
 * All transformations happen on *rendered copies*. The original sourceSvg
 * stored in the library is never modified (stroke safety guarantee).
 */

export interface ParsedIcon {
  /** viewBox of the source svg: [x, y, w, h] */
  viewBox: [number, number, number, number];
  /** inner markup (children of <svg>) */
  inner: string;
  width: number;
  height: number;
  /** presentation attributes declared on the ROOT <svg> tag — these must be
   *  re-applied to the embedding wrapper or stroked icons lose their look. */
  rootStyle: Record<string, string>;
}

const SVG_TAG = /<svg\b[^>]*>/i;
const CLOSE_TAG = /<\/svg\s*>/i;

/* ---- shared memoization (large-library render performance) ----------
 * parseIcon + hashSvgContent are called PER EMBED PER RENDER (sheet
 * preview, edit mode, overview thumbs, export) — memoizing them by source
 * string identity makes every call after the first an O(1) map lookup.
 * The stored objects are treated as IMMUTABLE by every caller (the
 * renderer copies rootStyle before mutating it), so sharing is safe.
 * Capped + FIFO-evicted to bound memory on huge libraries. */
const MEMO_CAP = 4000;
const parseMemo = new Map<string, ParsedIcon | null>();
const hashMemo = new Map<string, string>();

function memoPut<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.size >= MEMO_CAP) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Quick validation that a string looks like a parsable SVG document. */
export function isValidSvg(source: string): boolean {
  if (!source || source.length < 10) return false;
  const open = source.match(SVG_TAG);
  if (!open) return false;
  if (!CLOSE_TAG.test(source)) return false;
  // Reject fragments that contain script or external references
  if (/<script\b/i.test(source)) return false;
  return true;
}

/** Parse an icon SVG into viewBox + inner content. Never mutates source.
 *  Memoized by source identity — the returned object is SHARED and must
 *  be treated as read-only by callers (copy before mutating). */
export function parseIcon(source: string): ParsedIcon | null {
  const cached = parseMemo.get(source);
  if (cached !== undefined) return cached;
  const parsed = parseIconUncached(source);
  memoPut(parseMemo, source, parsed);
  return parsed;
}

function parseIconUncached(source: string): ParsedIcon | null {
  const open = source.match(SVG_TAG);
  if (!open) return null;
  const openTag = open[0];
  const startIdx = (open.index ?? 0) + openTag.length;
  const endIdx = source.lastIndexOf("</svg");
  if (endIdx < startIdx) return null;
  let inner = source.slice(startIdx, endIdx);

  let vb: [number, number, number, number] | null = null;
  const vbMatch = openTag.match(/viewBox\s*=\s*["']\s*([-\d.]+)[ ,]+([-\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)\s*["']/i);
  if (vbMatch) {
    vb = [Number(vbMatch[1]), Number(vbMatch[2]), Number(vbMatch[3]), Number(vbMatch[4])];
  }

  let w = 0;
  let h = 0;
  const wMatch = openTag.match(/width\s*=\s*["']([\d.]+)\s*(?:px)?["']/i);
  const hMatch = openTag.match(/height\s*=\s*["']([\d.]+)\s*(?:px)?["']/i);
  if (wMatch) w = Number(wMatch[1]);
  if (hMatch) h = Number(hMatch[1]);

  if (!vb) {
    if (w > 0 && h > 0) vb = [0, 0, w, h];
    else vb = [0, 0, 24, 24];
  }
  if (w <= 0) w = vb[2];
  if (h <= 0) h = vb[3];

  // Strip comments & xml declarations from inner content
  inner = inner.replace(/<!--[\s\S]*?-->/g, "");

  return { viewBox: vb, inner, width: w, height: h, rootStyle: extractRootStyle(openTag) };
}

/** Presentation attributes that define an icon's look when declared on root. */
const ROOT_ATTR_WHITELIST = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "fill-opacity",
  "fill-rule",
  "clip-rule",
  "color",
  "opacity",
  "paint-order",
] as const;

/** Pull whitelisted presentation attrs (plus inline style) off the root tag. */
export function extractRootStyle(openTag: string): Record<string, string> {
  const style: Record<string, string> = {};
  for (const attr of ROOT_ATTR_WHITELIST) {
    const m = openTag.match(new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "i"));
    if (m && m[1] !== "") style[attr] = m[1];
  }
  const styleMatch = openTag.match(/style\s*=\s*["']([^"']*)["']/i);
  if (styleMatch) {
    for (const decl of styleMatch[1].split(";")) {
      const idx = decl.indexOf(":");
      if (idx < 0) continue;
      const key = decl.slice(0, idx).trim().toLowerCase();
      const val = decl.slice(idx + 1).trim();
      if ((ROOT_ATTR_WHITELIST as readonly string[]).includes(key) && val) style[key] = val;
    }
  }
  return style;
}

/**
 * Namespace all ids inside an icon fragment so multiple icons can coexist
 * in one sheet SVG without id collisions (defs, gradients, clipPaths...).
 */
export function namespaceIds(inner: string, prefix: string): string {
  const referencedIds = new Set<string>();
  // collect ids
  const idRe = /\bid\s*=\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(inner)) !== null) referencedIds.add(m[1]);
  if (referencedIds.size === 0) return inner;

  // Replace url(#id), url('#id'), url("#id"), href="#id", xlink:href="#id"
  let out = inner;
  for (const id of referencedIds) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`url\\(\\s*["']?#${escaped}["']?\\s*\\)`, "g"), `url(#${prefix}${id})`);
    out = out.replace(new RegExp(`(href|xlink:href)\\s*=\\s*["']#${escaped}["']`, "g"), `$1="#${prefix}${id}"`);
    out = out.replace(new RegExp(`(fill|stroke|clip-path|mask|filter|marker-end|marker-start|marker-mid)\\s*=\\s*["']#${escaped}["']`, "g"), `$1="#${prefix}${id}"`);
  }
  // Replace the id declarations themselves
  out = out.replace(idRe, (full, id) => `id="${prefix}${id}"`);
  return out;
}

/**
 * Monochrome tint — recolor strokes/fills on a rendered copy only.
 *
 * (Historical note: the old percentage-based `normalizeStrokeWidths` regex
 * engine was removed — normalize-to-target now flows through the single
 * non-destructive factor engine in icon-style.ts, which measures every
 * icon individually via analyzeNativeStroke. No competing stroke
 * normalization implementations exist.)
 */
export function applyTint(inner: string, color: string): string {
  let out = inner;
  out = out.replace(/stroke\s*=\s*["'](?!none)([^"']*)["']/gi, `stroke="${color}"`);
  out = out.replace(/fill\s*=\s*["'](?!none)([^"']*)["']/gi, (full, val) => {
    // skip url() references and "none"
    if (val.startsWith("url(")) return full;
    return `fill="${color}"`;
  });
  return out;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Embed human metadata as accessibility elements in an SVG document
 * (round 15). Inserts `<title>` and `<desc>` as the FIRST children of the
 * root <svg> tag — the position screen readers and the SVG spec favor —
 * without touching anything else in the source. Existing <title>/<desc>
 * children are left alone (this only runs for library entries, whose
 * immutable sources never carry them; a defensive check keeps it a no-op
 * if one ever does). Returns the ORIGINAL string when there is nothing
 * to embed or the insertion point cannot be found.
 */
export function embedSvgMetadata(
  source: string,
  title?: string,
  description?: string
): string {
  const t = title?.trim();
  const d = description?.trim();
  if (!t && !d) return source;
  const svgOpen = source.indexOf("<svg");
  if (svgOpen === -1) return source;
  /* find the '>' that closes the root open tag, skipping quoted attribute
   * values (a '>' inside title="a > b" is legal XML); a second '<' before
   * it means malformed markup — bail out untouched */
  let quote: string | null = null;
  let i = svgOpen;
  while (i < source.length) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      break;
    } else if (c === "<" && i > svgOpen) {
      return source;
    }
    i++;
  }
  if (i >= source.length) return source;
  if (source[i - 1] === "/") return source; // self-closing <svg/> — nothing inside
  const inner = source.slice(i + 1, i + 61).replace(/\s+/g, " ");
  if (/<\s*(title|desc)\b/i.test(inner)) return source; // already documented
  const nodes =
    (t ? `<title>${escapeXml(t)}</title>` : "") +
    (d ? `<desc>${escapeXml(d)}</desc>` : "");
  return source.slice(0, i + 1) + nodes + source.slice(i + 1);
}

/** Generate a stable id (no external deps). */
let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * FNV-1a 32-bit hash of normalized SVG content (whitespace-collapsed) for
 * duplicate detection. Length is folded in to reduce collision odds across
 * huge libraries. Fast and dependency-free — not cryptographic. Memoized
 * by source identity (the same icon is hashed several times per render).
 */
export function hashSvgContent(source: string): string {
  const cached = hashMemo.get(source);
  if (cached !== undefined) return cached;
  const normalized = source.replace(/\s+/g, " ").trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const out = `${(h >>> 0).toString(36)}-${normalized.length.toString(36)}`;
  memoPut(hashMemo, source, out);
  return out;
}
