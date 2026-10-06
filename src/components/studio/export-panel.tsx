"use client";

/**
 * ICON SHEET STUDIO — Export dialog.
 *
 * Scope: active sheet / selected sheets / all sheets. Format: SVG or PNG.
 * Single-sheet exports download directly; multi-sheet exports run the batch
 * engine (zip) with REAL per-sheet progress — progress is never faked, it is
 * only ever set from the engine's onProgress reports.
 *
 * Transparent exports: the sheet background rect is part of the rendered
 * artwork; when "Transparent" is on, the first full-canvas Background rect is
 * stripped from the SVG string before download/rasterization (PNG paths get
 * this via the minimal export.ts edit; single SVG via stripBackground here).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, EyeOff, FileDown, Loader2, Ruler } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SelectField, ToggleRow } from "@/components/studio/small-controls";
import { useStudio } from "@/lib/studio/store";
import { cn } from "@/lib/utils";
import { formatVolume, type Sheet } from "@/lib/studio/types";
import { sheetTemplate } from "@/lib/studio/templates";
import { buildExportFilename } from "@/lib/studio/filename";
import {
  buildSheetSvg,
  exportBatch,
  exportSheetPng,
  exportSheetSvg,
  exportSheetsPdf,
  stripBackgroundRect,
  type ExportTarget,
  type ProgressReport,
} from "@/lib/studio/export";

type Scope = "active" | "selected" | "all";
type Fmt = "svg" | "png" | "pdf";
type Scale = "1" | "2" | "3";

/* ------------------------------------------------------------------ */
/* Local export helpers                                                */
/* ------------------------------------------------------------------ */

/* stripBackgroundRect (transparent export) is imported from export.ts —
 * the duplicated local regex copy was removed in review round 7. */

/** Blob download (same pattern as the private helper in export.ts). */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function scopeSheets(
  scope: Scope,
  sheets: Sheet[],
  activeSheetId: string | null,
  selectedSheetIds: string[]
): Sheet[] {
  if (scope === "active") {
    return activeSheetId ? sheets.filter((s) => s.id === activeSheetId) : [];
  }
  if (scope === "selected") {
    return sheets.filter((s) => selectedSheetIds.includes(s.id));
  }
  return sheets;
}

/** Build export targets from pre-scoped sheets; sheets with a missing template are skipped (counted as failed). */
function collectTargets(scoped: Sheet[]): { targets: ExportTarget[]; skipped: string[] } {
  const targets: ExportTarget[] = [];
  const skipped: string[] = [];
  for (const sheet of scoped) {
    const template = sheetTemplate(sheet);
    if (!template) {
      skipped.push(
        `"${sheet.category} ${formatVolume(sheet.volume)}": unknown template "${sheet.templateId}"`
      );
      continue;
    }
    targets.push({ sheet, template });
  }
  return { targets, skipped };
}

interface BatchSummary {
  succeeded: number;
  failed: number;
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="studio-group-label">{children}</p>
  );
}

/* ------------------------------------------------------------------ */
/* Export dialog                                                       */
/* ------------------------------------------------------------------ */

export function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const sheets = useStudio((s) => s.sheets);
  const activeSheetId = useStudio((s) => s.activeSheetId);
  const selectedSheetIds = useStudio((s) => s.selectedSheetIds);
  const savedPrefs = useStudio((s) => s.settings.export);
  const setExportPrefs = useStudio((s) => s.setExportPrefs);

  const [scope, setScope] = useState<Scope>("active");
  const [format, setFormat] = useState<Fmt>("svg");
  const [scale, setScale] = useState<Scale>("2");
  const [transparent, setTransparent] = useState(false);
  const [pdfFooter, setPdfFooter] = useState(true);

  /* Raster safety: the default sheets are wide canvases (6000-7976 px wide).
   * Chromium caps canvas area at ~268 MP; anything past ~110 MP risks
   * allocation failure on weaker machines. Cap the offered scales by the
   * LARGEST canvas among the current export targets. */
  const targetTemplates = useMemo(
    () =>
      sheets
        .map((s) => sheetTemplate(s))
        .filter((t): t is NonNullable<typeof t> => Boolean(t)),
    [sheets]
  );
  const maxArea = targetTemplates.reduce((m, t) => Math.max(m, t.width * t.height), 0);
  const scaleCap = useMemo(() => {
    if (maxArea <= 0) return 3;
    return Math.max(1, Math.min(3, Math.floor(Math.sqrt(110_000_000 / maxArea))));
  }, [maxArea]);
  const availableScales: { value: Scale; label: string }[] = (
    [
      { value: "1", label: "1×" },
      { value: "2", label: "2×" },
      { value: "3", label: "3×" },
    ] as { value: Scale; label: string }[]
  ).filter((o) => Number(o.value) <= scaleCap);
  /* PDF rasters are PAGE-relative (144/216/288 DPI), never canvas-scale —
   * the PNG canvas-area cap does not apply, so all three qualities are safe. */
  const pdfScales: { value: Scale; label: string }[] = [
    { value: "1", label: "Draft · 144 DPI" },
    { value: "2", label: "Print · 216 DPI" },
    { value: "3", label: "High · 288 DPI" },
  ];
  /** saved prefs may carry a scale the current canvases can no longer
   *  rasterize safely - clamp both the shown value and the export value */
  const safeScale: Scale = Number(scale) <= scaleCap ? scale : (String(scaleCap) as Scale);
  const safePdfScale: Scale = scale === "1" || scale === "2" || scale === "3" ? scale : "2";
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ProgressReport | null>(null);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const runningRef = useRef(false); // double-click guard (state updates are async)

  /* restore last-used settings + fresh run state every time the dialog opens */
  useEffect(() => {
    if (open) {
      if (savedPrefs) {
        if (savedPrefs.scope === "active" || savedPrefs.scope === "selected" || savedPrefs.scope === "all") {
          setScope(savedPrefs.scope);
        }
        if (savedPrefs.format === "svg" || savedPrefs.format === "png" || savedPrefs.format === "pdf") {
          setFormat(savedPrefs.format);
        }
        if (savedPrefs.scale === "1" || savedPrefs.scale === "2" || savedPrefs.scale === "3") {
          setScale(savedPrefs.scale);
        }
        setTransparent(Boolean(savedPrefs.transparent));
        setPdfFooter(savedPrefs.pdfFooter !== false);
      }
      setProgress(null);
      setSummary(null);
      setExporting(false);
    }
    // savedPrefs is read-once per open; a live subscription would fight the local state
  }, [open]);

  /* persist every settings change (debounced autosave via the store) */
  const changeScope = useCallback(
    (v: Scope) => {
      setScope(v);
      setExportPrefs({ scope: v });
    },
    [setExportPrefs]
  );
  const changeFormat = useCallback(
    (v: Fmt) => {
      setFormat(v);
      setExportPrefs({ format: v });
    },
    [setExportPrefs]
  );
  const changeScale = useCallback(
    (v: Scale) => {
      setScale(v);
      setExportPrefs({ scale: v });
    },
    [setExportPrefs]
  );
  const changeTransparent = useCallback(
    (v: boolean) => {
      setTransparent(v);
      setExportPrefs({ transparent: v });
    },
    [setExportPrefs]
  );
  const changePdfFooter = useCallback(
    (v: boolean) => {
      setPdfFooter(v);
      setExportPrefs({ pdfFooter: v });
    },
    [setExportPrefs]
  );

  /* block closing while a batch export is running */
  const handleOpenChange = (o: boolean) => {
    if (exporting && !o) return;
    onOpenChange(o);
  };

  /* -- derived (live preview of what will be exported) ------------------ */
  const selectedCount = selectedSheetIds.length;
  const effectiveScope: Scope = scope === "selected" && selectedCount === 0 ? "active" : scope;
  const scopedSheets = scopeSheets(effectiveScope, sheets, activeSheetId, selectedSheetIds);
  const { targets, skipped } = collectTargets(scopedSheets);

  /* cells skipped across the scoped sheets — they export as holes; the
   *  dialog says so up-front so nobody is surprised by a "missing" icon */
  const skippedCells = scopedSheets.reduce(
    (n, s) =>
      n + s.iconIds.filter((id) => s.cellOverrides?.[id]?.skip === true).length,
    0,
  );

  const count = targets.length;
  const isBatch = scopedSheets.length > 1;
  const firstSheet = scopedSheets[0] ?? null;
  const firstTarget = targets[0] ?? null;

  /* Estimated raster size for the CURRENT scope at the current scale — the
   * largest canvas among the scoped sheets decides the numbers. Pure
   * arithmetic (no allocation), safe to re-derive on every render. For PNG
   * this is the true output raster; for PDF it is the page raster width
   * (2000/3000/4000 px at quality 1/2/3). */
  const pngEstimate = useMemo(() => {
    const scopedTemplates = scopedSheets
      .map((s) => sheetTemplate(s))
      .filter((t): t is NonNullable<typeof t> => Boolean(t));
    if (scopedTemplates.length === 0) return null;
    const biggest = scopedTemplates.reduce((m, t) => (t.width * t.height > m.width * m.height ? t : m));
    const s = format === "png" ? Number(safeScale) : Number(safePdfScale);
    let w: number;
    let h: number;
    if (format === "pdf") {
      w = 1000 * s;
      h = Math.round((biggest.height / biggest.width) * w);
    } else {
      w = Math.round(biggest.width * s);
      h = Math.round(biggest.height * s);
    }
    const mp = (w * h) / 1_000_000;
    return { w, h, mp };
  }, [scopedSheets, format, safeScale, safePdfScale]);

  const previewFilename =
    format === "pdf"
      ? // PDF is always ONE document — even for a single sheet
        `icon-sheets_${new Date().toISOString().slice(0, 10)}.pdf`
      : isBatch
        ? `icon-sheets_${new Date().toISOString().slice(0, 10)}.zip`
        : firstTarget
          ? buildExportFilename(firstTarget.sheet, 0, format)
          : null;

  /* -- the export run ---------------------------------------------------- */
  const handleExport = async () => {
    if (runningRef.current || exporting || count === 0) return;
    runningRef.current = true;
    setExporting(true);
    setProgress(null);
    setSummary(null);
    try {
      /* exports use the LIVE sheet state — re-read at click time */
      const state = useStudio.getState();
      const liveScope: Scope =
        scope === "selected" && state.selectedSheetIds.length === 0 ? "active" : scope;
      const liveScoped = scopeSheets(liveScope, state.sheets, state.activeSheetId, state.selectedSheetIds);
      const { targets: liveTargets, skipped: liveSkipped } = collectTargets(liveScoped);
      const liveIcons = state.icons;

      /* ---- PDF → ONE document, one page per sheet (even for a single
       * sheet — a 1-page PDF). Raster pages at the sheet's native aspect
       * ratio; real per-sheet progress like the zip batch. ---- */
      if (format === "pdf") {
        if (liveTargets.length === 0) {
          toast.error(`Export failed: ${liveSkipped[0] ?? "no sheets to export"}`);
          return;
        }
        const result = await exportSheetsPdf(
          liveTargets,
          liveIcons,
          { pngScale: Number(safePdfScale), transparent, footer: pdfFooter },
          (report) => setProgress(report) // real progress only — never faked
        );
        const failed = result.failed + liveSkipped.length;
        const succeeded = result.succeeded;
        const firstError = liveSkipped[0] ?? result.errors[0];
        setSummary({ succeeded, failed });
        if (succeeded > 0) {
          toast.success(
            succeeded === 1 ? "1 sheet exported to PDF" : `${succeeded} sheets exported to one PDF`
          );
        }
        if (failed > 0) toast.error(`${failed} failed — ${firstError ?? "unknown error"}`);
        return;
      }

      /* ---- single sheet → direct file download ---- */
      if (liveScoped.length === 1 && liveTargets.length === 1) {
        const { sheet, template } = liveTargets[0];
        const filename = buildExportFilename(sheet, 0, format);
        if (format === "svg") {
          if (transparent) {
            const svg = stripBackgroundRect(buildSheetSvg(sheet, template, liveIcons));
            triggerDownload(
              new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
              filename
            );
          } else {
            exportSheetSvg(sheet, template, liveIcons, 0);
          }
          toast.success(`Exported ${filename}`);
        } else {
          await exportSheetPng(sheet, template, liveIcons, 0, {
            scale: Number(safeScale),
            transparent,
          });
          toast.success(`Exported ${filename}`);
        }
        handleOpenChange(false); // single exports close the dialog
        return;
      }

      /* ---- batch → zip archive with real progress ---- */
      if (liveTargets.length === 0) {
        toast.error(`Export failed: ${liveSkipped[0] ?? "no sheets to export"}`);
        return;
      }
      const result = await exportBatch(
        liveTargets,
        liveIcons,
        { format, pngScale: Number(safeScale), transparent },
        (report) => setProgress(report) // real progress only — never faked
      );
      const failed = result.failed + liveSkipped.length;
      const succeeded = result.succeeded;
      const firstError = liveSkipped[0] ?? result.errors[0];
      setSummary({ succeeded, failed });
      if (succeeded > 0) toast.success(`${succeeded} sheets exported`);
      if (failed > 0) toast.error(`${failed} failed — ${firstError ?? "unknown error"}`);
    } catch (err) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      runningRef.current = false;
      setExporting(false);
    }
  };

  /* -- render ------------------------------------------------------------ */
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        showCloseButton={!exporting}
      >
        <DialogHeader className="border-b border-border/70 px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span className="studio-dlg-tile">
              <Download className="h-4 w-4" aria-hidden="true" />
            </span>
            Export artwork
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            Single sheets download as files; multiple sheets bundle into a zip —
            or collect them all in one PDF document.
          </DialogDescription>
        </DialogHeader>

        <div className="custom-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-5 pt-4">
          {/* Scope */}
          <div className="space-y-1.5">
            <GroupLabel>Scope</GroupLabel>
            <ToggleGroup
              type="single"
              value={effectiveScope}
              onValueChange={(v) => {
                if (v === "active" || v === "selected" || v === "all") changeScope(v);
              }}
              variant="outline"
              size="sm"
              className="flex w-full sm:grid sm:grid-cols-3"
              aria-label="Export scope"
            >
              <ToggleGroupItem value="active" className="studio-choice rounded-lg text-xs" disabled={exporting || !activeSheetId}>
                Active sheet
              </ToggleGroupItem>
              <ToggleGroupItem value="selected" className="studio-choice rounded-lg text-xs" disabled={exporting || selectedCount === 0}>
                Selected sheets ({selectedCount})
              </ToggleGroupItem>
              <ToggleGroupItem value="all" className="studio-choice rounded-lg text-xs" disabled={exporting || sheets.length === 0}>
                All sheets ({sheets.length})
              </ToggleGroupItem>
            </ToggleGroup>
            {skippedCells > 0 ? (
              <p className="flex items-center gap-1.5 text-[10px] leading-snug text-stone-600 dark:text-stone-300" aria-live="polite">
                <EyeOff className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span>
                  {skippedCells === 1
                    ? "1 skipped cell exports as an empty hole — unskip it in Edit view to include."
                    : `${skippedCells} skipped cells export as empty holes — unskip them in Edit view to include.`}
                </span>
              </p>
            ) : null}
          </div>

          {/* Format */}
          <div className="space-y-1.5">
            <GroupLabel>Format</GroupLabel>
            <ToggleGroup
              type="single"
              value={format}
              onValueChange={(v) => {
                if (v === "svg" || v === "png" || v === "pdf") changeFormat(v);
              }}
              variant="outline"
              size="sm"
              className="flex w-full sm:grid sm:grid-cols-3"
              aria-label="Export format"
            >
              <ToggleGroupItem value="svg" className="studio-choice rounded-lg text-xs" disabled={exporting}>
                SVG (vector)
              </ToggleGroupItem>
              <ToggleGroupItem value="png" className="studio-choice rounded-lg text-xs" disabled={exporting}>
                PNG (raster)
              </ToggleGroupItem>
              <ToggleGroupItem value="pdf" className="studio-choice rounded-lg text-xs" disabled={exporting}>
                PDF (document)
              </ToggleGroupItem>
            </ToggleGroup>
            {format === "pdf" ? (
              <p className="text-[10px] leading-snug text-muted-foreground">
                One document, one page per sheet — pages sized to each sheet’s
                canvas. Perfect for sharing and printing.
              </p>
            ) : null}
          </div>

          {/* Options */}
          <div className="space-y-2">
            <GroupLabel>Options</GroupLabel>
            {format === "png" || format === "pdf" ? (
              <SelectField
                label={format === "pdf" ? "Page quality" : "Scale"}
                value={format === "pdf" ? safePdfScale : safeScale}
                options={format === "pdf" ? pdfScales : availableScales}
                onChange={changeScale}
              />
            ) : null}
            {format !== "svg" && pngEstimate ? (
              <p
                className="flex items-center gap-1.5 text-[10px] leading-snug"
                aria-live="polite"
              >
                <Ruler
                  className={cn(
                    "h-3 w-3 shrink-0",
                    pngEstimate.mp > 60
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground",
                  )}
                  aria-hidden="true"
                />
                <span
                  className={cn(
                    "tabular-nums",
                    pngEstimate.mp > 60
                      ? "font-medium text-amber-700 dark:text-amber-400"
                      : "text-muted-foreground",
                  )}
                >
                  {format === "pdf" ? "Page raster" : "Output raster"} ≈{" "}
                  {pngEstimate.w.toLocaleString()} × {pngEstimate.h.toLocaleString()} px ·{" "}
                  {pngEstimate.mp.toFixed(1)} MP
                </span>
                {format === "png" && pngEstimate.mp > 60 ? (
                  <span className="text-amber-700/90 dark:text-amber-400/90">
                    — heavy canvas, may take a moment
                  </span>
                ) : null}
              </p>
            ) : null}
            {format === "png" && scaleCap < 3 ? (
              <p className="text-[10px] leading-snug text-muted-foreground">
                Higher scales are hidden for these canvas sizes — Chromium
                caps raster memory (~110 MP safety cap applied).
              </p>
            ) : null}
            <ToggleRow
              label="Transparent"
              checked={transparent}
              onChange={changeTransparent}
              hint="Removes the background rect"
            />
            {format === "pdf" ? (
              <ToggleRow
                label="Page footer"
                checked={pdfFooter}
                onChange={changePdfFooter}
                hint="Sheet title · category · VOL · page N/M"
              />
            ) : null}
            {format === "pdf" && pdfFooter ? (
              <p className="text-[10px] leading-snug text-muted-foreground">
                A thin metadata strip is appended below each page&apos;s artwork
                (nothing is cropped): sheet title, category, volume, icon count,
                export date and page numbers.
              </p>
            ) : null}
            {transparent ? (
              <p className="text-[10px] text-muted-foreground">
                The sheet background rect is removed in {isBatch ? "every archive entry" : "the exported file"} — artwork, cards and text stay intact.
              </p>
            ) : null}
          </div>

          {/* Checklist preview */}
          <div className="space-y-1.5">
            <GroupLabel>Preview</GroupLabel>
            {firstSheet ? (
              <dl className="ex-preview grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 rounded-md border border-border/70 bg-muted/30 px-3 py-2.5 text-[11px] dark:border-border">
                <dt className="text-muted-foreground">Category</dt>
                <dd className="truncate font-medium">{firstSheet.category}</dd>
                <dt className="text-muted-foreground">Volume</dt>
                <dd className="font-mono tabular-nums">{formatVolume(firstSheet.volume)}</dd>
                <dt className="text-muted-foreground">Icon count</dt>
                <dd className="font-mono tabular-nums">{firstSheet.iconIds.length}</dd>
                <dt className="text-muted-foreground">Template</dt>
                <dd className="truncate">
                  {sheetTemplate(firstSheet)?.name ?? "—"}
                </dd>
              </dl>
            ) : (
              <p className="text-[11px] text-muted-foreground">No sheets in this scope.</p>
            )}
            {skipped.length > 0 ? (
              <p className="text-[10px] text-destructive/80">
                {skipped.length} sheet{skipped.length === 1 ? "" : "s"} skipped — unknown template.
              </p>
            ) : null}
            <p className="text-[11px] text-muted-foreground">Exports use the live sheet state.</p>
            <p className="ex-file-chip font-mono text-[11px] text-muted-foreground">
              <FileDown className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{previewFilename ?? "—"}</span>
            </p>
          </div>

          {/* Real progress — only from onProgress reports */}
          {exporting && progress ? (
            <div className="space-y-1.5">
              <Progress
                value={Math.round((progress.current / Math.max(1, progress.total)) * 100)}
                aria-label="Export progress"
                className="ex-progress"
              />
              <p className="text-[11px] text-muted-foreground">{progress.label}</p>
            </div>
          ) : null}

          {/* Batch summary — stays until the dialog is closed */}
          {summary && !exporting ? (
            <p className="text-[11px]">
              <span className="text-muted-foreground">{summary.succeeded} successful</span>
              <span className="text-muted-foreground"> · </span>
              <span
                className={
                  summary.failed > 0 ? "font-medium text-destructive" : "text-muted-foreground"
                }
              >
                {summary.failed} failed
              </span>
            </p>
          ) : null}
        </div>

        <DialogFooter className="studio-dlg-footer gap-3 px-5 py-3.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            onClick={() => handleOpenChange(false)}
            disabled={exporting}
          >
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={exporting || count === 0} className="studio-export-btn h-9 px-5">
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {exporting ? "Exporting…" : `Export ${count} ${count === 1 ? "sheet" : "sheets"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
