/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 1) · document model.
 *
 * The BuilderDocument is the AUTHORITATIVE source of truth for a template
 * layout. The SVG canvas is only a rendering of this state — never the
 * other way around. This model is deliberately structured (typed, finite,
 * validated) so Phase 2 can feed it into the template registry and the
 * universal renderer without rebuilding the editor.
 *
 * Design rules:
 *   · TYPE (what it renders as) and ROLE (what it means semantically) are
 *     independent — `type:"text" role:"category"` and `type:"text"
 *     role:"decorative"` are both valid. Phase 2 depends on this split.
 *   · `elements[]` array order IS the z-order (index 0 = bottom). The
 *     `zIndex` field is kept in sync with the array index on every
 *     reorder — the array stays authoritative.
 *   · Every number is finite; every dimension positive (lines may use a
 *     zero height/width as a flat bbox). validation.ts guards the rules.
 */

/* ------------------------------------------------------------------ */
/* Element types & semantic roles                                      */
/* ------------------------------------------------------------------ */

export const ELEMENT_TYPES = [
  "background",
  "icon-grid",
  "text",
  "rectangle",
  "rounded-rectangle",
  "circle",
  "ellipse",
  "line",
  "polygon",
  "svg",
] as const;
export type BuilderElementType = (typeof ELEMENT_TYPES)[number];

export const ELEMENT_ROLES = [
  "background",
  "icon-grid",
  "hero",
  "category",
  "icon-count",
  "volume",
  "descriptor",
  "decorative",
  "text",
  "shape",
  "svg",
] as const;
export type BuilderRole = (typeof ELEMENT_ROLES)[number];

/** Builder roles the Studio replaces with live sheet data when the
 *  template is used (mapped text roles). Order = reading-order priority. */
export const MAPPED_TEXT_ROLES: BuilderRole[] = ["category", "icon-count", "volume", "descriptor"];

/** Human labels for the role <select> — grouped by meaning. */
export const ROLE_GROUPS: { group: string; roles: { value: BuilderRole; label: string }[] }[] = [
  {
    group: "Structure",
    roles: [
      { value: "background", label: "Background" },
      { value: "icon-grid", label: "Icon grid" },
      { value: "hero", label: "Hero" },
    ],
  },
  {
    group: "Text semantics",
    roles: [
      { value: "category", label: "Category Title" },
      { value: "icon-count", label: "Icon Count" },
      { value: "volume", label: "Volume" },
      { value: "descriptor", label: "Descriptor" },
      { value: "text", label: "Text" },
    ],
  },
  {
    group: "Visual",
    roles: [
      { value: "decorative", label: "Decorative" },
      { value: "shape", label: "Shape" },
      { value: "svg", label: "SVG artwork" },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Role ⇄ type compatibility (§27 — incompatible combos are impossible) */
/* ------------------------------------------------------------------ */

/** Roles a text element may carry (semantic text roles + plain/decorative). */
const TEXT_ROLE_ALLOWED: BuilderRole[] = [...MAPPED_TEXT_ROLES, "text", "decorative"];
/** Roles a shape/SVG element may carry (visual/structural roles only). */
const SHAPE_ROLE_ALLOWED: BuilderRole[] = ["hero", "decorative", "shape", "svg", "background"];

/** Which roles the Role dropdown offers for an element of this type —
 *  a text layer can never become the icon grid, a rectangle can never
 *  become the Category Title (§27). Fixed-role types return []. */
export function rolesForElementType(type: BuilderElementType): BuilderRole[] {
  switch (type) {
    case "text":
      return TEXT_ROLE_ALLOWED;
    case "background":
      return [];
    case "icon-grid":
      return [];
    default:
      return SHAPE_ROLE_ALLOWED;
  }
}

/** Placeholder content the builder shows for a mapped text role (§11).
 *  Icon Count is special: its placeholder is DERIVED from the grid's
 *  usable icon count — never a stored, hardcoded string. */
export function rolePlaceholderContent(role: BuilderRole, gridIconCount: number): string {
  switch (role) {
    case "category":
      return "Category title";
    case "icon-count":
      return `${gridIconCount} ICONS`;
    case "volume":
      return "VOL. 01";
    case "descriptor":
      return "A short descriptor line";
    default:
      return "";
  }
}

/* ------------------------------------------------------------------ */
/* Limits — single source of truth for every clamp in the builder      */
/* ------------------------------------------------------------------ */

export const ARTBOARD_MIN = 16;
export const ARTBOARD_MAX = 20000;
export const GRID_ROWS_MAX = 64;
export const GRID_COLS_MAX = 64;
/** Hard render-safety cap: rows*columns above this warns instead of drawing. */
export const GRID_CELLS_RENDER_MAX = 4096;
export const HISTORY_LIMIT = 100;
export const SVG_SOURCE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
export const TEXT_CONTENT_MAX = 5000;
/** Upper bound for the flattened template artwork a published record may
 *  carry (sourceSvg + editableSvg are both derived from the elements, so a
 *  doc stuffed with 2 MB SVG artwork could otherwise triple per record). */
export const TEMPLATE_ARTWORK_MAX_BYTES = 4 * 1024 * 1024; // 4 MB

export const BUILDER_ZOOM_MIN = 0.05;
export const BUILDER_ZOOM_MAX = 8;

/* ------------------------------------------------------------------ */
/* Artboard                                                            */
/* ------------------------------------------------------------------ */

export interface BuilderArtboard {
  width: number;
  height: number;
  /** base fill rendered under every element */
  background: string;
}

/* ------------------------------------------------------------------ */
/* Per-type property payloads                                          */
/* ------------------------------------------------------------------ */

export interface GridElementProperties {
  rows: number;
  columns: number;
  /** cell geometry — with squareCells on, cellWidth === cellHeight at
   *  every write site (geometry + properties UI enforce it) */
  cellWidth: number;
  cellHeight: number;
  horizontalGap: number;
  verticalGap: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  squareCells: boolean;
  /** auto fit = derive the largest cell that fits the grid area */
  autoFit: boolean;
  /** horizontal placement of the cell block inside the padded area */
  alignment: "start" | "center" | "end";
  cellFill: string;
  cellRadius: number;
  /** how many grid positions (in reading order) are USABLE icon slots.
   *   capacity for publishing = iconCount (never rows×columns blindly);
   *   positions beyond it stay in the layout but never receive icons. */
  iconCount: number;
  /** what the PUBLISHED template does with positions beyond iconCount:
   *   "empty" → the cell card artwork is kept but holds no icon;
   *   "hidden" → the cell is not part of the published artwork. */
  unusedCells: "empty" | "hidden";
}

/** Factory defaults for a fresh icon-grid — the single object both
 *  createElement() and “Reset grid” restore (never two divergent copies). */
export function defaultGridProperties(): GridElementProperties {
  return {
    rows: 3,
    columns: 10,
    cellWidth: 80,
    cellHeight: 80,
    horizontalGap: 20,
    verticalGap: 20,
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    squareCells: true,
    alignment: "center",
    cellFill: "#F4F4F5",
    cellRadius: 12,
    iconCount: 30,
    unusedCells: "hidden",
    /* §16 — fresh grids AUTO-FIT their region: the largest square cell
     * that fits the assigned area, recalculated on every rows/columns /
     * size change (no broken intermediate states). Manual sizing stays
     * available by turning Auto fit off. */
    autoFit: true,
  };
}

/** Factory defaults for a fresh text element (Reset text restores these). */
export function defaultTextProperties(): TextElementProperties {
  return {
    content: "Category title",
    fontFamily: DEFAULT_FONT_STACK,
    fontSize: 48,
    fontWeight: 700,
    lineHeight: 1.2,
    letterSpacing: 0,
    align: "left",
    color: "#18181B",
    autoFit: true,
  };
}

export interface TextElementProperties {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
  align: "left" | "center" | "right";
  color: string;
  /** Auto Fit (§13): ON → the rendered font size is the largest size ≤
   *  fontSize that fits the text box (real measurement, glyphs never
   * stretched, manual line breaks preserved). OFF → fontSize is exact. */
  autoFit: boolean;
}

export interface ShapeElementProperties {
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  /** rounded-rectangle corner radius */
  cornerRadius: number;
  /** regular polygon side count (type "polygon") */
  sides: number;
}

export interface SvgElementProperties {
  /** sanitized original markup — vector data is never rasterized */
  svg: string;
  viewBox: string;
  sourceWidth: number;
  sourceHeight: number;
}

export interface BackgroundElementProperties {
  fill: string;
}

export type ElementProperties =
  | GridElementProperties
  | TextElementProperties
  | ShapeElementProperties
  | SvgElementProperties
  | BackgroundElementProperties
  | Record<string, never>;

/* ------------------------------------------------------------------ */
/* Element                                                             */
/* ------------------------------------------------------------------ */

export interface BuilderElement {
  id: string;
  type: BuilderElementType;
  role: BuilderRole;
  /** author-facing name shown in the Layers panel */
  name: string;
  /** local-frame geometry; rotation spins around the center */
  x: number;
  y: number;
  width: number;
  height: number;
  /** degrees, clockwise, normalized to (-180, 180] */
  rotation: number;
  visible: boolean;
  locked: boolean;
  /** synced with the elements[] index (array order is authoritative) */
  zIndex: number;
  /** element-level opacity (0–1) applied over type-specific styling */
  opacity: number;
  properties: ElementProperties;
}

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

export interface BuilderDocumentMetadata {
  createdAt: number;
  updatedAt: number;
  /** id of the published CustomTemplateRecord this draft is linked to
   *  (set on first “Save Template”; re-saving UPDATES that record in place
   *  so existing sheets keep their templateId reference). Null/absent =
 *  draft not published yet. */
  publishedTemplateId?: string | null;
}

export interface BuilderDocument {
  id: string;
  name: string;
  /** model version — bump when the shape evolves (Phase 2 migration hook) */
  version: 1;
  artboard: BuilderArtboard;
  elements: BuilderElement[];
  metadata: BuilderDocumentMetadata;
}

/* ------------------------------------------------------------------ */
/* Type guards for property payloads                                   */
/* ------------------------------------------------------------------ */

export function getGridProps(el: BuilderElement): GridElementProperties | null {
  if (el.type !== "icon-grid") return null;
  const p = el.properties as unknown;
  if (typeof p !== "object" || p === null || !("rows" in p) || !("columns" in p)) return null;
  return p as GridElementProperties;
}

export function getTextProps(el: BuilderElement): TextElementProperties | null {
  if (el.type !== "text") return null;
  const p = el.properties as unknown;
  if (typeof p !== "object" || p === null || !("content" in p)) return null;
  return p as TextElementProperties;
}

export function getShapeProps(el: BuilderElement): ShapeElementProperties | null {
  if (!["rectangle", "rounded-rectangle", "circle", "ellipse", "line", "polygon"].includes(el.type)) {
    return null;
  }
  return el.properties as ShapeElementProperties;
}

export function getSvgProps(el: BuilderElement): SvgElementProperties | null {
  return el.type === "svg" ? (el.properties as SvgElementProperties) : null;
}

export function getBackgroundProps(el: BuilderElement): BackgroundElementProperties | null {
  return el.type === "background" ? (el.properties as BackgroundElementProperties) : null;
}

/* ------------------------------------------------------------------ */
/* IDs                                                                 */
/* ------------------------------------------------------------------ */

/** Stable unique id (crypto when available). */
export function newId(prefix = "el"): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return `${prefix}_${c.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ */
/* Element factories — every insert path flows through these defaults  */
/* ------------------------------------------------------------------ */

export const DEFAULT_FONT_STACK =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export interface CreateElementInput {
  type: BuilderElementType;
  role?: BuilderRole;
  artboard: BuilderArtboard;
  /** optional geometry override (used by duplicate/import) */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  properties?: ElementProperties;
  name?: string;
}

const TYPE_LABELS: Record<BuilderElementType, string> = {
  background: "Background",
  "icon-grid": "Icon Grid",
  text: "Text",
  rectangle: "Rectangle",
  "rounded-rectangle": "Rounded Rectangle",
  circle: "Circle",
  ellipse: "Ellipse",
  line: "Line",
  polygon: "Polygon",
  svg: "SVG Artwork",
};

export function createElement(input: CreateElementInput): BuilderElement {
  const { type, artboard } = input;
  const el: BuilderElement = {
    id: newId("el"),
    type,
    role: input.role ?? defaultRoleForType(type),
    name: input.name ?? TYPE_LABELS[type],
    x: input.x ?? 0,
    y: input.y ?? 0,
    width: input.width ?? 100,
    height: input.height ?? 100,
    rotation: 0,
    visible: true,
    locked: false,
    zIndex: 0,
    opacity: 1,
    properties: {},
  };

  switch (type) {
    case "background":
      el.x = input.x ?? 0;
      el.y = input.y ?? 0;
      el.width = input.width ?? artboard.width;
      el.height = input.height ?? artboard.height;
      el.properties = { fill: artboard.background };
      el.name = "Background";
      break;
    case "icon-grid": {
      // defaults that FIT a fresh 1200×1200 board: 10×3 cells of 80px with
      // 20px gaps inside a 1060×400 area (content 980×280, centered)
      const w = input.width ?? 1060;
      const h = input.height ?? 400;
      el.x = input.x ?? Math.round((artboard.width - w) / 2);
      el.y = input.y ?? Math.round(artboard.height * 0.42);
      el.width = w;
      el.height = h;
      el.properties = input.properties ?? defaultGridProperties();
      break;
    }
    case "text": {
      const w = input.width ?? 640;
      el.x = input.x ?? Math.round((artboard.width - w) / 2);
      el.y = input.y ?? Math.round(artboard.height * 0.14);
      el.width = w;
      el.height = input.height ?? 72;
      el.properties = input.properties ?? defaultTextProperties();
      break;
    }
    case "rectangle":
    case "rounded-rectangle":
    case "circle":
    case "ellipse":
    case "line":
    case "polygon": {
      const dims = defaultShapeSize(type);
      el.x = input.x ?? Math.round((artboard.width - dims.w) / 2);
      el.y = input.y ?? Math.round((artboard.height - dims.h) / 2);
      el.width = input.width ?? dims.w;
      el.height = input.height ?? dims.h;
      el.properties = {
        fill: type === "line" ? "none" : "#E4E4E7",
        stroke: type === "line" ? "#3F3F46" : "#A1A1AA",
        strokeWidth: type === "line" ? 4 : 0,
        opacity: 1,
        cornerRadius: type === "rounded-rectangle" ? 16 : 0,
        sides: type === "polygon" ? 3 : 0,
      };
      break;
    }
    case "svg":
      el.properties =
        input.properties ??
        ({ svg: "", viewBox: "0 0 300 300", sourceWidth: 300, sourceHeight: 300 } satisfies SvgElementProperties);
      break;
  }
  if (input.properties && type !== "svg" && type !== "background") el.properties = input.properties;
  return el;
}

function defaultRoleForType(type: BuilderElementType): BuilderRole {
  switch (type) {
    case "background":
      return "background";
    case "icon-grid":
      return "icon-grid";
    case "text":
      return "text";
    case "svg":
      return "svg";
    default:
      return "shape";
  }
}

function defaultShapeSize(type: BuilderElementType): { w: number; h: number } {
  switch (type) {
    case "circle":
      return { w: 160, h: 160 };
    case "ellipse":
      return { w: 220, h: 140 };
    case "line":
      return { w: 240, h: 0 };
    case "polygon":
      return { w: 160, h: 160 };
    default:
      return { w: 240, h: 160 };
  }
}

/* ------------------------------------------------------------------ */
/* Hero placeholder factory — insert panel + “Reset hero” share this   */
/* ------------------------------------------------------------------ */

/** A selectable/resizable hero area: a soft rounded rectangle carrying
 *  role "hero". Its geometry is INDEPENDENT from the icon grid (mandate:
 *  resizing the hero never resizes cells, the artboard or the grid). */
export function createHeroElement(artboard: BuilderArtboard): BuilderElement {
  const w = 480;
  const h = 480;
  return {
    id: newId("el"),
    type: "rectangle",
    role: "hero",
    name: "Hero",
    x: Math.round((artboard.width - w) / 2),
    y: Math.round(artboard.height * 0.55),
    width: w,
    height: h,
    rotation: 0,
    visible: true,
    locked: false,
    zIndex: 0,
    opacity: 1,
    properties: {
      fill: "rgba(217,119,6,0.04)",
      stroke: "none",
      strokeWidth: 0,
      opacity: 1,
      cornerRadius: 4,
      sides: 0,
    },
  };
}

export function typeLabel(type: BuilderElementType): string {
  return TYPE_LABELS[type];
}

export function roleLabel(role: BuilderRole): string {
  const found = ROLE_GROUPS.flatMap((g) => g.roles).find((r) => r.value === role);
  return found ? found.label : role;
}
