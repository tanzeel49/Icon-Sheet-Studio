"use client";

/**
 * ICON SHEET STUDIO — Icon-cell hotspots for the edit-mode workspace.
 * Interactive overlay cells (hero / move / context actions) mounted per
 * sheet artboard by MultiSheetWorkspace; the old single-sheet SheetPreview
 * shell was removed with the round-14 workspace redesign.
 */

import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useStudio } from "@/lib/studio/store";
import { useWheelNumberAdjust } from "./use-wheel-number-adjust";
import { justDragged } from "@/lib/studio/drag-gate";
import { sheetTemplate } from "@/lib/studio/templates";
import { renderSheet, computeGrid } from "@/lib/studio/renderer";
import { Dices, Grid2x2, ZoomIn, ZoomOut, Maximize, Star, ArrowRightLeft, X, ChevronDown, MousePointerClick, GripHorizontal, Scan, Eye, EyeOff, Palette, Blinds, Eraser, FileText, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { GradientFill, Sheet } from "@/lib/studio/types";
import {
  effectiveStrokeWeightPx,
  effectiveUniformStroke,
  effectiveUniformTargetPx,
  STROKE_WEIGHT_PX_MAX,
  STROKE_WEIGHT_PX_MIN,
  UNIFORM_TARGET_PX_MAX,
  UNIFORM_TARGET_PX_MIN,
} from "@/lib/studio/types";
import { iconNativeVisualPx } from "@/lib/studio/icon-fit";
import { representativeGridIconBox } from "@/lib/studio/stroke-migration";
import { styledIconPreviewSvg } from "@/lib/studio/icon-preview";

/**
 * A single grid-cell hotspot: select target (click), drag source AND drop
 * target for cell→cell reordering (outer DndContext, PointerSensor with 6px
 * activation — clicks still work), plus keyboard grid navigation. A
 * double-click opens the shell-mounted inspector for that icon (round 8).
 *
 * Keyboard on a focused cell:
 *   · plain arrows  → move focus across the grid (wraps rows, never columns)
 *   · Alt + arrows  → move the icon itself one cell (undoable reorder),
 *                     focus follows the icon to its new position
 */
/* stable empty array for the cell-selection selector — returning a fresh []
   on every call triggers Zustand's "getSnapshot should be cached" infinite
   loop. A module-level constant keeps the reference stable across renders. */
const EMPTY_CELL_IDS: string[] = [];

function CellHotspot({
  sheetId,
  iconId,
  index,
  col,
  cols,
  rows,
  x,
  y,
  size,
  w,
  h,
  canvasW,
  canvasH,
  isHero,
  fileName,
  selected,
  skipped,
  cardColor,
  cardGradient,
  strokeTargetPx,
  strokeWeightPx,
  /* round 12: the sheet's active stroke mode — the corner chip shows the
   *  exception that is actually live (target while uniform ON, weight while
   *  OFF); the dormant twin is disclosed in the tooltip. */
  uniformCellMode,
  tabStop,
  onCellFocus,
  onSelect,
  onInspect,
  reorderSheetIcons,
}: {
  sheetId: string;
  iconId: string;
  index: number;
  col: number;
  cols: number;
  rows: number;
  x: number;
  y: number;
  size: number;
  /** full slot size (imported templates may have non-square slots) */
  w?: number;
  h?: number;
  canvasW: number;
  canvasH: number;
  isHero: boolean;
  fileName: string;
  selected: boolean;
  /** this cell is skipped (hidden from preview + export) */
  skipped: boolean;
  /** per-cell card color override, null = sheet default */
  cardColor: string | null;
  /** per-cell card GRADIENT override (round 12), null = sheet default */
  cardGradient: GradientFill | null;
  /** round 9: this icon's per-cell stroke exception target in px (null =
   *  sheet-wide target). Renders the amber corner chip; the smart-bar
   *  Stroke popover edits it. */
  strokeTargetPx: number | null;
  /** round 12: this icon's per-cell WEIGHT exception in px (null =
   *  sheet-wide weight) — the relative-mode twin of strokeTargetPx; the
   *  corner chip shows whichever exception is ACTIVE for the sheet's
   *  current stroke mode. */
  strokeWeightPx: number | null;
  /** round 12: the sheet's active stroke mode (uniform ON?) — the corner
   *  chip shows the exception that is actually live; the dormant twin is
   *  disclosed in the tooltip. */
  uniformCellMode: boolean;
  /** roving tabindex (round 12): exactly ONE cell is a Tab stop — the last
   * focused one. Focus (click or arrow walk) reports its index so the stop
   * follows; Tab enters the grid there and leaves it in one more press. */
  tabStop: boolean;
  onCellFocus: (index: number) => void;
  onSelect: (iconId: string, mode: "replace" | "toggle" | "range") => void;
  onInspect: (iconId: string) => void;
  reorderSheetIcons: (sheetId: string, from: number, to: number) => void;
}) {
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: `cell-${sheetId}-${index}`,
    data: { type: "sheet-cell", sheetId, iconId, fromIndex: index },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `cell-drop-${sheetId}-${index}`,
    data: { type: "sheet-cell", sheetId, index },
  });
  const setRef = useCallback(
    (node: HTMLElement | null) => {
      setDragRef(node as never);
      setDropRef(node as never);
    },
    [setDragRef, setDropRef],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    const map: Record<string, [number, number]> = {
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
    };
    const delta = map[e.key];
    if (!delta) return;
    e.preventDefault();
    const [dr, dc] = delta;
    const row = Math.floor(index / cols);
    /* horizontal moves never wrap rows; vertical moves stay in bounds */
    const nextCol = col + dc;
    const nextRow = row + dr;
    if (dc !== 0 && (nextCol < 0 || nextCol >= cols)) return;
    if (dr !== 0 && (nextRow < 0 || nextRow >= rows)) return;
    const target = index + dr * cols + dc;
    if (target < 0) return;

    if (e.altKey) {
      /* Alt+Arrow — move the icon itself (undoable), focus follows.
       * currentTarget is captured synchronously (null after the handler).
       * Double rAF: guarantees React has committed the reorder before we
       * look up the destination button. */
      const el = e.currentTarget;
      const focusTarget = () => {
        (el.parentElement?.querySelector<HTMLButtonElement>(
          `button[data-cell-index="${target}"]`,
        ) ?? null)?.focus();
      };
      reorderSheetIcons(sheetId, index, target);
      requestAnimationFrame(() => requestAnimationFrame(focusTarget));
      return;
    }
    /* plain arrows — grid focus navigation */
    (e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
      `button[data-cell-index="${target}"]`,
    ) ?? null)?.focus();
  }

  return (
    <button
      ref={setRef}
      type="button"
      {...attributes}
      /* dnd-kit's default drag instructions say "press space to pick up" —
       * wrong here: Space selects the cell (no KeyboardSensor on this
       * context). Pointer-drag only, so drop the instruction reference. */
      aria-describedby={undefined}
      {...listeners}
      data-cell-index={index}
      tabIndex={tabStop ? 0 : -1}
      onFocus={() => onCellFocus(index)}
      aria-label={`Icon ${index + 1}: ${fileName}${isHero ? " (hero)" : ""}${skipped ? " (skipped)" : ""}`}
      title={`${fileName}${isHero ? " — hero" : ""}${skipped ? " — SKIPPED (hidden from export)" : ""} · click to select · double-click to inspect · drag to rearrange · Alt+arrows to nudge`}
      className={cn(
        "absolute rounded-md transition-[background-color,outline-color,box-shadow] duration-150 outline-none cursor-grab active:cursor-grabbing",
        isDragging && "opacity-35",
        skipped &&
          !selected && "outline-1 outline-dashed outline-stone-400/80 outline-offset-[-2px]",
        isHero && !selected && "ring-1 ring-amber-500/40",
        selected
          ? "bg-amber-500/15 ring-2 ring-amber-500 shadow-md shadow-amber-500/25"
          : isOver
            ? "bg-amber-500/25 ring-2 ring-amber-500 ring-offset-2 ring-offset-white/70 shadow-lg shadow-amber-500/30"
            : skipped
              ? "hover:bg-stone-400/10 hover:outline-stone-500"
              : "hover:bg-amber-500/10 hover:ring-1 hover:ring-amber-500/50",
        isOver && "scale-[1.04] z-[1]",
      )}
      style={{
        left: `${(x / canvasW) * 100}%`,
        top: `${(y / canvasH) * 100}%`,
        width: `${((w ?? size) / canvasW) * 100}%`,
        height: `${((h ?? size) / canvasH) * 100}%`,
      }}
      onClick={(e) => {
        /* swallow the trailing click after a drag (same gate as tiles) */
        if (justDragged()) return;
        /* multi-selection modifiers (round 11): ctrl/cmd-click toggles a
         * single cell; shift-click extends a range from the anchor. Plain
         * click replaces the selection. */
        const mode: "replace" | "toggle" | "range" = e.shiftKey
          ? "range"
          : e.metaKey || e.ctrlKey
            ? "toggle"
            : "replace";
        onSelect(iconId, mode);
      }}
      onDoubleClick={() => {
        /* same drag gate — a drag that ended on this cell must not inspect */
        if (justDragged()) return;
        onInspect(iconId);
      }}
      onKeyDown={onKeyDown}
    >
      {isHero ? (
        <span
          aria-hidden
          className="absolute -top-2 -right-2 h-4 w-4 rounded-full bg-amber-500 text-amber-50 grid place-items-center shadow-md pointer-events-none"
          title="Hero icon"
        >
          <Star className="h-2.5 w-2.5 fill-current" />
        </span>
      ) : null}
      {skipped ? (
        <span
          aria-hidden
          className="absolute top-1 left-1 grid h-4 w-4 place-items-center rounded-full bg-stone-600 text-white shadow-md pointer-events-none"
          title="Skipped — hidden from export"
        >
          <EyeOff className="h-2.5 w-2.5" />
        </span>
      ) : null}
      {cardColor || cardGradient ? (
        <span
          aria-hidden
          className="absolute bottom-1 left-1 h-3 w-3 rounded-[4px] border border-white/70 shadow-sm pointer-events-none"
          style={cardGradient ? { background: cssGradient(cardGradient) } : { backgroundColor: cardColor ?? undefined }}
          title={cardGradient ? "Custom cell gradient" : "Custom cell color"}
        />
      ) : null}
      {strokeTargetPx != null || strokeWeightPx != null ? (
        <span
          aria-hidden
          className="absolute bottom-1 right-1 inline-flex items-center gap-0.5 rounded-full bg-amber-500/90 px-1 py-px text-[8.5px] font-semibold leading-3.5 tabular-nums text-amber-50 shadow-sm pointer-events-none"
          title={
            uniformCellMode
              ? `Stroke exception — targets ${strokeTargetPx ?? strokeWeightPx} px instead of the sheet-wide target${strokeWeightPx != null ? ` (carries a dormant weight exception of ${strokeWeightPx >= 0 ? "+" : ""}${strokeWeightPx} px)` : ""}`
              : `Stroke exception — own weight adjustment of ${strokeWeightPx != null ? (strokeWeightPx === 0 ? "0 (pinned to original)" : `${strokeWeightPx >= 0 ? "+" : ""}${strokeWeightPx} px`) : `${strokeTargetPx} px target (dormant)`} instead of the sheet-wide weight`
          }
        >
          <PenLine className="h-2 w-2" />
          {uniformCellMode
            ? strokeTargetPx ?? strokeWeightPx
            : strokeWeightPx != null
              ? strokeWeightPx === 0
                ? "±0"
                : `${strokeWeightPx >= 0 ? "+" : ""}${strokeWeightPx}`
              : strokeTargetPx}
        </span>
      ) : null}
      {isOver ? (
        <span
          aria-hidden
          className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 grid h-4 w-4 place-items-center rounded-full bg-amber-500 text-amber-50 shadow-md pointer-events-none"
          title="Move here"
        >
          <GripHorizontal className="h-2.5 w-2.5" />
        </span>
      ) : null}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Per-cell color picker — design-aware swatch popover                 */
/* ------------------------------------------------------------------ */

/** Curate a design-derived swatch palette: the sheet's own paint fields
 *  first (so one-click harmonious picks), then a few reliable neutrals
 *  and the studio's amber accent. Deduped, capped, hex-normalized. */
function cellColorPalette(sheet: Sheet): string[] {
  const d = sheet.design;
  const candidates = [
    d.background,
    d.card.color,
    d.card.borderColor,
    d.hero.card.color,
    d.hero.card.borderColor,
    d.typography.category.color,
    d.typography.volume.color,
    d.rail?.from,
    d.rail?.to,
    d.rail?.ribbon.from,
    "#ffffff",
    "#f5f5f4",
    "#d6d3d1",
    "#57534e",
    "#292524",
    "#f59e0b",
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (!c || !/^#[0-9a-fA-F]{3,8}$/.test(c)) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= 12) break;
  }
  return out;
}

/** Curated design-derived GRADIENT picks (round 12): the sheet's own paint
 *  gradients first (cards / canvas / rail / ribbon), then a few studio
 *  presets in the app's stone/amber register. Deduped, hex-validated, capped. */
function cellGradientPalette(sheet: Sheet): GradientFill[] {
  const d = sheet.design;
  const candidates: (GradientFill | null | undefined)[] = [
    d.card.gradient,
    d.bgGradient,
    d.rail ? { from: d.rail.from, to: d.rail.to, angle: d.rail.angle } : null,
    d.rail ? { from: d.rail.ribbon.from, to: d.rail.ribbon.to, angle: d.rail.ribbon.angle } : null,
    /* studio presets — tasteful, on-register two-stop pairs */
    { from: "#FDE68A", to: "#F59E0B", angle: 45 },
    { from: "#E7E5E4", to: "#A8A29E", angle: 90 },
    { from: "#F5F5F4", to: "#D6D3D1", angle: 0 },
    { from: "#292524", to: "#0C0A09", angle: -45 },
  ];
  const seen = new Set<string>();
  const out: GradientFill[] = [];
  for (const g of candidates) {
    if (!g || !g.from || !g.to || typeof g.angle !== "number") continue;
    if (!/^#[0-9a-fA-F]{3,8}$/.test(g.from) || !/^#[0-9a-fA-F]{3,8}$/.test(g.to)) continue;
    const key = `${g.from.toLowerCase()}|${g.to.toLowerCase()}|${g.angle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: g.from, to: g.to, angle: g.angle });
    if (out.length >= 8) break;
  }
  return out;
}

/** CSS preview direction for an SVG-angle gradient: SVG 0° = left→right
 *  while CSS 0deg = up, so the CSS angle is the SVG angle + 90. */
function cssGradient(g: GradientFill): string {
  return `linear-gradient(${((g.angle + 90) % 360 + 360) % 360}deg, ${g.from}, ${g.to})`;
}

/** Same gradient on both sides of the equality (case-insensitive hex). */
function sameGradient(a: GradientFill | null | undefined, b: GradientFill): boolean {
  return (
    a != null &&
    a.from.toLowerCase() === b.from.toLowerCase() &&
    a.to.toLowerCase() === b.to.toLowerCase() &&
    a.angle === b.angle
  );
}

function CellColorPopover({
  sheet,
  iconIds,
  current,
  currentGradient,
  open: openProp,
  onOpenChange,
}: {
  sheet: Sheet;
  iconIds: string[];
  current: string | null;
  /** gradient currently applied to the selection's first cell (round 12) —
   *  drives the trigger swatch, the chip highlight and the reset state. */
  currentGradient: GradientFill | null;
  /** controlled open (round 12) — the command palette can request this
   *  popover through the store flag. Uncontrolled (click-to-open) when
   *  omitted; both paths converge on the same Popover. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const setCellCardColor = useStudio((s) => s.setCellCardColor);
  const setCellCardGradient = useStudio((s) => s.setCellCardGradient);
  const resetSheetCellFills = useStudio((s) => s.resetSheetCellFills);
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const palette = useMemo(() => cellColorPalette(sheet), [sheet]);
  const gradients = useMemo(() => cellGradientPalette(sheet), [sheet]);
  const label =
    iconIds.length === 1 ? "this cell" : `${iconIds.length} selected cells`;
  /* how many cells on the WHOLE sheet carry a custom fill (solid or
   * gradient) — powers the sheet-wide reset row at the popover footer */
  const sheetFillCount = useMemo(() => {
    const ov = sheet.cellOverrides ?? {};
    let n = 0;
    for (const id of sheet.iconIds) {
      const o = ov[id];
      if (o && ((o.cardColor != null && o.cardColor.trim() !== "") || o.cardGradient != null)) n++;
    }
    return n;
  }, [sheet]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-[11px]"
              aria-label="Custom cell fill"
            >
              {currentGradient ? (
                <span
                  aria-hidden
                  className="h-3.5 w-3.5 rounded-[4px] border border-black/20"
                  style={{ background: cssGradient(currentGradient) }}
                />
              ) : current ? (
                <span
                  aria-hidden
                  className="h-3.5 w-3.5 rounded-[4px] border border-black/20"
                  style={{ backgroundColor: current }}
                />
              ) : (
                <Palette className="h-3.5 w-3.5" />
              )}
              Cell fill
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Override the card fill (solid or gradient) for {label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="center" className="w-60 p-3">
        <p className="text-[12px] font-medium tracking-tight text-foreground">Cell card fill</p>
        <p className="pb-2 pro-help">
          Solid or gradient — applies to {label} on this sheet only.
        </p>
        <div className="flex items-center gap-1.5 pb-1.5">
          <Palette className="h-3 w-3 text-muted-foreground" aria-hidden />
          <p className="pro-label">Solid</p>
        </div>
        <div className="grid grid-cols-6 gap-1.5">
          {palette.map((c) => (
            <button
              key={c}
              type="button"
              className={cn(
                "h-7 w-7 rounded-md border shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring outline-none",
                !currentGradient && current?.toLowerCase() === c.toLowerCase()
                  ? "border-amber-500 ring-2 ring-amber-500/60"
                  : "border-black/15 hover:border-black/40",
              )}
              style={{ backgroundColor: c }}
              aria-label={`Use ${c}`}
              title={c}
              onClick={() => {
                setCellCardColor(sheet.id, iconIds, c);
                toast.success(iconIds.length === 1 ? "Cell color set" : `Cell color set for ${iconIds.length} cells`);
              }}
            />
          ))}
        </div>
        <div className="flex items-center gap-1.5 pb-1.5 pt-3">
          <Blinds className="h-3 w-3 text-muted-foreground" aria-hidden />
          <p className="pro-label">Gradients</p>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {gradients.map((g, i) => {
            const isCurrent = sameGradient(currentGradient, g);
            return (
              <button
                key={`${g.from}-${g.to}-${g.angle}-${i}`}
                type="button"
                className={cn(
                  "h-7 rounded-md border shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring outline-none",
                  isCurrent
                    ? "border-amber-500 ring-2 ring-amber-500/60"
                    : "border-black/15 hover:border-black/40",
                )}
                style={{ background: cssGradient(g) }}
                aria-label={`Use gradient ${g.from} to ${g.to}`}
                title={`${g.from} → ${g.to} · ${g.angle}°`}
                onClick={() => {
                  setCellCardGradient(sheet.id, iconIds, g);
                  toast.success(
                    iconIds.length === 1 ? "Cell gradient set" : `Cell gradient set for ${iconIds.length} cells`,
                  );
                }}
              />
            );
          })}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <label className="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-border/70 dark:border-border text-[10px] font-medium text-muted-foreground transition-colors hover:border-amber-500/50 hover:bg-amber-500/[0.04] hover:text-foreground dark:hover:border-amber-400/50">
            <input
              type="color"
              className="sr-only"
              value={currentGradient ? currentGradient.from : (current ?? "#ffffff")}
              onChange={(e) => {
                setCellCardColor(sheet.id, iconIds, e.target.value);
              }}
            />
            Custom solid…
          </label>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-[11px]"
            disabled={!current && !currentGradient}
            onClick={() => {
              /* null clears BOTH the solid and gradient override (store) */
              setCellCardColor(sheet.id, iconIds, null);
              toast.info("Cell uses the sheet card fill again");
            }}
          >
            Reset
          </Button>
        </div>
        {sheetFillCount > 0 ? (
          <button
            type="button"
            className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/70 dark:border-border px-2 py-1.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-amber-500/60 hover:bg-amber-500/[0.04] hover:text-foreground dark:hover:border-amber-400/60 focus-visible:ring-2 focus-visible:ring-ring outline-none"
            onClick={() => {
              const n = resetSheetCellFills(sheet.id);
              if (n > 0) {
                toast.success(
                  `Cleared ${n} custom fill${n === 1 ? "" : "s"} on this sheet — all cells use the sheet design again`,
                  { description: "Ctrl Z to undo" },
                );
              }
            }}
          >
            <Eraser className="h-3 w-3" aria-hidden />
            Reset all {sheetFillCount} custom fill{sheetFillCount === 1 ? "" : "s"} on this sheet
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Per-cell stroke exception popover (round 9 target · round 12 weight) */
/* ------------------------------------------------------------------ */

/** Compact px label ("2", "0.5", "8.5") for the exception chip + readouts. */
function fmtStrokePx(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Signed integer label ("+3", "−2", "0") for weight exceptions. */
function fmtSignedPx(v: number): string {
  const r = Math.round(v);
  return r > 0 ? `+${r}` : String(r);
}

/** Quick exception presets — the canonical weights, one tap each. */
const STROKE_EXC_PRESETS: number[] = [0.5, 1, 2, 5, 10];

/** Quick WEIGHT-exception presets (round 12, relative mode). 0 is included
 *  deliberately: pinning one icon to its EXACT native weight while the
 *  sheet adjusts every other cell is a real, useful exception. */
const WEIGHT_EXC_PRESETS: number[] = [-3, -1, 0, 1, 3];

/**
 * Per-icon stroke EXCEPTION editor (mode-aware): while the sheet runs
 * Uniform Stroke it edits the icon's own absolute target (round 9); while
 * the sheet runs the relative weight system it edits the icon's own weight
 * adjustment (round 12). Both exceptions share the sheet-wide semantics —
 * consulted only in their own mode, preserved (never cleared) in the other,
 * non-destructive (the engine recomputes from the immutable source on every
 * render). Editing is live: slider/input/presets commit through the store
 * (rapid edits coalesce into ONE undo step, like every stroke slider).
 */
function CellStrokePopover({
  sheet,
  iconIds,
  currentTarget,
  currentWeight,
}: {
  sheet: Sheet;
  iconIds: string[];
  /** the selection's first-cell exception (null = follows the sheet) —
   *  drives the trigger's amber state + the seeded draft value */
  currentTarget: number | null;
  /** round 12: the selection's first-cell WEIGHT exception (null = follows
   *  the sheet weight) — seeds the draft while uniform stroke is OFF */
  currentWeight: number | null;
}) {
  const setCellStrokeTarget = useStudio((s) => s.setCellStrokeTarget);
  const setCellStrokeWeight = useStudio((s) => s.setCellStrokeWeight);
  const resetSheetCellStrokes = useStudio((s) => s.resetSheetCellStrokes);
  const icons = useStudio((s) => s.icons);

  const uniformOn = effectiveUniformStroke(sheet.design.icon);
  const sheetTarget = effectiveUniformTargetPx(sheet.design.icon);
  const sheetWeight = effectiveStrokeWeightPx(sheet.design.icon);
  const label = iconIds.length === 1 ? "this icon" : `these ${iconIds.length} icons`;
  /* the ACTIVE-mode exception drives the amber trigger state; a dormant
   * exception of the other kind is still surfaced by the report + panel */
  const activeException = uniformOn ? currentTarget : currentWeight;
  const isException = activeException != null;

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(uniformOn ? sheetTarget : sheetWeight);

  /* seed the draft from the selection's live state each time the popover
   * opens (no effect hooks — the open handler is the single entry point) */
  const handleOpenChange = (o: boolean): void => {
    if (o) setDraft(uniformOn ? (currentTarget ?? sheetTarget) : (currentWeight ?? sheetWeight));
    setOpen(o);
  };

  /* the first icon's measured native width at its REAL grid box — the same
   * cached analysis the renderer + stroke report use (computed only while
   * open; harmless null when the icon cannot be measured). P7: measured at
   * the artwork's TRUE render scale (icon-fit basis — the same weight the
   * renderer's plan anchors to). */
  const firstEntry = iconIds.length > 0 ? icons[iconIds[0]] : undefined;
  const nativePx = useMemo(() => {
    if (!open || !firstEntry?.svg) return null;
    const box = representativeGridIconBox(sheet);
    if (!(box > 0)) return null;
    const px = iconNativeVisualPx(firstEntry.svg, box);
    return px > 0 ? px : null;
  }, [open, firstEntry, sheet]);

  /* live sheet-styled preview of the first icon at the DRAFT exception —
   * exactly what the sheet will render (same engine, same box size). Only
   * the ACTIVE mode's field is passed: the other kind is dormant by
   * definition, so the preview stays visually exact. */
  const previewHtml = useMemo(() => {
    if (!open || !firstEntry) return "";
    const box = representativeGridIconBox(sheet);
    return styledIconPreviewSvg(firstEntry, sheet.design.icon, {
      boxSize: box,
      size: 34,
      cellOverride: uniformOn
        ? { strokeTargetPx: draft }
        : { strokeWeightPx: draft },
    });
  }, [open, firstEntry, sheet, draft, uniformOn]);

  /* how many stroke exceptions (either kind) exist on the WHOLE sheet —
   * powers the sheet-wide reset row at the popover footer */
  const sheetExceptionCount = useMemo(() => {
    const ov = sheet.cellOverrides ?? {};
    let n = 0;
    for (const id of sheet.iconIds) {
      if (ov[id]?.strokeTargetPx != null || ov[id]?.strokeWeightPx != null) n++;
    }
    return n;
  }, [sheet]);

  const commit = (v: number): void => {
    if (uniformOn) {
      const clamped = Math.min(UNIFORM_TARGET_PX_MAX, Math.max(UNIFORM_TARGET_PX_MIN, v));
      setDraft(clamped);
      setCellStrokeTarget(sheet.id, iconIds, clamped);
    } else {
      const clamped = Math.round(Math.min(STROKE_WEIGHT_PX_MAX, Math.max(STROKE_WEIGHT_PX_MIN, v)));
      setDraft(clamped);
      setCellStrokeWeight(sheet.id, iconIds, clamped);
    }
  };

  /* GLOBAL wheel adjustment — the same shared hook every numeric field in
   * the app uses (use-wheel-number-adjust.ts). This field's own step is
   * 0.5 px (uniform target) / 1 px (weight exception) and commit() applies
   * its own clamp + rounding, exactly like typing does. Callback-ref
   * binding — Radix may swap the popover's input node after mount, and the
   * callback fires exactly then, keeping the listener on the live node. */
  const strokeWheelRef = useWheelNumberAdjust({
    disabled: !open,
    onNudge: (dir, large) => {
      const stepSize = uniformOn ? 0.5 : 1;
      commit(draft + dir * stepSize * (large ? 10 : 1));
    },
  });

  const clearException = (): void => {
    if (uniformOn) setCellStrokeTarget(sheet.id, iconIds, null);
    else setCellStrokeWeight(sheet.id, iconIds, null);
    toast.info(
      iconIds.length === 1
        ? "Icon follows the sheet-wide stroke setting again"
        : `${iconIds.length} icons follow the sheet-wide stroke setting again`,
      { description: "Ctrl Z to undo" }
    );
  };

  /* the expected visual width of the first icon at the current DRAFT — for
   * the target mode it IS the draft; for the weight mode the engine lands
   * each icon at ≈ native + delta (factor clamps 0.25…×4 per icon). */
  const expectedPx =
    uniformOn || nativePx == null ? null : nativePx + Math.round(draft);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className={cn(
                "h-7 gap-1 text-[11px]",
                isException && "text-amber-700 dark:text-amber-400"
              )}
              aria-label="Custom cell stroke exception"
            >
              <PenLine className="h-3.5 w-3.5" />
              Stroke
              {isException ? (
                <span className="font-semibold tabular-nums">
                  {uniformOn ? fmtStrokePx(currentTarget ?? draft) : fmtSignedPx(currentWeight ?? draft)}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {isException
            ? uniformOn
              ? `Exception target ${fmtStrokePx(currentTarget ?? draft)} px — click to edit`
              : `Exception weight ${fmtSignedPx(currentWeight ?? draft)} px — click to edit`
            : `Give ${label} their own stroke ${uniformOn ? "target" : "weight"} (exception)`}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="center" className="w-64 p-3">
        <p className="text-[12px] font-medium tracking-tight text-foreground">
          {uniformOn ? "Cell stroke target" : "Cell stroke weight"}
        </p>
        <p className="pb-2 pro-help">
          {uniformOn ? (
            <>
              Sheet target <span className="font-medium text-foreground">{fmtStrokePx(sheetTarget)} px</span> — an exception
              gives {label} {iconIds.length === 1 ? "its own" : "their own"} absolute target.
            </>
          ) : (
            <>
              Sheet weight{" "}
              <span className="font-medium text-foreground">{fmtSignedPx(sheetWeight)} px</span> — an exception gives{" "}
              {label} {iconIds.length === 1 ? "its own" : "their own"} adjustment (0 pins{" "}
              {iconIds.length === 1 ? "it" : "them"} to the exact original).
            </>
          )}
        </p>

        {/* live preview + native-width readout for the first icon */}
        {firstEntry ? (
          <div className="mb-2 flex items-center gap-2.5 rounded-md border border-border/70 dark:border-border bg-muted/40 px-2 py-1.5">
            <span
              className="grid size-9 shrink-0 place-items-center text-foreground [&_svg]:h-[34px] [&_svg]:w-[34px]"
              dangerouslySetInnerHTML={{ __html: previewHtml || firstEntry.svg }}
              aria-hidden
            />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[11px] font-medium">{firstEntry.fileName}</p>
              <p className="text-[10px] text-muted-foreground">
                {nativePx != null ? (
                  uniformOn ? (
                    <>
                      native <span className="font-medium tabular-nums text-foreground">{fmtStrokePx(nativePx)} px</span>
                      {" → "}
                      <span className="font-medium tabular-nums text-amber-700 dark:text-amber-400">
                        {fmtStrokePx(draft)} px
                      </span>
                    </>
                  ) : (
                    <>
                      native <span className="font-medium tabular-nums text-foreground">{fmtStrokePx(nativePx)} px</span>
                      {" → "}
                      <span className="font-medium tabular-nums text-amber-700 dark:text-amber-400">
                        {fmtSignedPx(draft)} px
                      </span>
                      {expectedPx != null && expectedPx > 0 ? (
                        <> (≈{fmtStrokePx(expectedPx)} px)</>
                      ) : null}
                    </>
                  )
                ) : (
                  "not measurable — original look kept"
                )}
              </p>
            </div>
            {iconIds.length > 1 ? (
              <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-px text-[9px] font-semibold text-amber-700 tabular-nums dark:text-amber-400">
                +{iconIds.length - 1}
              </span>
            ) : null}
          </div>
        ) : null}

        {/* slider + exact input (live, coalesced undo) */}
        <div className="flex items-center gap-2">
          {uniformOn ? (
            <Slider
              className="flex-1"
              min={UNIFORM_TARGET_PX_MIN}
              max={20}
              step={0.5}
              value={[Math.min(draft, 20)]}
              onValueChange={(v) => commit(v[0] ?? draft)}
              aria-label="Exception stroke target in px"
            />
          ) : (
            <Slider
              className="flex-1"
              min={-10}
              max={10}
              step={1}
              value={[Math.max(-10, Math.min(10, draft))]}
              onValueChange={(v) => commit(v[0] ?? draft)}
              aria-label="Exception stroke weight in px"
            />
          )}
          <div className="flex items-center gap-0.5">
            <Input
              ref={strokeWheelRef}
              type="number"
              min={uniformOn ? UNIFORM_TARGET_PX_MIN : STROKE_WEIGHT_PX_MIN}
              max={uniformOn ? UNIFORM_TARGET_PX_MAX : STROKE_WEIGHT_PX_MAX}
              step={uniformOn ? 0.5 : 1}
              value={draft}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && (uniformOn ? v > 0 : true)) commit(v);
              }}
              /* NOTE: no React onWheel here on purpose — React 17+ registers
               * synthetic wheel handlers passively, so preventDefault() in
               * them fails. The shared hook's NATIVE non-passive listener
               * (use-wheel-number-adjust) owns wheel adjustment AND cancels
               * Chromium's native focused-number-input wheel spinning. */
              className="h-7 w-16 rounded-md px-1.5 text-center text-[11px] tabular-nums"
              aria-label="Exception stroke exact px"
            />
            <span className="text-[10px] text-muted-foreground">px</span>
          </div>
        </div>

        {/* quick presets — one tap per canonical weight; the draft highlights */}
        <div className="mt-2 flex items-center gap-1" role="group" aria-label="Quick exception presets">
          {(uniformOn ? STROKE_EXC_PRESETS : WEIGHT_EXC_PRESETS).map((preset) => {
            const active = Math.abs(draft - preset) < 0.01;
            return (
              <button
                key={preset}
                type="button"
                title={
                  uniformOn
                    ? `Target ${fmtStrokePx(preset)} px`
                    : preset === 0
                      ? "Pin to the exact original weight"
                      : `Weight ${fmtSignedPx(preset)} px`
                }
                aria-pressed={active}
                onClick={() => commit(preset)}
                className={cn(
                  "h-6 flex-1 rounded-md border px-1.5 text-[10px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-400"
                    : "border-border bg-card text-muted-foreground hover:border-amber-500/40 hover:bg-muted hover:text-foreground"
                )}
              >
                {uniformOn ? fmtStrokePx(preset) : fmtSignedPx(preset)}
              </button>
            );
          })}
        </div>

        <div className="mt-2.5 flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 flex-1 text-[11px]"
            disabled={!isException}
            onClick={clearException}
          >
            Follow sheet
          </Button>
          <span className="hint-text text-[10px]">
            {uniformOn
              ? "target is absolute"
              : draft === 0
                ? "pinned to original"
                : "relative to native"}
          </span>
        </div>

        {sheetExceptionCount > 0 ? (
          <button
            type="button"
            className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/70 dark:border-border px-2 py-1.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-amber-500/60 hover:bg-amber-500/[0.04] hover:text-foreground dark:hover:border-amber-400/60 focus-visible:ring-2 focus-visible:ring-ring outline-none"
            onClick={() => {
              const n = resetSheetCellStrokes(sheet.id);
              if (n > 0) {
                toast.success(
                  `Cleared ${n} stroke exception${n === 1 ? "" : "s"} — every cell follows the sheet stroke settings again`,
                  { description: "Ctrl Z to undo" }
                );
              }
            }}
          >
            <Eraser className="h-3 w-3" aria-hidden />
            Reset all {sheetExceptionCount} exception{sheetExceptionCount === 1 ? "" : "s"} on this sheet
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function IconCellHotspots({
  sheetId,
  canvasW,
  canvasH,
}: {
  sheetId: string;
  canvasW: number;
  canvasH: number;
}) {
  const sheet = useStudio((s) => s.sheets.find((sh) => sh.id === sheetId)) ?? null;
  const icons = useStudio((s) => s.icons);
  const sheets = useStudio((s) => s.sheets);
  const setHero = useStudio((s) => s.setHero);
  const moveIcons = useStudio((s) => s.moveIcons);
  const reorderSheetIcons = useStudio((s) => s.reorderSheetIcons);
  const openInspector = useStudio((s) => s.openInspector);
  /* round 10/11: cell selection lifted into the store (now multi-cell). The
   * selection is scoped to this sheet via selectedCellSheetId (switching
   * sheets clears it in setActiveSheet). */
  const selectedCellIconIds = useStudio((s) =>
    s.selectedCellSheetId === sheetId ? s.selectedCellIconIds : EMPTY_CELL_IDS
  );
  const setSelectedCell = useStudio((s) => s.setSelectedCell);
  const toggleCellInSelection = useStudio((s) => s.toggleCellInSelection);
  const rangeSelectCells = useStudio((s) => s.rangeSelectCells);
  const clearSelectedCell = useStudio((s) => s.clearSelectedCell);
  const setCellSkip = useStudio((s) => s.setCellSkip);
  /* round 12: the command palette can request this bar's cell-color popover
   *  for the current selection — the store flag drives the Popover's open
   *  state so palette-triggered and click-triggered opens behave identically. */
  const cellColorPickerOpen = useStudio((s) => s.cellColorPickerOpen);
  const openCellColorPicker = useStudio((s) => s.openCellColorPicker);
  const closeCellColorPicker = useStudio((s) => s.closeCellColorPicker);
  const [overflowTarget, setOverflowTarget] = useState<{ iconId: string; sheetId: string } | null>(null);
  /* round 12 roving tabindex — the Tab stop follows the last focused cell
   * (click or arrow walk). Positional cell keys keep button identity across
   * reorders, so the stop survives icon moves; clamp keeps it valid when
   * cells shrink (icons removed / moved to other sheets). */
  const [rovingIndex, setRovingIndex] = useState(0);

  const template = sheet ? sheetTemplate(sheet) : null;
  const grid = useMemo(
    () => (sheet && template ? computeGrid(template, sheet.design) : null),
    [sheet, template]
  );

  const count = Math.min(sheet?.iconIds.length ?? 0, grid ? grid.slots ? grid.slots.length : grid.cols * grid.rows : 0);
  const cells = useMemo(() => {
    if (!grid) return [];
    const out: { iconId: string; x: number; y: number; size: number; w: number; h: number; isHero: boolean }[] = [];
    for (let i = 0; i < count; i++) {
      const iconId = sheet!.iconIds[i];
      /* imported templates place icons at the EXACT detected slots */
      if (grid.slots) {
        const slot = grid.slots[i];
        out.push({
          iconId,
          x: slot.x,
          y: slot.y,
          size: Math.min(slot.width, slot.height),
          w: slot.width,
          h: slot.height,
          isHero: sheet!.heroIconId === iconId,
        });
        continue;
      }
      const col = i % grid.cols;
      const row = Math.floor(i / grid.cols);
      const size = grid.cell;
      out.push({
        iconId,
        x: grid.originX + col * (grid.cell + grid.gap),
        y: grid.originY + row * (grid.cell + grid.gap),
        size,
        w: size,
        h: size,
        isHero: sheet!.heroIconId === iconId,
      });
    }
    return out;
  }, [grid, count, sheet]);

  /* clamp the roving Tab stop against the live cell count (icons can leave
   * the sheet between renders — an out-of-range stop would orphan the grid) */
  const safeRovingIndex = Math.min(rovingIndex, Math.max(0, cells.length - 1));

  const selectedIcon = selectedCellIconIds.length === 1 ? icons[selectedCellIconIds[0]] : null;
  const movableSheets = sheets.filter((s) => s.id !== sheetId);
  /* per-cell overrides for this sheet (skip / card color), read straight
   *  off the live sheet object — re-renders on every store change already */
  const overrides = sheet?.cellOverrides ?? {};
  const selectedSkipped = selectedCellIconIds.length > 0 &&
    selectedCellIconIds.every((id) => overrides[id]?.skip === true);
  const someSelectedSkipped = selectedCellIconIds.some((id) => overrides[id]?.skip === true);
  const selectedCardColor = selectedCellIconIds.length > 0
    ? overrides[selectedCellIconIds[0]]?.cardColor ?? null
    : null;
  /* round 12: gradient override on the selection's first cell — same
   *  "first cell shows as current" convention as the solid picker */
  const selectedCardGradient = selectedCellIconIds.length > 0
    ? overrides[selectedCellIconIds[0]]?.cardGradient ?? null
    : null;
  /* round 9: stroke exception on the selection's first cell — same
   *  "first cell shows as current" convention as the fill pickers.
   *  round 12: the WEIGHT exception rides along for relative mode. */
  const selectedStrokeTarget = selectedCellIconIds.length > 0
    ? overrides[selectedCellIconIds[0]]?.strokeTargetPx ?? null
    : null;
  const selectedStrokeWeight = selectedCellIconIds.length > 0
    ? overrides[selectedCellIconIds[0]]?.strokeWeightPx ?? null
    : null;
  /* custom templates render their own cell artwork — per-cell color is a
   *  no-op there (skip still works), so the control is hidden */
  const allowCellColor = template?.sourceType !== "custom";
  const getCapacity = (sid: string) => {
    const s = sheets.find((x) => x.id === sid);
    return s ? sheetTemplate(s)?.capacity ?? s.iconIds.length : 0;
  };

  function doMove(iconId: string, targetId: string, create: boolean) {
    const result = moveIcons([iconId], targetId, create);
    if (result.overflow.length > 0) {
      setOverflowTarget({ iconId, sheetId: targetId });
      return;
    }
    if (result.moved.length > 0) {
      const idx = sheets.findIndex((s) => s.id === targetId);
      toast.success(`Icon moved to Sheet ${String(idx + 1).padStart(2, "0")}`);
      clearSelectedCell();
    }
  }

  /* batch move (round 11): move all selected cells to a target sheet. The
   * moveIcons store action already accepts an array; if the target overflows,
   * the overflow icons stay on the source sheet (no overflow dialog for the
   * multi case — the single-icon dialog is too narrow for a batch). */
  function doMoveMany(iconIds: string[], targetId: string) {
    const result = moveIcons(iconIds, targetId, false);
    const idx = sheets.findIndex((s) => s.id === targetId);
    if (result.moved.length > 0) {
      toast.success(`Moved ${result.moved.length} icon${result.moved.length === 1 ? "" : "s"} to Sheet ${String(idx + 1).padStart(2, "0")}`);
    }
    if (result.overflow.length > 0) {
      toast.info(`${result.overflow.length} icon${result.overflow.length === 1 ? "" : "s"} didn't fit — left on this sheet`);
    }
    clearSelectedCell();
  }

  if (!sheet || !grid) return null;

  /* the sheet's active stroke mode — decides which exception kind the
   *  corner chips + the smart-bar popover edit (round 12) */
  const uniformCellMode = effectiveUniformStroke(sheet.design.icon);

  return (
    <>
      {/* draggable + droppable hotspots over each grid cell — keys are
          POSITIONAL (index), not icon-based: reorders reuse the same button
          nodes instead of remounting, so focus and dnd node identity survive */}
      {cells.map((c, i) => (
        <CellHotspot
          key={i}
          sheetId={sheetId}
          iconId={c.iconId}
          index={i}
          col={grid.cols > 1 ? i % grid.cols : i}
          cols={grid.cols > 1 ? grid.cols : cells.length}
          rows={grid.rows}
          x={c.x}
          y={c.y}
          size={c.size}
          w={c.w}
          h={c.h}
          canvasW={canvasW}
          canvasH={canvasH}
          isHero={c.isHero}
          fileName={icons[c.iconId]?.fileName ?? "empty cell"}
          selected={selectedCellIconIds.includes(c.iconId)}
          skipped={overrides[c.iconId]?.skip === true}
          cardColor={overrides[c.iconId]?.cardColor ?? null}
          cardGradient={overrides[c.iconId]?.cardGradient ?? null}
          strokeTargetPx={overrides[c.iconId]?.strokeTargetPx ?? null}
          strokeWeightPx={overrides[c.iconId]?.strokeWeightPx ?? null}
          uniformCellMode={uniformCellMode}
          tabStop={i === safeRovingIndex}
          onCellFocus={setRovingIndex}
          onSelect={(iconId, mode) => {
            if (mode === "toggle") {
              toggleCellInSelection(sheetId, iconId);
            } else if (mode === "range") {
              rangeSelectCells(sheetId, iconId);
            } else {
              setSelectedCell(sheetId, selectedCellIconIds.length === 1 && selectedCellIconIds[0] === iconId ? null : iconId);
            }
          }}
          onInspect={(iconId) => openInspector(iconId)}
          reorderSheetIcons={reorderSheetIcons}
        />
      ))}

      {/* floating action bar for the selected icon — chrome-only "smart bar"
          (pill, glass blur, layered shadow; all buttons/behavior unchanged) */}
      {selectedIcon && (
        <div className="studio-smart-bar absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full border border-border/70 bg-background/90 backdrop-blur px-2 py-1.5 shadow-lg shadow-black/10 max-w-[calc(100cqw-1.5rem)] overflow-x-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <span className="flex min-w-0 shrink-0 items-center gap-1.5">
            <FileText className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="max-w-[180px] truncate text-[11px] font-medium" title={selectedIcon.fileName}>
              {selectedIcon.fileName}
            </span>
          </span>
          <span className="h-4 w-px bg-border/70 shrink-0" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 gap-1 text-[11px]"
                onClick={() => openInspector(selectedIcon.id)}
              >
                <Scan className="h-3.5 w-3.5" />
                Inspect
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open the icon inspector — tags, metadata, actions</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 gap-1 text-[11px]"
                onClick={() => {
                  setHero(sheetId, selectedIcon.id);
                  toast.success("Hero icon set for this sheet");
                }}
              >
                <Star className="h-3.5 w-3.5" />
                Set hero
              </Button>
            </TooltipTrigger>
            <TooltipContent>Make this the sheet&apos;s hero icon</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className={cn("h-7 shrink-0 gap-1 text-[11px]", selectedSkipped && "text-stone-600 dark:text-stone-300")}
                onClick={() => {
                  setCellSkip(sheetId, [selectedIcon.id], !selectedSkipped);
                  if (selectedSkipped) {
                    toast.success("Cell restored — renders in preview & export");
                  } else {
                    toast.info("Cell skipped — hidden from preview & export", {
                      description: "The icon stays on the sheet; Ctrl Z to undo",
                    });
                  }
                }}
              >
                {selectedSkipped ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                {selectedSkipped ? "Unskip" : "Skip"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {selectedSkipped
                ? "Render this cell again"
                : "Hide this cell from preview & export without removing the icon"}
            </TooltipContent>
          </Tooltip>

          {allowCellColor ? (
            <CellColorPopover
              sheet={sheet}
              iconIds={[selectedIcon.id]}
              current={selectedCardColor}
              currentGradient={selectedCardGradient}
              open={cellColorPickerOpen}
              onOpenChange={(o) => (o ? openCellColorPicker() : closeCellColorPicker())}
            />
          ) : null}

          {/* per-icon stroke exception (round 9) — own uniform target for
              this cell; works on custom templates too (engine-level) */}
          <CellStrokePopover
            sheet={sheet}
            iconIds={[selectedIcon.id]}
            currentTarget={selectedStrokeTarget}
            currentWeight={selectedStrokeWeight}
          />

          {movableSheets.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-7 shrink-0 gap-1 text-[11px]">
                  <ArrowRightLeft className="h-3.5 w-3.5" />
                  Move to…
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                <DropdownMenuLabel className="pro-label">Move icon to sheet</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {movableSheets.map((s, idx) => {
                  const cap = getCapacity(s.id);
                  const free = cap - s.iconIds.length;
                  return (
                    <DropdownMenuItem
                      key={s.id}
                      disabled={free <= 0}
                      onClick={() => doMove(selectedIcon.id, s.id, false)}
                      className="text-[11px] gap-2"
                    >
                      <span className="font-medium">Sheet {String(idx + 1).padStart(2, "0")}</span>
                      <span className="text-muted-foreground">
                        {s.iconIds.length}/{cap} · {s.category}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {/* round 19 · polish: separator + shrink-0 on the trailing X — the
              bar never compresses its buttons when overflowing, and the
              close affordance reads as its own group */}
          <span className="h-4 w-px bg-border/70 shrink-0" />
          <Button size="sm" variant="ghost" className="h-7 w-7 shrink-0 p-0 hover:bg-muted" onClick={() => clearSelectedCell()} aria-label="Deselect icon">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* multi-selection floating action bar (round 11) — shows when ≥2 cells
       * are selected. A simpler bar: a count, a batch "Move all to…" dropdown,
       * and a clear button. Single-icon actions (Inspect, Set hero) don't
       * apply to a batch. */}
      {selectedCellIconIds.length >= 2 && (
        <div className="studio-smart-bar studio-smart-bar--batch absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full border border-amber-500/50 bg-background/90 backdrop-blur px-2 py-1.5 shadow-lg shadow-black/10 max-w-[calc(100cqw-1.5rem)] overflow-x-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-amber-500 text-[10px] font-semibold text-amber-50 tabular-nums">
              {selectedCellIconIds.length}
            </span>
            selected
            {someSelectedSkipped ? (
              <span
                className="grid h-4 w-4 place-items-center rounded-full bg-stone-600 text-white"
                title={`${selectedCellIconIds.filter((id) => overrides[id]?.skip).length} of the selection are skipped`}
              >
                <EyeOff className="h-2.5 w-2.5" aria-hidden />
              </span>
            ) : null}
          </span>
          <span className="h-4 w-px bg-border/70 shrink-0" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className={cn("h-7 shrink-0 gap-1 text-[11px]", selectedSkipped && "text-stone-600 dark:text-stone-300")}
                onClick={() => {
                  /* batch semantics: unskip only when EVERY selected cell is
                   *  already skipped; otherwise the button skips the batch */
                  setCellSkip(sheetId, selectedCellIconIds, !selectedSkipped);
                  if (selectedSkipped) {
                    toast.success(`Restored ${selectedCellIconIds.length} cells`);
                  } else {
                    toast.info(`Skipped ${selectedCellIconIds.length} cells — hidden from preview & export`, {
                      description: "Icons stay on the sheet; Ctrl Z to undo",
                    });
                  }
                }}
              >
                {selectedSkipped ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                {selectedSkipped ? "Unskip all" : "Skip all"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {selectedSkipped
                ? "Render all selected cells again"
                : "Hide all selected cells from preview & export"}
            </TooltipContent>
          </Tooltip>
          {allowCellColor ? (
            <CellColorPopover
              sheet={sheet}
              iconIds={selectedCellIconIds}
              current={selectedCardColor}
              currentGradient={selectedCardGradient}
              open={cellColorPickerOpen}
              onOpenChange={(o) => (o ? openCellColorPicker() : closeCellColorPicker())}
            />
          ) : null}
          {/* batch stroke exceptions (round 9): one target for every
              selected cell; the first cell's value seeds the draft */}
          <CellStrokePopover
            sheet={sheet}
            iconIds={selectedCellIconIds}
            currentTarget={selectedStrokeTarget}
            currentWeight={selectedStrokeWeight}
          />
          {movableSheets.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-7 shrink-0 gap-1 text-[11px]">
                  <ArrowRightLeft className="h-3.5 w-3.5" />
                  Move all to…
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                <DropdownMenuLabel className="pro-label">
                  Move {selectedCellIconIds.length} icons to sheet
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {movableSheets.map((s, idx) => {
                  const cap = getCapacity(s.id);
                  const free = cap - s.iconIds.length;
                  return (
                    <DropdownMenuItem
                      key={s.id}
                      disabled={free <= 0}
                      onClick={() => doMoveMany(selectedCellIconIds, s.id)}
                      className="text-[11px] gap-2"
                    >
                      <span className="font-medium">Sheet {String(idx + 1).padStart(2, "0")}</span>
                      <span className="text-muted-foreground">
                        {s.iconIds.length}/{cap} · {free} free · {s.category}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <span className="h-4 w-px bg-border/70 shrink-0" />
          <Button size="sm" variant="ghost" className="h-7 w-7 shrink-0 p-0 hover:bg-muted" onClick={() => clearSelectedCell()} aria-label="Deselect all">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* sheet-full overflow dialog */}
      <AlertDialog open={overflowTarget !== null} onOpenChange={(o) => !o && setOverflowTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sheet is full</AlertDialogTitle>
            <AlertDialogDescription>
              The destination sheet has no free cells. Create a new sheet for this icon?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (overflowTarget) {
                  moveIcons([overflowTarget.iconId], overflowTarget.sheetId, true);
                  clearSelectedCell();
                  toast.success("New sheet created with the icon");
                }
                setOverflowTarget(null);
              }}
            >
              Create new sheet
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

