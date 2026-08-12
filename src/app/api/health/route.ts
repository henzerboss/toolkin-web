import { MODELS_BY_PURPOSE, cors, guard, json, toGeminiRestThinkingLevel } from '../_shared';

export const runtime = 'nodejs';

const CONFIGURED_MODELS = [...new Set(Object.values(MODELS_BY_PURPOSE).flat())];
const PROBE_CACHE_MS = 5 * 60 * 1000;

type ProbeState = {
  expiresAt: number;
  available: string[];
  listError: string | null;
  probes: { model: string; ok: boolean; status: number; error?: string }[];
  working: string[];
  planner: { model: string; ok: boolean; status: number; error?: string };
  image: Record<string, unknown>;
};
let probeCache: ProbeState | null = null;

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin') ?? '') });
}

/**
 * Production diagnostics. External model/image checks are cached for five
 * minutes: health endpoints are often polled and must not become a paid API
 * amplifier by themselves.
 */
export async function GET(req: Request) {
  const g = await guard(req, { requireAccount: false });
  if (!g.ok) return g.response!;
  const { headers } = g;

  const apiKey = process.env.TOOLKIN_GEMINI_API_KEY;
  if (!apiKey) return json({ ok: false, error: 'TOOLKIN_GEMINI_API_KEY is not configured' }, 500, headers);

  const now = Date.now();
  const cacheHit = Boolean(probeCache && probeCache.expiresAt > now);
  const external = cacheHit ? probeCache! : await runExternalProbes(apiKey, now);
  if (!cacheHit) probeCache = external;

  const productionConfigOk = process.env.NODE_ENV !== 'production' || Boolean(
    process.env.DATABASE_URL &&
    process.env.TOOLKIN_CLIENT_TOKEN &&
    process.env.TOOLKIN_PLAN_SECRET &&
    process.env.TOOLKIN_REVENUECAT_WEBHOOK_SECRET
  );
  const planWorking = MODELS_BY_PURPOSE.plan.some((model) => external.working.includes(model));
  const ok = planWorking && external.planner.ok && productionConfigOk;

  return json(
    {
      ok,
      configured: CONFIGURED_MODELS,
      working: external.working,
      planWorking,
      plannerProbe: external.planner,
      probes: external.probes,
      listError: external.listError,
      availableCount: external.available.length,
      suggestions: external.available.filter((name) => /flash|pro/.test(name)).slice(0, 12),
      image: external.image,
      probeCached: cacheHit,
      database: Boolean(process.env.DATABASE_URL),
      clientTokenSet: Boolean(process.env.TOOLKIN_CLIENT_TOKEN),
      planSecretSet: Boolean(process.env.TOOLKIN_PLAN_SECRET),
      revenueCatWebhookSecretSet: Boolean(process.env.TOOLKIN_REVENUECAT_WEBHOOK_SECRET),
      productionConfigOk,
    },
    ok ? 200 : 503,
    headers,
  );
}

async function runExternalProbes(apiKey: string, now: number): Promise<ProbeState> {
  let available: string[] = [];
  let listError: string | null = null;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (res.ok) {
      const body = (await res.json()) as { models?: { name?: string }[] };
      available = (body.models ?? [])
        .map((model) => (model.name ?? '').replace(/^models\//, ''))
        .filter(Boolean);
    } else {
      listError = `${res.status}`;
    }
  } catch (error) {
    listError = String(error);
  }

  const probes = await Promise.all(
    CONFIGURED_MODELS.map(async (model) => {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
              generationConfig: { maxOutputTokens: 1 },
            }),
          },
        );
        return { model, ok: res.ok, status: res.status };
      } catch (error) {
        return { model, ok: false, status: 0, error: String(error) };
      }
    }),
  );

  const planner = await probePlanner(apiKey);

  return {
    expiresAt: now + PROBE_CACHE_MS,
    available,
    listError,
    probes,
    working: probes.filter((probe) => probe.ok).map((probe) => probe.model),
    planner,
    image: await probeImage(),
  };
}

async function probePlanner(apiKey: string): Promise<ProbeState['planner']> {
  let last = { model: MODELS_BY_PURPOSE.plan[0] ?? 'none', ok: false, status: 0, error: 'no_plan_models' };
  for (const model of MODELS_BY_PURPOSE.plan) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Return JSON with ok=true.' }] }],
            generationConfig: {
              maxOutputTokens: 32,
              thinkingConfig: { thinkingLevel: toGeminiRestThinkingLevel('minimal') },
              responseMimeType: 'application/json',
              responseJsonSchema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
                required: ['ok'],
              },
            },
          }),
        },
      );
      if (!res.ok) {
        last = { model, ok: false, status: res.status, error: (await res.text()).slice(0, 400) };
        continue;
      }
      const body = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = (body.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('').trim();
      let parsedOk = false;
      try { parsedOk = JSON.parse(text)?.ok === true; } catch { parsedOk = false; }
      if (parsedOk) return { model, ok: true, status: res.status };
      last = { model, ok: false, status: res.status, error: 'structured_output_invalid' };
    } catch (error) {
      last = { model, ok: false, status: 0, error: String(error).slice(0, 400) };
    }
  }
  return last;
}

async function probeImage(): Promise<Record<string, unknown>> {
  const key = process.env.TOOLKIN_DEEPINFRA_API_KEY;
  if (!key) return { ok: false, optional: true, reason: 'TOOLKIN_DEEPINFRA_API_KEY is not configured' };

  const model = process.env.TOOLKIN_DEEPINFRA_IMAGE_MODEL ?? 'black-forest-labs/FLUX-1-schnell';
  const size = process.env.TOOLKIN_DEEPINFRA_IMAGE_SIZE ?? '1024x1024';

  try {
    const res = await fetch('https://api.deepinfra.com/v1/openai/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, prompt: 'a red circle on white background', size, n: 1 }),
    });

    const text = await res.text();
    if (!res.ok) return { ok: false, model, status: res.status, detail: text.slice(0, 400) };

    const payload = JSON.parse(text) as { data?: { b64_json?: string; url?: string }[] };
    const entry = payload.data?.[0];
    return {
      ok: Boolean(entry?.b64_json || entry?.url),
      model,
      size,
      bytes: entry?.b64_json ? Math.round((entry.b64_json.length * 3) / 4) : 0,
      shape: entry ? Object.keys(entry) : Object.keys(payload),
    };
  } catch (error) {
    return { ok: false, model, detail: String(error).slice(0, 300) };
  }
}
