"use client";

/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 1) · workspace shell.
 *
 * Full-screen in-app overlay (the studio stays mounted underneath — its
 * workflow, state and shortcuts are untouched; they are simply GATED
 * while the builder is open). Three-panel professional layout:
 *
 *   LEFT   insert tools + layers
 *   CENTER toolbar-less canvas (zoom cluster lives in its status bar)
 *   RIGHT  properties
 *
 * Below 1024px the side panels become drawers so the canvas keeps the
 * space it needs. Keyboard: undo/redo, delete, duplicate, select-all,
 * arrow nudges (Shift = ×10), Escape clears selection — all suppressed
 * while typing or while an overlay dialog owns focus.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  ChevronDown,
  Copy,
  Eye,
  FilePlus2,
  FolderOpen,
  Layers,
  Library,
  PanelLeft,
  PanelRight,
  Redo2,
  RotateCcw,
  SaveAll,
  Undo2,
} from "lucide-react";
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
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBuilderStore } from "@/lib/builder/store";
import { round2 } from "@/lib/builder/geometry";
import { validateDocument } from "@/lib/builder/validation";
import { useStudio } from "@/lib/studio/store";
import { BuilderCanvas } from "./builder-canvas";
import { BuilderDrafts } from "./builder-drafts";
import { BuilderInsertPanel } from "./builder-insert";
import { BuilderLayersPanel } from "./builder-layers";
import { BuilderPropertiesPanel } from "./builder-properties";
import { BuilderPreview } from "./builder-preview";
import { NewTemplateDialog } from "./new-template-dialog";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Desktop layout flag (studio pattern — SSR-safe, no stuck overlays)  */
/* ------------------------------------------------------------------ */

const subscribeDesktopLayout = (cb: () => void): (() => void) => {
  const mq = window.matchMedia("(min-width: 1024px)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const getDesktopLayout = (): boolean => window.matchMedia("(min-width: 1024px)").matches;

const TYPING_SELECTOR = "input, textarea, select, [contenteditable='true'], [contenteditable='']";
const OVERLAY_SELECTOR = "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']";

/** Overlay that OWNS the keyboard: Radix dialogs/menus/select-listboxes
 *  portal to <body> — OUTSIDE the builder region. The layers panel's
 *  inline role="listbox" is INSIDE the region and must NOT swallow
 *  arrow-key nudges. */
function inPortaledOverlay(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  const overlay = el.closest(OVERLAY_SELECTOR);
  return !!overlay && !overlay.closest('[aria-label="Template Builder"]');
}

/* ------------------------------------------------------------------ */
/* Save state chip                                                     */
/* ------------------------------------------------------------------ */

function SaveChip() {
  const saveState = useBuilderStore((s) => s.saveState);
  const saveError = useBuilderStore((s) => s.saveError);
  const saveNow = useBuilderStore((s) => s.saveNow);
  const label =
    saveState === "saving"
      ? "Saving…"
      : saveState === "unsaved"
        ? "Unsaved changes"
        : saveState === "error"
          ? "Save failed"
          : saveState === "saved"
            ? "Saved"
            : "No draft yet";
  const dot =
    saveState === "saving"
      ? "bg-amber-400 animate-pulse"
      : saveState === "error"
        ? "bg-red-500"
        : saveState === "unsaved"
          ? "bg-amber-500"
          : "bg-emerald-500";
  return (
    <button
      type="button"
      onClick={() => void saveNow().then(() => toast.success("Draft saved"))}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        saveState === "error"
          ? "border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400"
          : "border-border/70 bg-card text-muted-foreground hover:text-foreground"
      )}
      role="status"
      aria-live="polite"
      title={saveError ? `Persistence error: ${saveError} — click to retry` : "Draft autosaves to your browser — click to save now"}
    >
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Validation badge + issue popover                                    */
/* ------------------------------------------------------------------ */

function ValidationBadge() {
  const docs = useBuilderStore((s) => s.docs);
  const activeDocId = useBuilderStore((s) => s.activeDocId);
  const setSelection = useBuilderStore((s) => s.setSelection);
  const issues = activeDocId ? validateDocument(docs.find((d) => d.id === activeDocId) ?? null!) : [];
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  if (errors.length === 0 && warnings.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            errors.length > 0
              ? "border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400"
              : "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          )}
          aria-label={`${errors.length} errors and ${warnings.length} warnings — open validation details`}
        >
          <AlertTriangle className="size-3" aria-hidden />
          {errors.length > 0 ? `${errors.length} error${errors.length > 1 ? "s" : ""}` : `${warnings.length} warning${warnings.length > 1 ? "s" : ""}`}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-0">
        <div className="max-h-72 overflow-y-auto custom-scroll p-2">
          <p className="px-2 pb-1.5 pt-1 text-[11px] font-semibold text-foreground">Validation</p>
          {issues.slice(0, 30).map((issue, i) => (
            <button
              key={i}
              type="button"
              className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] leading-relaxed hover:bg-muted/70 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              onClick={() => {
                if (issue.elementId) setSelection([issue.elementId]);
              }}
            >
              <span
                className={cn(
                  "mt-0.5 size-1.5 shrink-0 rounded-full",
                  issue.level === "error" ? "bg-red-500" : "bg-amber-500"
                )}
                aria-hidden
              />
              <span className="min-w-0 text-muted-foreground">
                {issue.elementName ? <strong className="font-medium text-foreground">{issue.elementName}: </strong> : null}
                {issue.message}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Published chip — honest “in library” state                          */
/* ------------------------------------------------------------------ */

function PublishedChip({ recordName }: { recordName: string }) {
  return (
    <span
      className="hidden items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 md:inline-flex"
      role="status"
      title={`Published to the Template Library as “${recordName}” — saving again updates that template in place`}
    >
      <BadgeCheck className="size-3" aria-hidden />
      In Library
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

export function TemplateBuilder({ onClose, onOpenLibrary }: { onClose: () => void; onOpenLibrary: () => void }) {
  const hydrate = useBuilderStore((s) => s.hydrate);
  const hydrated = useBuilderStore((s) => s.hydrated);
  const docs = useBuilderStore((s) => s.docs);
  const activeDocId = useBuilderStore((s) => s.activeDocId);
  const selection = useBuilderStore((s) => s.selection);
  const canUndo = useBuilderStore((s) => s.past.length > 0);
  const canRedo = useBuilderStore((s) => s.future.length > 0);

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [focusText, setFocusText] = useState<{ id: string | null; token: number }>({ id: null, token: 0 });
  const [previewMode, setPreviewMode] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmSave, setConfirmSave] = useState<{ sheets: number } | null>(null);
  const notesShownRef = useRef(false);

  const isDesktopLayout = useSyncExternalStore(subscribeDesktopLayout, getDesktopLayout, () => true);
  const hasDoc = !!activeDocId;

  /* boot the builder store (IndexedDB hydrate) exactly once */
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  /* surface corruption-repair notes once after hydrate */
  useEffect(() => {
    if (hydrated && !notesShownRef.current) {
      notesShownRef.current = true;
      const notes = useBuilderStore.getState().loadNotes;
      if (notes.length > 0) {
        toast.warning(`Repaired ${notes.length} issue${notes.length > 1 ? "s" : ""} in stored drafts`, {
          description: notes.slice(0, 4).join(" · ").slice(0, 280),
        });
      }
    }
  }, [hydrated]);

  /* best-effort flush when leaving the builder or hiding the tab */
  useEffect(() => {
    const flush = (): void => {
      void useBuilderStore.getState().saveNow();
    };
    const onVisibility = (): void => {
      if (document.hidden) flush();
    };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      flush();
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  /* ---------------- keyboard (builder-global) ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!useBuilderStore.getState().activeDocId) return;
      const target = e.target as HTMLElement | null;
      if (inPortaledOverlay(target)) return;
      const typing = !!target?.closest?.(TYPING_SELECTOR) || target?.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;

      /* preview mode owns the keyboard: Escape exits, P toggles back */
      if (previewMode) {
        if (e.key === "Escape" && !typing) {
          e.preventDefault();
          setPreviewMode(false);
        }
        return;
      }

      if (mod && e.key.toLowerCase() === "z") {
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) useBuilderStore.getState().redo();
        else useBuilderStore.getState().undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        if (typing) return;
        e.preventDefault();
        useBuilderStore.getState().redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        if (typing) return;
        e.preventDefault();
        useBuilderStore.getState().duplicateElements(useBuilderStore.getState().selection);
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        if (typing) return;
        e.preventDefault();
        useBuilderStore.getState().selectAll();
        return;
      }
      if (mod || e.altKey) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        if (typing) return;
        e.preventDefault();
        useBuilderStore.getState().deleteElements(useBuilderStore.getState().selection);
        return;
      }
      if (e.key === "Escape") {
        if (typing) return;
        const st = useBuilderStore.getState();
        if (st.selection.length > 0) st.setSelection([]);
        return;
      }
      if (e.key.toLowerCase() === "p" && !mod && !e.altKey) {
        if (typing) return;
        e.preventDefault();
        setPreviewMode(true);
        return;
      }
      if (e.key.startsWith("Arrow")) {
        if (typing) return;
        e.preventDefault();
        const st = useBuilderStore.getState();
        const doc = st.docs.find((d) => d.id === st.activeDocId);
        if (!doc) return;
        const ids = st.selection.filter((id) => {
          const el = doc.elements.find((x) => x.id === id);
          return el && !el.locked && el.visible;
        });
        if (ids.length === 0) return;
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        st.updateElements(
          ids,
          (el) => ({ x: round2(el.x + dx), y: round2(el.y + dy) }),
          { label: "Nudge", key: `nudge:${ids.join(",")}:${dx}:${dy}` }
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewMode]);

  /* text edit requests from the canvas → properties focus */
  const onRequestTextEdit = useCallback((id: string) => {
    setFocusText((f) => ({ id, token: f.token + 1 }));
  }, []);

  const backToStudio = useCallback(() => {
    void useBuilderStore
      .getState()
      .saveNow()
      .catch(() => undefined)
      .finally(() => onClose());
  }, [onClose]);

  const activeDoc = docs.find((d) => d.id === activeDocId) ?? null;

  /* ---------------- publish state + save flow ---------------- */
  const customTemplates = useStudio((s) => s.customTemplates);
  const studioSheets = useStudio((s) => s.sheets);
  const publishedRecord = useMemo(() => {
    const pid = activeDoc?.metadata.publishedTemplateId;
    return pid ? customTemplates.find((r) => r.id === pid) ?? null : null;
  }, [activeDoc?.metadata.publishedTemplateId, customTemplates]);

  const saveTemplate = useCallback((): void => {
    if (!activeDocId) return;
    const result = useBuilderStore.getState().publishDocument(activeDocId);
    if (!result.ok) {
      toast.error("Template not saved — fix these problems first", {
        description:
          result.issues.slice(0, 3).map((i) => i.message).join(" · ") +
          (result.issues.length > 3 ? ` … +${result.issues.length - 3} more` : ""),
      });
      return;
    }
    toast.success(
      result.updated ? `“${result.recordName}” updated in the Template Library` : `“${result.recordName}” saved to the Template Library`,
      {
        description:
          "Generate sheets with this layout from the Studio's template picker or the Generate banner." +
          (result.issues.length > 0
            ? ` ${result.issues.length} warning${result.issues.length > 1 ? "s" : ""} noted on the template.`
            : ""),
      }
    );
  }, [activeDocId]);

  /* re-publishing a template that sheets already use needs explicit consent —
   * the diff baseline changes for those sheets (their look will update) */
  const onSaveTemplateClick = useCallback((): void => {
    const pid = activeDoc?.metadata.publishedTemplateId;
    if (!pid) {
      saveTemplate();
      return;
    }
    const inUse = studioSheets.filter((s) => s.templateId === pid).length;
    if (inUse > 0) setConfirmSave({ sheets: inUse });
    else saveTemplate();
  }, [activeDoc?.metadata.publishedTemplateId, studioSheets, saveTemplate]);

  const commitName = useCallback(
    (input: HTMLInputElement): void => {
      const next = input.value.trim().slice(0, 120);
      if (activeDoc && next && next !== activeDoc.name) {
        useBuilderStore.getState().renameDocument(activeDoc.id, next);
      } else if (activeDoc) {
        input.value = activeDoc.name;
      }
    },
    [activeDoc]
  );

  /* ---------------- panels (shared between column + drawer) ---------------- */

  const leftPanel = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Insert</p>
      </div>
      <div className="shrink-0 px-2.5 py-2.5">
        <BuilderInsertPanel />
      </div>
      <div className="shrink-0 border-y border-border px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Layers</p>
      </div>
      <BuilderLayersPanel />
    </div>
  );

  const rightPanel = (
    /* The ONE vertical scroll owner of the builder inspector. w-full pins
     * the flex item to the aside's exact width (its children never size the
     * column), h-full + min-h-0 give it exactly the aside's height inside
     * the flex body row, and overflow-x-hidden guarantees no horizontal
     * scrollbar can ever appear (overflow-y:auto alone computes
     * overflow-x:auto). Works identically in the <lg drawer, where the
     * SheetContent provides the height. */
    <div className="h-full w-full min-h-0 overflow-y-auto overflow-x-hidden custom-scroll">
      <BuilderPropertiesPanel focusTextId={focusText.id} focusTextToken={focusText.token} />
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-background text-foreground"
      role="region"
      aria-label="Template Builder"
    >
      {/* ---------------- header ---------------- */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-2.5 sm:px-3">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-[12px]"
          onClick={backToStudio}
          autoFocus
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Back to Studio</span>
        </Button>
        <span className="h-4 w-px bg-border" aria-hidden />

        <div className="flex min-w-0 items-center gap-2">
          <span className="studio-brand-logo grid size-6 shrink-0 place-items-center rounded-md" aria-hidden>
            <Layers className="size-3.5" />
          </span>
          <span className="hidden text-[12.5px] font-semibold tracking-tight md:inline">Template Builder</span>
          {activeDoc && (
            <>
              <span className="hidden text-muted-foreground/40 md:inline" aria-hidden>/</span>
              {/* editable template name — Enter applies, Escape reverts, blur commits */}
              <input
                key={`${activeDoc.id}:${activeDoc.name}`}
                defaultValue={activeDoc.name}
                onBlur={(e) => commitName(e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    e.currentTarget.value = activeDoc.name;
                    e.currentTarget.blur();
                  }
                }}
                maxLength={120}
                aria-label="Template name"
                title="Template name — press Enter to apply, Escape to revert"
                className="h-7 w-[clamp(80px,14vw,220px)] min-w-0 rounded-md border border-transparent bg-transparent px-1.5 text-[12px] font-medium text-foreground outline-none transition-colors hover:border-border focus-visible:border-ring focus-visible:bg-card"
              />
            </>
          )}
        </div>

        {/* draft switcher */}
        {docs.length > 0 && (
          <div className="ml-1 hidden items-center gap-1.5 md:flex">
            <Select
              value={activeDocId ?? "none"}
              onValueChange={(v) => {
                if (v === "__new__") setNewDialogOpen(true);
                else if (v !== "none") useBuilderStore.getState().openDocument(v);
              }}
            >
              <SelectTrigger
                className="h-8 w-[168px] gap-1 text-[11.5px]"
                aria-label="Switch template draft"
                title="Switch draft"
              >
                <SelectValue placeholder="Drafts" />
                <ChevronDown className="size-3.5 opacity-50" aria-hidden />
              </SelectTrigger>
              <SelectContent>
                {docs.map((doc) => (
                  <SelectItem key={doc.id} value={doc.id} className="text-[12px]">
                    {doc.name}
                  </SelectItem>
                ))}
                <SelectItem value="__new__" className="gap-1.5 text-[12px] text-muted-foreground">
                  <FilePlus2 className="size-3.5" />
                  New template…
                </SelectItem>
              </SelectContent>
            </Select>
            {/* back to the drafts manager (open/rename/delete drafts) —
             * there was no way back to the draft list once a draft was open */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={previewMode}
                  onClick={() => useBuilderStore.getState().closeDocument()}
                  aria-label="Back to templates — manage all drafts"
                  title="All templates — open, rename or delete drafts"
                >
                  <FolderOpen className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>All templates</TooltipContent>
            </Tooltip>
          </div>
        )}

        <div className="flex-1" />

        {/* status + actions */}
        <div className="flex items-center gap-1.5">
          {publishedRecord && <PublishedChip recordName={publishedRecord.name} />}
          <ValidationBadge />
          <SaveChip />
          <span className="hidden h-4 w-px bg-border sm:block" aria-hidden />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" disabled={!canUndo || previewMode} onClick={() => useBuilderStore.getState().undo()} aria-label="Undo (Ctrl+Z)">
                <Undo2 className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Undo <span className="text-muted-foreground">Ctrl+Z</span></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" disabled={!canRedo || previewMode} onClick={() => useBuilderStore.getState().redo()} aria-label="Redo (Ctrl+Shift+Z)">
                <Redo2 className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Redo <span className="text-muted-foreground">Ctrl+Shift+Z</span></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={selection.length === 0 || !hasDoc || previewMode}
                onClick={() => useBuilderStore.getState().duplicateElements(useBuilderStore.getState().selection)}
                aria-label="Duplicate selection (Ctrl+D)"
              >
                <Copy className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Duplicate <span className="text-muted-foreground">Ctrl+D</span></TooltipContent>
          </Tooltip>

          <span className="hidden h-4 w-px bg-border sm:block" aria-hidden />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn("h-8 gap-1.5 px-2.5 text-[11.5px]", previewMode && "bg-muted text-foreground")}
                disabled={!hasDoc}
                onClick={() => setPreviewMode((v) => !v)}
                aria-pressed={previewMode}
                aria-label="Preview the compiled template exactly as the Studio will render it"
              >
                <Eye className="size-3.5" />
                <span className="hidden xl:inline">{previewMode ? "Editing off" : "Preview"}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Preview <span className="text-muted-foreground">P — exact Studio render</span></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-2.5 text-[11.5px]"
                onClick={onOpenLibrary}
                aria-label="Open the Template Library"
              >
                <Library className="size-3.5" />
                <span className="hidden xl:inline">Library</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Template Library <span className="text-muted-foreground">manage every template</span></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={!hasDoc || previewMode}
                onClick={() => setConfirmReset(true)}
                aria-label="Reset the layout to the default builder configuration"
              >
                <RotateCcw className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reset layout</TooltipContent>
          </Tooltip>

          <span className="hidden h-4 w-px bg-border sm:block" aria-hidden />
          <Button
            size="sm"
            className="studio-export-btn h-8 gap-1.5 px-2.5 text-[11.5px]"
            disabled={!hasDoc}
            onClick={onSaveTemplateClick}
            aria-label="Save this template to the Template Library"
            title="Validate and save to the Template Library — the Studio can then generate sheets with this layout"
          >
            <SaveAll className="hidden h-3.5 w-3.5 sm:inline" />
            <span className="hidden sm:inline">Save Template</span>
            <span className="sm:hidden">Save</span>
          </Button>
          <Button variant="ghost" size="icon" className="size-8 lg:hidden" onClick={() => setLeftOpen(true)} aria-label="Open insert and layers panel">
            <PanelLeft className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-8 lg:hidden" onClick={() => setRightOpen(true)} aria-label="Open properties panel">
            <PanelRight className="size-4" />
          </Button>
        </div>
      </header>

      {/* ---------------- body ---------------- */}
      {!hydrated ? (
        <div className="grid flex-1 place-items-center">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <div className="size-7 animate-spin rounded-full border-2 border-muted-foreground/15 border-t-muted-foreground/50" />
            <p className="text-[11px]">Loading template drafts…</p>
          </div>
        </div>
      ) : !activeDoc ? (
        <BuilderDrafts onNewTemplate={() => setNewDialogOpen(true)} onOpenLibrary={onOpenLibrary} />
      ) : previewMode ? (
        <BuilderPreview doc={activeDoc} onExit={() => setPreviewMode(false)} />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* left — desktop */}
          <aside aria-label="Insert tools and layers" className="hidden w-56 shrink-0 border-r border-border bg-card/40 lg:flex xl:w-60">
            {leftPanel}
          </aside>

          {/* center — canvas */}
          <main className="flex min-w-0 flex-1 flex-col">
            <BuilderCanvas onRequestTextEdit={onRequestTextEdit} />
          </main>

          {/* right — properties */}
          <aside aria-label="Element properties" className="hidden w-[300px] shrink-0 border-l border-border bg-card/40 lg:flex xl:w-[316px]">
            {rightPanel}
          </aside>
        </div>
      )}

      {/* ---------------- mobile drawers ---------------- */}
      {!isDesktopLayout && (
        <>
          <Sheet open={leftOpen} onOpenChange={setLeftOpen}>
            <SheetContent side="left" className="w-[260px] p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Insert tools and layers</SheetTitle>
                <SheetDescription>Add objects and manage layers</SheetDescription>
              </SheetHeader>
              {leftPanel}
            </SheetContent>
          </Sheet>
          <Sheet open={rightOpen} onOpenChange={setRightOpen}>
            <SheetContent side="right" className="w-[300px] p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Properties</SheetTitle>
                <SheetDescription>Edit the selected object</SheetDescription>
              </SheetHeader>
              {rightPanel}
            </SheetContent>
          </Sheet>
        </>
      )}

      <NewTemplateDialog open={newDialogOpen} onOpenChange={setNewDialogOpen} />

      {/* Reset Layout — destructive to unsaved builder changes (undoable) */}
      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset this template layout?</AlertDialogTitle>
            <AlertDialogDescription>
              The layout resets to the default builder configuration — a 1200 × 1200 white artboard with only
              the background layer. Your current elements are removed (Ctrl+Z restores them). The template
              name and its link to the Template Library are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => useBuilderStore.getState().resetLayout()}>
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* re-publish while sheets use the template — explicit consent.
       * phase 3 version-pinning semantics: existing sheets are NOT
       * restyled; they keep their pinned revision and each sheet's
       * Properties panel offers an explicit "Update to latest". */}
      <AlertDialog open={!!confirmSave} onOpenChange={(v) => !v && setConfirmSave(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update the saved template?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmSave?.sheets} sheet{confirmSave?.sheets === 1 ? "" : "s"} currently use this template. Saving
              publishes a new template version — existing sheets keep their current layout untouched and can move
              to the new version individually (“Update to latest” in the sheet's Properties panel). New sheets use
              the new version immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmSave(null);
                saveTemplate();
              }}
            >
              Save new version
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
