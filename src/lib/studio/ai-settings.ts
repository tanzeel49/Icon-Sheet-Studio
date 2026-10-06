"use client";

/**
 * ICON SHEET STUDIO — AI provider settings (client-side).
 *
 * Which AI provider powers Category Suggestions (Z.AI or Google Gemini),
 * plus the user's Gemini API key and model choice.
 *
 * STORAGE CONTRACT (security-critical):
 *  - Lives ONLY in this browser's localStorage under "iss-ai-settings-v1"
 *    — the SAME pattern the app already uses for pure-UX memory (command
 *    palette recents, inspector recents). It is APPLICATION configuration,
 *    not project content.
 *  - NEVER written to the Zustand studio store, IndexedDB, workspace
 *    backups, sheet/template/preset data, SVG exports, or the project zip.
 *  - The key is sent ONLY to our own /api routes and forwarded by them
 *    ONLY to the selected provider's endpoint.
 *
 * Hydration is deferred to a post-mount effect (see `hydrate`) so SSR
 * markup and the first client render stay identical — no hydration
 * mismatch when a stored provider differs from the default.
 */

import { create } from "zustand";

export type AIProviderId = "zai" | "gemini";

/** Display labels used across the UI. */
export const AI_PROVIDER_LABEL: Record<AIProviderId, string> = {
  zai: "Z.AI",
  gemini: "Google Gemini",
};

/** Compact labels for tight spots (the AI Suggest button suffix). */
export const AI_PROVIDER_SHORT: Record<AIProviderId, string> = {
  zai: "Z.AI",
  gemini: "Gemini",
};

/** Recommended Gemini models (configurable — Custom… lets users type any
 * id). Keep in sync with DEFAULT_GEMINI_MODEL in src/lib/ai/provider.ts. */
export interface GeminiModelOption {
  value: string;
  label: string;
  hint: string;
}

export const GEMINI_MODEL_OPTIONS: GeminiModelOption[] = [
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "Recommended · balanced speed & quality" },
  { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", hint: "Fastest · lowest API usage" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "Most capable · slower" },
  { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash", hint: "Previous generation" },
];

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

/** Sentinel select value meaning "type a custom model id". */
export const CUSTOM_GEMINI_MODEL = "__custom__";

const STORAGE_KEY = "iss-ai-settings-v1";

interface PersistedShape {
  v: 1;
  provider: AIProviderId;
  geminiKey: string;
  geminiModel: string;
}

function loadPersisted(): PersistedShape {
  const fallback: PersistedShape = {
    v: 1,
    provider: "zai",
    geminiKey: "",
    geminiModel: DEFAULT_GEMINI_MODEL,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    return {
      v: 1,
      provider: parsed.provider === "gemini" ? "gemini" : "zai",
      geminiKey: typeof parsed.geminiKey === "string" ? parsed.geminiKey : "",
      geminiModel:
        typeof parsed.geminiModel === "string" && parsed.geminiModel.trim().length > 0
          ? parsed.geminiModel.trim()
          : DEFAULT_GEMINI_MODEL,
    };
  } catch {
    return fallback;
  }
}

/** Debounced localStorage writes — state updates are immediate, only the
 *  disk flush waits so typing a key doesn't write per keystroke. */
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function persist(state: Pick<PersistedShape, "provider" | "geminiKey" | "geminiModel">): void {
  if (typeof window === "undefined") return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ...state }));
    } catch {
      /* storage blocked/full — settings live in memory for this session */
    }
  }, 250);
}

interface AISettingsState {
  provider: AIProviderId;
  geminiKey: string;
  geminiModel: string;
  /** true once stored settings have been read post-mount. */
  hydrated: boolean;
  dialogOpen: boolean;
  hydrate: () => void;
  setProvider: (p: AIProviderId) => void;
  setGeminiKey: (k: string) => void;
  setGeminiModel: (m: string) => void;
  openDialog: () => void;
  closeDialog: () => void;
}

export const useAISettings = create<AISettingsState>((set, get) => ({
  // SSR-safe defaults; real values arrive via hydrate() after mount
  provider: "zai",
  geminiKey: "",
  geminiModel: DEFAULT_GEMINI_MODEL,
  hydrated: false,
  dialogOpen: false,

  hydrate: () => {
    if (get().hydrated || typeof window === "undefined") return;
    const stored = loadPersisted();
    set({ ...stored, hydrated: true });
  },

  setProvider: (provider) => {
    set({ provider });
    const s = get();
    persist({ provider: s.provider, geminiKey: s.geminiKey, geminiModel: s.geminiModel });
  },

  setGeminiKey: (geminiKey) => {
    set({ geminiKey });
    const s = get();
    persist({ provider: s.provider, geminiKey: s.geminiKey, geminiModel: s.geminiModel });
  },

  setGeminiModel: (geminiModel) => {
    set({ geminiModel: geminiModel.trim() });
    const s = get();
    persist({ provider: s.provider, geminiKey: s.geminiKey, geminiModel: s.geminiModel });
  },

  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),
}));

/** Gemini is usable when a key is present (used for switch affordances). */
export function isGeminiReady(): boolean {
  return useAISettings.getState().geminiKey.trim().length > 0;
}
