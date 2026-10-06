"use client";

/**
 * ICON SHEET STUDIO — AI provider settings dialog.
 *
 * Choose which AI provider powers Category Suggestions (Z.AI or Google
 * Gemini), configure the Gemini API key (masked, Show/Hide only on
 * explicit request), pick the Gemini model, and test the connection.
 *
 * The dialog is state-driven from the ai-settings store so it can be
 * opened from anywhere (Category & Volume gear button, command palette,
 * error affordances). Keys are stored ONLY in this browser's localStorage
 * — never in sheet data, exports, backups, or the project zip.
 */

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  PlugZap,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  AI_PROVIDER_LABEL,
  AIProviderId,
  CUSTOM_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODEL_OPTIONS,
  useAISettings,
} from "@/lib/studio/ai-settings";

interface TestResult {
  ok: boolean;
  kind: string;
  message: string;
}

export function AISettingsDialog() {
  const open = useAISettings((s) => s.dialogOpen);
  const hydrated = useAISettings((s) => s.hydrated);
  const provider = useAISettings((s) => s.provider);
  const geminiKey = useAISettings((s) => s.geminiKey);
  const geminiModel = useAISettings((s) => s.geminiModel);
  const setProvider = useAISettings((s) => s.setProvider);
  const setGeminiKey = useAISettings((s) => s.setGeminiKey);
  const setGeminiModel = useAISettings((s) => s.setGeminiModel);
  const closeDialog = useAISettings((s) => s.closeDialog);
  const hydrate = useAISettings((s) => s.hydrate);

  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const testingRef = useRef(false);

  /* hydrate stored settings after mount (SSR-safe) */
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  /* key/model/provider changes invalidate any previous test result */
  useEffect(() => {
    setTestResult(null);
  }, [provider, geminiKey, geminiModel]);

  const isPresetModel = GEMINI_MODEL_OPTIONS.some((o) => o.value === geminiModel);
  const keyConfigured = geminiKey.trim().length > 0;

  const runTest = async () => {
    if (testingRef.current) return;
    testingRef.current = true;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/ai-provider/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          geminiKey: provider === "gemini" ? geminiKey : "",
          geminiModel,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<TestResult>;
      setTestResult({
        ok: data.ok === true,
        kind: data.kind ?? "provider-error",
        message: data.message ?? "Test failed — unexpected server response.",
      });
    } catch {
      setTestResult({ ok: false, kind: "network", message: "Unable to reach the app server." });
    } finally {
      testingRef.current = false;
      setTesting(false);
    }
  };

  const resultIcon = (r: TestResult) => {
    if (r.ok) return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />;
    if (r.kind === "invalid-key" || r.kind === "missing-key")
      return <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />;
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />;
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : closeDialog())}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="border-b border-border/70 px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span className="studio-dlg-tile">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            AI provider settings
          </DialogTitle>
          <DialogDescription className="text-xs leading-snug">
            Choose which AI provider analyzes your icon collections for category suggestions. Both
            providers use the same artwork-driven analysis and produce the same result format.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] overflow-y-auto px-4 py-3.5 space-y-4">
          {/* ---- provider selection ---------------------------------- */}
          <div className="space-y-2.5">
            <p className="pro-label">AI category provider</p>
            <RadioGroup
              value={provider}
              onValueChange={(v) => setProvider(v === "gemini" ? "gemini" : "zai")}
              className="grid gap-2"
            >
              <label
                className={cn(
                  "ai-provider-card studio-lift flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 outline-none",
                  provider === "zai"
                    ? "border-amber-500/50 bg-amber-500/[0.07] shadow-sm"
                    : "border-border/70 hover:border-amber-500/40 hover:bg-amber-500/[0.04] hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring"
                )}
              >
                <RadioGroupItem value="zai" className="mt-0.5" aria-label="Use Z.AI" />
                <span className="min-w-0 space-y-0.5">
                  <span className="flex items-center gap-1.5 text-[12px] font-medium">
                    <Bot className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    Z.AI
                  </span>
                  <span className="block pro-help">
                    Built-in provider · configured on this server · no key needed
                  </span>
                </span>
              </label>

              <label
                className={cn(
                  "ai-provider-card studio-lift flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 outline-none",
                  provider === "gemini"
                    ? "border-amber-500/50 bg-amber-500/[0.07] shadow-sm"
                    : "border-border/70 hover:border-amber-500/40 hover:bg-amber-500/[0.04] hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring"
                )}
              >
                <RadioGroupItem value="gemini" className="mt-0.5" aria-label="Use Google Gemini" />
                <span className="min-w-0 space-y-0.5">
                  <span className="flex items-center gap-1.5 text-[12px] font-medium">
                    <Sparkles className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    Google Gemini
                  </span>
                  <span className="block pro-help">
                    Your own API key · free tier supported · same artwork analysis
                  </span>
                </span>
              </label>
            </RadioGroup>
            <p className="pro-help" aria-live="polite">
              {hydrated
                ? provider === "gemini"
                  ? keyConfigured
                    ? `Using Google Gemini${isPresetModel ? "" : ` · ${geminiModel}`} — the “AI suggest” button will call Gemini only.`
                    : "Add your Gemini API key below to use Gemini suggestions."
                  : "Using Z.AI — the “AI suggest” button will call Z.AI only."
                : "Loading provider settings…"}
            </p>
          </div>

          {/* ---- Gemini configuration (when selected) ---------------- */}
          {provider === "gemini" && (
            <div className="space-y-4 rounded-lg border border-border/70 bg-card/60 p-3 dark:border-border">
              {/* API key */}
              <div className="space-y-2">
                <Label htmlFor="iss-gemini-key" className="pro-label gap-1.5 flex items-center">
                  <KeyRound className="h-3 w-3 text-muted-foreground" aria-hidden />
                  Google Gemini API key
                </Label>
                <div className="relative">
                  <Input
                    id="iss-gemini-key"
                    type={showKey ? "text" : "password"}
                    value={geminiKey}
                    onChange={(e) => setGeminiKey(e.target.value)}
                    placeholder="Paste your API key (AIza…)"
                    autoComplete="off"
                    spellCheck={false}
                    className="h-8 pr-9 font-mono text-[11px]"
                    aria-label="Google Gemini API key"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                    title={showKey ? "Hide the API key" : "Reveal the API key (masking is on by default)"}
                  >
                    {showKey ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
                  </button>
                </div>
                <p className="pro-help">
                  Stored only in this browser (local settings) — never in sheet data, exports,
                  backups, or the project zip.{" "}
                  <a
                    href="https://aistudio.google.com/app/apikey"
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-dotted hover:text-foreground"
                  >
                    Get a free key at Google AI Studio
                  </a>
                  .
                </p>
              </div>

              {/* Model */}
              <div className="space-y-2">
                <Label htmlFor="iss-gemini-model" className="pro-label">
                  Gemini model
                </Label>
                <Select
                  value={isPresetModel ? geminiModel : CUSTOM_GEMINI_MODEL}
                  onValueChange={(v) => setGeminiModel(v === CUSTOM_GEMINI_MODEL ? "" : v)}
                >
                  <SelectTrigger id="iss-gemini-model" className="h-8 text-[11px]" aria-label="Gemini model">
                    <SelectValue placeholder="Choose a Gemini model" />
                  </SelectTrigger>
                  <SelectContent>
                    {GEMINI_MODEL_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value} className="text-[11px]">
                        {o.label}
                        <span className="ml-1.5 text-[10px] text-muted-foreground">{o.hint}</span>
                      </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM_GEMINI_MODEL} className="text-[11px]">
                      Custom model id…
                    </SelectItem>
                  </SelectContent>
                </Select>
                {!isPresetModel && (
                  <Input
                    value={geminiModel}
                    onChange={(e) => setGeminiModel(e.target.value)}
                    placeholder={`e.g. ${DEFAULT_GEMINI_MODEL}`}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-8 font-mono text-[11px]"
                    aria-label="Custom Gemini model id"
                  />
                )}
                <p className="pro-help">
                  Default <span className="font-mono">{DEFAULT_GEMINI_MODEL}</span> — fast, strong at
                  icon classification, and free-tier friendly.
                </p>
              </div>
            </div>
          )}

          {/* ---- connection test (works for either provider) --------- */}
          <div className="space-y-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-[11px]"
              onClick={runTest}
              disabled={testing || (provider === "gemini" && !keyConfigured)}
              title={
                provider === "gemini" && !keyConfigured
                  ? "Paste your Gemini API key first"
                  : `Run a tiny test request against ${AI_PROVIDER_LABEL[provider]}`
              }
            >
              {testing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <PlugZap className="h-3.5 w-3.5" aria-hidden />
              )}
              {testing ? "Testing…" : `Test ${AI_PROVIDER_LABEL[provider]} connection`}
            </Button>
            {testResult && (
              <p
                role="status"
                className={cn(
                  "flex items-start gap-1.5 rounded-md border p-2.5 text-[11px] leading-snug",
                  testResult.ok
                    ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                    : testResult.kind === "invalid-key" || testResult.kind === "missing-key"
                      ? "border-destructive/30 bg-destructive/5 text-destructive"
                      : "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400"
                )}
              >
                {resultIcon(testResult)}
                <span className="min-w-0">{testResult.message}</span>
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="studio-dlg-footer items-center justify-between gap-3 px-4 py-3 sm:justify-between">
          <p className="flex items-start gap-1.5 pro-help">
            <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            Keys never leave this browser except to call the selected provider&apos;s own API.
          </p>
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0 text-[11px]"
            onClick={closeDialog}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
