"use client";

/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 2) · publish compiler.
 *
 * THE bridge between the authoring model and the template registry:
 *
 *   BuilderDocument (authoritative structured state)
 *          ↓  compileBuilderDocument()
 *   CustomTemplateRecord partial
 *          ↓  importCustomTemplate / updateCustomTemplateRecord
 *   Template Registry (setCustomTemplateRegistry → buildCustomTemplate)
 *          ↓  the ONE universal renderer (renderSheet → renderCustomSheet)
 *   Builder Preview · Studio sheets · SVG/PNG export
 *
 * The flattening rules:
 *   · The ARTBOARD background becomes the first artwork rect — emitted with
 *     the exact attribute order x,y,width,height,fill so the existing
 *     transparent-export stripper (export.ts stripBackgroundRect) keeps
 *     working. It carries data-iss-role="background" so the Properties
 *     panel can recolor it later (markers are stripped at render time).
 *   · One icon-grid element → cells generated MATHMATICALLY (gridCellRects).
 *     The first `iconCount` cells (reading order) become the icon slots;
 *     positions beyond that are "empty" (card kept, no icon) or "hidden"
 *     (not emitted) per the grid's unusedCells mode. Rows × columns are
 *     never silently rewritten.
 *   · Mapped text elements (roles category / volume / descriptor) are
 *     emitted with GLOBAL numeric x/y attributes — the live-text and
 *     auto-fit engines (custom-template.ts setFittedTextLines) require
 *     numeric anchors, so mapped text never sits inside a transform group.
 *     Rotation is applied via the text element's own transform attribute.
 *   · Every other element renders exactly like the builder canvas renders
 *     it (element-view.tsx) minus editor-only chrome: no hero placeholder
 *     dashes, no hit-testing twins, no unused-cell markers. EDITOR GUIDES
 *     NEVER LEAK into the published template.
 *   · `editableSvg` = artwork WITH data-iss markers; `sourceSvg` = the same
 *     artwork with markers stripped (verbatim visual master).
 *   · The full BuilderDocument is embedded in the record so "Edit in
 *     Builder" reconstructs the authoring state EXACTLY — never
 *     reverse-engineered from the rendered SVG.
 */

import { escapeXml, isValidSvg } from "@/lib/studio/svg";
import type {
  CustomCellPaint,
  CustomTemplateMetadata,
  CustomTemplateRecord,
  CustomTemplateRoles,
  CustomTextStyleCapture,
  CustomTextRole,
  Rect,
  TemplateGrid,
} from "@/lib/studio/types";
import {
  TEMPLATE_ARTWORK_MAX_BYTES,
  getGridProps,
  getShapeProps,
  getSvgProps,
  getTextProps,
  type BuilderDocument,
  type BuilderElement,
  type BuilderRole,
} from "./types";
import { computeGridMetrics, elementBBox, gridCellRects } from "./geometry";
import { validateDocument, type ValidationIssue } from "./validation";
import { fitBuilderText } from "./text-fit";

/* ------------------------------------------------------------------ */
/* Public result                                                       */
/* ------------------------------------------------------------------ */

export interface CompileResult {
  ok: boolean;
  /** blocking problems — the template must NOT be saved while non-empty */
  errors: ValidationIssue[];
  /** advisory problems — saving is allowed, the user was informed */
  warnings: ValidationIssue[];
  /** present only when ok — hand to importCustomTemplate / updateCustomTemplateRecord */
  record?: Omit<CustomTemplateRecord, "id" | "createdAt">;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** 2-decimal trim — kills FP noise without visible snapping. */
const r2 = (n: number): number => Math.round(n * 100) / 100;
const fmt = (n: number): string => String(r2(n));

/** Builder role → studio text-editing role (descriptor behaves as caption;
 *  icon-count becomes the live "30 ICONS" counter filled per sheet). */
const TEXT_ROLE_MAP: Partial<Record<BuilderRole, CustomTextRole>> = {
  category: "category",
  "icon-count": "count",
  volume: "volume",
  descriptor: "caption",
};

/** Inner markup of a stored outer <svg> — cached (parse once per source). */
const innerCache = new Map<string, string>();
function svgInnerContent(outer: string): string {
  const cached = innerCache.get(outer);
  if (cached !== undefined) return cached;
  let inner = "";
  try {
    const parsed = new DOMParser().parseFromString(outer, "image/svg+xml");
    const root = parsed.documentElement;
    if (root && root.nodeName.toLowerCase() === "svg") inner = root.innerHTML;
  } catch {
    inner = "";
  }
  if (innerCache.size > 60) innerCache.clear();
  innerCache.set(outer, inner);
  return inner;
}

function polygonPoints(w: number, h: number, sides: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2;
  const pts: string[] = [];
  const n = Math.max(3, Math.round(sides));
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pts.push(`${r2(cx + r * Math.cos(a))},${r2(cy + r * Math.sin(a))}`);
  }
  return pts.join(" ");
}

/* ------------------------------------------------------------------ */
/* Element flattening                                                  */
/* ------------------------------------------------------------------ */

/** Wrap artwork in the standard positioned group (rotation around center). */
function positionGroup(el: BuilderElement, inner: string): string {
  const transform =
    el.rotation !== 0
      ? `translate(${fmt(el.x)} ${fmt(el.y)}) rotate(${fmt(el.rotation)} ${fmt(el.width / 2)} ${fmt(el.height / 2)})`
      : `translate(${fmt(el.x)} ${fmt(el.y)})`;
  const opacity = el.opacity < 1 ? ` opacity="${r2(el.opacity)}"` : "";
  return `<g transform="${transform}"${opacity}>${inner}</g>`;
}

/** Shape artwork — mirrors element-view.tsx rendering minus editor chrome. */
function shapeInner(el: BuilderElement): string {
  const p = getShapeProps(el);
  if (!p) return "";
  const w = el.width;
  const h = el.height;
  const strokeAttrs =
    p.stroke && p.stroke !== "none" && (p.strokeWidth ?? 0) > 0
      ? ` stroke="${escapeXml(p.stroke)}" stroke-width="${fmt(p.strokeWidth)}"`
      : "";
  switch (el.type) {
    case "rectangle":
      return `<rect x="0" y="0" width="${fmt(w)}" height="${fmt(h)}" fill="${escapeXml(p.fill)}"${strokeAttrs}/>`;
    case "rounded-rectangle":
      return `<rect x="0" y="0" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(Math.min(p.cornerRadius, Math.min(w, h) / 2))}" fill="${escapeXml(p.fill)}"${strokeAttrs}/>`;
    case "circle":
      return `<circle cx="${fmt(w / 2)}" cy="${fmt(h / 2)}" r="${fmt(Math.max(0, Math.min(w, h) / 2))}" fill="${escapeXml(p.fill)}"${strokeAttrs}/>`;
    case "ellipse":
      return `<ellipse cx="${fmt(w / 2)}" cy="${fmt(h / 2)}" rx="${fmt(Math.max(0, w / 2))}" ry="${fmt(Math.max(0, h / 2))}" fill="${escapeXml(p.fill)}"${strokeAttrs}/>`;
    case "line":
      return `<line x1="0" y1="0" x2="${fmt(w)}" y2="${fmt(h)}" stroke="${escapeXml(p.stroke)}" stroke-width="${fmt(Math.max(1, p.strokeWidth))}" stroke-linecap="round"/>`;
    case "polygon":
      return `<polygon points="${polygonPoints(w, h, p.sides)}" fill="${escapeXml(p.fill)}"${strokeAttrs} stroke-linejoin="round"/>`;
    default:
      return "";
  }
}

/**
 * Display content for a text element. Icon Count is DERIVED from the
 * grid's usable icon count (§5/§11 — never a stored, hardcoded string,
 * so it can never go stale when rows/columns change). Every other role
 * renders the author's own words.
 */
function textDisplayContent(el: BuilderElement, gridIconCount: number): string {
  const p = getTextProps(el);
  if (!p) return "";
  if (el.role === "icon-count") return `${gridIconCount} ICONS`;
  return p.content;
}

/**
 * Effective render size: autoFit bakes the MEASURED fitted size (largest
 * size ≤ fontSize that fits the box — §13) so the builder canvas, the
 * preview and a fresh studio sheet all agree. autoFit OFF → the exact
 * specified size.
 */
function textRenderSize(el: BuilderElement, content: string, boxW: number, boxH: number): number {
  const p = getTextProps(el);
  if (!p) return 48;
  return fitBuilderText(p, content, boxW, boxH).fontSize;
}

/**
 * Mapped text artwork. GLOBAL coordinates + numeric x/y attributes —
 * never inside a transform group (the auto-fit engine repositions via the
 * y attribute). Rotation rides on the element's own transform attribute.
 * `size`/`content` are the resolved display values (autoFit + Icon Count).
 */
function mappedTextMarkup(el: BuilderElement, role: CustomTextRole, content: string, size: number): string {
  const p = getTextProps(el);
  if (!p) return "";
  const anchorX =
    p.align === "left" ? el.x : p.align === "center" ? el.x + el.width / 2 : el.x + el.width;
  const anchor = p.align === "left" ? "start" : p.align === "center" ? "middle" : "end";
  const baseline = el.y + size * 0.8;
  const rotateAttr =
    el.rotation !== 0
      ? ` transform="rotate(${fmt(el.rotation)} ${fmt(el.x + el.width / 2)} ${fmt(el.y + el.height / 2)})"`
      : "";
  const lines = (content || " ").split("\n");
  const tspans = lines
    .map((line, i) => {
      const text = line === "" ? " " : line;
      const pos =
        i === 0
          ? ` x="${fmt(anchorX)}" y="${fmt(baseline)}"`
          : ` x="${fmt(anchorX)}" dy="${fmt(size * p.lineHeight)}"`;
      return `<tspan${pos}>${escapeXml(text)}</tspan>`;
    })
    .join("");
  return (
    `<text x="${fmt(anchorX)}" y="${fmt(baseline)}"${rotateAttr} fill="${escapeXml(p.color)}" ` +
    `font-family="${escapeXml(p.fontFamily)}" font-size="${fmt(size)}" font-weight="${fmt(p.fontWeight)}" ` +
    (p.letterSpacing !== 0 ? `letter-spacing="${fmt(p.letterSpacing)}" ` : "") +
    `text-anchor="${anchor}" data-iss-role="text" data-iss-text-role="${role}">${tspans}</text>`
  );
}

/** Static (unmapped) text artwork — same geometry rules, no markers. */
function staticTextMarkup(el: BuilderElement, content: string, size: number): string {
  const p = getTextProps(el);
  if (!p) return "";
  const anchorX =
    p.align === "left" ? el.x : p.align === "center" ? el.x + el.width / 2 : el.x + el.width;
  const anchor = p.align === "left" ? "start" : p.align === "center" ? "middle" : "end";
  const baseline = el.y + size * 0.8;
  const lines = (content || " ").split("\n");
  const tspans = lines
    .map((line, i) => {
      const text = line === "" ? " " : line;
      const pos =
        i === 0
          ? ` x="${fmt(anchorX)}" y="${fmt(baseline)}"`
          : ` x="${fmt(anchorX)}" dy="${fmt(size * p.lineHeight)}"`;
      return `<tspan${pos}>${escapeXml(text)}</tspan>`;
    })
    .join("");
  return (
    `<g transform="translate(${fmt(el.x)} ${fmt(el.y)})${el.rotation !== 0 ? ` rotate(${fmt(el.rotation)} ${fmt(el.width / 2)} ${fmt(el.height / 2)})` : ""}"${el.opacity < 1 ? ` opacity="${r2(el.opacity)}"` : ""}>` +
    `<text x="${fmt(anchorX - el.x)}" y="${fmt(baseline - el.y)}" fill="${escapeXml(p.color)}" ` +
    `font-family="${escapeXml(p.fontFamily)}" font-size="${fmt(size)}" font-weight="${fmt(p.fontWeight)}" ` +
    (p.letterSpacing !== 0 ? `letter-spacing="${fmt(p.letterSpacing)}" ` : "") +
    `text-anchor="${anchor}">${tspans}</text></g>`
  );
}

/* ------------------------------------------------------------------ */
/* THE compiler                                                        */
/* ------------------------------------------------------------------ */

export function compileBuilderDocument(doc: BuilderDocument): CompileResult {
  const issues = validateDocument(doc);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const pushError = (message: string): void => {
    errors.push({ level: "error", message });
  };
  const pushWarning = (message: string): void => {
    warnings.push({ level: "warning", message });
  };

  /* ---- structural picks ------------------------------------------- */
  const gridCandidates = doc.elements.filter((el) => el.type === "icon-grid");
  const gridEl = gridCandidates[0] ?? null;
  const gridProps = gridEl ? getGridProps(gridEl) : null;
  if (!gridEl || !gridProps) {
    pushError("A template needs exactly one icon grid element before it can be saved.");
    return { ok: false, errors, warnings };
  }
  /* validateDocument already errored on: multiple grids, grid rotation,
   * invalid icon count, multiple heroes, non-fitting geometry, … — those
   * errors block the compile; warnings pass through to the record. */
  if (errors.length > 0) return { ok: false, errors, warnings };
  const metrics = computeGridMetrics(gridEl);
  if (!metrics.fits || !metrics.renderable) {
    pushError("The icon grid does not fit its area — reduce spacing or padding, change rows/columns, or enlarge the grid before saving.");
    return { ok: false, errors, warnings };
  }

  const capacity = gridProps.rows * gridProps.columns;
  const iconCount = Math.min(Math.max(1, Math.round(gridProps.iconCount || capacity)), capacity);

  if (!gridEl.visible)
    pushWarning(
      "The icon grid layer is hidden — published sheets still place icons at its slots, but no cell cards are drawn."
    );

  /* ---- hero (0 or 1, visible only) ---------------------------------- */
  const heroCandidates = doc.elements.filter((el) => el.role === "hero");
  const heroEl = heroCandidates.find((el) => el.visible) ?? null;
  if (heroCandidates.some((el) => !el.visible))
    pushWarning("A hidden hero element is not part of the published template — no hero icon will be placed.");
  if (heroEl && Math.abs(heroEl.rotation) > 1e-6)
    pushWarning("Hero rotation rotates the hero artwork only — the hero icon itself stays upright (centered on the rotated area).");
  /* P5 fitting fix: the slot is the hero element's ROTATED axis-aligned
   * bounding box — the icon now lands centered over the artwork the user
   * actually sees. The old raw x/y/w/h slot ignored rotation, so a rotated
   * hero background published rotated ARTWORK with an UNrotated slot and
   * the hero icon rendered visibly off-center from its card. */
  const heroSlot: Rect | null = heroEl
    ? (() => {
        const b = elementBBox(heroEl);
        return { x: r2(b.x), y: r2(b.y), width: r2(b.width), height: r2(b.height) };
      })()
    : null;

  /* ---- text role mapping (first element per role wins) -------------- */
  const textRoleOf = new Map<string, CustomTextRole>();
  const seenRoles = new Set<CustomTextRole>();
  let mappedTextCount = 0;
  for (const el of doc.elements) {
    if (el.type !== "text" || !el.visible) continue;
    const mapped = TEXT_ROLE_MAP[el.role];
    if (!mapped) continue;
    if (seenRoles.has(mapped)) {
      /* duplicate-role warnings come from validateDocument (single source) */
      continue;
    }
    seenRoles.add(mapped);
    textRoleOf.set(el.id, mapped);
    mappedTextCount++;
  }

  /* ---- icon slots (absolute artboard coordinates) ------------------- */
  const localCells = gridCellRects(gridEl);
  const slots: Rect[] = [];
  for (let i = 0; i < iconCount && i < localCells.length; i++) {
    const c = localCells[i];
    slots.push({ x: r2(gridEl.x + c.x), y: r2(gridEl.y + c.y), width: r2(c.w), height: r2(c.h) });
  }

  /* ---- artwork (marked = editableSvg; clean = sourceSvg) ------------- */
  const W = r2(doc.artboard.width);
  const H = r2(doc.artboard.height);
  const parts: string[] = [];
  /* background first — attr order matters for stripBackgroundRect */
  parts.push(
    `<rect x="0" y="0" width="${fmt(W)}" height="${fmt(H)}" fill="${escapeXml(doc.artboard.background)}" data-iss-role="background"/>`
  );

  for (const el of doc.elements) {
    if (el.type === "background") continue; // the artboard rect already covers it
    if (!el.visible) continue; // hidden elements are not part of the template
    /* (locked is an EDITOR concept — locked artwork still publishes) */
    if (el.type === "icon-grid") {
      /* cells: active slots carry editing markers; unused cells follow the
       * grid's unusedCells mode ("empty" keeps the card, "hidden" drops it).
       * Grid rotation was blocked by validation — plain translate only. */
      const cellParts: string[] = [];
      localCells.forEach((c, i) => {
        const active = i < iconCount;
        if (!active && gridProps.unusedCells === "hidden") return;
        const markers = active ? ` data-iss-role="cell" data-iss-cell="${i}"` : "";
        cellParts.push(
          `<rect x="${fmt(c.x)}" y="${fmt(c.y)}" width="${fmt(c.w)}" height="${fmt(c.h)}" rx="${fmt(Math.min(gridProps.cellRadius, Math.min(c.w, c.h) / 2))}" fill="${escapeXml(gridProps.cellFill)}"${markers}/>`
        );
      });
      parts.push(
        `<g transform="translate(${fmt(gridEl.x)} ${fmt(gridEl.y)})"${gridEl.opacity < 1 ? ` opacity="${r2(gridEl.opacity)}"` : ""}>${cellParts.join("")}</g>`
      );
      continue;
    }
    if (el.type === "text") {
      /* resolved display values: Icon Count placeholder derives from the
       * grid; autoFit bakes the measured fitted size (§5/§11/§13) */
      const displayContent = textDisplayContent(el, iconCount);
      const renderSize = textRenderSize(el, displayContent, el.width, el.height);
      const mapped = textRoleOf.get(el.id);
      parts.push(mapped ? mappedTextMarkup(el, mapped, displayContent, renderSize) : staticTextMarkup(el, displayContent, renderSize));
      continue;
    }
    if (el.type === "svg") {
      const p = getSvgProps(el);
      if (p && p.svg) {
        const inner = `<svg x="0" y="0" width="${fmt(el.width)}" height="${fmt(el.height)}" viewBox="${escapeXml(p.viewBox)}" overflow="visible">${svgInnerContent(p.svg)}</svg>`;
        parts.push(positionGroup(el, inner));
      }
      continue;
    }
    /* shapes (rectangle / rounded-rectangle / circle / ellipse / line / polygon) */
    const inner = shapeInner(el);
    if (inner) parts.push(positionGroup(el, inner));
  }

  const editableSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(W)} ${fmt(H)}" width="${fmt(W)}" height="${fmt(H)}">` +
    parts.join("") +
    `</svg>`;
  const sourceSvg = editableSvg.replace(/ data-iss-[a-z-]+="[^"]*"/g, "");

  if (!isValidSvg(sourceSvg) || !isValidSvg(editableSvg)) {
    pushError("The compiled template artwork is not valid SVG — check the SVG artwork elements in this document.");
    return { ok: false, errors, warnings };
  }
  if (sourceSvg.length > TEMPLATE_ARTWORK_MAX_BYTES) {
    pushError(
      `The flattened template artwork is ${(sourceSvg.length / (1024 * 1024)).toFixed(1)} MB — the limit is ${TEMPLATE_ARTWORK_MAX_BYTES / (1024 * 1024)} MB. Remove or shrink heavy SVG artwork elements.`
    );
    return { ok: false, errors, warnings };
  }

  /* ---- roles + text captures (straight from the document model —
   *        never guessed by re-analyzing the artwork) ------------------ */
  const cellPaint: Array<CustomCellPaint | null> = slots.map(() => ({
    fill: gridProps.cellFill,
    stroke: "none",
    strokeWidth: 0,
    opacity: 1,
  }));
  const text: CustomTemplateRoles["text"] = {};
  for (const el of doc.elements) {
    const mapped = textRoleOf.get(el.id);
    if (!mapped) continue;
    const p = getTextProps(el)!;
    /* the capture describes the EMITTED text: resolved content + fitted
     * size (identical values to mappedTextMarkup above) */
    const displayContent = textDisplayContent(el, iconCount);
    const renderSize = textRenderSize(el, displayContent, el.width, el.height);
    const anchorX =
      p.align === "left" ? el.x : p.align === "center" ? el.x + el.width / 2 : el.x + el.width;
    const capture: CustomTextStyleCapture = {
      role: mapped,
      content: displayContent,
      fontFamily: p.fontFamily,
      fontSize: r2(renderSize),
      fontWeight: Math.round(p.fontWeight),
      letterSpacing: r2(p.letterSpacing),
      color: p.color,
      anchor: p.align === "left" ? "start" : p.align === "center" ? "middle" : "end",
      fontStyle: "normal",
      rect: { x: r2(el.x), y: r2(el.y), width: r2(el.width), height: r2(el.height) },
      xAttr: r2(anchorX),
      yAttr: r2(el.y + renderSize * 0.8),
      /* the builder's Auto Fit choice rides on the capture — the studio's
       * live auto-fit honors it for the Category Title (other roles are
       * short counters whose fixed size is correct) */
      autoFit: p.autoFit !== false,
    };
    text[mapped] = capture;
  }
  const roles: CustomTemplateRoles = {
    backgroundFill: doc.artboard.background,
    cellPaint,
    text,
    heroSlotSize: heroSlot ? r2(Math.min(heroSlot.width, heroSlot.height)) : null,
    cellCount: slots.length,
  };

  /* ---- metadata + record -------------------------------------------- */
  const metadata: CustomTemplateMetadata = {
    autoDetected: false,
    confidence: 1,
    gridDescription: `${gridProps.rows} × ${gridProps.columns} grid`,
    notes: ["Created with the Template Builder"],
    warnings: warnings.map((w) => w.message).slice(0, 12),
    spacing: { h: r2(gridProps.horizontalGap), v: r2(gridProps.verticalGap) },
    textElements: mappedTextCount,
    background: `${fmt(W)} × ${fmt(H)}`,
    sections: 1,
  };
  const grid: TemplateGrid = {
    cols: gridProps.columns,
    rows: gridProps.rows,
    gap: r2(gridProps.horizontalGap),
  };

  const record: Omit<CustomTemplateRecord, "id" | "createdAt"> = {
    name: doc.name.trim(),
    sourceSvg,
    width: W,
    height: H,
    viewBox: `0 0 ${fmt(W)} ${fmt(H)}`,
    capacity: slots.length,
    iconSlots: slots,
    heroSlot,
    grid,
    metadata,
    editableSvg,
    roles,
    /* the structured authoring state, embedded for exact re-editing */
    builderDoc: structuredClone(doc),
  };

  return { ok: true, errors, warnings, record };
}
