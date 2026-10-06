"use client";

/**
 * ICON SHEET STUDIO — Library catalog export dialog (round 6).
 *
 * Exports the whole workspace metadata as JSON (structured, complete) or
 * CSV (flat spreadsheet rows: one row per icon). Cataloging workflows get
 * tags, assignments, categories/volumes and technical SVG facts — but
 * never the SVG sources themselves (metadata only, local-first: the data
 * leaves the browser only through this explicit download).
 */

import { useMemo, useState } from "react";
import type { JSX } from "react";
import { toast } from "sonner";
import { Braces, FileDown, Sheet, Tags, Grid3x3, Shapes, PackageOpen, Filter } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useStudio } from "@/lib/studio/store";
import { buildLibraryFilterScope } from "@/lib/studio/filter";
import {
  buildLibraryCatalog,
  downloadCatalog,
  type CatalogFormat,
  type CatalogScope,
} from "@/lib/studio/catalog";
import { cn } from "@/lib/utils";

interface StatDef {
  key: string;
  label: string;
  value: number;
  icon: typeof Tags;
}

export function CatalogDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const icons = useStudio((s) => s.icons);
  const iconOrder = useStudio((s) => s.iconOrder);
  const sheets = useStudio((s) => s.sheets);
  const libraryFilter = useStudio((s) => s.libraryFilter);

  const [format, setFormat] = useState<CatalogFormat>("json");
  const [scopeMode, setScopeMode] = useState<"all" | "filtered">("all");

  /* ---- current-filter scope (round 7: round-6 rec #5) — uses the SHARED
   * filter semantics from lib/studio/filter.ts so the catalog scope always
   * mirrors exactly what the library panel shows (query + multi-tag AND/OR
   * + unassigned mode). */
  const filterScope = useMemo(() => {
    const scope = buildLibraryFilterScope({
      icons,
      iconOrder,
      sheets,
      filter: {
        query: libraryFilter.query,
        tags: libraryFilter.tags,
        tagLogic: libraryFilter.tagLogic,
        mode: libraryFilter.mode,
      },
    });
    return scope;
  }, [libraryFilter, icons, iconOrder, sheets]);

  const useFilterScope = scopeMode === "filtered" && filterScope !== null && filterScope.ids.length > 0;
  const scope: CatalogScope | undefined = useFilterScope
    ? { label: filterScope.label, iconIds: filterScope.ids }
    : undefined;

  const catalog = useMemo(
    () => (open ? buildLibraryCatalog({ icons, iconOrder, sheets }, scope) : null),
    [open, icons, iconOrder, sheets, scope],
  );

  const stats: StatDef[] = useMemo(() => {
    if (!catalog) return [];
    return [
      { key: "icons", label: "Icons", value: catalog.summary.icons, icon: Shapes },
      { key: "sheets", label: "Sheets", value: catalog.summary.sheets, icon: Grid3x3 },
      { key: "tags", label: "Tags", value: catalog.summary.tags, icon: Tags },
      { key: "cats", label: "Categories", value: catalog.summary.categories, icon: PackageOpen },
    ];
  }, [catalog]);

  function exportNow(): void {
    if (!catalog || catalog.summary.icons === 0) return;
    const filename = downloadCatalog(catalog, format);
    toast.success(`Catalog exported — ${filename}`, {
      description:
        format === "json"
          ? "Structured JSON with summary, tags, sheets and per-icon metadata"
          : "Flat CSV — one row per icon, ready for spreadsheets",
    });
    onOpenChange(false);
  }

  const empty = catalog === null || catalog.summary.icons === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span className="studio-dlg-tile">
              <FileDown className="h-4 w-4" aria-hidden="true" />
            </span>
            Export library catalog
          </DialogTitle>
          <DialogDescription className="text-[11px] leading-relaxed">
            Metadata for every icon — tags, sheet assignments, categories &amp; volumes and
            technical SVG facts — as a file you own. SVG sources are never included.
          </DialogDescription>
        </DialogHeader>

        {empty ? (
          <div className="grid place-items-center px-5 py-10 text-center">
            <div className="studio-empty-glyph mb-2.5">
              <FileDown className="h-5 w-5" aria-hidden="true" />
            </div>
            <p className="text-[12px] font-medium text-foreground/80">Nothing to catalog yet.</p>
            <p className="text-[11px] hint-text">
              Upload a few icons first — the catalog covers the whole library.
            </p>
          </div>
        ) : (
          <div className="space-y-3 px-5 py-4">
            {/* summary stat grid */}
            <div className="cat-stats grid grid-cols-4 gap-2" aria-hidden="true">
              {stats.map(({ key, label, value, icon: Icon }) => (
                <div
                  key={key}
                  className="rounded-lg border border-border/70 bg-muted/30 px-2 py-2 text-center dark:border-border"
                >
                  <Icon className="mx-auto mb-1 h-3.5 w-3.5 text-amber-600/80" />
                  <p className="font-mono text-[14px] font-semibold leading-none tabular-nums">
                    {value.toLocaleString()}
                  </p>
                  <p className="mt-1 text-[9px] font-medium uppercase tracking-wider hint-text">
                    {label}
                  </p>
                </div>
              ))}
            </div>

            {/* scope choice (round 7): whole library vs current filter */}
            {filterScope && filterScope.ids.length > 0 ? (
              <div>
                <p className="studio-group-label mb-1.5">
                  Scope
                </p>
                <ToggleGroup
                  type="single"
                  value={scopeMode}
                  onValueChange={(v) => {
                    if (v === "all" || v === "filtered") setScopeMode(v);
                  }}
                  variant="outline"
                  className="grid w-full grid-cols-2"
                >
                  <ToggleGroupItem
                    value="all"
                    aria-label="Whole library scope"
                    className="studio-choice h-8 rounded-lg text-[11px]"
                  >
                    Whole library
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="filtered"
                    aria-label="Current filter scope"
                    className="studio-choice h-8 gap-1.5 rounded-lg text-[11px]"
                  >
                    <Filter className="h-3 w-3" aria-hidden="true" />
                    Current filter ({filterScope.ids.length})
                  </ToggleGroupItem>
                </ToggleGroup>
                <p className="mt-1.5 truncate text-[10.5px] hint-text" title={filterScope.label}>
                  {scopeMode === "filtered"
                    ? `${filterScope.label} — sheets and tags outside the subset are omitted`
                    : `The library panel is filtered (${filterScope.ids.length} of ${iconOrder.length}) — switch scope to export only those`}
                </p>
              </div>
            ) : null}

            {/* format choice */}
            <div>
              <p className="studio-group-label mb-1.5">
                Format
              </p>
              <ToggleGroup
                type="single"
                value={format}
                onValueChange={(v) => {
                  if (v === "json" || v === "csv") setFormat(v);
                }}
                variant="outline"
                className="grid w-full grid-cols-2"
              >
                <ToggleGroupItem
                  value="json"
                  aria-label="JSON format"
                  className="studio-choice h-8 gap-1.5 rounded-lg text-[11px]"
                >
                  <Braces className="h-3.5 w-3.5" aria-hidden="true" />
                  JSON · structured
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="csv"
                  aria-label="CSV format"
                  className="studio-choice h-8 gap-1.5 rounded-lg text-[11px]"
                >
                  <Sheet className="h-3.5 w-3.5" aria-hidden="true" />
                  CSV · spreadsheet
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            {/* per-format detail note */}
            <div
              className={cn(
                "rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground",
              )}
              aria-live="polite"
            >
              {format === "json" ? (
                <>
                  One structured file: <span className="text-foreground">summary</span>,{" "}
                  <span className="text-foreground">tags</span> with counts,{" "}
                  <span className="text-foreground">sheets</span> and one record per{" "}
                  <span className="text-foreground">icon</span> (viewBox, nature, stroke width,
                  content hash, assignment, tags).
                </>
              ) : (
                <>
                  One flat table — a header row plus{" "}
                  <span className="text-foreground">
                    {catalog ? catalog.summary.icons.toLocaleString() : 0} icon rows
                  </span>
                  . Tags are joined with <span className="font-mono">|</span>; unassigned icons
                  have empty sheet/cell columns.
                </>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="studio-dlg-footer px-5 py-3">
          <span className="hint-text mr-auto hidden items-center gap-1.5 text-[10px] sm:inline-flex">
            <Tags className="h-3 w-3" aria-hidden="true" />
            local-first — nothing leaves this browser but the file
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-3 text-[11px]"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1.5 bg-amber-700 px-3 text-[11px] hover:bg-amber-800"
            onClick={exportNow}
            disabled={empty}
          >
            <FileDown className="h-3.5 w-3.5" aria-hidden="true" />
            Export {format === "json" ? "JSON" : "CSV"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
