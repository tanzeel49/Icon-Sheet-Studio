/**
 * ICON SHEET STUDIO — AI provider abstraction (server-only).
 *
 * ONE category-suggestion engine, TWO interchangeable transports:
 *
 *   CategorySuggestionService (analyze-category route)
 *            ↓ same prompts · same input · same parsing
 *   AIProvider ── ZAIProvider     (z-ai-web-dev-sdk, ambient server config)
 *              └─ GeminiProvider  (Google generativelanguage REST API,
 *                                  user-supplied key, configurable model)
 *
 * The route never knows which provider it is talking to — it passes the
 * SAME strong category-analysis instructions and receives a raw text
 * response it parses with its own robust extractor. Only the API
 * transport differs.
 *
 * SECURITY: the Gemini API key travels ONLY in the `x-goog-api-key`
 * request header to Google's endpoint. It is never logged, never echoed
 * in error messages, never persisted server-side, and never handed to
 * the Z.AI provider (or vice versa).
 */

/* ------------------------------------------------------------------ */
/* Error taxonomy                                                      */
/* ------------------------------------------------------------------ */

export type ProviderId = "zai" | "gemini";

export type AIErrorKind =
  | "missing-key" // no API key configured for the selected provider
  | "invalid-key" // authentication failed / permission denied
  | "rate-limit" // 429 — quota or requests-per-minute
  | "network" // could not reach the provider endpoint
  | "timeout" // request aborted after the per-call timeout
  | "unsupported-model" // model id rejected by the provider
  | "malformed" // provider answered but the payload was unusable
  | "provider-error"; // any other provider-side failure

/** Provider-classified failure. Z.AI transport errors intentionally stay
 *  RAW (the legacy surfacing the frontend already handles); Gemini errors
 *  are always wrapped so users get clean, actionable messages. */
export class AIProviderError extends Error {
  readonly kind: AIErrorKind;
  readonly providerId: ProviderId;

  constructor(kind: AIErrorKind, message: string, providerId: ProviderId = "gemini") {
    super(message);
    this.name = "AIProviderError";
    this.kind = kind;
    this.providerId = providerId;
  }
}

/** HTTP status for a classified provider error (client → friendly UI). */
export function httpStatusForKind(kind: AIErrorKind): number {
  switch (kind) {
    case "missing-key":
      return 400;
    case "invalid-key":
      return 401;
    case "unsupported-model":
      return 400;
    case "rate-limit":
      return 429;
    case "timeout":
      return 504;
    default:
      return 502; // network · malformed · provider-error
  }
}

/* ------------------------------------------------------------------ */
/* Provider interface                                                  */
/* ------------------------------------------------------------------ */

export interface AIProviderCall {
  /** system instruction (taxonomist persona). Sent as the system layer of
   *  the request on providers that support one. */
  system?: string;
  /** the user prompt (the strong category-analysis instructions). */
  user: string;
  /** PNG contact-sheet bytes, base64-encoded — presence marks a VISION call. */
  imageBase64?: string;
  imageMime?: string;
  /** enable the provider's reasoning mode (aggregation step). */
  thinking?: boolean;
  /** per-call timeout in ms (route-level timeouts stay authoritative). */
  timeoutMs?: number;
  /** request strict JSON output where the provider supports it. */
  json?: boolean;
  /** output-token ceiling (Gemini only; keeps free-tier usage tight). */
  maxOutputTokens?: number;
}

export interface AIProvider {
  readonly id: ProviderId;
  /** max concurrent in-flight calls the route should run (free-tier
   *  friendliness for Gemini). */
  readonly maxConcurrency: number;
  /** One text(+optional image) turn → raw text response. */
  complete(call: AIProviderCall): Promise<string>;
}

/* ------------------------------------------------------------------ */
/* Z.AI provider — EXACT legacy transport, byte-for-byte behavior      */
/* ------------------------------------------------------------------ */

/** Minimal shape of a chat-completion response we consume. */
interface CompletionLike {
  choices?: { message?: { content?: string } }[];
}

/** The SDK's vision body type demands a `model` the backend infers at
 *  runtime — a single, local, typed cast bridges that without changing
 *  behavior. */
type VisionCall = (body: {
  messages: { role: "user"; content: unknown[] }[];
  thinking?: { type: "disabled" | "enabled" };
}) => Promise<CompletionLike>;

async function importZai() {
  const { default: ZAI } = await import("z-ai-web-dev-sdk");
  return ZAI.create();
}
type Zai = Awaited<ReturnType<typeof importZai>>;
let zaiPromise: Promise<Zai> | null = null;
async function getZai(): Promise<Zai> {
  if (!zaiPromise) zaiPromise = importZai();
  return zaiPromise;
}

/** Read the text content out of a completion response. */
function contentOf(resp: CompletionLike | undefined | null): string {
  return resp?.choices?.[0]?.message?.content ?? "";
}

class ZAIProvider implements AIProvider {
  readonly id = "zai" as const;
  readonly maxConcurrency = 2; // legacy vision-batch concurrency (unchanged)

  constructor(private readonly zai: Zai) {}

  async complete(call: AIProviderCall): Promise<string> {
    if (call.imageBase64) {
      // EXACT legacy vision transport (contact sheet → VLM)
      const dataUrl = "data:" + (call.imageMime ?? "image/png") + ";base64," + call.imageBase64;
      const createVision = this.zai.chat.completions.createVision as unknown as VisionCall;
      const resp = await createVision({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: call.user },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        thinking: { type: "disabled" },
      });
      return contentOf(resp);
    }
    // EXACT legacy chat transport (system as assistant-role preamble,
    // thinking enabled/disabled exactly as the route used to request)
    const messages = [
      ...(call.system ? [{ role: "assistant" as const, content: call.system }] : []),
      { role: "user" as const, content: call.user },
    ];
    const resp = await this.zai.chat.completions.create({
      messages,
      thinking: { type: call.thinking ? "enabled" : "disabled" },
    });
    return contentOf(resp as CompletionLike);
  }
}

/* ------------------------------------------------------------------ */
/* Gemini provider — Google generativelanguage REST API               */
/* ------------------------------------------------------------------ */

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

/** Endpoint base. GEMINI_API_BASE lets a self-hosted deployment point the
 *  provider at a proxy; default is Google's official API. The API key is
 *  sent via the `x-goog-api-key` HEADER so it never appears in URLs. */
const GEMINI_BASE_URL = (
  process.env.GEMINI_API_BASE ?? "https://generativelanguage.googleapis.com/v1beta"
).replace(/\/+$/, "");

interface GeminiPart {
  text?: string;
  thought?: boolean;
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}
interface GeminiResponseShape {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
}

/** Google's current REST surface: POST {base}/models/{model}:generateContent
 *  with inline image parts and x-goog-api-key header auth. */
class GeminiProvider implements AIProvider {
  readonly id = "gemini" as const;
  /** Free tier ≈ 10 requests/minute — three concurrent calls with the
   *  route's retry/backoff keeps bursts inside the window. */
  readonly maxConcurrency = 3;

  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    const key = (opts.apiKey ?? "").trim();
    if (!key) {
      throw new AIProviderError("missing-key", "Add your Google Gemini API key in AI settings.");
    }
    const model = (opts.model ?? "").trim() || DEFAULT_GEMINI_MODEL;
    // the model id becomes part of the request path — reject anything that
    // is not a plain model name (defends against URL injection via a
    // hand-edited setting)
    if (!/^[A-Za-z0-9._-]+$/.test(model)) {
      throw new AIProviderError(
        "unsupported-model",
        `Gemini model "${model.slice(0, 40)}" is not a valid model id.`
      );
    }
    this.apiKey = key;
    this.model = model;
  }

  get modelName(): string {
    return this.model;
  }

  async complete(call: AIProviderCall): Promise<string> {
    const timeoutMs = call.timeoutMs ?? 90_000;

    const body: Record<string, unknown> = {
      contents: [
        {
          role: "user",
          parts: call.imageBase64
            ? [
                { text: call.user },
                {
                  inline_data: {
                    mime_type: call.imageMime ?? "image/png",
                    data: call.imageBase64,
                  },
                },
              ]
            : [{ text: call.user }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: call.maxOutputTokens ?? (call.thinking ? 8192 : 4096),
        ...(call.json ? { responseMimeType: "application/json" } : {}),
        ...this.thinkingConfig(call.thinking === true),
      },
    };
    if (call.system) {
      body.systemInstruction = { parts: [{ text: call.system }] };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${GEMINI_BASE_URL}/models/${this.model}:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw mapGeminiHttpError(res.status, await safeErrorText(res), this.model);
      }

      const data = (await res.json().catch(() => null)) as GeminiResponseShape | null;
      if (!data) {
        throw new AIProviderError("malformed", "Gemini returned an unreadable response.");
      }
      const text = extractGeminiText(data);
      if (text.trim().length === 0) {
        const block = data.promptFeedback?.blockReason;
        const finish = data.candidates?.[0]?.finishReason;
        if (block) {
          throw new AIProviderError(
            "malformed",
            `Gemini blocked the request (safety filter: ${String(block).slice(0, 40)}).`
          );
        }
        if (finish === "MAX_TOKENS") {
          throw new AIProviderError("malformed", "Gemini response was truncated (MAX_TOKENS).");
        }
        throw new AIProviderError("malformed", "Gemini returned an empty response.");
      }
      return text;
    } catch (err) {
      if (err instanceof AIProviderError) throw err;
      if (err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message))) {
        throw new AIProviderError(
          "timeout",
          `Gemini API request timed out after ${timeoutMs}ms (HTTP 504).`
        );
      }
      // fetch-level network failure — the message never contains the key
      throw new AIProviderError("network", "Unable to reach Gemini API (network error).");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Gemini 2.5-family thinking control: 0 disables on flash models, 128
   *  is the floor on pro; older/unknown models get no field at all. */
  private thinkingConfig(enabled: boolean): Record<string, unknown> {
    if (enabled) return {}; // dynamic thinking (provider default)
    if (/^gemini-2\.5-flash/.test(this.model)) return { thinkingConfig: { thinkingBudget: 0 } };
    if (/^gemini-2\.5-pro/.test(this.model)) return { thinkingConfig: { thinkingBudget: 128 } };
    return {};
  }
}

/** Read Google's error body WITHOUT ever echoing the request headers/key. */
async function safeErrorText(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: string; status?: string } };
    return data?.error?.message ?? data?.error?.status ?? "";
  } catch {
    return "";
  }
}

/** Classify a non-2xx Gemini response. Messages embed the HTTP code so the
 *  route's existing retry heuristic (429 / 5xx) keeps working unchanged. */
function mapGeminiHttpError(status: number, text: string, model: string): AIProviderError {
  const t = text.slice(0, 300);
  if (status === 429) {
    return new AIProviderError("rate-limit", "Gemini API rate limit or quota exceeded (HTTP 429).");
  }
  if (status === 400 || status === 401 || status === 403) {
    if (/api[ _]?key|unregistered|permission|credential/i.test(t)) {
      return new AIProviderError(
        "invalid-key",
        `Gemini API key is invalid or unavailable (HTTP ${status}).`
      );
    }
    if (/model|not found|not supported|unsupported/i.test(t)) {
      return new AIProviderError(
        "unsupported-model",
        `Gemini model "${model}" is not available (HTTP ${status}).`
      );
    }
    if (status === 401 || status === 403) {
      return new AIProviderError(
        "invalid-key",
        `Gemini API key is invalid or unavailable (HTTP ${status}).`
      );
    }
    return new AIProviderError("provider-error", "Gemini API rejected the request (HTTP 400).");
  }
  if (status === 404) {
    return new AIProviderError(
      "unsupported-model",
      `Gemini model "${model}" is not available (HTTP 404).`
    );
  }
  if (status >= 500) {
    return new AIProviderError(
      "provider-error",
      `Gemini API is temporarily unavailable (HTTP ${status}).`
    );
  }
  return new AIProviderError("provider-error", `Gemini API request failed (HTTP ${status}).`);
}

/** Concatenate the non-thought text parts of the first candidate. */
function extractGeminiText(data: GeminiResponseShape): string {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => typeof p?.text === "string" && p.thought !== true)
    .map((p) => p.text)
    .join("");
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export interface ProviderConfig {
  id: ProviderId;
  /** user-supplied Gemini key (arrives via the x-gemini-key request
   *  header; never stored server-side). */
  geminiKey?: string;
  geminiModel?: string;
}

/** Build the selected provider. Only the selected provider is ever
 *  constructed — the other provider's credentials are never touched. */
export async function createProvider(cfg: ProviderConfig): Promise<AIProvider> {
  if (cfg.id === "gemini") {
    return new GeminiProvider({ apiKey: cfg.geminiKey ?? "", model: cfg.geminiModel });
  }
  return new ZAIProvider(await getZai());
}

/** Resolve the effective Gemini model id (for echoing in responses). */
export function effectiveGeminiModel(model: string | undefined): string {
  const m = (model ?? "").trim();
  return m || DEFAULT_GEMINI_MODEL;
}
