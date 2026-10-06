"use client";

/**
 * ICON SHEET STUDIO — Multi-Sheet Edit Workspace (round 14).
 *
 * A vertical multi-artboard editor. ALL generated sheets render in a single
 * scrollable column; each preserves its template's aspect ratio, has clean
 * vertical spacing, an active outline, and click-to-activate. Only the ACTIVE
 * sheet mounts IconCellHotspots (interactive cells) — inactive sheets render
 * their SVG artwork only (a huge DOM saving for 50–100+ sheet projects).
 *
 * Editing safety: every store mutation takes an explicit `sheetId`, so there
 * is NO global edit state. Editing Sheet 03 never touches Sheet 04. The
 * Properties panel reads `activeSheetId` and operates on exactly that sheet.
 *
 * Scroll vs active:
 *   - Clicking a sheet artboard → setActiveSheet + scrollIntoView.
 *   - Scrolling → navigates the viewport only; does NOT change the active
 *     (edit-target) sheet. An IntersectionObserver tracks the "viewed"
 *     sheet for a non-destructive status indicator in the toolbar.
 *
 * Reuses the existing toolbar (zoom / guides / randomize / stats) and the
 * existing IconCellHotspots — no editing surface was rewritten.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useShallow } from "zustand/react/shallow";
import { useStudio, ZOOM_MIN, ZOOM_MAX } from "@/lib/studio/store";
import { sheetTemplate } from "@/lib/studio/templates";
import { sheetTitle } from "@/lib/studio/types";
import { renderSheet } from "@/lib/studio/renderer";
import { IconCellHotspots } from "./sheet-preview";
import { useCanvasPan } from "./use-canvas-pan";
import {
  Dices,
  Grid2x2,
  ZoomIn,
  ZoomOut,
  Maximize,
  Star,
  ChevronDown,
  Hand,
  MousePointerClick,
  GripHorizontal,
  Scan,
  Eye,
  EyeOff,
  Palette,
  Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* SheetArtboard — one sheet's rendered artwork + (if active) hotspots  */
/* ------------------------------------------------------------------ */

interface ArtboardProps {
  sheetId: string;
  index: number;
  total: number;
  isActive: boolean;
  zoom: number; // 0 = fit, else a multiplier
  showGuides: boolean;
  onActivate: (sheetId: string) => void;
  /** ref callback so the workspace can scrollIntoView / observe each artboard */
  registerNode: (sheetId: string, el: HTMLDivElement | null) => void;
}

/**
 * A single artboard. Memoized so that when the active sheet changes, only the
 * two affected artboards (old active → re-render to drop hotspots; new active
 * → re-render to add hotspots) update. Inactive artboards with unchanged
 * sheet state never re-render.
 */
const SheetArtboard = memo(function SheetArtboard({
  sheetId,
  index,
  total,
  isActive,
  zoom,
  showGuides,
  onActivate,
  registerNode,
}: ArtboardProps) {
  const sheet = useStudio((s) => s.sheets.find((sh) => sh.id === sheetId) ?? null);
  /* NARROWED icon subscription (large-library performance): renderSheet
   * reads ONLY `icon.svg` from the entries a sheet references (grid ids +
   * the hero id) — so the reactive dependency is exactly that list of svg
   * strings, shallow-compared. A library mutation that does not change any
   * svg THIS sheet renders (tag edits, imports for other sheets, renames)
   * no longer re-renders/re-rasterizes this artboard — previously ANY
   * icons-map identity change rebuilt every artboard's full SVG string. */
  const heroIconId = sheet?.heroIconId;
  const iconIds = sheet?.iconIds;
  const sheetIconSvgs = useStudio(
    useShallow((s) => {
      const out: (string | undefined)[] = [];
      if (iconIds) {
        for (const id of iconIds) out.push(s.icons[id]?.svg);
      }
      if (heroIconId) out.push(s.icons[heroIconId]?.svg);
      return out;
    })
  );
  const setActiveSheet = useStudio((s) => s.setActiveSheet);
  const setViewMode = useStudio((s) => s.setViewMode);
  const randomizeSheet = useStudio((s) => s.randomizeSheet);

  /* this artboard is a DROP TARGET for library icon drags. Registered with
   * the OUTER DndContext as a "sheet-card" — identical semantics to the
   * overview cards + the old single-sheet preview, so the shell's dragEnd
   * handler (with its overflow → create-new-sheet dialog) routes these
   * drops unchanged. Dropping lands on the SHEET under the cursor, not the
   * active sheet (dnd-kit's collision detection uses the pointer position). */
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `artboard-${sheetId}`,
    data: { type: "sheet-card", sheetId },
  });

  const template = useMemo(() => (sheet ? sheetTemplate(sheet) : undefined), [sheet]);
  const svg = useMemo(() => {
    if (!sheet || !template) return "";
    /* getState() (non-reactive) supplies the icon records at execution
     * time — the REACTIVE invalidation is sheetIconSvgs above, which
     * changes exactly when a referenced svg changes. */
    return renderSheet(sheet, template, useStudio.getState().icons, {
      mode: "preview",
      showGuides: showGuides && isActive, /* guides only on the active sheet
                                            * (the one being edited) */
    });
  }, [sheet, template, sheetIconSvgs, showGuides, isActive]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    /* only mount hotspots for the active sheet, and only after a short tick
     * so the SVG has laid out (matches the old single-sheet behavior). */
    if (!isActive) return;
    const t = setTimeout(() => setMounted(true), 30);
    return () => clearTimeout(t);
  }, [isActive]);
  /* when the sheet stops being active, unmount hotspots immediately (no
   * setState-in-effect — derive it from the prop). */
  const hotspotsMounted = isActive && mounted;

  /* combined ref: droppable + the workspace's node registry */
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      setDropRef(node);
      registerNode(sheetId, node);
    },
    [setDropRef, registerNode, sheetId]
  );

  if (!sheet || !template) return null;

  const aspectRatio = template.width / template.height;
  const sheetLabel = sheetTitle(sheet, index);
  const z = zoom === 0 ? null : zoom; // null = fit
  /* per-cell skip count for the label strip (round 7 review) */
  const skippedCount = sheet.iconIds.filter(
    (id) => sheet.cellOverrides?.[id]?.skip === true,
  ).length;
  /* round 12: custom cell fills (solid or gradient) — surfaces an otherwise
   *  invisible state at a glance, next to the skip chip */
  const customFillCount = sheet.iconIds.filter((id) => {
    const o = sheet.cellOverrides?.[id];
    return !!o && ((o.cardColor != null && o.cardColor.trim() !== "") || o.cardGradient != null);
  }).length;

  return (
    <div
      ref={setRef}
      data-sheet-id={sheetId}
      data-artboard-index={index}
      onClick={(e) => {
        /* clicking the artboard (but NOT a child interactive element like a
         * cell hotspot) activates this sheet. Cell hotspots stopPropagation
         * via dnd-kit's own click handling, so this fires on background clicks. */
        const target = e.target as HTMLElement;
        if (target.closest("[data-cell-index]")) return; // a cell click — let it through
        if (!isActive) onActivate(sheetId);
      }}
      className={cn(
        "sheet-artboard group relative mx-auto my-5 rounded-xl sheet-stack overflow-visible transition-shadow",
        isActive ? "" : "cursor-pointer"
      )}
      style={
        z
          ? {
              width: `${z * 100}%`,
              /* floor keeps deep zoom-out sheets perceivable; above it the
               * width is faithful (z ∈ [0.25, 5] → 25%–500% of the column) */
              minWidth: 160,
              /* NO maxWidth clamp: zooming IN (z > 1) must let the artboard
               * grow past the column so the sheet genuinely enlarges — the
               * canvas then pans it horizontally (overflow-x-auto below).
               * `mx-auto` keeps it centered while it fits and left-anchors
               * it (overflow to the right, fully scrollable) when over-wide. */
            }
          : {
              width: "100%",
              /* fit-to-screen: cap by the ACTUAL available workspace height.
               * `100cqh` resolves against the canvas size container (the
               * scrollable workspace viewport — header/toolbar/footer already
               * excluded), so the fit is correct at every viewport height and
               * every sidebar combination, instead of a hardcoded 100vh
               * assumption. The 100px reserve covers the label strip (~23px),
               * the artboard's vertical margins (my-5 = 40px) and the sticky
               * interaction legend at the bottom of the canvas. */
              maxWidth: `min(100%, calc((100cqh - 100px) * ${aspectRatio.toFixed(4)}))`,
            }
      }
      aria-label={`${sheetLabel}: ${sheet.category}, ${sheet.iconIds.length} of ${template.capacity} icons${isActive ? " (active)" : ""}`}
      aria-current={isActive ? "true" : undefined}
    >
      {/* sheet label strip — always visible above the artwork */}
      <div
        className={cn(
          "flex items-center gap-2 px-1 pb-1.5 text-[11px]",
          isActive ? "text-foreground" : "text-muted-foreground"
        )}
      >
        <span className="font-medium tabular-nums">{sheetLabel}</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="truncate max-w-[160px]">{sheet.category || "Uncategorized"}</span>
        {skippedCount > 0 ? (
          <span
            className="ws-chip ws-chip--skip px-1.5 py-0.5 text-[9px]"
            title={`${skippedCount} cell${skippedCount === 1 ? "" : "s"} skipped — hidden from preview & export`}
          >
            <EyeOff className="h-2.5 w-2.5" aria-hidden />
            {skippedCount} skipped
          </span>
        ) : null}
        {customFillCount > 0 ? (
          <span
            className="ws-chip ws-chip--fill px-1.5 py-0.5 text-[9px]"
            title={`${customFillCount} cell${customFillCount === 1 ? "" : "s"} with a custom fill (color or gradient) — overrides the sheet design`}
          >
            <Palette className="h-2.5 w-2.5" aria-hidden />
            {customFillCount} fill{customFillCount === 1 ? "" : "s"}
          </span>
        ) : null}
        <span className="ws-count ml-auto font-mono tabular-nums text-[10px]">
          {sheet.iconIds.length}/{template.capacity}
        </span>
        {isActive ? (
          <span
            className="ws-chip ws-chip--edit px-1.5 py-0.5 text-[9px] uppercase tracking-wide"
            title="This is the sheet the Properties panel edits — click another sheet to switch"
          >
            <Pencil className="h-2.5 w-2.5" aria-hidden />
            Editing
          </span>
        ) : null}
      </div>

      {/* the rendered sheet SVG + (active only) icon hotspots */}
      <div
        ref={setDropRef}
        className="relative rounded-xl transparency-grid overflow-visible"
      >
        <div
          role="img"
          aria-hidden
          className="w-full [&>svg]:block [&>svg]:w-full [&>svg]:h-auto [&>svg]:rounded-xl"
          style={{ aspectRatio: `${template.width} / ${template.height}` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        {hotspotsMounted && isActive ? (
          <IconCellHotspots sheetId={sheet.id} canvasW={template.width} canvasH={template.height} />
        ) : null}

        {/* drop hint overlay while a library icon drag hovers this artboard */}
        {isOver ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-xl border-2 border-dashed border-amber-500 bg-amber-500/10 backdrop-blur-[1px]"
          >
            <span className="rounded-full bg-amber-500 px-3 py-1.5 text-[11px] font-medium text-amber-50 shadow-xs">
              Drop to move into {sheetLabel}
            </span>
          </div>
        ) : null}

        {/* "click to activate" hint on inactive artboards */}
        {!isActive ? (
          <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl bg-background/0 opacity-0 transition-opacity group-hover:bg-background/5 group-hover:opacity-100">
            <span className="rounded-full bg-background/90 px-3 py-1 text-[11px] font-medium text-foreground shadow-xs border border-border">
              Click to activate
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* MultiSheetWorkspace — the scrollable vertical column of artboards   */
/* ------------------------------------------------------------------ */

export function MultiSheetWorkspace() {
  const sheets = useStudio((s) => s.sheets);
  const activeSheetId = useStudio((s) => s.activeSheetId);
  const icons = useStudio((s) => s.icons);
  const settings = useStudio((s) => s.settings);
  const setZoom = useStudio((s) => s.setZoom);
  const toggleGuides = useStudio((s) => s.toggleGridGuides);
  const setViewMode = useStudio((s) => s.setViewMode);
  const setActiveSheet = useStudio((s) => s.setActiveSheet);
  const randomizeSheet = useStudio((s) => s.randomizeSheet);

  const canvasRef = useRef<HTMLDivElement>(null);
  /* Space + drag canvas panning — one reusable system bound to THE scroll
   * viewport that hosts every artboard (works at all zoom levels; pure DOM
   * attribute state, zero React renders in the pan hot path). */
  const bindCanvasPan = useCanvasPan();
  const setCanvasRef = useCallback(
    (node: HTMLDivElement | null) => {
      canvasRef.current = node;
      bindCanvasPan(node);
    },
    [bindCanvasPan],
  );
  /* map of sheetId → artboard DOM node (for scrollIntoView + IntersectionObserver) */
  const nodeMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const [viewedSheetId, setViewedSheetId] = useState<string | null>(activeSheetId);

  /* register/unregister artboard nodes */
  const registerNode = useCallback((sheetId: string, el: HTMLDivElement | null) => {
    if (el) nodeMap.current.set(sheetId, el);
    else nodeMap.current.delete(sheetId);
  }, []);

  /* activate a sheet (click handler) + scroll it into view */
  const activateSheet = useCallback(
    (sheetId: string) => {
      setActiveSheet(sheetId);
      setViewMode("edit");
      const el = nodeMap.current.get(sheetId);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    [setActiveSheet, setViewMode]
  );

  /* IntersectionObserver: track which artboard is most prominently visible.
   * This is the VIEWED sheet (non-destructive — scrolling does NOT change the
   * active/edit-target sheet). Used for a subtle "viewing Sheet NN" indicator. */
  useEffect(() => {
    const root = canvasRef.current;
    if (!root || sheets.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // pick the most-visible entry
        let best: { id: string; ratio: number } | null = null;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = (e.target as HTMLElement).dataset.sheetId;
          if (!id) continue;
          if (!best || e.intersectionRatio > best.ratio) {
            best = { id, ratio: e.intersectionRatio };
          }
        }
        if (best) setViewedSheetId((best as { id: string; ratio: number }).id);
      },
      { root, threshold: [0.3, 0.5, 0.7] }
    );
    for (const el of nodeMap.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [sheets.length]);

  /* when the active sheet changes externally (e.g. Overview click, [ / ],
   * palette), scroll it into view in the workspace. */
  useEffect(() => {
    if (!activeSheetId) return;
    const el = nodeMap.current.get(activeSheetId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [activeSheetId]);

  /* Ctrl/⌘ + wheel zoom over the canvas (5% steps, 25%–500%). The listener
   * is attached natively with { passive: false } so the browser's own
   * ctrl-zoom can be suppressed while the workspace is hovered. */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const cur = useStudio.getState().settings.zoom || 1;
      const factor = e.deltaY < 0 ? 1.05 : 1 / 1.05;
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cur * factor));
      useStudio.getState().setZoom(Math.round(next * 1000) / 1000);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomPct = useCallback(() => {
    if (settings.zoom === 0) return null;
    return Math.round(settings.zoom * 100);
  }, [settings.zoom]);

  const ZOOM_PRESETS: { label: string; value: number }[] = [
    { label: "Fit to screen", value: 0 },
    { label: "50%", value: 0.5 },
    { label: "75%", value: 0.75 },
    { label: "100%", value: 1 },
    { label: "125%", value: 1.25 },
    { label: "150%", value: 1.5 },
    { label: "200%", value: 2 },
    { label: "250%", value: 2.5 },
    { label: "300%", value: 3 },
    { label: "400%", value: 4 },
    { label: "500%", value: 5 },
  ];
  const activePreset = ZOOM_PRESETS.find((p) => p.value === settings.zoom);

  const z = zoomPct();
  const activeSheet = activeSheetId ? sheets.find((sh) => sh.id === activeSheetId) ?? null : null;
  const activeTemplate = activeSheet ? sheetTemplate(activeSheet) : null;
  const viewedIndex = viewedSheetId ? sheets.findIndex((s) => s.id === viewedSheetId) : -1;
  const activeIndex = activeSheetId ? sheets.findIndex((s) => s.id === activeSheetId) : -1;

  if (sheets.length === 0) {
    return (
      <div className="flex-1 grid place-items-center">
        <div className="ws-empty text-center space-y-2.5">
          <div className="studio-empty-glyph mx-auto" aria-hidden="true">
            <Grid2x2 className="h-5 w-5" aria-hidden="true" />
          </div>
          <p className="text-sm font-medium">No sheets yet.</p>
          <p className="pro-help">Generate sheets in the overview first.</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => setViewMode("overview")}>
            Go to overview
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* toolbar (reused from the old single-sheet edit view) */}
      <div className="ws-toolbar h-11 shrink-0 border-b border-border bg-background flex items-center gap-3 px-4">
        <ToggleGroup
          type="single"
          value="edit"
          onValueChange={(v) => v === "overview" && setViewMode("overview")}
          className="studio-seg h-8 gap-0.5 p-0.5"
          aria-label="View mode"
        >
          <ToggleGroupItem value="overview" size="sm" className="studio-seg-item h-7 text-[11px] px-3" title="Overview — all sheet cards at a glance">
            Overview
          </ToggleGroupItem>
          <ToggleGroupItem value="edit" size="sm" className="studio-seg-item h-7 text-[11px] px-3" title="Edit — multi-sheet workspace">
            Edit
          </ToggleGroupItem>
        </ToggleGroup>

        <span className="h-5 w-px bg-border/60" />

        <div className="studio-toolbar-pill">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom(0)} aria-label="Fit to screen">
                <Maximize className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Fit sheet <span className="text-muted-foreground">F</span></TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom(Math.max(ZOOM_MIN, (settings.zoom || 1) - 0.25))} aria-label="Zoom out">
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Zoom presets"
                title="Zoom presets — Ctrl + scroll over the canvas for smooth zoom"
                className="ws-zoom-readout h-8 min-w-[56px] px-1.5 rounded-md text-[11px] font-mono tabular-nums text-muted-foreground hover:text-foreground transition-colors inline-flex items-center justify-center gap-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="w-8 text-center">{z ? `${z}%` : "fit"}</span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="min-w-[9rem]">
              <DropdownMenuLabel className="pro-label">Zoom</DropdownMenuLabel>
              {ZOOM_PRESETS.map((p) => (
                <DropdownMenuItem
                  key={p.value}
                  onClick={() => setZoom(p.value)}
                  className="text-[11px] gap-2 justify-between"
                  aria-checked={settings.zoom === p.value}
                >
                  <span>{p.label}</span>
                  {activePreset?.value === p.value ? <Star className="h-3 w-3 fill-amber-500 text-amber-500" aria-hidden /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom(Math.min(ZOOM_MAX, (settings.zoom || 1) + 0.25))} aria-label="Zoom in">
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
        </div>

        <span className="h-5 w-px bg-border/60" />

        <div className="studio-toolbar-pill">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn("h-8 gap-1.5 text-[11px]", settings.showGridGuides && "studio-toolbar-toggle-on")}
                onClick={toggleGuides}
                aria-pressed={settings.showGridGuides}
              >
                <Grid2x2 className="h-3.5 w-3.5" />
                <span className="hidden @2xl:inline">Guides</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Show grid guides (preview only — never exported)</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex-1" />

        {/* viewed vs active indicator — distinguishes "what I'm looking at"
            (scroll-driven, non-destructive) from "what I'm editing" (click-driven).
            Round 17: both roles are now EXPLICITLY labeled (eye icon + "viewing
            Sheet NN" for the viewport, pencil icon + "editing Sheet NN" for the
            edit target) so the two numbers can never read as one sentence.
            Container-query gated (@2xl = center pane ≥672px) so the toolbar
            never overflows on compact laptop center columns. */}
        <div className="ws-context hidden @2xl:flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {viewedSheetId && viewedSheetId !== activeSheetId ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-muted-foreground/90">
              <Eye className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="text-muted-foreground/80">viewing</span>
              <span className="font-mono tabular-nums">
                Sheet {String((viewedIndex >= 0 ? viewedIndex : 0) + 1).padStart(2, "0")}
              </span>
            </span>
          ) : null}
          {activeSheet && activeTemplate ? (
            <span
              className={cn(
                "inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5",
                viewedSheetId && viewedSheetId !== activeSheetId
                  ? "bg-amber-500/10 text-foreground/90"
                  : "bg-muted/40 text-muted-foreground",
              )}
              title={`Editing Sheet ${String((activeIndex >= 0 ? activeIndex : 0) + 1).padStart(2, "0")} — its properties panel and cell edits target this sheet`}
            >
              <Pencil className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
              <span className="sr-only">editing</span>
              <span className="font-mono tabular-nums">
                Sheet {String((activeIndex >= 0 ? activeIndex : 0) + 1).padStart(2, "0")}
              </span>
              <span className="text-muted-foreground/50">·</span>
              <span className="font-mono tabular-nums">
                {activeSheet.iconIds.length}/{activeTemplate.capacity}
              </span>
              <span>icons</span>
              <span className="text-muted-foreground/50">·</span>
              <span className="truncate max-w-[120px]">{activeSheet.category}</span>
            </span>
          ) : null}
        </div>

        {activeSheet ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-[11px] group/rand transition-colors hover:border-amber-500/60 hover:bg-amber-500/[0.06] hover:text-amber-700 dark:hover:border-amber-400/50 dark:hover:text-amber-300"
                onClick={() => randomizeSheet(activeSheet.id)}
              >
                <Dices className="h-3.5 w-3.5 transition-transform duration-300 group-hover/rand:rotate-[18deg] group-hover/rand:scale-110" />
                <span className="hidden @2xl:inline">Randomize</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Shuffle the active sheet&apos;s icon order — hero stays</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {/* the scrollable vertical workspace — a SIZE query container: `cqh`
       * inside artboards resolves to this element's visible height (the
       * scroll viewport, not the scrolled content), powering the true
       * fit-to-workspace cap above. */}
      <div
        ref={setCanvasRef}
        className="relative flex-1 overflow-y-auto overflow-x-auto workspace-canvas pan-canvas px-6 @3xl:px-8 pb-16 custom-scroll [container-type:size]"
      >
        {/* center column for the artboards (max-width keeps sheets readable
            on ultra-wide screens; sheets still preserve their aspect ratio).
            Container-query caps widen the column as the CENTER pane grows:
            ≥672px → 1180, ≥1280px → 1320 (named variants), ≥1700px → 1560
            (the `sheet-column-wide` plain-CSS rule below — unlayered rules
            beat @layer utilities, so it deterministically overrides the
            @7xl cap no matter how Tailwind orders its variants). */}
        <div className="sheet-column-wide mx-auto w-full max-w-[1100px] @2xl:max-w-[1180px] @7xl:max-w-[1320px]">
          {sheets.map((sheet, i) => (
            <SheetArtboard
              key={sheet.id}
              sheetId={sheet.id}
              index={i}
              total={sheets.length}
              isActive={sheet.id === activeSheetId}
              zoom={settings.zoom}
              showGuides={settings.showGridGuides}
              onActivate={activateSheet}
              registerNode={registerNode}
            />
          ))}
        </div>

        {/* interaction legend — discoverability */}
        <div className="pointer-events-none sticky bottom-0 left-0 right-0 z-10 flex justify-center pb-1">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border/70 dark:border-border/85 bg-background/90 backdrop-blur px-3.5 py-1 text-[10px] text-muted-foreground shadow-md shadow-black/10 dark:shadow-black/40">
            <MousePointerClick className="h-3 w-3" aria-hidden />
            <span>Click a sheet to activate</span>
            <span className="text-muted-foreground/40">·</span>
            <Hand className="h-3 w-3" aria-hidden />
            <span className="hidden @3xl:inline">hold Space + drag to pan</span>
            <span className="text-muted-foreground/40">·</span>
            <Scan className="h-3 w-3" aria-hidden />
            <span className="hidden @3xl:inline">double-click an icon to inspect</span>
            <span className="hidden text-muted-foreground/40 @3xl:inline">·</span>
            <GripHorizontal className="h-3 w-3" aria-hidden />
            <span className="hidden @3xl:inline">drag to rearrange</span>
            <span className="hidden text-muted-foreground/40 @4xl:inline">·</span>
            <span className="hidden @4xl:inline">scroll to navigate</span>
            <span className="hidden text-muted-foreground/40 @4xl:inline">·</span>
            <span className="hidden @4xl:inline">drag icons from the library onto any sheet</span>
          </div>
        </div>
      </div>
    </div>
  );
}
