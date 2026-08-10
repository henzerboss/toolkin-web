import { ensureAccount, type Account } from '@/lib/credits';

/**
 * Общая обвязка API-роутов Toolkin.
 * Повторяет соглашения проекта (nodejs runtime, CORS, X-Client-Token,
 * ограничение по IP) и добавляет одно своё: идентификацию по appUserId
 * из RevenueCat — регистрации в приложении нет.
 */

export const TOOLKIN_MODELS: string[] = (
  process.env.TOOLKIN_MODELS ?? 'gemini-2.5-flash,gemini-2.5-flash-lite'
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const TEMPERATURE = Number.parseFloat(process.env.TOOLKIN_TEMPERATURE ?? '0.4');
const MAX_OUTPUT_TOKENS = Number.parseInt(process.env.TOOLKIN_MAX_OUTPUT_TOKENS ?? '8192', 10);
const ATTEMPTS_PER_MODEL = 2;
const RETRY_DELAY_MS = 120;

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
const LIMIT = Number.parseInt(process.env.TOOLKIN_RATE_LIMIT ?? '120', 10);
const WINDOW_MS = 60 * 60 * 1000;

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
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

/**
 * Единая проверка на входе каждого роута. Возвращает готовый ответ при отказе,
 * чтобы в самих роутах не расползались варианты формата ошибки.
 */
export async function guard(req: Request, options: { requireAccount?: boolean } = {}): Promise<Guard> {
  const origin = req.headers.get('origin') ?? '';
  const headers = { 'Content-Type': 'application/json', ...cors(origin) };

  const token = req.headers.get('X-Client-Token');
  if (process.env.TOOLKIN_CLIENT_TOKEN && token !== process.env.TOOLKIN_CLIENT_TOKEN) {
    return { ok: false, headers, response: json({ error: 'unauthorized' }, 401, headers) };
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown';
  if (!checkRateLimit(ip)) {
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

export interface GeminiResult {
  ok: boolean;
  text?: string;
  error?: string;
  model?: string;
}

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

async function callOnce(
  model: string,
  apiKey: string,
  system: string,
  parts: GeminiPart[],
  jsonOnly: boolean,
): Promise<GeminiResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: TEMPERATURE,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        ...(jsonOnly ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, error: detail || `gemini_${res.status}` };
  }

  const body: { candidates?: { content?: { parts?: { text?: string }[] } }[] } = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return text ? { ok: true, text, model } : { ok: false, error: 'empty_response' };
}

export async function callGemini(
  system: string,
  prompt: string,
  options: { imageBase64?: string; jsonOnly?: boolean } = {},
): Promise<GeminiResult> {
  const apiKey = process.env.TOOLKIN_GEMINI_API_KEY ?? process.env.RECIPE_GEMINI_API_KEY;
  if (!apiKey) return { ok: false, error: 'TOOLKIN_GEMINI_API_KEY missing' };

  const parts: GeminiPart[] = [{ text: prompt }];
  if (options.imageBase64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: options.imageBase64 } });

  let lastError = 'unavailable';
  for (const model of TOOLKIN_MODELS) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const result = await callOnce(model, apiKey, system, parts, options.jsonOnly !== false);
        if (result.ok) return result;
        lastError = result.error ?? 'unknown';
      } catch (error) {
        lastError = String(error);
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  return { ok: false, error: `all_models_failed: ${lastError}` };
}

export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const cleaned = text.replace(/```json|```/g, '').trim();
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      return fallback;
    }
  }
}
