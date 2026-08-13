import { ensureAccount, type Account } from '@/lib/credits';

/** Shared API/runtime helpers for Toolkin backend. */

const parseModels = (value: string | undefined, fallback: string): string[] =>
  (value ?? fallback)
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);

const DEFAULT_MODEL_CASCADE = 'gemini-3.6-flash,gemini-3.5-flash';
const GLOBAL_MODELS = process.env.TOOLKIN_MODELS;

export const MODELS: string[] = parseModels(GLOBAL_MODELS, DEFAULT_MODEL_CASCADE);

const purposeModels = (specific: string | undefined, fallback: string): string[] =>
  parseModels(specific ?? GLOBAL_MODELS, fallback);

export const MODELS_BY_PURPOSE = {
  plan: purposeModels(process.env.TOOLKIN_MODELS_PLAN, 'gemini-3.6-flash,gemini-3.5-flash-lite'),
  generate: purposeModels(process.env.TOOLKIN_MODELS_GENERATE, DEFAULT_MODEL_CASCADE),
  refine: purposeModels(process.env.TOOLKIN_MODELS_REFINE, DEFAULT_MODEL_CASCADE),
  ask: purposeModels(process.env.TOOLKIN_MODELS_ASK, 'gemini-3.5-flash-lite'),
  verify: purposeModels(process.env.TOOLKIN_MODELS_VERIFY, 'gemini-3.5-flash-lite,gemini-3.5-flash'),
  translate: purposeModels(process.env.TOOLKIN_MODELS_TRANSLATE, 'gemini-3.5-flash-lite'),
} as const;

export type Purpose = keyof typeof MODELS_BY_PURPOSE;

const parsePositiveInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

/**
 * Spec v2 may legitimately need substantially more than 8k tokens. Keep limits
 * per task: the planner/ask paths stay cheap while generation/refinement have
 * enough room to finish a complete JSON object instead of being cut mid-token.
 */
const OUTPUT_LIMITS: Record<Purpose, number> = {
  plan: parsePositiveInt(process.env.TOOLKIN_MAX_OUTPUT_TOKENS_PLAN, 6144, 512, 65536),
  generate: parsePositiveInt(process.env.TOOLKIN_MAX_OUTPUT_TOKENS_GENERATE, 32768, 2048, 65536),
  refine: parsePositiveInt(process.env.TOOLKIN_MAX_OUTPUT_TOKENS_REFINE, 32768, 2048, 65536),
  ask: parsePositiveInt(process.env.TOOLKIN_MAX_OUTPUT_TOKENS_ASK, 4096, 256, 65536),
  verify: parsePositiveInt(process.env.TOOLKIN_MAX_OUTPUT_TOKENS_VERIFY, 4096, 512, 65536),
  translate: parsePositiveInt(process.env.TOOLKIN_MAX_OUTPUT_TOKENS_TRANSLATE, 2048, 128, 65536),
};

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export type GeminiRestThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
export const toGeminiRestThinkingLevel = (level: ThinkingLevel): GeminiRestThinkingLevel =>
  level.toUpperCase() as GeminiRestThinkingLevel;
const THINKING_LEVELS = new Set<ThinkingLevel>(['minimal', 'low', 'medium', 'high']);
const parseThinking = (value: string | undefined, fallback: ThinkingLevel): ThinkingLevel =>
  value && THINKING_LEVELS.has(value as ThinkingLevel) ? (value as ThinkingLevel) : fallback;

export const THINKING: Record<Purpose, ThinkingLevel> = {
  plan: parseThinking(process.env.TOOLKIN_THINKING_PLAN, 'medium'),
  generate: parseThinking(process.env.TOOLKIN_THINKING_GENERATE, 'medium'),
  refine: parseThinking(process.env.TOOLKIN_THINKING_REFINE, 'medium'),
  ask: parseThinking(process.env.TOOLKIN_THINKING_ASK, 'low'),
  verify: parseThinking(process.env.TOOLKIN_THINKING_VERIFY, 'low'),
  translate: 'low',
};

const ATTEMPTS_PER_MODEL = parsePositiveInt(process.env.TOOLKIN_ATTEMPTS_PER_MODEL, 1, 1, 2);
const MAX_MODELS_PER_CALL = parsePositiveInt(process.env.TOOLKIN_MAX_MODELS_PER_CALL, 2, 1, 3);
const RETRY_DELAY_MS = 150;
const AI_REQUEST_TIMEOUT_MS = parsePositiveInt(process.env.TOOLKIN_AI_REQUEST_TIMEOUT_MS, 90_000, 10_000, 180_000);

export function cors(origin: string) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Client-Token, X-App-User-Id',
    Vary: 'Origin',
  };
}

export function json(data: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(data), { status, headers });
}

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const LIMIT = parsePositiveInt(process.env.TOOLKIN_RATE_LIMIT, 120, 1, 100000);
const WINDOW_MS = 60 * 60 * 1000;
let rateLimitChecks = 0;

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  if ((rateLimitChecks++ & 255) === 0) {
    for (const [key, value] of rateLimitMap) if (now > value.resetTime) rateLimitMap.delete(key);
  }
  const rec = rateLimitMap.get(ip);
  if (!rec || now > rec.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + WINDOW_MS });
    return true;
  }
  if (rec.count >= LIMIT) return false;
  rec.count += 1;
  return true;
}

export interface Guard {
  ok: boolean;
  response?: Response;
  account?: Account;
  headers: Record<string, string>;
}

export async function guard(req: Request, options: { requireAccount?: boolean; rateLimit?: boolean } = {}): Promise<Guard> {
  const origin = req.headers.get('origin') ?? '';
  const headers = { 'Content-Type': 'application/json', ...cors(origin) };

  const token = req.headers.get('X-Client-Token');
  if (process.env.TOOLKIN_CLIENT_TOKEN && token !== process.env.TOOLKIN_CLIENT_TOKEN) {
    return { ok: false, headers, response: json({ error: 'unauthorized' }, 401, headers) };
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown';
  if (options.rateLimit !== false && !checkRateLimit(ip)) {
    return { ok: false, headers, response: json({ error: 'rate_limited' }, 429, headers) };
  }

  if (options.requireAccount === false) return { ok: true, headers };

  const appUserId = (req.headers.get('X-App-User-Id') ?? '').trim();
  if (!appUserId || appUserId.length > 128) {
    return { ok: false, headers, response: json({ error: 'missing_app_user_id' }, 400, headers) };
  }

  const account = await ensureAccount(appUserId);
  return { ok: true, headers, account };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface GeminiUsage {
  input: number;
  output: number;
  thoughts: number;
}

export interface GeminiResult {
  ok: boolean;
  text?: string;
  error?: string;
  model?: string;
  usage?: GeminiUsage;
  transport?: 'interactions' | 'generateContent';
}

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/** Convert the compact OpenAPI-like schemas used in this repository to JSON Schema. */
export function toResponseJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert);
    if (!value || typeof value !== 'object') return value;
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(source)) {
      // propertyOrdering is a provider-specific legacy extension, not JSON Schema.
      if (key === 'propertyOrdering') continue;
      if (key === 'type' && typeof raw === 'string') out[key] = raw.toLowerCase();
      else out[key] = convert(raw);
    }
    return out;
  };
  return convert(schema) as Record<string, unknown>;
}

const DEFAULT_JSON_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
};

/**
 * Current production JSON transport. The Interactions API has one response_format
 * field that both requests application/json and enforces the schema. That removes
 * the main source of "valid MIME type but malformed JSON" failures.
 */
async function callOnceInteractions(
  model: string,
  apiKey: string,
  system: string,
  prompt: string,
  thinking: ThinkingLevel,
  maxOutputTokens: number,
  responseSchema?: Record<string, unknown>,
): Promise<GeminiResult> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/interactions?key=${apiKey}`, {
    method: 'POST',
    signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      // Explicitly document the schema generation the backend was implemented for.
      // The revision header is ignored by Google after the legacy sunset, which is safe.
      'Api-Revision': '2026-05-20',
    },
    body: JSON.stringify({
      model,
      input: prompt,
      system_instruction: system,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: responseSchema ? toResponseJsonSchema(responseSchema) : DEFAULT_JSON_OBJECT_SCHEMA,
      },
      generation_config: {
        max_output_tokens: maxOutputTokens,
        thinking_level: thinking,
      },
      store: false,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, error: detail || `gemini_interactions_${res.status}`, transport: 'interactions' };
  }

  const body = (await res.json()) as {
    status?: string;
    steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    usage?: {
      total_input_tokens?: number;
      total_output_tokens?: number;
      total_thought_tokens?: number;
    };
  };

  if (body.status && body.status !== 'completed') {
    return { ok: false, error: `interaction_${body.status}`, model, transport: 'interactions' };
  }

  const text = (body.steps ?? [])
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => step.content ?? [])
    .filter((content) => content.type === 'text')
    .map((content) => content.text ?? '')
    .join('')
    .trim();

  const usage: GeminiUsage = {
    input: body.usage?.total_input_tokens ?? 0,
    output: body.usage?.total_output_tokens ?? 0,
    thoughts: body.usage?.total_thought_tokens ?? 0,
  };

  return text
    ? { ok: true, text, model, usage, transport: 'interactions' }
    : { ok: false, error: 'empty_response', model, usage, transport: 'interactions' };
}

/**
 * generateContent remains only for plain text and multimodal requests. We no
 * longer attach responseJsonSchema here; JSON app creation goes through
 * Interactions structured output above.
 */
async function callOnceGenerateContent(
  model: string,
  apiKey: string,
  system: string,
  parts: GeminiPart[],
  jsonOnly: boolean,
  thinking: ThinkingLevel,
  maxOutputTokens: number,
): Promise<GeminiResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        maxOutputTokens,
        thinkingConfig: { thinkingLevel: toGeminiRestThinkingLevel(thinking) },
        ...(jsonOnly ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, error: detail || `gemini_${res.status}`, transport: 'generateContent' };
  }

  const body = (await res.json()) as {
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  const candidate = body.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('').trim();
  const usage: GeminiUsage = {
    input: body.usageMetadata?.promptTokenCount ?? 0,
    output: body.usageMetadata?.candidatesTokenCount ?? 0,
    thoughts: body.usageMetadata?.thoughtsTokenCount ?? 0,
  };

  if (!text) {
    const suffix = candidate?.finishReason ? `_${candidate.finishReason.toLowerCase()}` : '';
    return { ok: false, error: `empty_response${suffix}`, model, usage, transport: 'generateContent' };
  }
  return { ok: true, text, model, usage, transport: 'generateContent' };
}

export async function callGemini(
  system: string,
  prompt: string,
  options: {
    imageBase64?: string;
    jsonOnly?: boolean;
    thinking?: ThinkingLevel;
    purpose?: Purpose;
    responseSchema?: Record<string, unknown>;
  } = {},
): Promise<GeminiResult> {
  const apiKey = process.env.TOOLKIN_GEMINI_API_KEY ?? process.env.RECIPE_GEMINI_API_KEY;
  if (!apiKey) return { ok: false, error: 'TOOLKIN_GEMINI_API_KEY missing' };

  const purpose = options.purpose ?? 'generate';
  const models = (MODELS_BY_PURPOSE[purpose] ?? MODELS).slice(0, MAX_MODELS_PER_CALL);
  const thinking = options.thinking ?? THINKING[purpose] ?? 'medium';
  const jsonOnly = options.jsonOnly !== false;
  const maxOutputTokens = OUTPUT_LIMITS[purpose];

  const parts: GeminiPart[] = [{ text: prompt }];
  if (options.imageBase64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: options.imageBase64 } });

  let lastError = 'unavailable';
  for (const model of models) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const result = jsonOnly && !options.imageBase64
          ? await callOnceInteractions(model, apiKey, system, prompt, thinking, maxOutputTokens, options.responseSchema)
          : await callOnceGenerateContent(model, apiKey, system, parts, jsonOnly, thinking, maxOutputTokens);
        if (result.ok) return result;
        lastError = result.error ?? 'unknown';
      } catch (error) {
        lastError = String(error);
      }
      if (attempt + 1 < ATTEMPTS_PER_MODEL) await sleep(RETRY_DELAY_MS);
    }
  }
  return { ok: false, error: `all_models_failed: ${lastError}` };
}

/** Find the first balanced JSON object/array while respecting quoted strings. */
function extractBalancedJson(text: string): string | null {
  const start = text.search(/[\[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function safeJsonParse<T>(text: string, fallback: T): T {
  const candidates = [
    text.trim(),
    text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim(),
    extractBalancedJson(text) ?? '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) as T; } catch { /* try next representation */ }
  }
  return fallback;
}
