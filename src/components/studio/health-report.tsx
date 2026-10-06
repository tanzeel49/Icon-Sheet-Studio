"use client";

/**
 * ICON SHEET STUDIO — Library Health Report dialog (round 9).
 *
 * A one-glance quality dashboard for the whole workspace: summary stats
 * (icons / tags / sheets / fill) plus every detected issue — untagged
 * icons, empty sheets, duplicate file names, unassigned icons, singleton
 * tags and low-fill sheets — each with a jump action that lands the user
 * exactly where the problem can be fixed (inspector, library unassigned
 * filter, the sheet canvas, or the tag manager).
 *
 * The analysis itself lives in `@/lib/studio/health.ts` (pure, shared with
 * the command palette's live-count hint) so both surfaces always agree.
 * Opened from the palette ("Library health report"), the overview stats
 * strip (sheets / categories cells) or `openLibraryDialog("health")`.
 */

import { useMemo } from "react";
import type { JSX } from "react";
import {
  CheckCircle2,
  HeartPulse,
  Shapes,
  Tags,
  Grid3x3,
  CircleDot,
  ChevronRight,
  Scan,
  FolderOpen,
  GitMerge,
  FileWarning,
  AlertTriangle,
  EyeOff,
  Copy,
  PenLine,
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
import { computeHealthReport } from "@/lib/studio/health";
import type { HealthAction, HealthIssue } from "@/lib/studio/health";
import { findSimilarIcons } from "@/lib/studio/similarity";
import { cn } from "@/lib/utils";

/* severity → dot / icon language (amber for warnings, quiet for info) */
const ACTION_META: Record<HealthAction["kind"], { label: string; icon: typeof ChevronRight }> = {
  "inspect-first": { label: "Inspect", icon: Scan },
  "library-unassigned": { label: "View in library", icon: FolderOpen },
  "open-sheet": { label: "Open sheet", icon: ChevronRight },
  "tag-manager": { label: "Open tag manager", icon: GitMerge },
  "similar-icons": { label: "Review matches", icon: Copy },
};

const ISSUE_ICON: Record<string, typeof AlertTriangle> = {
  untagged: Tags,
  "empty-sheet": Grid3x3,
  "duplicate-names": FileWarning,
  "similar-icons": Copy,
  unassigned: FolderOpen,
  "singleton-tags": GitMerge,
  "low-fill": CircleDot,
  "skipped-cells": EyeOff,
};

function issueIcon(issue: HealthIssue): typeof AlertTriangle {
  if (issue.id.startsWith("empty-sheet")) return ISSUE_ICON["empty-sheet"];
  if (issue.id.startsWith("low-fill")) return ISSUE_ICON["low-fill"];
  if (issue.id.startsWith("skipped-cells")) return ISSUE_ICON["skipped-cells"];
  return ISSUE_ICON[issue.id] ?? AlertTriangle;
}

export function HealthReportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const icons = useStudio((s) => s.icons);
  const iconOrder = useStudio((s) => s.iconOrder);
  const sheets = useStudio((s) => s.sheets);

  /* geometry scan for visually-similar icons — runs ONLY while the
   * dialog is open (the scan is cheap for typical libraries, but it
   * parses every SVG and has no reason to run on closed dialogs). */
  const similarity = useMemo(
    () => (open ? findSimilarIcons(icons, iconOrder) : []),
    [open, icons, iconOrder]
  );

  const report = useMemo(
    () => computeHealthReport({ icons, iconOrder, sheets, similarity }),
    [icons, iconOrder, sheets, similarity]
  );

  const warningCount = report.issues.filter((i) => i.severity === "warning").length;

  function runAction(action: HealthAction): void {
    const s = useStudio.getState();
    switch (action.kind) {
      case "inspect-first":
        if (action.payload) {
          s.openInspector(action.payload);
          onOpenChange(false);
        }
        break;
      case "library-unassigned":
        s.setSidebarTab("library");
        s.setLibraryFilter({ query: "", tags: [], mode: "unassigned" });
        onOpenChange(false);
        break;
      case "open-sheet":
        if (action.payload) {
          s.setActiveSheet(action.payload);
          s.setViewMode("edit");
          onOpenChange(false);
        }
        break;
      case "tag-manager":
        s.openLibraryDialog("tag-manager");
        break;
      case "similar-icons":
        onOpenChange(false);
        s.openSimilarityDialog();
        break;
    }
  }

  const fillPct = Math.round(report.summary.fillRatio * 100);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
        <DialogHeader className="border-b border-border/70 px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span className="studio-dlg-tile">
              <HeartPulse className="h-4 w-4" aria-hidden="true" />
            </span>
            Library health report
            <span
              className={cn(
                "studio-chip ml-auto px-2.5 py-0.5 text-[10.5px]",
                report.issueCount === 0
                  ? "studio-chip--ok"
                  : warningCount > 0
                    ? "studio-chip--warn"
                    : "studio-chip--neutral",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  report.issueCount === 0
                    ? "bg-emerald-500"
                    : warningCount > 0
                      ? "bg-amber-500"
                      : "bg-muted-foreground/60",
                )}
                aria-hidden="true"
              />
              {report.issueCount === 0
                ? "Healthy"
                : `${report.issueCount} to review`}
            </span>
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            Workspace quality at a glance — every finding links to where it can be fixed.
          </DialogDescription>
        </DialogHeader>

        {/* summary mini-stats — a 5th "skipped" stat (and a 6th "stroke
            exc." stat) appear only when the workspace actually has them
            (keeps the happy path clean) */}
        {(() => {
          const stats: { icon: typeof Shapes; value: string; label: string; title?: string; tone?: string }[] = [
            { icon: Shapes, value: report.summary.iconCount.toLocaleString(), label: "icons" },
            { icon: Tags, value: String(report.summary.tagCount), label: "tags" },
            { icon: Grid3x3, value: String(report.summary.sheetCount), label: "sheets" },
            {
              icon: CircleDot,
              value: `${fillPct}%`,
              label: "cells full",
              title: `${fillPct}% of all sheet cells are filled`,
            },
          ];
          if (report.summary.skippedCells > 0) {
            stats.push({
              icon: EyeOff,
              value: String(report.summary.skippedCells),
              label: "skipped",
              title: `${report.summary.skippedCells} cell${report.summary.skippedCells === 1 ? "" : "s"} hidden from preview & export`,
              tone: "text-stone-500 dark:text-stone-400",
            });
          }
          if (report.summary.strokeExceptions > 0) {
            stats.push({
              icon: PenLine,
              value: String(report.summary.strokeExceptions),
              label: "stroke exc.",
              title: `${report.summary.strokeExceptions} icon${report.summary.strokeExceptions === 1 ? "" : "s"} with their own absolute stroke target — see the Stroke report`,
              tone: "text-stone-500 dark:text-stone-400",
            });
          }
          const cols = stats.length >= 6 ? "grid-cols-6" : stats.length === 5 ? "grid-cols-5" : "grid-cols-4";
          return (
            <div
              className={cn(
                "hr-stats mx-5 mt-4 grid divide-x divide-border/60 rounded-lg border border-border/70 bg-muted/30 dark:divide-border/80 dark:border-border",
                cols,
              )}
              role="group"
              aria-label="Workspace summary"
            >
              {stats.map((stat) => (
                <div
                  key={stat.label}
                  className={cn(
                    "flex flex-col items-center gap-0.5 px-1 py-2.5",
                    stats.length >= 6 && "py-2",
                  )}
                  title={stat.title}
                >
                  <stat.icon className={cn("h-3.5 w-3.5 text-muted-foreground", stat.tone)} aria-hidden="true" />
                  <span className={cn("text-[13px] font-semibold tabular-nums leading-tight", stats.length >= 6 && "text-[12px]", stat.tone)}>{stat.value}</span>
                  <span className={cn("text-[9.5px] uppercase tracking-wider hint-text", stats.length >= 6 && "text-[8.5px] tracking-wide", stat.tone)}>{stat.label}</span>
                </div>
              ))}
            </div>
          );
        })()}

        {/* issues */}
        <div
          className="custom-scroll max-h-[46vh] overflow-y-auto px-4 py-3 space-y-2"
          role="list"
          aria-label="Health issues"
        >
          {report.issues.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 py-8 text-center">
              <div className="grid h-11 w-11 place-items-center rounded-full bg-emerald-500/12 text-emerald-600 ring-1 ring-emerald-500/25 dark:text-emerald-400">
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
              </div>
              <p className="text-[13px] font-semibold">All clear</p>
              <p className="max-w-[300px] text-[11px] text-muted-foreground leading-relaxed">
                Every icon is tagged and assigned, every sheet has icons at a healthy fill level, no file name was
                imported twice, and no cells are left skipped — this library is ready to publish.
              </p>
            </div>
          ) : (
            report.issues.map((issue) => {
              const Icon = issueIcon(issue);
              const meta = ACTION_META[issue.action.kind];
              const ActionIcon = meta.icon;
              return (
                  <div
                    key={issue.id}
                    role="listitem"
                    className={cn(
                      "health-issue group",
                      issue.severity === "warning"
                        ? "health-issue-warning"
                        : "health-issue-info",
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <span
                        className={cn(
                          "mt-0.5 shrink-0 grid h-6 w-6 place-items-center rounded-md",
                          issue.severity === "warning"
                            ? "hr-glyph bg-amber-500/15 text-amber-600 dark:text-amber-400"
                            : "hr-glyph hr-glyph--info bg-muted/70 text-muted-foreground",
                        )}
                        aria-hidden="true"
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-[12.5px] font-semibold leading-tight truncate">{issue.title}</p>
                          {issue.count > 0 ? (
                            <span
                              className={cn(
                                "studio-chip shrink-0 px-1.5 py-px font-mono text-[10px] tabular-nums",
                                issue.severity === "warning" ? "studio-chip--warn" : "studio-chip--neutral",
                              )}
                            >
                              {issue.count}
                            </span>
                          ) : null}
                        <span className="sr-only">{issue.severity === "warning" ? "warning" : "info"}</span>
                        </div>
                        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{issue.detail}</p>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="hr-action mt-1.5 h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                          onClick={() => runAction(issue.action)}
                          aria-label={`${meta.label} — ${issue.title.toLowerCase()}`}
                        >
                          <ActionIcon className="h-3 w-3" aria-hidden="true" />
                          {meta.label}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
        </div>

        <DialogFooter className="studio-dlg-footer px-5 py-2.5 sm:justify-between">
          <span className="text-[10.5px] hint-text">
            {report.summary.iconCount === 0
              ? "Upload icons to begin a health check"
              : `Based on ${report.summary.iconCount.toLocaleString()} icons · ${report.summary.sheetCount} sheet${
                  report.summary.sheetCount === 1 ? "" : "s"
                } right now`}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11.5px]"
            onClick={() => onOpenChange(false)}
          >
            Close report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
