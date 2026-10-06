"use client";

/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 1) · draft list / empty state.
 *
 * No open document → this surface. Zero drafts: a calm "create your
 * first template" card. Existing drafts: a card grid with open/delete,
 * plus New Template and Import SVG (imports create a new draft).
 */

import { useRef, useState } from "react";
import { toast } from "sonner";
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
import { FileCode2, FolderOpen, Layers, Library, Plus, Trash2, Wand2 } from "lucide-react";
import { useBuilderStore, getActiveDoc } from "@/lib/builder/store";
import { createElement, newId, type SvgElementProperties } from "@/lib/builder/types";
import { importSvgFile } from "@/lib/builder/svg-import";
import { cn } from "@/lib/utils";

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function BuilderDrafts({ onNewTemplate, onOpenLibrary }: { onNewTemplate: () => void; onOpenLibrary: () => void }) {
  const docs = useBuilderStore((s) => s.docs);
  const openDocument = useBuilderStore((s) => s.openDocument);
  const deleteDocument = useBuilderStore((s) => s.deleteDocument);
  const createDocument = useBuilderStore((s) => s.createDocument);
  const addElement = useBuilderStore((s) => s.addElement);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const importAsNewDoc = async (files: FileList | null): Promise<void> => {
    const file = files?.[0];
    if (!file) return;
    try {
      const imported = await importSvgFile(file);
      const name = file.name.replace(/\.svg$/i, "").slice(0, 80) || "Imported template";
      const id = createDocument({ name, width: 1200, height: 1200, background: "#FFFFFF" });
      void id;
      const doc = getActiveDoc(useBuilderStore.getState());
      if (!doc) return;
      const maxSide = 480;
      const scale = Math.min(1, maxSide / Math.max(imported.sourceWidth, imported.sourceHeight));
      const w = Math.round(imported.sourceWidth * scale);
      const h = Math.round(imported.sourceHeight * scale);
      const el = createElement({
        type: "svg",
        artboard: doc.artboard,
        x: Math.round((doc.artboard.width - w) / 2),
        y: Math.round((doc.artboard.height - h) / 2),
        width: w,
        height: h,
        name,
        properties: {
          svg: imported.svg,
          viewBox: imported.viewBox,
          sourceWidth: imported.sourceWidth,
          sourceHeight: imported.sourceHeight,
        } satisfies SvgElementProperties,
      });
      el.id = newId("el");
      addElement(el);
      if (imported.warnings.length) toast.warning(`Imported — ${imported.warnings.join(" · ")}`);
      toast.success(`"${name}" created from SVG — full vector data preserved`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not import "${file.name}".`);
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const deleting = docs.find((d) => d.id === pendingDelete) ?? null;

  return (
    <div className="flex-1 overflow-y-auto custom-scroll bg-muted/30">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:py-14">
        <input
          ref={fileRef}
          type="file"
          accept=".svg,image/svg+xml"
          className="hidden"
          onChange={(e) => void importAsNewDoc(e.target.files)}
          aria-label="Import an SVG file as a new template draft"
        />

        {docs.length === 0 ? (
          <div className="mx-auto max-w-md space-y-5 text-center">
            <div className="relative mx-auto grid size-12 place-items-center" aria-hidden="true">
              <span className="empty-state-halo absolute inset-0 rounded-full" />
              <span className="studio-brand-logo relative grid size-12 place-items-center rounded-xl">
                <Wand2 className="size-5" />
              </span>
            </div>
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold tracking-tight">Create your first template</h2>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                Design reusable icon-sheet layouts — artboard, icon grid, semantic text roles and decorative artwork —
                saved as structured drafts.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2.5">
              <Button onClick={onNewTemplate} className="gap-1.5">
                <Plus className="h-4 w-4" />
                New Template
              </Button>
              <Button variant="outline" onClick={() => fileRef.current?.click()} className="gap-1.5">
                <FileCode2 className="h-4 w-4" />
                Import SVG
              </Button>
              <Button variant="outline" onClick={onOpenLibrary} className="gap-1.5">
                <Library className="h-4 w-4" />
                Template Library
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold tracking-tight">Your template drafts</h2>
                <p className="text-[11.5px] text-muted-foreground">
                  {docs.length} draft{docs.length === 1 ? "" : "s"} · stored locally in your browser
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={onOpenLibrary} className="gap-1.5">
                  <Library className="h-3.5 w-3.5" />
                  Library
                </Button>
                <Button onClick={onNewTemplate} size="sm" className="gap-1.5">
                  <Plus className="h-3.5 w-3.5" />
                  New Template
                </Button>
                <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} className="gap-1.5">
                  <FileCode2 className="h-3.5 w-3.5" />
                  Import SVG
                </Button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {docs.map((doc) => (
                <div
                  key={doc.id}
                  className={cn(
                    "group flex flex-col gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-xs transition-colors hover:border-ring/40"
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold">{doc.name}</p>
                      <p className="mt-0.5 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                        {doc.artboard.width} × {doc.artboard.height} · {doc.elements.length} elements
                      </p>
                    </div>
                    <span
                      className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"
                      aria-hidden="true"
                    >
                      <Layers className="size-3.5" />
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[10.5px] text-muted-foreground/80">
                      {formatDate(doc.metadata.updatedAt)}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-[11px]" onClick={() => openDocument(doc.id)}>
                        <FolderOpen className="h-3 w-3" />
                        Open
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-destructive"
                        onClick={() => setPendingDelete(doc.id)}
                        aria-label={`Delete draft "${doc.name}"`}
                        title="Delete draft"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleting?.name}” and its {deleting?.elements.length ?? 0} elements will be removed permanently. This does
              not touch any studio sheets or official templates.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleting) deleteDocument(deleting.id);
                setPendingDelete(null);
                toast.success("Draft deleted");
              }}
            >
              Delete draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
