"use client";

/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 1) · canvas workspace.
 *
 * The canvas is a RENDERING of the BuilderDocument plus an interaction
 * layer. Geometry model:
 *
 *   viewport (screen px, overflow hidden)
 *     └─ stage  — CSS `translate(pan) scale(zoom)`, origin 0 0
 *          └─ artboard <svg> — width/height in DOCUMENT units
 *
 *   docPoint(event) = (client − viewport.origin − pan) / zoom
 *
 * Interactions: click / shift-click / marquee selection, move, resize
 * (8 handles, rotation-aware local-axis math), rotate handle, Space+drag
 * pan (grab/grabbing), middle-drag pan, Ctrl/⌘+wheel zoom anchored at the
 * cursor, plain wheel = vertical pan, Shift+wheel = horizontal pan,
 * fit-to-screen. Drag previews live in local React state and commit to
 * the document ONCE on pointer-up — history and persistence never see
 * intermediate pixels. The hover cursor readout writes straight to the
 * DOM so idle mouse movement performs ZERO React renders.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Maximize, Minus, Plus } from "lucide-react";
import { useBuilderStore } from "@/lib/builder/store";
import { BUILDER_ZOOM_MAX, BUILDER_ZOOM_MIN, getGridProps, type BuilderElement } from "@/lib/builder/types";
import { elementBBox, rectsIntersect, round2, type Rect } from "@/lib/builder/geometry";
import { ElementView, type ElementPreview } from "./element-view";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Interaction state machine                                           */
/* ------------------------------------------------------------------ */

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rot";

const HANDLE_DIRS: Record<Exclude<HandleId, "rot">, [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

interface Interaction {
  mode: "none" | "pan" | "marquee" | "move" | "resize" | "rotate";
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startDocX: number;
  startDocY: number;
  startPanX: number;
  startPanY: number;
  /** move: element start positions */
  startPositions?: Map<string, { x: number; y: number }>;
  /** resize/rotate: element snapshot */
  snapshot?: BuilderElement;
  handle?: HandleId;
  marquee?: Rect;
  additive?: boolean;
  moved?: boolean;
  /** move: raw delta · resize/rotate: computed geometry */
  preview?: ElementPreview;
}

const NO_INTERACTION: Interaction = {
  mode: "none",
  pointerId: -1,
  startClientX: 0,
  startClientY: 0,
  startDocX: 0,
  startDocY: 0,
  startPanX: 0,
  startPanY: 0,
};

const MIN_SIZE = 4;

const TYPING_SELECTOR = "input, textarea, select, [contenteditable='true'], [contenteditable='']";
const OVERLAY_SELECTOR = "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']";

function normalizeAngle(deg: number): number {
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function BuilderCanvas({
  onRequestTextEdit,
}: {
  onRequestTextEdit?: (elementId: string) => void;
}) {
  const docs = useBuilderStore((s) => s.docs);
  const activeDocId = useBuilderStore((s) => s.activeDocId);
  const selection = useBuilderStore((s) => s.selection);
  const setSelection = useBuilderStore((s) => s.setSelection);
  const toggleSelection = useBuilderStore((s) => s.toggleSelection);
  const updateElements = useBuilderStore((s) => s.updateElements);
  const doc = useMemo(() => docs.find((d) => d.id === activeDocId) ?? null, [docs, activeDocId]);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const cursorRef = useRef<HTMLSpanElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [interaction, setInteraction] = useState<Interaction>(NO_INTERACTION);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [fittedFor, setFittedFor] = useState("");

  /* refs mirroring state for native listeners (no re-binds); synced in
   * an effect so listeners always read the committed values */
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  useEffect(() => {
    zoomRef.current = zoom;
    panRef.current = pan;
  }, [zoom, pan]);

  const elements = doc?.elements ?? [];
  const selectedElements = useMemo(
    () => elements.filter((el) => selection.includes(el.id)),
    [elements, selection]
  );

  /* §5/§19 — the LIVE Icon Count placeholder: derived from the grid's
   * usable icon count on every render, so rows/columns/icon-count changes
   * reflow it immediately (never a stored, stale string). */
  const iconCountPlaceholder = useMemo(() => {
    const grid = elements.find((el) => el.type === "icon-grid");
    const p = grid ? getGridProps(grid) : null;
    if (!p) return null;
    const count = Math.min(Math.max(1, p.iconCount || p.rows * p.columns), p.rows * p.columns);
    return `${count} ICONS`;
  }, [elements]);
  const semanticContentFor = useCallback(
    (el: BuilderElement): string | undefined =>
      el.role === "icon-count" ? (iconCountPlaceholder ?? undefined) : undefined,
    [iconCountPlaceholder]
  );

  /* ---------------- fit-to-screen ---------------- */

  const fitToScreen = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !doc) return;
    const rect = viewport.getBoundingClientRect();
    const pad = 72;
    const aw = doc.artboard.width;
    const ah = doc.artboard.height;
    const z = Math.min(
      BUILDER_ZOOM_MAX,
      Math.max(BUILDER_ZOOM_MIN, Math.min((rect.width - pad) / aw, (rect.height - pad) / ah))
    );
    setZoom(z);
    setPan({
      x: Math.round((rect.width - aw * z) / 2),
      y: Math.round((rect.height - ah * z) / 2),
    });
  }, [doc]);

  /* auto-fit when a document opens or its artboard size changes
   * (deferred to the next frame — the viewport is measured post-layout
   * and the lint rule forbids direct setState in effects) */
  useEffect(() => {
    if (!doc) return;
    const key = `${doc.id}:${doc.artboard.width}x${doc.artboard.height}`;
    if (fittedFor === key) return;
    const raf = requestAnimationFrame(() => {
      setFittedFor(key);
      fitToScreen();
    });
    return () => cancelAnimationFrame(raf);
  }, [doc, fittedFor, fitToScreen]);

  /* ---------------- coordinate helpers ---------------- */

  const docPoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = viewportRef.current?.getBoundingClientRect();
      const p = panRef.current;
      const z = zoomRef.current;
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left - p.x) / z, y: (clientY - rect.top - p.y) / z };
    },
    []
  );

  const zoomAt = useCallback(
    (factor: number, anchorClientX?: number, anchorClientY?: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const ax = anchorClientX ?? rect.left + rect.width / 2;
      const ay = anchorClientY ?? rect.top + rect.height / 2;
      const oldZ = zoomRef.current;
      const newZ = Math.min(BUILDER_ZOOM_MAX, Math.max(BUILDER_ZOOM_MIN, oldZ * factor));
      if (Math.abs(newZ - oldZ) < 1e-9) return;
      const p = panRef.current;
      const docX = (ax - rect.left - p.x) / oldZ;
      const docY = (ay - rect.top - p.y) / oldZ;
      setZoom(newZ);
      setPan({ x: Math.round(ax - rect.left - docX * newZ), y: Math.round(ay - rect.top - docY * newZ) });
    },
    []
  );

  /* ---------------- wheel: zoom / pan (native, non-passive) ---------------- */

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(-e.deltaY * 0.0018), e.clientX, e.clientY);
      } else if (e.shiftKey) {
        const dx = e.deltaX || e.deltaY;
        setPan((p) => ({ ...p, x: p.x - dx }));
      } else {
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  /* ---------------- Space key → pan mode ---------------- */

  useEffect(() => {
    const ignored = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      return (
        !!el &&
        typeof el.closest === "function" &&
        (!!el.closest(TYPING_SELECTOR) || !!el.closest(OVERLAY_SELECTOR))
      );
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== "Space") return;
      if (ignored(e.target)) return;
      e.preventDefault();
      if (e.repeat) return;
      setSpaceHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== "Space") return;
      setSpaceHeld(false);
    };
    const onBlur = (): void => setSpaceHeld(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  /* ---------------- zoom keyboard (0 fit · 1 = 100% · +/− steps) ----- */

  useEffect(() => {
    const ignored = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      return (
        !!el &&
        typeof el.closest === "function" &&
        (!!el.closest(TYPING_SELECTOR) || !!el.closest(OVERLAY_SELECTOR))
      );
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (ignored(e.target)) return;
      if (e.key === "0") {
        e.preventDefault();
        fitToScreen();
      } else if (e.key === "1") {
        e.preventDefault();
        setZoom(1);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomAt(1.25);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomAt(0.8);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fitToScreen, zoomAt]);

  /* ---------------- Escape cancels an in-flight interaction ---------------- *
   * capture phase on window fires before bubble listeners (incl. the
   * builder-level Escape) so cancelling a drag never ALSO clears the
   * selection. Typing targets keep their own Escape behavior. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest && (t.closest(TYPING_SELECTOR) || t.closest(OVERLAY_SELECTOR))) return;
      if (interaction.mode === "none" || interaction.mode === "pan") return;
      e.preventDefault();
      e.stopPropagation();
      setInteraction(NO_INTERACTION);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [interaction.mode]);

  /* ---------------- live previews ---------------- */

  /** move preview: absolute position for a dragged element */
  const movePreview = useCallback(
    (el: BuilderElement): ElementPreview | undefined => {
      if (interaction.mode !== "move" || !interaction.startPositions || !interaction.moved) return undefined;
      const start = interaction.startPositions.get(el.id);
      if (!start) return undefined;
      const raw = interaction.preview ?? { x: 0, y: 0 };
      return { x: start.x + (raw.x ?? 0), y: start.y + (raw.y ?? 0) };
    },
    [interaction]
  );

  /** resize/rotate preview for the single edited element */
  const editPreview = useCallback(
    (el: BuilderElement): ElementPreview | undefined => {
      if ((interaction.mode !== "resize" && interaction.mode !== "rotate") || interaction.snapshot?.id !== el.id) {
        return undefined;
      }
      return interaction.preview;
    },
    [interaction]
  );

  /* ---------------- pointer interactions ---------------- */

  const onViewportPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!doc) return;
      const viewport = viewportRef.current;
      if (!viewport) return;
      /* pan first: Space held OR middle mouse button */
      if (spaceHeld || e.button === 1) {
        e.preventDefault();
        try {
          viewport.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointer */
        }
        setInteraction({
          ...NO_INTERACTION,
          mode: "pan",
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startPanX: pan.x,
          startPanY: pan.y,
        });
        return;
      }
      if (e.button !== 0) return;

      const pt = docPoint(e.clientX, e.clientY);
      const target = (e.target as Element).closest?.("[data-element-id]") as SVGElement | null;
      const targetId = target?.getAttribute("data-element-id") ?? null;
      const targetEl = targetId ? elements.find((el) => el.id === targetId) : undefined;

      /* clicking a visible, unlocked element */
      if (targetEl && targetEl.visible && !targetEl.locked) {
        if (e.shiftKey) {
          toggleSelection(targetEl.id);
          return;
        }
        const ids = selection.includes(targetEl.id) ? selection : [targetEl.id];
        if (!selection.includes(targetEl.id)) setSelection(ids);
        const startPositions = new Map<string, { x: number; y: number }>();
        for (const id of ids) {
          const el = elements.find((x) => x.id === id);
          if (el && !el.locked && el.visible) startPositions.set(id, { x: el.x, y: el.y });
        }
        try {
          viewport.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        setInteraction({
          ...NO_INTERACTION,
          mode: "move",
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startDocX: pt.x,
          startDocY: pt.y,
          startPositions,
        });
        return;
      }

      /* empty area → marquee (shift = additive to current selection) */
      if (!e.shiftKey) setSelection([]);
      try {
        viewport.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      setInteraction({
        ...NO_INTERACTION,
        mode: "marquee",
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startDocX: pt.x,
        startDocY: pt.y,
        marquee: { x: pt.x, y: pt.y, width: 0, height: 0 },
        additive: e.shiftKey,
        moved: false,
      });
    },
    [doc, docPoint, elements, pan.x, pan.y, selection, setSelection, spaceHeld, toggleSelection]
  );

  const onViewportPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const pt = docPoint(e.clientX, e.clientY);
      /* hover readout — straight to the DOM, zero React renders */
      if (cursorRef.current && interaction.mode === "none") {
        cursorRef.current.textContent = `${Math.round(pt.x)}, ${Math.round(pt.y)}`;
      }

      if (interaction.mode === "none" || interaction.pointerId !== e.pointerId) return;

      if (interaction.mode === "pan") {
        setPan({
          x: interaction.startPanX + (e.clientX - interaction.startClientX),
          y: interaction.startPanY + (e.clientY - interaction.startClientY),
        });
        return;
      }

      if (interaction.mode === "marquee") {
        const x = Math.min(interaction.startDocX, pt.x);
        const y = Math.min(interaction.startDocY, pt.y);
        const w = Math.abs(pt.x - interaction.startDocX);
        const h = Math.abs(pt.y - interaction.startDocY);
        if (w > 2 || h > 2) {
          setInteraction((s) => (s.mode === "marquee" ? { ...s, moved: true, marquee: { x, y, width: w, height: h } } : s));
        }
        return;
      }

      if (interaction.mode === "move" && interaction.startPositions) {
        let dx = pt.x - interaction.startDocX;
        let dy = pt.y - interaction.startDocY;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const moved = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5;
        setInteraction((s) => (s.mode === "move" ? { ...s, moved, preview: { x: dx, y: dy } } : s));
        return;
      }

      if (interaction.mode === "resize" && interaction.snapshot && interaction.handle) {
        const next = computeResize(interaction.snapshot, interaction.handle, pt, e.shiftKey);
        setInteraction((s) => (s.mode === "resize" ? { ...s, moved: true, preview: next } : s));
        return;
      }

      if (interaction.mode === "rotate" && interaction.snapshot) {
        const cx = interaction.snapshot.x + interaction.snapshot.width / 2;
        const cy = interaction.snapshot.y + interaction.snapshot.height / 2;
        let deg = (Math.atan2(pt.y - cy, pt.x - cx) * 180) / Math.PI + 90;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        else {
          const card = Math.round(deg / 90) * 90;
          if (Math.abs(deg - card) < 3) deg = card;
        }
        setInteraction((s) => (s.mode === "rotate" ? { ...s, moved: true, preview: { rotation: normalizeAngle(deg) } } : s));
      }
    },
    [docPoint, interaction]
  );

  const onViewportPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (interaction.mode === "none" || interaction.pointerId !== e.pointerId) return;
      const viewport = viewportRef.current;
      try {
        viewport?.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }

      if (interaction.mode === "marquee" && interaction.moved && interaction.marquee) {
        const base = interaction.additive ? selection : [];
        const hit = elements
          .filter((el) => el.visible && !el.locked && rectsIntersect(elementBBox(el), interaction.marquee!))
          .map((el) => el.id);
        setInteraction(NO_INTERACTION);
        setSelection(Array.from(new Set([...base, ...hit])));
        return;
      }

      if (interaction.mode === "move" && interaction.moved && interaction.startPositions && interaction.preview) {
        const raw = interaction.preview;
        const patches: { id: string; x: number; y: number }[] = [];
        interaction.startPositions.forEach((start, id) => {
          patches.push({ id, x: round2(start.x + (raw.x ?? 0)), y: round2(start.y + (raw.y ?? 0)) });
        });
        setInteraction(NO_INTERACTION);
        if (patches.length > 0) {
          updateElements(
            patches.map((p) => p.id),
            (el) => {
              const patch = patches.find((p) => p.id === el.id);
              return patch ? { x: patch.x, y: patch.y } : {};
            },
            { label: `Move ${patches.length === 1 ? "element" : `${patches.length} elements`}` }
          );
        }
        return;
      }

      if (
        (interaction.mode === "resize" || interaction.mode === "rotate") &&
        interaction.snapshot &&
        interaction.moved &&
        interaction.preview
      ) {
        const id = interaction.snapshot.id;
        const p = interaction.preview;
        setInteraction(NO_INTERACTION);
        updateElements([id], { ...p }, { label: interaction.mode === "resize" ? "Resize element" : "Rotate element" });
        return;
      }

      setInteraction(NO_INTERACTION);
    },
    [elements, interaction, selection, setSelection, updateElements]
  );

  /* ---------------- handles ---------------- */

  const startHandleDrag = useCallback(
    (e: ReactPointerEvent<SVGCircleElement>, handle: HandleId) => {
      const single = selectedElements.length === 1 ? selectedElements[0] : null;
      if (!single || single.locked) return;
      e.stopPropagation();
      const viewport = viewportRef.current;
      try {
        viewport?.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const pt = docPoint(e.clientX, e.clientY);
      setInteraction({
        ...NO_INTERACTION,
        mode: handle === "rot" ? "rotate" : "resize",
        pointerId: e.pointerId,
        handle,
        snapshot: single,
        startDocX: pt.x,
        startDocY: pt.y,
      });
    },
    [docPoint, selectedElements]
  );

  /* ---------------- double click → text editing ---------------- */

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = (e.target as Element).closest?.("[data-element-id]") as SVGElement | null;
      const id = target?.getAttribute("data-element-id");
      if (!id) return;
      const el = elements.find((x) => x.id === id);
      if (el && el.type === "text") onRequestTextEdit?.(id);
    },
    [elements, onRequestTextEdit]
  );

  /* ---------------- derived overlay geometry ---------------- */

  const marqueePreviewIds = useMemo(() => {
    if (interaction.mode !== "marquee" || !interaction.moved || !interaction.marquee) return new Set<string>();
    return new Set(
      elements
        .filter((el) => el.visible && !el.locked && rectsIntersect(elementBBox(el), interaction.marquee!))
        .map((el) => el.id)
    );
  }, [elements, interaction]);

  const single = selectedElements.length === 1 ? selectedElements[0] : null;
  const singlePreview = single ? editPreview(single) ?? movePreview(single) : undefined;

  if (!doc) return <div className="flex-1 min-w-0 bg-muted/30" aria-hidden />;

  const aw = doc.artboard.width;
  const ah = doc.artboard.height;
  const panModeAttr = interaction.mode === "pan" ? "dragging" : spaceHeld ? "armed" : undefined;

  return (
    <div className="relative flex-1 min-w-0 min-h-0 flex flex-col">
      <div
        ref={viewportRef}
        className={cn(
          "builder-viewport relative flex-1 min-h-0 overflow-hidden outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
        )}
        data-pan={panModeAttr}
        tabIndex={0}
        role="application"
        aria-label={`Template canvas — ${doc.name}, ${aw} by ${ah} pixels. Use arrow keys to nudge the selection.`}
        onPointerDown={onViewportPointerDown}
        onPointerMove={onViewportPointerMove}
        onPointerUp={onViewportPointerUp}
        onPointerCancel={onViewportPointerUp}
        onDoubleClick={onDoubleClick}
      >
        <div
          className="builder-stage absolute left-0 top-0"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
        >
          <div className="builder-artboard-frame relative" style={{ width: aw, height: ah }}>
            <svg
              width={aw}
              height={ah}
              className="block"
              style={{ background: doc.artboard.background }}
              shapeRendering="geometricPrecision"
            >
              {/* elements — array order is z-order */}
              {elements.map((el) => (
                <ElementView
                  key={el.id}
                  el={el}
                  zoom={zoom}
                  preview={editPreview(el) ?? movePreview(el)}
                  semanticContent={semanticContentFor(el)}
                />
              ))}

              {/* ---- selection overlay ---- */}
              <g pointerEvents="none">
                {selectedElements.map((el) => {
                  const prev = el.id === single?.id ? singlePreview : movePreview(el);
                  const x = prev?.x ?? el.x;
                  const y = prev?.y ?? el.y;
                  const w = prev?.width ?? el.width;
                  const h = prev?.height ?? el.height;
                  const rot = prev?.rotation ?? el.rotation;
                  const tf = rot !== 0 ? `translate(${x} ${y}) rotate(${rot} ${w / 2} ${h / 2})` : `translate(${x} ${y})`;
                  return (
                    <g key={`sel-${el.id}`} transform={tf}>
                      <rect
                        x={0}
                        y={0}
                        width={w}
                        height={h}
                        fill="none"
                        stroke="#F59E0B"
                        strokeWidth={1.5 / zoom}
                      />
                    </g>
                  );
                })}

                {/* marquee candidates */}
                {marqueePreviewIds.size > 0 &&
                  elements
                    .filter((el) => marqueePreviewIds.has(el.id) && !selection.includes(el.id))
                    .map((el) => (
                      <rect
                        key={`mq-${el.id}`}
                        x={el.x}
                        y={el.y}
                        width={el.width}
                        height={el.height}
                        fill="rgba(245,158,11,0.08)"
                        stroke="#F59E0B"
                        strokeDasharray={`${4 / zoom} ${3 / zoom}`}
                        strokeWidth={1 / zoom}
                      />
                    ))}

                {/* single-selection handles (rotation-aware) */}
                {single && interaction.mode !== "marquee" && interaction.mode !== "resize" && interaction.mode !== "rotate"
                  ? (() => {
                      const p = singlePreview;
                      const x = p?.x ?? single.x;
                      const y = p?.y ?? single.y;
                      const w = p?.width ?? single.width;
                      const h = p?.height ?? single.height;
                      const rot = p?.rotation ?? single.rotation;
                      const tf =
                        rot !== 0 ? `translate(${x} ${y}) rotate(${rot} ${w / 2} ${h / 2})` : `translate(${x} ${y})`;
                      const hs = 4.5 / zoom;
                      const handlePos: { id: HandleId; cx: number; cy: number }[] = [
                        { id: "nw", cx: 0, cy: 0 },
                        { id: "n", cx: w / 2, cy: 0 },
                        { id: "ne", cx: w, cy: 0 },
                        { id: "e", cx: w, cy: h / 2 },
                        { id: "se", cx: w, cy: h },
                        { id: "s", cx: w / 2, cy: h },
                        { id: "sw", cx: 0, cy: h },
                        { id: "w", cx: 0, cy: h / 2 },
                      ];
                      const rotOffset = 26 / zoom;
                      return (
                        <g transform={tf}>
                          <line x1={w / 2} y1={-rotOffset} x2={w / 2} y2={0} stroke="#F59E0B" strokeWidth={1 / zoom} />
                          <circle
                            cx={w / 2}
                            cy={-rotOffset}
                            r={hs}
                            fill="#FFFFFF"
                            stroke="#D97706"
                            strokeWidth={1.5 / zoom}
                            style={{ pointerEvents: "all", cursor: "grab" }}
                            onPointerDown={(e) => startHandleDrag(e, "rot")}
                          >
                            <title>Rotate element — hold Shift for 15° steps</title>
                          </circle>
                          {handlePos.map((hp) => (
                            <circle
                              key={hp.id}
                              cx={hp.cx}
                              cy={hp.cy}
                              r={hs}
                              fill="#FFFFFF"
                              stroke="#D97706"
                              strokeWidth={1.5 / zoom}
                              style={{
                                pointerEvents: "all",
                                cursor:
                                  hp.id === "n" || hp.id === "s"
                                    ? "ns-resize"
                                    : hp.id === "e" || hp.id === "w"
                                      ? "ew-resize"
                                      : hp.id === "nw" || hp.id === "se"
                                        ? "nwse-resize"
                                        : "nesw-resize",
                              }}
                              onPointerDown={(e) => startHandleDrag(e, hp.id)}
                            >
                              <title>{`Resize ${hp.id.toUpperCase()} — hold Shift to keep proportions`}</title>
                            </circle>
                          ))}
                        </g>
                      );
                    })()
                  : null}

                {/* marquee rectangle */}
                {interaction.mode === "marquee" && interaction.moved && interaction.marquee && (
                  <rect
                    x={interaction.marquee.x}
                    y={interaction.marquee.y}
                    width={interaction.marquee.width}
                    height={interaction.marquee.height}
                    fill="rgba(245,158,11,0.08)"
                    stroke="#F59E0B"
                    strokeWidth={1 / zoom}
                    strokeDasharray={`${5 / zoom} ${3 / zoom}`}
                  />
                )}
              </g>
            </svg>

            {/* empty-document hint (constant screen size via inverse scale) */}
            {elements.length === 0 && (
              <div
                className="absolute left-1/2 top-1/2 select-none text-center"
                style={{ transform: `translate(-50%, -50%) scale(${1 / zoom})` }}
              >
                <p className="text-[13px] font-medium text-muted-foreground">This artboard is empty</p>
                <p className="mt-1 text-[11px] text-muted-foreground/70">
                  Add an Icon Grid, text or shapes from the insert panel
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---------------- status bar ---------------- */}
      <div className="builder-statusbar flex h-9 shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-3">
        <div className="flex min-w-0 items-center gap-3 font-mono text-[10.5px] tabular-nums text-muted-foreground">
          <span className="truncate">
            {aw} × {ah}
          </span>
          <span className="text-border" aria-hidden>
            |
          </span>
          {selection.length > 0 ? (
            <span>{selection.length} selected</span>
          ) : (
            <span ref={cursorRef} className="hidden sm:inline" aria-hidden>
              —
            </span>
          )}
          {interaction.mode === "pan" && <span className="text-amber-600">panning…</span>}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => zoomAt(0.8)}
            disabled={zoom <= BUILDER_ZOOM_MIN}
            aria-label="Zoom out (Ctrl+scroll down)"
            title="Zoom out — Ctrl + scroll"
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <button
            type="button"
            className="h-7 min-w-[52px] rounded-md px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setZoom(1)}
            aria-label={`Zoom level ${Math.round(zoom * 100)} percent — click to reset to 100 percent`}
            title="Click to reset to 100%"
          >
            {Math.round(zoom * 100)}%
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => zoomAt(1.25)}
            disabled={zoom >= BUILDER_ZOOM_MAX}
            aria-label="Zoom in (Ctrl+scroll up)"
            title="Zoom in — Ctrl + scroll"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={fitToScreen}
            aria-label="Fit artboard to screen (key 0)"
            title="Fit to screen — key 0"
          >
            <Maximize className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Fit</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Resize math (rotation-aware, local-axis)                            */
/*                                                                     */
/* anchor A = opposite corner/edge (fixed). pointer in the anchor's     */
/* UNROTATED frame: u = R(−θ)·(P−A). half-extents derive directly:      */
/* hw' = u.x·dx/2 (dx≠0) · hh' = u.y·dy/2 (dy≠0); the new center keeps  */
/* the anchor pinned: C' = A + R(θ)·(dx·hw', dy·hh').                   */
/* ------------------------------------------------------------------ */

function computeResize(
  snap: BuilderElement,
  handle: HandleId,
  pointer: { x: number; y: number },
  keepAspect: boolean
): ElementPreview {
  if (handle === "rot") return {};
  const [dx, dy] = HANDLE_DIRS[handle];
  const theta = ((snap.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  const hw0 = snap.width / 2;
  const hh0 = snap.height / 2;
  const cx0 = snap.x + hw0;
  const cy0 = snap.y + hh0;

  /* anchor = the opposite corner/edge in doc space */
  const axLocal = -dx * hw0;
  const ayLocal = -dy * hh0;
  const ax = cx0 + axLocal * cos - ayLocal * sin;
  const ay = cy0 + axLocal * sin + ayLocal * cos;

  /* pointer in the anchor's local (unrotated) frame */
  const ux = (pointer.x - ax) * cos + (pointer.y - ay) * sin;
  const uy = -(pointer.x - ax) * sin + (pointer.y - ay) * cos;

  const minW = snap.type === "line" ? 0 : MIN_SIZE;
  const minH = snap.type === "line" ? 0 : MIN_SIZE;

  let hw = hw0;
  let hh = hh0;
  if (dx !== 0) hw = Math.max(minW / 2, (ux * dx) / 2);
  if (dy !== 0) hh = Math.max(minH / 2, (uy * dy) / 2);

  /* Shift on a CORNER keeps the original aspect ratio */
  if (keepAspect && dx !== 0 && dy !== 0 && hw0 > 0 && hh0 > 0) {
    const ratio = hh0 / hw0;
    if (hw * ratio >= minH / 2 && hw >= minW / 2) hh = hw * ratio;
  }

  const w = hw * 2;
  const h = hh * 2;

  /* new center keeps the anchor pinned */
  const nlx = dx * hw;
  const nly = dy * hh;
  const ncx = ax + nlx * cos - nly * sin;
  const ncy = ay + nlx * sin + nly * cos;

  return {
    x: round2(ncx - hw),
    y: round2(ncy - hh),
    width: round2(w),
    height: round2(h),
  };
}
