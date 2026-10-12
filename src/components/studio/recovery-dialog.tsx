"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RotateCcw, CheckCircle2, Trash2, Clock, Layers, Image as ImageIcon } from "lucide-react";
import { useStudio } from "@/lib/studio/store";
import { toast } from "sonner";

function formatDate(ts: number): string {
  if (!ts) return "Never";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function RecoveryDialog() {
  const open = useStudio((s) => s.recoveryDialogOpen);
  const setOpen = useStudio((s) => s.setRecoveryDialogOpen);
  const recoveryInfo = useStudio((s) => s.recoveryInfo);
  const restoreRecoverySession = useStudio((s) => s.restoreRecoverySession);
  const discardRecoverySession = useStudio((s) => s.discardRecoverySession);

  const [recovering, setRecovering] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  if (!recoveryInfo || !recoveryInfo.has_recovery) {
    return null;
  }

  const handleRecover = async () => {
    setRecovering(true);
    try {
      const ok = await restoreRecoverySession();
      if (ok) {
        toast.success("Previous session recovered successfully!", {
          description: `Restored ${recoveryInfo.sheets_count} sheets and ${recoveryInfo.icons_count} icons.`,
        });
        setOpen(false);
      } else {
        toast.error("Failed to restore recovery session.");
      }
    } catch (err) {
      toast.error("Recovery failed: " + String(err));
    } finally {
      setRecovering(false);
    }
  };

  const handleDiscard = async () => {
    const confirm = window.confirm(
      "Are you sure you want to discard this recovery snapshot? This action cannot be undone."
    );
    if (!confirm) return;

    setDiscarding(true);
    try {
      await discardRecoverySession();
      toast.info("Recovery snapshot discarded.");
      setOpen(false);
    } catch (err) {
      toast.error("Failed to discard recovery: " + String(err));
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg p-6 space-y-4">
        <DialogHeader className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 grid place-items-center shrink-0 border border-amber-500/20">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold">Recover Previous Session</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                An unsaved recovery snapshot was detected from a previous session that ended unexpectedly.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="rounded-lg border border-border/80 bg-muted/30 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">Project:</span>
            <span className="text-xs font-semibold text-foreground font-mono">{recoveryInfo.project_name}</span>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-amber-500" />
              Recovery Snapshot Time:
            </span>
            <span className="font-mono text-foreground font-medium">{formatDate(recoveryInfo.recovery_timestamp)}</span>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              Last Successful Save:
            </span>
            <span className="font-mono text-foreground font-medium">{formatDate(recoveryInfo.last_saved_timestamp)}</span>
          </div>

          <div className="pt-2 border-t border-border/60 flex items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5 text-muted-foreground font-mono">
              <Layers className="h-3.5 w-3.5 text-primary" />
              <span>{recoveryInfo.sheets_count} sheets</span>
            </div>
            <div className="flex items-center gap-1.5 text-muted-foreground font-mono">
              <ImageIcon className="h-3.5 w-3.5 text-primary" />
              <span>{recoveryInfo.icons_count} icons</span>
            </div>
          </div>
        </div>

        <DialogFooter className="flex flex-col-reverse sm:flex-row items-center gap-2 sm:justify-between pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDiscard}
            disabled={discarding || recovering}
            className="text-xs text-muted-foreground hover:text-destructive gap-1.5 w-full sm:w-auto"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Discard Recovery
          </Button>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={recovering}
              className="text-xs w-full sm:w-auto"
            >
              Open Last Saved
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleRecover}
              disabled={recovering}
              className="text-xs gap-1.5 bg-amber-600 hover:bg-amber-700 text-white w-full sm:w-auto font-medium"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {recovering ? "Recovering…" : "Recover Work"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
