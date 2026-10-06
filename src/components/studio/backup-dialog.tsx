"use client";

/**
 * ICON SHEET STUDIO — Workspace backup & restore dialog (round 3).
 *
 * The workspace is local-first: everything lives in this browser's
 * IndexedDB. This dialog offers the two safety valves:
 *   · DOWNLOAD  — one JSON document with the ENTIRE workspace (icons with
 *                 SVG sources, sheets + designs, custom templates, user
 *                 design presets, ordering, settings).
 *   · RESTORE   — pick a backup file, preview what it contains, then
 *                 replace the current workspace with it (destructive,
 *                 confirmed explicitly, history reset).
 */

import { useCallback, useRef, useState } from "react";
import type { JSX } from "react";
import { toast } from "sonner";
import {
  ArchiveRestore,
  CheckCircle2,
  FileJson,
  Grid3x3,
  HardDriveDownload,
  Layers,
  Package,
  TriangleAlert,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { useStudio } from "@/lib/studio/store";
import { parseWorkspaceBackup, type WorkspaceBackup } from "@/lib/studio/backup";
import { triggerDownload } from "@/lib/studio/export";

function backupFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `icon-sheet-studio-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

/** Safety net filename for the automatic pre-restore snapshot. */
function preRestoreFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `icon-sheet-studio-pre-restore-${stamp}.json`;
}

interface RestorePreview {
  backup: WorkspaceBackup;
  warnings: string[];
  fileName: string;
  sizeLabel: string;
}

export function BackupDialog(): JSX.Element {
  const open = useStudio((s) => s.backupDialogOpen);
  const setBackupDialogOpen = useStudio((s) => s.setBackupDialogOpen);
  const buildBackupJson = useStudio((s) => s.buildBackupJson);
  const restoreWorkspace = useStudio((s) => s.restoreWorkspace);
  const iconCount = useStudio((s) => s.iconOrder.length);
  const sheetCount = useStudio((s) => s.sheets.length);
  const templateCount = useStudio((s) => s.customTemplates.length);
  const presetCount = useStudio((s) => s.designPresets.length);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [restoring, setRestoring] = useState(false);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const empty = iconCount === 0 && sheetCount === 0;

  const handleDownload = useCallback(() => {
    try {
      const json = buildBackupJson();
      const blob = new Blob([json], { type: "application/json" });
      triggerDownload(blob, backupFilename());
      const kb = Math.max(1, Math.round(blob.size / 1024));
      toast.success("Workspace backup downloaded", {
        description: `${iconCount.toLocaleString()} icons · ${sheetCount.toLocaleString()} sheets · ${kb.toLocaleString()} KB — keep it somewhere safe.`,
      });
    } catch (err) {
      console.error("[backup] download failed", err);
      toast.error("Could not build the backup", {
        description: "Your workspace is untouched — try again.",
      });
    }
  }, [buildBackupJson, iconCount, sheetCount]);

  const handleFilePicked = useCallback(async (file: File) => {
    setRestoreError(null);
    try {
      const text = await file.text();
      const { backup, warnings } = parseWorkspaceBackup(text);
      setPreview({
        backup,
        warnings,
        fileName: file.name,
        sizeLabel: `${Math.max(1, Math.round(file.size / 1024)).toLocaleString()} KB`,
      });
    } catch (err) {
      setPreview(null);
      setRestoreError(err instanceof Error ? err.message : "Could not read this file.");
    }
  }, []);

  const handleRestore = useCallback(async () => {
    if (!preview) return;
    setRestoring(true);
    /* SAFETY NET: automatically download the CURRENT workspace before it
     * is replaced — a bad restore is then always recoverable. Failures here
     * never block the restore itself. */
    let autoBackedUp = false;
    try {
      if (iconCount > 0 || sheetCount > 0) {
        const json = buildBackupJson();
        triggerDownload(new Blob([json], { type: "application/json" }), preRestoreFilename());
        autoBackedUp = true;
      }
    } catch {
      /* safety-net failure should not block the restore */
    }
    const result = await restoreWorkspace(JSON.stringify(preview.backup));
    setRestoring(false);
    if (result.ok) {
      const b = preview.backup;
      toast.success("Workspace restored from backup", {
        description: `${b.icons.length.toLocaleString()} icons · ${b.sheets.length.toLocaleString()} sheets${
          autoBackedUp ? " · previous workspace auto-saved as a pre-restore backup" : ""
        }${result.warnings.length ? ` · ${result.warnings.length} note${result.warnings.length === 1 ? "" : "s"}` : ""}`,
      });
      setPreview(null);
      setRestoreError(null);
    } else {
      setRestoreError(result.error ?? "Restoring failed.");
    }
  }, [preview, restoreWorkspace, buildBackupJson, iconCount, sheetCount]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setBackupDialogOpen(next);
      if (!next) {
        setPreview(null);
        setRestoreError(null);
        setRestoring(false);
      }
    },
    [setBackupDialogOpen]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md p-0 overflow-hidden gap-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span className="studio-dlg-tile">
              <HardDriveDownload className="h-4 w-4" aria-hidden="true" />
            </span>
            Workspace backup
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            Your workspace lives only in this browser. Download a backup to move it to another
            machine — or bring one back.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 pb-5 space-y-4">
          {/* ---- download ------------------------------------------------ */}
          <section className="backup-card">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-[13px] font-medium">Download a backup</h3>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Everything: icons, sheets, designs, templates, presets.
                </p>
              </div>
              <Button
                size="sm"
                className="h-8 gap-1.5 shrink-0"
                onClick={handleDownload}
                disabled={empty}
                aria-label="Download the full workspace as a JSON backup"
              >
                <HardDriveDownload className="h-3.5 w-3.5" />
                Download
              </Button>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-1.5">
              {[
                { icon: Grid3x3, label: "icons", value: iconCount },
                { icon: Layers, label: "sheets", value: sheetCount },
                { icon: Package, label: "templates", value: templateCount },
                { icon: FileJson, label: "presets", value: presetCount },
              ].map(({ icon: Icon, label, value }) => (
                <div
                  key={label}
                  className="flex flex-col items-center gap-0.5 rounded-md border border-border/70 bg-muted/30 px-1 py-1.5 dark:border-border"
                  title={`${value.toLocaleString()} ${label} in the backup`}
                >
                  <Icon className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                  <span className="text-[12px] font-medium tabular-nums leading-none">
                    {value.toLocaleString()}
                  </span>
                  <span className="text-[9px] text-muted-foreground leading-none">{label}</span>
                </div>
              ))}
            </div>
            {empty ? (
              <p className="mt-2 text-[10px] text-muted-foreground">
                The workspace is empty — load icons first, then back it up.
              </p>
            ) : null}
          </section>

          <div className="flex items-center gap-3 px-1">
            <Separator className="flex-1" />
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">or</span>
            <Separator className="flex-1" />
          </div>

          {/* ---- restore ------------------------------------------------- */}
          <section className="backup-card">
            <h3 className="text-[13px] font-medium">Restore from a backup</h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Replaces everything currently in this browser.
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              aria-label="Pick a backup JSON file"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                e.target.value = "";
                if (file) void handleFilePicked(file);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="mt-3 h-8 w-full gap-1.5"
              onClick={() => fileInputRef.current?.click()}
              disabled={restoring}
              aria-label="Pick a backup JSON file to restore"
            >
              <Upload className="h-3.5 w-3.5" />
              Choose backup file…
            </Button>

            {restoreError ? (
              <p
                role="alert"
                className="mt-3 flex items-start gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] leading-snug text-red-700 dark:text-red-400"
              >
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                {restoreError}
              </p>
            ) : null}

            {preview ? (
              <div className="mt-3 space-y-3">
                <div className="rounded-md border border-border/70 bg-muted/30 p-2.5 dark:border-border">
                  <p className="flex items-center gap-1.5 text-[11px] font-medium">
                    <CheckCircle2
                      className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400"
                      aria-hidden="true"
                    />
                    {preview.fileName}
                    <span className="font-normal text-muted-foreground">· {preview.sizeLabel}</span>
                  </p>
                  <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <div className="flex justify-between gap-2">
                      <dt>Icons</dt>
                      <dd className="tabular-nums text-foreground">
                        {preview.backup.icons.length.toLocaleString()}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>Sheets</dt>
                      <dd className="tabular-nums text-foreground">
                        {preview.backup.sheets.length.toLocaleString()}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>Templates</dt>
                      <dd className="tabular-nums text-foreground">
                        {preview.backup.customTemplates.length.toLocaleString()}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>Exported</dt>
                      <dd className="text-foreground">
                        {new Date(preview.backup.exportedAt).toLocaleDateString()}
                      </dd>
                    </div>
                  </dl>
                  {preview.warnings.length > 0 ? (
                    <ul className="mt-2 space-y-1 border-t border-border/60 pt-2 dark:border-border/80">
                      {preview.warnings.slice(0, 3).map((w, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-[10px] leading-snug text-amber-700 dark:text-amber-400">
                          <TriangleAlert className="mt-0.5 h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                          {w}
                        </li>
                      ))}
                      {preview.warnings.length > 3 ? (
                        <li className="text-[10px] text-muted-foreground">
                          +{preview.warnings.length - 3} more notes after restoring
                        </li>
                      ) : null}
                    </ul>
                  ) : null}
                </div>

                <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                  Restoring <strong className="font-medium text-foreground">replaces</strong> the
                  {empty ? " empty workspace" : ` ${iconCount.toLocaleString()} icons and ${sheetCount.toLocaleString()} sheets`} currently
                  in this browser. A safety backup of it downloads automatically
                  first. Undo history starts fresh.
                </p>

                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 flex-1"
                    onClick={() => {
                      setPreview(null);
                      setRestoreError(null);
                    }}
                    disabled={restoring}
                  >
                    Choose another file
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 flex-1 gap-1.5 bg-red-600 text-white hover:bg-red-700"
                    onClick={handleRestore}
                    disabled={restoring}
                    aria-label="Replace the current workspace with this backup"
                  >
                    <ArchiveRestore className="h-3.5 w-3.5" />
                    {restoring ? "Restoring…" : "Restore workspace"}
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
