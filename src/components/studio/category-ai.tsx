"use client";

/**
 * ICON SHEET STUDIO — Category + volume editor with AI assistance.
 *
 * Edits the ACTIVE sheet's category and VOLUME NUMBER. The AI only ever
 * produces a SUGGESTION — it never mutates state. State changes
 * exclusively through explicit user actions (Apply / input commit /
 * reset confirm). Category and volume are fully independent: changing
 * one never touches the other.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, Settings2, Sparkles, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useStudio } from "@/lib/studio/store";
import { formatVolume, formatVolumeNumber, MAX_VOLUME, parseVolumeText } from "@/lib/studio/types";
import { AI_PROVIDER_LABEL, AI_PROVIDER_SHORT, AIProviderId, useAISettings } from "@/lib/studio/ai-settings";
import { cn } from "@/lib/utils";
import { useWheelNumberAdjust } from "./use-wheel-number-adjust";

interface ThemeShare {
  name: string;
  share: number; // 0..1
}

interface CategorySuggestion {
  category: string;
  confidence: number; // 0..1
  reasoning: string;
  alternatives: string[];
  /** semantic clusters detected in the actual artwork (round 14) */
  themes?: ThemeShare[];
  /** how much of the collection the visual analysis covered */
  analyzed?: { unique: number; total: number; batchesOk: number; batchesTotal: number };
  /** "visual" = real artwork analysis; "text" = filename fallback */
  method?: "visual" | "text";
  /** true when the generic-guard re-analysis pass ran */
  guarded?: boolean;
  /** which AI provider produced this suggestion ("zai" | "gemini") */
  provider?: string;
  /** Gemini model used (Gemini provider only) */
  model?: string;
}

/** Inline AI-error presentation state (provider-aware, actionable). */
interface AiErrorState {
  message: string;
  /** offer "Open AI settings" (bad key/model). Optional: raw/legacy Z.AI
   *  failures only surface the message (toast carries the alert) — a
   *  missing flag is falsy, so no action buttons render. */
  offerSettings?: boolean;
  /** offer a one-click provider switch (never auto-switched). */
  switchTo?: AIProviderId;
  /** amber presentation for rate limits, destructive for hard errors. */
  warn?: boolean;
}

/** Friendly messages for provider-classified failures (Gemini). The
 *  backend sends a `kind`; the raw transport message stays in the
 *  response only for diagnostics. */
const AI_ERROR_MESSAGES: Record<string, string> = {
  "missing-key": "Add your Google Gemini API key in AI settings.",
  "invalid-key": "Gemini API key is invalid or unavailable.",
  "rate-limit": "Gemini API limit reached. Try again later or switch to Z.AI.",
  network: "Unable to reach Gemini API.",
  timeout: "Gemini API request timed out.",
  "unsupported-model": "This Gemini model is not available — pick another model in AI settings.",
  malformed: "Gemini returned an unexpected response.",
  "provider-error": "Gemini API is temporarily unavailable. Try again shortly.",
};

/** Kinds where fixing the configuration (settings) is the next action. */
const SETTINGS_KINDS = new Set(["missing-key", "invalid-key", "unsupported-model"]);

/** Full provenance line for the suggestion card. */
function suggestionProvenance(s: CategorySuggestion): string {
  if (s.provider === "gemini") {
    return `Analyzed with Google Gemini${s.model ? ` · ${s.model}` : ""}`;
  }
  return "Analyzed with Z.AI";
}

/** Budget for the visual analysis request (must match the backend). */
const MAX_UNIQUE_ICONS = 168;
/** Hard payload cap (~1.6 MB of SVG source) keeps requests light. */
const MAX_PAYLOAD_CHARS = 1_600_000;

/** 32-bit FNV-1a content hash — deduplicates exact-duplicate artwork so
 *  30 copies of one gear count as ONE semantic concept (with multiplicity)
 *  instead of 30 independent votes. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Evenly sample `max` indices from `total` (first + last always kept). */
function sampleIndices(total: number, max: number): number[] {
  if (total <= max) return Array.from({ length: total }, (_, i) => i);
  const out = new Set<number>();
  out.add(0);
  out.add(total - 1);
  const interior = max - 2;
  for (let i = 1; i <= interior; i++) {
    out.add(Math.round((i * (total - 1)) / (interior + 1)));
  }
  return [...out].sort((a, b) => a - b);
}

/** Chip colors for the detected-theme breakdown (amber family + warm,
 *  blue-free accents). */
const THEME_BAR_COLORS = [
  "bg-amber-500",
  "bg-orange-400",
  "bg-yellow-400",
  "bg-stone-400",
  "bg-teal-500",
  "bg-rose-400",
];

/* ------------------------------------------------------------------ */
/* Volume field — the editable numeric portion of “VOL. NN”           */
/* ------------------------------------------------------------------ */

/** Editable Volume number: click → type → Enter commits (Escape restores,
 *  Tab commits via blur, ↑/↓ nudge ±1 / ±10 with Shift). Commits go
 *  through setVolume → a per-sheet MANUAL override the automatic
 *  numbering never clobbers. Invalid input (letters, signs, decimals,
 *  empty) is rejected with a visible message and the previous value
 *  restored — the sheet state can never be corrupted. */
function VolumeField({ sheetId }: { sheetId: string }) {
  const sheet = useStudio((s) => s.sheets.find((sh) => sh.id === sheetId) ?? null);
  const setVolume = useStudio((s) => s.setVolume);
  const inputRef = useRef<HTMLInputElement>(null);
  /** null → not editing → mirrors the sheet's committed volume; a string
   *  → mid-edit draft, committed on Enter/blur, discarded on Escape. */
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Arrow nudge — acts on the live value or a valid pending draft,
   * exactly like the other numeric fields (Shift = 10×). Declared BEFORE
   *  the early return so the wheel hook below it stays unconditional
   *  (rules of hooks); the sheet guard makes it a no-op when unmounted. */
  const nudge = (dir: 1 | -1, large: boolean): void => {
    if (!sheet) return;
    const delta = (large ? 10 : 1) * dir;
    const draftNum = draft != null ? parseVolumeText(draft) : null;
    const base = draftNum != null ? draftNum : sheet.volume;
    const next = Math.min(MAX_VOLUME, Math.max(1, base + delta));
    setDraft(null);
    setError(null);
    setVolume(sheetId, next);
  };

  /* GLOBAL wheel adjustment — the same shared hook every numeric field in
   * the app uses (use-wheel-number-adjust.ts): focus + scroll = ±1 / ±10
   * with Shift, clamped 1…9999 through the field's own nudge. Callback-ref
   * binding, called before the early return (rules of hooks). */
  const volumeWheelRef = useWheelNumberAdjust({ onNudge: nudge }, inputRef);

  if (!sheet) return null;
  const display = formatVolumeNumber(sheet.volume);

  const commit = (raw: string): void => {
    setDraft(null);
    const trimmed = raw.trim();
    const parsed = parseVolumeText(trimmed);
    if (parsed == null) {
      setError(
        trimmed === ""
          ? `Empty — kept ${formatVolume(sheet.volume)}`
          : `“${trimmed.slice(0, 12)}” is not a whole number — kept ${formatVolume(sheet.volume)}`
      );
      return;
    }
    if (/^\d+$/.test(trimmed) && Number(trimmed) > MAX_VOLUME) {
      setError(`Clamped to the ${MAX_VOLUME} maximum`);
    }
    /* the store's no-op guard handles "same value, already manual"; a
     * retyped identical number on an automatic sheet still takes ownership */
    setVolume(sheetId, parsed);
  };

  return (
    <div className="grid grid-cols-[112px_1fr] items-start gap-2.5">
      <label
        htmlFor="iss-volume-input"
        className="pt-2 text-[11.5px] font-medium text-foreground/90 truncate"
        title="Volume — the number rendered as VOL. NN"
      >
        Volume
      </label>
      <div className="min-w-0 space-y-1">
        <div className="studio-value-row flex items-center gap-1.5">
          <input
            ref={volumeWheelRef}
            id="iss-volume-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            aria-label="Sheet volume number"
            value={draft ?? display}
            title="Volume number (rendered as VOL. NN) — type a whole number 1–9999. Enter applies · Esc restores · ↑ ↓ nudge · mouse wheel adjusts (Shift = ×10)"
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onBlur={(e) => commit(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault(); // commits — never submits any other UI
                commit(e.currentTarget.value);
                requestAnimationFrame(() => inputRef.current?.select());
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setDraft(null); // restore the committed volume
                setError(null);
                requestAnimationFrame(() => inputRef.current?.select());
              } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault(); // nudge the value, don't move the caret
                nudge(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
              }
              // Tab falls through → browser moves focus → onBlur commits
            }}
            className={cn(
              "studio-value h-9 w-[64px] shrink-0 rounded-lg border border-input bg-card px-1.5 text-center font-mono text-[11.5px] tabular-nums text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[2.5px] focus-visible:ring-ring/25 dark:bg-input/30",
              error && "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/25"
            )}
          />
          {sheet.volumeManual === true ? (
            <Badge
              variant="outline"
              className="h-5 shrink-0 rounded-md border-amber-500/50 bg-amber-500/10 px-1.5 text-[9px] font-semibold tracking-wide text-amber-700 dark:text-amber-400"
              title={`Manual override — Reset volume restores ${formatVolume(sheet.volumeAuto ?? sheet.volume)}`}
            >
              MANUAL
            </Badge>
          ) : (
            <span
              className="shrink-0 pro-label"
              title="Automatically numbered — typing takes ownership of this sheet's number"
            >
              auto
            </span>
          )}
        </div>
        <p
          className={cn(
            error ? "text-[11px] leading-snug font-medium text-destructive" : "pro-help"
          )}
        >
          {error ?? "Whole number 1–9999 · Enter applies · Esc restores"}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reset volume — dual mode                                            */
/* ------------------------------------------------------------------ */

/** The Reset Volume control, shared by the Category & Volume card and the
 *  properties section below it. Dual-mode, matching the sheet's state:
 *  · MANUAL sheet → SHEET-scoped reset: remove the override, restore this
 *    sheet's automatic number (volumeAuto snapshot). Everything else —
 *    category, other sheets, typography/design — is untouched.
 *  · Automatic sheet → the original category-wide counter reset: every
 *    sheet of the category re-sequences 1..n (manual overrides included —
 *    a counter reset releases them back to automatic). */
export function ResetVolumeButton({
  sheetId,
  label = "Reset",
  variant = "ghost",
  className,
}: {
  sheetId: string;
  label?: string;
  variant?: "ghost" | "outline";
  className?: string;
}) {
  const sheet = useStudio((s) => s.sheets.find((sh) => sh.id === sheetId) ?? null);
  const resetSheetVolume = useStudio((s) => s.resetSheetVolume);
  const resetCategoryVolume = useStudio((s) => s.resetCategoryVolume);
  if (!sheet) return null;
  const manual = sheet.volumeManual === true;
  const restored = formatVolume(sheet.volumeAuto ?? sheet.volume);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant={variant}
          size="sm"
          className={cn(
            "h-8 gap-1.5 rounded-lg px-2 text-[11px] font-medium",
            manual ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
            className
          )}
          aria-label={
            manual
              ? "Reset this sheet's volume to its automatic number"
              : "Reset volume counter for this category"
          }
          title={
            manual
              ? `Remove the manual override — this sheet returns to ${restored}`
              : "Re-sequence every sheet of this category from VOL. 01"
          }
        >
          <RotateCcw className="h-3 w-3" aria-hidden />
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {manual ? "Reset this sheet's volume?" : `Reset volume counter for ${sheet.category}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {manual ? (
              <>
                Removes the manual override — this sheet returns to {restored}. Category, other
                sheets and design settings are untouched. You can undo this from the history.
              </>
            ) : (
              <>
                Sheets of this category restart at VOL. 01 (manual overrides release back to
                automatic). You can undo this from the history.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              manual ? resetSheetVolume(sheetId) : resetCategoryVolume(sheet.category)
            }
          >
            {manual ? "Reset volume" : "Reset"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Multiline category editor: Enter creates a line break (never
 *  submits), blur commits, Escape restores the last committed text.
 *  The store keeps the exact string incl. \n — the renderer respects
 *  every manual line break. */
function CategoryTextarea({
  sheetId,
  localCategory,
  setLocalCategory,
  commit,
  inputRef,
}: {
  sheetId: string;
  localCategory: string;
  setLocalCategory: (v: string) => void;
  commit: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const sheet = useStudio((s) => s.sheets.find((sh) => sh.id === sheetId) ?? null);
  return (
    <div className="grid grid-cols-[112px_1fr] items-start gap-2.5">
      <label
        htmlFor="iss-category-input"
        className="pt-2 text-[11.5px] font-medium text-foreground/90 truncate"
        title="Category"
      >
        Category
      </label>
      <div className="min-w-0 space-y-1">
        <textarea
          id="iss-category-input"
          ref={inputRef}
          rows={2}
          value={localCategory}
          placeholder="Icon Collection"
          onChange={(e) => setLocalCategory(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            /* Enter falls through and inserts a newline — this is a
             * multiline editor; committing happens on blur only. */
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setLocalCategory(sheet?.category ?? "");
            }
          }}
          className="ip-field field-sizing-content min-h-[56px] w-full resize-y rounded-lg border border-input bg-card px-2.5 py-2 text-[12px] leading-relaxed shadow-xs outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[2.5px] focus-visible:ring-ring/25 dark:bg-input/30"
          aria-label="Sheet category"
          spellCheck={false}
        />
        <p className="pro-help">
          Enter adds a line break · Esc restores
        </p>
      </div>
    </div>
  );
}

export function CategoryAiControl({ sheetId }: { sheetId: string }) {
  const sheet = useStudio((s) => s.sheets.find((sh) => sh.id === sheetId) ?? null);
  const icons = useStudio((s) => s.icons);
  const setCategory = useStudio((s) => s.setCategory);

  /* AI provider selection (Z.AI / Gemini) — application configuration,
   * kept in localStorage, never in project data. */
  const aiProvider = useAISettings((s) => s.provider);
  const geminiKey = useAISettings((s) => s.geminiKey);
  const geminiModel = useAISettings((s) => s.geminiModel);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const runningRef = useRef(false); // double-click guard
  const [localCategory, setLocalCategory] = useState(sheet?.category ?? "");
  const [loading, setLoading] = useState(false);
  const [suggestion, setSuggestion] = useState<CategorySuggestion | null>(null);
  const [aiError, setAiError] = useState<AiErrorState | null>(null);

  /* hydrate persisted AI settings after mount (SSR-safe) */
  useEffect(() => {
    useAISettings.getState().hydrate();
  }, []);

  /* keep the local input in sync with external category changes (Apply, undo, …) */
  useEffect(() => {
    setLocalCategory(sheet?.category ?? "");
  }, [sheet?.category]);

  /* switching sheets clears any pending AI suggestion + error */
  useEffect(() => {
    setSuggestion(null);
    setAiError(null);
  }, [sheetId]);

  if (!sheet) return null;

  const hasIcons = sheet.iconIds.length > 0;

  /* -- input commit: only on blur / Enter, never per keystroke ---------- */
  const commit = () => {
    setCategory(sheetId, localCategory, false); // manual edit keeps the current volume
  };

  const editWith = (value: string) => {
    setLocalCategory(value);
    inputRef.current?.focus();
  };

  /* -- provider switch from an error affordance (explicit user action —
   * we NEVER auto-switch or silently consume the other provider's quota;
   * the user re-runs AI Suggest themselves) --------------------------- */
  const switchProviderTo = (target: AIProviderId) => {
    useAISettings.getState().setProvider(target);
    setAiError(null);
    toast.info(`AI provider switched to ${AI_PROVIDER_LABEL[target]} — click AI suggest to analyze.`);
  };

  /* -- AI suggest -------------------------------------------------------- */
  /* round 14: the PRIMARY signal is the actual SVG artwork. The sheet's
   * icons are DEDUPLICATED by content hash (exact duplicates collapse into
   * one unique design + an occurrence count — repeated artwork can never
   * inflate the semantic evidence), evenly sampled up to MAX_UNIQUE_ICONS
   * across the sheet, and sent with their counts so the backend can run its
   * multi-stage pipeline: numbered contact sheets → per-icon VLM analysis →
   * collection-level clustering/candidate-scoring → generic-guard.
   * Filenames + tags ride along only as secondary hints. Every click
   * re-analyzes the CURRENT collection — no result reuse. */
  const runAi = async () => {
    if (runningRef.current) return;
    /* client-side guard: Gemini selected but no key → open settings,
     * never send a request that would just fail. */
    if (aiProvider === "gemini" && !geminiKey.trim()) {
      setSuggestion(null);
      setAiError({
        message: "Add your Google Gemini API key in AI settings, or switch back to Z.AI.",
        offerSettings: true,
      });
      useAISettings.getState().openDialog();
      return;
    }
    runningRef.current = true;
    setLoading(true);
    setAiError(null);
    try {
      const iconIds = sheet.iconIds;

      // Unique designs by content hash, first-occurrence order + counts.
      const unique = new Map<string, { svg: string; count: number }>();
      for (const id of iconIds) {
        const svg = icons[id]?.svg;
        if (!svg) continue;
        const hash = fnv1a(svg);
        const entry = unique.get(hash);
        if (entry) entry.count += 1;
        else unique.set(hash, { svg, count: 1 });
      }
      const uniqueList = [...unique.values()];

      // Evenly sample the UNIQUE designs across the whole span.
      const picks = sampleIndices(uniqueList.length, MAX_UNIQUE_ICONS).map(
        (i) => uniqueList[i]
      );

      // Keep the request body under the payload cap (drop from the end).
      let payloadChars = 0;
      let cutoff = picks.length;
      for (let i = 0; i < picks.length; i++) {
        payloadChars += picks[i].svg.length;
        if (payloadChars > MAX_PAYLOAD_CHARS) {
          cutoff = Math.max(1, i);
          break;
        }
      }
      const sampled = picks.slice(0, cutoff);
      const iconSvgs = sampled.map((p) => p.svg);
      const iconCounts = sampled.map((p) => p.count);

      // Filenames + tags — secondary hints / text-fallback material.
      const iconNames = iconIds
        .map((id) => icons[id]?.fileName)
        .filter((n): n is string => Boolean(n))
        .slice(0, 120);
      const tagSet = new Set<string>();
      for (const id of iconIds) {
        for (const tag of icons[id]?.tags ?? []) {
          tagSet.add(tag);
          if (tagSet.size >= 40) break;
        }
      }
      const iconTags = [...tagSet];
      const sheetCount = iconIds.length;

      /* Provider selection — ONLY the selected provider is called. The
       * Gemini key rides in a dedicated request header (never in the JSON
       * body, never logged) and reaches only Google's endpoint. */
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (aiProvider === "gemini") headers["x-gemini-key"] = geminiKey.trim();
      const res = await fetch("/api/analyze-category", {
        method: "POST",
        headers,
        body: JSON.stringify({
          iconSvgs,
          iconCounts,
          iconNames,
          sheetCount,
          iconTags,
          provider: aiProvider,
          ...(aiProvider === "gemini" ? { geminiModel } : {}),
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          kind?: string;
          provider?: string;
        };
        if (body.kind) {
          /* provider-classified failure (Gemini) → friendly inline
           * presentation with the appropriate next actions */
          const other: AIProviderId = body.provider === "gemini" ? "zai" : "gemini";
          const canSwitch = other === "zai" || useAISettings.getState().geminiKey.trim().length > 0;
          setAiError({
            message: AI_ERROR_MESSAGES[body.kind] ?? body.error ?? `AI analysis failed (HTTP ${res.status})`,
            offerSettings: SETTINGS_KINDS.has(body.kind),
            switchTo: canSwitch ? other : undefined,
            warn: body.kind === "rate-limit" || body.kind === "network" || body.kind === "timeout",
          });
          return;
        }
        /* legacy/raw Z.AI failure — EXACT existing toast behavior */
        toast.error(`AI analysis failed: ${body.error ?? `HTTP ${res.status}`}`);
        setAiError({ message: body.error ?? `AI analysis failed (HTTP ${res.status})` });
        return;
      }

      const data = (await res.json()) as CategorySuggestion;
      if (!data.category) {
        toast.error("AI analysis failed: no category returned");
        return;
      }
      setSuggestion(data);
    } catch (err) {
      setAiError({ message: `AI analysis failed: ${err instanceof Error ? err.message : String(err)}` });
      toast.error(`AI analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      runningRef.current = false;
      setLoading(false);
    }
  };

  /* -- apply: the ONLY path where an AI result mutates state ------------ */
  const applySuggestion = () => {
    if (!suggestion) return;
    /* autoVolume=false — category and volume are independent controls:
     * applying a category never rewrites the sheet's volume number. */
    setCategory(sheetId, suggestion.category, false);
    toast.success(`Category set — ${suggestion.category}`);
    setSuggestion(null);
  };

  const confidencePct = suggestion
    ? Math.round(Math.min(1, Math.max(0, suggestion.confidence || 0)) * 100)
    : 0;

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-3">
      {/* Category input — multiline (Enter = line break, blur = commit) */}
      <CategoryTextarea
        sheetId={sheetId}
        localCategory={localCategory}
        setLocalCategory={setLocalCategory}
        commit={commit}
        inputRef={inputRef}
      />

      {/* Volume — editable per-sheet number (manual override) + reset.
       * Replaces the old read-only VOL badge: the number is now a real
       * editable property with a manual/auto state, and the reset adapts
       * to it (sheet-scoped when manual, category-wide when automatic). */}
      <VolumeField sheetId={sheetId} />

      <div className="flex items-center justify-end">
        <ResetVolumeButton sheetId={sheetId} />
      </div>

      {/* AI suggest — provider indicator on the button + settings gear.
       * The button always calls ONLY the selected provider. */}
      <div>
        <div className="flex items-stretch gap-2">
          <Button
            variant="outline"
            size="sm"
            className="ai-suggest-btn h-9 min-w-0 flex-1 gap-1.5 rounded-lg text-[12px]"
            onClick={runAi}
            disabled={!hasIcons || loading}
            title={
              hasIcons
                ? `Analyze this sheet's icon artwork with ${AI_PROVIDER_LABEL[aiProvider]} and suggest a category name — nothing changes until you apply it`
                : "Add icons first"
            }
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            )}
            <span className="truncate">
              {loading ? `Analyzing · ${AI_PROVIDER_SHORT[aiProvider]}…` : `AI suggest · ${AI_PROVIDER_SHORT[aiProvider]}`}
            </span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 w-9 shrink-0 rounded-lg p-0"
            onClick={() => useAISettings.getState().openDialog()}
            aria-label="AI provider settings"
            title="AI provider settings — choose Z.AI or Google Gemini, configure the Gemini API key and model"
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
        {!hasIcons && <p className="mt-1.5 pro-help">Add icons first.</p>}

        {/* provider-classified / connection failures — friendly, actionable */}
        {aiError && (
          <div
            role="alert"
            className={cn(
              "mt-2 space-y-2 rounded-lg border p-2.5",
              aiError.warn
                ? "border-amber-500/40 bg-amber-500/5"
                : "border-destructive/30 bg-destructive/5"
            )}
          >
            <p
              className={cn(
                "flex items-start gap-1.5 text-[11px] leading-snug font-medium",
                aiError.warn ? "text-amber-700 dark:text-amber-400" : "text-destructive"
              )}
            >
              <TriangleAlert className="mt-px h-3 w-3 shrink-0" aria-hidden />
              <span className="min-w-0">{aiError.message}</span>
            </p>
            {(aiError.offerSettings || aiError.switchTo) && (
              <div className="flex flex-wrap gap-1.5">
                {aiError.offerSettings && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-md px-2.5 text-[11px]"
                    onClick={() => useAISettings.getState().openDialog()}
                  >
                    <Settings2 className="h-3 w-3" aria-hidden />
                    Open AI settings
                  </Button>
                )}
                {aiError.switchTo && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-md px-2.5 text-[11px]"
                    onClick={() => switchProviderTo(aiError.switchTo!)}
                    title={`Switch the AI provider to ${AI_PROVIDER_LABEL[aiError.switchTo]} — then click AI suggest again`}
                  >
                    Switch to {AI_PROVIDER_SHORT[aiError.switchTo]}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* AI suggestion card — suggestion only; Apply is the explicit mutation */}
      {suggestion && (
        <div className="ai-card space-y-2 rounded-lg border border-border bg-card p-3 shadow-xs">
          <div className="flex items-center gap-1.5">
            <Sparkles className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="truncate text-[12px] font-medium tracking-tight">
              Suggested: {suggestion.category}
            </span>
            <Badge
              variant="outline"
              className="studio-chip studio-chip--warn ml-auto px-1.5 font-mono text-[10px] font-semibold tabular-nums"
            >
              {confidencePct}%
            </Badge>
            <button
              type="button"
              onClick={() => setSuggestion(null)}
              className="ai-dismiss rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              aria-label="Dismiss suggestion"
            >
              <X className="h-3 w-3" />
            </button>
          </div>

          {suggestion.reasoning ? (
            <p className="pro-help">{suggestion.reasoning}</p>
          ) : null}

          {/* Detected semantic themes — a compact stacked bar + labeled
           * chips so the user sees WHY the category was chosen. */}
          {suggestion.themes && suggestion.themes.length > 0 && (
            <div className="space-y-1" aria-label="Detected themes">
              <div
                className="ai-theme-track flex h-1.5 w-full overflow-hidden rounded-full"
                title="Semantic theme breakdown of the icon artwork"
              >
                {suggestion.themes.map((t, i) => (
                  <div
                    key={t.name}
                    className={cn(
                      "h-full min-w-[2px] transition-[width]",
                      THEME_BAR_COLORS[i % THEME_BAR_COLORS.length]
                    )}
                    style={{ width: `${Math.max(2, Math.round(t.share * 100))}%` }}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-1">
                {suggestion.themes.map((t, i) => (
                  <span
                    key={t.name}
                    className="inline-flex items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/5 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
                    title={`${t.name} — ${Math.round(t.share * 100)}% of the collection`}
                  >
                    <span
                      className={cn(
                        "inline-block h-1.5 w-1.5 rounded-full",
                        THEME_BAR_COLORS[i % THEME_BAR_COLORS.length]
                      )}
                      aria-hidden
                    />
                    {t.name} · {Math.round(t.share * 100)}%
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Analysis provenance — coverage + signal source + provider. */}
          <p className="pro-help">
            {suggestion.method === "text"
              ? "Analyzed via filenames (visual analysis unavailable)"
              : `Analyzed via icon artwork${
                  suggestion.analyzed && suggestion.analyzed.total > 0
                    ? ` · ${suggestion.analyzed.unique} of ${suggestion.analyzed.total} icons`
                    : ""
                }`}{' — '}
            {suggestionProvenance(suggestion)}
          </p>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" className="studio-cta h-8 rounded-md px-2.5 text-[11px]" onClick={applySuggestion}>
              Apply
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-md px-2.5 text-[11px]"
              onClick={() => editWith(suggestion.category)}
            >
              Edit
            </Button>
            {suggestion.alternatives
              .filter((alt) => alt.trim().length > 0)
              .map((alt) => (
                <button
                  key={alt}
                  type="button"
                  onClick={() => editWith(alt)}
                  className="ai-alt max-w-full truncate rounded-md px-1.5 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  title={`Use "${alt}" in the category field`}
                >
                  {alt}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
