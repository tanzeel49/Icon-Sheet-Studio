/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 1) · pure geometry.
 *
 * Deterministic math for the Icon Grid, rotated bounding boxes, marquee
 * intersection, and alignment/distribution. No React, no DOM — 100%
 * pure functions so the exact same math drives the canvas renderer, the
 * properties panel readouts, and validation.
 */

import { getGridProps, GRID_CELLS_RENDER_MAX, type BuilderElement } from "./types";

/* ------------------------------------------------------------------ */
/* Icon grid — THE feature. One object generates its cells             */
/*                                                                     */
/*   availableWidth  = gridWidth  − padL − padR − (cols−1)·hGap        */
/*   availableHeight = gridHeight − padT − padB − (rows−1)·vGap        */
/*                                                                     */
/*   square cells → cellSize bounded by BOTH axes                      */
/*   auto fit     → cellSize = min(availableWidth, availableHeight)    */
/*   never distorted, never overlapped, never fractional-noisy         */
/* ------------------------------------------------------------------ */

export interface GridMetrics {
  rows: number;
  columns: number;
  /** rows × columns — ALWAYS derived, never stored stale */
  totalIcons: number;
  availableWidth: number;
  availableHeight: number;
  /** effective cell size after square/autoFit resolution */
  cellWidth: number;
  cellHeight: number;
  /** total size of the cell block */
  contentWidth: number;
  contentHeight: number;
  /** where the cell block starts inside the element box (padding + alignment) */
  originX: number;
  originY: number;
  /** false → the requested cell size does not fit the available area */
  fits: boolean;
  /** render-safety: cells above GRID_CELLS_RENDER_MAX are not drawn */
  renderable: boolean;
}

/** Round to 2 decimals — kills FP noise without visible snapping. */
const r2 = (n: number): number => Math.round(n * 100) / 100;

export function computeGridMetrics(el: BuilderElement): GridMetrics {
  const p = getGridProps(el);
  const rows = p?.rows ?? 1;
  const columns = p?.columns ?? 1;
  const hGap = p?.horizontalGap ?? 0;
  const vGap = p?.verticalGap ?? 0;
  const padT = p?.paddingTop ?? 0;
  const padR = p?.paddingRight ?? 0;
  const padB = p?.paddingBottom ?? 0;
  const padL = p?.paddingLeft ?? 0;
  const alignment = p?.alignment ?? "center";

  const availableWidth = el.width - padL - padR - (columns - 1) * hGap;
  const availableHeight = el.height - padT - padB - (rows - 1) * vGap;

  /* The available axes are the space for the CELLS themselves (gaps and
   * padding already subtracted), so the largest cell that fits is
   * avail/cols and avail/rows — never avail itself. */
  let cellWidth: number;
  let cellHeight: number;
  if (p?.autoFit) {
    // largest cell that fits both axes (square → min of the two)
    if (p.squareCells) {
      cellWidth = cellHeight = Math.max(0, Math.min(availableWidth / columns, availableHeight / rows));
    } else {
      cellWidth = Math.max(0, availableWidth / columns);
      cellHeight = Math.max(0, availableHeight / rows);
    }
  } else {
    cellWidth = p?.cellWidth ?? 0;
    cellHeight = p?.squareCells ? cellWidth : (p?.cellHeight ?? cellWidth);
  }

  const contentWidth = columns * cellWidth + (columns - 1) * hGap;
  const contentHeight = rows * cellHeight + (rows - 1) * vGap;

  // horizontal placement of the block inside the padded area
  const slack = availableWidth - contentWidth;
  let blockX = padL;
  if (alignment === "center") blockX = padL + slack / 2;
  else if (alignment === "end") blockX = padL + slack;
  const blockY = padT; // vertical placement stays top-anchored (grid rows stack down)

  const fits =
    availableWidth > 0 &&
    availableHeight > 0 &&
    cellWidth * columns <= availableWidth + 1e-9 &&
    cellHeight * rows <= availableHeight + 1e-9;

  return {
    rows,
    columns,
    totalIcons: rows * columns,
    availableWidth: r2(availableWidth),
    availableHeight: r2(availableHeight),
    cellWidth: r2(cellWidth),
    cellHeight: r2(cellHeight),
    contentWidth: r2(contentWidth),
    contentHeight: r2(contentHeight),
    originX: r2(Math.max(0, blockX)),
    originY: r2(Math.max(0, blockY)),
    fits,
    renderable: rows * columns <= GRID_CELLS_RENDER_MAX,
  };
}

/** Positions of every cell (local element coordinates). Pure + memoizable. */
export function gridCellRects(el: BuilderElement): { x: number; y: number; w: number; h: number }[] {
  const m = computeGridMetrics(el);
  if (!m.renderable) return [];
  const p = getGridProps(el)!;
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  for (let row = 0; row < m.rows; row++) {
    for (let col = 0; col < m.columns; col++) {
      rects.push({
        x: m.originX + col * (m.cellWidth + p.horizontalGap),
        y: m.originY + row * (m.cellHeight + p.verticalGap),
        w: m.cellWidth,
        h: m.cellHeight,
      });
    }
  }
  return rects;
}

/* ------------------------------------------------------------------ */
/* Rotated element geometry                                            */
/* ------------------------------------------------------------------ */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The four corners of an element in DOCUMENT coordinates (rotation applied). */
export function elementCorners(el: BuilderElement): { x: number; y: number }[] {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const rad = (el.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = el.width / 2;
  const hh = el.height / 2;
  const local: { x: number; y: number }[] = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
  return local.map((p) => ({
    x: cx + p.x * cos - p.y * sin,
    y: cy + p.x * sin + p.y * cos,
  }));
}

/** Axis-aligned bounding box of a (possibly rotated) element. */
export function elementBBox(el: BuilderElement): Rect {
  const corners = elementCorners(el);
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** Union bbox of several elements (null when empty). */
export function elementsBBox(els: BuilderElement[]): Rect | null {
  if (els.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of els) {
    for (const c of elementCorners(el)) {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.x > maxX) maxX = c.x;
      if (c.y > maxY) maxY = c.y;
    }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/* ------------------------------------------------------------------ */
/* Alignment & distribution                                            */
/* ------------------------------------------------------------------ */

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
export type DistributeAxis = "horizontal" | "vertical";

export interface GeometryPatch {
  id: string;
  x?: number;
  y?: number;
}

/** Alignment math on ROTATED bboxes: align the bbox edge, keep geometry. */
export function alignElements(
  els: BuilderElement[],
  mode: AlignMode,
  bounds: Rect
): GeometryPatch[] {
  if (els.length === 0) return [];
  return els.map((el) => {
    const b = elementBBox(el);
    // shift delta of the BBOX, applied to x/y (rotation preserved)
    let dx = 0;
    let dy = 0;
    switch (mode) {
      case "left":
        dx = bounds.x - b.x;
        break;
      case "hcenter":
        dx = bounds.x + bounds.width / 2 - (b.x + b.width / 2);
        break;
      case "right":
        dx = bounds.x + bounds.width - (b.x + b.width);
        break;
      case "top":
        dy = bounds.y - b.y;
        break;
      case "vcenter":
        dy = bounds.y + bounds.height / 2 - (b.y + b.height / 2);
        break;
      case "bottom":
        dy = bounds.y + bounds.height - (b.y + b.height);
        break;
    }
    return { id: el.id, x: r2(el.x + dx), y: r2(el.y + dy) };
  });
}

/** Even spacing of bbox CENTERS along an axis (≥3 elements; endpoints pinned). */
export function distributeElements(els: BuilderElement[], axis: DistributeAxis): GeometryPatch[] {
  if (els.length < 3) return [];
  const withB = els.map((el) => ({ el, b: elementBBox(el) }));
  const key = axis === "horizontal" ? "x" : "y";
  const center = axis === "horizontal" ? (b: Rect) => b.x + b.width / 2 : (b: Rect) => b.y + b.height / 2;
  withB.sort((a, b) => center(a.b) - center(b.b));
  const first = center(withB[0].b);
  const last = center(withB[withB.length - 1].b);
  const n = withB.length;
  const gap = (last - first) / (n - 1);
  return withB.map((item, i) => {
    const target = first + gap * i;
    const current = center(item.b);
    const delta = target - current;
    const el = item.el;
    return axis === "horizontal"
      ? { id: el.id, x: r2(el.x + delta) }
      : { id: el.id, y: r2(el.y + delta) };
  });
}

export { r2 as round2 };
