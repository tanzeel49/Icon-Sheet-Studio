"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  HardDrive,
  FolderOpen,
  History,
  RotateCcw,
  ShieldCheck,
  Download,
  Upload,
  Sparkles,
  Layers,
  Image as ImageIcon,
  CheckCircle2,
  FileArchive,
  RefreshCw,
} from "lucide-react";
import { useStudio } from "@/lib/studio/store";
import {
  getStorageHealth,
  openProjectFolder,
  createProjectBackup,
  listProjectBackups,
  restoreProjectBackup,
  type StorageHealth,
  type BackupInfo,
} from "@/lib/studio/project-manager";
import { saveFileNative } from "@/lib/studio/desktop";
import { toast } from "sonner";

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(ts: number | null | undefined): string {
  if (!ts) return "Not saved yet";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function StorageRecoveryDialog() {
  const open = useStudio((s) => s.storageHealthOpen);
  const setOpen = useStudio((s) => s.setStorageHealthOpen);
  const projectName = useStudio((s) => s.projectName);
  const currentRevision = useStudio((s) => s.projectRevision);
  const lastSavedAt = useStudio((s) => s.lastSavedAt);
  const saveStatus = useStudio((s) => s.saveStatus);
  const setVersionHistoryOpen = useStudio((s) => s.setVersionHistoryOpen);
  const saveProjectNow = useStudio((s) => s.saveProjectNow);
  const hasYesterdayRecovery = useStudio((s) => s.hasYesterdayRecovery);
  const yesterdayStats = useStudio((s) => s.yesterdayStats);
  const restoreYesterdayProject = useStudio((s) => s.restoreYesterdayProject);
  const hydrate = useStudio((s) => s.hydrate);

  const [health, setHealth] = useState<StorageHealth | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoringYesterday, setRestoringYesterday] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [h, bList] = await Promise.all([
        getStorageHealth(),
        listProjectBackups(),
      ]);
      setHealth(h);
      setBackups(bList);
    } catch (err) {
      console.error("Failed to load storage health", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadData();
    }
  }, [open, loadData]);

  const handleOpenFolder = async () => {
    try {
      await openProjectFolder();
      toast.success("Opened project directory in Windows Explorer");
    } catch (err) {
      toast.error("Failed to open directory: " + String(err));
    }
  };

  const handleCreateBackup = async () => {
    setCreatingBackup(true);
    try {
      const b = await createProjectBackup();
      if (b) {
        toast.success("Project backup created successfully!", {
          description: `Saved to ${b.filename} (${formatBytes(b.size)})`,
        });
        await loadData();
      }
    } catch (err) {
      toast.error("Failed to create backup: " + String(err));
    } finally {
      setCreatingBackup(false);
    }
  };

  const handleExportBackup = async () => {
    try {
      // First ensure project is saved
      await saveProjectNow("Export project backup");
      const healthInfo = await getStorageHealth();
      if (!healthInfo?.project_path) {
        toast.error("No saved project file found to export.");
        return;
      }

      // Read active project
      const { invoke } = await import("@tauri-apps/api/core");
      const raw = await invoke<string | null>("load_project_native");
      if (!raw) {
        toast.error("Project file is empty.");
        return;
      }

      const blob = new Blob([raw], { type: "application/json" });
      const defaultName = `${projectName.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}_backup_${Date.now()}.issproj`;
      const res = await saveFileNative(blob, defaultName, "Icon Sheet Studio Project (.issproj)");

      if (res.saved) {
        toast.success("Project backup exported successfully!", {
          description: `Saved to ${res.filePath}`,
        });
      }
    } catch (err) {
      toast.error("Export backup failed: " + String(err));
    }
  };

  const handleRestoreBackup = async (backupPath: string) => {
    const confirm = window.confirm(
      "Restore this backup?\n\nA safety checkpoint of your current work will be created automatically before restoring."
    );
    if (!confirm) return;

    try {
      const doc = await restoreProjectBackup(backupPath);
      if (doc) {
        toast.success("Backup restored successfully!");
        setOpen(false);
        await hydrate();
      }
    } catch (err) {
      toast.error("Failed to restore backup: " + String(err));
    }
  };

  const handleRestoreYesterday = async () => {
    const confirm = window.confirm(
      "Restore yesterday's recovered project?\n\nThis will restore all 32 sheets and 960 icons from yesterday's session. A safety checkpoint of your current state will be preserved automatically."
    );
    if (!confirm) return;

    setRestoringYesterday(true);
    try {
      const ok = await restoreYesterdayProject();
      if (ok) {
        toast.success("Yesterday's work restored successfully!", {
          description: "All 32 sheets and 960 icons have been loaded into the workspace.",
        });
        setOpen(false);
      } else {
        toast.error("Failed to restore yesterday's project.");
      }
    } catch (err) {
      toast.error("Restoration failed: " + String(err));
    } finally {
      setRestoringYesterday(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-6 space-y-4">
        <DialogHeader className="shrink-0 space-y-1">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 grid place-items-center">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold">Storage & Data Safety</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Authoritative desktop persistence, rolling backups, and crash protection.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          {/* Yesterday's Work Bridge Card (if present) */}
          {hasYesterdayRecovery && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300 bg-amber-500/20 px-2 py-0.5 rounded-full border border-amber-500/30">
                      <Sparkles className="h-3 w-3" />
                      Yesterday's Work Recovered
                    </span>
                  </div>
                  <h4 className="text-sm font-semibold text-foreground">
                    Icon Collection (Vol 01 - 35)
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    Contains {yesterdayStats?.sheetsCount ?? 32} sheets and {yesterdayStats?.iconsCount ?? 960} icons from yesterday's session preserved in storage.
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={handleRestoreYesterday}
                  disabled={restoringYesterday}
                  className="bg-amber-600 hover:bg-amber-700 text-white text-xs gap-1.5 shrink-0 shadow-sm"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {restoringYesterday ? "Restoring…" : "Restore All 32 Sheets"}
                </Button>
              </div>
            </div>
          )}

          {/* Active Project Card */}
          <div className="rounded-xl border border-border/80 bg-muted/20 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-primary" />
                <span className="text-xs font-semibold text-foreground">Authoritative Storage</span>
              </div>
              <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                Active & Persistent
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs pt-1">
              <div>
                <span className="text-muted-foreground">Project Name:</span>
                <p className="font-medium text-foreground">{projectName}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Revision:</span>
                <p className="font-mono font-medium text-foreground">Rev {currentRevision}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Last Saved:</span>
                <p className="font-mono text-foreground">{formatDate(lastSavedAt || health?.last_saved)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Project Size:</span>
                <p className="font-mono text-foreground">{formatBytes(health?.project_size ?? 0)}</p>
              </div>
            </div>

            <div className="pt-2 border-t border-border/60 flex items-center justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenFolder}
                className="text-xs gap-1.5 h-8"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Open Storage Folder
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  setVersionHistoryOpen(true);
                }}
                className="text-xs gap-1.5 h-8"
              >
                <History className="h-3.5 w-3.5" />
                Version History ({health?.checkpoint_count ?? 0})
              </Button>
            </div>
          </div>

          {/* Backups Section */}
          <div className="rounded-xl border border-border/80 bg-muted/20 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileArchive className="h-4 w-4 text-primary" />
                <span className="text-xs font-semibold text-foreground">Rolling Backups</span>
              </div>
              <span className="text-xs text-muted-foreground font-mono">
                {backups.length} backups ({formatBytes(health?.total_backup_size ?? 0)})
              </span>
            </div>

            <p className="text-xs text-muted-foreground">
              Automatic backups rotate continuously on disk, retaining the latest 10 dated snapshots. You can also export portable <code className="font-mono">.issproj</code> files.
            </p>

            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="default"
                size="sm"
                onClick={handleCreateBackup}
                disabled={creatingBackup}
                className="text-xs gap-1.5 h-8"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                {creatingBackup ? "Backing up…" : "Create Backup Now"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportBackup}
                className="text-xs gap-1.5 h-8"
              >
                <Download className="h-3.5 w-3.5" />
                Export .issproj
              </Button>
            </div>

            {backups.length > 0 && (
              <div className="pt-2 border-t border-border/60 space-y-1.5 max-h-40 overflow-y-auto pr-1">
                {backups.slice(0, 5).map((b) => (
                  <div
                    key={b.filename}
                    className="flex items-center justify-between text-xs p-2 rounded-lg bg-background/60 border border-border/50 hover:bg-background transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="font-mono font-medium truncate text-foreground">{b.filename}</p>
                      <p className="text-[11px] text-muted-foreground font-mono">
                        {formatDate(b.timestamp)} · {formatBytes(b.size)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRestoreBackup(b.path)}
                      className="h-7 text-xs gap-1 text-primary hover:text-primary"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Restore
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="shrink-0 pt-2 border-t border-border/70 flex items-center justify-between sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={loadData}
            disabled={loading}
            className="text-xs gap-1.5 text-muted-foreground"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setOpen(false)}
            className="text-xs"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
