"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { isDesktop } from "@/lib/studio/desktop";
import { RefreshCcw, Download } from "lucide-react";

let checkUpdateFn: (() => Promise<void>) | null = null;

export function triggerUpdateCheck() {
  if (checkUpdateFn) {
    checkUpdateFn();
  } else {
    toast.error("Updater is not initialized or not supported on this platform.");
  }
}

export function UpdaterDialog() {
  const [open, setOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<any>(null);
  const [status, setStatus] = useState<"idle" | "downloading" | "ready" | "error">("idle");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!isDesktop()) return;

    let isChecking = false;

    const checkUpdate = async (silent = true) => {
      if (isChecking) return;
      isChecking = true;
      try {
        if (!silent) toast.loading("Checking for updates...", { id: "updater" });
        
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        
        if (update) {
          if (!silent) toast.dismiss("updater");
          setUpdateInfo(update);
          setOpen(true);
        } else {
          if (!silent) toast.success("You are on the latest version.", { id: "updater" });
        }
      } catch (err) {
        console.error("Update check failed:", err);
        if (!silent) toast.error("Failed to check for updates.", { id: "updater" });
      } finally {
        isChecking = false;
      }
    };

    checkUpdateFn = () => checkUpdate(false);

    // Initial silent check
    setTimeout(() => checkUpdate(true), 2000);

    return () => {
      checkUpdateFn = null;
    };
  }, []);

  const startUpdate = async () => {
    if (!updateInfo) return;
    setStatus("downloading");
    setProgress(0);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      
      let downloaded = 0;
      let contentLength = 0;

      await updateInfo.downloadAndInstall((event: any) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength || 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            setProgress((downloaded / contentLength) * 100);
          }
        } else if (event.event === "Finished") {
          setStatus("ready");
          setProgress(100);
        }
      });
      
      // Cleanly kill node.exe before relaunch so the NSIS updater won't hit an ERROR_SHARING_VIOLATION file lock
      try {
        await invoke("terminate_background_server");
      } catch (e) {
        console.warn("Could not invoke terminate_background_server before relaunch:", e);
      }

      setStatus("ready");
      toast.success("Update installed successfully. Restarting...");
      setTimeout(() => relaunch(), 1500);
    } catch (err) {
      console.error("Install failed:", err);
      setStatus("error");
      toast.error("Installation failed. Please verify network or signature.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(val) => {
      if (status !== "downloading") setOpen(val);
    }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCcw className="h-5 w-5 text-blue-500" />
            Update Available
          </DialogTitle>
          <DialogDescription>
            A new version of Icon Sheet Studio is available.
          </DialogDescription>
        </DialogHeader>

        {updateInfo && (
          <div className="text-sm space-y-4">
            <div className="flex justify-between items-center bg-muted/40 p-3 rounded-md border border-border">
              <span className="text-muted-foreground">Version:</span>
              <span className="font-mono font-medium">{updateInfo.currentVersion} → {updateInfo.version}</span>
            </div>
            
            {updateInfo.body && (
              <div className="space-y-1">
                <span className="font-medium">Release Notes:</span>
                <div className="bg-muted/40 p-3 rounded-md text-muted-foreground max-h-32 overflow-y-auto text-xs border border-border">
                  {updateInfo.body}
                </div>
              </div>
            )}
          </div>
        )}

        {status === "downloading" && (
          <div className="space-y-2 mt-4">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Downloading update...</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        )}

        {status === "ready" && (
          <div className="mt-4 text-sm text-emerald-500 font-medium">
            Update ready! Restarting application...
          </div>
        )}

        {status === "error" && (
          <div className="mt-4 text-sm text-red-500 font-medium">
            Failed to install the update.
          </div>
        )}

        <DialogFooter className="sm:justify-end mt-4">
          <Button 
            variant="outline" 
            onClick={() => setOpen(false)}
            disabled={status === "downloading" || status === "ready"}
          >
            Later
          </Button>
          <Button 
            onClick={startUpdate} 
            disabled={status === "downloading" || status === "ready"}
            className="gap-2"
          >
            <Download className="h-4 w-4" />
            Download & Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
