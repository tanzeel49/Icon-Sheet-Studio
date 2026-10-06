"use client";

/**
 * ICON SHEET STUDIO — Template import dialog (universal template support).
 * Pick an arbitrary icon-sheet SVG → automatic analysis → REVIEW & ADJUST
 * (toggle detected slots, add missed slots, choose or place the hero slot,
 * name it) → save as a reusable custom template. When automatic analysis
 * cannot determine the slots, the canvas is still read and the user can
 * MARK THE SLOTS MANUALLY. The original file is never modified; nothing is
 * written to the workspace unless the user confirms.
 */

import { useCallback, useRef, useState } from "react";
import type { JSX, MouseEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useStudio } from "@/lib/studio/store";
import {
  analyzeTemplateSvg,
  describeSlotRects,
  type SlotCandidate,
  type TemplateAnalysis,
} from "@/lib/studio/template-analyzer";
import { annotateCustomSvg } from "@/lib/studio/custom-template";
import type { CustomTextRole, Rect } from "@/lib/studio/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  FileUp,
  Loader2,
  Check,
  TriangleAlert,
  Sparkles,
  Save,
  RotateCcw,
  SquarePlus,
  Crown,
  PenLine,
  Type,
} from "lucide-react";

interface DialogState {
  file: File | null;
  svgText: string;
  /** successful analysis (auto review mode) */
  analysis: TemplateAnalysis | null;
  /** canvas info is kept even when slot detection fails (manual fallback) */
  canvas: { width: number; height: number; viewBox: string } | null;
  error: string | null;
  busy: boolean;
  /** manual marking mode (analysis failed, user places slots by hand) */
  manual: boolean;
}

const INITIAL: DialogState = {
  file: null,
  svgText: "",
  analysis: null,
  canvas: null,
  error: null,
  busy: false,
  manual: false,
};

type AddMode = "off" | "slot" | "hero";

const HERO_MANUAL = "manual";

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function TemplateImportDialog(): JSX.Element | null {
  const open = useStudio((s) => s.templateImportOpen);
  const close = useStudio((s) => s.closeTemplateImport);
  const importTemplate = useStudio((s) => s.importCustomTemplate);

  const [state, setState] = useState<DialogState>(INITIAL);
  const [slots, setSlots] = useState<SlotCandidate[]>([]);
  const [heroChoice, setHeroChoice] = useState<string>("-1"); // "-1" | index | "manual"
  const [manualHero, setManualHero] = useState<Rect | null>(null);
  const [addMode, setAddMode] = useState<AddMode>("off");
  const [name, setName] = useState("");
  /* per detected text element: editing role ("none" = not editable) —
   * initialized from the analyzer's guesses, reviewable by the user */
  const [textRoles, setTextRoles] = useState<Array<CustomTextRole | "none">>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const analyze = useCallback(async (file: File) => {
    setState({ ...INITIAL, file, busy: true });
    try {
      const svgText = await file.text();
      const analysis = analyzeTemplateSvg(svgText);
      const canvas = {
        width: analysis.width,
        height: analysis.height,
        viewBox: analysis.viewBox,
      };
      if (!analysis.ok) {
        /* canvas may still be known → manual marking remains possible */
        setState({
          file,
          svgText,
          analysis: null,
          canvas: canvas.width > 0 ? canvas : null,
          error: analysis.error ?? "Template analysis could not determine the icon slots.",
          busy: false,
          manual: false,
        });
        setSlots([]);
        setHeroChoice("-1");
        setManualHero(null);
        setAddMode("off");
        return;
      }
      setState({
        file,
        svgText,
        analysis,
        canvas,
        error: null,
        busy: false,
        manual: false,
      });
      setSlots(analysis.slots.map((s) => ({ ...s, selected: true })));
      setHeroChoice("-1");
      setManualHero(null);
      setAddMode("off");
      /* text role review defaults = analyzer guesses (category/volume/caption) */
      setTextRoles((analysis.texts ?? []).map((t) => t.guess ?? "none"));
      setName(
        file.name.replace(/\.svg$/i, "").replace(/[_-]+/g, " ").trim() || "Custom template"
      );
    } catch (err) {
      console.error("[template-import] failed", err);
      setState({
        ...INITIAL,
        file,
        error: "Template analysis could not determine the icon slots.",
      });
    }
  }, []);

  const enterManual = () => {
    if (!state.canvas) return;
    setState({ ...state, analysis: null, error: null, manual: true });
    setSlots([]);
    setHeroChoice("-1");
    setManualHero(null);
    setAddMode("slot");
    setName(
      state.file?.name.replace(/\.svg$/i, "").replace(/[_-]+/g, " ").trim() || "Custom template"
    );
  };

  const toggleSlot = (i: number) => {
    setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, selected: !s.selected } : s)));
  };

  const removeSlot = (i: number) => {
    setSlots((prev) => prev.filter((_, j) => j !== i));
  };

  /* -- click-to-place on the preview ---------------------------------- */
  const vbParts = state.canvas
    ? state.canvas.viewBox.split(/\s+/).map(Number)
    : [0, 0, 0, 0];
  const [vbX, vbY, vbW, vbH] = vbParts;

  const medianCell = (): number => {
    const dims = slots.map((s) => Math.min(s.rect.width, s.rect.height));
    if (dims.length) {
      const sorted = [...dims].sort((a, b) => a - b);
      return sorted[sorted.length >> 1];
    }
    return Math.min(vbW || 1000, vbH || 1000) / 9;
  };

  const onPreviewClick = (e: MouseEvent<HTMLDivElement>) => {
    if (addMode === "off" || !state.canvas || vbW <= 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const rx = clamp((e.clientX - box.left) / box.width, 0, 1);
    const ry = clamp((e.clientY - box.top) / box.height, 0, 1);
    const cx = vbX + rx * vbW;
    const cy = vbY + ry * vbH;
    if (addMode === "hero") {
      const size = medianCell() * 1.5;
      const half = size / 2;
      setManualHero({
        x: clamp(cx - half, vbX, vbX + vbW - size),
        y: clamp(cy - half, vbY, vbY + vbH - size),
        width: size,
        height: size,
      });
      setHeroChoice(HERO_MANUAL);
      setAddMode("off");
      return;
    }
    const size = medianCell();
    const half = size / 2;
    setSlots((prev) => [
      ...prev,
      {
        rect: {
          x: clamp(cx - half, vbX, vbX + vbW - size),
          y: clamp(cy - half, vbY, vbY + vbH - size),
          width: size,
          height: size,
        },
        selected: true,
        manual: true,
      },
    ]);
  };

  const { analysis } = state;
  const enabledSlots = slots.filter((s) => s.selected);
  const enabledCount = enabledSlots.length;
  const manualCount = slots.filter((s) => s.manual).length;

  const resolvedHeroRect: Rect | null =
    heroChoice === HERO_MANUAL
      ? manualHero
      : heroChoice !== "-1" && analysis
        ? (analysis.heroCandidates[Number(heroChoice)]?.rect ?? null)
        : null;

  const save = () => {
    if (!state.canvas || !state.svgText || enabledCount === 0 || !name.trim()) return;
    const rects = enabledSlots.map((s) => ({
      x: s.rect.x,
      y: s.rect.y,
      width: s.rect.width,
      height: s.rect.height,
    }));
    const hero = resolvedHeroRect
      ? {
          x: resolvedHeroRect.x,
          y: resolvedHeroRect.y,
          width: resolvedHeroRect.width,
          height: resolvedHeroRect.height,
        }
      : null;
    /* role-annotate the confirmed structure (slots + hero + text mapping):
     * the editableSvg is geometry-identical to the source — only invisible
     * data-iss markers are added so the editing system can find the elements
     * it may touch. Failure is non-fatal: the template still saves, the
     * Properties panel then shows those controls as unavailable. */
    const rolesForSave = state.manual ? [] : textRoles;
    const annotation = annotateCustomSvg({
      svgText: state.svgText,
      slotRects: rects,
      heroRect: hero,
      textRoles: rolesForSave,
    });
    importTemplate({
      name: name.trim(),
      sourceSvg: state.svgText,
      width: state.canvas.width,
      height: state.canvas.height,
      viewBox: state.canvas.viewBox,
      capacity: rects.length,
      iconSlots: rects,
      heroSlot: hero,
      grid: {
        cols: rects.length,
        rows: 1,
        gap: analysis?.spacing?.h ?? 0,
      },
      editableSvg: annotation?.editableSvg,
      roles: annotation?.roles,
      metadata: {
        autoDetected: !state.manual,
        confidence: state.manual ? 1 : analysis?.confidence ?? 0,
        /* recompute from the FINAL selection so the saved description always
         * matches the saved capacity (internal consistency) */
        gridDescription: describeSlotRects(rects),
        notes: state.manual
          ? ["Slots were marked manually by the user."]
          : analysis?.notes ?? [],
        warnings: state.manual ? [] : analysis?.warnings ?? [],
        fileName: state.file?.name,
        spacing: state.manual ? null : analysis?.spacing ?? null,
        textElements: state.manual ? 0 : analysis?.textElementCount ?? 0,
        background: state.manual
          ? null
          : analysis?.background
            ? `${Math.round(analysis.background.width)} × ${Math.round(analysis.background.height)}`
            : null,
        sections: state.manual ? 1 : analysis?.sections ?? 1,
      },
    });
    if (annotation && rolesForSave.some((r) => r !== "none")) {
      const mapped = rolesForSave.filter((r) => r !== "none").join(", ");
      toast.success("Text elements mapped", {
        description: `“${name.trim()}” carries ${mapped} text — sheets render their own category, volume and caption there.`,
      });
    }
  };

  const reviewVisible = (analysis || state.manual) && !state.busy && !state.error;
  const structureChips: { label: string; title: string }[] = [];
  if (analysis?.background) {
    structureChips.push({
      label: "background",
      title: `Background element detected — ${Math.round(analysis.background.width)} × ${Math.round(analysis.background.height)}; its color becomes editable (geometry never changes)`,
    });
  }
  if ((analysis?.textElementCount ?? 0) > 0) {
    structureChips.push({
      label: `${analysis?.textElementCount} text`,
      title: `Detected text elements — assign their editing roles (category / volume / caption) in the Text mapping step below${analysis?.textSnippets?.length ? `: ${analysis.textSnippets.join(" · ")}` : ""}`,
    });
  }
  if (analysis?.spacing && (analysis.spacing.h > 0 || analysis.spacing.v > 0)) {
    structureChips.push({
      label: `gap ${analysis.spacing.h} × ${analysis.spacing.v}`,
      title: `Median slot gap — horizontal ${analysis.spacing.h}, vertical ${analysis.spacing.v} (viewBox units)`,
    });
  }
  if (analysis?.margins) {
    const m = analysis.margins;
    structureChips.push({
      label: `margin ${m.left}·${m.top}`,
      title: `Grid margins — left ${m.left}, top ${m.top}, right ${m.right}, bottom ${m.bottom}`,
    });
  }
  if ((analysis?.sections ?? 1) > 1) {
    structureChips.push({
      label: `${analysis?.sections} sections`,
      title: "Multiple cell-size sections contribute slots — verify the numbering",
    });
  }
  if (resolvedHeroRect) {
    structureChips.push({
      label: `hero ${Math.round(resolvedHeroRect.width)}×${Math.round(resolvedHeroRect.height)}`,
      title: "The hero icon of every sheet using this template lands in this slot",
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-2xl p-0 overflow-hidden max-h-[88vh] flex flex-col gap-0">
        <DialogHeader className="p-5 pb-3 border-b border-border/70">
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span className="studio-dlg-tile">
              <FileUp className="size-4" aria-hidden />
            </span>
            Import Template SVG
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            Upload any icon-sheet template — the studio detects its canvas, grid and hero slot.
            The original file is kept exactly as-is; only the detected slots get populated.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto custom-scroll min-h-0">
          {/* ---- picker ---- */}
          {!analysis && !state.manual && !state.error && !state.busy ? (
            <div className="p-5">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="group flex w-full cursor-pointer select-none flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-border p-8 text-center outline-none transition-colors hover:border-amber-500/60 hover:bg-amber-500/[0.04] hover:shadow-md focus-within:ring-2 focus-within:ring-amber-500"
              >
                <FileUp className="h-5 w-5 text-muted-foreground transition-transform duration-200 group-hover:-rotate-3 group-hover:scale-110 group-hover:text-amber-600 dark:group-hover:text-amber-400" aria-hidden />
                <p className="text-[13px] font-medium">Choose a template SVG</p>
                <p className="max-w-sm text-[11px] text-muted-foreground">
                  Any canvas size, any number of icon cells, any layout — regular grids,
                  irregular grids, hero areas, margins and decorations are all supported.
                </p>
              </button>
            </div>
          ) : null}

          {/* ---- analyzing ---- */}
          {state.busy ? (
            <div className="grid place-items-center gap-2 p-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
              <p className="text-[12px]">Analyzing template…</p>
            </div>
          ) : null}

          {/* ---- error (with manual fallback when the canvas was readable) ---- */}
          {state.error && !state.busy ? (
            <div className="space-y-3 p-5">
              <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3.5">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                <div className="space-y-1">
                  <p className="text-[13px] font-semibold text-amber-700 dark:text-amber-400">
                    Template analysis could not determine the icon slots.
                  </p>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    {state.error}
                  </p>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Nothing was changed — your workspace is exactly as it was. Try a template whose
                icon cells are visible shapes, or mark the slots by hand.
              </p>
              <div className="flex flex-wrap gap-2">
                {state.canvas ? (
                  <Button
                    size="sm"
                    className="h-8 gap-1.5 text-[12px]"
                    onClick={enterManual}
                  >
                    <PenLine className="size-3.5" aria-hidden />
                    Mark slots manually
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[12px]" onClick={() => inputRef.current?.click()}>
                  <RotateCcw className="size-3.5" aria-hidden />
                  Try another file
                </Button>
                <Button size="sm" variant="ghost" className="h-8 text-[12px]" onClick={close}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {/* ---- analysis review / manual marking ---- */}
          {reviewVisible ? (
            <div className="space-y-4 p-5">
              {/* summary chips */}
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="gap-1 font-mono text-[10px] tabular-nums">
                  {Math.round(state.canvas?.width ?? 0)} × {Math.round(state.canvas?.height ?? 0)}
                </Badge>
                <Badge variant="secondary" className="gap-1 font-mono text-[10px] tabular-nums">
                  {enabledCount} slots
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  {state.manual
                    ? describeSlotRects(enabledSlots.map((s) => s.rect)) || "mark slots on the preview"
                    : (analysis?.gridDescription ?? "")}
                </Badge>
                <Badge
                  variant="outline"
                  className={cn(
                    "gap-1 text-[10px]",
                    state.manual
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : (analysis?.confidence ?? 0) >= 0.9
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  )}
                >
                  <Sparkles className="size-3" aria-hidden />
                  {state.manual
                    ? "manual marking"
                    : (analysis?.confidence ?? 0) >= 0.9
                      ? "high confidence"
                      : "check slots"}
                </Badge>
              </div>

              {/* detected structure chips (validation transparency) */}
              {structureChips.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {structureChips.map((c) => (
                    <span
                      key={c.label}
                      title={c.title}
                      className="inline-flex items-center rounded-full border border-border/80 bg-muted/50 px-2 py-0.5 font-mono text-[9.5px] tabular-nums text-muted-foreground"
                    >
                      {c.label}
                    </span>
                  ))}
                </div>
              ) : null}

              {(analysis?.notes ?? []).map((n) => (
                <p key={n} className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
                  <TriangleAlert className="mt-0.5 size-3 shrink-0 text-amber-600" aria-hidden />
                  {n}
                </p>
              ))}
              {state.manual ? (
                <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
                  <PenLine className="mt-0.5 size-3 shrink-0 text-amber-600" aria-hidden />
                  Click the template preview to place each icon slot. Place them in reading
                  order — top-left first. The canvas size was read from the file.
                </p>
              ) : null}

              {/* manual adjust controls */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={addMode === "slot" ? "default" : "outline"}
                  aria-pressed={addMode === "slot"}
                  className="h-7 gap-1.5 text-[11px]"
                  onClick={() => setAddMode((m) => (m === "slot" ? "off" : "slot"))}
                >
                  <SquarePlus className="size-3.5" aria-hidden />
                  {addMode === "slot" ? "Click preview to add…" : "Add slot"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={addMode === "hero" ? "default" : "outline"}
                  aria-pressed={addMode === "hero"}
                  className="h-7 gap-1.5 text-[11px]"
                  onClick={() => setAddMode((m) => (m === "hero" ? "off" : "hero"))}
                >
                  <Crown className="size-3.5" aria-hidden />
                  {addMode === "hero" ? "Click preview to place…" : "Place hero"}
                </Button>
                {manualCount > 0 ? (
                  <span className="text-[10px] text-muted-foreground">
                    {manualCount} manual slot{manualCount === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>

              {/* preview + slot toggles */}
              <div className="relative overflow-hidden rounded-lg border border-border bg-muted/30">
                <div
                  className={cn(
                    "template-preview-canvas relative [&>svg]:block [&>svg]:h-auto [&>svg]:w-full",
                    addMode !== "off" && "cursor-crosshair"
                  )}
                  aria-label="Template preview with detected slots"
                  onClick={onPreviewClick}
                >
                  <div dangerouslySetInnerHTML={{ __html: state.svgText }} />
                  {slots.map((slot, i) => {
                    const on = slot.selected;
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (slot.manual) {
                            /* manual slots: click removes, shift-click re-adds */
                            if (e.shiftKey) toggleSlot(i);
                            else removeSlot(i);
                          } else {
                            toggleSlot(i);
                          }
                        }}
                        aria-pressed={on}
                        aria-label={`Slot ${i + 1}${slot.manual ? " (manual)" : ""} — ${slot.manual ? (on ? "included, click to remove; hold Shift and click to exclude" : "excluded, click to include") : on ? "included, click to exclude" : "excluded, click to include"}`}
                        title={`Slot ${i + 1} · ${Math.round(slot.rect.width)}×${Math.round(slot.rect.height)}${slot.manual ? " · manual" : ""} — ${slot.manual ? "click to remove (shift-click to keep/exclude)" : `click to ${on ? "exclude" : "include"}`}`}
                        className={cn(
                          "absolute grid place-items-center rounded-[4px] border-2 text-[9px] font-bold transition-colors",
                          addMode !== "off" && "pointer-events-none",
                          on
                            ? "border-emerald-500 bg-emerald-500/25 text-emerald-700 dark:text-emerald-300 hover:bg-red-500/25 hover:border-red-400 hover:text-red-700 dark:hover:text-red-300"
                            : "border-muted-foreground/40 bg-muted/60 text-muted-foreground/70 hover:bg-emerald-500/25 hover:border-emerald-500 hover:text-emerald-700 dark:hover:text-emerald-300",
                          slot.manual && on && "border-dashed"
                        )}
                        style={{
                          left: `${((slot.rect.x - vbX) / vbW) * 100}%`,
                          top: `${((slot.rect.y - vbY) / vbH) * 100}%`,
                          width: `${(slot.rect.width / vbW) * 100}%`,
                          height: `${(slot.rect.height / vbH) * 100}%`,
                        }}
                      >
                        <span className="pointer-events-none drop-shadow-sm">{on ? i + 1 : ""}</span>
                      </button>
                    );
                  })}
                  {resolvedHeroRect ? (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute rounded-[4px] border-2 border-dashed border-amber-500 bg-amber-500/15"
                      style={{
                        left: `${((resolvedHeroRect.x - vbX) / vbW) * 100}%`,
                        top: `${((resolvedHeroRect.y - vbY) / vbH) * 100}%`,
                        width: `${(resolvedHeroRect.width / vbW) * 100}%`,
                        height: `${(resolvedHeroRect.height / vbH) * 100}%`,
                      }}
                    />
                  ) : null}
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Green boxes are the slots icons will fill. Click a slot to exclude or re-include
                it — the final capacity updates automatically. Missing one? “Add slot” then click
                where it belongs.
              </p>

              {/* hero selection */}
              {(analysis?.heroCandidates.length ?? 0) > 0 || manualHero ? (
                <div className="space-y-1.5">
                  <Label className="text-[11px] font-medium">Hero slot</Label>
                  <Select
                    value={heroChoice}
                    onValueChange={(v) => {
                      setHeroChoice(v);
                      setManualHero(null);
                      if (v === HERO_MANUAL) setAddMode("hero");
                      else setAddMode((m) => (m === "hero" ? "off" : m));
                    }}
                  >
                    <SelectTrigger size="sm" className="h-7 w-full text-[12px]" aria-label="Hero slot">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel className="text-[10px] text-muted-foreground">Detected</SelectLabel>
                        <SelectItem value="-1" className="text-[12px]">No hero slot</SelectItem>
                        {(analysis?.heroCandidates ?? []).map((c, i) => (
                          <SelectItem key={i} value={String(i)} className="text-[12px]">
                            {c.label}
                          </SelectItem>
                        ))}
                        <SelectLabel className="text-[10px] text-muted-foreground">Manual</SelectLabel>
                        <SelectItem value={HERO_MANUAL} className="text-[12px]">
                          Pick on template…
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground">
                    The hero icon of every sheet using this template lands in this slot.
                    {heroChoice === HERO_MANUAL && !manualHero
                      ? " Click the template preview to place it."
                      : ""}
                  </p>
                </div>
              ) : null}

              {/* text role mapping (universal editing) */}
              {!state.manual && (analysis?.texts ?? []).length > 0 ? (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <Type className="size-3.5 text-muted-foreground" aria-hidden />
                    <Label className="text-[11px] font-medium">Text mapping</Label>
                    <span className="text-[10px] text-muted-foreground">
                      {textRoles.filter((r) => r !== "none").length} of{" "}
                      {(analysis?.texts ?? []).length} mapped
                    </span>
                  </div>
                  <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-border/70 bg-muted/30 p-1.5 custom-scroll">
                    {(analysis?.texts ?? []).map((t, i) => (
                      <div key={i} className="flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors duration-150 hover:bg-muted/60">
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground"
                          title={t.snippet}
                        >
                          {t.snippet || "(empty text)"}
                        </span>
                        <span className="shrink-0 text-[9px] font-mono tabular-nums text-muted-foreground/70">
                          {t.fontSize ? Math.round(t.fontSize) : "?"}
                        </span>
                        <Select
                          value={textRoles[i] ?? "none"}
                          onValueChange={(v) => {
                            const role = v as CustomTextRole | "none";
                            setTextRoles((prev) => {
                              const next = [...prev];
                              /* one element per role — assigning an already-used
                               * role releases the previous holder */
                              if (role !== "none") {
                                for (let j = 0; j < next.length; j++) {
                                  if (j !== i && next[j] === role) next[j] = "none";
                                }
                              }
                              next[i] = role;
                              return next;
                            });
                          }}
                        >
                          <SelectTrigger
                            size="sm"
                            className="h-6 w-28 shrink-0 text-[10px]"
                            aria-label={`Role for text “${t.snippet.slice(0, 20)}”`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none" className="text-[11px]">Not editable</SelectItem>
                            <SelectItem value="category" className="text-[11px]">Category</SelectItem>
                            <SelectItem value="volume" className="text-[11px]">Volume</SelectItem>
                            <SelectItem value="caption" className="text-[11px]">Caption</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] leading-snug text-muted-foreground">
                    Mapped text becomes editable: sheets render their own category name,
                    VOL number and caption there (style editable in Properties). Unmapped
                    text stays exactly as drawn.
                  </p>
                </div>
              ) : null}

              {/* name */}
              <div className="space-y-1.5">
                <Label htmlFor="template-name" className="text-[11px] font-medium">Template name</Label>
                <Input
                  id="template-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Wide Grid 72"
                  className="h-8 text-[12px]"
                  maxLength={60}
                />
              </div>
            </div>
          ) : null}
        </div>

        {/* ---- footer ---- */}
        {reviewVisible ? (
          <DialogFooter className="studio-dlg-footer flex-row items-center justify-between gap-2 p-4">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 text-[12px]"
              onClick={() => inputRef.current?.click()}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Choose another file
            </Button>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-8 text-[12px]" onClick={close}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1.5 text-[12px]"
                disabled={enabledCount === 0 || !name.trim()}
                onClick={save}
              >
                <Save className="size-3.5" aria-hidden />
                Save template
                {enabledCount > 0 ? (
                  <Check className="size-3 text-primary-foreground/70" aria-hidden />
                ) : null}
              </Button>
            </div>
          </DialogFooter>
        ) : null}

        <input
          ref={inputRef}
          type="file"
          accept=".svg,image/svg+xml"
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (!file.name.toLowerCase().endsWith(".svg")) {
              toast.error("Please choose an SVG file");
              return;
            }
            void analyze(file);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
