"use client";

/**
 * ICON SHEET STUDIO — Stroke Report dialog (round 8).
 *
 * Per-icon stroke consistency QA at a glance: the diagnostics engine
 * (`strokeDiagnosticRows` — the SAME measurement + factor math the
 * renderer/export pipeline applies) surfaced as a visual table instead of
 * the console-only `window.__strokeDebug()`. For every icon on the sheet
 * (grid + hero) it shows the measured native width, the active request,
 * the calculated correction, the per-icon factor, the capability, the
 * method the renderer applies and the resulting width — plus a summary
 * strip (analyzed / landing on target / median / spread) and status
 * filter chips.
 *
 * Pure analysis of the immutable source SVGs — nothing is mutated, and
 * nothing here contributes markup to preview or export.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  Activity,
  Crosshair,
  Flag,
  Grid3x3,
  MoveHorizontal,
  Ruler,
  Target,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useStudio } from "@/lib/studio/store";
import {
  strokeDiagnosticRows,
  type StrokeDiagnosticRow,
} from "@/lib/studio/stroke-diagnostics";
import { toast } from "sonner";
import {
  effectiveStrokeWeightPx,
  effectiveUniformStroke,
  effectiveUniformTargetPx,
  formatVolume,
  sheetTitle,
} from "@/lib/studio/types";
import type { IconStyle } from "@/lib/studio/types";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Status / where presentation                                         */
/* ------------------------------------------------------------------ */

/** Status chip language — subtle /10 background + /70 text (HealthPill
 *  pattern). "unmeasurable" gets a dashed border to read as "no data". */
const STATUS_META: Record<
  StrokeDiagnosticRow["status"],
  { label: string; chip: string; title: string }
> = {
  supported: {
    label: "supported",
    chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    title: "Adjusted — lands on the requested width",
  },
  partial: {
    label: "partial",
    chip: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    title: "Adjusted every measured mark — structurally unsafe subpaths keep their native look",
  },
  limited: {
    label: "limited",
    chip: "bg-stone-500/10 text-stone-700 dark:text-stone-400",
    title: "Nothing safely adjustable — keeps its exact native look",
  },
  "no-op": {
    label: "no-op",
    chip: "bg-muted text-muted-foreground",
    title: "Already at the request — nothing to do",
  },
  unmeasurable: {
    label: "unmeasurable",
    chip: "border border-dashed border-border bg-muted/50 text-muted-foreground",
    title: "No safely measurable artwork — original look kept",
  },
};

/** grid vs hero embed badge (hero is amber — the sheet's feature icon). */
const WHERE_META: Record<StrokeDiagnosticRow["where"], string> = {
  grid: "bg-muted text-muted-foreground",
  hero: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

type StatusFilter = "all" | "exception" | StrokeDiagnosticRow["status"];

/** round 9/12: the exception chip label for a row — target px (uniform
 *  mode) or the signed weight adjustment (relative mode). */
function exceptionChipLabel(row: StrokeDiagnosticRow): string {
  if (row.exceptionTargetPx != null) return `${fmtPx(row.exceptionTargetPx)} px`;
  const w = row.exceptionWeightPx;
  if (w == null) return "";
  return w === 0 ? "±0" : `${w >= 0 ? "+" : ""}${w} px`;
}

/** round 9/12: the exception chip tooltip for a row. */
function exceptionChipTitle(row: StrokeDiagnosticRow): string {
  const base = "set from the cell toolbar’s Stroke popover";
  if (row.exceptionTargetPx != null) {
    return `Per-icon exception — this icon targets ${fmtPx(row.exceptionTargetPx)} px instead of the sheet-wide request (${base})`;
  }
  const w = row.exceptionWeightPx;
  if (w == null) return "";
  return `Per-icon exception — this icon gets its own ${
    w === 0 ? "native weight" : `weight adjustment of ${w >= 0 ? "+" : ""}${w} px`
  } instead of the sheet-wide request (${base})`;
}

/** chip display order (matches the severity ladder). */
const STATUS_ORDER: StrokeDiagnosticRow["status"][] = [
  "supported",
  "partial",
  "limited",
  "no-op",
  "unmeasurable",
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Compact px value ("2", "8.6") — one decimal only when it matters. */
function fmtPx(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** The ACTIVE stroke request as a human label (uniform target, weight
 *  delta, or native). Mirrors the engine's effective* helpers so the
 *  dialog can never disagree with what renders. */
function requestLabelOf(icon: IconStyle): string {
  if (effectiveUniformStroke(icon)) return `Uniform ${effectiveUniformTargetPx(icon)} px`;
  const delta = effectiveStrokeWeightPx(icon);
  if (delta === 0) return "Native — no adjustment";
  return `Weight ${delta > 0 ? "+" : ""}${delta} px`;
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export function StrokeReportDialog(): JSX.Element {
  const open = useStudio((s) => s.strokeReportOpen);
  const setStrokeReportOpen = useStudio((s) => s.setStrokeReportOpen);
  const sheets = useStudio((s) => s.sheets);
  /* round 19 · locate — jump from a report row straight to the icon's cell
   * on the sheet (activate + edit view + select + scrollIntoView, the same
   * choreography the sheet nav uses). */
  const setActiveSheet = useStudio((s) => s.setActiveSheet);
  const setViewMode = useStudio((s) => s.setViewMode);
  const setSelectedCell = useStudio((s) => s.setSelectedCell);
  /* same selector semantics as window.__strokeDebug / the properties
   * panel: the ACTIVE sheet, falling back to the first (overview mode
   * keeps an activeSheetId for the next edit). round 22: when a scoped
   * strokeReportSheetId is set (the switcher pills below), THAT sheet is
   * analyzed instead — the report reads any sheet without activating it. */
  const sheet = useStudio(
    (s) =>
      (s.strokeReportSheetId ? s.sheets.find((x) => x.id === s.strokeReportSheetId) : undefined) ??
      s.sheets.find((x) => x.id === s.activeSheetId) ??
      s.sheets[0] ??
      null
  );
  const setStrokeReportSheet = useStudio((s) => s.setStrokeReportSheet);
  const activeSheetId = useStudio((s) => s.activeSheetId);
  const icons = useStudio((s) => s.icons);

  const [filter, setFilter] = useState<StatusFilter>("all");

  /* round 19 · table fit QA fix: the nine columns' natural width (~1,020 px
   * with long sample names + method strings) used to overflow the 62-rem
   * dialog with no visible affordance — STATUS / RESULT PX were clipped
   * in the default view. The dialog now widens to 74 rem at lg (every
   * ≥1,280-px screen fits the full table), and narrower viewports keep the
   * scroll box, now with an explicit right-edge gradient + "scroll" hint
   * whenever more columns remain off-screen. */
  const tableBoxRef = useRef<HTMLDivElement>(null);
  const [scrollHint, setScrollHint] = useState(false);
  const updateScrollHint = useCallback(() => {
    const el = tableBoxRef.current;
    if (!el) return;
    const remaining = el.scrollWidth - el.clientWidth - el.scrollLeft;
    setScrollHint(remaining > 4);
  }, []);

  /* round 19 · locate handler — closes the report so the workspace (and the
   * freshly selected cell ring) is what you land on. Hero rows select the
   * hero embed the same way (it is a cell on the sheet). */
  const locateIcon = useCallback(
    (iconId: string) => {
      if (!sheet) return;
      setActiveSheet(sheet.id);
      setViewMode("edit");
      setSelectedCell(sheet.id, iconId);
      setStrokeReportOpen(false);
    },
    [sheet, setActiveSheet, setViewMode, setSelectedCell, setStrokeReportOpen]
  );

  /* round 22 · clear-exception action — until now the ONLY place to clear a
   * per-icon stroke exception was the cell toolbar's Stroke popover (or the
   * sheet-wide reset in the properties panel). The report is where you SEE
   * the exceptions, so it should also let you clear them: one click on the
   * X inside the amber flag chip restores the icon to the sheet-wide request
   * (both exception kinds are cleared — undoable via the sheet's history,
   * exactly like the cell toolbar's own clear). */
  const setCellStrokeTarget = useStudio((s) => s.setCellStrokeTarget);
  const setCellStrokeWeight = useStudio((s) => s.setCellStrokeWeight);
  const clearException = useCallback(
    (row: StrokeDiagnosticRow) => {
      if (!sheet) return;
      if (row.exceptionTargetPx != null) setCellStrokeTarget(sheet.id, [row.id], null);
      if (row.exceptionWeightPx != null) setCellStrokeWeight(sheet.id, [row.id], null);
      toast.success(`Exception cleared — ${row.icon} follows the sheet-wide request again`, {
        description: "Undo works from the toolbar (or Ctrl/Cmd+Z).",
      });
    },
    [sheet, setCellStrokeTarget, setCellStrokeWeight]
  );

  /* computed ONLY while open (pure analysis — no cost when closed) */
  const rows = useMemo(
    () => (open && sheet ? strokeDiagnosticRows(sheet, icons) : []),
    [open, sheet, icons]
  );
  /* rows carrying a per-cell stroke exception (round 9 target / round 12
   *  weight — either kind counts) */
  const exceptionCount = useMemo(
    () => rows.filter((r) => r.exceptionTargetPx != null || r.exceptionWeightPx != null).length,
    [rows]
  );

  /* default order: hero first, then icon name (natural, case-insensitive) */
  const sortedRows = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      if (a.where !== b.where) return a.where === "hero" ? -1 : 1;
      return a.icon.localeCompare(b.icon, undefined, { sensitivity: "base", numeric: true });
    });
    return arr;
  }, [rows]);

  const visibleRows = useMemo(() => {
    if (filter === "all") return sortedRows;
    if (filter === "exception")
      return sortedRows.filter((r) => r.exceptionTargetPx != null || r.exceptionWeightPx != null);
    return sortedRows.filter((r) => r.status === filter);
  }, [sortedRows, filter]);

  /* scroll-hint effect — runs after the rows exist so the box can be
   * measured; re-checks whenever the content (rows / filter) changes and
   * on window resizes (dialog width follows the viewport). */
  useEffect(() => {
    if (!open) return;
    updateScrollHint();
    window.addEventListener("resize", updateScrollHint);
    return () => window.removeEventListener("resize", updateScrollHint);
  }, [open, rows, visibleRows, filter, updateScrollHint]);

  /* summary numbers */
  const nativeValues = useMemo(
    () => rows.map((r) => r.nativePx).filter((v): v is number => v != null),
    [rows]
  );
  const medianNative = useMemo(() => {
    if (nativeValues.length === 0) return null;
    const sorted = [...nativeValues].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }, [nativeValues]);
  const spread = useMemo(() => {
    if (nativeValues.length === 0) return null;
    const min = Math.min(...nativeValues);
    const max = Math.max(...nativeValues);
    return { min, max };
  }, [nativeValues]);

  const onTarget = rows.filter((r) => r.status === "supported").length;
  const heroCount = rows.filter((r) => r.where === "hero").length;
  const gridCount = rows.length - heroCount;
  /* any fill-based artwork on the sheet → show the shape-aware (κ) footnote
   * in the footer (round 17 — surfaces the engine's κ model for compact
   * marks like dots, which otherwise look "fatter than the math") */
  const hasFillArtwork = rows.some(
    (r) => r.capability !== "stroke" && r.capability !== "unmeasurable"
  );

  /* sheet + request labels for the subtitle */
  const sheetLabel = useMemo(() => {
    if (!sheet) return null;
    const idx = Math.max(sheets.findIndex((x) => x.id === sheet.id), 0);
    const title = sheetTitle(sheet, idx);
    const category = sheet.category?.trim();
    return category ? `${title} — ${category} · ${formatVolume(sheet.volume)}` : title;
  }, [sheet, sheets]);
  const requestLabel = useMemo(
    () => (sheet ? requestLabelOf(sheet.design.icon) : "Native — no adjustment"),
    [sheet]
  );
  /* subtitle suffix: how many per-icon exceptions ride on the sheet-wide
   *  request (round 9) — shown only when there are any */
  const exceptionSuffix = useMemo(
    () =>
      exceptionCount > 0
        ? ` · ${exceptionCount} exception${exceptionCount === 1 ? "" : "s"}`
        : "",
    [exceptionCount]
  );

  const handleOpenChange = (next: boolean): void => {
    setStrokeReportOpen(next);
    if (!next) setFilter("all");
  };

  /* chips: All + one per status PRESENT in the sheet (never a dead chip,
   * and no status is hidden from the filters) */
  const statusCounts = useMemo(() => {
    const counts = new Map<StrokeDiagnosticRow["status"], number>();
    for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    return counts;
  }, [rows]);

  const stats: Array<{
    icon: typeof Grid3x3;
    value: string;
    label: string;
    title: string;
  }> = [
    {
      icon: Grid3x3,
      value: String(rows.length),
      label: "analyzed",
      title: `${gridCount} grid embed${gridCount === 1 ? "" : "s"} + ${heroCount} hero embed${heroCount === 1 ? "" : "s"}`,
    },
    {
      icon: Target,
      value: String(onTarget),
      label: "on target",
      title: `${onTarget} of ${rows.length} icon${rows.length === 1 ? "" : "s"} land on the requested width (status “supported”)`,
    },
    {
      icon: Ruler,
      value: medianNative != null ? `${fmtPx(medianNative)} px` : "—",
      label: "median native",
      title:
        medianNative != null
          ? "Median of the measured native effective stroke widths (canvas px)"
          : "No measurable native stroke on this sheet",
    },
    {
      icon: MoveHorizontal,
      value: spread ? (spread.min >= spread.max ? `${fmtPx(spread.min)} px` : `${fmtPx(spread.min)}–${fmtPx(spread.max)} px`) : "—",
      label: "native spread",
      title: spread
        ? "Min–max of the measured native effective stroke widths (canvas px)"
        : "No measurable native stroke on this sheet",
    },
  ];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-2xl md:max-w-[62rem] lg:max-w-[74rem]">
        <DialogHeader className="border-b border-border/70 px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-[15px] tracking-tight">
            <span className="studio-dlg-tile">
              <Activity className="h-4 w-4" aria-hidden="true" />
            </span>
            Stroke report
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            {sheetLabel ? (
              <>
                <span className="font-medium text-foreground">{sheetLabel}</span> · request:{" "}
                <span className="font-medium text-foreground">{requestLabel}</span>
                {exceptionSuffix ? (
                  <span className="font-medium text-amber-700 dark:text-amber-400">{exceptionSuffix}</span>
                ) : null}
              </>
            ) : (
              "Per-icon stroke consistency analysis of the active sheet."
            )}
          </DialogDescription>
        </DialogHeader>

        {/* round 22 · sheet switcher — the report reads ANY sheet without
         * activating it. Shown only when more than one sheet exists; the
         * analyzed sheet's pill carries the amber accent (the same language
         * the filter chips use), and the sheet the WORKSPACE is editing gets
         * a small pencil marker so the scope is never ambiguous. */}
        {sheets.length > 1 ? (
          <div
            className="flex flex-wrap items-center gap-1.5 px-5 pt-3"
            role="group"
            aria-label="Which sheet the report analyzes"
          >
            <span className="hint-text text-[9.5px] font-medium uppercase tracking-wider">sheet</span>
            {sheets.map((sh, i) => {
              const active = sheet?.id === sh.id;
              return (
                <button
                  key={sh.id}
                  type="button"
                  aria-pressed={active}
                  aria-label={`Analyze ${sheetTitle(sh, i)}`}
                  title={`${sheetTitle(sh, i)} — ${sh.iconIds.length} icon${sh.iconIds.length === 1 ? "" : "s"}${sh.id === activeSheetId ? " · currently editing" : ""}`}
                  onClick={() => setStrokeReportSheet(active ? null : sh.id)}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-[10.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-400"
                      : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <span className="max-w-[140px] truncate">{sheetTitle(sh, i)}</span>
                  {sh.id === activeSheetId ? (
                    <span
                      className="size-1.5 rounded-full bg-amber-500/80"
                      aria-hidden="true"
                      title="This is the sheet the workspace is editing"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2.5 px-6 py-10 text-center">
            <div className="studio-empty-glyph">
              <Activity className="h-5 w-5" aria-hidden="true" />
            </div>
            <p className="text-[13px] font-semibold">
              {sheet ? "Nothing to analyze yet" : "No sheet to analyze"}
            </p>
            <p className="max-w-[420px] text-[11px] leading-relaxed text-muted-foreground">
              {sheet
                ? "This sheet has no icons — the report fills in as icons are placed on the grid or hero slot."
                : "Open or create a sheet first; the report analyzes the active sheet's icons (hero included)."}
            </p>
          </div>
        ) : (
          <>
            {/* ---- summary strip (overview stats-strip styling) ------- */}
            <div
              className="sr-stats mx-5 mt-4 grid grid-cols-4 divide-x divide-border rounded-lg border border-border bg-muted/30"
              role="group"
              aria-label="Stroke report summary"
            >
              {stats.map((stat) => (
                <div key={stat.label} className="flex flex-col items-center gap-0.5 px-1.5 py-2.5" title={stat.title}>
                  <stat.icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className="text-[13px] font-semibold tabular-nums leading-tight">{stat.value}</span>
                  <span className="hint-text text-[9.5px] uppercase tracking-wider">{stat.label}</span>
                </div>
              ))}
            </div>

            {/* ---- status filter chips --------------------------------- */}
            <div
              className="flex flex-wrap items-center gap-1.5 px-5 pt-3"
              role="group"
              aria-label="Filter rows by status"
            >
              {
                (
                  [
                    { key: "all" as StatusFilter, label: "All", count: rows.length },
                    ...(exceptionCount > 0
                      ? [
                          {
                            key: "exception" as StatusFilter,
                            label: "exceptions",
                            count: exceptionCount,
                          },
                        ]
                      : []),
                    ...[...statusCounts.entries()]
                      .sort(
                        (a, b) => STATUS_ORDER.indexOf(a[0]) - STATUS_ORDER.indexOf(b[0])
                      )
                      .map(([status, count]) => ({
                        key: status as StatusFilter,
                        label: STATUS_META[status].label,
                        count,
                      })),
                  ] satisfies Array<{ key: StatusFilter; label: string; count: number }>
                ).map((chip) => {
                  const active = filter === chip.key;
                  return (
                    <button
                      key={chip.key}
                      type="button"
                      aria-pressed={active}
                      aria-label={chip.key === "all" ? "Show all icon rows" : chip.key === "exception" ? "Show only icons with a per-icon exception" : `Show only ${chip.label} icon rows`}
                      title={
                        chip.key === "all"
                          ? "Show every icon on the sheet"
                          : chip.key === "exception"
                            ? "Icons with their own stroke target or weight adjustment (cell exception) — set from the cell toolbar’s Stroke popover"
                            : STATUS_META[chip.key as StrokeDiagnosticRow["status"]].title
                      }
                      onClick={() => setFilter(chip.key)}
                      className={cn(
                        "sr-filter inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[10.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-400"
                          : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      {chip.label}
                      <span className="tabular-nums opacity-70" aria-hidden="true">
                        {chip.count}
                      </span>
                    </button>
                  );
                })
              }
            </div>

            {/* ---- per-icon table ------------------------------------- */}
            <div className="relative mx-5 mt-2.5">
              <div
                ref={tableBoxRef}
                onScroll={updateScrollHint}
                className="sr-table-box custom-scroll max-h-[50vh] overflow-auto rounded-lg border border-border/70"
              >
              <table
                className="w-full min-w-[780px] border-collapse text-left text-[11.5px]"
                aria-label="Per-icon stroke analysis"
              >
                <thead>
                  <tr>
                    <th scope="col" className="sr-th sticky top-0 z-10 bg-muted px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Icon
                    </th>
                    <th scope="col" className="sr-th sticky top-0 z-10 bg-muted px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Native px
                    </th>
                    <th scope="col" className="sr-th sticky top-0 z-10 bg-muted px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Request
                    </th>
                    <th scope="col" className="sr-th sticky top-0 z-10 bg-muted px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Correction
                    </th>
                    <th scope="col" className="sr-th sticky top-0 z-10 bg-muted px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Factor
                    </th>
                    <th scope="col" className="sr-th sticky top-0 z-10 bg-muted px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Capability
                    </th>
                    <th scope="col" className="sr-th sticky top-0 z-10 bg-muted px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Method
                    </th>
                    <th scope="col" className="sr-th sticky top-0 z-10 bg-muted px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Status
                    </th>
                    <th scope="col" className="sr-th sticky top-0 z-10 bg-muted px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Result px
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 ? (
                    <tr className="sr-row">
                      <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                        No icons with this status on the sheet.
                      </td>
                    </tr>
                  ) : (
                    visibleRows.map((row) => {
                      const status = STATUS_META[row.status];
                      return (
                        /* zebra + hover tinting live in globals.css (.sr-row
                         * rules) — one source of truth for light AND dark.
                         * round 19: the row is a locate affordance — click
                         * anywhere on it (or its crosshair button) to jump to
                         * the icon's cell on the sheet. */
                        <tr
                          key={`${row.where}-${row.id}`}
                          className="sr-row group/row cursor-pointer border-b border-border/70 last:border-b-0"
                          onClick={() => locateIcon(row.id)}
                          title={`Locate ${row.icon} on ${sheetLabel ?? "the sheet"} — activates the sheet, selects the cell and scrolls it into view`}
                        >
                          <td className="max-w-[220px] px-3 py-[7px]">
                            <div className="flex items-center gap-1.5" title={`${row.icon} · viewBox ${row.viewBox}`}>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  locateIcon(row.id);
                                }}
                                aria-label={`Locate ${row.icon} on the sheet`}
                                title="Select this icon on the sheet"
                                className="shrink-0 grid size-4 place-items-center rounded text-muted-foreground/60 outline-none transition-all hover:scale-110 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100"
                              >
                                <Crosshair className="size-3" aria-hidden="true" />
                              </button>
                              <span className="truncate font-medium">{row.icon}</span>
                              <span
                                className={cn(
                                  "shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium uppercase leading-4 tracking-wide",
                                  WHERE_META[row.where]
                                )}
                              >
                                {row.where}
                              </span>
                              {row.exceptionTargetPx != null || row.exceptionWeightPx != null ? (
                                <span
                                  className="shrink-0 inline-flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/10 py-px pl-1.5 pr-0.5 text-[9px] font-semibold leading-4 tabular-nums text-amber-700 dark:text-amber-400"
                                  title={exceptionChipTitle(row)}
                                >
                                  <Flag className="size-2.5" aria-hidden="true" />
                                  {exceptionChipLabel(row)}
                                  {/* round 22 · clear-exception — inside the chip so it
                                   * reads as part of the exception itself; the row's
                                   * own click (locate) is stopped. */}
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      clearException(row);
                                    }}
                                    aria-label={`Clear the stroke exception on ${row.icon} — follow the sheet-wide request again`}
                                    title="Clear this exception — the icon follows the sheet-wide stroke request again"
                                    className="-my-px ml-0.5 grid size-[15px] place-items-center rounded-full text-amber-700/70 transition-all hover:scale-110 hover:bg-amber-500/20 hover:text-amber-800 focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-400/70 dark:hover:text-amber-300"
                                  >
                                    <X className="size-2.5" aria-hidden="true" />
                                  </button>
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td
                            className={cn(
                              "whitespace-nowrap px-3 py-[7px] text-right tabular-nums",
                              row.nativePx == null && "text-muted-foreground"
                            )}
                          >
                            {row.nativePx == null ? "—" : fmtPx(row.nativePx)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-[7px]">
                            <span
                              className={cn(
                                "text-muted-foreground",
                                row.exceptionTargetPx != null &&
                                  "font-medium text-amber-700 dark:text-amber-400"
                              )}
                            >
                              {row.request}
                            </span>
                          </td>
                          <td
                            className={cn(
                              "whitespace-nowrap px-3 py-[7px] text-right tabular-nums",
                              row.correctionPx === "—" && "text-muted-foreground"
                            )}
                          >
                            {row.correctionPx}
                          </td>
                          <td
                            className={cn(
                              "whitespace-nowrap px-3 py-[7px] text-right tabular-nums",
                              row.factor === "—" && "text-muted-foreground"
                            )}
                          >
                            {row.factor}
                          </td>
                          <td className="whitespace-nowrap px-3 py-[7px] text-muted-foreground">{row.capability}</td>
                          <td className="max-w-[320px] px-3 py-[7px]">
                            <span className="block truncate text-muted-foreground" title={row.method}>
                              {row.method}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-[7px]">
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full px-1.5 py-px text-[9.5px] font-medium leading-4",
                                status.chip
                              )}
                              title={status.title}
                            >
                              {status.label}
                            </span>
                          </td>
                          <td
                            className={cn(
                              "whitespace-nowrap px-3 py-[7px] text-right font-medium tabular-nums",
                              row.resultPx === "—" && "text-muted-foreground font-normal"
                            )}
                          >
                            {row.resultPx}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
              </div>
              {scrollHint ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 right-0 flex w-14 items-center justify-end rounded-r-lg bg-gradient-to-l from-background via-background/85 to-transparent pr-1.5"
                >
                  <span className="hint-text flex items-center gap-0.5 text-[9px] font-medium uppercase tracking-wider">
                    scroll
                    <MoveHorizontal className="h-2.5 w-2.5 animate-pulse" />
                  </span>
                </div>
              ) : null}
            </div>
          </>
        )}

        <DialogFooter className="studio-dlg-footer mt-4 flex-col items-start gap-1 border-t border-border bg-muted/30 px-5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-0.5">
            <span className="hint-text text-[10.5px] leading-relaxed">
              Pure analysis of the immutable source SVGs — the same engine preview &amp; export
              use. Nothing is mutated. Click any row to locate the icon on the sheet. Amber chips mark
              per-icon exceptions — the × inside clears them.
            </span>
            {hasFillArtwork ? (
              <span className="hint-text text-[10.5px] leading-relaxed text-muted-foreground/85">
                <span className="font-medium text-muted-foreground">Shape-aware (κ):</span>{" "}
                fill-based marks adjust from their own geometry — stroke-like marks (bars,
                capsules) thin from two opposing edges, compact marks (dots, squares) from their
                single boundary, so every mark lands on the same target width.
              </span>
            ) : null}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 text-[11.5px]"
            onClick={() => handleOpenChange(false)}
            aria-label="Close the stroke report"
          >
            Close report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
