/**
 * ICON SHEET STUDIO — Universal custom-template editing (v3).
 *
 * Bridges the template analyzer's detected structure to the full editing
 * system, for ANY user-imported icon-sheet SVG:
 *
 *  1. ANNOTATION  — after the import dialog confirms slots / hero / text
 *     roles, `annotateCustomSvg` marks the exact elements in a copy of the
 *     source SVG with data-iss-* role attributes (geometry untouched — only
 *     invisible markers are added) and captures their original computed
 *     styles. The annotated copy is persisted as `editableSvg`; the ORIGINAL
 *     sourceSvg is still kept verbatim and never modified.
 *
 *  2. TRANSFORM   — at render time `renderCustomArtwork` clones the cached
 *     annotated document, applies ONLY the sheet's design diffs (relative to
 *     the owning template's detected defaults) to the marked elements, and
 *     serializes the artwork. Zero diffs ⇒ byte-faithful look: the template
 *     renders exactly as uploaded until the user actually edits something.
 *
 *  3. CAPABILITIES — `resolveCustomCapabilities` tells the Properties panel
 *     which editing roles exist on a template (background / grid cells /
 *     category / volume / caption / hero slot / rail) so unsupported
 *     controls are clearly indicated instead of pretending to work.
 *
 *  4. BACKFILL    — records saved before this system get annotated at
 *     hydrate (slots + cells + background only, NO text mapping — legacy
 *     sheets keep rendering byte-identically).
 *
 * Browser-only (DOMParser/XMLSerializer); every entry point degrades
 * gracefully to the verbatim artwork when anything fails.
 */

import type {
  CustomCellPaint,
  CustomTemplateRecord,
  CustomTemplateRoles,
  CustomTextRole,
  CustomTextStyleCapture,
  Rect,
  Sheet,
  SheetDesign,
  TemplateDef,
  TextStyle,
} from "./types";
import { formatVolume } from "./types";
import { fitTitle } from "./title-fit";
import {
  measureMountedSvg,
  overlapRatio,
  parseSvgDocument,
  rgbToHex,
  type MeasuredEl,
} from "./template-analyzer";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const SVG_NS = "http://www.w3.org/2000/svg";

function round(n: number, digits = 2): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

/** ViewBox of an SVG string (from the open tag; [0 0 w h] fallback via
 *  width/height). Mirrors the analyzer's canvas parsing. */
function parseViewBox(svgText: string): [number, number, number, number] | null {
  const openTag = svgText.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const vbMatch = openTag.match(
    /viewBox\s*=\s*["']\s*([-\d.]+)[ ,]+([-\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)\s*["']/i
  );
  if (vbMatch) {
    return [Number(vbMatch[1]), Number(vbMatch[2]), Number(vbMatch[3]), Number(vbMatch[4])];
  }
  const w = openTag.match(/width\s*=\s*["']([\d.]+)\s*(?:px)?["']/i)?.[1];
  const h = openTag.match(/height\s*=\s*["']([\d.]+)\s*(?:px)?["']/i)?.[1];
  if (w && h) return [0, 0, Number(w), Number(h)];
  return null;
}

/** Canvas coverage of a rect (0..1 per axis) — background heuristic. */
function canvasCoverage(
  r: Rect,
  vb: [number, number, number, number]
): { x: number; y: number } {
  return {
    x:
      Math.max(0, Math.min(r.x + r.width, vb[0] + vb[2]) - Math.max(r.x, vb[0])) / vb[2],
    y:
      Math.max(0, Math.min(r.y + r.height, vb[1] + vb[3]) - Math.max(r.y, vb[1])) / vb[3],
  };
}

/** Normalize a computed paint color for DESIGN storage: hex when possible;
 *  anything unusable (none / gradients) becomes "transparent", which in
 *  custom-template semantics means "keep the template's original paint". */
function designColor(computed: string): string {
  const hex = rgbToHex(computed);
  if (hex) return hex;
  if (computed && computed !== "none" && !computed.startsWith("url(") && /^[a-zA-Z#][\w(),.#%-]*$/.test(computed)) {
    return computed;
  }
  return "transparent";
}

/** First numeric value of an attribute ("128" | "128 64" → 128; null otherwise). */
function numericAttr(el: SVGElement, name: string): number | null {
  const raw = el.getAttribute(name);
  if (!raw) return null;
  const first = raw.trim().split(/[\s,]+/)[0];
  const n = Number(first);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* 1 · Annotation                                                      */
/* ------------------------------------------------------------------ */

export interface CustomAnnotationInput {
  svgText: string;
  /** final confirmed slot rects (reading order, as saved) */
  slotRects: Rect[];
  /** confirmed hero rect (or null) */
  heroRect: Rect | null;
  /** role per detected text element, aligned with the analyzer's texts */
  textRoles: Array<CustomTextRole | "none">;
}

export interface CustomAnnotation {
  /** the role-annotated SVG document string (full <svg …> markup) */
  editableSvg: string;
  /** captured roles + original styles */
  roles: CustomTemplateRoles;
}

/**
 * Mark the classified elements of a custom template with data-iss-* role
 * attributes and capture their original styles. The source GEOMETRY is
 * untouched — only invisible marker attributes are added to a serialized
 * copy; the original sourceSvg is never modified.
 */
export function annotateCustomSvg(input: CustomAnnotationInput): CustomAnnotation | null {
  if (typeof DOMParser === "undefined" || typeof window === "undefined") return null;
  try {
    const vb = parseViewBox(input.svgText);
    if (!vb || vb[2] < 2 || vb[3] < 2) return null;
    const root = parseSvgDocument(input.svgText);
    if (!root) return null;

    /* preserve the root's original sizing attrs — measurement temporarily
     * overrides width/height (inline style included) */
    const savedWidth = root.getAttribute("width");
    const savedHeight = root.getAttribute("height");
    const savedStyle = root.getAttribute("style");

    const raw = measureMountedSvg(root, vb);
    if (!raw) {
      restoreRootSizing(root, savedWidth, savedHeight, savedStyle);
      return null;
    }

    /* -- background (largest full-canvas shape) ------------------------ */
    const canvasArea = vb[2] * vb[3];
    const backgrounds = raw.shapes.filter((s) => {
      const cov = canvasCoverage(s.rect, vb);
      return (cov.x >= 0.85 && cov.y >= 0.85) || s.area >= canvasArea * 0.6;
    });
    const background =
      backgrounds.length > 0
        ? [...backgrounds].sort((a, b) => b.area - a.area)[0]
        : null;
    const used = new Set<MeasuredEl>();
    if (background) {
      background.el.setAttribute("data-iss-role", "background");
      used.add(background);
    }

    /* -- hero area (best-matching shape or group for the hero rect) ---- */
    if (input.heroRect) {
      const heroEl = bestElementForRect(
        [...raw.shapes, ...raw.groups],
        input.heroRect,
        used
      );
      if (heroEl) {
        heroEl.el.setAttribute("data-iss-role", "hero-area");
        used.add(heroEl);
      }
    }

    /* -- grid cells (one backing element per confirmed slot) ------------ */
    const cellPaint: Array<CustomCellPaint | null> = [];
    for (const slotRect of input.slotRects) {
      const cell = bestElementForRect(raw.shapes, slotRect, used);
      if (!cell) {
        cellPaint.push(null);
        continue;
      }
      cell.el.setAttribute("data-iss-role", "cell");
      cell.el.setAttribute("data-iss-cell", String(cellPaint.length));
      used.add(cell);
      cellPaint.push({
        fill: cell.fill,
        stroke: cell.stroke,
        strokeWidth: round(cell.strokeWidth),
        opacity: round(cell.opacity),
      });
    }

    /* -- mapped texts --------------------------------------------------- */
    const textRoles = input.textRoles;
    const text: CustomTemplateRoles["text"] = {};
    raw.texts.forEach((t, i) => {
      const role = textRoles[i] ?? "none";
      if (role === "none") return;
      if (text[role]) return; // one element per role — first wins
      t.el.setAttribute("data-iss-role", "text");
      t.el.setAttribute("data-iss-text-role", role);
      const capture: CustomTextStyleCapture = {
        role,
        content: t.info.snippet,
        fontFamily: t.style.fontFamily,
        fontSize: round(t.style.fontSize, 1),
        fontWeight: t.style.fontWeight,
        letterSpacing: round(t.style.letterSpacing),
        color: rgbToHex(t.style.fill) ?? t.style.fill,
        anchor: t.style.anchor,
        fontStyle: t.style.fontStyle,
        rect: t.info.rect,
        xAttr: numericAttr(t.el, "x"),
        yAttr: numericAttr(t.el, "y"),
      };
      text[role] = capture;
    });

    restoreRootSizing(root, savedWidth, savedHeight, savedStyle);

    const editableSvg = new XMLSerializer().serializeToString(root);
    const roles: CustomTemplateRoles = {
      backgroundFill: background ? background.fill : null,
      cellPaint,
      text,
      heroSlotSize: input.heroRect
        ? round(Math.min(input.heroRect.width, input.heroRect.height))
        : null,
      cellCount: cellPaint.filter(Boolean).length,
    };
    return { editableSvg, roles };
  } catch (err) {
    console.warn("[custom-template] annotation failed — keeping verbatim artwork", err);
    return null;
  }
}

function restoreRootSizing(
  root: SVGElement,
  width: string | null,
  height: string | null,
  style: string | null
): void {
  if (width === null) root.removeAttribute("width");
  else root.setAttribute("width", width);
  if (height === null) root.removeAttribute("height");
  else root.setAttribute("height", height);
  if (style === null) root.removeAttribute("style");
  else root.setAttribute("style", style);
}

/** Highest-overlap unused element for a rect (≥ 0.5); prefers painted,
 *  slot-hinted, shallower elements for stacked duplicates. */
function bestElementForRect(
  candidates: MeasuredEl[],
  rect: Rect,
  used: Set<MeasuredEl>
): MeasuredEl | null {
  let best: MeasuredEl | null = null;
  let bestScore = 0;
  const pref = (m: MeasuredEl): number =>
    (m.painted && !m.hidden ? 8 : 0) + (m.hints ? 4 : 0) - m.depth * 0.1;
  for (const c of candidates) {
    if (used.has(c)) continue;
    const ov = overlapRatio(c.rect, rect);
    if (ov < 0.5) continue;
    if (ov > bestScore || (ov === bestScore && best && pref(c) > pref(best))) {
      best = c;
      bestScore = ov;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 2 · Legacy backfill (hydrate)                                       */
/* ------------------------------------------------------------------ */

/**
 * Annotate a template record saved BEFORE universal editing. Slots, hero
 * and cells are matched from the STORED (user-confirmed) geometry; texts
 * are deliberately left unmapped so legacy sheets keep rendering
 * byte-identically. Returns null when annotation fails (record untouched).
 */
export function annotateLegacyRecord(
  record: CustomTemplateRecord
): CustomTemplateRecord | null {
  const annotation = annotateCustomSvg({
    svgText: record.sourceSvg,
    slotRects: record.iconSlots,
    heroRect: record.heroSlot,
    textRoles: [],
  });
  if (!annotation) return null;
  return {
    ...record,
    editableSvg: annotation.editableSvg,
    roles: annotation.roles,
  };
}

/** Annotate every legacy record in place (registry-safe clones). Returns
 *  the full record list plus the subset that gained annotations (to persist). */
export function enrichCustomTemplateRecords(records: CustomTemplateRecord[]): {
  records: CustomTemplateRecord[];
  changed: CustomTemplateRecord[];
} {
  if (typeof DOMParser === "undefined" || typeof window === "undefined") {
    return { records, changed: [] };
  }
  const out: CustomTemplateRecord[] = [];
  const changed: CustomTemplateRecord[] = [];
  for (const record of records) {
    if (record.editableSvg && record.roles) {
      out.push(record);
      continue;
    }
    const enriched = annotateLegacyRecord(record);
    if (enriched) {
      out.push(enriched);
      changed.push(enriched);
    } else {
      out.push(record);
    }
  }
  return { records: out, changed };
}

/* ------------------------------------------------------------------ */
/* 3 · Design defaults derived from detected roles                     */
/* ------------------------------------------------------------------ */

function mode(values: string[]): string {
  if (!values.length) return "";
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && v === values[0])) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** TextStyle that reproduces the captured text exactly (diff baseline). */
function captureToTextStyle(c: CustomTextStyleCapture, role: CustomTextRole): TextStyle {
  return {
    fontFamily: c.fontFamily,
    fontSize: c.fontSize,
    fontWeight: c.fontWeight,
    letterSpacing: c.letterSpacing,
    lineHeight: 1,
    align: c.anchor,
    color: c.color,
    uppercase: false,
    offsetX: 0,
    offsetY: 0,
    fontStyle: c.fontStyle,
    /* round 17 + R34: the title auto-fits the captured text element's own
     * rect (the template's real title geometry) by default — the builder's
     * explicit Auto Fit OFF choice is honored via the capture flag */
    ...(role === "category" ? { autoFit: c.autoFit ?? true } : {}),
  };
}

/** Design defaults for a custom template WITH detected roles: every value
 *  equals the template's own original paint/typography so a fresh sheet
 *  renders the uploaded artwork byte-faithfully (all diffs are no-ops).
 *  `base` is the studio-wide fallback design (passed in to avoid a module
 *  cycle with templates.ts). */
export function customDesignDefaultsFromRoles(
  roles: CustomTemplateRoles | undefined,
  heroSlotSize: number | null,
  base: SheetDesign
): SheetDesign {
  if (!roles) {
    return {
      ...base,
      background: "transparent",
      spacing: { ...base.spacing, cellPadding: 0, iconScale: 0.8 },
      footerText: "",
      hero: { ...base.hero, customHeroCard: false },
      customDesignV2: true,
    };
  }
  const cells = roles.cellPaint.filter((c): c is CustomCellPaint => c != null);
  const fill = cells.length ? designColor(mode(cells.map((c) => c.fill))) : "transparent";
  const stroke = cells.length ? designColor(mode(cells.map((c) => c.stroke))) : "transparent";
  const strokeWidth = cells.length ? Math.round(median(cells.map((c) => c.strokeWidth))) : 0;
  return {
    ...base,
    background: roles.backgroundFill != null ? designColor(roles.backgroundFill) : "transparent",
    card: {
      ...base.card,
      color: fill,
      borderColor: stroke,
      borderWidth: strokeWidth,
      opacity: 1,
      radius: 0,
      shadow: false,
      gradient: null,
      showEmptyCells: false,
    },
    hero: {
      ...base.hero,
      cardSize: heroSlotSize != null ? Math.max(60, Math.round(heroSlotSize)) : base.hero.cardSize,
      customHeroCard: false,
      /* P5 hero card controls — stamped explicitly so new sheets carry
       * the current schema (on · selected icon · no padding · no pin). */
      enabled: true,
      displayMode: "selected",
      iconPadding: 0,
      customIconId: null,
    },
    typography: {
      category: roles.text.category
        ? captureToTextStyle(roles.text.category, "category")
        : base.typography.category,
      volume: roles.text.volume
        ? captureToTextStyle(roles.text.volume, "volume")
        : base.typography.volume,
      caption: roles.text.caption
        ? captureToTextStyle(roles.text.caption, "caption")
        : base.typography.caption,
      footer: base.typography.footer,
    },
    captionText: roles.text.caption?.content ?? "",
    footerText: "",
    spacing: { ...base.spacing, cellPadding: 0, iconScale: 0.8 },
    customDesignV2: true,
  };
}

/* ------------------------------------------------------------------ */
/* 4 · Render-time artwork transform                                   */
/* ------------------------------------------------------------------ */

interface EditableCacheEntry {
  svg: string;
  root: SVGElement;
}
const editableCache = new Map<string, EditableCacheEntry>();

function acquireEditableRoot(templateId: string, editableSvg: string): SVGElement | null {
  const cached = editableCache.get(templateId);
  if (cached && cached.svg === editableSvg) {
    return cached.root.cloneNode(true) as SVGElement;
  }
  const root = parseSvgDocument(editableSvg);
  if (!root) return null;
  editableCache.set(templateId, { svg: editableSvg, root });
  return root.cloneNode(true) as SVGElement;
}

/**
 * The sheet's live text for a mapped text role (category/volume/count
 * render the SHEET's own data — that is the point of the mapping; caption
 * renders the design's caption text). The count is the number of icons
 * actually assigned to this sheet ("47 ICONS" on a 60-slot template). */
function liveTextContent(
  role: CustomTextRole,
  sheet: Sheet,
  design: SheetDesign,
  uppercase: boolean
): string {
  let content = "";
  if (role === "category") content = sheet.category || "Icon Collection";
  else if (role === "volume") content = formatVolume(sheet.volume);
  else if (role === "count") content = `${sheet.iconIds.length} ICONS`;
  else content = design.captionText ?? "";
  if (uppercase) content = content.toUpperCase();
  return content;
}

/** Wrap text into lines by an estimated width (chars × size heuristic).
 *  MANUAL line breaks (`\n`) are structural: each line wraps
 *  independently and every break is preserved — auto-wrap only adds
 *  lines below a too-long manual line, never merges breaks. */
function wrapByWidth(text: string, maxWidth: number, style: TextStyle): string[] {
  const paragraphs = text.split("\n");
  if (maxWidth <= 0) return paragraphs;
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push(""); // blank manual line — always kept
      continue;
    }
    if (words.length === 1) {
      lines.push(words[0]);
      continue;
    }
    const charW = style.fontSize * 0.58 + style.letterSpacing;
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length * charW <= maxWidth || !current) current = candidate;
      else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function setTextLines(
  el: SVGTextElement,
  lines: string[],
  style: TextStyle,
  xAttr: number | null
): void {
  const doc = el.ownerDocument;
  while (el.firstChild) el.removeChild(el.firstChild);
  if (lines.length > 1 && xAttr != null) {
    lines.forEach((line, i) => {
      const tspan = doc.createElementNS(SVG_NS, "tspan");
      tspan.setAttribute("x", String(xAttr));
      if (i > 0) tspan.setAttribute("dy", String(round(style.fontSize * Math.max(style.lineHeight, 0.8))));
      tspan.textContent = line;
      el.appendChild(tspan);
    });
  } else {
    el.textContent = lines.join(" ");
  }
}

/** Auto-fitted lines for a custom template's text element: per-line
 *  spacing comes from the FIT (not the manual style), and the first
 *  baseline is repositioned so the whole block is vertically centered on
 *  the original text's visual center (only possible when the element has
 *  a numeric y attribute — otherwise the template's own vertical position
 *  is kept and only the size/lines adapt). */
function setFittedTextLines(
  el: SVGTextElement,
  lines: string[],
  lineHeightPx: number,
  xAttr: number | null,
  yAttr: number | null,
  firstBaseline: number
): void {
  const doc = el.ownerDocument;
  while (el.firstChild) el.removeChild(el.firstChild);
  if (yAttr != null) {
    el.setAttribute("y", String(round(firstBaseline)));
  }
  if (lines.length > 1) {
    lines.forEach((line, i) => {
      const tspan = doc.createElementNS(SVG_NS, "tspan");
      if (xAttr != null) tspan.setAttribute("x", String(xAttr));
      if (i > 0) tspan.setAttribute("dy", String(round(lineHeightPx)));
      tspan.textContent = line;
      el.appendChild(tspan);
    });
  } else {
    el.textContent = lines.join(" ");
  }
}

/** Apply the sheet's design DIFFS (vs the template's detected defaults) to
 *  the cloned annotated artwork. Only the marked elements are touched. */
function applyCustomDesignEdits(cloneRoot: SVGElement, sheet: Sheet, template: TemplateDef): void {
  const custom = template.custom!;
  const roles = custom.roles;
  if (!roles) return;
  const design = sheet.design;
  const base = template.defaults;

  /* -- background ----------------------------------------------------- */
  if (roles.backgroundFill != null) {
    const el = cloneRoot.querySelector('[data-iss-role="background"]');
    if (el) {
      const bgEl = el as SVGElement;
      if (design.backgroundVisible === false) {
        /* master switch OFF: the detected background element is removed
         * from the render entirely (preview AND export — same renderer). */
        bgEl.style.display = "none";
      } else if (design.background && design.background !== base.background) {
        bgEl.style.fill =
          design.background === "transparent" ? "none" : design.background;
      }
    }
  }

  /* -- grid cells ------------------------------------------------------ */
  if (roles.cellCount > 0) {
    const cells = Array.from(
      cloneRoot.querySelectorAll('[data-iss-role="cell"]')
    ) as SVGElement[];
    const card = design.card;
    const baseCard = base.card;
    if (card.visible !== baseCard.visible) {
      for (const el of cells) el.style.display = card.visible ? "" : "none";
    }
    if (card.color && card.color !== baseCard.color) {
      const fill = card.color === "transparent" ? "none" : card.color;
      for (const el of cells) el.style.fill = fill;
    }
    if (
      (card.borderColor && card.borderColor !== baseCard.borderColor) ||
      card.borderWidth !== baseCard.borderWidth
    ) {
      const noStroke =
        !card.borderColor || card.borderColor === "transparent" || card.borderWidth <= 0;
      for (const el of cells) {
        el.style.stroke = noStroke ? "none" : card.borderColor;
        el.style.strokeWidth = String(Math.max(0, card.borderWidth));
      }
    }
    if (card.opacity !== baseCard.opacity) {
      for (const el of cells) el.style.opacity = String(card.opacity);
    }
  }

  /* -- mapped texts ----------------------------------------------------- */
  const textSpecs: Array<{
    role: CustomTextRole;
    capture: CustomTextStyleCapture;
    style: TextStyle;
    baseStyle: TextStyle;
  }> = [];
  for (const role of ["category", "volume", "caption", "count"] as const) {
    const capture = roles.text[role];
    if (!capture) continue;
    if (role === "count") {
      /* the icon counter is AUTO-MANAGED: it has no design.typography field
       * (nothing to hand-edit — the number is derived per sheet). Its style
       * IS the template's captured style, so every diff below is a no-op and
       * only the live content replacement runs. */
      const style = captureToTextStyle(capture, "count");
      textSpecs.push({ role, capture, style, baseStyle: { ...style } });
      continue;
    }
    textSpecs.push({
      role,
      capture,
      style: design.typography[role],
      baseStyle: base.typography[role],
    });
  }

  for (const spec of textSpecs) {
    const el = cloneRoot.querySelector(
      `[data-iss-text-role="${spec.role}"]`
    ) as SVGTextElement | null;
    if (!el) continue;
    const { role, capture, style, baseStyle } = spec;

    /* round 24 — visibility master switch: hidden mapped text is removed
     * from the render entirely (display:none on the fresh clone; preview
     * AND export share this renderer). Diff-based like every other text
     * edit so an untouched sheet stays byte-faithful. */
    if ((style.visible ?? true) !== (baseStyle.visible ?? true)) {
      el.style.display = style.visible === false ? "none" : "";
    }

    /* content — category/volume always render the sheet's live data; the
     * caption re-renders only when its text changed */
    const content = liveTextContent(role, sheet, design, style.uppercase);
    const contentChanged = content !== capture.content;
    /* round 17 — SMART AUTO-FIT for the title: when enabled, the live
     * text is fitted (real measurement, safe inset of the template's own
     * title-text rect, balanced size, whole-block vertical centering).
     * Applied only when the render actually DIFFERS from the template's
     * own words/styles, so a fresh custom sheet stays byte-faithful. */
    const autoFitOn = role === "category" && style.autoFit !== false;
    const styleDiff =
      style.fontFamily !== baseStyle.fontFamily ||
      style.fontWeight !== baseStyle.fontWeight ||
      style.letterSpacing !== baseStyle.letterSpacing ||
      (style.fontStyle ?? "normal") !== (baseStyle.fontStyle ?? "normal");
    let autoFitApplied = false;
    if (autoFitOn && (contentChanged || styleDiff)) {
      const fit = fitTitle(content, capture.rect, style);
      if (fit.fitted && fit.lines.length > 0) {
        /* inline style beats the template's own CSS — the fitted size is
         * the rendered size, whatever the captured default was */
        el.style.fontSize = `${Math.round(fit.fontSize * 100) / 100}px`;
        const blockTop = capture.rect.y + capture.rect.height / 2 - fit.blockHeight / 2;
        const firstBaseline = blockTop + 0.8 * fit.fontSize;
        setFittedTextLines(el, fit.lines, fit.lineHeightPx, capture.xAttr, capture.yAttr, firstBaseline);
        autoFitApplied = true;
      }
    }
    if (!autoFitApplied && contentChanged) {
      /* auto-fit off (or degenerate rect): legacy behavior — slack 1.5:
       * modest growth (letter-spacing, slightly wider glyphs) stays on one
       * line; genuinely longer copy wraps below the anchor */
      const maxWidth = capture.rect.width * 1.5;
      setTextLines(el, wrapByWidth(content, maxWidth, style), style, capture.xAttr);
    }

    /* style — only the fields that actually differ from the template's
     * captured defaults are set (inline style beats CSS rules); with
     * auto-fit ON the fitted size already won, so the manual size is
     * never re-applied on top */
    if (style.fontFamily !== baseStyle.fontFamily) el.style.fontFamily = style.fontFamily;
    if (!autoFitApplied && style.fontSize !== baseStyle.fontSize) el.style.fontSize = `${style.fontSize}px`;
    if (style.fontWeight !== baseStyle.fontWeight) el.style.fontWeight = String(style.fontWeight);
    if (style.letterSpacing !== baseStyle.letterSpacing) {
      el.style.letterSpacing = `${style.letterSpacing}px`;
    }
    if (style.color !== baseStyle.color) el.style.fill = style.color;
    if (style.fontStyle !== baseStyle.fontStyle) el.style.fontStyle = style.fontStyle ?? "normal";
    if (style.align !== baseStyle.align) el.style.textAnchor = style.align;

    if (style.offsetX !== baseStyle.offsetX || style.offsetY !== baseStyle.offsetY) {
      const dx = (style.offsetX ?? 0) - (baseStyle.offsetX ?? 0);
      const dy = (style.offsetY ?? 0) - (baseStyle.offsetY ?? 0);
      const existing = el.getAttribute("transform") ?? "";
      el.setAttribute("transform", `${existing} translate(${round(dx)} ${round(dy)})`.trim());
    }
  }
}

/** Serialize the (possibly transformed) cloned root into inner markup,
 *  stripping our internal data-iss markers from the output. */
function serializeInner(root: SVGElement): string {
  let xml = new XMLSerializer().serializeToString(root);
  if (/^<svg[\s>]/i.test(xml)) {
    const openEnd = xml.indexOf(">");
    const closeIdx = xml.toLowerCase().lastIndexOf("</svg>");
    if (openEnd >= 0) {
      xml = closeIdx > openEnd ? xml.slice(openEnd + 1, closeIdx) : xml.slice(openEnd + 1);
    }
  }
  /* markers are workflow-internal — never leak them into rendered or
   * exported sheets (attribute values are XML-escaped so no raw quotes) */
  xml = xml.replace(/ data-iss-[a-z-]+="[^"]*"/g, "");
  return xml;
}

/**
 * The custom template's artwork with the sheet's design edits applied.
 * Returns the inner markup (root <svg> tag stripped, data markers removed —
 * id namespacing stays the renderer's job). Null → fall back to verbatim.
 */
export function renderCustomArtwork(sheet: Sheet, template: TemplateDef): string | null {
  const custom = template.custom;
  if (!custom?.editableSvg) return null;
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return null;
  try {
    const clone = acquireEditableRoot(template.id, custom.editableSvg);
    if (!clone) return null;
    applyCustomDesignEdits(clone, sheet, template);
    return serializeInner(clone);
  } catch (err) {
    console.warn("[custom-template] artwork transform failed — verbatim fallback", err);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 5 · Capabilities (Properties panel)                                 */
/* ------------------------------------------------------------------ */

export interface CustomTemplateCapabilities {
  /** true for user-imported templates */
  isCustom: boolean;
  /** background color editable (detected background element / official) */
  background: boolean;
  /** grid-cell paint editable; count of backing cell elements (custom) or
   *  the template capacity (official) */
  cells: number;
  /** which text styles exist on the template */
  text: { category: boolean; volume: boolean; caption: boolean; count: boolean; footer: boolean };
  /** hero icon placeable (hero slot detected / official region) */
  heroSlot: boolean;
  /** template owns a left rail */
  rail: boolean;
}

/** Which editing roles a template supports. Official templates support the
 *  full classic system; custom templates depend on their detected structure. */
export function resolveCustomCapabilities(
  template: TemplateDef | undefined
): CustomTemplateCapabilities {
  if (!template || template.sourceType !== "custom" || !template.custom) {
    return {
      isCustom: false,
      background: true,
      cells: template?.capacity ?? 0,
      text: { category: true, volume: true, caption: true, count: false, footer: true },
      heroSlot: true,
      rail: Boolean(template?.rail),
    };
  }
  const custom = template.custom;
  const roles = custom.roles;
  return {
    isCustom: true,
    background: roles ? roles.backgroundFill != null : false,
    cells: roles ? roles.cellCount : 0,
    text: {
      category: Boolean(roles?.text.category),
      volume: Boolean(roles?.text.volume),
      caption: Boolean(roles?.text.caption),
      count: Boolean(roles?.text.count),
      footer: false, // custom templates have no footer role
    },
    heroSlot: custom.heroSlot != null,
    rail: false,
  };
}
