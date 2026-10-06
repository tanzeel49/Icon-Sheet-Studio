"use client";

/**
 * ICON SHEET STUDIO — Properties panel (right sidebar).
 *
 * Editor for the ACTIVE sheet. Every mutation goes through
 * `useStudio.getState().updateSheetDesign(sheetId, label, updater)` (or a
 * dedicated store action) — never direct state mutation. Granular undo
 * labels ("design:card.color", "geometry:hero.x", …) let the store coalesce
 * history entries per control.
 */

import * as React from "react";
import type { JSX } from "react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Check,
  CopyCheck,
  Dices,
  FileUp,
  Library,
  MoreHorizontal,
  MousePointerClick,
  Paintbrush,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  BookmarkPlus,
  Layers,
  Tags,
  LayoutTemplate,
  FileCode2,
  Palette,
  Bookmark,
  PanelLeft,
  Type,
  Blend,
  Activity,
  Star,
  Zap,
  PenLine,
  History,
} from "lucide-react";

import { useActiveSheet, useStudio } from "@/lib/studio/store";
import { toast } from "sonner";
import { customRecordVersion, getTemplate, listTemplates, listOfficialTemplates, sheetTemplate } from "@/lib/studio/templates";
import { DESIGN_PRESETS } from "@/lib/studio/presets";
import { resolveRegion } from "@/lib/studio/renderer";
import { resolveCustomCapabilities, type CustomTemplateCapabilities } from "@/lib/studio/custom-template";
import { fitTitle } from "@/lib/studio/title-fit";
import { iconEmbedPlan, iconNativeVisualPx } from "@/lib/studio/icon-fit";
import {
  STROKE_WEIGHT_PX_MAX,
  STROKE_WEIGHT_PX_MIN,
  UNIFORM_TARGET_PX_MAX,
  UNIFORM_TARGET_PX_MIN,
  effectiveTintIcons,
  effectiveUniformStroke,
  effectiveUniformTargetPx,
  formatVolume,
  sheetTitle,
} from "@/lib/studio/types";
import type {
  CellOverride,
  CustomTemplateRecord,
  DesignPresetIncludes,
  Rect,
  RegionKey,
  Sheet,
  SheetDesign,
  TemplateDef,
  TextAlign,
  UserDesignPreset,
} from "@/lib/studio/types";
import {
  applyStrokeModel,
  displayStrokeWeightPx,
  legacyNormalizeEquivalentPx,
  representativeGridIconBox,
} from "@/lib/studio/stroke-migration";
import { heroEmbedBoxSize, styledIconPreviewSvg } from "@/lib/studio/icon-preview";
import { resolveHeroIconId } from "@/lib/studio/hero-fit";
import type { HeroDisplayMode } from "@/lib/studio/types";
import { CategoryAiControl, ResetVolumeButton } from "./category-ai";
import {
  ColorField,
  formatNumber,
  formatPercent,
  MultilineField,
  parsePercentText,
  Row,
  Section,
  SegmentedField,
  SelectField,
  SliderField,
  TextField,
  ToggleRow,
} from "./panel-kit";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Local types & constants                                             */
/* ------------------------------------------------------------------ */

type TextStyleKey = "category" | "volume" | "caption" | "footer";
type GeometryAxis = "x" | "y" | "width" | "height";

const TEXT_KEYS: { value: TextStyleKey; label: string }[] = [
  { value: "category", label: "Category" },
  { value: "volume", label: "Volume" },
  { value: "caption", label: "Caption" },
  { value: "footer", label: "Footer" },
];

const REGION_OPTIONS: { value: RegionKey; label: string }[] = [
  { value: "grid", label: "Grid" },
  { value: "hero", label: "Hero" },
  { value: "category", label: "Category" },
  { value: "volume", label: "Volume" },
  { value: "caption", label: "Caption" },
  { value: "footer", label: "Footer" },
];

/** Axis labels for the geometry editor; slider RANGES are computed per
 *  template at render time (default-sheet canvases run up to ~8000 wide). */
const GEOMETRY_AXIS_LABELS: { axis: GeometryAxis; label: string }[] = [
  { axis: "x", label: "X" },
  { axis: "y", label: "Y" },
  { axis: "width", label: "Width" },
  { axis: "height", label: "Height" },
];

const FONT_OPTIONS: { value: string; label: string }[] = [
  { value: "Arial, Helvetica, sans-serif", label: "Arial" },
  { value: "Helvetica, Arial, sans-serif", label: "Helvetica" },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia" },
  { value: "'Times New Roman', Times, serif", label: "Times New Roman" },
  { value: '"Courier New", Courier, monospace', label: "Courier New" },
  { value: "Verdana, Geneva, sans-serif", label: "Verdana" },
  { value: "'Trebuchet MS', sans-serif", label: "Trebuchet MS" },
  { value: "Impact, Haettenschweiler, sans-serif", label: "Impact" },
  { value: "'Comic Sans MS', cursive", label: "Comic Sans MS" },
  { value: "'Palatino Linotype', Book Antiqua, Palatino, serif", label: "Palatino" },
];

const SCROLLABLE_GRID =
  "max-h-96 overflow-y-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function useDesignUpdater(sheetId: string) {
  return React.useCallback(
    (label: string, updater: (design: SheetDesign) => void) => {
      useStudio.getState().updateSheetDesign(sheetId, label, updater);
    },
    [sheetId]
  );
}

/** Per-section "Reset to default" — restores ONLY this section's slice of
 *  the design from the owning template's defaults (one undo entry, never
 *  touches other sections, other sheets, icons or hero assignment).
 *  Round 24 · Quiet Precision: a quiet ghost text action — resets never
 *  render as full-width outlined rows. */
function ResetSectionButton({
  onClick,
  title,
  label = "Reset to default",
}: {
  onClick: () => void;
  title: string;
  label?: string;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 gap-1.5 rounded-lg px-2 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={onClick}
      title={title}
    >
      <RotateCcw className="size-3.5" aria-hidden />
      {label}
    </Button>
  );
}

/** Clear "this property is unavailable on this template" indication —
 *  used instead of controls that would pretend to work. */
function UnavailableNote({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
      <span className="mt-0.5 shrink-0 rounded bg-muted px-1 py-px font-mono text-[9px] uppercase tracking-wide text-muted-foreground">n/a</span>
      <span>{children}</span>
    </p>
  );
}

/** Centered micro-divider that labels a sub-group inside a section card
 *  (round 25 · Inspector v2 — replaces the bare pro-label captions). */
function SubHeader({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 pt-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {children}
      </span>
      <span className="h-px flex-1 bg-border/80" aria-hidden />
    </div>
  );
}

/** Tiny inline raw-SVG preview (source is immutable & validated on import). */
function RawIconPreview({ svg, className }: { svg: string; className?: string }) {
  return (
    <span
      className={cn("block text-foreground [&_svg]:h-full [&_svg]:w-full", className)}
      dangerouslySetInnerHTML={{ __html: svg }}
      aria-hidden
    />
  );
}

/** Sheet-styled icon preview — renders the icon EXACTLY as the sheet
 *  renders it (same stroke factor at the same real embed box, same tint /
 *  hero color override, same engine — icon-preview.ts). Falls back to the
 *  raw original when the source cannot be styled. The panel can now never
 *  show an icon that disagrees with the artwork on the sheet. */
function StyledIconPreview({
  svg,
  entryId,
  iconStyle,
  boxSize,
  colorOverride,
  cellOverride,
  size = 64,
  className,
}: {
  svg: string;
  entryId: string;
  iconStyle: SheetDesign["icon"];
  boxSize: number;
  colorOverride?: string | null;
  /** round 9: this icon's per-cell exception — resolved EXACTLY like the
   *  sheet renderer does (iconStyleForCell), so the preview can never
   *  disagree with the artwork on the sheet. */
  cellOverride?: CellOverride;
  size?: number;
  className?: string;
}) {
  const html = React.useMemo(() => {
    return styledIconPreviewSvg(
      { id: entryId, fileName: "", svg, createdAt: 0 },
      iconStyle,
      { boxSize, size, colorOverride: colorOverride ?? null, cellOverride }
    );
  }, [svg, entryId, iconStyle, boxSize, colorOverride, cellOverride, size]);
  return (
    <span
      className={cn("block text-foreground [&_svg]:h-full [&_svg]:w-full", className)}
      dangerouslySetInnerHTML={{ __html: html || svg }}
      aria-hidden
    />
  );
}

/* ------------------------------------------------------------------ */
/* Main panel                                                          */
/* ------------------------------------------------------------------ */

export function PropertiesPanel(): JSX.Element {
  const sheet = useActiveSheet();
  const sheetIndex = useStudio((s) =>
    s.activeSheetId ? s.sheets.findIndex((sh) => sh.id === s.activeSheetId) : -1
  );

  if (!sheet) {
    return (
      <div className="ip-panel grid h-full w-full place-items-center p-6">
        <div className="space-y-2.5 text-center">
          <div className="mx-auto grid size-10 place-items-center rounded-full bg-muted/70 text-muted-foreground">
            <MousePointerClick className="size-4" aria-hidden />
          </div>
          <p className="pro-help">Select a sheet to edit its design.</p>
        </div>
      </div>
    );
  }

  /* Universal editing (v3): EVERY section renders for every template —
   * controls that a template structurally lacks (custom template without
   * background / cells / mapped text / hero slot / rail) are replaced by a
   * clear "unavailable" note instead of being silently hidden or pretending
   * to work. Official templates render exactly as before. */
  const template = sheetTemplate(sheet);
  const caps = resolveCustomCapabilities(template);

  const capacity = template?.capacity ?? sheet.iconIds.length;
  const title = sheetTitle(sheet, Math.max(sheetIndex, 0));

  return (
    <div className="ip-panel flex h-full w-full flex-col" aria-label="Sheet properties">
      {/* round 25 · Inspector v2 — sticky sheet-identity header over the
       * deep tool surface; one floating card per section below. */}
      <div className="ip-head z-10 flex h-[54px] shrink-0 items-center gap-3 border-b border-border/80 px-4 backdrop-blur-sm">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold leading-tight text-foreground">{title}</p>
          <p className="truncate text-[10.5px] leading-tight text-muted-foreground">
            {sheet.category || "Uncategorized"} · {template?.name ?? "Template"} · {sheet.iconIds.length}/{capacity}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex h-6 shrink-0 items-center rounded-md border px-1.5 text-[10px] font-semibold tabular-nums",
            sheet.volumeManual === true
              ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
              : "border-border bg-muted/60 text-muted-foreground"
          )}
          title={
            sheet.volumeManual === true
              ? "Manual volume override — Reset volume restores the automatic number"
              : "Automatically numbered"
          }
        >
          {formatVolume(sheet.volume)}
        </span>
      </div>
      {/* The ONE vertical scroll owner of the inspector (layout contract:
       * .ip-panel is flex-col h-full; this child is flex-1 + min-h-0 so it
       * takes exactly the remaining panel height and scrolls vertically —
       * sections below fold into it, they never push the panel past the
       * viewport. overflow-x-hidden guarantees no horizontal scrollbar can
       * ever appear (overflow-y:auto alone would compute overflow-x:auto). */}
      <div className="custom-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="space-y-2.5 p-3 pb-10">
          <CategoryVolumeSection sheet={sheet} />
          <TemplateSection sheet={sheet} />
          <CustomTemplateSection sheet={sheet} />
          <DesignSection sheet={sheet} caps={caps} />
          <UserPresetsSection sheet={sheet} />
          <RailSection sheet={sheet} />
          <TypographySection sheet={sheet} caps={caps} />
          <AppearanceSection sheet={sheet} />
          <HeroSection sheet={sheet} caps={caps} />
          <ActionsSection sheet={sheet} sheetIndex={Math.max(sheetIndex, 0)} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 1 · Category & Volume                                               */
/* ------------------------------------------------------------------ */

/** Plain fallback if CategoryAiControl throws — category only, no auto-volume.
 *  Multiline: Enter creates a line break, blur commits, Esc restores. */
function CategoryFallbackInput({ sheet }: { sheet: Sheet }): JSX.Element {
  return (
    <MultilineField
      label="Category"
      value={sheet.category}
      rows={2}
      hint="Enter adds a line break · Esc restores"
      onCommit={(v) => useStudio.getState().setCategory(sheet.id, v, false)}
    />
  );
}

class CategoryControlBoundary extends React.Component<
  { sheet: Sheet; children: React.ReactNode },
  { failed: boolean }
> {
  constructor(props: { sheet: Sheet; children: React.ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("[properties-panel] CategoryAiControl failed, using fallback", error);
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return <CategoryFallbackInput sheet={this.props.sheet} />;
    }
    return this.props.children;
  }
}

function CategoryVolumeSection({ sheet }: { sheet: Sheet }): JSX.Element {
  /* sheet order can change (reorder/delete) — the placeholder must track
   * the sheet's CURRENT positional title */
  const sheetIndex = useStudio((s) => s.sheets.findIndex((sh) => sh.id === sheet.id));
  return (
    <Section
      title="Category & Volume"
      icon={<Tags className="size-3.5" />}
      badge={
        <Badge
          variant="outline"
          className={cn(
            "h-5 rounded-md px-1.5 text-[10px] font-medium tabular-nums",
            sheet.volumeManual === true
              ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
              : "bg-muted/60 text-muted-foreground"
          )}
          title={
            sheet.volumeManual === true
              ? "Manual volume override — Reset volume restores the automatic number"
              : "Automatically numbered"
          }
        >
          {formatVolume(sheet.volume)}
          {sheet.volumeManual === true ? " · manual" : ""}
        </Badge>
      }
    >
      <TextField
        label="Sheet name"
        value={sheet.name ?? ""}
        placeholder={sheetTitle(sheet, Math.max(sheetIndex, 0))}
        onChange={(v) => useStudio.getState().renameSheet(sheet.id, v)}
      />

      <CategoryControlBoundary sheet={sheet}>
        <CategoryAiControl sheetId={sheet.id} />
      </CategoryControlBoundary>

      {/* Dual-mode reset (shared with the card above): sheet-scoped when the
       * volume is a manual override (restores the automatic number), the
       * original category-wide counter reset otherwise. Round 24: related
       * resets group as quiet ghosts, right-aligned at the section end. */}
      <div className="flex items-center justify-end gap-1">
        <ResetVolumeButton sheetId={sheet.id} label="Reset volume" />
        <ResetSectionButton
          title="Restore this section’s defaults — sheet name, category “Icon Collection” and automatic volume VOL. 01 (undoable)"
          onClick={() => {
            useStudio.getState().renameSheet(sheet.id, "");
            useStudio.getState().setCategory(sheet.id, "Icon Collection", false);
            /* manual=false → VOL. 01 as a true AUTOMATIC default, not an
             * override that Reset Volume would later try to undo */
            useStudio.getState().setVolume(sheet.id, 1, false);
          }}
        />
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Template version notice (phase 3 — §49 explicit update)             */
/* ------------------------------------------------------------------ */

/** Shown when this sheet is pinned to an OLDER revision of its custom
 * template than the one currently in the library. Never updates
 * automatically: the user explicitly chooses “Update to latest” (with
 * the capacity consequence disclosed when the new version holds fewer
 * icons) or simply keeps the pinned version. */
function TemplateVersionNotice({ sheet, record }: { sheet: Sheet; record: CustomTemplateRecord }): JSX.Element | null {
  const updateSheetTemplateToLatest = useStudio((s) => s.updateSheetTemplateToLatest);
  const [confirm, setConfirm] = React.useState(false);
  const pinned = sheet.templateSnapshot?.version ?? 1;
  const live = customRecordVersion(record);
  if (live <= pinned) return null;
  const overflow = sheet.iconIds.length - record.capacity;
  const apply = (strategy: "move-next" | "create-new"): void => {
    const result = updateSheetTemplateToLatest(sheet.id, strategy);
    setConfirm(false);
    if (result.ok) {
      toast.success(`Updated “${record.name}” to v${live}`, {
        description:
          result.overflow && result.overflow > 0
            ? `${result.overflow} icon${result.overflow === 1 ? "" : "s"} moved to another sheet — nothing was deleted.`
            : undefined,
      });
    } else {
      toast.error("Could not update the template version");
    }
  };
  return (
    <>
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.07] p-3">
        <div className="flex items-start gap-2">
          <History className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-[11.5px] font-medium leading-snug text-foreground">
              “{record.name}” was updated — this sheet is on v{pinned}, the library is at v{live}.
            </p>
            <p className="text-[10.5px] leading-relaxed text-muted-foreground">
              {overflow > 0
                ? `The latest version holds ${record.capacity} icons — this sheet has ${sheet.iconIds.length}. Updating moves ${overflow} icon${overflow === 1 ? "" : "s"} to another sheet (never deleted).`
                : "Updating re-pins this sheet to the new layout. Icons, category, volume and hero keep their assignments."}
            </p>
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 border-amber-500/40 bg-amber-500/10 px-2.5 text-[11px] font-medium text-amber-700 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
                onClick={() => (overflow > 0 ? setConfirm(true) : apply("move-next"))}
              >
                Update to latest
              </Button>
              <span className="text-[10px] text-muted-foreground">or keep v{pinned} — nothing changes.</span>
            </div>
          </div>
        </div>
      </div>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent className="max-w-md p-5">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">Update “{record.name}” to v{live}?</AlertDialogTitle>
            <AlertDialogDescription className="text-[13px]">
              This sheet contains {sheet.iconIds.length} icons. The new template version holds {record.capacity} —
              {" "}{overflow} icon{overflow === 1 ? "" : "s"} will move to another sheet.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
            <AlertDialogAction className="h-8" onClick={() => apply("move-next")}>
              Move extra icons to next sheet
            </AlertDialogAction>
            <AlertDialogAction className="h-8" onClick={() => apply("create-new")}>
              Create a new sheet for extras
            </AlertDialogAction>
            <AlertDialogCancel className="h-8">Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function TemplateSection({ sheet }: { sheet: Sheet }): JSX.Element {
  const [geometryEdit, setGeometryEdit] = React.useState(false);
  const [region, setRegion] = React.useState<RegionKey>("grid");
  const [pending, setPending] = React.useState<TemplateDef | null>(null);
  /* phase 3 — deleting a template (even one in use) is a destructive,
   * confirm-guarded action from this dropdown too */
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(null);

  const template = sheetTemplate(sheet);
  /* subscribe to imported-template changes so the selector's Custom group
   * refreshes the moment a template is imported/renamed/deleted */
  const customTemplateRecords = useStudio((s) => s.customTemplates);
  /* the LIVE record for this sheet's template (may be absent when the
   * library record was deleted — the sheet then renders from its
   * snapshot and no version notice applies) */
  const liveRecord = customTemplateRecords.find((r) => r.id === sheet.templateId) ?? null;
  const isCustom = template?.sourceType === "custom";
  const sheets = useStudio((s) => s.sheets);
  const customTemplates = React.useMemo(
    () => listTemplates().filter((t) => t.sourceType === "custom"),
    [customTemplateRecords]
  );
  const sheetsUsingTemplate = (id: string) => sheets.filter((sh) => sh.templateId === id).length;
  const capacity = template?.capacity ?? sheet.iconIds.length;
  const resolved = template ? resolveRegion(template, sheet.design, region) : null;
  const hasOverride = sheet.design.geometryOverrides[region] !== undefined;
  const update = useDesignUpdater(sheet.id);
  const openTemplateImport = useStudio((s) => s.openTemplateImport);

  const handleTemplateChange = (templateId: string) => {
    if (templateId === sheet.templateId) return;
    const next = getTemplate(templateId);
    if (!next) return;
    if (sheet.iconIds.length <= next.capacity) {
      useStudio.getState().changeSheetTemplate(sheet.id, templateId, "move-next");
    } else {
      setPending(next);
    }
  };

  const applyPending = (strategy: "move-next" | "create-new") => {
    if (!pending) return;
    useStudio.getState().changeSheetTemplate(sheet.id, pending.id, strategy);
    setPending(null);
  };

  const setGeometry = (axis: GeometryAxis, value: number) => {
    update(`geometry:${region}.${axis}`, (design) => {
      design.geometryOverrides[region] = { ...design.geometryOverrides[region], [axis]: value };
    });
  };

  const resetRegion = () => {
    update(`geometry:${region}.reset`, (design) => {
      delete design.geometryOverrides[region];
    });
  };

  return (
    <Section
      title="Template"
      icon={<LayoutTemplate className="size-3.5" />}
      badge={
        <Badge variant="secondary" className="h-5 rounded-md px-1.5 text-[10px] font-medium tabular-nums">
          {sheet.iconIds.length}/{capacity}
        </Badge>
      }
    >
      <Row label="Template">
        {/* flex-1 min-w-0 on the select keeps the trailing icon buttons
         * (import / manage) fully inside the row at the narrowest panel
         * width (300px at the lg breakpoint) — the trigger truncates its
         * label instead of pushing the buttons out of the panel. */}
        <div className="flex items-center gap-1 min-w-0 w-full">
          <Select value={sheet.templateId} onValueChange={handleTemplateChange}>
            <SelectTrigger
              size="sm"
              className="h-9 min-w-0 flex-1 rounded-lg bg-card text-[12px] shadow-xs"
              aria-label="Sheet template"
              title={`Template: ${template?.name ?? ""} — ${template?.capacity ?? 0} cells`}
            >
              <SelectValue placeholder="Template" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel className="pro-label">Official</SelectLabel>
                {listOfficialTemplates().map((t) => (
                  /* round 22 · compact trigger: only the name rides in the
                   * trigger (ItemText); the capacity suffix renders in the
                     menu only — "50 Icon — 50 cells" used to truncate to
                   * "50 Icon — 5…" inside the narrow panel row. */
                  <SelectItem key={t.id} value={t.id} className="text-[11px]" menuLabel={`— ${t.capacity} cells`}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectGroup>
              {customTemplates.length > 0 ? (
                <SelectGroup>
                  <SelectLabel className="pro-label">Custom</SelectLabel>
                  {customTemplates.map((t) => (
                    <SelectItem key={t.id} value={t.id} className="text-[11px]" menuLabel={`— ${t.capacity} slots`}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-9 w-9 shrink-0 rounded-lg p-0"
            aria-label="Import a custom template SVG"
            title="Import Template SVG — any size, any grid, any number of cells"
            onClick={openTemplateImport}
          >
            <FileUp className="size-3.5" aria-hidden />
          </Button>
          {customTemplates.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 w-9 shrink-0 rounded-lg p-0"
                  aria-label="Manage custom templates"
                  title="Custom templates — rename, duplicate, delete"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 max-h-64 overflow-y-auto">
                <DropdownMenuLabel className="pro-label">Custom templates</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {customTemplates.map((t) => {
                  const usedBy = sheetsUsingTemplate(t.id);
                  return (
                    <DropdownMenuItem
                      key={t.id}
                      className="gap-2 text-[11px]"
                      title={
                        usedBy > 0
                          ? `Delete “${t.name}” — ${usedBy} sheet${usedBy === 1 ? "" : "s"} keep their layout via embedded snapshots`
                          : `Delete “${t.name}”`
                      }
                      onClick={() => setPendingDeleteId(t.id)}
                    >
                      <span className="min-w-0 flex-1 truncate">{t.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                        {usedBy > 0 ? `${usedBy} in use` : `${t.capacity}`}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </Row>

      {isCustom ? (
        <>
          <p className="pro-help">
            {customTemplateRecords.some((r) => r.id === sheet.templateId && r.builderDoc)
              ? "Builder-made template — the compiled layout is the visual master and stays fully editable in the Template Builder (Header → Template Library → Edit). Icon slots, the hero slot, background, grid cells and mapped text edit right here too."
              : "Imported template — the original SVG is the visual master. Editing applies to what it actually contains: icon slots, the hero slot, background, grid cells and mapped text. Sections it can’t support say so."}
          </p>
          {liveRecord ? <TemplateVersionNotice sheet={sheet} record={liveRecord} /> : null}
        </>
      ) : (
        <>
          <ToggleRow
            label="Edit template geometry"
            checked={geometryEdit}
            onChange={setGeometryEdit}
            hint="per sheet"
          />

      {geometryEdit && resolved ? (
        <div className="space-y-2.5 rounded-lg border border-border bg-muted/40 p-3">
          <Row label="Region">
            <Select value={region} onValueChange={(v) => setRegion(v as RegionKey)}>
              <SelectTrigger size="sm" className="h-9 w-full rounded-lg bg-card text-[12px] shadow-xs" aria-label="Geometry region">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REGION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value} className="text-[11px]">
                    {o.label}
                    {sheet.design.geometryOverrides[o.value] ? " ·" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          {template ? GEOMETRY_AXIS_LABELS.map(({ axis, label }) => (
            <SliderField
              key={axis}
              label={label}
              value={resolved[axis]}
              min={axis === "width" || axis === "height" ? 20 : 0}
              max={axis === "x" || axis === "width" ? template.width : template.height}
              step={Math.max(2, Math.round((axis === "x" || axis === "width" ? template.width : template.height) / 200))}
              onChange={(v) => setGeometry(axis, v)}
            />
          )) : null}

          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 rounded-lg px-2 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              disabled={!hasOverride}
              onClick={resetRegion}
              title="Remove this sheet's override — back to the template default"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Reset region
            </Button>
          </div>
          <p className="pro-help">
            {hasOverride ? "Region overridden for this sheet." : "Showing template defaults."}
          </p>
        </div>
      ) : null}

      <ResetSectionButton
        label="Reset geometry"
        title="Clear every geometry override on this sheet — all regions return to the template defaults (undoable)"
        onClick={() =>
          update("geometry:reset-all", (design) => {
            design.geometryOverrides = {};
          })
        }
      />
        </>
      )}

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent className="max-w-md p-5">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">Change template to {pending?.name}?</AlertDialogTitle>
            <AlertDialogDescription className="text-[13px]">
              This sheet contains {sheet.iconIds.length} icons. The new template supports {pending?.capacity}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
            <AlertDialogAction className="h-8" onClick={() => applyPending("move-next")}>
              Move extra icons to next sheet
            </AlertDialogAction>
            <AlertDialogAction className="h-8" onClick={() => applyPending("create-new")}>
              Create a new sheet for extras
            </AlertDialogAction>
            <AlertDialogCancel className="h-8">Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* phase 3 — delete confirm (delete-while-in-use is allowed: sheets
       * keep rendering from their embedded template snapshots) */}
      <AlertDialog open={pendingDeleteId !== null} onOpenChange={(open) => !open && setPendingDeleteId(null)}>
        <AlertDialogContent className="max-w-md p-5">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              Delete “{customTemplates.find((t) => t.id === pendingDeleteId)?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[13px]">
              {(() => {
                const usedBy = pendingDeleteId ? sheetsUsingTemplate(pendingDeleteId) : 0;
                return usedBy > 0
                  ? `${usedBy} sheet${usedBy === 1 ? "" : "s"} use this template — they keep their current layout via their embedded template snapshot and can be switched to another template any time.`
                  : "This template will be removed from your library.";
              })()}
              {" "}This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="h-8 bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (pendingDeleteId) useStudio.getState().deleteCustomTemplate(pendingDeleteId);
                setPendingDeleteId(null);
              }}
            >
              Delete template
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 2b · Custom template manager (rename / duplicate / delete)          */
/* ------------------------------------------------------------------ */

function CustomTemplateSection({ sheet }: { sheet: Sheet }): JSX.Element | null {
  const template = sheetTemplate(sheet);
  const custom = template?.custom;
  const [editing, setEditing] = React.useState(false);
  const [draftName, setDraftName] = React.useState(template?.name ?? "");
  React.useEffect(() => setDraftName(template?.name ?? ""), [template?.name]);
  const customTemplateRecords = useStudio((s) => s.customTemplates);
  if (template?.sourceType !== "custom" || !custom) return null;
  /* builder-made templates carry their authoring document — they can be
   * re-opened in the Template Builder (uploaded SVGs cannot) */
  const isBuilderMade = customTemplateRecords.some(
    (r) => r.id === template.id && r.builderDoc
  );

  const meta = custom.metadata;

  const commitRename = () => {
    if (draftName.trim() && draftName.trim() !== template.name) {
      useStudio.getState().renameCustomTemplate(template.id, draftName);
    }
    setEditing(false);
  };

  return (
    <Section
      title="Custom Template"
      icon={<FileCode2 className="size-3.5" />}
      badge={
        <Badge variant="outline" className="h-5 rounded-md bg-muted/60 px-1.5 text-[10px] font-medium text-muted-foreground">
          {isBuilderMade ? "builder-made" : "imported"}
        </Badge>
      }
    >
      {editing ? (
        <div className="flex items-center gap-1">
          <Input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setDraftName(template.name);
                setEditing(false);
              }
            }}
            autoFocus
            className="h-9 rounded-lg px-2.5 text-[12px]"
            aria-label="Template name"
            maxLength={60}
          />
          <Button variant="outline" size="sm" className="h-9 w-9 shrink-0 rounded-lg p-0" aria-label="Save name" onClick={commitRename}>
            <Check className="size-3.5" aria-hidden />
          </Button>
        </div>
      ) : (
        <Row label="Name">
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-[11px]" title={template.name}>
              {template.name}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-9 w-9 shrink-0 rounded-lg p-0"
              aria-label="Rename template"
              title="Rename this template"
              onClick={() => {
                setDraftName(template.name);
                setEditing(true);
              }}
            >
              <Pencil className="size-3.5" aria-hidden />
            </Button>
          </div>
        </Row>
      )}

      <div className="space-y-1 rounded-lg border border-border bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
        <p className="font-mono tabular-nums">
          Canvas {Math.round(template.width)} × {Math.round(template.height)}
          {custom.viewBox.startsWith("0 0") ? "" : " · offset viewBox"}
        </p>
        <p className="font-mono tabular-nums">
          {template.capacity} slots · {meta.gridDescription}
        </p>
        {custom.heroSlot ? <p>Hero slot detected · {Math.round(custom.heroSlot.width)}×{Math.round(custom.heroSlot.height)}</p> : null}
        {meta.spacing && (meta.spacing.h > 0 || meta.spacing.v > 0) ? (
          <p className="font-mono tabular-nums">
            gap {meta.spacing.h} × {meta.spacing.v}
            {meta.textElements ? ` · ${meta.textElements} text` : ""}
            {meta.background ? ` · background ${meta.background}` : ""}
          </p>
        ) : meta.textElements ? (
          <p className="font-mono tabular-nums">
            {meta.textElements} text element{meta.textElements === 1 ? "" : "s"}
            {meta.background ? ` · background ${meta.background}` : ""}
          </p>
        ) : meta.background ? (
          <p className="font-mono tabular-nums">background {meta.background}</p>
        ) : null}
        {!meta.autoDetected ? <p>Slots were marked manually</p> : null}
        {meta.fileName ? <p className="truncate" title={meta.fileName}>From {meta.fileName}</p> : null}
        <p>Imported {new Date(custom.createdAt).toLocaleDateString()}</p>
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-9 flex-1 gap-1.5 rounded-lg text-[12px]"
          onClick={() => useStudio.getState().duplicateCustomTemplate(template.id)}
          title="Duplicate this template (slots, hero, artwork)"
        >
          <CopyCheck className="size-3.5" aria-hidden />
          Duplicate
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-9 flex-1 gap-1.5 rounded-lg text-[12px] hover:text-red-600 hover:border-red-300"
              title="Delete this template (only when no sheets use it)"
            >
              <Trash2 className="size-3.5" aria-hidden />
              Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="max-w-sm p-5">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-base">Delete “{template.name}”?</AlertDialogTitle>
              <AlertDialogDescription className="text-[13px]">
                The imported template and its detected slots are removed from this workspace.
                Sheets using it must be switched or deleted first.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="h-8">Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="h-8 bg-red-600 hover:bg-red-700 text-white"
                onClick={() => useStudio.getState().deleteCustomTemplate(template.id)}
              >
                Delete template
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 3 · Design (background + grid cards + shadow)                       */
/* ------------------------------------------------------------------ */

/** Sensible default second gradient stop for a background color: a
 *  channel-wise luminance shift (lighter backgrounds get darker, dark
 *  ones get lighter) so the gradient is always visible on first toggle.
 *  Non-hex values (named colors) fall back to a fixed counterpart. */
function defaultGradientStop(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#0C1A38";
  const n = parseInt(m[1], 16);
  const shift = (c: number) => Math.min(255, Math.max(0, Math.round(c + (c < 128 ? 52 : -52))));
  const r = shift((n >> 16) & 255);
  const g = shift((n >> 8) & 255);
  const b = shift(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/** One-click gradient presets — curated pairs in the app's artwork language
 *  (light paper/sage/sand/blush + dark inks). Swatches show the actual
 *  CSS-rendered blend; applying one is a single undoable design patch. */
const BG_GRADIENT_PRESETS: { name: string; from: string; to: string; angle: number }[] = [
  { name: "Warm Horizon", from: "#F7F3EA", to: "#E9D6B8", angle: 90 },
  { name: "Morning Mist", from: "#F1F4F2", to: "#DCE6E0", angle: 90 },
  { name: "Sage Field", from: "#EDF3E9", to: "#CBE0C3", angle: 90 },
  { name: "Sand Drift", from: "#F3ECDD", to: "#E1CCAC", angle: 90 },
  { name: "Blush Veil", from: "#F9F0EC", to: "#EDD3C9", angle: 90 },
  { name: "Dusk Ink", from: "#1B1F26", to: "#303B49", angle: 90 },
  { name: "Midnight Steel", from: "#14161A", to: "#242B34", angle: 90 },
  { name: "Mono Fade", from: "#FFFFFF", to: "#EBEBEB", angle: 90 },
];

function DesignSection({ sheet, caps }: { sheet: Sheet; caps: CustomTemplateCapabilities }): JSX.Element {
  const d = sheet.design;
  const update = useDesignUpdater(sheet.id);
  const tpl = sheetTemplate(sheet);
  const isCustom = caps.isCustom;

  return (
    <Section
      title="Design"
      icon={<Palette className="size-3.5" />}
      badge={<span className="text-[10px] font-medium text-muted-foreground">presets</span>}
    >
      <div className="flex flex-wrap gap-1.5 pb-1">
        {DESIGN_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            title={`Apply the ${preset.name} theme to this sheet (colors, typography, card style — one undo step)`}
            aria-label={`Apply ${preset.name} design preset`}
            className="studio-preset-chip flex h-8 items-center gap-1.5 rounded-full border border-border bg-card pl-1 pr-2.5 text-[11px] font-medium text-muted-foreground shadow-xs transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 cursor-pointer"
            onClick={() =>
              update(`preset:${preset.id}`, (x) => {
                DESIGN_PRESETS.find((p) => p.id === preset.id)?.apply(x);
              })
            }
          >
            <span className="flex items-center -space-x-1" aria-hidden>
              {preset.swatch.map((c, i) => (
                <span
                  key={i}
                  className="h-3.5 w-3.5 rounded-full border border-border/80 shadow-sm"
                  style={{ background: c }}
                />
              ))}
            </span>
            {preset.name}
          </button>
        ))}
      </div>
      {isCustom ? (
        <p className="pro-help">
          Imported template — themes restyle what it actually contains (background,
          cells, mapped text, icon tint). Parts it can&apos;t show are skipped.
        </p>
      ) : null}

      {caps.background ? (
        <div className="space-y-2.5">
          <ToggleRow
            label="Background"
            tooltip="Show or hide the sheet background — hidden means the sheet renders and exports fully transparent."
            checked={d.backgroundVisible !== false}
            onChange={(v) => update("design:backgroundVisible", (x) => { x.backgroundVisible = v; })}
          />
          {d.backgroundVisible === false ? (
            <p className="pro-help">
              Background off — the sheet renders (and exports) without its
              background, fully transparent.
            </p>
          ) : (
            <>
              <ColorField
                label="Background color"
                value={d.background}
                onChange={(v) => update("design:background", (x) => { x.background = v; })}
              />
              {!isCustom ? (
                <>
                  <ToggleRow
                    label="Background gradient"
                    checked={!!d.bgGradient}
                    onChange={(v) =>
                      update("design:bgGradient", (x) => {
                        x.bgGradient = v
                          ? { from: x.background, to: x.bgGradient?.to ?? defaultGradientStop(x.background), angle: x.bgGradient?.angle ?? 90 }
                          : null;
                      })
                    }
                  />
                  {d.bgGradient ? (
                    <div className="space-y-2.5 rounded-lg border border-border bg-muted/40 p-3">
                      {/* live preview — CSS angle = SVG angle + 90° (CSS 0°
                        * points up, SVG 0° points right) so the swatch matches
                        * the artwork orientation */}
                      <div
                        className="h-7 rounded-lg border border-border/70 shadow-inner"
                        style={{
                          background: `linear-gradient(${Math.round(d.bgGradient.angle + 90)}deg, ${d.bgGradient.from}, ${d.bgGradient.to})`,
                        }}
                        role="img"
                        aria-label="Background gradient preview"
                        title="Live gradient preview — exactly what the sheet background will render"
                      />
                      {/* one-click preset swatches — each renders the actual blend */}
                      <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Background gradient presets">
                        {BG_GRADIENT_PRESETS.map((p) => {
                          const active =
                            d.bgGradient!.from.toLowerCase() === p.from.toLowerCase() &&
                            d.bgGradient!.to.toLowerCase() === p.to.toLowerCase();
                          return (
                            <button
                              key={p.name}
                              type="button"
                              aria-label={`Apply the ${p.name} gradient`}
                              aria-pressed={active}
                              title={`${p.name} — ${p.from} → ${p.to}`}
                              className={cn(
                                "h-6 rounded-lg border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer",
                                active
                                  ? "border-amber-500 ring-2 ring-amber-500/30"
                                  : "border-border hover:border-foreground/35"
                              )}
                              style={{
                                background: `linear-gradient(${p.angle + 90}deg, ${p.from}, ${p.to})`,
                              }}
                              onClick={() =>
                                update("design:bgGradient.preset", (x) => {
                                  if (!x.bgGradient) x.bgGradient = { from: p.from, to: p.to, angle: p.angle };
                                  else {
                                    x.bgGradient.from = p.from;
                                    x.bgGradient.to = p.to;
                                    x.bgGradient.angle = p.angle;
                                  }
                                })
                              }
                            />
                          );
                        })}
                      </div>
                      <ColorField
                        label="Gradient start"
                        value={d.bgGradient.from}
                        onChange={(v) => update("design:bgGradient.from", (x) => { if (x.bgGradient) x.bgGradient.from = v; })}
                      />
                      <ColorField
                        label="Gradient end"
                        value={d.bgGradient.to}
                        onChange={(v) => update("design:bgGradient.to", (x) => { if (x.bgGradient) x.bgGradient.to = v; })}
                      />
                      <SliderField
                        label="Gradient angle"
                        value={d.bgGradient.angle}
                        min={-180}
                        max={180}
                        step={1}
                        format={(v) => `${formatNumber(v, 1)}°`}
                        onChange={(v) => update("design:bgGradient.angle", (x) => { if (x.bgGradient) x.bgGradient.angle = v; })}
                      />
                    </div>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </div>
      ) : (
        <UnavailableNote>
          No background element was detected in this template — the background
          color doesn&apos;t apply to imported artwork.
        </UnavailableNote>
      )}

      <div className="pt-1">
        <SubHeader>Grid cards</SubHeader>
        {caps.cells === 0 ? (
          <UnavailableNote>
            No grid-cell shapes were detected — card styling has nothing to edit
            on this template. Icons still fill the detected slots.
          </UnavailableNote>
        ) : (
          <div className="space-y-2.5">
            <ToggleRow
              label="Card visibility"
              checked={d.card.visible}
              onChange={(v) => update("design:card.visible", (x) => { x.card.visible = v; })}
            />
            <ColorField
              label="Card color"
              value={d.card.color}
              onChange={(v) => update("design:card.color", (x) => { x.card.color = v; })}
            />
            <SliderField
              label="Opacity"
              value={d.card.opacity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => update("design:card.opacity", (x) => { x.card.opacity = v; })}
            />
            <SliderField
              label="Border width"
              value={d.card.borderWidth}
              min={0}
              max={8}
              step={1}
              onChange={(v) => update("design:card.borderWidth", (x) => { x.card.borderWidth = v; })}
            />
            <ColorField
              label="Border color"
              value={d.card.borderColor}
              onChange={(v) => update("design:card.borderColor", (x) => { x.card.borderColor = v; })}
            />
            {!isCustom ? (
              <>
                <SliderField
                  label="Radius"
                  value={d.card.radius}
                  min={0}
                  max={60}
                  step={1}
                  onChange={(v) => update("design:card.radius", (x) => { x.card.radius = v; })}
                />
                <SliderField
                  label="Cell padding"
                  value={d.spacing.cellPadding}
                  min={0}
                  max={0.4}
                  step={0.01}
                  onChange={(v) => update("design:spacing.cellPadding", (x) => { x.spacing.cellPadding = v; })}
                />
                <SliderField
                  label="Grid gap"
                  value={d.spacing.gap}
                  min={0}
                  max={60}
                  step={1}
                  onChange={(v) => update("design:spacing.gap", (x) => { x.spacing.gap = v; })}
                />
              </>
            ) : (
              <p className="pro-help">
                Cards are this template&apos;s own cell shapes — radius, padding, gap,
                shadows and gradients don&apos;t apply (the layout is fixed by the SVG).
              </p>
            )}
            <SliderField
              label="Icon scale"
              value={d.spacing.iconScale ?? 0.86}
              min={0.3}
              max={1}
              step={0.01}
              format={formatPercent}
              parse={parsePercentText}
              onChange={(v) => update("design:spacing.iconScale", (x) => { x.spacing.iconScale = v; })}
            />
            {!isCustom ? (
              <>
                <ToggleRow
                  label="Show empty cells"
                  checked={Boolean(d.card.showEmptyCells)}
                  hint="full frame"
                  onChange={(v) => update("design:card.showEmptyCells", (x) => { x.card.showEmptyCells = v; })}
                />
                <ToggleRow
                  label="Gradient fill"
                  checked={Boolean(d.card.gradient)}
                  hint="per cell"
                  onChange={(v) =>
                    update("design:card.gradient", (x) => {
                      x.card.gradient = v
                        ? { from: x.card.color, to: x.card.gradient?.to ?? "#0C1A38", angle: x.card.gradient?.angle ?? 0 }
                        : null;
                    })
                  }
                />
                {d.card.gradient ? (
                  <div className="space-y-2.5 rounded-lg border border-border bg-muted/40 p-3">
                    <ColorField
                      label="Gradient from"
                      value={d.card.gradient.from}
                      onChange={(v) => update("design:card.gradient.from", (x) => { if (x.card.gradient) x.card.gradient.from = v; })}
                    />
                    <ColorField
                      label="Gradient to"
                      value={d.card.gradient.to}
                      onChange={(v) => update("design:card.gradient.to", (x) => { if (x.card.gradient) x.card.gradient.to = v; })}
                    />
                    <SliderField
                      label="Gradient angle"
                      value={d.card.gradient.angle}
                      min={-180}
                      max={180}
                      step={1}
                      format={(v) => `${formatNumber(v, 1)}°`}
                      onChange={(v) => update("design:card.gradient.angle", (x) => { if (x.card.gradient) x.card.gradient.angle = v; })}
                    />
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        )}
      </div>

      {!isCustom ? (
        <div className="pt-1">
          <ToggleRow
            label="Shadow"
            checked={d.card.shadow}
            onChange={(v) => update("design:card.shadow", (x) => { x.card.shadow = v; })}
          />
          {d.card.shadow ? (
            <div className="mt-2.5 space-y-2.5 rounded-lg border border-border bg-muted/40 p-3">
              <SliderField
                label="Strength"
                value={d.card.shadowStrength}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => update("design:card.shadowStrength", (x) => { x.card.shadowStrength = v; })}
              />
              <SliderField
                label="Blur"
                value={d.card.shadowBlur}
                min={0}
                max={60}
                step={1}
                onChange={(v) => update("design:card.shadowBlur", (x) => { x.card.shadowBlur = v; })}
              />
              <SliderField
                label="Shadow X"
                value={d.card.shadowX}
                min={-40}
                max={40}
                step={1}
                onChange={(v) => update("design:card.shadowX", (x) => { x.card.shadowX = v; })}
              />
              <SliderField
                label="Shadow Y"
                value={d.card.shadowY}
                min={-40}
                max={40}
                step={1}
                onChange={(v) => update("design:card.shadowY", (x) => { x.card.shadowY = v; })}
              />
              <ColorField
                label="Shadow color"
                value={d.card.shadowColor}
                onChange={(v) => update("design:card.shadowColor", (x) => { x.card.shadowColor = v; })}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <ResetSectionButton
        title="Restore this section’s defaults — background, grid cards, cell padding, gap and icon scale (undoable). Typography, rail and hero keep their current settings."
        onClick={() => {
          if (!tpl) return;
          update("design:reset-section", (x) => {
            const fresh = structuredClone(tpl.defaults);
            x.background = fresh.background;
            x.backgroundVisible = fresh.backgroundVisible;
            x.card = fresh.card;
            x.spacing = fresh.spacing;
          });
        }}
      />
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 3b · My Presets (user-saved design snapshots)                       */
/* ------------------------------------------------------------------ */

const PRESET_GROUPS: Array<{ key: keyof DesignPresetIncludes; label: string; hint: string }> = [
  { key: "typography", label: "Typography", hint: "fonts, sizes, weights, colors + caption/footer text" },
  { key: "colors", label: "Colors", hint: "background, grid cards, rail paint" },
  { key: "appearance", label: "Icons & stroke", hint: "stroke weight, tint" },
  { key: "hero", label: "Hero", hint: "scale, offsets, card style — never the hero icon itself" },
  { key: "layout", label: "Layout", hint: "icon scale, cell padding, grid gap" },
];

function presetSwatches(preset: UserDesignPreset): string[] {
  const d = preset.data;
  return [
    d.background ?? "transparent",
    d.card?.color ?? "transparent",
    d.typography?.category?.color ?? "transparent",
  ];
}

function UserPresetsSection({ sheet }: { sheet: Sheet }): JSX.Element {
  const presets = useStudio((s) => s.designPresets);
  const sheets = useStudio((s) => s.sheets);
  const selectedSheetIds = useStudio((s) => s.selectedSheetIds);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [presetName, setPresetName] = React.useState("");
  const [includes, setIncludes] = React.useState<DesignPresetIncludes>({
    typography: true,
    colors: true,
    appearance: true,
    hero: true,
    layout: true,
  });
  const [renameTarget, setRenameTarget] = React.useState<UserDesignPreset | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [deleteTarget, setDeleteTarget] = React.useState<UserDesignPreset | null>(null);

  const otherIds = sheets.filter((s) => s.id !== sheet.id).map((s) => s.id);
  const selectedTargets = selectedSheetIds.filter((id) => id !== sheet.id);

  const openSaveDialog = () => {
    setPresetName(`${sheet.category} look`.trim());
    setIncludes({ typography: true, colors: true, appearance: true, hero: true, layout: true });
    setSaveOpen(true);
  };

  const savePreset = () => {
    if (!presetName.trim()) return;
    useStudio.getState().saveDesignPreset(sheet.id, presetName, includes);
    setSaveOpen(false);
  };

  const anyInclude = Object.values(includes).some(Boolean);

  return (
    <Section
      title="My Presets"
      icon={<Bookmark className="size-3.5" />}
      badge={
        <span className="text-[10px] font-medium text-muted-foreground">
          {presets.length > 0 ? `${presets.length} saved` : "reusable"}
        </span>
      }
    >
      <Button
        variant="outline"
        size="sm"
        className="h-9 w-full gap-1.5 rounded-lg text-[12px]"
        onClick={openSaveDialog}
        title="Save this sheet's current customization (typography, colors, appearance, hero, layout) as a named preset"
      >
        <BookmarkPlus className="size-3.5" aria-hidden />
        Save current design as preset…
      </Button>

      {presets.length === 0 ? (
        <p className="pro-help">
          Presets capture this sheet&apos;s typography, colors, appearance, hero and
          layout settings under a name. Apply one to any sheet later — icons,
          category, volume, template and icon assignments are never replaced.
        </p>
      ) : (
        <div className={cn("space-y-2", SCROLLABLE_GRID)}>
          {presets.map((preset) => {
            const groups = PRESET_GROUPS.filter((g) => preset.includes[g.key]).map((g) => g.label);
            return (
              <div key={preset.id} className="space-y-2 rounded-lg border border-border bg-muted/40 p-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="flex shrink-0 items-center -space-x-1" aria-hidden>
                    {presetSwatches(preset).map((c, i) => (
                      <span
                        key={i}
                        className="h-3.5 w-3.5 rounded-full border border-border/80 shadow-sm"
                        style={{ background: c === "transparent" ? "transparent" : c }}
                        title={c}
                      />
                    ))}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium" title={preset.name}>
                    {preset.name}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 shrink-0 rounded-md p-0"
                        aria-label={`Preset “${preset.name}” actions`}
                      >
                        <MoreHorizontal className="size-3.5" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuItem
                        className="gap-2 text-[11px]"
                        onClick={() => useStudio.getState().applyDesignPreset(preset.id, sheet.id)}
                      >
                        <Check className="size-3.5" aria-hidden />
                        Apply to this sheet
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="gap-2 text-[11px]"
                        disabled={selectedTargets.length === 0}
                        title={
                          selectedTargets.length === 0
                            ? "Select sheets in the sheet list first"
                            : `Apply to ${selectedTargets.length} selected sheets`
                        }
                        onClick={() => useStudio.getState().applyDesignPresetToSheets(preset.id, selectedTargets)}
                      >
                        <Layers className="size-3.5" aria-hidden />
                        Apply to selected ({selectedTargets.length})
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="gap-2 text-[11px]"
                        disabled={otherIds.length === 0}
                        onClick={() => useStudio.getState().applyDesignPresetToSheets(preset.id, otherIds)}
                      >
                        <Paintbrush className="size-3.5" aria-hidden />
                        Apply to all other sheets
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="gap-2 text-[11px]"
                        onClick={() => {
                          setRenameTarget(preset);
                          setRenameValue(preset.name);
                        }}
                      >
                        <Pencil className="size-3.5" aria-hidden />
                        Rename…
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="gap-2 text-[11px] text-destructive focus:text-destructive"
                        onClick={() => setDeleteTarget(preset)}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                        Delete…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 flex-1 gap-1.5 rounded-lg text-[12px]"
                    onClick={() => useStudio.getState().applyDesignPreset(preset.id, sheet.id)}
                    title={`Apply “${preset.name}” to this sheet — icons, category and volume are never touched`}
                  >
                    Apply to this sheet
                  </Button>
                </div>
                <p className="pro-help" title={groups.join(", ")}>
                  {groups.length ? groups.join(" · ") : "empty preset"}
                  {` · ${new Date(preset.createdAt).toLocaleDateString()}`}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {/* ---- save dialog ---- */}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Save design preset</DialogTitle>
            <DialogDescription className="text-xs">
              Captures this sheet&apos;s current customization. Applying a preset
              never replaces a sheet&apos;s icons, category, volume, template or
              icon assignments — it restyles the design only.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2.5">
            <Input
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="e.g. Warm Poster"
              className="h-8 text-[12px]"
              maxLength={60}
              autoFocus
              aria-label="Preset name"
              onKeyDown={(e) => {
                if (e.key === "Enter" && anyInclude) savePreset();
              }}
            />
          </div>
          <div className="space-y-2.5">
            <p className="pro-label">
              Include
            </p>
            {PRESET_GROUPS.map((g) => (
              <label
                key={g.key}
                className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 hover:bg-muted/50"
                title={g.hint}
              >
                <Checkbox
                  checked={includes[g.key]}
                  onCheckedChange={(v) =>
                    setIncludes((prev) => ({ ...prev, [g.key]: v === true }))
                  }
                  className="mt-0.5"
                  aria-label={g.label}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-medium leading-tight">{g.label}</span>
                  <span className="pro-help block">{g.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="pro-help">
            Cross-template safe: when a target sheet&apos;s template lacks a property
            (rail, mapped text, hero slot…), only that property is skipped.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" className="h-8 gap-1.5 text-[12px]" disabled={!presetName.trim() || !anyInclude} onClick={savePreset}>
              <BookmarkPlus className="size-3.5" aria-hidden />
              Save preset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- rename dialog ---- */}
      <Dialog open={renameTarget !== null} onOpenChange={(o) => { if (!o) setRenameTarget(null); }}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-base">Rename preset</DialogTitle>
            <DialogDescription className="text-xs">
              Enter a new name for this design preset.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            className="h-8 text-[12px]"
            maxLength={60}
            autoFocus
            aria-label="New preset name"
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameTarget && renameValue.trim()) {
                useStudio.getState().renameDesignPreset(renameTarget.id, renameValue);
                setRenameTarget(null);
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-8 text-[12px]"
              disabled={!renameValue.trim()}
              onClick={() => {
                if (renameTarget && renameValue.trim()) {
                  useStudio.getState().renameDesignPreset(renameTarget.id, renameValue);
                }
                setRenameTarget(null);
              }}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- delete confirm ---- */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent className="max-w-sm p-5">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription className="text-[13px]">
              The preset is removed from your saved presets. Sheets that already use
              its look keep their current design.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="h-8 bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) useStudio.getState().deleteDesignPreset(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Delete preset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 4 · Typography                                                      */
/* ------------------------------------------------------------------ */

function RailSection({ sheet }: { sheet: Sheet }): JSX.Element {
  const update = useDesignUpdater(sheet.id);
  const d = sheet.design;
  const r = d.rail;
  const template = sheetTemplate(sheet);
  /* sheets migrated before rails (or custom designs without one) still get
   * the section with the template's default paint as the starting point */
  const effective = r ?? template?.rail?.defaults;

  if (!effective) {
    return (
      <Section title="Left Rail" icon={<PanelLeft className="size-3.5" />}>
        <p className="pro-help">This template has no rail.</p>
      </Section>
    );
  }

  return (
    <Section
      title="Left Rail"
      icon={<PanelLeft className="size-3.5" />}
      badge={<span className="text-[10px] font-medium text-muted-foreground">default sheets</span>}
    >
      <ToggleRow
        label="Rail visible"
        checked={r ? r.visible : true}
        onChange={(v) =>
          update("design:rail.visible", (x) => {
            x.rail = x.rail ?? structuredClone(effective);
            x.rail.visible = v;
          })
        }
      />
      {r?.visible !== false ? (
        <div className="space-y-2.5">
          <ColorField
            label="Rail gradient from"
            value={r?.from ?? effective.from}
            onChange={(v) => update("design:rail.from", (x) => { x.rail = x.rail ?? structuredClone(effective); x.rail.from = v; })}
          />
          <ColorField
            label="Rail gradient to"
            value={r?.to ?? effective.to}
            onChange={(v) => update("design:rail.to", (x) => { x.rail = x.rail ?? structuredClone(effective); x.rail.to = v; })}
          />
          <SliderField
            label="Rail gradient angle"
            value={r?.angle ?? effective.angle}
            min={-180}
            max={180}
            step={1}
            format={(v) => `${formatNumber(v, 1)}°`}
            onChange={(v) => update("design:rail.angle", (x) => { x.rail = x.rail ?? structuredClone(effective); x.rail.angle = v; })}
          />

          <div className="pt-1">
            <ToggleRow
              label="VOL ribbon"
              checked={r ? r.ribbon.visible : true}
              onChange={(v) =>
                update("design:rail.ribbon.visible", (x) => {
                  x.rail = x.rail ?? structuredClone(effective);
                  x.rail.ribbon.visible = v;
                })
              }
            />
            {r?.ribbon.visible !== false ? (
              <div className="mt-2.5 space-y-2.5 rounded-lg border border-border bg-muted/40 p-3">
                <ColorField
                  label="Ribbon from"
                  value={r?.ribbon.from ?? effective.ribbon.from}
                  onChange={(v) => update("design:rail.ribbon.from", (x) => { x.rail = x.rail ?? structuredClone(effective); x.rail.ribbon.from = v; })}
                />
                <ColorField
                  label="Ribbon to"
                  value={r?.ribbon.to ?? effective.ribbon.to}
                  onChange={(v) => update("design:rail.ribbon.to", (x) => { x.rail = x.rail ?? structuredClone(effective); x.rail.ribbon.to = v; })}
                />
              </div>
            ) : null}
          </div>

          <div className="pt-1">
            <ToggleRow
              label="Format pills"
              checked={r ? r.pills.visible : true}
              onChange={(v) =>
                update("design:rail.pills.visible", (x) => {
                  x.rail = x.rail ?? structuredClone(effective);
                  x.rail.pills.visible = v;
                })
              }
            />
            {r?.pills.visible !== false ? (
              <div className="mt-2.5 space-y-2.5 rounded-lg border border-border bg-muted/40 p-3">
                <ColorField
                  label="Pill color"
                  value={r?.pills.color ?? effective.pills.color}
                  onChange={(v) => update("design:rail.pills.color", (x) => { x.rail = x.rail ?? structuredClone(effective); x.rail.pills.color = v; })}
                />
                <ColorField
                  label="Pill label color"
                  value={r?.pills.labelColor ?? effective.pills.labelColor}
                  onChange={(v) => update("design:rail.pills.labelColor", (x) => { x.rail = x.rail ?? structuredClone(effective); x.rail.pills.labelColor = v; })}
                />
                <TextField
                  label="Pill labels"
                  value={(r?.pills.labels ?? effective.pills.labels).join(", ")}
                  placeholder="AI, SVG, EPS, PNG"
                  onChange={(v) =>
                    update("design:rail.pills.labels", (x) => {
                      x.rail = x.rail ?? structuredClone(effective);
                      x.rail.pills.labels = v
                        .split(",")
                        .map((l) => l.trim().slice(0, 12))
                        .filter(Boolean)
                        .slice(0, 6);
                    })
                  }
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <ResetSectionButton
        title="Restore this section’s defaults — rail gradient, VOL ribbon and format pills from the template (undoable)"
        onClick={() => {
          if (!template?.rail) return;
          update("design:rail.reset", (x) => {
            x.rail = structuredClone(template.rail!.defaults);
          });
        }}
      />
    </Section>
  );
}

function TypographySection({ sheet, caps }: { sheet: Sheet; caps: CustomTemplateCapabilities }): JSX.Element {
  const [key, setKey] = React.useState<TextStyleKey>("category");
  const template = sheetTemplate(sheet);
  const style = sheet.design.typography[key];
  const update = useDesignUpdater(sheet.id);
  const label = `design:typography.${key}`;
  /* custom templates: text styles apply only to text elements the import
   * mapped to a role (unavailable tabs are disabled + explained) */
  const textAvailable: Record<TextStyleKey, boolean> = {
    category: caps.text.category,
    volume: caps.text.volume,
    caption: caps.text.caption,
    footer: caps.text.footer,
  };
  const keyAvailable = textAvailable[key];

  /* round 17 — SMART AUTO-FIT (title/category only). The panel computes
   * the SAME fit the renderer draws (shared, memoized engine) so the
   * toggle's hint and the Size control show the live auto size. Custom
   * templates fit inside the DETECTED title-text rect (the template's own
   * geometry); official templates fit the category region (with any
   * geometry overrides applied). */
  const autoFitOn = key === "category" && style.autoFit !== false;
  const autoFitRegion: Rect | null =
    key === "category"
      ? caps.isCustom
        ? (template?.custom?.roles?.text.category?.rect ?? null)
        : template
          ? resolveRegion(template, sheet.design, "category")
          : null
      : null;
  const autoFit =
    autoFitOn && autoFitRegion ? fitTitle(sheet.category, autoFitRegion, style) : null;
  const autoFitPx = autoFit?.fitted ? Math.round(autoFit.fontSize) : null;
  const autoFitLineCount = autoFit?.fitted ? autoFit.lines.length : null;
  /** the size the control shows: the fitted size when active, otherwise
   *  the sheet's manual size (also the safe fallback when no fit exists). */
  const displaySize = autoFitOn && autoFit?.fitted ? autoFit.fontSize : style.fontSize;

  const fontOptions = FONT_OPTIONS.some((o) => o.value === style.fontFamily)
    ? FONT_OPTIONS
    : [{ value: style.fontFamily, label: "Custom font" }, ...FONT_OPTIONS];

  const autoFooter = `Auto: ${template?.capacity ?? 0} ICONS · ${template?.width ?? 1200} × ${
    template?.height ?? 1500
  } · SVG VECTOR`;

  return (
    <Section
      title="Typography"
      icon={<Type className="size-3.5" />}
      badge={<span className="text-[10px] font-medium capitalize text-muted-foreground">{key}</span>}
    >
      <ToggleGroup
        type="single"
        value={key}
        onValueChange={(v) => {
          if (v) setKey(v as TextStyleKey);
        }}
        className="flex h-9 w-full items-center gap-0.5 rounded-lg border border-input bg-card p-0.5 shadow-xs"
        aria-label="Text style target"
      >
        {TEXT_KEYS.map((o) => (
          <ToggleGroupItem
            key={o.value}
            value={o.value}
            className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-1 text-[11px] font-medium text-muted-foreground shadow-none transition-colors hover:bg-muted/70 hover:text-foreground data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:shadow-xs"
            disabled={caps.isCustom && !textAvailable[o.value]}
            title={
              caps.isCustom && !textAvailable[o.value]
                ? `This template has no detected ${o.label} text — not editable`
                : `Edit the ${o.label} text style`
            }
          >
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {caps.isCustom && !keyAvailable ? (
        <UnavailableNote>
          This template has no detected {key} text element. Import it again and map
          a text element to “{key}” to make it editable — everything else keeps
          working.
        </UnavailableNote>
      ) : (
        <>
          {caps.isCustom ? (
            <p className="pro-help">
              Edits restyle the template&apos;s own {key} text in place — its position
              stays exactly where the SVG put it.
            </p>
          ) : null}
          {/* round 24 — visibility master switch: hides the whole block from
              preview AND export (no <text> nodes; custom templates hide the
              mapped element via display:none). Ships hidden on templates
              designed without that label (e.g. Design Warsa Temp has no VOL
              stamp). */}
          <ToggleRow
            label="Visible"
            tooltip="Master switch — hide this text block from the sheet entirely (preview and export)."
            checked={style.visible !== false}
            onChange={(v) => update(`${label}.visible`, (x) => { x.typography[key].visible = v; })}
            hint={style.visible !== false ? undefined : "hidden — nothing renders"}
          />
          <SelectField
            label="Font family"
            value={style.fontFamily}
            options={fontOptions}
            onChange={(v) => update(`${label}.fontFamily`, (x) => { x.typography[key].fontFamily = v; })}
          />
          {key === "category" ? (
            <ToggleRow
              label="Auto fit"
              tooltip="Automatically fit the title inside its safe area — size and line breaks adapt to the text."
              checked={autoFitOn}
              onChange={(v) => update(`${label}.autoFit`, (x) => { x.typography[key].autoFit = v; })}
              hint={
                autoFitOn
                  ? autoFitPx != null && autoFitLineCount != null
                    ? `auto · ${autoFitPx} px · ${autoFitLineCount} line${autoFitLineCount === 1 ? "" : "s"}`
                    : "auto"
                  : "off — size is manual"
              }
            />
          ) : null}
          <SliderField
            label="Size"
            value={autoFitOn ? displaySize : style.fontSize}
            min={autoFitOn ? Math.min(8, displaySize) : 8}
            max={autoFitOn ? Math.max(300, displaySize) : 300}
            step={1}
            disabled={autoFitOn}
            format={autoFitOn ? (v) => `auto · ${Math.round(v)} px` : undefined}
            onChange={(v) => update(`${label}.fontSize`, (x) => { x.typography[key].fontSize = v; })}
          />
          <SliderField
            label="Weight"
            value={style.fontWeight}
            min={100}
            max={900}
            step={100}
            onChange={(v) => update(`${label}.fontWeight`, (x) => { x.typography[key].fontWeight = v; })}
          />
          <SliderField
            label="Letter spacing"
            value={style.letterSpacing}
            min={-10}
            max={30}
            step={0.5}
            onChange={(v) => update(`${label}.letterSpacing`, (x) => { x.typography[key].letterSpacing = v; })}
          />
          <SliderField
            label="Line height"
            value={style.lineHeight}
            min={0.8}
            max={2.4}
            step={0.05}
            onChange={(v) => update(`${label}.lineHeight`, (x) => { x.typography[key].lineHeight = v; })}
          />
          <SegmentedField<TextAlign>
            label="Align"
            value={style.align}
            options={[
              { value: "start", label: "Start" },
              { value: "middle", label: "Middle" },
              { value: "end", label: "End" },
            ]}
            onChange={(v) => update(`${label}.align`, (x) => { x.typography[key].align = v; })}
          />
          <ColorField
            label="Color"
            value={style.color}
            onChange={(v) => update(`${label}.color`, (x) => { x.typography[key].color = v; })}
          />
          <ToggleRow
            label="Uppercase"
            checked={style.uppercase}
            onChange={(v) => update(`${label}.uppercase`, (x) => { x.typography[key].uppercase = v; })}
          />
          <ToggleRow
            label="Italic"
            checked={style.fontStyle === "italic"}
            onChange={(v) => update(`${label}.fontStyle`, (x) => { x.typography[key].fontStyle = v ? "italic" : "normal"; })}
          />
          <SliderField
            label="Offset X"
            value={style.offsetX}
            min={-400}
            max={400}
            step={5}
            onChange={(v) => update(`${label}.offsetX`, (x) => { x.typography[key].offsetX = v; })}
          />
          <SliderField
            label="Offset Y"
            value={style.offsetY}
            min={-400}
            max={400}
            step={5}
            onChange={(v) => update(`${label}.offsetY`, (x) => { x.typography[key].offsetY = v; })}
          />

          {key === "caption" ? (
            <MultilineField
              label="Caption text"
              value={sheet.design.captionText}
              rows={2}
              placeholder="Sheet caption — shown in the left rail"
              hint="Enter adds a line break · Esc restores"
              onCommit={(v) => update("design:captionText", (x) => { x.captionText = v; })}
            />
          ) : null}

          {key === "footer" ? (
            <MultilineField
              label="Footer text"
              value={sheet.design.footerText}
              rows={2}
              placeholder={autoFooter}
              hint="Enter adds a line break · Esc restores"
              onCommit={(v) => update("design:footerText", (x) => { x.footerText = v; })}
            />
          ) : null}
        </>
      )}

      <ResetSectionButton
        title="Restore this section’s defaults — fonts, weights, colors, spacing and the default caption/footer text from the template (undoable)"
        onClick={() => {
          if (!template) return;
          update("design:typography.reset", (x) => {
            const fresh = structuredClone(template.defaults);
            x.typography = fresh.typography;
            x.captionText = fresh.captionText;
            x.footerText = fresh.footerText;
          });
        }}
      />
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 5 · Appearance (px stroke weight + optional uniform + tint)         */
/* ------------------------------------------------------------------ */

/* Signed px display for the stroke-weight chip — the unit renders as the
 * field's suffix, so the value reads as "+5 px" / "−20 px" / "0 px".
 * Round-trips with parsePxText. */
function formatSignedPx(v: number): string {
  return v > 0 ? `+${v}` : `${v}`;
}

/** Unsigned px display for the absolute uniform target ("2 px"). */
function formatPlainPx(v: number): string {
  return `${v}`;
}

/** Compact native-width range for the limited-status line ("6–24.1 px";
 *  one decimal only when it matters, min collapsed when equal to max). */
function formatRangePx(min: number, max: number): string {
  const f = (v: number): string => {
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? `${r}` : `${r.toFixed(1)}`;
  };
  return min >= max ? `${f(max)} px` : `${f(min)}–${f(max)} px`;
}

/** Lenient px parse for the stroke value chips: accepts "5", "-10",
 *  "+5", "5px", " 7 " — anything non-numeric returns null and the field
 *  silently restores the committed value (never corrupts the design). */
function parsePxText(text: string): number | null {
  const t = text.replace(/px/gi, "").replace(/[°\uFF05%\s]/g, "").replace(/,/g, ".");
  if (t === "" || t === "-" || t === "." || t === "-." || t === "+") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Compact checkbox row — the simple on/off affordance for "Uniform
 *  Stroke" and "Tint Icons" (deliberately a plain checkbox, never a mode
 *  selector). Clicking anywhere on the row toggles (Radix label pattern). */
function CheckboxRow({
  label,
  checked,
  onChange,
  tooltip,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  tooltip?: string;
}): JSX.Element {
  return (
    <label
      className="flex h-9 cursor-pointer select-none items-center gap-2 rounded-lg px-2 transition-colors hover:bg-muted/60"
      title={tooltip ?? label}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        aria-label={label}
        className="shrink-0"
      />
      <span className="min-w-0 truncate text-[12px] font-medium text-foreground/90">{label}</span>
    </label>
  );
}

function AppearanceSection({ sheet }: { sheet: Sheet }): JSX.Element {
  const icon = sheet.design.icon;
  const update = useDesignUpdater(sheet.id);
  const tpl = sheetTemplate(sheet);
  const icons = useStudio((s) => s.icons);
  const openStrokeReport = useStudio((s) => s.openStrokeReport);
  const resetSheetCellStrokes = useStudio((s) => s.resetSheetCellStrokes);

  /* round 9: how many icons on this sheet carry a per-cell stroke
   *  exception — powers the notice inside the uniform block (surfacing
   *  the feature + one-tap sheet-wide cleanup) */
  const exceptionCount = React.useMemo(() => {
    const ov = sheet.cellOverrides ?? {};
    let n = 0;
    for (const id of sheet.iconIds) if (ov[id]?.strokeTargetPx != null) n++;
    return n;
  }, [sheet]);

  /* round 12: the relative-mode twin — WEIGHT exceptions surface while
   *  uniform stroke is OFF (mirrors the target notice inside the uniform
   *  block, so neither exception kind can ever hide) */
  const weightExceptionCount = React.useMemo(() => {
    const ov = sheet.cellOverrides ?? {};
    let n = 0;
    for (const id of sheet.iconIds) if (ov[id]?.strokeWeightPx != null) n++;
    return n;
  }, [sheet]);

  /* Display values. Current designs read their stored fields directly;
   * designs persisted by older stroke UIs show derived equivalents
   * (stroke-migration.ts — median of the per-icon factors the legacy
   * render applies, computed from THIS sheet's actual icons), so the
   * first edit migrates the design continuously onto the px model
   * instead of jumping. Pure cached analysis; regular sheets take the
   * cheap direct read. */
  const strokeDisplay = React.useMemo(
    () => ({
      weight: displayStrokeWeightPx(sheet, icons),
      /* continuity delta for switching a legacy-normalize sheet's
       * uniform stroke OFF (target − median native visual) */
      legacyOff: icon.strokeMode === "normalize" ? legacyNormalizeEquivalentPx(sheet, icons) : 0,
    }),
    [sheet, icon, icons]
  );
  const weightPx = strokeDisplay.weight;
  const uniformOn = effectiveUniformStroke(icon);
  const targetPx = effectiveUniformTargetPx(icon);
  const tintOn = effectiveTintIcons(icon);

  /* Honest limited-status — appears ONLY while a stroke request is
   * actually active (weight ≠ 0 or uniform ON) AND some icons can't fully
   * obey it. Per-icon classification via the SAME analysis + factor math
   * the renderer applies (computeStrokeAdjustment — the panel can never
   * disagree with what renders or exports):
   *   · partial — the icon has measurable artwork but ALSO structurally
   *     unsafe leaves (open / degenerate subpaths, or a pre-existing mask
   *     that must not be overwritten): those few marks keep their
   *     original look while every measured mark adjusts;
   *   · unmeasurable — no safely-measurable artwork at all (text-only /
   *     degenerate shapes): keeps the exact original look, never faked.
   *  Bands AND solids adjust in BOTH directions now (Illustrator-style
   *  erosion thinning / dilation growth — single lines everywhere), so
   *  there is no direction-specific limitation anymore. */
  const limitedStrokeStatus = React.useMemo(() => {
    if (!(weightPx !== 0 || uniformOn)) return null;
    /* the sheet's REAL grid icon embed box (cell padding + icon scale —
     * the same lattice math the renderer uses), from the shared helper.
     * P7: the per-icon plan comes from THE shared embed engine
     * (icon-fit.ts) — the same basis-corrected factor the renderer applies,
     * so the classification can never disagree with what renders. */
    const cell = representativeGridIconBox(sheet);
    if (!(cell > 0)) return null;
    let partial = 0;
    let unmeasured = 0;
    for (const id of sheet.iconIds) {
      const entry = icons[id];
      if (!entry?.svg) continue;
      const plan = iconEmbedPlan(entry.svg, cell, sheet.design.icon).plan;
      if (plan.nativeVisualPx === 0) {
        unmeasured++;
      } else if (plan.limitedFillLeaves > 0) {
        partial++;
      }
    }
    if (partial === 0 && unmeasured === 0) return null;
    return { partial, unmeasured };
  }, [sheet, icons, uniformOn, weightPx]);

  /* EVERY stroke write (weight drag, uniform toggle, target change) fully
   * migrates the design onto the current px model — legacy fields are
   * deleted (not undefined-assigned) so IndexedDB stops persisting them. */
  const writeStroke = (weight: number, uniform: boolean, target: number): void => {
    update("design:icon.stroke", (x) => {
      applyStrokeModel(x.icon, weight, uniform, target);
    });
  };

  /* Honest native-width readout for the WHOLE sheet (the same per-icon
   * analysis the renderer applies): the min–max range and median of the
   * measured native visual widths. Shown while Uniform Stroke is ON so the
   * user can pick a target against the sheet's REAL artwork distribution —
   * e.g. "8.6–42.8 px · median 21.4" makes an informed 2 px thinning
   * decision obvious. Pure cached analysis; no extra renders. */
  const nativeRange = React.useMemo(() => {
    if (!uniformOn) return null;
    const cell = representativeGridIconBox(sheet);
    if (!(cell > 0)) return null;
    const widths: number[] = [];
    for (const id of sheet.iconIds) {
      const entry = icons[id];
      if (!entry?.svg) continue;
      /* P7: native widths measured at the artwork's TRUE render scale
       * (icon-fit basis) — the same weight the renderer's plan anchors to. */
      const px = iconNativeVisualPx(entry.svg, cell);
      if (px > 0) widths.push(px);
    }
    if (widths.length === 0) return null;
    widths.sort((a, b) => a - b);
    return {
      count: widths.length,
      min: widths[0],
      max: widths[widths.length - 1],
      median: widths[Math.floor(widths.length / 2)],
    };
  }, [sheet, icons, uniformOn]);

  /* Quick target presets — the four canonical weights, one tap each. Small,
   * unobtrusive, and derived from the SAME absolute-target model (no new
   * workflow, no modes — just fast access to common targets). */
  const TARGET_PRESETS: Array<{ label: string; value: number; hint: string }> = [
    { label: "0.5", value: 0.5, hint: "Hairline — 0.5 px target" },
    { label: "1", value: 1, hint: "Thin — 1 px target" },
    { label: "2", value: 2, hint: "Regular — 2 px target" },
    { label: "5", value: 5, hint: "Bold — 5 px target" },
  ];

  return (
    <Section
      title="Appearance"
      icon={<Blend className="size-3.5" />}
      badge={<span className="text-[10px] font-medium text-muted-foreground">icons</span>}
    >
      <p className="pro-label">Stroke</p>
      {/* MUTUAL EXCLUSION (UI side): while Uniform Stroke is ON the weight
       * control is DISABLED (value still visible + preserved — it is never
       * reset, never composed into the target; it simply has no effect
       * until uniform is switched back OFF). The renderer enforces the same
       * rule at the engine level, so no state can double-apply. */}
      <SliderField
        label="Icon stroke weight"
        tooltip="Outline thickness in px — negative is thinner, 0 is the exact original look, positive is thicker. Each icon is analyzed individually and adjusted relative to its own native stroke; unsafe requests clamp per icon. Non-destructive: path data is never regenerated. Disabled while Uniform Stroke is active (the value is kept and comes back when Uniform Stroke is switched off)."
        value={weightPx}
        min={STROKE_WEIGHT_PX_MIN}
        max={STROKE_WEIGHT_PX_MAX}
        step={1}
        unit="px"
        format={formatSignedPx}
        parse={parsePxText}
        disabled={uniformOn}
        onChange={(v) => writeStroke(Math.round(v), uniformOn, targetPx)}
      />
      <p className="pro-help">
        {uniformOn
          ? "Disabled while Uniform Stroke is active — the value is kept and returns when it is switched off."
          : "− makes strokes thinner · 0 restores original · + makes them thicker"}
      </p>
      {/* Per-icon WEIGHT exceptions (round 12) — surfaced while uniform is
       *  OFF: the count + one-tap cleanup, mirroring the target notice
       *  inside the uniform block. */}
      {!uniformOn && weightExceptionCount > 0 ? (
        <div
          className="studio-chip studio-chip--warn ip-notice flex items-center gap-1.5 px-2 py-1 text-[10px] leading-relaxed"
          role="status"
          title="Icons with their own weight adjustment — set from the cell toolbar's Stroke popover; see the Stroke report for the full picture"
        >
          <PenLine className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {weightExceptionCount} icon{weightExceptionCount === 1 ? " uses" : "s use"}{" "}
            {weightExceptionCount === 1 ? "its own weight" : "their own weights"} — set from a cell&apos;s Stroke
            control.
          </span>
          <button
            type="button"
            className="shrink-0 rounded-sm font-medium underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              const n = resetSheetCellStrokes(sheet.id);
              if (n > 0) {
                toast.success(
                  `Cleared ${n} stroke exception${n === 1 ? "" : "s"} — every cell follows the sheet stroke settings`,
                  { description: "Ctrl Z to undo" }
                );
              }
            }}
          >
            Clear all
          </button>
        </div>
      ) : null}
      {limitedStrokeStatus ? (
        <div className="pro-help text-amber-600 dark:text-amber-400/90 space-y-0.5">
          {limitedStrokeStatus.partial > 0 ? (
            <p>
              {limitedStrokeStatus.partial} icon
              {limitedStrokeStatus.partial === 1
                ? " has structurally unsafe subpaths — those marks keep their original look"
                : "s have structurally unsafe subpaths — those marks keep their original look"}
            </p>
          ) : null}
          {limitedStrokeStatus.unmeasured > 0 ? (
            <p>
              {limitedStrokeStatus.unmeasured} icon
              {limitedStrokeStatus.unmeasured === 1 ? " can't be measured — original look kept" : "s can't be measured — original look kept"}
            </p>
          ) : null}
        </div>
      ) : null}

      <CheckboxRow
        label="Uniform Stroke"
        checked={uniformOn}
        tooltip="Make icon strokes consistent — every icon is analyzed individually and brought toward one target width."
        onChange={(v) => {
          if (v) {
            writeStroke(weightPx, true, targetPx);
          } else if (icon.strokeMode === "normalize") {
            /* legacy normalize → px model: keep the look continuous
             * (delta = target − median native) and preserve the target */
            writeStroke(strokeDisplay.legacyOff, false, targetPx);
          } else {
            writeStroke(weightPx, false, targetPx);
          }
        }}
      />
      <p className="pro-help pl-2">Make icon strokes consistent.</p>
      {uniformOn ? (
        <div className="space-y-1.5 pl-3">
          {/* Native-width readout — the sheet's REAL artwork distribution
           * (same cached analysis the renderer uses), so target choices are
           * informed instead of guesswork. */}
          {nativeRange ? (
            <div
              className="flex items-start gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-[10px] leading-relaxed text-muted-foreground"
              title={`Measured native stroke widths of this sheet's ${nativeRange.count} icons at their real grid size — the same analysis the renderer applies.`}
            >
              <Blend className="size-3 shrink-0 translate-y-px opacity-60" aria-hidden />
              <span className="min-w-0 flex-wrap">
                Native widths{" "}
                <span className="font-medium text-foreground">
                  {formatRangePx(nativeRange.min, nativeRange.max)}
                </span>{" "}
                · median{" "}
                <span className="font-medium text-foreground">
                  {Math.round(nativeRange.median * 10) / 10} px
                </span>{" "}
                · {nativeRange.count} icons
              </span>
            </div>
          ) : null}
          <SliderField
            label="Target Width"
            tooltip="Bring every supported icon toward this stroke width (px, 0.5–100). Icons that cannot be adjusted safely keep their original look."
            value={targetPx}
            min={UNIFORM_TARGET_PX_MIN}
            max={UNIFORM_TARGET_PX_MAX}
            step={0.5}
            unit="px"
            format={formatPlainPx}
            parse={parsePxText}
            onChange={(v) => writeStroke(weightPx, true, v)}
          />
          {/* Quick target presets — one tap per canonical weight; the
           * active target highlights so the current state stays obvious. */}
          <div className="flex items-center gap-1" role="group" aria-label="Quick target presets">
            {TARGET_PRESETS.map((preset) => {
              const active = Math.abs(targetPx - preset.value) < 0.01;
              return (
                <button
                  key={preset.label}
                  type="button"
                  title={preset.hint}
                  aria-pressed={active}
                  onClick={() => writeStroke(weightPx, true, preset.value)}
                  className={cn(
                    "ip-target-btn h-6 flex-1 rounded-md border px-1.5 text-[10px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-400"
                      : "border-border bg-card text-muted-foreground hover:border-amber-500/40 hover:bg-muted hover:text-foreground"
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          {/* Per-icon exceptions (round 9) — surfaced while uniform is ON:
           * the count + one-tap cleanup, so exceptions never hide. */}
          {exceptionCount > 0 ? (
            <div
              className="studio-chip studio-chip--warn ip-notice flex items-center gap-1.5 px-2 py-1 text-[10px] leading-relaxed"
              role="status"
              title="Icons with their own absolute target — set from the cell toolbar's Stroke popover; see the Stroke report for the full picture"
            >
              <PenLine className="size-3 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                {exceptionCount} icon{exceptionCount === 1 ? " uses" : "s use"}{" "}
                {exceptionCount === 1 ? "its own target" : "their own targets"} — set from a cell&apos;s Stroke
                control.
              </span>
              <button
                type="button"
                className="shrink-0 rounded-sm font-medium underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  const n = resetSheetCellStrokes(sheet.id);
                  if (n > 0) {
                    toast.success(
                      `Cleared ${n} stroke exception${n === 1 ? "" : "s"} — every cell follows the sheet target`,
                      { description: "Ctrl Z to undo" }
                    );
                  }
                }}
              >
                Clear all
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Stroke report — per-icon QA at a glance (native width, request,
       * correction, method and result for every icon on this sheet; the
       * same analysis the renderer applies, pure read-only). */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-full justify-start gap-1.5 px-2 text-[11.5px] text-muted-foreground hover:text-foreground"
        title="Per-icon stroke analysis — native width, correction, method and result"
        onClick={openStrokeReport}
        aria-label="Open the stroke report for this sheet"
      >
        <Activity className="size-3.5 shrink-0" aria-hidden />
        Stroke report
      </Button>

      <p className="pro-label">Icon Tint</p>
      <CheckboxRow
        label="Tint Icons"
        checked={tintOn}
        tooltip="Off keeps each icon's original SVG colors; on repaints the icon artwork with one tint color. Non-destructive — original colors come back when turned off."
        onChange={(v) =>
          update("design:icon.tintIcons", (x) => {
            x.icon.tintIcons = v;
            /* full migration onto the tint checkbox model */
            delete x.icon.colorMode;
          })
        }
      />
      {tintOn ? (
        <div className="pl-3">
          <ColorField
            label="Tint color"
            value={icon.tintColor}
            onChange={(v) => update("design:icon.tintColor", (x) => { x.icon.tintColor = v; })}
          />
        </div>
      ) : null}
      <p className="pro-help">Keep original colors or apply one tint.</p>

      <ResetSectionButton
        title="Restore this section’s defaults — stroke weight 0 px, uniform stroke off and the template’s tint (undoable)"
        onClick={() => {
          if (!tpl) return;
          update("design:icon.reset", (x) => {
            x.icon = structuredClone(tpl.defaults.icon);
          });
        }}
      />
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 6 · Hero                                                            */
/* ------------------------------------------------------------------ */

function HeroSection({ sheet, caps }: { sheet: Sheet; caps: CustomTemplateCapabilities }): JSX.Element {
  const icons = useStudio((s) => s.icons);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [heroQuery, setHeroQuery] = React.useState("");
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [libraryQuery, setLibraryQuery] = React.useState("");

  const heroCandidates = React.useMemo(() => {
    const q = heroQuery.trim().toLowerCase();
    if (!q) return sheet.iconIds;
    return sheet.iconIds.filter((id) => icons[id]?.fileName.toLowerCase().includes(q));
  }, [heroQuery, sheet.iconIds, icons]);

  /* P5 · library picker candidates — every icon in the workspace library
   * (displayMode "custom" may pin ANY icon, not just ones on this sheet). */
  const libraryCandidates = React.useMemo(() => {
    const q = libraryQuery.trim().toLowerCase();
    const all = Object.values(icons);
    if (!q) return all.slice(0, 96);
    return all.filter((e) => e.fileName.toLowerCase().includes(q)).slice(0, 96);
  }, [libraryQuery, icons]);

  const hero = sheet.design.hero;
  /* P5: the ONE resolver (hero-fit.ts) decides which icon renders — the
   * enabled gate + display mode + pinned id, identical to the renderer. */
  const heroIconId = resolveHeroIconId(sheet);
  const heroIcon = heroIconId ? icons[heroIconId] : undefined;
  const effectiveMode: "none" | HeroDisplayMode =
    hero.enabled === false ? "none" : hero.displayMode ?? "selected";
  const update = useDesignUpdater(sheet.id);
  const label = "design:hero";
  const template = sheetTemplate(sheet);
  const isCustom = caps.isCustom;

  /* REAL embed boxes for the styled previews (the same lattice math the
   * renderer uses — computed once per sheet, shared by every tile). */
  const gridPreviewBox = React.useMemo(() => representativeGridIconBox(sheet), [sheet]);
  const heroPreviewBox = React.useMemo(() => heroEmbedBoxSize(sheet), [sheet]);

  /* slider ranges scale with the sheet's canvas — hero geometry on the wide
   * default sheets runs 540–680px, so the legacy fixed range (80–420) sat
   * BELOW the live value and clamped the card on first drag. */
  const heroBase = Math.max(template?.regions.hero.width ?? 300, 120);
  const cardSizeMax = Math.max(420, Math.ceil(heroBase * 2.5));
  const offsetMax = Math.max(300, Math.ceil(heroBase * 1.2));
  /* border width range must cover the template's own default (t-families
   * ship 8–10px hero borders) or the first drag clamps the live value */
  const heroBorderMax = Math.max(8, Math.ceil((template?.defaults.hero.card.borderWidth ?? 4) * 2));
  /* P5: icon padding may never swallow the card — cap at 45% (the same
   * clamp hero-fit.ts applies, so the slider cannot request an impossible
   * value). */
  const paddingMax = Math.max(20, Math.round(heroBase * 0.45));

  const pickHero = (iconId: string) => {
    useStudio.getState().setHero(sheet.id, iconId);
    setPickerOpen(false);
  };

  const clearHero = () => {
    useStudio.getState().setHero(sheet.id, null);
    setPickerOpen(false);
  };

  /* P5 display-mode control: "None" is the layout-level OFF switch (the
   * sheet renders no hero icon and no hero card — icons stay in their
   * grid cells, never a blank hole); the other three pick the icon. */
  const setMode = (mode: "none" | HeroDisplayMode): void => {
    if (mode === effectiveMode) return;
    if (mode === "none") {
      update(`${label}.enabled`, (x) => {
        x.hero.enabled = false;
      });
      return;
    }
    update(`${label}.displayMode`, (x) => {
      x.hero.enabled = true;
      x.hero.displayMode = mode;
    });
  };

  const pinCustomIcon = (iconId: string): void => {
    update(`${label}.customIconId`, (x) => {
      x.hero.customIconId = iconId;
    });
    setLibraryOpen(false);
  };

  /* custom templates without a detected hero slot: the whole section is
   * honestly unavailable (no slot to place the hero icon into) */
  if (isCustom && !caps.heroSlot) {
    return (
      <Section title="Hero" icon={<Star className="size-3.5" />} badge={<Badge variant="outline" className="h-5 rounded-md bg-muted/60 px-1.5 text-[10px] font-medium text-muted-foreground">None</Badge>}>
        <UnavailableNote>
          No hero slot was detected in this template — hero settings are
          unavailable. Re-import it and place a hero slot to enable them.
        </UnavailableNote>
      </Section>
    );
  }

  const modeBadge =
    effectiveMode === "none"
      ? "Off"
      : effectiveMode === "first"
        ? "First"
        : effectiveMode === "custom"
          ? "Custom"
          : heroIcon
            ? "Set"
            : "None";

  return (
    <Section
      title="Hero"
      icon={<Star className="size-3.5" />}
      badge={
        <Badge
          variant="outline"
          className={cn(
            "h-5 rounded-md px-1.5 text-[10px] font-medium",
            effectiveMode === "none"
              ? "bg-muted/60 text-muted-foreground"
              : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-500"
          )}
        >
          {modeBadge}
        </Badge>
      }
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "grid size-12 shrink-0 place-items-center rounded-lg border",
              heroIcon ? "border-amber-500/50 bg-amber-500/10" : "border-dashed border-muted-foreground/40"
            )}
            title={heroIcon ? heroIcon.fileName : "No hero icon"}
          >
            {heroIcon ? (
              <StyledIconPreview
                svg={heroIcon.svg}
                entryId={heroIcon.id}
                iconStyle={sheet.design.icon}
                boxSize={heroPreviewBox}
                colorOverride={hero.iconColor}
                cellOverride={sheet.cellOverrides?.[heroIcon.id]}
                size={96}
                className="h-9 w-9"
              />
            ) : (
              <span className="h-9 w-9 rounded-md border border-dashed border-muted-foreground/25" aria-hidden />
            )}
          </div>
          <div className="min-w-0 flex-1">
            {effectiveMode === "custom" ? (
              <Button
                variant="outline"
                size="sm"
                className="h-9 w-full rounded-lg text-[12px]"
                onClick={() => setLibraryOpen(true)}
                aria-label="Choose the pinned hero icon from the library"
                title="Pin any icon from the library — it stays the hero even when sheet contents change"
              >
                <Library className="size-3.5" aria-hidden />
                {hero.customIconId ? "Change pinned icon…" : "Choose from library…"}
              </Button>
            ) : effectiveMode === "selected" ? (
              <Button
                variant="outline"
                size="sm"
                className="h-9 w-full rounded-lg text-[12px]"
                onClick={() => setPickerOpen(true)}
                aria-label="Select hero icon"
                title="Pick any icon from this sheet to feature as the hero"
              >
                Select hero…
              </Button>
            ) : (
              <div className="flex h-9 items-center justify-center rounded-lg border border-dashed border-muted-foreground/40 px-2 text-[11px] text-muted-foreground">
                {effectiveMode === "none" ? "Hero is off" : "Always the sheet's first icon"}
              </div>
            )}
          </div>
        </div>
        <p className="pro-help truncate" title={heroIcon?.fileName ?? undefined}>
          {effectiveMode === "none"
            ? isCustom
              ? "No hero icon and no hero card are drawn — the template's own hero artwork shows and every icon stays in its grid cell (no blank holes)."
              : "No hero icon and no hero card are drawn — every icon stays in its grid cell (no blank holes)."
            : heroIcon
              ? isCustom
                ? `${heroIcon.fileName} — renders centered in the detected hero slot, uniformly scaled to fit.`
                : heroIcon.fileName
              : effectiveMode === "custom"
                ? "No pinned icon yet — choose one from the library."
                : effectiveMode === "first"
                  ? "This sheet has no icons yet."
                  : isCustom
                    ? "No hero icon — the detected hero slot stays empty."
                    : "No hero icon — the sheet shows a dashed placeholder."}
        </p>
      </div>

      <SubHeader>Display</SubHeader>
      <SegmentedField<"none" | HeroDisplayMode>
        label="Icon source"
        value={effectiveMode}
        options={[
          { value: "none", label: "None" },
          { value: "selected", label: "Selected" },
          { value: "first", label: "First" },
          { value: "custom", label: "Custom" },
        ]}
        onChange={setMode}
      />
      <p className="pro-help">
        {effectiveMode === "none"
          ? "Off — a real layout change: nothing hero-related is drawn on this sheet."
          : effectiveMode === "selected"
            ? "The sheet's chosen hero icon (the classic behavior)."
            : effectiveMode === "first"
              ? "Always the sheet's first icon — follows content changes automatically, never stale."
              : "The pinned library icon stays the hero even when sheet contents change."}
      </p>

      <SubHeader>Icon</SubHeader>
      <SliderField
        label="Icon scale"
        tooltip="Resize the hero icon without changing the hero card."
        value={hero.iconScale}
        min={0.1}
        max={2.5}
        step={0.01}
        format={formatPercent}
        parse={parsePercentText}
        bigStep={0.1}
        onChange={(v) => update(`${label}.iconScale`, (x) => { x.hero.iconScale = v; })}
      />
      <p className="pro-help">
        {isCustom
          ? "Up to 100% fills the detected hero slot; above 100% only the icon artwork grows, centered on the slot — the card and the template never resize."
          : "Up to 100% fills the card; above 100% only the icon artwork grows, centered — the hero card itself never resizes."}
      </p>
      <SliderField
        label="Icon padding"
        tooltip="Breathing room between the hero card's edge and the icon artwork — the icon is fitted inside the padded area (centered, aspect preserved, never distorted)."
        value={hero.iconPadding ?? 0}
        min={0}
        max={paddingMax}
        step={1}
        onChange={(v) => update(`${label}.iconPadding`, (x) => { x.hero.iconPadding = v; })}
      />
      <p className="pro-help">
        Padding shrinks the usable area before the icon is fitted — the artwork can never enter the pad.
      </p>
      {/* Hero icon color — ALWAYS visible (the picker is the affordance
       * itself; the old opt-in toggle hid the control behind an off
       * switch and users could not find it). While following the sheet
       * (iconColor == null) the swatch previews the color the hero icon
       * would take; picking any color opts into the override (same
       * "design:hero.iconColor" update label → same undo coalescing as
       * before); the chip resets back to following the sheet. */}
      <ColorField
        label="Icon color"
        value={hero.iconColor ?? sheet.design.icon.tintColor ?? "#1F1D17"}
        onChange={(v) => update(`${label}.iconColor`, (x) => { x.hero.iconColor = v; })}
      />
      {hero.iconColor != null ? (
        <button
          type="button"
          onClick={() => update(`${label}.iconColor`, (x) => { x.hero.iconColor = null; })}
          className="mt-1 inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="Reset — the hero icon goes back to following the sheet's icon color settings"
        >
          <RotateCcw className="size-3" aria-hidden />
          Follow sheet color
        </button>
      ) : (
        <p className="pro-help">
          {effectiveTintIcons(sheet.design.icon)
            ? "Auto — follows the sheet’s icon tint. Pick any color above to recolor only the hero icon’s artwork (the hero card is never affected)."
            : "Auto — keeps the hero icon’s original colors. Pick any color above to tint the hero icon’s artwork (the hero card is never affected)."}
        </p>
      )}
      <SliderField
        label="Offset X"
        value={hero.offsetX}
        min={-offsetMax}
        max={offsetMax}
        step={1}
        onChange={(v) => update(`${label}.offsetX`, (x) => { x.hero.offsetX = v; })}
      />
      <SliderField
        label="Offset Y"
        value={hero.offsetY}
        min={-offsetMax}
        max={offsetMax}
        step={1}
        onChange={(v) => update(`${label}.offsetY`, (x) => { x.hero.offsetY = v; })}
      />

      <SubHeader>Card</SubHeader>
      {isCustom ? (
        <>
          <ToggleRow
            label="Draw hero card"
            checked={hero.customHeroCard === true}
            onChange={(v) =>
              update(`${label}.customHeroCard`, (x) => {
                x.hero.customHeroCard = v;
                if (v) x.hero.card.visible = true;
              })
            }
          />
          <p className="pro-help">
            {hero.customHeroCard === true
              ? "A styled card is drawn behind the hero icon, centered on the detected slot — the template’s own hero artwork stays beneath it."
              : "Off keeps the template’s own hero artwork — turn on to draw a styled card behind the icon."}
          </p>
        </>
      ) : (
        <ToggleRow
          label="Card visible"
          checked={hero.card.visible}
          onChange={(v) => update(`${label}.card.visible`, (x) => { x.hero.card.visible = v; })}
        />
      )}
      {isCustom && hero.customHeroCard !== true ? null : (
        <>
          <SliderField
            label="Card size"
            value={hero.cardSize}
            min={Math.min(80, Math.floor(heroBase / 2))}
            max={cardSizeMax}
            step={2}
            onChange={(v) => update(`${label}.cardSize`, (x) => { x.hero.cardSize = v; })}
          />
          <ColorField
            label="Card color"
            value={hero.card.color}
            onChange={(v) => update(`${label}.card.color`, (x) => { x.hero.card.color = v; })}
          />
          <SliderField
            label="Opacity"
            value={hero.card.opacity}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => update(`${label}.card.opacity`, (x) => { x.hero.card.opacity = v; })}
          />
          <SliderField
            label="Radius"
            value={hero.card.radius}
            min={0}
            max={80}
            step={1}
            onChange={(v) => update(`${label}.card.radius`, (x) => { x.hero.card.radius = v; })}
          />
          <SliderField
            label="Border width"
            value={hero.card.borderWidth}
            min={0}
            max={heroBorderMax}
            step={1}
            onChange={(v) => update(`${label}.card.borderWidth`, (x) => { x.hero.card.borderWidth = v; })}
          />
          <ColorField
            label="Border color"
            value={hero.card.borderColor}
            onChange={(v) => update(`${label}.card.borderColor`, (x) => { x.hero.card.borderColor = v; })}
          />
          <SliderField
            label="Card offset X"
            value={hero.cardOffsetX}
            min={-offsetMax}
            max={offsetMax}
            step={1}
            onChange={(v) => update(`${label}.cardOffsetX`, (x) => { x.hero.cardOffsetX = v; })}
          />
          <SliderField
            label="Card offset Y"
            value={hero.cardOffsetY}
            min={-offsetMax}
            max={offsetMax}
            step={1}
            onChange={(v) => update(`${label}.cardOffsetY`, (x) => { x.hero.cardOffsetY = v; })}
          />
        </>
      )}

      <SubHeader>Shadow</SubHeader>
      {isCustom && hero.customHeroCard !== true ? (
        <p className="pro-help">
          Card styling is inactive while the template’s own hero artwork shows.
        </p>
      ) : (
        <ToggleRow
          label="Shadow"
          checked={hero.shadow}
          onChange={(v) => update(`${label}.shadow`, (x) => { x.hero.shadow = v; })}
        />
      )}
      {isCustom && hero.customHeroCard !== true ? null : hero.shadow ? (
        <div className="mt-2.5 space-y-2.5 rounded-lg border border-border bg-muted/40 p-3">
          <SliderField
            label="Strength"
            value={hero.shadowStrength}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => update(`${label}.shadowStrength`, (x) => { x.hero.shadowStrength = v; })}
          />
          <SliderField
            label="Blur"
            value={hero.shadowBlur}
            min={0}
            max={60}
            step={1}
            onChange={(v) => update(`${label}.shadowBlur`, (x) => { x.hero.shadowBlur = v; })}
          />
          <SliderField
            label="Shadow X"
            value={hero.shadowX}
            min={-40}
            max={40}
            step={1}
            onChange={(v) => update(`${label}.shadowX`, (x) => { x.hero.shadowX = v; })}
          />
          <SliderField
            label="Shadow Y"
            value={hero.shadowY}
            min={-40}
            max={40}
            step={1}
            onChange={(v) => update(`${label}.shadowY`, (x) => { x.hero.shadowY = v; })}
          />
          <ColorField
            label="Shadow color"
            value={hero.shadowColor}
            onChange={(v) => update(`${label}.shadowColor`, (x) => { x.hero.shadowColor = v; })}
          />
        </div>
      ) : null}

      <ResetSectionButton
        title="Restore this section’s defaults — icon scale, offsets, card size/style and shadow from the template (undoable). The hero icon choice is kept."
        onClick={() => {
          if (!template) return;
          update(`${label}.reset`, (x) => {
            x.hero = structuredClone(template.defaults.hero);
          });
        }}
      />

      <Dialog
        open={pickerOpen}
        onOpenChange={(o) => {
          setPickerOpen(o);
          if (!o) setHeroQuery("");
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-base">Select hero icon</DialogTitle>
            <DialogDescription className="text-xs">
              Pick any icon from this sheet — it renders large in the left rail. The current hero is highlighted.
            </DialogDescription>
          </DialogHeader>

          {sheet.iconIds.length === 0 ? (
            <p className="py-8 text-center text-[11px] text-muted-foreground">
              This sheet has no icons yet.
            </p>
          ) : sheet.iconIds.length > 12 ? (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" aria-hidden />
              <Input
                value={heroQuery}
                onChange={(e) => setHeroQuery(e.target.value)}
                placeholder={`Search ${sheet.iconIds.length} icons…`}
                className="h-8 pl-8 text-[12px]"
                aria-label="Search icons by file name"
              />
            </div>
          ) : null}

          {sheet.iconIds.length > 0 && heroCandidates.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-muted-foreground">
              No icons match “{heroQuery.trim()}”.
            </p>
          ) : (
            <div
              className={cn("grid grid-cols-6 gap-2 p-1 sm:grid-cols-8", SCROLLABLE_GRID)}
              role="listbox"
              aria-label="Icons in this sheet"
            >
              {heroCandidates.map((iconId) => {
                const icon = icons[iconId];
                if (!icon) return null;
                const isCurrent = sheet.heroIconId === iconId;
                return (
                  <button
                    key={iconId}
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    title={icon.fileName}
                    aria-label={`Set hero: ${icon.fileName}`}
                    onClick={() => pickHero(iconId)}
                    className={cn(
                      "relative flex h-16 w-full cursor-pointer items-center justify-center rounded-lg border bg-card p-2 outline-none transition-all",
                      "hover:ring-2 hover:ring-amber-500/70 focus-visible:ring-2 focus-visible:ring-amber-500",
                      isCurrent
                        ? "border-amber-500/60 bg-amber-500/10 ring-2 ring-amber-500/60"
                        : "border-border"
                    )}
                  >
                    <StyledIconPreview
                      svg={icon.svg}
                      entryId={icon.id}
                      iconStyle={sheet.design.icon}
                      boxSize={gridPreviewBox}
                      cellOverride={sheet.cellOverrides?.[icon.id]}
                      size={96}
                      className="pointer-events-none h-9 w-9"
                    />
                    {isCurrent ? (
                      <Check
                        className="absolute right-1 top-1 size-3.5 rounded-sm bg-background text-amber-600"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-[11px]"
              onClick={clearHero}
              disabled={!sheet.heroIconId}
            >
              <Trash2 className="size-3.5" aria-hidden />
              Clear hero
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* P5 · library picker — displayMode "custom" pins ANY library icon
       * (reuses the same searchable-grid picker pattern + the same styled
       * icon previews; the pin lives on the design, so it persists and
       * survives sheet content changes). */}
      <Dialog
        open={libraryOpen}
        onOpenChange={(o) => {
          setLibraryOpen(o);
          if (!o) setLibraryQuery("");
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-base">Pin a hero icon from the library</DialogTitle>
            <DialogDescription className="text-xs">
              The pinned icon stays this sheet's hero even when its icons change — it renders centered in the hero area, uniformly scaled to fit.
            </DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" aria-hidden />
            <Input
              value={libraryQuery}
              onChange={(e) => setLibraryQuery(e.target.value)}
              placeholder={`Search ${Object.keys(icons).length} library icons…`}
              className="h-8 pl-8 text-[12px]"
              aria-label="Search library icons by file name"
            />
          </div>

          {libraryCandidates.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-muted-foreground">
              No library icons match “{libraryQuery.trim()}”.
            </p>
          ) : (
            <div
              className={cn("grid grid-cols-6 gap-2 p-1 sm:grid-cols-8", SCROLLABLE_GRID)}
              role="listbox"
              aria-label="Icons in the library"
            >
              {libraryCandidates.map((icon) => {
                const isPinned = hero.customIconId === icon.id;
                return (
                  <button
                    key={icon.id}
                    type="button"
                    role="option"
                    aria-selected={isPinned}
                    title={icon.fileName}
                    aria-label={`Pin hero: ${icon.fileName}`}
                    onClick={() => pinCustomIcon(icon.id)}
                    className={cn(
                      "relative flex h-16 w-full cursor-pointer items-center justify-center rounded-lg border bg-card p-2 outline-none transition-all",
                      "hover:ring-2 hover:ring-amber-500/70 focus-visible:ring-2 focus-visible:ring-amber-500",
                      isPinned
                        ? "border-amber-500/60 bg-amber-500/10 ring-2 ring-amber-500/60"
                        : "border-border"
                    )}
                  >
                    <StyledIconPreview
                      svg={icon.svg}
                      entryId={icon.id}
                      iconStyle={sheet.design.icon}
                      boxSize={gridPreviewBox}
                      cellOverride={sheet.cellOverrides?.[icon.id]}
                      size={96}
                      className="pointer-events-none h-9 w-9"
                    />
                    {isPinned ? (
                      <Check
                        className="absolute right-1 top-1 size-3.5 rounded-sm bg-background text-amber-600"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}

          <DialogFooter>
            {hero.customIconId ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-[11px]"
                onClick={() => {
                  update(`${label}.customIconId`, (x) => {
                    x.hero.customIconId = null;
                  });
                  setLibraryOpen(false);
                }}
              >
                <Trash2 className="size-3.5" aria-hidden />
                Clear pin
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 7 · Actions                                                         */
/* ------------------------------------------------------------------ */

function ActionsSection({ sheet, sheetIndex }: { sheet: Sheet; sheetIndex: number }): JSX.Element {
  const sheets = useStudio((s) => s.sheets);
  const selectedSheetIds = useStudio((s) => s.selectedSheetIds);

  const otherIds = sheets.filter((s) => s.id !== sheet.id).map((s) => s.id);
  const selectedTargetIds = selectedSheetIds.filter((id) => id !== sheet.id);
  const title = sheetTitle(sheet, sheetIndex);

  const randomize = () => useStudio.getState().randomizeSheet(sheet.id);
  /* read the store LIVE at click time — a confirm dialog can outlive a
   * selection change (user ticks/unticks checkmarks while it is open), and
   * a stale render-time closure would target the wrong sheets or none at
   * all — the exact silent "nothing happened" failure users reported. */
  const applyToAll = () => {
    const st = useStudio.getState();
    const liveOthers = st.sheets.filter((sh) => sh.id !== sheet.id).map((sh) => sh.id);
    if (liveOthers.length === 0) return;
    st.applyDesignToSheets(liveOthers, sheet.id);
  };
  const applyToSelected = () => {
    const st = useStudio.getState();
    const live = st.selectedSheetIds.filter(
      (id) => id !== sheet.id && st.sheets.some((sh) => sh.id === id)
    );
    if (live.length === 0) return;
    st.applyDesignToSheets(live, sheet.id);
  };
  const removeSheet = () => useStudio.getState().deleteSheet(sheet.id);

  /* target names for the confirm dialog — the direction (source → targets)
  * must be unmistakable: checking a sheet then clicking its row makes THAT
  * sheet the editing source, and a silent reversed apply destroys edits. */
  const selectedTargetTitles = selectedTargetIds
    .map((id) => {
      const idx = sheets.findIndex((sh) => sh.id === id);
      return idx >= 0 ? sheetTitle(sheets[idx], idx) : null;
    })
    .filter((t): t is string => t !== null);

  return (
    <Section title="Actions" icon={<Zap className="size-3.5" />}>
      <div className="space-y-2.5">
        <Button
          variant="outline"
          size="sm"
          className="h-9 w-full gap-1.5 rounded-lg text-[12px]"
          onClick={randomize}
          title="Shuffle icon order — hero and library order stay intact"
        >
          <Dices className="size-3.5" aria-hidden />
          Randomize
        </Button>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-9 w-full gap-1.5 rounded-lg text-[12px]"
              disabled={otherIds.length === 0}
              aria-label="Apply design to all sheets"
              title={`Copy ${title}'s design (colors, typography, cards) to all ${otherIds.length} other sheet${otherIds.length === 1 ? "" : "s"}`}
            >
              <Paintbrush className="size-3.5" aria-hidden />
              Apply design to all sheets
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="max-w-md p-5">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-base">Copy {title}'s design to all sheets?</AlertDialogTitle>
              <AlertDialogDescription className="text-[13px]">
                The design of <span className="font-semibold">{title}</span> — the sheet you are
                editing — replaces the design on the {otherIds.length} other sheet{otherIds.length === 1 ? "" : "s"}.
                Icon assignments, heroes, categories and volumes are never copied.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="h-8">Cancel</AlertDialogCancel>
              <AlertDialogAction className="h-8" onClick={applyToAll}>
                Apply design
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-9 w-full gap-1.5 rounded-lg text-[12px]"
              disabled={selectedTargetIds.length === 0}
              title={
                selectedTargetIds.length === 0
                  ? "Select target sheets first — tick the checkmarks in the sheet list (left) or the overview"
                  : `Copy ${title}'s design (colors, typography, cards) to the ${selectedTargetIds.length} selected sheet${selectedTargetIds.length === 1 ? "" : "s"}`
              }
              aria-label={`Apply design to ${selectedTargetIds.length} selected sheets`}
            >
              <CopyCheck className="size-3.5" aria-hidden />
              Apply to selected ({selectedTargetIds.length})
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="max-w-md p-5">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-base">
                Copy {title}'s design to {selectedTargetIds.length} selected sheet{selectedTargetIds.length === 1 ? "" : "s"}?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-[13px]">
                The design of <span className="font-semibold">{title}</span> — the sheet you are
                editing — replaces the design on{" "}
                <span className="font-semibold">{selectedTargetTitles.join(", ")}</span>.
                Icon assignments, heroes, categories and volumes are never copied.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="h-8">Cancel</AlertDialogCancel>
              <AlertDialogAction className="h-8" onClick={applyToSelected}>
                Apply design
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Separator className="my-1" />

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-full gap-1.5 rounded-lg text-[12px] text-destructive hover:bg-destructive/10 hover:text-destructive"
              aria-label={`Delete ${title}`}
            >
              <Trash2 className="size-3.5" aria-hidden />
              Delete {title}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="max-w-md p-5">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-base">Delete {title}?</AlertDialogTitle>
              <AlertDialogDescription className="text-[13px]">
                Its icons return to the unassigned library. You can undo this from history.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="h-8">Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="h-8 bg-destructive text-white hover:bg-destructive/90"
                onClick={removeSheet}
              >
                Delete sheet
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Section>
  );
}
