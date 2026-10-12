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
import { History, RotateCcw, Plus, HardDrive, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { useStudio } from "@/lib/studio/store";
import {
  listProjectCheckpoints,
  restoreProjectCheckpoint,
  type CheckpointInfo,
} from "@/lib/studio/project-manager";
import { toast } from "sonner";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(ts: number): string {
  if (!ts) return "Unknown";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function VersionHistoryDialog() {
  const open = useStudio((s) => s.versionHistoryOpen);
  const setOpen = useStudio((s) => s.setVersionHistoryOpen);
  const projectName = useStudio((s) => s.projectName);
  const currentRevision = useStudio((s) => s.projectRevision);
  const saveProjectNow = useStudio((s) => s.saveProjectNow);
  const hydrate = useStudio((s) => s.hydrate);

  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadCheckpoints = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listProjectCheckpoints();
      setCheckpoints(list);
    } catch (err) {
      console.error("Failed to load checkpoints", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadCheckpoints();
    }
  }, [open, loadCheckpoints]);

  const handleCreateCheckpoint = async () => {
    setCreating(true);
    try {
      const summary = prompt("Enter a summary for this checkpoint:", "Manual checkpoint");
      if (summary === null) {
        setCreating(false);
        return;
      }
      const ok = await saveProjectNow(summary.trim() || "Manual checkpoint");
      if (ok) {
        toast.success("Checkpoint created successfully");
        await loadCheckpoints();
      } else {
        toast.error("Failed to create checkpoint");
      }
    } catch (err) {
      toast.error("Error creating checkpoint: " + String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleRestore = async (chk: CheckpointInfo) => {
    const confirm = window.confirm(
      `Restore revision ${chk.revision} (${formatDate(chk.timestamp)})?\n\nA safety checkpoint of your current work will be created automatically first.`
    );
    if (!confirm) return;

    setRestoringId(chk.id);
    try {
      const doc = await restoreProjectCheckpoint(chk.id);
      if (doc) {
        toast.success(`Restored revision ${chk.revision}`, {
          description: "A safety checkpoint of your previous state was preserved.",
        });
        setOpen(false);
        // Re-hydrate store with restored document
        await hydrate();
      }
    } catch (err) {
      toast.error("Failed to restore checkpoint: " + String(err));
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-6">
        <DialogHeader className="shrink-0 space-y-1">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary grid place-items-center">
              <History className="h-4 w-4" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold">Version History</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Reversible checkpoints for <span className="font-medium text-foreground">{projectName}</span> (Current: Rev {currentRevision})
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-[280px] py-3 space-y-2">
          {loading ? (
            <div className="py-12 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
              <Clock className="h-4 w-4 animate-spin text-primary" />
              Loading checkpoints…
            </div>
          ) : checkpoints.length === 0 ? (
            <div className="py-12 text-center space-y-2">
              <HardDrive className="h-8 w-8 mx-auto text-muted-foreground/40" />
              <p className="text-sm font-medium text-muted-foreground">No checkpoints recorded yet</p>
              <p className="text-xs text-muted-foreground/70 max-w-sm mx-auto">
                Checkpoints are created automatically during major structural edits or when you create a manual milestone.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-muted/20">
              {checkpoints.map((chk) => {
                const isCurrent = chk.revision === currentRevision;
                return (
                  <div
                    key={chk.id}
                    className="p-3.5 flex items-center justify-between gap-4 hover:bg-muted/40 transition-colors"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-muted text-foreground border border-border/70">
                          Rev {chk.revision}
                        </span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1 font-mono">
                          <Clock className="h-3 w-3" />
                          {formatDate(chk.timestamp)}
                        </span>
                        {isCurrent && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                            <CheckCircle2 className="h-3 w-3" />
                            Current
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-medium text-foreground truncate">
                        {chk.summary || "Automatic checkpoint"}
                      </p>
                      <p className="text-[11px] text-muted-foreground font-mono">
                        {formatBytes(chk.size)} · {chk.project_name}
                      </p>
                    </div>

                    <div className="shrink-0 flex items-center gap-2">
                      <Button
                        variant={isCurrent ? "outline" : "default"}
                        size="sm"
                        disabled={isCurrent || restoringId === chk.id}
                        onClick={() => handleRestore(chk)}
                        className="h-8 text-xs gap-1.5"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {restoringId === chk.id ? "Restoring…" : "Restore"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 pt-3 border-t border-border/70 flex items-center justify-between sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCreateCheckpoint}
            disabled={creating}
            className="text-xs gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            {creating ? "Creating…" : "Save New Checkpoint"}
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
