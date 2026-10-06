"use client";

/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 2) · preview mode.
 *
 * “Preview” must never be a second renderer. This component compiles the
 * document through the SAME pipeline a save goes through
 * (compileBuilderDocument → buildCustomTemplate → renderSheet) and renders
 * a representative sheet with the template's own defaults — so what the
 * user previews is bit-for-bit what the Studio will produce after saving.
 *
 * Non-destructive by construction: nothing here touches the document.
 *
 * P5 · Preview Zoom: the preview body is a proper zooming viewport —
 *
 *   viewport (screen px, overflow hidden)
 *     └─ stage — CSS translate(pan) scale(zoom), origin 0 0
 *          └─ the rendered sheet <svg> at its natural document size
 *
 * Zoom is PURE VIEWPORT STATE: 25 % – 500 % (steps 25/50/75/100/125/150/
 * 200/250/300/400/500 for the stepper, continuous while Ctrl-wheeling),
 * plus pan (wheel, Space + drag, middle-drag). It NEVER touches the
 * document, the compiled record, exports or saves — the sheet SVG itself
 * is never re-rendered or re-scaled, only the stage transform changes.
 * The representative sheet now carries a REAL hero icon (the library's
 * first icon — exactly what generateSheets stamps on a fresh sheet), so
 * the preview shows the hero area the way the Studio will render it
 * (P5 single-layout-engine guarantee: preview === final output).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Eye, Maximize, Minus, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { compileBuilderDocument } from "@/lib/builder/publish";
import { buildCustomTemplate } from "@/lib/studio/templates";
import { renderSheet } from "@/lib/studio/renderer";
import { useStudio } from "@/lib/studio/store";
import type { CustomTemplateRecord, Sheet } from "@/lib/studio/types";
import type { BuilderDocument } from "@/lib/builder/types";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Zoom steps — the mandate's discrete ladder                          */
/* ------------------------------------------------------------------ */

export const PREVIEW_ZOOM_STEPS = [25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500] as const;
export const PREVIEW_ZOOM_MIN = 0.25;
export const PREVIEW_ZOOM_MAX = 5;

function clampZoom(z: number): number {
  return Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, z));
}

/** Nearest step ≥ the current zoom (for the + button). */
function stepUp(z: number): number {
  const pct = z * 100;
  const next = PREVIEW_ZOOM_STEPS.find((s) => s > pct + 0.5);
  return clampZoom((next ?? PREVIEW_ZOOM_MAX) / 100);
}

/** Nearest step ≤ the current zoom (for the − button). */
function stepDown(z: number): number {
  const pct = z * 100;
  const prev = [...PREVIEW_ZOOM_STEPS].reverse().find((s) => s < pct - 0.5);
  return clampZoom((prev ?? PREVIEW_ZOOM_MIN) / 100);
}

function zoomLabel(z: number): string {
  const pct = Math.round(z * 100);
  const exact = (PREVIEW_ZOOM_STEPS as readonly number[]).find((s) => Math.abs(s - pct) < 0.5);
  return exact ? `${exact}%` : `${pct}%`;
}

/* ------------------------------------------------------------------ */
/* Representative sheet                                                */
/* ------------------------------------------------------------------ */

function templateThumbSheet(
  record: CustomTemplateRecord,
  def: ReturnType<typeof buildCustomTemplate>,
  heroIconId: string | null,
  libraryIconIds: string[]
): Sheet {
  const categoryText = renderedCategory(record.builderDoc ?? null);
  return {
    id: "preview",
    templateId: def.id,
    /* representative sheet: REAL library icons fill the slots exactly the
     * way generateSheets chunks them (slots beyond the library stay
     * unresolved placeholders — visually empty), and the LIVE icon count
     * text renders “{capacity} ICONS” because iconIds.length === capacity */
    iconIds: Array.from({ length: record.capacity }, (_, i) => libraryIconIds[i] ?? `preview-slot-${i}`),
    /* P5: a REAL hero icon — generateSheets stamps chunk[0] (the first
     * icon) on every fresh sheet, so the preview mirrors the final
     * output's hero area instead of showing an empty slot. */
    heroIconId,
    category: categoryText,
    volume: 1,
    design: structuredClone(def.defaults),
    createdAt: 0,
    updatedAt: 0,
  };
}

/** The category placeholder shown in previews — the doc's own category text
 *  (first line) so the preview matches the author's intent. */
function renderedCategory(doc: BuilderDocument | null): string {
  const el = doc?.elements.find((e) => e.role === "category" && e.type === "text");
  const content = el && typeof (el.properties as { content?: unknown }).content === "string"
    ? (el.properties as { content: string }).content
    : "";
  return content.split("\n")[0]?.trim() || "Icon Collection";
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

const TYPING_SELECTOR = "input, textarea, select, [contenteditable='true'], [contenteditable='']";
const OVERLAY_SELECTOR = "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']";

export function BuilderPreview({
  doc,
  onExit,
}: {
  doc: BuilderDocument;
  onExit: () => void;
}) {
  const compiled = useMemo(() => compileBuilderDocument(doc), [doc]);
  const icons = useStudio((s) => s.icons);
  /* the representative sheet's icon source: the library's icons in order,
  * exactly the way generateSheets chunks them onto fresh sheets */
  const libraryIconIds = useMemo(() => Object.keys(icons), [icons]);
  const representativeHeroId = useMemo(() => libraryIconIds[0] ?? null, [libraryIconIds]);

  const rendered = useMemo(() => {
    if (!compiled.ok || !compiled.record) return null;
    const record: CustomTemplateRecord = { ...compiled.record, id: "preview", createdAt: Date.now() };
    const def = buildCustomTemplate(record);
    const sheet = templateThumbSheet(record, def, representativeHeroId, libraryIconIds);
    try {
      return { svg: renderSheet(sheet, def, icons, { mode: "export" }), def };
    } catch (err) {
      console.error("[builder-preview] render failed", err);
      return null;
    }
  }, [compiled, icons, representativeHeroId, libraryIconIds]);

  const warnings = compiled.warnings;

  /* ---------------- P5 zoom & pan viewport state ---------------- */

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const panStart = useRef({ cx: 0, cy: 0, px: 0, py: 0 });
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  useEffect(() => {
    zoomRef.current = zoom;
    panRef.current = pan;
  }, [zoom, pan]);

  /** Fit the sheet inside the viewport (zoom is derived, pan centers). */
  const fitToScreen = useCallback(() => {
    const viewport = viewportRef.current;
    const stage = stageRef.current;
    if (!viewport || !stage) return;
    const vr = viewport.getBoundingClientRect();
    const sw = stage.scrollWidth || 1;
    const sh = stage.scrollHeight || 1;
    const pad = 88;
    const z = clampZoom(Math.min((vr.width - pad) / sw, (vr.height - pad) / sh));
    setZoom(z);
    setPan({
      x: Math.round((vr.width - sw * z) / 2),
      y: Math.round((vr.height - sh * z) / 2),
    });
  }, []);

  /* fit once when a valid render first appears (deferred — the stage is
   * measured post-layout; lint forbids direct setState in effects) */
  const [fittedFor, setFittedFor] = useState("");
  useEffect(() => {
    if (!rendered) return;
    const key = `${doc.id}:${rendered.def.width}x${rendered.def.height}:${representativeHeroId ?? "nohero"}`;
    if (fittedFor === key) return;
    const raf = requestAnimationFrame(() => {
      setFittedFor(key);
      fitToScreen();
    });
    return () => cancelAnimationFrame(raf);
  }, [doc.id, rendered, fittedFor, fitToScreen, representativeHeroId]);

  /** Zoom anchored at a viewport point (keeps that document point under
   *  the cursor — the same math the builder canvas uses). */
  const zoomAt = useCallback((factor: number, anchorClientX?: number, anchorClientY?: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const ax = anchorClientX ?? rect.left + rect.width / 2;
    const ay = anchorClientY ?? rect.top + rect.height / 2;
    const oldZ = zoomRef.current;
    const newZ = clampZoom(oldZ * factor);
    if (Math.abs(newZ - oldZ) < 1e-6) return;
    const p = panRef.current;
    const dx = (ax - rect.left - p.x) / oldZ;
    const dy = (ay - rect.top - p.y) / oldZ;
    setZoom(newZ);
    setPan({ x: Math.round(ax - rect.left - dx * newZ), y: Math.round(ay - rect.top - dy * newZ) });
  }, []);

  /* wheel: Ctrl/⌘ = anchored zoom · plain = pan · Shift = horizontal */
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

  /* Space key → pan mode (grab cursor) */
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
      if (!e.repeat) setSpaceHeld(true);
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

  /* zoom keyboard: 0 = fit · 1 = 100 % · +/- = one ladder step */
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
        setZoom((z) => stepUp(z));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setZoom((z) => stepDown(z));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fitToScreen]);

  /* pointer pan (Space + drag / middle button) */
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!(spaceHeld || e.button === 1)) return;
      e.preventDefault();
      try {
        viewportRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
      panStart.current = { cx: e.clientX, cy: e.clientY, px: panRef.current.x, py: panRef.current.y };
      setPanning(true);
    },
    [spaceHeld]
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!panning) return;
      setPan({
        x: panStart.current.px + (e.clientX - panStart.current.cx),
        y: panStart.current.py + (e.clientY - panStart.current.cy),
      });
    },
    [panning]
  );
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    try {
      viewportRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setPanning(false);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/40">
      {/* preview header */}
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border bg-background px-3">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400">
          <Eye className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-[12px] font-semibold leading-tight">Preview — exactly what the Studio will render</p>
          <p className="truncate text-[10.5px] leading-tight text-muted-foreground">
            {compiled.record
              ? `${compiled.record.capacity} icon slots · ${compiled.record.width} × ${compiled.record.height} · category text and “VOL. 01” are placeholders the Studio fills per sheet`
              : "Fix the validation errors to see the preview"}
          </p>
        </div>
        <div className="flex-1" />
        {warnings.length > 0 && compiled.ok && (
          <span
            className="hidden items-center gap-1.5 rounded-full border border-amber-500/50 bg-amber-500/10 px-2.5 py-1 text-[10.5px] font-medium text-amber-700 dark:text-amber-400 sm:inline-flex"
            role="status"
          >
            <AlertTriangle className="size-3" aria-hidden />
            {warnings.length} warning{warnings.length > 1 ? "s" : ""} — saving is still allowed
          </span>
        )}
        <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 text-[11.5px]" onClick={onExit} autoFocus>
          <RotateCcw className="size-3.5" />
          Back to editing
        </Button>
      </div>

      {/* body */}
      {!compiled.ok ? (
        <div className="grid flex-1 place-items-center overflow-y-auto p-6">
          <div className="w-full max-w-md rounded-xl border border-destructive/40 bg-card p-5 text-center shadow-sm">
            <span className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="size-5" aria-hidden />
            </span>
            <p className="text-[13px] font-semibold">Preview unavailable</p>
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              Fix {compiled.errors.length} validation error{compiled.errors.length > 1 ? "s" : ""} — the preview
              only renders valid templates, and saving refuses invalid ones for the same reason.
            </p>
            <ul className="mt-3 space-y-1.5 text-left">
              {compiled.errors.slice(0, 5).map((issue, i) => (
                <li key={i} className="flex items-start gap-2 rounded-lg bg-muted/60 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden />
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : !rendered ? (
        <div className="grid flex-1 place-items-center p-6 text-center text-[12px] text-muted-foreground">
          The template compiled, but the renderer could not draw it. Save anyway and check the sheet in the Studio.
        </div>
      ) : (
        <div
          ref={viewportRef}
          className={cn(
            "relative min-h-0 flex-1 overflow-hidden outline-none",
            (spaceHeld || panning) && (panning ? "cursor-grabbing" : "cursor-grab")
          )}
          tabIndex={0}
          role="application"
          aria-label={`Template preview viewport — ${doc.name}. Zoom ${zoomLabel(zoom)}. Hold Space or use the middle mouse button to pan; Ctrl + scroll to zoom.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/* P5 zoom viewport: the stage transform is PURE VIEWPORT STATE —
           * the sheet SVG below is exactly what the Studio renders, never
           * re-rendered or re-scaled for zooming. */}
          <div
            ref={stageRef}
            className="absolute left-0 top-0"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
          >
            <div
              className="shadow-xl shadow-black/10 dark:shadow-black/40 ring-1 ring-border/70"
              style={{ width: rendered.def.width, height: rendered.def.height }}
            >
              <div
                className="h-full w-full [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: rendered.svg }}
                role="img"
                aria-label={`Preview of template ${doc.name}`}
              />
            </div>
          </div>

          {/* zoom controls (floating, bottom-right — never cover the sheet's
           * top-left content; constant screen size) */}
          <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-border bg-background/95 p-1 shadow-md backdrop-blur">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setZoom((z) => stepDown(z))}
              disabled={zoom <= PREVIEW_ZOOM_MIN + 1e-6}
              aria-label="Zoom out one step (Ctrl+scroll down)"
              title="Zoom out — Ctrl + scroll or −"
            >
              <Minus className="h-3.5 w-3.5" />
            </Button>
            <select
              value={zoomLabel(zoom)}
              onChange={(e) => {
                const v = Number.parseFloat(e.target.value);
                if (Number.isFinite(v)) setZoom(clampZoom(v / 100));
              }}
              className="h-7 min-w-[64px] cursor-pointer rounded-md bg-transparent px-1 text-center font-mono text-[11px] tabular-nums text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Zoom level ${zoomLabel(zoom)} — pick a preset`}
              title="Zoom preset — 25% to 500%"
            >
              {(PREVIEW_ZOOM_STEPS as readonly number[]).map((s) => (
                <option key={s} value={`${s}%`}>
                  {s}%
                </option>
              ))}
              {/* keep the current value selectable when it sits between steps */}
              {(PREVIEW_ZOOM_STEPS as readonly number[]).every((s) => Math.abs(s - zoom * 100) >= 0.5) && (
                <option value={zoomLabel(zoom)}>{zoomLabel(zoom)}</option>
              )}
            </select>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setZoom((z) => stepUp(z))}
              disabled={zoom >= PREVIEW_ZOOM_MAX - 1e-6}
              aria-label="Zoom in one step (Ctrl+scroll up)"
              title="Zoom in — Ctrl + scroll or +"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <div className="mx-0.5 h-5 w-px bg-border" aria-hidden />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={fitToScreen}
              aria-label="Fit the sheet to the viewport (key 0)"
              title="Fit to screen — key 0"
            >
              <Maximize className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Fit</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 font-mono text-[11px] tabular-nums"
              onClick={() => setZoom(1)}
              aria-label="Reset zoom to 100 percent (key 1)"
              title="Reset to 100% — key 1"
            >
              100%
            </Button>
          </div>
        </div>
      )}

      {/* status footer */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border bg-background px-3 text-[10.5px] text-muted-foreground">
        <span className="font-medium text-foreground">{doc.name}</span>
        <span aria-hidden>·</span>
        <span className="hidden truncate md:inline">
          placeholders: category → “{rendered ? renderedCategory(doc) : "Icon Collection"}” · volume → VOL. 01{compiled.record ? ` · icon count → ${compiled.record.capacity} ICONS` : ""}{representativeHeroId ? " · hero → first library icon" : ""}
        </span>
        <div className="flex-1" />
        <span className={cn("tabular-nums", compiled.ok ? "" : "text-destructive")}>
          {compiled.ok ? `${compiled.record?.capacity} slots · ${compiled.record?.width} × ${compiled.record?.height}` : "invalid"}
        </span>
        <span aria-hidden>·</span>
        <span className="tabular-nums" title="Viewport zoom — pan with Space + drag or the mouse wheel; Ctrl + scroll zooms">
          zoom {zoomLabel(zoom)}
        </span>
      </div>
    </div>
  );
}
