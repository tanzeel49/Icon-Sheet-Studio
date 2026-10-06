/**
 * ICON SHEET STUDIO — Built-in template library.
 * Templates are data, not code paths. The renderer never special-cases a
 * capacity: everything is derived from template.regions + template.grid.
 *
 * The 8 built-ins replicate the user's default icon sheets 1:1
 * (uploads: "27/30/36/40/44/50/55/60 Icon Sheet.svg", Illustrator
 * exports). Geometry below is measured from those files in canvas units:
 *
 *   · Wide landscape canvases (6000–7976 × 2000–2500), white background
 *   · Left rail: navy gradient (#152A54→#0C1A38), rounded outer corners
 *   · VOL ribbon: blue gradient flag (#3E82FB→#1F5FE0) with chevron notch
 *   · Icon cells: square, per-cell navy gradient, radius 36/45
 *   · Hero slot: solid #0E1B3B with #3E82FB stroke
 *   · Format pills: AI / SVG / EPS / PNG badges in the rail footer
 *
 * Three geometry families (measured):
 *   A  27/30  — H 2000, rail 1000/r50, cell 577.06 r36, pitch 648.48
 *   B  36/40/44 — H 2500, rail 1250/r62.5, cell 534.96 r45, pitch 601.2
 *   C  50/55/60 — H 2400, rail 1200/r60, cell 414.41 r36, pitch 465.7
 */

import type { CustomTemplateRecord, RailStyle, Rect, SheetDesign, SheetTemplateSnapshot, TemplateDef, TemplateRail } from "./types";
import { customDesignDefaultsFromRoles } from "./custom-template";

/** Kept for backward compatibility as the ultimate fallback (store, presets).
 * The built-in templates all ship their own defaults. */
export function createDefaultDesign(): SheetDesign {
  return {
    background: "#F5F2EB",
    card: {
      visible: true,
      color: "#FFFFFF",
      opacity: 1,
      borderWidth: 0,
      borderColor: "#E5E0D5",
      radius: 18,
      shadow: true,
      shadowStrength: 0.1,
      shadowBlur: 14,
      shadowX: 0,
      shadowY: 5,
      shadowColor: "#1F1D17",
      gradient: null,
      showEmptyCells: false,
    },
    hero: {
      iconScale: 0.62,
      offsetX: 0,
      offsetY: 0,
      cardSize: 256,
      cardOffsetX: 0,
      cardOffsetY: 0,
      card: {
        visible: true,
        color: "#1F1D17",
        opacity: 1,
        borderWidth: 0,
        borderColor: "#E5E0D5",
        radius: 32,
      },
      shadow: true,
      shadowStrength: 0.18,
      shadowBlur: 24,
      shadowX: 0,
      shadowY: 10,
      shadowColor: "#1F1D17",
    },
    icon: {
      /* px stroke model — plain weight delta (0 = exact original), no
       * uniform stroke, original icon colors. No legacy fields persisted.
       * The full current schema is stamped from the start (uniformStroke /
       * uniformTargetPx) so new-sheet records never rely on read-time
       * fallbacks. */
      strokeWeightPx: 0,
      uniformStroke: false,
      uniformTargetPx: 2,
      tintIcons: false,
      tintColor: "#1F1D17",
    },
    typography: {
      category: {
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSize: 58,
        fontWeight: 800,
        letterSpacing: -1,
        lineHeight: 1.08,
        align: "start",
        color: "#1F1D17",
        uppercase: true,
        offsetX: 0,
        offsetY: 0,
        /* round 17: the title auto-fits the category region by default */
        autoFit: true,
      },
      volume: {
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSize: 21,
        fontWeight: 700,
        letterSpacing: 3,
        lineHeight: 1,
        align: "start",
        color: "#8A8578",
        uppercase: true,
        offsetX: 0,
        offsetY: 0,
      },
      caption: {
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: 17,
        fontWeight: 400,
        letterSpacing: 0,
        lineHeight: 1.55,
        align: "start",
        color: "#6B6759",
        uppercase: false,
        offsetX: 0,
        offsetY: 0,
      },
      footer: {
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: 2.5,
        lineHeight: 1,
        align: "start",
        color: "#A19B8C",
        uppercase: true,
        offsetX: 0,
        offsetY: 0,
      },
    },
    captionText: "A curated set of vector icons, crafted for modern interfaces. Scalable, consistent and pixel-perfect.",
    footerText: "",
    spacing: {
      gap: 22,
      cellPadding: 0.16,
      iconScale: 0.86,
    },
    rail: undefined,
    geometryOverrides: {},
  };
}

/* ------------------------------------------------------------------ */
/* User default-sheet design language                                  */
/* ------------------------------------------------------------------ */

const ARIAL = "Arial, Helvetica, sans-serif";

/** Rail paint shared by every default sheet (measured once). */
const USER_RAIL: RailStyle = {
  visible: true,
  from: "#152A54",
  to: "#0C1A38",
  angle: -45,
  ribbon: {
    visible: true,
    from: "#3E82FB",
    to: "#1F5FE0",
    angle: 0,
  },
  pills: {
    visible: true,
    color: "#1B2D53",
    labelColor: "#DCE6FA",
    labels: ["AI", "SVG", "EPS", "PNG"],
  },
};

/** Measured per-family metrics of the default sheets. */
interface FamilySpec {
  /** canvas height */
  canvasH: number;
  /** cell outer size */
  cell: number;
  /** grid pitch (cell + gap) */
  pitch: number;
  /** grid gap = pitch - cell */
  gap: number;
  /** grid top edge */
  gridY: number;
  cellRadius: number;
  rail: {
    width: number;
    radius: number;
    ribbon: { x: number; y: number; w: number; h: number; notch: number };
    pills: { x: number; y: number; w: number; h: number; gap: number; radius: number };
  };
  hero: {
    x: number;
    y: number;
    size: number;
    radius: number;
    strokeWidth: number;
  };
  type: {
    volX: number;
    volBaseline: number;
    volSize: number;
    catSize: number;
    catBaseline: number;
    countSize: number;
    countLs: number;
    countBaseline: number;
    subSize: number;
    subLs: number;
    subBaseline: number;
  };
}

/** Family A — 27/30 (canvas H 2000) */
const FAMILY_A: FamilySpec = {
  canvasH: 2000,
  cell: 577.06,
  pitch: 648.48,
  gap: 71.42,
  gridY: 63,
  cellRadius: 36,
  rail: {
    width: 1000,
    radius: 50,
    ribbon: { x: 4.7, y: 92.52, w: 457.12, h: 147.3, notch: 78.73 },
    pills: { x: 86.86, y: 1817.43, w: 180.74, h: 78.87, gap: 33.16, radius: 18 },
  },
  hero: { x: 226.51, y: 772.46, size: 542.21, radius: 72, strokeWidth: 8.22 },
  type: {
    volX: 43.94,
    volBaseline: 194.46,
    volSize: 79.04,
    catSize: 124.05,
    catBaseline: 475.74,
    countSize: 115.01,
    countLs: 3,
    countBaseline: 1544,
    subSize: 36.15,
    subLs: 5,
    subBaseline: 1722.95,
  },
};

/** Family B — 36/40/44 (canvas H 2500) */
const FAMILY_B: FamilySpec = {
  canvasH: 2500,
  cell: 534.96,
  pitch: 601.2,
  gap: 66.24,
  gridY: 80.8,
  cellRadius: 45,
  rail: {
    width: 1250,
    radius: 62.5,
    ribbon: { x: 5.88, y: 115.65, w: 571.4, h: 184.12, notch: 98.41 },
    pills: { x: 108.6, y: 2271.8, w: 225.92, h: 98.58, gap: 41.1, radius: 18 },
  },
  hero: { x: 283.14, y: 965.58, size: 677.75, radius: 90, strokeWidth: 10.27 },
  type: {
    volX: 54.9,
    volBaseline: 243.1,
    volSize: 98.8,
    catSize: 155.1,
    catBaseline: 594.7,
    countSize: 143.8,
    countLs: 4,
    countBaseline: 1930,
    subSize: 45.2,
    subLs: 6,
    subBaseline: 2153.7,
  },
};

/** Family C — 50/55/60 (canvas H 2400) */
const FAMILY_C: FamilySpec = {
  canvasH: 2400,
  cell: 414.41,
  pitch: 465.7,
  gap: 51.29,
  gridY: 61.39,
  cellRadius: 36,
  rail: {
    width: 1200,
    radius: 60,
    ribbon: { x: 0, y: 95.35, w: 556.43, h: 179.65, notch: 95.83 },
    pills: { x: 100, y: 2195, w: 220, h: 96, gap: 40, radius: 18 },
  },
  hero: { x: 270, y: 923.01, size: 660, radius: 72, strokeWidth: 10 },
  type: {
    volX: 47.76,
    volBaseline: 219.44,
    volSize: 96.21,
    catSize: 151,
    catBaseline: 561.83,
    countSize: 140,
    countLs: 4,
    countBaseline: 1862.17,
    subSize: 44,
    subLs: 6,
    subBaseline: 2080,
  },
};

/** One template per uploaded default sheet. */
interface SheetSpec {
  id: string;
  capacity: number;
  cols: number;
  rows: number;
  /** canvas width (measured, decimals preserved) */
  canvasW: number;
  /** grid left edge (outer) */
  gridX: number;
  family: FamilySpec;
}

const SHEETS: SheetSpec[] = [
  { id: "t27", capacity: 27, cols: 9, rows: 3, canvasW: 6948.37, gridX: 1064.47, family: FAMILY_A },
  { id: "t30", capacity: 30, cols: 10, rows: 3, canvasW: 7580, gridX: 1064.47, family: FAMILY_A },
  { id: "t36", capacity: 36, cols: 9, rows: 4, canvasW: 6777.15, gridX: 1330.6, family: FAMILY_B },
  { id: "t40", capacity: 40, cols: 10, rows: 4, canvasW: 7385.51, gridX: 1330.6, family: FAMILY_B },
  { id: "t44", capacity: 44, cols: 11, rows: 4, canvasW: 7975.69, gridX: 1327.6, family: FAMILY_B },
  { id: "t50", capacity: 50, cols: 10, rows: 5, canvasW: 6000, gridX: 1290, family: FAMILY_C },
  { id: "t55", capacity: 55, cols: 11, rows: 5, canvasW: 6470, gridX: 1290, family: FAMILY_C },
  { id: "t60", capacity: 60, cols: 12, rows: 5, canvasW: 6930, gridX: 1289.3, family: FAMILY_C },
];

/** Baseline math: renderTextBlock puts line i at region.y + fontSize*(0.8+i·lh).
 *  Solving for the measured baseline gives region.y = baseline - 0.8·fontSize. */
function regionYForBaseline(baseline: number, fontSize: number): number {
  return Math.round((baseline - fontSize * 0.8) * 100) / 100;
}

function createUserDesign(spec: SheetSpec): SheetDesign {
  const f = spec.family;
  const t = f.type;
  return {
    background: "#FFFFFF",
    card: {
      visible: true,
      color: "#152A54",
      opacity: 1,
      borderWidth: 0,
      borderColor: "#0C1A38",
      radius: f.cellRadius,
      shadow: false,
      shadowStrength: 0,
      shadowBlur: 0,
      shadowX: 0,
      shadowY: 0,
      shadowColor: "#000000",
      gradient: { from: "#152A54", to: "#0C1A38", angle: 0 },
      showEmptyCells: true,
    },
    hero: {
      iconScale: 0.62,
      offsetX: 0,
      offsetY: 0,
      cardSize: f.hero.size,
      cardOffsetX: 0,
      cardOffsetY: 0,
      card: {
        visible: true,
        color: "#0E1B3B",
        opacity: 1,
        borderWidth: f.hero.strokeWidth,
        borderColor: "#3E82FB",
        radius: f.hero.radius,
      },
      shadow: false,
      shadowStrength: 0,
      shadowBlur: 0,
      shadowX: 0,
      shadowY: 0,
      shadowColor: "#000000",
    },
    icon: {
      /* px stroke model + the family's signature white icon tint */
      strokeWeightPx: 0,
      tintIcons: true,
      tintColor: "#FFFFFF",
    },
    typography: {
      category: {
        fontFamily: ARIAL,
        fontSize: t.catSize,
        fontWeight: 700,
        letterSpacing: 0,
        lineHeight: 1.2,
        align: "middle",
        color: "#FFFFFF",
        uppercase: true,
        offsetX: 0,
        offsetY: 0,
        /* round 17: the title auto-fits the rail's category region by
         * default — reset restores this behavior */
        autoFit: true,
      },
      volume: {
        fontFamily: ARIAL,
        fontSize: t.volSize,
        fontWeight: 700,
        fontStyle: "italic",
        letterSpacing: 1,
        lineHeight: 1,
        align: "start",
        color: "#FFFFFF",
        uppercase: true,
        offsetX: 0,
        offsetY: 0,
      },
      caption: {
        fontFamily: ARIAL,
        fontSize: t.subSize,
        fontWeight: 700,
        letterSpacing: t.subLs,
        lineHeight: 1,
        align: "middle",
        color: "#7C93C4",
        uppercase: true,
        offsetX: 0,
        offsetY: 0,
      },
      footer: {
        fontFamily: ARIAL,
        fontSize: t.countSize,
        fontWeight: 700,
        letterSpacing: t.countLs,
        lineHeight: 1,
        align: "middle",
        color: "#FFFFFF",
        uppercase: true,
        offsetX: 0,
        offsetY: 0,
      },
    },
    captionText: "OUTLINE STYLE · EDITABLE",
    footerText: `${spec.capacity} ICONS`,
    spacing: {
      gap: f.gap,
      cellPadding: 0,
      iconScale: 0.62,
    },
    rail: structuredClone(USER_RAIL),
    geometryOverrides: {},
  };
}

function buildUserTemplate(spec: SheetSpec): TemplateDef {
  const f = spec.family;
  const t = f.type;
  const gridW = spec.cols * f.cell + (spec.cols - 1) * f.gap;
  const gridH = spec.rows * f.cell + (spec.rows - 1) * f.gap;

  const rail: TemplateRail = {
    width: f.rail.width,
    radius: f.rail.radius,
    ribbon: { ...f.rail.ribbon },
    pills: { ...f.rail.pills },
    defaults: structuredClone(USER_RAIL),
  };

  return {
    id: spec.id,
    name: `${spec.capacity} Icon`,
    capacity: spec.capacity,
    width: spec.canvasW,
    height: f.canvasH,
    grid: { cols: spec.cols, rows: spec.rows, gap: f.gap },
    regions: {
      grid: { x: spec.gridX, y: f.gridY, width: Math.round(gridW * 100) / 100, height: Math.round(gridH * 100) / 100 },
      hero: { x: f.hero.x, y: f.hero.y, width: f.hero.size, height: f.hero.size },
      volume: { x: t.volX, y: regionYForBaseline(t.volBaseline, t.volSize), width: 420, height: Math.round(t.volSize * 1.2) },
      category: {
        x: 0,
        y: regionYForBaseline(t.catBaseline, t.catSize),
        width: f.rail.width,
        height: Math.round(t.catSize * 2.4),
      },
      caption: {
        x: 0,
        y: regionYForBaseline(t.subBaseline, t.subSize),
        width: f.rail.width,
        height: Math.round(t.subSize * 1.4),
      },
      footer: {
        x: 0,
        y: regionYForBaseline(t.countBaseline, t.countSize),
        width: f.rail.width,
        height: Math.round(t.countSize * 1.4),
      },
    },
    rail,
    defaults: createUserDesign(spec),
    builtIn: true,
  };
}

/* ------------------------------------------------------------------ */
/* "Design Warsa Temp" template                                        */
/*                                                                      */
/* Built-in replicated 1:1 from the USER-UPLOADED design (upload:      */
/* "Design Warsa Temp.svg", Adobe Illustrator 30 export). The SVG is   */
/* the immutable visual master — every constant below is measured      */
/* from its actual structure in canvas units:                          */
/*                                                                      */
/*   · Canvas 8083.47 × 2200, white background                          */
/*   · Left rail: SOLID #1C1C1C, 1021.429 wide, full height, r 0       */
/*   · Accent: flat #FF7A3D bar 535.714 × 13.393 at (242.857,          */
/*     1478.607) — occupies the ribbon slot with notch 0 (plain rect)  */
/*   · Hero: WHITE rounded card 635.906 × 635.905 at (192.761,         */
/*     390.793), radius 87.814, dark hero icon (iconColor #1C1C1C)     */
/*   · Cells: flat #1C1C1C squares 608.167 (r 0), 10 × 3 = 30 icons,   */
/*     pitch 695.048 h / 695.627 v (gap 86.881) from (1120.651, 100)   */
/*   · Type: Calibri-Bold 160 "Document" @ (104.7626, 1297.02) ls 1    */
/*     white · Arial-BoldMT 93.75 "30 ICONS" @ (250.5046, 1631.3064)   */
/*     #FF7A3D ls 13 · ArialMT 53.5714 "VECTOR LINE SET" @            */
/*     (242.4152, 1746.4642) #B7B7B7 ls 4                              */
/*                                                                      */
/* The design language inverts the navy families: dark rail + white     */
/* hero card + flat orange accent, no gradients, no format pills, and  */
/* NO volume label — the volume style ships visible:false (the         */
/* TextStyle.visible master switch) so nothing renders until the user   */
/* toggles it back on from the Typography panel. The category ships    */
/* with autoFit OFF: the default title renders byte-exact at the       */
/* master's own 160px size and 1297.02 baseline (the auto-fit engine   */
/* stays one toggle away in the Typography panel).                     */
/*                                                                      */
/* Replaces the earlier "Document" (tdoc30) registration, which was    */
/* built from a different upload and did not match this master. A      */
/* legacy id alias below keeps sheets saved against tdoc30 resolving  */
/* to THIS template — the corrected geometry.                           */
/* ------------------------------------------------------------------ */

const WSA_ARIAL = "Arial, Helvetica, sans-serif";
/** Calibri is the uploaded artwork's font; Carlito is the metric-compatible
 * open clone (Linux/LO), Segoe UI/Trebuchet keep the humanist feel elsewhere. */
const WSA_CALIBRI = "Calibri, 'Segoe UI', Carlito, 'Trebuchet MS', sans-serif";

/** rail paint: solid dark rail, flat orange accent bar, no format pills. */
const WSA_RAIL: RailStyle = {
  visible: true,
  from: "#1C1C1C",
  to: "#1C1C1C",
  angle: 0,
  ribbon: { visible: true, from: "#FF7A3D", to: "#FF7A3D", angle: 0 },
  pills: { visible: false, color: "#2A2A2A", labelColor: "#FFFFFF", labels: [] },
};

function createDesignWarsaDesign(): SheetDesign {
  return {
    background: "#FFFFFF",
    bgGradient: null,
    card: {
      visible: true,
      color: "#1C1C1C",
      opacity: 1,
      borderWidth: 0,
      borderColor: "#000000",
      radius: 0,
      shadow: false,
      shadowStrength: 0,
      shadowBlur: 0,
      shadowX: 0,
      shadowY: 0,
      shadowColor: "#000000",
      gradient: null,
      showEmptyCells: true,
    },
    hero: {
      iconScale: 0.62,
      offsetX: 0,
      offsetY: 0,
      cardSize: 635.905,
      cardOffsetX: 0,
      cardOffsetY: 0,
      card: {
        visible: true,
        color: "#FFFFFF",
        opacity: 1,
        borderWidth: 0,
        borderColor: "#E5E0D5",
        radius: 87.814,
      },
      shadow: false,
      shadowStrength: 0,
      shadowBlur: 0,
      shadowX: 0,
      shadowY: 0,
      shadowColor: "#000000",
      /* dark hero icon on the WHITE card — inverse of the navy families */
      iconColor: "#1C1C1C",
    },
    icon: {
      /* white icons on the flat dark cells (family stroke language) */
      strokeWeightPx: 0,
      uniformStroke: false,
      uniformTargetPx: 2,
      tintIcons: true,
      tintColor: "#FFFFFF",
    },
    typography: {
      /* title "Document" — Calibri-Bold 160px white at x 104.7626,
       * baseline 1297.02 (the master's own numbers). autoFit OFF by
       * default: the classic block lands the baseline at region.y +
       * 0.8·160 = 1297.02 EXACTLY, so the fresh sheet renders the master
       * byte-exact. The region height (257.3) still caps the auto-fit
       * engine at ≈160px should the user toggle it on. */
      category: {
        fontFamily: WSA_CALIBRI,
        fontSize: 160,
        fontWeight: 700,
        letterSpacing: 1,
        lineHeight: 1.2,
        align: "start",
        color: "#FFFFFF",
        uppercase: false,
        offsetX: 0,
        offsetY: 0,
        autoFit: false,
      },
      /* no volume label in this design — hidden (TextStyle.visible).
       * Toggling it back on shows an orange VOL stamp at the top-left
       * of the rail. */
      volume: {
        fontFamily: WSA_ARIAL,
        fontSize: 48,
        fontWeight: 700,
        letterSpacing: 2,
        lineHeight: 1,
        align: "start",
        color: "#FF7A3D",
        uppercase: true,
        offsetX: 0,
        offsetY: 0,
        visible: false,
      },
      /* "VECTOR LINE SET" — Arial 53.5714px #B7B7B7 ls 4, baseline 1746.464 */
      caption: {
        fontFamily: WSA_ARIAL,
        fontSize: 53.5714,
        fontWeight: 400,
        letterSpacing: 4,
        lineHeight: 1,
        align: "start",
        color: "#B7B7B7",
        uppercase: false,
        offsetX: 0,
        offsetY: 0,
      },
      /* "30 ICONS" — Arial-Bold 93.75px #FF7A3D ls 13, baseline 1631.306.
       * Template-owned capacity stamp: the store swaps it on template
       * switches, exactly like the navy family's "N ICONS" lines. */
      footer: {
        fontFamily: WSA_ARIAL,
        fontSize: 93.75,
        fontWeight: 700,
        letterSpacing: 13,
        lineHeight: 1,
        align: "start",
        color: "#FF7A3D",
        uppercase: true,
        offsetX: 0,
        offsetY: 0,
      },
    },
    captionText: "VECTOR LINE SET",
    footerText: "30 ICONS",
    spacing: {
      gap: 86.881,
      cellPadding: 0,
      iconScale: 0.62,
    },
    rail: structuredClone(WSA_RAIL),
    geometryOverrides: {},
  };
}

function buildDesignWarsaTemplate(): TemplateDef {
  /* grid: 10 × 3 cells of 608.167 (measured 608.167 × 608.746 — the
   * renderer draws square cells; 0.58u of 608 = 0.09%, invisible). The
   * region width is the lattice's own width, so cell math is x-exact:
   * left edge 1120.651, right edge 7984.248, rows centered on y = 100. */
  return {
    id: "design-warsa-temp",
    name: "Design Warsa Temp",
    capacity: 30,
    width: 8083.47,
    height: 2200,
    grid: { cols: 10, rows: 3, gap: 86.881 },
    regions: {
      grid: { x: 1120.651, y: 100, width: 6863.599, height: 1998.263 },
      /* white rounded card 192.761→828.667 × 390.793→1026.698 (r 87.814) */
      hero: { x: 192.761, y: 390.793, width: 635.906, height: 635.905 },
      /* hidden by default (volume style visible:false) — parked at the
       * rail's top-left so re-enabling it lands somewhere sensible */
      volume: { x: 104.762, y: 100, width: 420, height: 58 },
      /* classic title block (autoFit: false): baseline = y + 0.8·160 =
       * 1297.02 — the master's own "Document" baseline; x is the master's
       * own 104.7626. Height 257.3 caps the auto-fit engine at ≈160px. */
      category: { x: 104.7626, y: 1169.02, width: 850, height: 257.3 },
      /* "VECTOR LINE SET" baseline 1703.607 + 0.8·53.5714 = 1746.464 */
      caption: { x: 242.415, y: 1703.607, width: 779.014, height: 75 },
      /* "30 ICONS" baseline 1556.306 + 0.8·93.75 = 1631.306 */
      footer: { x: 250.505, y: 1556.306, width: 770.925, height: 131.25 },
    },
    rail: {
      width: 1021.429,
      radius: 0,
      /* flat orange accent bar (535.714 × 13.393 at 242.857, 1478.607) —
       * notch 0 renders the ribbon slot as a plain rectangle, exactly the
       * uploaded artwork */
      ribbon: { x: 242.857, y: 1478.607, w: 535.714, h: 13.393, notch: 0 },
      pills: { x: 0, y: 0, w: 0, h: 0, gap: 0, radius: 0 },
      defaults: structuredClone(WSA_RAIL),
    },
    defaults: createDesignWarsaDesign(),
    builtIn: true,
  };
}

export const BUILTIN_TEMPLATES: TemplateDef[] = [
  ...SHEETS.map(buildUserTemplate),
  buildDesignWarsaTemplate(),
];

const TEMPLATE_MAP = new Map(BUILTIN_TEMPLATES.map((t) => [t.id, t]));

/** Legacy id → current template id. "tdoc30" was the earlier "Document"
 *  registration of this same design family (built from a different upload,
 * did not match the current master). Sheets persisted against it resolve
 * to the corrected "Design Warsa Temp" definition — no dead ids, no dead
 * sheets. Pickers never list the legacy id (they iterate the registry). */
const LEGACY_TEMPLATE_IDS = new Map<string, string>([
  ["tdoc30", "design-warsa-temp"],
]);

/* ------------------------------------------------------------------ */
/* Custom (user-imported) template registry — universal template       */
/* support. Official templates above are PROTECTED: nothing in this    */
/* section ever touches them. Custom templates live in IndexedDB and  */
/* are injected here at hydrate time so every existing consumer       */
/* (getTemplate / listTemplates) resolves them transparently.         */
/* ------------------------------------------------------------------ */

let customTemplates: TemplateDef[] = [];
const CUSTOM_MAP = new Map<string, TemplateDef>();

/** Design defaults for imported templates. WITH detected roles (v3): every
 *  value equals the template's own original paint/typography, so a fresh
 *  sheet renders the uploaded artwork byte-faithfully and each Properties
 *  edit diffs against what the template itself shipped. WITHOUT roles
 *  (annotation failed / pre-v3 record): the historical placeholder design —
 *  the renderer then embeds the original artwork verbatim. */
function createCustomDefaultDesign(record: CustomTemplateRecord): SheetDesign {
  return customDesignDefaultsFromRoles(
    record.roles,
    record.roles?.heroSlotSize ?? (record.heroSlot ? Math.min(record.heroSlot.width, record.heroSlot.height) : null),
    createDefaultDesign()
  );
}

/** Record → TemplateDef conversion (also used by the Template Builder's
 *  preview so the builder shows EXACTLY what the Studio will render —
 *  one conversion path, never a second renderer). */
export function buildCustomTemplate(record: CustomTemplateRecord): TemplateDef {
  /* informational grid stats derived from the detected slots */
  const sorted = [...record.iconSlots].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = new Set<number>();
  let lastY = Number.NaN;
  for (const s of sorted) {
    if (!Number.isNaN(lastY) && Math.abs(s.y - lastY) <= s.height * 0.7) continue;
    rows.add(s.y);
    lastY = s.y;
  }
  const rowList = [...rows].sort((a, b) => a - b);
  let cols = 0;
  for (const ry of rowList) {
    const inRow = sorted.filter((s) => Math.abs(s.y - ry) < s.height * 0.7).length;
    cols = Math.max(cols, inRow);
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of record.iconSlots) {
    minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.width); maxY = Math.max(maxY, s.y + s.height);
  }
  const gridRect: Rect = record.iconSlots.length
    ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    : { x: 0, y: 0, width: record.width, height: record.height };
  const zero = { x: 0, y: 0, width: 0, height: 0 };
  return {
    id: record.id,
    name: record.name,
    capacity: record.capacity,
    width: record.width,
    height: record.height,
    grid: { cols: cols || record.capacity, rows: rowList.length || 1, gap: record.grid?.gap ?? 0 },
    /* regions are compatibility fillers — the custom renderer ignores them
     * (no text areas or cards are drawn for imported templates) */
    regions: {
      grid: gridRect,
      hero: record.heroSlot ?? gridRect,
      volume: zero,
      category: zero,
      caption: zero,
      footer: zero,
    },
    defaults: createCustomDefaultDesign(record),
    builtIn: false,
    sourceType: "custom",
    custom: {
      sourceSvg: record.sourceSvg,
      viewBox: record.viewBox,
      iconSlots: record.iconSlots,
      heroSlot: record.heroSlot,
      createdAt: record.createdAt,
      metadata: record.metadata,
      /* v3 — role-annotated copy + captured roles (absent on legacy records;
       * hydrate backfills them in memory) */
      editableSvg: record.editableSvg,
      roles: record.roles,
      /* phase 3 — record revision this def was built from. Sheets pin their
       * own version via Sheet.templateSnapshot; sheetTemplate() compares
       * the two to decide which one renders. */
      version: customRecordVersion(record),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Sheet → template resolution (phase 3 — version pinning)            */
/* ------------------------------------------------------------------ */

/** A record's revision, sanitized: absent/invalid → 1 (legacy records). */
export function customRecordVersion(record: CustomTemplateRecord): number {
  const v = record.version;
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

/** Snapshot-ready copy of a record — the authoring document (builderDoc)
 * is intentionally dropped: rendering/editing never need it and “Edit in
 * Builder” always resolves through the live library record. */
export function stripBuilderDoc(record: CustomTemplateRecord): Omit<CustomTemplateRecord, "builderDoc"> {
  if (!record.builderDoc) return record;
  const { builderDoc: _dropped, ...rest } = record;
  return rest;
}

/** Build the immutable per-sheet snapshot for a custom record. */
export function buildSheetSnapshot(record: CustomTemplateRecord): SheetTemplateSnapshot {
  return {
    version: customRecordVersion(record),
    name: record.name,
    record: stripBuilderDoc(record),
  };
}

/* Snapshot TemplateDefs are derived records → derived cache. Keyed by
 * record id; invalidated by version (rebuilds when the sheet re-stamps to
 * a newer snapshot or an older one is re-requested after a newer cache hit). */
const SNAPSHOT_DEF_CACHE = new Map<string, { version: number; def: TemplateDef }>();

function snapshotTemplateDef(snap: SheetTemplateSnapshot): TemplateDef {
  const hit = SNAPSHOT_DEF_CACHE.get(snap.record.id);
  if (hit && hit.version === snap.version) return hit.def;
  const def = buildCustomTemplate(snap.record);
  SNAPSHOT_DEF_CACHE.set(snap.record.id, { version: snap.version, def });
  return def;
}

/** THE sheet → template resolver (phase 3). Every consumer that used to
 * call `getTemplate(sheet.templateId)` must call this instead: it prefers
 * the sheet's pinned snapshot whenever (a) the live record is gone (deleted
 * from the library — the sheet keeps rendering exactly as before) or (b)
 * the live record has moved to a newer version (edits never retroactively
 * restyle existing sheets). Same version or no snapshot → the live def.
 * A snapshot only ever belongs to the CUSTOM record the sheet pointed at
 * when it was stamped: if templateId now resolves to an official template
 * (the sheet was later switched), the live registry wins and the stale
 * snapshot is ignored. */
export function sheetTemplate(
  sheet: Pick<import("./types").Sheet, "templateId" | "templateSnapshot">
): TemplateDef | undefined {
  const snap = sheet.templateSnapshot;
  const live = getTemplate(sheet.templateId);
  if (!snap) return live;
  /* the snapshot is authoritative ONLY for its own record: live record
   * deleted, or that same record at a newer revision. A snapshot belonging
   * to a different template than templateId (hand-edited data) never wins. */
  if (
    !live ||
    (live.sourceType === "custom" &&
      live.id === snap.record.id &&
      live.custom?.version !== snap.version)
  ) {
    return snapshotTemplateDef(snap);
  }
  return live;
}

/** Hydrate-time injection (called by the store). Rebuilds the custom
 *  registry atomically; official templates are never affected. */
export function setCustomTemplateRegistry(records: CustomTemplateRecord[]): void {
  customTemplates = records.map(buildCustomTemplate);
  CUSTOM_MAP.clear();
  for (const t of customTemplates) CUSTOM_MAP.set(t.id, t);
}

export function getTemplate(id: string): TemplateDef | undefined {
  /* legacy ids resolve transparently to their successor template */
  const canonical = LEGACY_TEMPLATE_IDS.get(id) ?? id;
  return TEMPLATE_MAP.get(canonical) ?? CUSTOM_MAP.get(canonical);
}

export function listTemplates(): TemplateDef[] {
  return [...BUILTIN_TEMPLATES, ...customTemplates];
}

export function listOfficialTemplates(): TemplateDef[] {
  return BUILTIN_TEMPLATES;
}

export function listCustomTemplateDefs(): TemplateDef[] {
  return customTemplates;
}
