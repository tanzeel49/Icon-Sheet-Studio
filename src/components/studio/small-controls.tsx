"use client";

/**
 * ICON SHEET STUDIO — shared compact editor controls.
 * Used by the Properties panel, export dialog, and geometry editor.
 */

import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWheelNumberAdjust } from "./use-wheel-number-adjust";

/* `tooltip` — optional micro-help text shown on the LABEL (native title).
 * Purely presentational: lets non-obvious controls (stroke weight, hero
 * scale, auto-fit…) carry a one-line explanation without new components. */
export function Row({
  label,
  children,
  className,
  tooltip,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  tooltip?: string;
}) {
  return (
    <div className={cn("grid grid-cols-[110px_1fr] items-center gap-2", className)}>
      <Label
        className="text-[11px] font-medium text-foreground truncate"
        title={tooltip ?? label}
      >
        {label}
      </Label>
      <div className="flex items-center gap-2 min-w-0">{children}</div>
    </div>
  );
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const NAMED_RE = /^(none|transparent|black|white|red|blue|green|gray|grey|silver|maroon|navy|olive|lime|aqua|teal|purple|fuchsia|yellow|orange)$/i;

export function isUsableColor(v: string): boolean {
  return HEX_RE.test(v) || NAMED_RE.test(v);
}

export function ColorField({
  label,
  value,
  onChange,
  allowEmpty,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  allowEmpty?: boolean;
}) {
  // local text mirrors the prop; only VALID colors are committed so that
  // mid-typing states / native input-undo never corrupt the design state.
  const [local, setLocal] = useState({ text: value, committed: value });
  if (value !== local.committed) {
    // prop changed externally → resync local text during render (React pattern)
    setLocal({ text: value, committed: value });
  }

  function commit(next: string) {
    const usable = isUsableColor(next) || (allowEmpty && next === "");
    setLocal((prev) => ({ text: next, committed: usable ? next : prev.committed }));
    if (usable) onChange(next);
  }

  const safe = HEX_RE.test(value) ? value : "#000000";
  return (
    <Row label={label}>
      <div className="flex items-center gap-1.5 w-full">
        <label
          className="studio-swatch relative h-8 w-9 shrink-0 rounded-md border border-border overflow-hidden cursor-pointer shadow-sm"
          title={`${label} color picker`}
        >
          <span className="absolute inset-0" style={{ background: value || "transparent" }} />
          <input
            type="color"
            value={safe}
            onChange={(e) => commit(e.target.value)}
            className="absolute inset-0 opacity-0 cursor-pointer"
            aria-label={`${label} color`}
          />
        </label>
        <Input
          value={local.text}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => {
            // restore text to the last committed value when invalid
            if (!isUsableColor(local.text) && !(allowEmpty && local.text === "")) {
              setLocal((prev) => ({ ...prev, text: prev.committed }));
            }
          }}
          className={cn(
            "h-8 min-w-0 flex-1 bg-background px-2 font-mono text-[11px] tabular-nums",
            !isUsableColor(local.text) && !(allowEmpty && local.text === "") && "text-red-500"
          )}
          spellCheck={false}
          aria-label={`${label} hex value`}
        />
        {allowEmpty && value ? (
          <Button variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0" onClick={() => onChange("")} title="Clear">
            ×
          </Button>
        ) : null}
      </div>
    </Row>
  );
}

/* ------------------------------------------------------------------ */
/* Numeric slider + editable value (Illustrator-style)                  */
/*                                                                     */
/* [ ─────●───── ] [ 122 ]                                             */
/*                                                                     */
/* The slider is FAST visual adjustment, the field is PRECISE manual    */
/* control — both drive the SAME underlying value (the prop). The field */
/* is a live mirror while idle: dragging the slider re-renders it.      */
/* Typing creates a local draft that is committed (Enter / blur / Tab)  */
/* after parse + clamp validation; Escape discards it. Arrow keys       */
/* nudge by step, Shift+Arrow by 10 × step (or `bigStep`).             */
/* ------------------------------------------------------------------ */

/** Decimal places implied by a step value (1 → 0, 0.5 → 1, 0.01 → 2). */
function stepDecimals(step: number): number {
  if (Number.isInteger(step)) return 0;
  const s = String(step);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Decimal places needed to display a value without lying about it
 *  (typed values such as 1.25 on a 0.5-step field stay visible). */
function valueDecimals(v: number): number {
  if (Number.isInteger(v)) return 0;
  const s = String(v);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : Math.min(3, s.length - dot - 1);
}

/** Default number formatting: the step's precision, widened when the
 *  underlying value genuinely carries more decimals (never rounds a
 *  typed decimal away), capped at 3. Float noise (> 6 decimals, from
 *  legacy preset JSON / repeated step addition) is stripped first. */
export function formatNumber(v: number, step: number): string {
  if (!Number.isFinite(v)) return String(v);
  const denoised = Math.round(v * 1e6) / 1e6;
  const d = Math.min(3, Math.max(stepDecimals(step), valueDecimals(denoised)));
  return denoised.toFixed(d);
}

/** Lenient numeric parse for the value field: strips common unit
 *  decorations (°, %, spaces, thousands commas) so "45°", "86%",
 *  " 1.25 " and "-0.5" all parse. Returns null for anything that is
 *  not a usable number (empty, "abc", lone "-") — callers then snap
 *  the display back to the committed value. */
export function parseUnitText(text: string): number | null {
  const t = text.replace(/[°%\s]/g, "").replace(/,/g, ".");
  if (t === "" || t === "-" || t === "." || t === "-." || t === "+") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parser for fields whose VALUE is a fraction displayed as percent
 *  ("86%" ↔ 0.86): the typed number is interpreted as a percentage,
 *  exactly like Illustrator's percent fields. */
export function parsePercentText(text: string): number | null {
  const n = parseUnitText(text);
  return n == null ? null : n / 100;
}

/** Precision-honest percent display for fraction-valued fields
 *  ("86%", "62.5%") — never rounds a typed decimal away, no trailing
 *  zero noise on step-aligned values. */
export function formatPercent(v: number): string {
  const pct = Math.round(v * 100 * 1e6) / 1e6; // strip FP noise
  return `${formatNumber(pct, 1)}%`;
}

export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  parse,
  bigStep,
  disabled,
  tooltip,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** Display formatter (defaults to raw number with step precision). */
  format?: (v: number) => string;
  /** Typed-text parser (defaults to the lenient unit-stripping parse).
   *  Must round-trip: parse(format(value)) === value. */
  parse?: (text: string) => number | null;
  /** Shift+↑/↓ step — defaults to 10 × step. */
  bigStep?: number;
  /** round 17: auto-fit states disable the manual control (the value is
   *  then derived — shown read-only, still fully visible). */
  disabled?: boolean;
  /** micro-help shown on the label (visual only). */
  tooltip?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  /** null → not editing → the field mirrors the prop value (single
   *  source of truth). A string → mid-edit draft, committed only on
   *  Enter / blur / Tab, discarded on Escape. */
  const [draft, setDraft] = useState<string | null>(null);
  /** true while a pointer-drag scrub is active (drives the highlight). */
  const [scrubbing, setScrubbing] = useState(false);
  const scrubbingRef = useRef(false);

  const display = format ? format(value) : formatNumber(value, step);
  const parseText = parse ?? parseUnitText;

  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  /** Strip binary floating-point noise from repeated step addition
   *  (0.86 + 0.01 = 0.8700000000000001); typed values arrive clean. */
  const clean = (n: number) => Math.round(n * 1e6) / 1e6;

  /** Commit a typed/pasted value: parse → validate → clamp → onChange.
   *  Invalid or empty input restores the committed value silently. */
  const commit = (raw: string): void => {
    setDraft(null);
    const parsed = parseText(raw);
    if (parsed == null || !Number.isFinite(parsed)) return;
    const next = clamp(parsed);
    if (next !== value) onChange(next);
  };

  /** Arrow nudge — acts on the live value, or on a valid pending draft
   *  when one exists (professional field behavior). */
  const nudge = (dir: 1 | -1, large: boolean): void => {
    const delta = (large ? bigStep ?? step * 10 : step) * dir;
    const draftNum = draft != null ? parseText(draft) : null;
    const base = draftNum != null && Number.isFinite(draftNum) ? draftNum : value;
    const next = clamp(clean(base + delta));
    setDraft(null);
    if (next !== value) onChange(next);
  };

  /* GLOBAL wheel adjustment — same shared hook as panel-kit's SliderField
   * (single source: use-wheel-number-adjust.ts). Focus + scroll = ±step.
   * Callback-ref binding — survives node swaps (popovers). */
  const wheelRef = useWheelNumberAdjust({ disabled, onNudge: nudge }, inputRef);

  /** SCRUB — the Illustrator/Figma field interaction: press and drag
   *  horizontally to sweep the value continuously (snapped to the step
   *  grid, Shift = 10 × coarser); a press WITHOUT movement is a plain
   *  click and restores normal click-to-edit. Focus is suppressed during
   *  the press so the caret never fights the drag. */
  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>): void => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const startX = e.clientX;
    /* sensitivity: a full sweep across ~600 px, clamped so tiny ranges
     * (font weight: 8 steps) aren't hair-trigger and huge ranges stay
     * responsive. */
    const stepCount = Math.max(1, (max - min) / step);
    const pxPerStep = Math.max(3, Math.min(40, 600 / stepCount));
    const draftNum = draft != null ? parseText(draft) : null;
    const base = draftNum != null && Number.isFinite(draftNum) ? draftNum : value;
    let moved = false;

    /* suppress the default focus + selection start; a no-move pointerup
     * re-focuses manually so click-to-edit keeps working exactly as
     * before (keyboard focus via Tab is unaffected). */
    e.preventDefault();

    const endScrub = (): void => {
      if (scrubbingRef.current) {
        scrubbingRef.current = false;
        setScrubbing(false);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      }
    };

    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 4) return; // dead zone → still a click
      moved = true;
      if (!scrubbingRef.current) {
        scrubbingRef.current = true;
        setScrubbing(true);
        setDraft(null); // the scrub drives the live value — supersede any draft
        document.body.style.userSelect = "none";
        document.body.style.cursor = "ew-resize";
      }
      const stepSize = ev.shiftKey ? step * 10 : step;
      const target = base + (dx / pxPerStep) * stepSize;
      const snapped = Math.round(target / stepSize) * stepSize;
      const next = clamp(clean(snapped));
      if (next !== value) onChange(next);
    };

    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      endScrub();
      if (!moved) {
        // plain click → normal click-to-edit (focus was suppressed)
        el.focus(); // onFocus selects all, as before
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <Row label={label} tooltip={tooltip}>
      <div className="studio-value-row relative z-[1] flex min-w-0 flex-1 items-center gap-2">
        <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={(vals) => {
          if (disabled) return;
          setDraft(null); // slider is live — any pending draft is superseded
          onChange(vals[0]);
        }}
        className={cn("studio-slider min-w-0 flex-1", disabled && "opacity-50")}
        aria-label={label}
      />
      <input
        ref={wheelRef}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        aria-label={`${label} value`}
        value={draft ?? display}
        title={
          disabled
            ? `${label} is calculated automatically — turn Auto fit off to set it manually`
            : `${label} — drag the slider OR drag this field sideways to scrub. Click to type an exact value. Enter applies · Esc restores · ↑ ↓ nudge · mouse wheel adjusts · Shift for bigger steps`
        }
        onPointerDown={onPointerDown}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.currentTarget.value);
            // keep focus for follow-up edits; re-select for a clean state
            requestAnimationFrame(() => inputRef.current?.select());
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDraft(null); // restore display to the committed value
            requestAnimationFrame(() => inputRef.current?.select());
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault(); // don't move the caret — nudge the value
            nudge(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
          }
          // Tab falls through → browser moves focus → onBlur commits
        }}
        className={cn(
          "studio-value h-8 w-[56px] shrink-0 touch-none cursor-ew-resize rounded-md border border-transparent bg-transparent px-1 text-right font-mono text-[11px] tabular-nums text-muted-foreground outline-none",
          "focus:cursor-text",
          "focus:border-ring focus:bg-background focus:text-foreground focus:ring-1 focus:ring-ring",
          scrubbing && "border-ring bg-background text-foreground ring-1 ring-ring"
        )}
      />
      </div>
    </Row>
  );
}

/* ------------------------------------------------------------------ */
/* Multiline text field (category editor)                               */
/*                                                                     */
/* A proper accessible multiline control: Enter creates a line break,   */
/* never submits. Commits on blur / Tab only (no per-keystroke undo     */
/* spam); Escape restores the last committed text.                     */
/* ------------------------------------------------------------------ */

export function MultilineField({
  label,
  value,
  onCommit,
  placeholder,
  rows = 2,
  hint,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  rows?: number;
  hint?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (): void => {
    if (draft == null) return;
    setDraft(null);
    onCommit(draft);
  };

  return (
    <div>
      <div className="grid grid-cols-[110px_1fr] items-start gap-2">
        <Label
          className="pt-[7px] text-[11px] font-medium text-foreground truncate"
          title={label}
        >
          {label}
        </Label>
        <textarea
          rows={rows}
          value={draft ?? value}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDraft(null); // restore the committed text, keep editing
            }
            // Enter falls through → newline (multiline editing, never submits)
          }}
          spellCheck={false}
          aria-label={label}
          className="field-sizing-content min-h-[48px] w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-[11px] leading-relaxed outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring"
        />
      </div>
      {hint ? <p className="pro-help mt-1.5">{hint}</p> : null}
    </div>
  );
}

export function ToggleRow({
  label,
  checked,
  onChange,
  hint,
  tooltip,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  tooltip?: string;
}) {
  return (
    <div>
      <Row label={label} tooltip={tooltip}>
        <div className="flex items-center gap-2 w-full">
          <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
        </div>
      </Row>
      {hint ? <p className="pro-help mt-1.5">{hint}</p> : null}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <Row label={label}>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn("h-8 bg-background px-2 text-[11px]", mono && "font-mono")}
        aria-label={label}
      />
    </Row>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Row label={label}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="studio-select h-8 w-full rounded-md border border-input bg-background px-2 pr-[1.6rem] text-[11px] focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring cursor-pointer"
        aria-label={label}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** Compact collapsible section with a subtle divider. */
export function Section({
  title,
  children,
  defaultOpen = true,
  badge,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  badge?: React.ReactNode;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  return (
    <details ref={detailsRef} open={defaultOpen} className="studio-section group border-b border-border last:border-b-0">
      <summary className="studio-section-summary flex items-center justify-between cursor-pointer select-none py-3 px-1.5 transition-colors [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-1.5 min-w-0">
          <svg
            className="studio-section-chevron h-3 w-3 transition-transform duration-200 group-open:rotate-90 text-muted-foreground/60"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            aria-hidden
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
          <span className="pro-label truncate">{title}</span>
        </span>
        {/* badge gets pr-0.5 so right-aligned values aren't cramped against
         * the panel edge (the panel's p-4 gutter provides the outer air). */}
        {badge ? <span className="shrink-0 pr-0.5">{badge}</span> : null}
      </summary>
      <div className="studio-section-body px-1.5 pb-4 space-y-3">{children}</div>
    </details>
  );
}
