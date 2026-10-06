/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 1) · SVG import.
 *
 * Decorative vector artwork enters the builder through here. The import
 * is VECTOR-PRESERVING:
 *   · geometry, viewBox, fills, strokes, groups, transforms and opacity
 *     ride through untouched (path data is never rewritten);
 *   · the sanitized ORIGINAL MARKUP is stored on the element so a later
 *     renderer/export can reproduce the artwork byte-faithfully;
 *   · rendering nests a real <svg viewBox> inside the element group, so
 *     scaling the element never touches the source geometry.
 *
 * Safety: scripts, event handlers, javascript: URLs and foreignObject
 * are stripped before the markup is ever stored or rendered.
 */

import { SVG_SOURCE_MAX_BYTES } from "./types";

export interface ImportedSvg {
  /** sanitized outer SVG markup (starts with <svg …>) */
  svg: string;
  viewBox: string;
  /** intrinsic size in source units (viewBox or width/height attrs) */
  sourceWidth: number;
  sourceHeight: number;
  warnings: string[];
}

/** Strip active-content nodes/attrs — keep everything visual. */
function sanitizeRoot(root: SVGSVGElement, warnings: string[]): void {
  const kill = [...root.querySelectorAll("script, foreignObject, iframe, object, embed")];
  if (kill.length) warnings.push(`removed ${kill.length} disallowed node(s) (script/foreignObject/…)`);
  kill.forEach((n) => n.remove());

  let strippedAttrs = 0;
  let strippedUrls = 0;
  const walk = (el: Element): void => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        strippedAttrs++;
      } else if ((name === "href" || name === "xlink:href") && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
        strippedUrls++;
      }
    }
    for (const child of [...el.children]) walk(child);
  };
  walk(root);
  if (strippedAttrs) warnings.push(`removed ${strippedAttrs} event-handler attribute(s)`);
  if (strippedUrls) warnings.push(`removed ${strippedUrls} javascript: URL(s)`);
}

function parseSize(value: string | null): number | null {
  if (!value) return null;
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseViewBoxDims(viewBox: string): { w: number; h: number } | null {
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [, , w, h] = parts;
  if (w > 0 && h > 0) return { w, h };
  return null;
}

/**
 * Import an SVG file. Throws Error with a USER-READABLE message on
 * failure — callers surface it, never a raw stack trace.
 */
export async function importSvgFile(file: File): Promise<ImportedSvg> {
  if (file.size > SVG_SOURCE_MAX_BYTES) {
    throw new Error(`"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB — the limit is 2 MB.`);
  }
  if (file.type && file.type !== "image/svg+xml" && !/\.svg$/i.test(file.name)) {
    throw new Error(`"${file.name}" is not an SVG file.`);
  }

  const text = await file.text();
  return importSvgText(text, file.name);
}

export function importSvgText(text: string, fileName = "SVG"): ImportedSvg {
  const warnings: string[] = [];
  if (!text || !text.trim()) throw new Error(`"${fileName}" is empty.`);
  if (text.length > SVG_SOURCE_MAX_BYTES) {
    throw new Error(`"${fileName}" is larger than the 2 MB source limit.`);
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, "image/svg+xml");
  } catch {
    throw new Error(`"${fileName}" could not be parsed as SVG.`);
  }
  if (doc.querySelector("parsererror")) {
    throw new Error(`"${fileName}" contains invalid SVG markup.`);
  }
  const root = doc.documentElement as unknown as SVGSVGElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") {
    throw new Error(`"${fileName}" does not contain an <svg> root element.`);
  }

  sanitizeRoot(root, warnings);

  /* intrinsic size: viewBox wins; else width/height attrs; else 300×300 */
  let viewBox = root.getAttribute("viewBox")?.trim() ?? "";
  let dims = viewBox ? parseViewBoxDims(viewBox) : null;
  if (!dims) {
    const w = parseSize(root.getAttribute("width"));
    const h = parseSize(root.getAttribute("height"));
    if (w && h) {
      dims = { w, h };
      if (!viewBox) {
        viewBox = `0 0 ${w} ${h}`;
        warnings.push(`added viewBox "0 0 ${w} ${h}" (source used width/height)`);
      }
    }
  }
  if (!dims) {
    dims = { w: 300, h: 300 };
    if (!viewBox) viewBox = "0 0 300 300";
    warnings.push('no viewBox or size found — defaulted to "0 0 300 300"');
  }

  /* normalize the outer tag: explicit width/height + viewBox so the
     nested renderer can scale cleanly; everything INSIDE is untouched */
  root.setAttribute("width", String(dims.w));
  root.setAttribute("height", String(dims.h));
  if (!root.getAttribute("viewBox")) root.setAttribute("viewBox", viewBox);
  root.removeAttribute("id");

  const svg = new XMLSerializer().serializeToString(root);
  return {
    svg,
    viewBox,
    sourceWidth: dims.w,
    sourceHeight: dims.h,
    warnings,
  };
}
