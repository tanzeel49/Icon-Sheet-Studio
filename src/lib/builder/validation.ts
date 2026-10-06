/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 1) · centralized validation.
 *
 * Two layers:
 *   1. validateDocument(doc)  — live issue list for the UI (field-level
 *      messages next to the controls + a toolbar badge with a popover).
 *   2. sanitizeDocument(raw)  — corruption RECOVERY on persistence load:
 *      coerces NaN/Infinity → safe fallbacks, clamps to the limit
 *      constants, drops unrecoverable elements, and REPORTS everything
 *      it fixed. Corrupt values are never silently accepted: the user
 *      sees exactly what was repaired.
 */

import {
  ARTBOARD_MAX,
  ARTBOARD_MIN,
  ELEMENT_ROLES,
  ELEMENT_TYPES,
  GRID_COLS_MAX,
  GRID_ROWS_MAX,
  GRID_CELLS_RENDER_MAX,
  MAPPED_TEXT_ROLES,
  SVG_SOURCE_MAX_BYTES,
  TEXT_CONTENT_MAX,
  getGridProps,
  getSvgProps,
  getTextProps,
  newId,
  roleLabel,
  type BuilderDocument,
  type BuilderElement,
  type BuilderElementType,
  type BuilderRole,
} from "./types";
import { computeGridMetrics, gridCellRects, elementBBox, rectsIntersect } from "./geometry";

/* ------------------------------------------------------------------ */
/* Numeric guards                                                      */
/* ------------------------------------------------------------------ */

export function finiteOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function clampNum(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------ */
/* Live validation                                                     */
/* ------------------------------------------------------------------ */

export interface ValidationIssue {
  level: "error" | "warning";
  message: string;
  elementId?: string;
  elementName?: string;
}

export function validateDocument(doc: BuilderDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (level: ValidationIssue["level"], message: string, el?: BuilderElement) =>
    issues.push({ level, message, elementId: el?.id, elementName: el?.name });

  /* artboard */
  if (!Number.isFinite(doc.artboard.width) || doc.artboard.width < ARTBOARD_MIN)
    push("error", `Artboard width must be at least ${ARTBOARD_MIN} px (is ${doc.artboard.width}).`);
  if (!Number.isFinite(doc.artboard.height) || doc.artboard.height < ARTBOARD_MIN)
    push("error", `Artboard height must be at least ${ARTBOARD_MIN} px (is ${doc.artboard.height}).`);
  if (doc.artboard.width > ARTBOARD_MAX || doc.artboard.height > ARTBOARD_MAX)
    push("error", `Artboard dimensions exceed the ${ARTBOARD_MAX} px limit.`);
  if (!doc.name.trim()) push("warning", "Document has no name.");

  /* ---- semantic structure (publish readiness) ---- */
  const grids = doc.elements.filter((el) => el.type === "icon-grid");
  if (grids.length === 0)
    push("warning", "No icon grid — a publishable template needs exactly one icon grid element.");
  if (grids.length > 1)
    push("error", `Only one icon grid is supported per template — ${grids.length} found. Delete the extra grid before saving.`);
  for (const g of grids) {
    if (Math.abs(g.rotation) > 1e-6)
      push(
        "error",
        "Icon grid rotation is not supported in published templates — set the grid's rotation to 0.",
        g
      );
  }
  const heroes = doc.elements.filter((el) => el.role === "hero");
  if (heroes.length > 1)
    push(
      "error",
      `Only one hero area is allowed — ${heroes.length} elements carry the hero role. Keep exactly one so the Studio knows where the hero icon goes.`
    );

  /* duplicate mapped text roles — the compiler maps only the FIRST element
   * per role; surface that live (§28: never two competing bindings). */
  for (const role of MAPPED_TEXT_ROLES) {
    const holders = doc.elements.filter((el) => el.type === "text" && el.role === role);
    if (holders.length > 1) {
      const extra = holders.slice(1);
      push(
        "warning",
        `${holders.length} ${roleLabel(role)} texts — only the first is mapped to the Studio; ${extra
          .map((e) => `“${e.name}”`)
          .join(", ")} stay static artwork.`,
        extra[0]
      );
    }
  }

  /* §29 recommended advisories — a template without these still saves,
   * but the author should know what the Studio will NOT populate. */
  const mappedTextRolesPresent = new Set(
    doc.elements.filter((el) => el.type === "text").map((el) => el.role)
  );
  if (!mappedTextRolesPresent.has("category"))
    push("warning", "No Category Title text — sheets will not show a live category name.");
  if (!mappedTextRolesPresent.has("icon-count"))
    push("warning", "No Icon Count text — sheets will not show a live icon count.");
  if (!mappedTextRolesPresent.has("volume"))
    push("warning", "No Volume text — sheets will not show a live volume number.");
  if (heroes.length === 0)
    push("warning", "No hero area — sheets using this template cannot feature a hero icon.");

  /* hero ↔ icon-cell overlap (advisory — advanced users may overlap on purpose) */
  const hero = heroes[0];
  const grid = grids[0];
  if (hero && grid && getGridProps(grid)) {
    const cells = gridCellRects(grid).map((r) => ({
      x: r.x + grid.x,
      y: r.y + grid.y,
      width: r.w,
      height: r.h,
    }));
    const heroBox = { x: hero.x, y: hero.y, width: hero.width, height: hero.height };
    const overlapped = cells.filter((c) => rectsIntersect(heroBox, c)).length;
    if (overlapped > 0)
      push(
        "warning",
        `Hero overlaps ${overlapped} icon cell${overlapped === 1 ? "" : "s"} — icons will be drawn on top of the hero artwork. Move the hero or the grid if that is not intended.`,
        hero
      );
  }

  /* elements */
  const ids = new Set<string>();
  doc.elements.forEach((el, index) => {
    const label = `${el.name || el.type} (#${index + 1})`;
    if (!el.id || ids.has(el.id)) push("error", `Element has a duplicate or missing id.`, el);
    else ids.add(el.id);
    if (!ELEMENT_TYPES.includes(el.type)) push("error", `Unknown element type "${el.type}".`, el);
    if (!ELEMENT_ROLES.includes(el.role)) push("error", `Unknown role "${el.role}".`, el);
    for (const field of ["x", "y", "width", "height", "rotation", "opacity"] as const) {
      if (!Number.isFinite(el[field])) push("error", `${label}: ${field} is not a finite number.`, el);
    }
    if (el.type !== "line" && (el.width <= 0 || el.height <= 0))
      push("error", `${label}: width and height must be greater than zero.`, el);
    if (el.type === "line" && el.width + el.height <= 0)
      push("error", `${label}: a line needs a non-zero length.`, el);
    if (el.opacity < 0 || el.opacity > 1) push("error", `${label}: opacity must be between 0 and 1.`, el);

    /* out-of-bounds (advisory warning — never silently moved or cropped) */
    if (el.type !== "background" && el.visible) {
      const b = elementBBox(el);
      const outH = b.x < -0.51 || b.x + b.width > doc.artboard.width + 0.51;
      const outV = b.y < -0.51 || b.y + b.height > doc.artboard.height + 0.51;
      if (outH || outV)
        push(
          "warning",
          `${label} extends beyond the artboard — the published template will show it cropped at the canvas edge.`,
          el
        );
    }

    /* icon grid */
    const grid = getGridProps(el);
    if (grid) {
      if (!Number.isInteger(grid.rows) || grid.rows < 1)
        push("error", `${label}: rows must be a whole number ≥ 1.`, el);
      if (!Number.isInteger(grid.columns) || grid.columns < 1)
        push("error", `${label}: columns must be a whole number ≥ 1.`, el);
      if (grid.rows > GRID_ROWS_MAX || grid.columns > GRID_COLS_MAX)
        push("error", `${label}: rows/columns exceed the ${GRID_ROWS_MAX}×${GRID_COLS_MAX} limit.`, el);
      if (grid.rows * grid.columns > GRID_CELLS_RENDER_MAX)
        push(
          "warning",
          `${label}: ${grid.rows * grid.columns} cells exceeds the ${GRID_CELLS_RENDER_MAX} render limit — cells are hidden until reduced.`,
          el
        );
      /* icon count — usable slots within the grid capacity */
      const capacity = grid.rows * grid.columns;
      if (
        !Number.isInteger(grid.iconCount) ||
        grid.iconCount < 1 ||
        grid.iconCount > capacity
      )
        push(
          "error",
          `${label}: icon count must be a whole number between 1 and ${capacity} (is ${grid.iconCount}).`,
          el
        );
      if (grid.unusedCells !== "empty" && grid.unusedCells !== "hidden")
        push("error", `${label}: unused-cells mode must be "empty" or "hidden".`, el);
      for (const [field, value] of [
        ["horizontal gap", grid.horizontalGap],
        ["vertical gap", grid.verticalGap],
        ["padding", grid.paddingTop],
        ["cell size", grid.squareCells ? grid.cellWidth : Math.min(grid.cellWidth, grid.cellHeight)],
      ] as [string, number][]) {
        if (!Number.isFinite(value) || value < 0)
          push("error", `${label}: ${field} must be zero or a positive number.`, el);
      }
      if (grid.squareCells && Math.abs(grid.cellWidth - grid.cellHeight) > 1e-6)
        push("error", `${label}: square cells is on but width ≠ height.`, el);
      const metrics = computeGridMetrics(el);
      if (!metrics.fits) {
        const maxCellW = metrics.availableWidth / Math.max(1, grid.columns);
        const maxCellH = metrics.availableHeight / Math.max(1, grid.rows);
        push(
          "error",
          `${label}: grid does not fit in the available area (max cell ${Math.round(maxCellW * 10) / 10}×${Math.round(maxCellH * 10) / 10} px at these rows/columns). Reduce spacing or padding, change rows/columns, or enlarge the grid area.`,
          el
        );
      }
    }

    /* text */
    const text = getTextProps(el);
    if (text) {
      if (!Number.isFinite(text.fontSize) || text.fontSize <= 0)
        push("error", `${label}: font size must be greater than zero.`, el);
      if (!Number.isFinite(text.lineHeight) || text.lineHeight <= 0)
        push("error", `${label}: line height must be greater than zero.`, el);
      if (!Number.isFinite(text.letterSpacing) || text.letterSpacing < -10)
        push("error", `${label}: letter spacing must be −10 or greater.`, el);
      if (text.content.length > TEXT_CONTENT_MAX)
        push("warning", `${label}: text exceeds ${TEXT_CONTENT_MAX} characters.`, el);
    }

    /* svg */
    const svg = getSvgProps(el);
    if (svg) {
      if (!svg.svg || !/<svg[\s>]/i.test(svg.svg))
        push("error", `${label}: missing or invalid SVG source.`, el);
      else if (svg.svg.length > SVG_SOURCE_MAX_BYTES)
        push("error", `${label}: SVG source exceeds the 2 MB limit.`, el);
    }
  });

  return issues;
}

/* ------------------------------------------------------------------ */
/* Corruption recovery (persistence load)                              */
/* ------------------------------------------------------------------ */

const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity): number =>
  Math.round(clampNum(finiteOr(v, fallback), min, max) * 100) / 100;

/** Repair one element; returns null when the element is unrecoverable. */
function sanitizeElement(raw: unknown, index: number, seen: Set<string>): { el: BuilderElement | null; notes: string[] } {
  const notes: string[] = [];
  if (typeof raw !== "object" || raw === null) return { el: null, notes: ["dropped a non-object element"] };
  const r = raw as Record<string, unknown>;
  const type = r.type as BuilderElementType;
  if (!ELEMENT_TYPES.includes(type)) return { el: null, notes: [`dropped element with unknown type "${String(r.type)}"`] };
  const role = (ELEMENT_ROLES.includes(r.role as BuilderRole) ? r.role : "decorative") as BuilderRole;
  if (role !== r.role) notes.push(`reset invalid role "${String(r.role)}" to "decorative"`);

  let id = typeof r.id === "string" && r.id ? r.id : newId("el");
  if (seen.has(id)) {
    notes.push("regenerated duplicate element id");
    id = newId("el");
  }
  seen.add(id);

  const isLine = type === "line";
  const el: BuilderElement = {
    id,
    type,
    role,
    name: typeof r.name === "string" && r.name.trim() ? r.name.slice(0, 120) : `${type} ${index + 1}`,
    x: num(r.x, 0, -ARTBOARD_MAX, ARTBOARD_MAX),
    y: num(r.y, 0, -ARTBOARD_MAX, ARTBOARD_MAX),
    width: num(r.width, 100, 0, ARTBOARD_MAX) || (isLine ? 0 : 1),
    height: num(r.height, 100, 0, ARTBOARD_MAX) || (isLine ? 0 : 1),
    rotation: num(r.rotation, 0, -360, 360),
    visible: r.visible !== false,
    locked: r.locked === true,
    zIndex: index,
    opacity: num(r.opacity, 1, 0, 1),
    properties: {},
  };

  const p = (typeof r.properties === "object" && r.properties !== null ? r.properties : {}) as Record<string, unknown>;

  switch (type) {
    case "background":
      el.properties = { fill: typeof p.fill === "string" ? p.fill : "#FFFFFF" };
      break;
    case "icon-grid": {
      const rows = Math.round(clampNum(finiteOr(p.rows, 1), 1, GRID_ROWS_MAX));
      const columns = Math.round(clampNum(finiteOr(p.columns, 1), 1, GRID_COLS_MAX));
      const squareCells = p.squareCells !== false;
      const autoFit = p.autoFit === true;
      let cellWidth = num(p.cellWidth, 80, 0, ARTBOARD_MAX);
      let cellHeight = squareCells ? cellWidth : num(p.cellHeight, 80, 0, ARTBOARD_MAX);
      if (squareCells && Math.abs(cellWidth - cellHeight) > 1e-6) {
        notes.push("repaired non-square cell size while Square Cells is on");
        cellHeight = cellWidth;
      }
      el.properties = {
        rows,
        columns,
        cellWidth,
        cellHeight,
        horizontalGap: num(p.horizontalGap, 0, 0, ARTBOARD_MAX),
        verticalGap: num(p.verticalGap, 0, 0, ARTBOARD_MAX),
        paddingTop: num(p.paddingTop, 0, 0, ARTBOARD_MAX),
        paddingRight: num(p.paddingRight, 0, 0, ARTBOARD_MAX),
        paddingBottom: num(p.paddingBottom, 0, 0, ARTBOARD_MAX),
        paddingLeft: num(p.paddingLeft, 0, 0, ARTBOARD_MAX),
        squareCells,
        autoFit,
        alignment: p.alignment === "start" || p.alignment === "end" ? p.alignment : "center",
        cellFill: typeof p.cellFill === "string" ? p.cellFill : "#F4F4F5",
        cellRadius: num(p.cellRadius, 12, 0, 500),
        iconCount: Math.round(clampNum(finiteOr(p.iconCount, rows * columns), 1, rows * columns)),
        unusedCells: p.unusedCells === "empty" ? "empty" : "hidden",
      };
      break;
    }
    case "text":
      el.properties = {
        content: typeof p.content === "string" ? p.content.slice(0, TEXT_CONTENT_MAX) : "Text",
        fontFamily: typeof p.fontFamily === "string" ? p.fontFamily : "sans-serif",
        fontSize: num(p.fontSize, 48, 1, 2000),
        fontWeight: num(p.fontWeight, 400, 100, 900),
        lineHeight: num(p.lineHeight, 1.2, 0.1, 10),
        letterSpacing: num(p.letterSpacing, 0, -10, 200),
        align: p.align === "left" || p.align === "center" || p.align === "right" ? p.align : "left",
        color: typeof p.color === "string" ? p.color : "#18181B",
        autoFit: p.autoFit !== false,
      };
      break;
    case "svg": {
      const svgStr = typeof p.svg === "string" ? p.svg : "";
      if (!svgStr || !/<svg[\s>]/i.test(svgStr)) notes.push("cleared invalid SVG source");
      if (svgStr.length > SVG_SOURCE_MAX_BYTES) notes.push("dropped oversized SVG source");
      el.properties = {
        svg: svgStr.length > SVG_SOURCE_MAX_BYTES ? "" : svgStr,
        viewBox: typeof p.viewBox === "string" ? p.viewBox : "0 0 300 300",
        sourceWidth: num(p.sourceWidth, 300, 1, ARTBOARD_MAX),
        sourceHeight: num(p.sourceHeight, 300, 1, ARTBOARD_MAX),
      };
      break;
    }
    default:
      el.properties = {
        fill: typeof p.fill === "string" ? p.fill : "#E4E4E7",
        stroke: typeof p.stroke === "string" ? p.stroke : "none",
        strokeWidth: num(p.strokeWidth, 0, 0, 200),
        opacity: num(p.opacity, 1, 0, 1),
        cornerRadius: num(p.cornerRadius, 0, 0, 500),
        sides: type === "polygon" ? Math.round(clampNum(finiteOr(p.sides, 3), 3, 12)) : 0,
      };
      break;
  }
  return { el, notes };
}

export interface SanitizeResult {
  doc: BuilderDocument | null;
  notes: string[];
}

/** Rebuild a possibly-corrupt document row into a valid BuilderDocument. */
export function sanitizeDocument(raw: unknown): SanitizeResult {
  if (typeof raw !== "object" || raw === null) return { doc: null, notes: ["row is not an object"] };
  const r = raw as Record<string, unknown>;
  const notes: string[] = [];

  const artboardRaw = (typeof r.artboard === "object" && r.artboard !== null ? r.artboard : {}) as Record<string, unknown>;
  const width = Math.round(clampNum(finiteOr(artboardRaw.width, 1200), ARTBOARD_MIN, ARTBOARD_MAX));
  const height = Math.round(clampNum(finiteOr(artboardRaw.height, 1200), ARTBOARD_MIN, ARTBOARD_MAX));
  if (Math.abs(width - finiteOr(artboardRaw.width, width)) > 0.5) notes.push(`repaired artboard width to ${width}`);
  if (Math.abs(height - finiteOr(artboardRaw.height, height)) > 0.5) notes.push(`repaired artboard height to ${height}`);

  const rawElements = Array.isArray(r.elements) ? r.elements : [];
  if (!Array.isArray(r.elements)) notes.push("elements was not an array — started empty");
  const seen = new Set<string>();
  const elements: BuilderElement[] = [];
  for (let i = 0; i < rawElements.length; i++) {
    const { el, notes: elNotes } = sanitizeElement(rawElements[i], i, seen);
    if (elNotes.length) notes.push(`element ${i + 1}: ${elNotes.join("; ")}`);
    if (el) elements.push(el);
  }
  elements.forEach((el, i) => (el.zIndex = i));

  const doc: BuilderDocument = {
    id: typeof r.id === "string" && r.id ? r.id : newId("doc"),
    name: typeof r.name === "string" && r.name.trim() ? r.name.slice(0, 120) : "Untitled Template",
    version: 1,
    artboard: {
      width,
      height,
      background: typeof artboardRaw.background === "string" ? artboardRaw.background : "#FFFFFF",
    },
    elements,
    metadata: {
      createdAt: finiteOr((r.metadata as Record<string, unknown> | undefined)?.createdAt, Date.now()),
      updatedAt: finiteOr((r.metadata as Record<string, unknown> | undefined)?.updatedAt, Date.now()),
      /* publish link survives corruption repair (string or null only) */
      publishedTemplateId:
        typeof (r.metadata as Record<string, unknown> | undefined)?.publishedTemplateId === "string"
          ? ((r.metadata as Record<string, unknown>).publishedTemplateId as string)
          : null,
    },
  };
  return { doc, notes };
}
