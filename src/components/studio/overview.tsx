"use client";

/**
 * ICON SHEET STUDIO — Overview.
 * Rapid multi-sheet review: lightweight lazy-mounted previews, selection,
 * apply-design actions, and the "Generate Sheets" flow for unassigned
 * icons. Clicking a card opens it in Edit mode as the ACTIVE sheet.
 * Cards are DROP TARGETS for library icon drags (drop → move icons onto
 * the sheet, with the same overflow dialog semantics as the menu flow).
 */

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useDroppable } from "@dnd-kit/core";
import { useStudio, getUnassignedIconIds } from "@/lib/studio/store";
import { listTemplates, listOfficialTemplates, sheetTemplate } from "@/lib/studio/templates";
import { renderSheet } from "@/lib/studio/renderer";
import type { Sheet } from "@/lib/studio/types";
import { formatVolume, sheetTitle } from "@/lib/studio/types";
import { LazyMount } from "./lazy-mount";
import { CheckSquare, Square, Layers, Wand2, LayoutGrid, Trash2, Copy, Dices, Pencil, ArrowUpRight, Shapes, Tags, FolderOpen, Grid3x3, CircleDot, FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/* ------------------------------------------------------------------ */
/* Thumbnail derivation cache (module-level, no hooks)                 */
/* ------------------------------------------------------------------ */

/** One cached thumbnail per sheet. Key = template + updatedAt (every sheet
 * mutation re-stamps it) + the icon sources actually referenced — so icon
 * imports / tag edits elsewhere in the library never re-render other cards,
 * and undo restoring an old sheet object correctly misses the cache. */
const thumbCache = new Map<string, { key: string; svg: string }>();

function cachedThumb(sheet: Sheet, template: NonNullable<ReturnType<typeof sheetTemplate>>, icons: Record<string, import("@/lib/studio/types").IconEntry>): string {
  const contentKey = sheet.iconIds
    .map((id) => {
      const ic = icons[id];
      return ic ? `${ic.svg.length}:${ic.fileName}` : "missing";
    })
    .join(",");
  const key = `${template.id}|${sheet.updatedAt}|${contentKey}`;
  const hit = thumbCache.get(sheet.id);
  if (hit && hit.key === key) return hit.svg;
  const svg = renderSheet(sheet, template, icons, { mode: "export", quality: "thumb" });
  thumbCache.set(sheet.id, { key, svg });
  return svg;
}

/* ------------------------------------------------------------------ */
/* Lightweight sheet preview card                                      */
/* ------------------------------------------------------------------ */

function SheetCard({ sheet, index }: { sheet: Sheet; index: number }) {
  const icons = useStudio((s) => s.icons);
  const activeSheetId = useStudio((s) => s.activeSheetId);
  const selectedSheetIds = useStudio((s) => s.selectedSheetIds);
  const setActiveSheet = useStudio((s) => s.setActiveSheet);
  const setViewMode = useStudio((s) => s.setViewMode);
  const toggleSheetSelected = useStudio((s) => s.toggleSheetSelected);
  const deleteSheet = useStudio((s) => s.deleteSheet);
  const duplicateSheet = useStudio((s) => s.duplicateSheet);
  const randomizeSheet = useStudio((s) => s.randomizeSheet);

  const template = sheetTemplate(sheet);
  const isActive = sheet.id === activeSheetId;
  const isSelected = selectedSheetIds.includes(sheet.id);
  const capacity = template?.capacity ?? sheet.iconIds.length;
  const fill = capacity > 0 ? sheet.iconIds.length / capacity : 0;

  /* drop target for library icon drags */
  const { setNodeRef, isOver } = useDroppable({
    id: `card-${sheet.id}`,
    data: { type: "sheet-card", sheetId: sheet.id },
  });

  /* thumbnails render WITHOUT preview overlays — pure artwork, low cost.
   * cachedThumb() memoizes by sheet mutation stamp + referenced icon sources
   * (see above). Thumb quality skips the micro footer line (round-5 VLM note). */
  const svg = template ? cachedThumb(sheet, template, icons) : "";

  function open() {
    setActiveSheet(sheet.id);
    setViewMode("edit");
  }

  return (
    <motion.div
      ref={setNodeRef}
      initial={{ opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.16 } }}
      transition={{ duration: 0.24, ease: "easeOut" }}
      whileHover={{ y: -2, transition: { duration: 0.18, ease: [0.2, 0.8, 0.3, 1] } }}
      className={cn(
        "card-sheen group relative rounded-xl border bg-card overflow-hidden transition-[border-color,box-shadow] duration-200 shadow-sm hover:shadow-md hover:shadow-black/15 dark:hover:shadow-black/50",
        isActive ? "border-amber-500/70 ring-1 ring-amber-500/40" : "border-border/70 dark:border-border hover:border-border",
        isSelected && !isActive && "border-amber-500/50",
        isOver && "drop-pulse border-amber-500 ring-2 ring-amber-500/60",
      )}
    >
      {/* capacity fill rail — mirrors the sheet-nav rail language */}
      <div
        aria-hidden="true"
        title={`${sheet.iconIds.length} of ${capacity} cells filled`}
        className="absolute inset-x-0 top-0 z-10 h-[2.5px] bg-muted/70"
      >
        <div
          className={cn(
            "h-full transition-[width] duration-300",
            fill >= 1 ? "bg-amber-500" : fill > 0.6 ? "bg-amber-500/75" : "bg-amber-500/50",
          )}
          style={{ width: `${Math.round(fill * 100)}%` }}
        />
      </div>
      <button
        type="button"
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") open();
        }}
        className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Open sheet ${index + 1}: ${sheet.category}, ${sheet.iconIds.length} icons, volume ${sheet.volume}`}
      >
        <LazyMount minHeight={0} className="w-full transparency-grid">
          <div
            role="img"
            aria-hidden
            className="w-full pointer-events-none [&>svg]:block [&>svg]:w-full [&>svg]:h-auto"
            style={{ aspectRatio: template ? `${template.width} / ${template.height}` : "1200 / 1500" }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </LazyMount>

        <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-t border-border/70 dark:border-border bg-card">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[12px] font-medium tracking-tight">
              <span className="truncate">{sheetTitle(sheet, index)}</span>
              <span className="shrink-0 pro-label">
                {template?.name ?? "Custom"}
              </span>
              <ArrowUpRight
                className="ml-auto h-3 w-3 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-amber-600"
                aria-hidden="true"
              />
            </div>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground min-w-0">
              <span className="truncate max-w-[120px]" title={sheet.category}>
                {sheet.category}
              </span>
              <span className="text-muted-foreground/50">·</span>
              <span className="font-mono tabular-nums shrink-0">{formatVolume(sheet.volume)}</span>
            </div>
          </div>
          <Badge
            variant={sheet.iconIds.length >= capacity ? "default" : "secondary"}
            className={cn(
              "overview-count-chip font-mono text-[10px] tabular-nums shrink-0",
              sheet.iconIds.length >= capacity && "overview-count-chip--full",
            )}
          >
            {sheet.iconIds.length}/{capacity}
          </Badge>
        </div>
      </button>

      {/* drop hint overlay while an icon drag hovers this card */}
      {isOver ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl border-2 border-dashed border-amber-500 bg-amber-500/10"
        >
          <span className="rounded-full bg-amber-500 px-3 py-1 text-[11px] font-medium text-amber-50 shadow-xs">
            Drop to move here
          </span>
        </div>
      ) : null}

      {/* selection checkbox */}
      <button
        type="button"
        aria-label={isSelected ? `Remove sheet ${index + 1} from selection` : `Select sheet ${index + 1}`}
        title={isSelected ? "Remove from selection" : "Select"}
        className={cn(
          "absolute top-2 left-2 z-10 h-5 w-5 rounded-md border grid place-items-center backdrop-blur transition",
          isSelected
            ? "bg-amber-500 border-amber-500 text-amber-50 shadow-xs"
            : "bg-background/80 border-border text-transparent opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        )}
        onClick={(e) => {
          e.stopPropagation();
          toggleSheetSelected(sheet.id);
        }}
      >
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="4">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </button>

      {/* active marker */}
      {isActive ? (
        <span className="absolute top-2 right-2 z-10 inline-flex items-center gap-1 rounded-full bg-amber-500 text-amber-50 text-[10px] font-semibold px-2 py-0.5 shadow-xs">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-50" />
          Active
        </span>
      ) : null}

      {/* edit + randomize + duplicate + delete — hover-revealed quick actions */}
      <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Edit sheet ${index + 1}`}
              title="Open this sheet in the edit view"
              className="h-6 w-6 rounded-md grid place-items-center bg-background/85 border border-border/70 dark:border-border text-muted-foreground hover:text-foreground hover:border-foreground/25 hover:shadow-md hover:shadow-black/15 dark:hover:shadow-black/50 hover:-translate-y-px active:translate-y-0 motion-reduce:hover:translate-y-0 motion-reduce:active:translate-y-0 backdrop-blur transition"
              onClick={(e) => {
                e.stopPropagation();
                open();
              }}
            >
              <Pencil className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Open in edit view</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Randomize sheet ${index + 1} icon order`}
              title="Randomize icon order (hero stays)"
              className={cn(
                "h-6 w-6 rounded-md grid place-items-center bg-background/85 border border-border/70 dark:border-border text-muted-foreground hover:text-foreground hover:border-foreground/25 hover:shadow-md hover:shadow-black/15 dark:hover:shadow-black/50 hover:-translate-y-px active:translate-y-0 motion-reduce:hover:translate-y-0 motion-reduce:active:translate-y-0 backdrop-blur transition",
                sheet.iconIds.length < 2 && "opacity-40 pointer-events-none cursor-not-allowed",
              )}
              disabled={sheet.iconIds.length < 2}
              onClick={(e) => {
                e.stopPropagation();
                randomizeSheet(sheet.id);
              }}
            >
              <Dices className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Shuffle icons — hero stays in place</TooltipContent>
        </Tooltip>
        <button
          type="button"
          aria-label={`Duplicate sheet ${index + 1} design`}
          title="Duplicate design into a new empty sheet"
          className="h-6 w-6 rounded-md grid place-items-center bg-background/85 border border-border/70 dark:border-border text-muted-foreground hover:text-foreground hover:border-foreground/25 hover:shadow-md hover:shadow-black/15 dark:hover:shadow-black/50 hover:-translate-y-px active:translate-y-0 motion-reduce:hover:translate-y-0 motion-reduce:active:translate-y-0 backdrop-blur transition"
          onClick={(e) => {
            e.stopPropagation();
            duplicateSheet(sheet.id);
          }}
        >
          <Copy className="h-3 w-3" />
        </button>
        <AlertDialog>
        <AlertDialogTrigger asChild>
          <button
            type="button"
            aria-label={`Delete sheet ${index + 1}`}
            title="Delete sheet (icons return to the library)"
            className="h-6 w-6 rounded-md grid place-items-center bg-background/85 border border-border/70 dark:border-border text-muted-foreground hover:text-red-600 hover:border-red-300 hover:shadow-md hover:shadow-black/15 dark:hover:shadow-black/50 hover:-translate-y-px active:translate-y-0 motion-reduce:hover:translate-y-0 motion-reduce:active:translate-y-0 backdrop-blur transition"
            onClick={(e) => e.stopPropagation()}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {sheetTitle(sheet, index)}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {sheet.iconIds.length} icons return to the unassigned library — nothing is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                deleteSheet(sheet.id);
                toast.success("Sheet deleted — icons returned to the library");
              }}
            >
              Delete sheet
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
        </AlertDialog>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

export function Overview() {
  const sheets = useStudio((s) => s.sheets);
  const icons = useStudio((s) => s.icons);
  const iconOrder = useStudio((s) => s.iconOrder);
  const activeSheetId = useStudio((s) => s.activeSheetId);
  const selectedSheetIds = useStudio((s) => s.selectedSheetIds);
  const generateSheets = useStudio((s) => s.generateSheets);
  const selectAllSheets = useStudio((s) => s.selectAllSheets);
  const clearSheetSelection = useStudio((s) => s.clearSheetSelection);
  const applyDesignToSheets = useStudio((s) => s.applyDesignToSheets);
  const setViewMode = useStudio((s) => s.setViewMode);
  /* round 9: stat cells are actionable — each jumps where it matters */
  const setSidebarTab = useStudio((s) => s.setSidebarTab);
  const setLibraryFilter = useStudio((s) => s.setLibraryFilter);
  const openLibraryDialog = useStudio((s) => s.openLibraryDialog);
  /* universal template support: imported templates join the generator */
  const openTemplateImport = useStudio((s) => s.openTemplateImport);
  const customTemplateRecords = useStudio((s) => s.customTemplates);
  const customTemplateOptions = useMemo(
    () => listTemplates().filter((t) => t.sourceType === "custom"),
    [customTemplateRecords]
  );

  const [templateId, setTemplateId] = useState("t50");
  const unassigned = useMemo(() => getUnassignedIconIds({ sheets, iconOrder }), [sheets, iconOrder]);
  const selectedCount = selectedSheetIds.length;
  const applyTargets = useMemo(
    () => selectedSheetIds.filter((id) => id !== activeSheetId),
    [selectedSheetIds, activeSheetId]
  );

  /* ---- workspace stats (round 6 dashboard strip) ---- */
  const stats = useMemo(() => {
    const tagged = iconOrder.filter((id) => (icons[id]?.tags ?? []).length > 0).length;
    const totalCells = sheets.reduce(
      (sum, sh) => sum + (sheetTemplate(sh)?.capacity ?? sh.iconIds.length),
      0,
    );
    const filledCells = sheets.reduce((sum, sh) => sum + sh.iconIds.length, 0);
    const categories = new Set(sheets.map((sh) => sh.category));
    const volumes = sheets.reduce((max, sh) => Math.max(max, sh.volume), 0);
    return { tagged, totalCells, filledCells, categories: categories.size, volumes };
  }, [iconOrder, icons, sheets]);

  /* ---- sheet grid: template-aware track sizing (round-13 rec #1) ----
   * All 8 built-in templates are wide canvases (aspect 2.8–3.5:1). At the old
   * 220px minimum their cards rendered ~65px of artwork — honest but unusable.
   * When EVERY sheet is wide, the grid switches to wide tracks (~430px+) so
   * cards show real artwork; mixed grids keep 220px tracks and wide cards
   * span 2 columns at md+ instead. Memoized above the early return so hook
   * order stays stable. */
  const wideIds = useMemo(
    () => new Set(sheets.filter((sh) => {
      const t = sheetTemplate(sh);
      return t ? t.width / t.height >= 1.6 : false;
    }).map((sh) => sh.id)),
    [sheets],
  );
  const allWide = sheets.length > 0 && wideIds.size === sheets.length;

  function generate() {
    const created = generateSheets(templateId);
    if (created > 0) {
      toast.success(`Generated ${created} sheet${created > 1 ? "s" : ""} from ${unassigned.length} icons`);
    } else {
      toast.error("All icons are already assigned to sheets");
    }
  }

  /* ---- empty workspace ---- */
  if (sheets.length === 0 && unassigned.length === 0) {
    return (
      <div className="flex-1 grid place-items-center p-8">
        <div className="overview-empty-card text-center space-y-2.5 max-w-sm">
          <div className="studio-empty-glyph mx-auto" aria-hidden="true">
            <LayoutGrid className="h-[18px] w-[18px]" />
          </div>
          <p className="text-sm font-medium">No sheets yet</p>
          <p className="pro-help">
            {iconOrder.length === 0
              ? "Upload SVG icons first — then generate sheets from them."
              : "Generate sheets from your uploaded icons below."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto custom-scroll">
      {/* container-query sizing: padding + content cap follow the CENTER pane
       * width (main is an inline-size @container). The ≥1700px cap comes from
       * the unlayered `overview-content-wide` rule in globals.css (it beats
       * the layered base `max-w-[1500px]` utility deterministically) so the
       * card grid gains columns on large screens instead of dead margin. */}
      <div className="overview-content-wide px-4 py-5 @3xl:px-5 @3xl:py-6 space-y-5 max-w-[1500px] mx-auto">
        {/* workspace stats strip (round 6; interactive since round 9) */}
        {iconOrder.length > 0 ? (
          <div
            className="stat-strip"
            role="group"
            aria-label="Workspace statistics — click a stat to jump to its surface"
          >
            <button type="button" className="stat-cell stat-cell-action" title="Open the icon library" onClick={() => setSidebarTab("library")}>
              <Shapes className="stat-icon" aria-hidden="true" />
              <span className="stat-value">{iconOrder.length.toLocaleString()}</span>
              <span className="stat-label">icons</span>
            </button>
            <div className="stat-sep" aria-hidden="true" />
            <button
              type="button"
              className="stat-cell stat-cell-action"
              title={`${sheets.length} sheet${sheets.length === 1 ? "" : "s"} · ${stats.filledCells} of ${stats.totalCells} cells filled — open the health report`}
              onClick={() => openLibraryDialog("health")}
            >
              <Grid3x3 className="stat-icon" aria-hidden="true" />
              <span className="stat-value">{sheets.length}</span>
              <span className="stat-label">sheets</span>
              <span className="stat-sub">{stats.totalCells > 0 ? `${Math.round((stats.filledCells / stats.totalCells) * 100)}% full` : "—"}</span>
            </button>
            <div className="stat-sep" aria-hidden="true" />
            <button
              type="button"
              className={cn("stat-cell stat-cell-action", unassigned.length > 0 && "stat-cell-accent")}
              title={`${unassigned.length.toLocaleString()} icons not yet on any sheet — view them in the library`}
              onClick={() => {
                setSidebarTab("library");
                setLibraryFilter({ query: "", tags: [], mode: "unassigned" });
              }}
            >
              <FolderOpen className="stat-icon" aria-hidden="true" />
              <span className="stat-value">{unassigned.length.toLocaleString()}</span>
              <span className="stat-label">unassigned</span>
            </button>
            <div className="stat-sep" aria-hidden="true" />
            <button
              type="button"
              className="stat-cell stat-cell-action"
              title={`${stats.tagged} of ${iconOrder.length} icons carry tags — open the tag manager`}
              onClick={() => openLibraryDialog("tag-manager")}
            >
              <Tags className="stat-icon" aria-hidden="true" />
              <span className="stat-value">{stats.tagged.toLocaleString()}</span>
              <span className="stat-label">tagged</span>
            </button>
            <div className="stat-sep hidden sm:block" aria-hidden="true" />
            <button
              type="button"
              className="stat-cell stat-cell-action hidden sm:flex"
              title={`${stats.categories} categor${stats.categories === 1 ? "y" : "ies"} · highest volume ${stats.volumes} — open the health report`}
              onClick={() => openLibraryDialog("health")}
            >
              <CircleDot className="stat-icon" aria-hidden="true" />
              <span className="stat-value">{stats.categories}</span>
              <span className="stat-label">{stats.categories === 1 ? "category" : "categories"}</span>
              <span className="stat-sub">VOL ≤ {String(stats.volumes).padStart(2, "0")}</span>
            </button>
          </div>
        ) : null}

        {/* generate banner */}
        {unassigned.length > 0 && (
          <div className="overview-generate rounded-xl border border-amber-500/40 bg-amber-500/[0.06] p-4 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <div className="overview-generate-tile h-8 w-8 rounded-lg bg-amber-500/15 text-amber-600 grid place-items-center shrink-0">
                <Layers className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[12px] font-medium tracking-tight">
                  {unassigned.length.toLocaleString()} unassigned icon{unassigned.length === 1 ? "" : "s"}
                </p>
                <p className="pro-help">Generate sheets to turn them into artwork.</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger className="h-8 w-[150px] text-[12px]" aria-label="Sheet template">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel className="pro-label">Official</SelectLabel>
                    {listOfficialTemplates().map((t) => (
                      <SelectItem key={t.id} value={t.id} className="text-[12px]">
                        {t.name} — {t.capacity} cells
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  {customTemplateOptions.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel className="pro-label">Custom</SelectLabel>
                      {customTemplateOptions.map((t) => (
                        <SelectItem key={t.id} value={t.id} className="text-[12px]">
                          {t.name} — {t.capacity} slots
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label="Import a custom template SVG"
                title="Import Template SVG — any size, any grid, any number of cells"
                onClick={openTemplateImport}
              >
                <FileUp className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button size="sm" className="h-8 gap-1.5" onClick={generate}>
                <Wand2 className="h-3.5 w-3.5" />
                Generate Sheets
              </Button>
            </div>
          </div>
        )}

        {/* toolbar — a touch of extra top margin separates the tools zone
         * (stats + generate) from the content zone (title + card grid) */}
        {sheets.length > 0 && (
          <div className="overview-toolbar mt-1.5 flex flex-wrap items-center gap-2">
            <h2 className="pro-label">
              Sheet Overview
              <span className="ml-2 font-mono text-[11px] font-normal normal-case tracking-normal text-muted-foreground tabular-nums">{sheets.length} sheets</span>
            </h2>
            <div className="flex-1" />
            {selectedCount > 0 ? (
              <>
                <Badge variant="secondary" className="overview-selection-badge gap-1 font-mono text-[10px]">
                  <CheckSquare className="h-3 w-3 text-amber-600" />
                  {selectedCount} selected
                </Badge>
                <div className="overview-toolbar-group">
                  <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={selectAllSheets}>
                    <Square className="h-3 w-3 mr-1" />
                    Select all
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={clearSheetSelection}>
                    Clear
                  </Button>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="overview-apply-button h-7 text-[11px] gap-1.5"
                      disabled={applyTargets.length === 0}
                      onClick={() => {
                        /* the store action toasts the result (source sheet +
                         * target count + carry rules) — no local toast here,
                         * it would double-fire */
                        applyDesignToSheets(applyTargets, activeSheetId ?? "");
                      }}
                    >
                      <Wand2 className="h-3 w-3" />
                      Apply design to selected
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Copies the active sheet&apos;s design — never icons, heroes, categories or volumes</TooltipContent>
                </Tooltip>
              </>
            ) : (
              <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={selectAllSheets} disabled={sheets.length < 2}>
                <Square className="h-3 w-3 mr-1" />
                Select all
              </Button>
            )}
          </div>
        )}

        {/* sheet grid */}
        <AnimatePresence initial={false}>
          <div
            className="grid gap-3.5"
            style={{
              gridTemplateColumns: allWide
                ? "repeat(auto-fill, minmax(min(100%, 340px), 1fr))"
                : "repeat(auto-fill, minmax(220px, 1fr))",
            }}
            role="list"
            aria-label="Sheets"
          >
            {sheets.map((sheet, i) => (
              <div
                key={sheet.id}
                role="listitem"
                className={cn(!allWide && wideIds.has(sheet.id) && "md:col-span-2")}
              >
                <SheetCard sheet={sheet} index={i} />
              </div>
            ))}
          </div>
        </AnimatePresence>
      </div>
    </div>
  );
}
