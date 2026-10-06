"use client";

/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 2/3) · Template Library dialog.
 *
 * The management surface for every template the Studio knows:
 *
 *   OFFICIAL   — immutable: preview + “Use” only (never editable, never
 *                deletable, never duplicable through this UI).
 *   BUILDER    — created in the Template Builder (record carries an embedded
 *                builderDoc): Use / Edit (re-opens the Builder with the exact
 *                authoring state) / Rename / Duplicate / Export / Delete.
 *   UPLOADED   — imported SVG templates: Use / Rename / Duplicate / Export /
 *                Delete (no “Edit” — they were not authored in the builder).
 *   BROKEN     — records that failed structural validation at hydrate: kept
 *                listed with the exact reason + an explicit Remove action
 *                (phase 3 §59 — never silent loss, never a crash).
 *
 * Phase 3 additions: search (name / capacity / origin), per-section sorting
 * (library order · name · capacity · recently created · recently updated),
 * revision badges (v2+), delete-while-in-use (sheets keep their embedded
 * snapshot), and portable template files (.icon-template.json) — export any
 * custom template, import one back through the SAME validator as everything
 * else.
 *
 * Thumbnails render through THE universal renderer (renderSheet, export
 * mode) — the same engine that draws sheets and exports — never a separate
 * visual implementation.
 */

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowDownUp,
  BadgeCheck,
  Copy,
  Download,
  FileUp,
  LayoutTemplate,
  PencilRuler,
  Pencil,
  Search,
  Trash2,
  Wand2,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStudio } from "@/lib/studio/store";
import { buildCustomTemplate, customRecordVersion, listOfficialTemplates } from "@/lib/studio/templates";
import { renderSheet } from "@/lib/studio/renderer";
import { triggerDownload } from "@/lib/studio/export";
import { parseTemplateFile, serializeTemplateFile, TEMPLATE_FILE_EXTENSION } from "@/lib/studio/template-file";
import type { CustomTemplateRecord, Sheet, TemplateDef } from "@/lib/studio/types";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Thumbnail cache (module-level — survives dialog remounts)            */
/* ------------------------------------------------------------------ */

const thumbCache = new Map<string, { key: string; svg: string }>();

function previewSheetFor(def: TemplateDef, category: string): Sheet {
  return {
    id: `lib-${def.id}`,
    templateId: def.id,
    /* capacity placeholder ids — unresolved icons are skipped by the
     * renderer, but the live Icon Count text shows "{capacity} ICONS" */
    iconIds: Array.from({ length: def.capacity }, (_, i) => `lib-slot-${i}`),
    heroIconId: null,
    category,
    volume: 1,
    design: structuredClone(def.defaults),
    createdAt: 0,
    updatedAt: 0,
  };
}

function templateThumbnail(def: TemplateDef, record: CustomTemplateRecord | null): string {
  const category = record?.builderDoc
    ? ((): string => {
        const el = record.builderDoc.elements.find((e) => e.role === "category" && e.type === "text");
        const content =
          el && typeof (el.properties as { content?: unknown }).content === "string"
            ? (el.properties as { content: string }).content
            : "";
        return content.split("\n")[0]?.trim() || "Icon Collection";
      })()
    : def.name;
  /* phase 3 — the cache key carries the revision: a re-published template
   * invalidates its thumbnail immediately */
  const key = `${def.id}|${def.name}|${def.capacity}|${Math.round(def.width)}x${Math.round(def.height)}|${record?.builderDoc?.metadata.updatedAt ?? 0}|v${record ? customRecordVersion(record) : 1}`;
  const hit = thumbCache.get(def.id);
  if (hit && hit.key === key) return hit.svg;
  try {
    const svg = renderSheet(previewSheetFor(def, category), def, {}, { mode: "export" });
    thumbCache.set(def.id, { key, svg });
    return svg;
  } catch (err) {
    console.error("[template-library] thumbnail render failed", err);
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* Search + sort (phase 3 — §44/§45)                                   */
/* ------------------------------------------------------------------ */

type SortMode = "library" | "name" | "capacity" | "created" | "updated";

const SORT_LABELS: Array<{ value: SortMode; label: string }> = [
  { value: "library", label: "Library order" },
  { value: "name", label: "Name A→Z" },
  { value: "capacity", label: "Capacity ↑" },
  { value: "created", label: "Recently created" },
  { value: "updated", label: "Recently updated" },
];

function matchesQuery(query: string, name: string, capacity: number, origin: "official" | "builder" | "uploaded"): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (name.toLowerCase().includes(q)) return true;
  if (String(capacity).includes(q)) return true;
  if (origin === "official" && ("official".includes(q) || "builtin".includes(q))) return true;
  if (origin === "builder" && "builder".includes(q)) return true;
  if (origin === "uploaded" && ("uploaded".includes(q) || "svg" .includes(q))) return true;
  if (origin !== "official" && "custom".includes(q)) return true;
  return false;
}

function sortCustomRecords(records: CustomTemplateRecord[], mode: SortMode): CustomTemplateRecord[] {
  const list = [...records];
  switch (mode) {
    case "name":
      return list.sort((a, b) => a.name.localeCompare(b.name));
    case "capacity":
      return list.sort((a, b) => a.capacity - b.capacity || a.name.localeCompare(b.name));
    case "created":
      return list.sort((a, b) => b.createdAt - a.createdAt);
    case "updated":
      return list.sort(
        (a, b) =>
          (b.builderDoc?.metadata.updatedAt ?? b.createdAt) - (a.builderDoc?.metadata.updatedAt ?? a.createdAt)
      );
    default:
      return list;
  }
}

function templateFileSlug(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "template";
}

/* ------------------------------------------------------------------ */
/* One template row                                                    */
/* ------------------------------------------------------------------ */

type Origin = "official" | "builder" | "uploaded";

interface TemplateRowProps {
  def: TemplateDef;
  record: CustomTemplateRecord | null;
  origin: Origin;
  usedBy: number;
  onEditInBuilder: (recordId: string) => void;
  onRequestDelete: (record: CustomTemplateRecord) => void;
  onUsed: (def: TemplateDef) => void;
  onExport: (record: CustomTemplateRecord) => void;
}

function TemplateRow({ def, record, origin, usedBy, onEditInBuilder, onRequestDelete, onUsed, onExport }: TemplateRowProps) {
  const renameCustomTemplate = useStudio((s) => s.renameCustomTemplate);
  const duplicateCustomTemplate = useStudio((s) => s.duplicateCustomTemplate);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(record?.name ?? def.name);
  const revision = record ? customRecordVersion(record) : 1;

  const svg = useMemo(() => templateThumbnail(def, record), [def, record]);

  const commitRename = (): void => {
    setEditing(false);
    const next = draftName.trim();
    if (record && next && next !== record.name) renameCustomTemplate(record.id, next);
    else setDraftName(record?.name ?? def.name);
  };

  const isCustom = origin !== "official";

  return (
    <div
      className={cn(
        "group flex flex-col gap-3 rounded-xl border bg-card p-3 shadow-sm transition-[border-color,box-shadow] hover:shadow-md hover:shadow-black/10 sm:flex-row sm:items-stretch",
        origin === "official" ? "border-border/70" : "border-border/70 hover:border-ring/40"
      )}
    >
      {/* thumbnail — the universal renderer, export mode */}
      <div
        className="relative mx-auto w-full max-w-[280px] shrink-0 overflow-hidden rounded-lg border border-border/60 bg-white shadow-inner sm:mx-0 sm:w-44"
        style={{ aspectRatio: `${def.width} / ${def.height}` }}
      >
        {svg ? (
          <div
            className="h-full w-full [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
            dangerouslySetInnerHTML={{ __html: svg }}
            role="img"
            aria-label={`Preview of ${def.name}`}
          />
        ) : (
          <div className="grid h-full place-items-center text-[10px] text-zinc-400">preview unavailable</div>
        )}
        <span
          className={cn(
            "absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide backdrop-blur",
            origin === "official"
              ? "bg-zinc-900/70 text-white"
              : origin === "builder"
                ? "bg-amber-500/85 text-white"
                : "bg-zinc-600/80 text-white"
          )}
        >
          {origin === "official" ? (
            <BadgeCheck className="size-2.5" aria-hidden />
          ) : origin === "builder" ? (
            <PencilRuler className="size-2.5" aria-hidden />
          ) : (
            <FileUp className="size-2.5" aria-hidden />
          )}
          {origin === "official" ? "Official" : origin === "builder" ? "Builder" : "Uploaded"}
        </span>
      </div>

      {/* info + actions */}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="min-w-0">
          {editing && record ? (
            <Input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") {
                  setDraftName(record.name);
                  setEditing(false);
                }
              }}
              autoFocus
              maxLength={120}
              className="h-8 w-full max-w-[260px] text-[12.5px] font-semibold"
              aria-label="Template name"
            />
          ) : (
            <div className="flex items-center gap-1.5">
              <p className="truncate text-[13px] font-semibold leading-tight" title={def.name}>
                {def.name}
              </p>
              {revision > 1 && (
                <span
                  title={`Revision v${revision} — sheets created earlier keep the version they were built with (update available per sheet in its Properties panel)`}
                  className="inline-flex h-4 shrink-0 items-center rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[9px] font-semibold tabular-nums text-amber-700 dark:text-amber-400"
                >
                  v{revision}
                </span>
              )}
              {isCustom && (
                <button
                  type="button"
                  className="rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                  onClick={() => {
                    setDraftName(record?.name ?? def.name);
                    setEditing(true);
                  }}
                  aria-label={`Rename ${def.name}`}
                  title="Rename"
                >
                  <Pencil className="size-3" aria-hidden />
                </button>
              )}
            </div>
          )}
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted-foreground">
            <span className="tabular-nums">
              {def.capacity} icon {def.capacity === 1 ? "slot" : "slots"}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              {Math.round(def.width)} × {Math.round(def.height)}
            </span>
            {def.grid && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums">
                  {def.grid.rows} × {def.grid.cols} grid
                </span>
              </>
            )}
            {usedBy > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="font-medium text-amber-600 dark:text-amber-400">
                  used by {usedBy} sheet{usedBy === 1 ? "" : "s"}
                </span>
              </>
            )}
          </p>
          {record?.metadata.gridDescription && (
            <p className="mt-1 hidden text-[10.5px] leading-relaxed text-muted-foreground/80 sm:block">
              {record.metadata.gridDescription}
              {record.builderDoc ? " — editable in the Template Builder" : ""}
            </p>
          )}
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-[11px]"
            onClick={() => onUsed(def)}
            title={`Use ${def.name} for the active sheet`}
          >
            <LayoutTemplate className="size-3" aria-hidden />
            Use
          </Button>
          {origin === "builder" && record && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-[11px]"
              onClick={() => onEditInBuilder(record.id)}
              title="Open in the Template Builder — reconstructs the exact authoring state"
            >
              <PencilRuler className="size-3" aria-hidden />
              Edit
            </Button>
          )}
          {isCustom && record && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2.5 text-[11px]"
                onClick={() => duplicateCustomTemplate(record.id)}
                title="Duplicate — the copy is fully independent"
              >
                <Copy className="size-3" aria-hidden />
                Duplicate
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2.5 text-[11px]"
                onClick={() => onExport(record)}
                title={`Export as a portable ${TEMPLATE_FILE_EXTENSION} file — restores on any machine`}
              >
                <Download className="size-3" aria-hidden />
                Export
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 border-destructive/40 px-2.5 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => onRequestDelete(record)}
                title={
                  usedBy > 0
                    ? `Delete ${def.name} — ${usedBy} sheet${usedBy === 1 ? "" : "s"} keep their layout via embedded snapshots`
                    : `Delete ${def.name}`
                }
              >
                <Trash2 className="size-3" aria-hidden />
                Delete
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The dialog                                                          */
/* ------------------------------------------------------------------ */

export function TemplateLibraryDialog({
  open,
  onOpenChange,
  onEditInBuilder,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** studio-app wires this to open the builder with the record's embedded doc */
  onEditInBuilder: (recordId: string) => void;
}) {
  const customRecords = useStudio((s) => s.customTemplates);
  const templateLoadErrors = useStudio((s) => s.templateLoadErrors);
  const removeBrokenTemplateRecord = useStudio((s) => s.removeBrokenTemplateRecord);
  const sheets = useStudio((s) => s.sheets);
  const activeSheetId = useStudio((s) => s.activeSheetId);
  const changeSheetTemplate = useStudio((s) => s.changeSheetTemplate);
  const deleteCustomTemplate = useStudio((s) => s.deleteCustomTemplate);
  const [pendingDelete, setPendingDelete] = useState<CustomTemplateRecord | null>(null);
  /* phase 3 — search + sort + portable template files */
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("library");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const officials = useMemo(() => listOfficialTemplates(), []);
  const builderRecords = useMemo(
    () =>
      sortCustomRecords(
        customRecords.filter((r) => r.builderDoc && matchesQuery(query, r.name, r.capacity, "builder")),
        sortMode
      ),
    [customRecords, query, sortMode]
  );
  const uploadedRecords = useMemo(
    () =>
      sortCustomRecords(
        customRecords.filter((r) => !r.builderDoc && matchesQuery(query, r.name, r.capacity, "uploaded")),
        sortMode
      ),
    [customRecords, query, sortMode]
  );
  const officialDefs = useMemo(() => {
    const filtered = officials.filter((def) => matchesQuery(query, def.name, def.capacity, "official"));
    /* official templates have no createdAt/updatedAt history — the
     * recency sorts keep their canonical order; name/capacity apply */
    if (sortMode === "name") return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    if (sortMode === "capacity") return [...filtered].sort((a, b) => a.capacity - b.capacity || a.name.localeCompare(b.name));
    return filtered;
  }, [officials, query, sortMode]);

  const usedBy = (id: string): number => sheets.filter((sh) => sh.templateId === id).length;

  const exportTemplateFile = (record: CustomTemplateRecord): void => {
    try {
      const json = serializeTemplateFile(record);
      triggerDownload(
        new Blob([json], { type: "application/json;charset=utf-8" }),
        `${templateFileSlug(record.name)}${TEMPLATE_FILE_EXTENSION}`
      );
      toast.success(`Exported “${record.name}”`, {
        description: `A portable ${TEMPLATE_FILE_EXTENSION} file — import it back here on any machine.`,
      });
    } catch (err) {
      console.error("[template-library] export failed", err);
      toast.error("Could not export this template");
    }
  };

  const importTemplateFile = async (file: File): Promise<void> => {
    try {
      const text = await file.text();
      const { record, warnings } = parseTemplateFile(text);
      const imported = useStudio.getState().importCustomTemplate(record, { silent: true });
      toast.success(`Template “${imported.name}” imported — ${imported.capacity} slots ready`, {
        description: warnings.length ? warnings.join(" ") : undefined,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not read this template file.");
    }
  };

  const useTemplate = (def: TemplateDef): void => {
    const sheet = sheets.find((sh) => sh.id === activeSheetId) ?? null;
    if (!sheet) {
      toast.info("Select or create a sheet first", {
        description: "Generate sheets from your icons, then apply a template from here.",
      });
      return;
    }
    if (sheet.templateId === def.id) {
      /* phase 3 — same template but an older pinned revision? point at the
       * explicit update path instead of a flat "already uses it" */
      const live = customRecords.find((r) => r.id === def.id) ?? null;
      const pinned = sheet.templateSnapshot?.version ?? 1;
      if (live && customRecordVersion(live) > pinned) {
        toast.info(`This sheet uses v${pinned} of “${def.name}” (library is at v${customRecordVersion(live)})`, {
          description: "Open the sheet's Properties panel → Template to update it to the latest version.",
        });
        return;
      }
      toast.info(`“${sheet.name ?? def.name}” already uses this template`);
      return;
    }
    if (sheet.iconIds.length > def.capacity) {
      toast.error(`“${def.name}” holds ${def.capacity} icons — this sheet has ${sheet.iconIds.length}`, {
        description: "Remove icons from the sheet (or move them to another sheet) first.",
      });
      return;
    }
    changeSheetTemplate(sheet.id, def.id, "move-next");
    toast.success(`“${sheet.name ?? "Sheet"}” now uses “${def.name}”`);
    onOpenChange(false);
  };

  const searchActive = query.trim().length > 0;
  const noResults =
    searchActive && builderRecords.length === 0 && uploadedRecords.length === 0 && officialDefs.length === 0;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="inspector-shell flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(54rem,calc(100%-2rem))]">
          <DialogHeader className="shrink-0 border-b border-border px-4 py-3.5">
            <DialogTitle className="flex items-center gap-2 text-[15px]">
              <span className="studio-brand-logo grid size-6 place-items-center rounded-md">
                <LayoutTemplate className="size-3.5" />
              </span>
              Template Library
            </DialogTitle>
            <DialogDescription className="text-[11.5px]">
              {officials.length} official (protected) · {builderRecords.length} builder-made ·{" "}
              {uploadedRecords.length} uploaded SVG — builder templates re-open for editing with their exact
              authoring state.
            </DialogDescription>
          </DialogHeader>

          {/* phase 3 toolbar — search, sort, portable template file import */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/60 px-4 py-2.5">
            <div className="relative min-w-[9rem] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, capacity or origin…"
                className="h-8 rounded-lg bg-card pl-8 text-[12px]"
                aria-label="Search templates"
                maxLength={80}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <ArrowDownUp className="size-3.5 text-muted-foreground" aria-hidden />
              <Select value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
                <SelectTrigger size="sm" className="h-8 w-[10.5rem] rounded-lg bg-card text-[12px]" aria-label="Sort templates">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SORT_LABELS.map((s) => (
                    <SelectItem key={s.value} value={s.value} className="text-[11px]">
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              aria-hidden
              tabIndex={-1}
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                e.target.value = "";
                if (file) void importTemplateFile(file);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 rounded-lg px-2.5 text-[11px]"
              onClick={() => fileInputRef.current?.click()}
              title={`Import a portable ${TEMPLATE_FILE_EXTENSION} template file`}
            >
              <Download className="size-3.5 rotate-180" aria-hidden />
              Import file
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto custom-scroll bg-muted/30 px-4 py-4">
            {noResults ? (
              <div className="grid place-items-center py-16 text-center">
                <Search className="mb-3 size-8 text-muted-foreground/50" aria-hidden />
                <p className="text-[13px] font-medium">No templates match “{query.trim()}”</p>
                <p className="mt-1 max-w-xs text-[11.5px] leading-relaxed text-muted-foreground">
                  Search covers template names, capacities and origins (official · builder · uploaded).
                </p>
              </div>
            ) : customRecords.length === 0 && templateLoadErrors.length === 0 ? (
              /* §64 — useful empty state for the custom side of the library */
              <div className="space-y-5">
                <div className="grid place-items-center rounded-xl border border-dashed border-border bg-card/50 py-10 text-center">
                  <Wand2 className="mb-3 size-8 text-muted-foreground/50" aria-hidden />
                  <p className="text-[13px] font-medium">No custom templates yet</p>
                  <p className="mt-1 max-w-xs text-[11.5px] leading-relaxed text-muted-foreground">
                    Create your first icon-sheet template in the Template Builder and save it here — or import a
                    portable {TEMPLATE_FILE_EXTENSION} file.
                  </p>
                </div>
                <section aria-label="Official templates">
                  <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <BadgeCheck className="size-3.5" aria-hidden />
                    Official templates — protected
                  </h3>
                  <div className="space-y-2.5">
                    {officialDefs.map((def) => (
                      <TemplateRow
                        key={def.id}
                        def={def}
                        record={null}
                        origin="official"
                        usedBy={usedBy(def.id)}
                        onEditInBuilder={() => undefined}
                        onRequestDelete={() => undefined}
                        onUsed={useTemplate}
                        onExport={() => undefined}
                      />
                    ))}
                  </div>
                </section>
              </div>
            ) : (
              <div className="space-y-5">
                {/* §59 — broken records stay listed with the exact reason */}
                {templateLoadErrors.length > 0 && (
                  <section aria-label="Broken templates">
                    <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <AlertTriangle className="size-3.5 text-destructive" aria-hidden />
                      Could not be loaded
                    </h3>
                    <div className="space-y-2.5">
                      {templateLoadErrors.map((e) => (
                        <div
                          key={e.id}
                          className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/[0.04] p-3 sm:flex-row sm:items-center"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-semibold leading-tight" title={e.name}>
                              {e.name}
                            </p>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-destructive">{e.reason}</p>
                            <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
                              The record stays safely stored but cannot be used. Sheets already using it keep their
                              layout.
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 shrink-0 gap-1.5 border-destructive/40 px-2.5 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => removeBrokenTemplateRecord(e.id)}
                            title={`Remove the unusable “${e.name}” record`}
                          >
                            <Trash2 className="size-3" aria-hidden />
                            Remove
                          </Button>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {builderRecords.length > 0 && (
                  <section aria-label="Builder templates">
                    <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <PencilRuler className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
                      Builder templates
                    </h3>
                    <div className="space-y-2.5">
                      {builderRecords.map((r) => (
                        <TemplateRow
                          key={r.id}
                          def={buildCustomTemplate(r)}
                          record={r}
                          origin="builder"
                          usedBy={usedBy(r.id)}
                          onEditInBuilder={onEditInBuilder}
                          onRequestDelete={setPendingDelete}
                          onUsed={useTemplate}
                          onExport={exportTemplateFile}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {uploadedRecords.length > 0 && (
                  <section aria-label="Uploaded SVG templates">
                    <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <FileUp className="size-3.5 text-zinc-500 dark:text-zinc-400" aria-hidden />
                      Uploaded SVG templates
                    </h3>
                    <div className="space-y-2.5">
                      {uploadedRecords.map((r) => (
                        <TemplateRow
                          key={r.id}
                          def={buildCustomTemplate(r)}
                          record={r}
                          origin="uploaded"
                          usedBy={usedBy(r.id)}
                          onEditInBuilder={onEditInBuilder}
                          onRequestDelete={setPendingDelete}
                          onUsed={useTemplate}
                          onExport={exportTemplateFile}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {officialDefs.length > 0 && (
                  <section aria-label="Official templates">
                    <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <BadgeCheck className="size-3.5" aria-hidden />
                      Official templates — protected
                    </h3>
                    <div className="space-y-2.5">
                      {officialDefs.map((def) => (
                        <TemplateRow
                          key={def.id}
                          def={def}
                          record={null}
                          origin="official"
                          usedBy={usedBy(def.id)}
                          onEditInBuilder={() => undefined}
                          onRequestDelete={() => undefined}
                          onUsed={useTemplate}
                          onExport={() => undefined}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* delete confirmation — never a single accidental misclick. phase 3:
       * deleting while sheets use the template is ALLOWED — every sheet
       * carries an immutable snapshot and keeps rendering exactly as before. */}
      <AlertDialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This template will be removed from your Template Library.{" "}
              {(() => {
                const using = pendingDelete ? usedBy(pendingDelete.id) : 0;
                return using > 0
                  ? `${using} sheet${using === 1 ? "" : "s"} currently use it — they keep their current layout via their embedded template snapshot and can be switched to another template any time.`
                  : "";
              })()}
              {" "}This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) deleteCustomTemplate(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete template
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
