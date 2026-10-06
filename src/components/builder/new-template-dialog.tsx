"use client";

/**
 * ICON SHEET STUDIO — TEMPLATE BUILDER (Phase 1) · new-template dialog.
 *
 * Small setup flow: name, width, height, background. Values are
 * validated before creation (finite, within limits) — invalid input
 * shows inline errors and never creates a corrupted document.
 */

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useBuilderStore } from "@/lib/builder/store";
import { ARTBOARD_MAX, ARTBOARD_MIN } from "@/lib/builder/types";
import { cn } from "@/lib/utils";

const PRESETS = [
  { label: "Square 1200×1200", w: 1200, h: 1200 },
  { label: "Landscape 1920×1080", w: 1920, h: 1080 },
  { label: "Portrait 1080×1920", w: 1080, h: 1920 },
] as const;

const BACKGROUNDS = [
  { label: "White", value: "#FFFFFF" },
  { label: "Ivory", value: "#F5F2EB" },
  { label: "Warm", value: "#FAF7F0" },
  { label: "Dark", value: "#18181B" },
] as const;

export function NewTemplateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const createDocument = useBuilderStore((s) => s.createDocument);
  const [name, setName] = useState("Untitled Template");
  const [wStr, setWStr] = useState("1200");
  const [hStr, setHStr] = useState("1200");
  const [background, setBackground] = useState<string>("#FFFFFF");

  const width = Number(wStr);
  const height = Number(hStr);
  const widthError =
    wStr.trim() === "" || !Number.isFinite(width) || !Number.isInteger(width) || width < ARTBOARD_MIN || width > ARTBOARD_MAX
      ? `Width must be a whole number between ${ARTBOARD_MIN} and ${ARTBOARD_MAX}`
      : null;
  const heightError =
    hStr.trim() === "" || !Number.isFinite(height) || !Number.isInteger(height) || height < ARTBOARD_MIN || height > ARTBOARD_MAX
      ? `Height must be a whole number between ${ARTBOARD_MIN} and ${ARTBOARD_MAX}`
      : null;

  const submit = (): void => {
    if (widthError || heightError) return;
    createDocument({
      name: name.trim() || "Untitled Template",
      width,
      height,
      background,
    });
    onOpenChange(false);
    toast.success(`"${name.trim() || "Untitled Template"}" created — ${width} × ${height}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>New template</DialogTitle>
          <DialogDescription>
            Set up the artboard — everything stays editable later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="tb-name" className="text-[12px]">
              Template name
            </Label>
            <Input
              id="tb-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="Untitled Template"
              className="h-9"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tb-width" className="text-[12px]">
                Width (px)
              </Label>
              <Input
                id="tb-width"
                value={wStr}
                onChange={(e) => setWStr(e.target.value)}
                inputMode="numeric"
                aria-invalid={!!widthError}
                className={cn("h-9 font-mono tabular-nums", widthError && "border-destructive focus-visible:ring-destructive/25")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tb-height" className="text-[12px]">
                Height (px)
              </Label>
              <Input
                id="tb-height"
                value={hStr}
                onChange={(e) => setHStr(e.target.value)}
                inputMode="numeric"
                aria-invalid={!!heightError}
                className={cn("h-9 font-mono tabular-nums", heightError && "border-destructive focus-visible:ring-destructive/25")}
              />
            </div>
          </div>
          {(widthError || heightError) && (
            <p role="alert" className="text-[11px] leading-relaxed text-destructive">
              {widthError ?? heightError}
            </p>
          )}

          <div className="space-y-1.5">
            <Label className="text-[12px]">Quick sizes</Label>
            <div className="grid grid-cols-3 gap-1.5">
              {PRESETS.map((p) => {
                const active = Number(wStr) === p.w && Number(hStr) === p.h;
                return (
                  <Button
                    key={p.label}
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn("h-7 px-1 text-[10.5px]", active && "border-ring bg-muted")}
                    onClick={() => {
                      setWStr(String(p.w));
                      setHStr(String(p.h));
                    }}
                  >
                    {p.label.split(" ")[0]}
                    <span className="ml-1 font-mono text-[9.5px] text-muted-foreground">
                      {p.w}×{p.h}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[12px]">Background</Label>
            <div className="flex items-center gap-1.5">
              {BACKGROUNDS.map((bg) => (
                <button
                  key={bg.value}
                  type="button"
                  onClick={() => setBackground(bg.value)}
                  aria-label={`Background: ${bg.label}`}
                  aria-pressed={background === bg.value}
                  title={bg.label}
                  className={cn(
                    "size-8 rounded-lg border shadow-xs outline-none transition-[box-shadow,border-color] focus-visible:ring-2 focus-visible:ring-ring/50",
                    background === bg.value ? "border-ring ring-2 ring-ring/30" : "border-input hover:border-foreground/30"
                  )}
                  style={{ background: bg.value }}
                />
              ))}
              <label
                className="relative ml-1 grid size-8 cursor-pointer place-items-center overflow-hidden rounded-lg border border-dashed border-input shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                title="Custom color"
              >
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(background) ? background : "#FFFFFF"}
                  onChange={(e) => setBackground(e.target.value)}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  aria-label="Custom background color"
                />
                <span className="font-mono text-[9px] text-muted-foreground">+</span>
              </label>
              <span className="ml-1.5 font-mono text-[10.5px] tabular-nums text-muted-foreground">{background}</span>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!!widthError || !!heightError}>
            Create Template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
