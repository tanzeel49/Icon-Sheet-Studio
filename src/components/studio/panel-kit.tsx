"use client";

/**
 * ICON SHEET STUDIO — Inspector panel kit (round 25 · "Inspector v2").
 *
 * Presentational primitives for the RIGHT properties panel ONLY — a total
 * visual redesign: the panel becomes a deep tool surface with one floating
 * elevated card per section, amber-accented sliders/switches, bordered
 * rounded field boxes, segmented enum controls and normal-case labels.
 *
 * Every component keeps the EXACT prop contract of its small-controls
 * counterpart, so properties-panel.tsx swaps visually with ZERO logic
 * drift. The export dialog keeps importing small-controls — untouched.
 *
 * Pure logic helpers (parse/format/validate) are re-exported from
 * small-controls so there is a single source of truth.
 */

import { useRef, useState, type JSX, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatNumber, isUsableColor, parseUnitText } from "./small-controls";
import { useWheelNumberAdjust } from "./use-wheel-number-adjust";

export {
  formatNumber,
  formatPercent,
  parsePercentText,
  parseUnitText,
  isUsableColor,
} from "./small-controls";

/* ------------------------------------------------------------------ */
/* Shared class strings                                                */
/* ------------------------------------------------------------------ */

/** The one field-box recipe: bordered, card-surface, soft focus halo.
 * Task 10-b: `.ip-field` (globals.css) refines the resting border to a
 * hairline + hover shift + clean focus handoff — appended CSS only. */
const FIELD =
  "ip-field h-9 w-full rounded-lg border border-input bg-card px-2.5 text-[12px] text-foreground shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[2.5px] focus-visible:ring-ring/25";

const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/* ------------------------------------------------------------------ */
/* Row — label left, control right                                     */
/* ------------------------------------------------------------------ */

export function Row({
  label,
  children,
  className,
  tooltip,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  tooltip?: string;
}) {
  return (
    <div className={cn("grid min-w-0 grid-cols-[112px_1fr] items-center gap-2.5", className)}>
      <Label
        className="truncate text-[11.5px] font-medium text-foreground/90"
        title={tooltip ?? label}
      >
        {label}
      </Label>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Text / select / segmented fields                                    */
/* ------------------------------------------------------------------ */

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
        className={cn(FIELD, mono && "font-mono text-[11.5px]")}
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
        className={cn(
          FIELD,
          "studio-select cursor-pointer pr-7"
        )}
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

/** Segmented enum control — the Figma-style pill group that replaces
 *  dropdowns when there are only a handful of short options. Behavior
 *  is identical to SelectField (click → onChange); presentation is the
 *  only difference. */
export function SegmentedField<T extends string>({
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
      <div
        className="ip-seg flex h-9 w-full min-w-0 items-center gap-0.5 rounded-lg border border-input bg-card p-0.5 shadow-xs"
        role="group"
        aria-label={label}
      >
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => {
                if (!active) onChange(o.value);
              }}
              className={cn(
                "h-8 min-w-0 flex-1 truncate rounded-md px-1 text-[11px] font-medium outline-none transition-colors",
                "focus-visible:ring-[2.5px] focus-visible:ring-ring/30",
                active
                  ? "bg-foreground text-background shadow-xs"
                  : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </Row>
  );
}

/* ------------------------------------------------------------------ */
/* Color field — checkerboard swatch + hex box                         */
/* ------------------------------------------------------------------ */

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
      <div className="flex w-full items-center gap-2">
        <label
          className="studio-swatch relative size-7 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-input shadow-xs"
          title={`${label} color picker`}
        >
          <span className="absolute inset-0" style={{ background: value || "transparent" }} />
          <input
            type="color"
            value={safe}
            onChange={(e) => commit(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
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
            "ip-field h-9 min-w-0 flex-1 rounded-lg border border-input bg-card px-2 font-mono text-[11px] tabular-nums text-foreground shadow-xs outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[2.5px] focus-visible:ring-ring/25",
            !isUsableColor(local.text) && !(allowEmpty && local.text === "") && "ip-field-invalid border-destructive text-destructive"
          )}
          spellCheck={false}
          aria-label={`${label} hex value`}
        />
        {allowEmpty && value ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-9 shrink-0 rounded-lg p-0"
            onClick={() => onChange("")}
            title="Clear"
          >
            ×
          </Button>
        ) : null}
      </div>
    </Row>
  );
}

/* ------------------------------------------------------------------ */
/* Numeric slider + editable value (Illustrator-style)                 */
/*                                                                     */
/* [ ─────●───── ] [ 122 ]                                             */
/*                                                                     */
/* Identical interaction logic to the small-controls slider (copied    */
/* verbatim — scrub, draft commit, arrow nudge); ONLY the styling      */
/* changes: amber-filled track + bordered value chip.                  */
/* ------------------------------------------------------------------ */

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
  unit,
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
  /** auto-fit states disable the manual control (the value is then
   *  derived — shown read-only, still fully visible). */
  disabled?: boolean;
  /** micro-help shown on the label (visual only). */
  tooltip?: string;
  /** Optional unit suffix rendered AFTER the value chip (e.g. "px") —
   *  the chip itself stays narrow; the unit reads as part of the value
   *  ("+5 px") and is never part of the editable text. */
  unit?: string;
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

  /* GLOBAL wheel adjustment (shared hook — every numeric field in the app
   * gets it through the SliderField pattern): focus the field, scroll the
   * wheel; up = +step, down = −step, Shift = bigStep. Routes into the SAME
   * nudge path as the arrow keys, so step/min/max/precision/state are the
   * field's own. Callback-ref binding — survives node swaps (popovers). */
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
    /* P5 control layout: LABEL + editable value on the header line, the
     * slider on its OWN line below spanning (nearly) the whole panel —
     * the slider gets the horizontal space, the value stays hand-editable,
     * and slider ⇄ input always mirror the same committed value. The value
     * row carries .studio-value-row (z-lifted, CSS) so the slider's hit
     * zone can NEVER cover the editable chip, and the slider sits a full
     * 8px below it (P5 overlap fix — they used to share pixels). */
    <div className="studio-slider-field min-w-0">
      {/* relative z-[1] (inline utility, P5): the value chip always wins
       * paint order + pointer hit tests against the slider's hit zone. */}
      <div className="studio-value-row relative z-[1] flex min-w-0 items-center justify-between gap-2">
        <Label
          className="min-w-0 truncate text-[11.5px] font-medium text-foreground/90"
          title={tooltip ?? label}
        >
          {label}
        </Label>
        <span className="flex shrink-0 items-center gap-1.5">
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
              "studio-value h-8 w-[76px] shrink-0 touch-none cursor-ew-resize rounded-lg border border-input bg-card px-1.5 text-right font-mono text-[11.5px] tabular-nums text-foreground shadow-xs outline-none",
              "transition-[border-color,box-shadow,color] focus:cursor-text",
              "focus-visible:border-ring focus-visible:ring-[2.5px] focus-visible:ring-ring/25",
              scrubbing && "border-ring ring-2 ring-ring/25"
            )}
          />
          {unit ? (
            <span
              className="shrink-0 select-none font-mono text-[11px] tabular-nums text-muted-foreground"
              aria-hidden
            >
              {unit}
            </span>
          ) : null}
        </span>
      </div>
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
        className="ip-slider mt-2 w-full"
        aria-label={label}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Multiline text field                                                */
/* ------------------------------------------------------------------ */

export function MultilineField({
  label,
  value,
  onCommit,
  placeholder,
  rows = 2,
  hint,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  rows?: number;
  hint?: string;
  /** mount-time focus (used by the builder to jump into text editing) */
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (): void => {
    if (draft == null) return;
    setDraft(null);
    onCommit(draft);
  };

  return (
    <div>
      <div className="grid grid-cols-[112px_1fr] items-start gap-2.5">
        <Label
          className="pt-2 text-[11.5px] font-medium text-foreground/90 truncate"
          title={label}
        >
          {label}
        </Label>
        <textarea
          rows={rows}
          autoFocus={autoFocus}
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
          className="ip-field field-sizing-content min-h-[56px] w-full resize-y rounded-lg border border-input bg-card px-2.5 py-2 text-[12px] leading-relaxed text-foreground shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[2.5px] focus-visible:ring-ring/25 dark:bg-input/30"
        />
      </div>
      {hint ? <p className="pro-help mt-1.5 pl-[122px]">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toggle row — full-width pill row with the amber switch              */
/* ------------------------------------------------------------------ */

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
      <div className="flex h-9 items-center justify-between gap-2.5 rounded-lg px-2 transition-colors hover:bg-muted/60">
        <Label
          className="min-w-0 truncate text-[11.5px] font-medium text-foreground/90"
          title={tooltip ?? label}
        >
          {label}
        </Label>
        <Switch
          checked={checked}
          onCheckedChange={onChange}
          aria-label={label}
          className="ip-switch"
        />
      </div>
      {hint ? <p className="pro-help pl-2">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section — one floating card on the deep inspector surface           */
/* ------------------------------------------------------------------ */

export function Section({
  title,
  children,
  /* round 27 · user request: the right-side properties panel starts with
   * EVERY section collapsed — the sticky identity header + section titles
   * give the overview, and users open only what they need. (panel-kit's
   * Section is used exclusively by the properties panel, so this default
   * deliberately does not touch the left sidebar's small-controls Section.) */
  defaultOpen = false,
  badge,
  icon,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  badge?: ReactNode;
  /** lucide icon rendered in the header tile (visual identity). */
  icon?: ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="ip-card group overflow-hidden rounded-xl border border-border/80 bg-card shadow-xs"
    >
      <summary
        className="flex h-11 cursor-pointer select-none items-center gap-2.5 px-2.5 outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 [&::-webkit-details-marker]:hidden"
      >
        {icon ? (
          <span
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground transition-colors",
              "group-open:bg-amber-500/15 group-open:text-amber-700 dark:group-open:text-amber-400"
            )}
            aria-hidden
          >
            {icon}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-[-0.01em] text-foreground">
          {title}
        </span>
        {badge ? <span className="shrink-0">{badge}</span> : null}
        <svg
          className="ip-card-chevron h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-open:rotate-90"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
      </summary>
      <div className="studio-section-body space-y-2.5 px-3 pb-3.5 pt-1.5">{children}</div>
    </details>
  );
}
