"use client";

/**
 * Duplicate Icons Detected — the ONE confirmation dialog in the import
 * pipeline. It is driven entirely by the store (duplicateAsk state set by
 * importWithDuplicateCheck) and mounted once at the studio shell, so EVERY
 * upload surface — file picker, drag & drop, sample loader, command
 * palette — goes through the same ask-first contract. No import path can
 * silently discard duplicates: importFiles itself contains no duplicate
 * logic at all; the only place duplicates are excluded is the skip-filter
 * in importWithDuplicateCheck, which runs AFTER the user answers here.
 *
 * THREE explicit outcomes — the user always controls the decision:
 *   · Add Duplicates  — every file imports; duplicates become separate,
 *     independent records (own tags and sheet placement); existing icons
 *     are never touched, merged or replaced.
 *   · Skip Duplicates — only the non-duplicate files import.
 *   · Cancel          — the ENTIRE import is aborted safely: nothing is
 *     imported, nothing is deleted, the library is unchanged.
 * ESC / outside-click = Cancel (the safest default).
 */

import type { JSX } from "react";
import { ArrowRightLeft, CopyX } from "lucide-react";
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
import { useStudio } from "@/lib/studio/store";

export function DuplicateImportDialog(): JSX.Element | null {
  const ask = useStudio((s) => s.duplicateAsk);
  const resolveDuplicateAsk = useStudio((s) => s.resolveDuplicateAsk);
  const scan = ask?.scan ?? null;
  if (!scan) return null;
  const count = scan.duplicates.length;

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        /* ESC / outside-click = Cancel — the safest default: the ENTIRE
         * import is aborted (nothing imported, nothing deleted, the
         * existing library is unchanged). */
        if (!open) resolveDuplicateAsk("cancel");
      }}
    >
      <AlertDialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <AlertDialogHeader className="border-b border-border/70 px-5 pb-3 pt-5 dark:border-border">
          <AlertDialogTitle className="flex items-center gap-2 text-left font-semibold tracking-tight">
            <span
              className="studio-dlg-tile"
              aria-hidden="true"
            >
              <CopyX className="size-4" />
            </span>
            Duplicate Icons Detected
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2.5 px-5 py-4 text-left">
              <p>
                <span className="font-medium text-foreground">{count}</span> duplicate{" "}
                {count === 1 ? "icon was" : "icons were"} found —{" "}
                {count === 1 ? "this icon already exists" : "these icons already exist"} in your
                library.
              </p>
              <ul className="max-h-28 space-y-1 overflow-y-auto custom-scroll rounded-lg border border-border/70 bg-muted/40 p-2 dark:border-border">
                {scan.duplicates.slice(0, 6).map((d) => (
                  <li key={d.fileName} className="studio-row flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground">
                    {/* artwork preview — the duplicate is content-identical to
                        the library copy, so ONE thumbnail shows exactly what
                        would be added (round 14; the ask dialog is the first
                        dialog new users meet — it should speak in glyphs) */}
                    {d.svg ? (
                      <span
                        className="dup-preview grid size-6 shrink-0 place-items-center overflow-hidden rounded-md text-foreground [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
                        aria-hidden="true"
                        dangerouslySetInnerHTML={{ __html: d.svg }}
                      />
                    ) : null}
                    <span className="truncate font-medium text-foreground">{d.fileName}</span>
                    {d.existingName !== d.fileName ? (
                      <>
                        <ArrowRightLeft className="size-3 shrink-0 opacity-50" aria-hidden="true" />
                        <span className="truncate">{d.existingName}</span>
                      </>
                    ) : (
                      <span className="shrink-0 opacity-60">· already in library</span>
                    )}
                  </li>
                ))}
                {count > 6 ? (
                  <li className="text-[11px] text-muted-foreground/70">+ {count - 6} more…</li>
                ) : null}
              </ul>
              <p>
                Do you want to add the duplicates?{" "}
                <span className="text-foreground">Add Duplicates</span> keeps every uploaded icon
                as separate records;{" "}
                <span className="text-foreground">Skip Duplicates</span> imports only the unique
                files; <span className="text-foreground">Cancel</span> aborts the whole import —
                nothing is added, nothing is deleted.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="studio-dlg-footer px-5 py-3 sm:justify-between">
          <AlertDialogCancel
            className="dup-cancel order-1 sm:order-none"
            onClick={(e) => {
              e.preventDefault();
              resolveDuplicateAsk("cancel");
            }}
          >
            Cancel
          </AlertDialogCancel>
          <div className="flex gap-2">
            <AlertDialogCancel
              className="dup-skip"
              onClick={(e) => {
                e.preventDefault();
                resolveDuplicateAsk("skip");
              }}
            >
              Skip Duplicates
            </AlertDialogCancel>
            <AlertDialogAction
              className="studio-cta"
              onClick={(e) => {
                e.preventDefault();
                resolveDuplicateAsk("add");
              }}
            >
              Add Duplicates
            </AlertDialogAction>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
