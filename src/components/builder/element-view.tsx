"use client";

/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 1) · element rendering.
 *
 * Pure state→SVG rendering. Every element type renders inside its own
 * `<g>` positioned from the DOCUMENT MODEL (translate + rotate around the
 * element center). Components are memoized so a drag preview only
 * re-renders the element being dragged — the grid is generated
 * mathematically from geometry.ts (never per-cell DOM hand-placement).
 */

import { memo, useEffect, useMemo, useRef } from "react";
import {
  getBackgroundProps,
  getGridProps,
  getShapeProps,
  getSvgProps,
  getTextProps,
  type BuilderElement,
} from "@/lib/builder/types";
import { computeGridMetrics, gridCellRects } from "@/lib/builder/geometry";
import { fitBuilderText } from "@/lib/builder/text-fit";

/* ------------------------------------------------------------------ */
/* Live interaction preview (doc-coordinate overrides)                 */
/* ------------------------------------------------------------------ */

export interface ElementPreview {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
}

/* ------------------------------------------------------------------ */
/* SVG artwork — vector-preserving nested <svg>                        */
/* ------------------------------------------------------------------ */

const innerCache = new Map<string, string>();

/** Extract the inner markup of a stored outer <svg> (cached — the parse
 *  happens exactly once per unique source string, never per frame). */
function svgInnerContent(outer: string): string {
  const cached = innerCache.get(outer);
  if (cached !== undefined) return cached;
  let inner = "";
  try {
    const doc = new DOMParser().parseFromString(outer, "image/svg+xml");
    const root = doc.documentElement;
    if (root && root.nodeName.toLowerCase() === "svg") {
      inner = root.innerHTML;
    }
  } catch {
    inner = "";
  }
  if (innerCache.size > 60) innerCache.clear(); // bound the cache
  innerCache.set(outer, inner);
  return inner;
}

function SvgArtwork({
  markup,
  viewBox,
  width,
  height,
}: {
  markup: string;
  viewBox: string;
  width: number;
  height: number;
}) {
  const hostRef = useRef<SVGSVGElement | null>(null);
  const inner = useMemo(() => svgInnerContent(markup), [markup]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = inner;
  }, [inner]);
  /* explicit pixel size — percentages here would resolve against the
   * ARTBOARD viewport, not this element's box (verified bug in QA) */
  return (
    <svg
      ref={hostRef}
      x={0}
      y={0}
      width={width}
      height={height}
      viewBox={viewBox}
      overflow="visible"
    />
  );
}

/* ------------------------------------------------------------------ */
/* Regular polygon points                                              */
/* ------------------------------------------------------------------ */

function polygonPoints(w: number, h: number, sides: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2;
  const pts: string[] = [];
  const n = Math.max(3, Math.round(sides));
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

/* ------------------------------------------------------------------ */
/* Element view                                                        */
/* ------------------------------------------------------------------ */

function ElementViewImpl({
  el,
  preview,
  zoom,
  semanticContent,
}: {
  el: BuilderElement;
  preview?: ElementPreview;
  zoom: number;
  /** derived display content for semantic text roles (Icon Count — §5:
   *  derived from the grid, never stored); undefined → the author's words */
  semanticContent?: string;
}) {
  if (!el.visible) return null;

  const x = preview?.x ?? el.x;
  const y = preview?.y ?? el.y;
  const w = preview?.width ?? el.width;
  const h = preview?.height ?? el.height;
  const rotation = preview?.rotation ?? el.rotation;
  const cx = w / 2;
  const cy = h / 2;
  const transform =
    rotation !== 0 ? `translate(${x} ${y}) rotate(${rotation} ${cx} ${cy})` : `translate(${x} ${y})`;

  const grid = getGridProps(el);
  const metrics = grid ? computeGridMetrics({ ...el, width: w, height: h }) : null;

  return (
    <g
      transform={transform}
      opacity={el.opacity}
      data-element-id={el.id}
      style={{ cursor: "move" }}
    >
      {/* ---------------- background ---------------- */}
      {el.type === "background" &&
        (() => {
          const p = getBackgroundProps(el);
          return <rect x={0} y={0} width={w} height={h} fill={p?.fill ?? "#FFFFFF"} />;
        })()}

      {/* ---------------- shapes ---------------- */}
      {(el.type === "rectangle" || el.type === "rounded-rectangle") &&
        (() => {
          const p = getShapeProps(el);
          return (
            <rect
              x={0}
              y={0}
              width={w}
              height={h}
              rx={el.type === "rounded-rectangle" ? Math.min(p?.cornerRadius ?? 0, Math.min(w, h) / 2) : 0}
              fill={p?.fill ?? "none"}
              stroke={p?.stroke && (p?.strokeWidth ?? 0) > 0 ? p.stroke : "none"}
              strokeWidth={p?.strokeWidth ?? 0}
            />
          );
        })()}

      {el.type === "circle" &&
        (() => {
          const p = getShapeProps(el);
          return (
            <circle
              cx={cx}
              cy={cy}
              r={Math.max(0, Math.min(w, h) / 2)}
              fill={p?.fill ?? "none"}
              stroke={p?.stroke && (p?.strokeWidth ?? 0) > 0 ? p.stroke : "none"}
              strokeWidth={p?.strokeWidth ?? 0}
            />
          );
        })()}

      {el.type === "ellipse" &&
        (() => {
          const p = getShapeProps(el);
          return (
            <ellipse
              cx={cx}
              cy={cy}
              rx={Math.max(0, w / 2)}
              ry={Math.max(0, h / 2)}
              fill={p?.fill ?? "none"}
              stroke={p?.stroke && (p?.strokeWidth ?? 0) > 0 ? p.stroke : "none"}
              strokeWidth={p?.strokeWidth ?? 0}
            />
          );
        })()}

      {el.type === "line" &&
        (() => {
          const p = getShapeProps(el);
          return (
            <>
              <line
                x1={0}
                y1={0}
                x2={w}
                y2={h}
                stroke={p?.stroke ?? "#3F3F46"}
                strokeWidth={Math.max(1, p?.strokeWidth ?? 2)}
                strokeLinecap="round"
              />
              {/* fat invisible twin for reliable hit-testing */}
              <line x1={0} y1={0} x2={w} y2={h} stroke="transparent" strokeWidth={Math.max(12, 12 / zoom)} />
            </>
          );
        })()}

      {el.type === "polygon" &&
        (() => {
          const p = getShapeProps(el);
          return (
            <polygon
              points={polygonPoints(w, h, p?.sides ?? 3)}
              fill={p?.fill ?? "none"}
              stroke={p?.stroke && (p?.strokeWidth ?? 0) > 0 ? p.stroke : "none"}
              strokeWidth={p?.strokeWidth ?? 0}
              strokeLinejoin="round"
            />
          );
        })()}

      {/* ---------------- text ---------------- */}
      {el.type === "text" &&
        (() => {
          const p = getTextProps(el);
          if (!p) return null;
          /* resolved display values — semantic override (Icon Count) and
           * autoFit fitted size (§13) mirror exactly what publish compiles */
          const content = semanticContent ?? p.content;
          const renderSize = p.autoFit
            ? fitBuilderText(p, content, w, h).fontSize
            : p.fontSize;
          const lines = (content || " ").split("\n");
          const anchor = p.align === "left" ? "start" : p.align === "center" ? "middle" : "end";
          const tx = p.align === "left" ? 0 : p.align === "center" ? cx : w;
          return (
            <g>
              <text
                x={tx}
                y={0}
                fill={p.color}
                fontFamily={p.fontFamily}
                fontSize={renderSize}
                fontWeight={p.fontWeight}
                letterSpacing={p.letterSpacing}
                textAnchor={anchor}
                style={{ whiteSpace: "pre" }}
              >
                {lines.map((line, i) => (
                  <tspan key={i} x={tx} dy={i === 0 ? renderSize * 0.8 : renderSize * p.lineHeight}>
                    {line === "" ? " " : line}
                  </tspan>
                ))}
              </text>
              {/* invisible box so empty/short text stays grabbable */}
              <rect x={0} y={0} width={w} height={h} fill="transparent" />
            </g>
          );
        })()}

      {/* ---------------- imported SVG ---------------- */}
      {el.type === "svg" &&
        (() => {
          const p = getSvgProps(el);
          if (!p || !p.svg) return null;
          return (
            <g>
              <SvgArtwork markup={p.svg} viewBox={p.viewBox} width={w} height={h} />
              <rect x={0} y={0} width={w} height={h} fill="transparent" />
            </g>
          );
        })()}

      {/* ---------------- icon grid (mathematically generated) ---------------- */}
      {grid && metrics &&
        (() => {
          if (!metrics.renderable) {
            return (
              <rect
                x={0}
                y={0}
                width={w}
                height={h}
                fill="none"
                stroke="#F59E0B"
                strokeWidth={2 / zoom}
                strokeDasharray={`${6 / zoom} ${4 / zoom}`}
              />
            );
          }
          const rects = gridCellRects({ ...el, width: w, height: h });
          /* iconCount splits the cells into ACTIVE slots (reading order) and
           * unused positions — an EDITOR-ONLY distinction (dashed overlays)
           * that never reaches the published template: compile emits unused
           * cells per the grid's unusedCells mode, with no markers. */
          const iconCount = Math.min(Math.max(1, grid.iconCount || rects.length), rects.length);
          return (
            <g>
              {rects.map((r, i) => {
                const active = i < iconCount;
                if (!active && grid.unusedCells === "hidden") {
                  /* ghost — the position exists but is not part of the
                   * published artwork; shown so users never lose track of it */
                  return (
                    <rect
                      key={i}
                      x={r.x}
                      y={r.y}
                      width={r.w}
                      height={r.h}
                      rx={Math.min(grid.cellRadius, Math.min(r.w, r.h) / 2)}
                      fill="none"
                      stroke="#71717A"
                      strokeWidth={1 / zoom}
                      strokeDasharray={`${4 / zoom} ${3 / zoom}`}
                      opacity={0.55}
                    />
                  );
                }
                return (
                  <rect
                    key={i}
                    x={r.x}
                    y={r.y}
                    width={r.w}
                    height={r.h}
                    rx={Math.min(grid.cellRadius, Math.min(r.w, r.h) / 2)}
                    fill={grid.cellFill}
                  />
                );
              })}
              {/* unused-but-visible cells get a dashed amber overlay so the
               * “this card stays but holds no icon” state is unmistakable */}
              {grid.unusedCells === "empty" &&
                rects.slice(iconCount).map((r, k) => (
                  <rect
                    key={`u${k}`}
                    x={r.x}
                    y={r.y}
                    width={r.w}
                    height={r.h}
                    rx={Math.min(grid.cellRadius, Math.min(r.w, r.h) / 2)}
                    fill="none"
                    stroke="#D97706"
                    strokeWidth={1.5 / zoom}
                    strokeDasharray={`${5 / zoom} ${3 / zoom}`}
                    pointerEvents="none"
                  />
                ))}
              {/* first dropped position carries a tiny editor-only label */}
              {iconCount < rects.length && (
                <text
                  x={rects[iconCount].x + rects[iconCount].w / 2}
                  y={rects[iconCount].y - 6 / zoom}
                  textAnchor="middle"
                  fontSize={11 / zoom}
                  fontWeight={600}
                  fill={grid.unusedCells === "hidden" ? "#71717A" : "#D97706"}
                  pointerEvents="none"
                >
                  +{rects.length - iconCount} unused
                </text>
              )}
              {/* validation state: impossible geometry is never silently distorted */}
              {!metrics.fits && (
                <g>
                  <rect
                    x={0}
                    y={0}
                    width={w}
                    height={h}
                    fill="none"
                    stroke="#DC2626"
                    strokeWidth={2 / zoom}
                    strokeDasharray={`${8 / zoom} ${5 / zoom}`}
                  />
                  <text
                    x={w / 2}
                    y={-10 / zoom}
                    textAnchor="middle"
                    fontSize={13 / zoom}
                    fontWeight={600}
                    fill="#DC2626"
                  >
                    Grid does not fit — reduce spacing/padding or enlarge the area
                  </text>
                </g>
              )}
            </g>
          );
        })()}

      {/* ---------------- hero role placeholder styling ---------------- */}
      {el.role === "hero" && el.type !== "background" && el.type !== "icon-grid" && (
        <g pointerEvents="none">
          <rect
            x={0.5}
            y={0.5}
            width={Math.max(0, w - 1)}
            height={Math.max(0, h - 1)}
            fill="none"
            stroke="#D97706"
            strokeWidth={1.5 / zoom}
            strokeDasharray={`${7 / zoom} ${4 / zoom}`}
            rx={4}
          />
          <text
            x={cx}
            y={cy + 4 / zoom}
            textAnchor="middle"
            fontSize={12 / zoom}
            fontWeight={700}
            letterSpacing={(2 / zoom) as number}
            fill="#D97706"
          >
            HERO
          </text>
        </g>
      )}
    </g>
  );
}

export const ElementView = memo(ElementViewImpl);
