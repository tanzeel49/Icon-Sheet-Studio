"use client";

/**
 * ICON SHEET STUDIO — Header.
 * Left: brand · Center: workspace stats · Right: undo/redo, save state,
 * theme, export.
 */

import { Undo2, Redo2, Download, Sun, Moon, Monitor, Grid3x3, Keyboard, Search, HeartPulse, HardDriveDownload, PencilRuler, Library } from "lucide-react";
import { useSyncExternalStore, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "next-themes";
import { useStudio } from "@/lib/studio/store";
import { computeHealthReport } from "@/lib/studio/health";

const emptySubscribe = () => () => {};
/** SSR-safe mounted flag without effects. */
function useMounted(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

function SaveIndicator() {
  const saveStatus = useStudio((s) => s.saveStatus);
  const label =
    saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved" : saveStatus === "error" ? "Save failed" : "Up to date";
  const dot =
    saveStatus === "saving"
      ? "bg-amber-400 animate-pulse"
      : saveStatus === "error"
        ? "bg-red-500"
        : "bg-emerald-500";
  return (
    <span
      className="hidden sm:inline-flex items-center gap-1.5 text-[11px] text-muted-foreground px-2 h-8 rounded-md hover:bg-muted/60 transition-colors"
      role="status"
      aria-live="polite"
      title={`Workspace autosave: ${label}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

/** Round-9 recommendation #6: surface the health report in the header.
 * The pill only exists when the workspace has something to review — a calm
 * amber alert that jumps straight into the report. Healthy workspaces stay
 * clean (the report is still reachable via the palette and stat strip). */
function HealthPill() {
  const icons = useStudio((s) => s.icons);
  const iconOrder = useStudio((s) => s.iconOrder);
  const sheets = useStudio((s) => s.sheets);
  const openLibraryDialog = useStudio((s) => s.openLibraryDialog);
  const report = useMemo(
    () => computeHealthReport({ icons, iconOrder, sheets }),
    [icons, iconOrder, sheets],
  );
  const warnIssues = report.issues.filter((i) => i.severity === "warning");
  if (warnIssues.length === 0) return null;
  const summary = warnIssues.map((i) => i.title.toLowerCase()).join(", ");
  const notes = report.issues.length - warnIssues.length;
  return (
    <button
      type="button"
      onClick={() => openLibraryDialog("health")}
      aria-label={`${warnIssues.length} workspace ${warnIssues.length === 1 ? "warning" : "warnings"} — open the library health report`}
      title={`Health report: ${summary} — click to review`}
      className="hidden sm:inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400 text-[11px] font-medium hover:bg-amber-500/20 hover:border-amber-500/80 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <HeartPulse className="h-3 w-3" aria-hidden="true" />
      {warnIssues.length} to review{notes > 0 ? ` · ${notes} notes` : ""}
    </button>
  );
}

export function Header({ onExport, onHelp, onToggleLeft, onToggleRight, onOpenPalette, onOpenBuilder, onOpenLibrary }: {
  onExport: () => void;
  onHelp: () => void;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onOpenPalette: () => void;
  onOpenBuilder: () => void;
  onOpenLibrary: () => void;
}) {
  const iconCount = useStudio((s) => s.iconOrder.length);
  const sheetCount = useStudio((s) => s.sheets.length);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const openBackupDialog = useStudio((s) => s.openBackupDialog);
  const { theme, setTheme } = useTheme();
  // theme is undefined during SSR — only trust it after mount
  const mounted = useMounted();

  const resolvedTheme = mounted ? (theme ?? "system") : "system";
  const nextTheme = resolvedTheme === "dark" ? "light" : resolvedTheme === "light" ? "system" : "dark";
  const ThemeIcon = resolvedTheme === "dark" ? Moon : resolvedTheme === "light" ? Sun : Monitor;

  return (
    <header className="h-14 shrink-0 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 z-20">
      <div className="h-full flex items-center gap-2 px-4">
        {/* mobile drawer toggles */}
        <Button variant="ghost" size="icon" className="lg:hidden h-8 w-8" onClick={onToggleLeft} aria-label="Open sheets and library">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
          </svg>
        </Button>

        {/* brand */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="studio-brand-logo h-7 w-7 rounded-lg grid place-items-center shrink-0">
            <Grid3x3 className="h-4 w-4" />
          </div>
          <div className="leading-none hidden sm:block">
            {/* the app's single h1 (axe page-has-heading-one, round 6) */}
            <h1 className="text-[13px] font-semibold tracking-tight">Icon Sheet Studio</h1>
            <div className="text-[10px] text-muted-foreground">Professional icon-sheet artwork</div>
          </div>
        </div>

        {/* center stats — quiet mono text, not badge chips: the numbers are
         * ambient status, not controls. HealthPill only when actionable. */}
        <div className="flex-1 flex items-center justify-center gap-2 min-w-0">
          {iconCount > 0 || sheetCount > 0 ? (
            <>
              <span className="hidden sm:inline font-mono text-[11px] tabular-nums text-muted-foreground">
                {iconCount.toLocaleString()} icons
              </span>
              <span className="hidden sm:inline text-muted-foreground/50 text-[10px]" aria-hidden="true">·</span>
              <span className="hidden sm:inline font-mono text-[11px] tabular-nums text-muted-foreground">
                {sheetCount.toLocaleString()} sheets
              </span>
              <HealthPill />
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground hidden sm:block">Local-first · nothing leaves your browser</span>
          )}
        </div>

        {/* actions — grouped with hairline separators so each cluster reads
         * as one unit: search · history · status · utilities · primary CTA */}
        <div className="flex items-center gap-1">
          {/* command palette trigger */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onOpenPalette}
                aria-label="Open command palette (Ctrl+K)"
                className="palette-trigger hidden sm:flex items-center gap-2 h-8 px-2.5 rounded-md border border-border/70 bg-muted/40 text-muted-foreground text-[11px] hover:bg-muted hover:text-foreground hover:border-border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Search className="h-3.5 w-3.5" />
                <span className="hidden md:inline">Search everything…</span>
                <kbd className="kbd-chip">Ctrl K</kbd>
              </button>
            </TooltipTrigger>
            <TooltipContent>Command palette <span className="text-muted-foreground">Ctrl+K</span></TooltipContent>
          </Tooltip>

          <span className="hidden sm:block h-4 w-px bg-border/60 mx-1" aria-hidden="true" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 sm:hidden" onClick={onOpenPalette} aria-label="Open command palette">
                <Search className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Command palette</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!canUndo} onClick={undo} aria-label="Undo (Ctrl+Z)">
                <Undo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Undo <span className="text-muted-foreground">Ctrl+Z</span></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!canRedo} onClick={redo} aria-label="Redo (Ctrl+Shift+Z)">
                <Redo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Redo <span className="text-muted-foreground">Ctrl+Shift+Z</span></TooltipContent>
          </Tooltip>

          <SaveIndicator />

          <span className="hidden sm:block h-4 w-px bg-border/60 mx-1" aria-hidden="true" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onHelp} aria-label="Keyboard shortcuts (?)">
                <Keyboard className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Keyboard shortcuts <span className="text-muted-foreground">?</span></TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={openBackupDialog} aria-label="Workspace backup and restore">
                <HardDriveDownload className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Workspace backup <span className="text-muted-foreground">download / restore</span></TooltipContent>
          </Tooltip>

          {/* Template Builder — Phase 1 entry point (additive; the studio
              workflow underneath is untouched while the builder overlay is
              open). Outlined so it reads as a workspace switch, not an
              action on the current sheet. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-2.5 text-[11.5px]"
                onClick={onOpenBuilder}
                aria-label="Open the Template Builder — design reusable icon-sheet template layouts"
              >
                <PencilRuler className="h-3.5 w-3.5" />
                <span className="hidden md:inline">Template Builder</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Template Builder <span className="text-muted-foreground">design reusable sheet layouts</span></TooltipContent>
          </Tooltip>

          {/* Template Library — every template in one management surface
              (official / builder-made / uploaded SVG). */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-2.5 text-[11.5px]"
                onClick={onOpenLibrary}
                aria-label="Open the Template Library — preview, use, edit, duplicate or delete templates"
              >
                <Library className="h-3.5 w-3.5" />
                <span className="hidden xl:inline">Library</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Template Library <span className="text-muted-foreground">manage every template</span></TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setTheme(nextTheme)} aria-label={`Theme: ${resolvedTheme}. Click to switch`}>
                <ThemeIcon className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="capitalize">{resolvedTheme} theme</TooltipContent>
          </Tooltip>

          <span className="hidden sm:block h-4 w-px bg-border/60 mx-1.5" aria-hidden="true" />

          <Button size="sm" className="studio-export-btn h-8 gap-1.5 px-3.5" onClick={onExport} disabled={sheetCount === 0} aria-label="Export">
            <Download className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Export</span>
          </Button>

          {/* right-panel drawer toggle — the properties sidebar is a permanent
              column from lg (1024) up, so the toggle only exists below that */}
          <Button variant="ghost" size="icon" className="h-8 w-8 lg:hidden" onClick={onToggleRight} aria-label="Open design properties">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7" />
              <path d="M3 3h3v18H3z" />
            </svg>
          </Button>
        </div>
      </div>
    </header>
  );
}
