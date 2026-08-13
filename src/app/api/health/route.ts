import { MODELS_BY_PURPOSE, callGemini, cors, guard, json } from '../_shared';
import { PIPELINE_VERSION } from '@/lib/specCacheKey';
import prisma from '@/lib/prisma';

export const runtime = 'nodejs';

const CONFIGURED_MODELS = [...new Set(Object.values(MODELS_BY_PURPOSE).flat())];
const PROBE_CACHE_MS = 5 * 60 * 1000;

type ProbeState = {
  expiresAt: number;
  available: string[];
  listError: string | null;
  probes: { model: string; ok: boolean; status: number; error?: string }[];
  working: string[];
  planner: { model: string; ok: boolean; status: number; error?: string; transport?: string };
  image: Record<string, unknown>;
};
let probeCache: ProbeState | null = null;

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin') ?? '') });
}

/**
 * Production diagnostics. The only live paid probe is one tiny JSON-object
 * request through the SAME planner transport used by the product. We do not
 * ping every model or generate a real image from a health endpoint.
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
  let generationJobsReady = false;
  let generationJobsError: string | null = null;
  try {
    await prisma.generationJob.findFirst({ select: { id: true } });
    generationJobsReady = true;
  } catch (error) {
    generationJobsError = String(error).slice(0, 300);
  }
  const planWorking = external.planner.ok;
  const ok = planWorking && productionConfigOk && generationJobsReady;

  return json(
    {
      ok,
      pipelineVersion: PIPELINE_VERSION,
      aiJsonTransport: 'interactions',
      generationTransport: 'durable-job-polling',
      featureVerification: 'reachable-graph+runtime-aware-criterion-audit',
      plannerMode: 'interactions-json-primary',
      generationJobsReady,
      generationJobsError,
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
      available = (body.models ?? []).map((model) => (model.name ?? '').replace(/^models\//, '')).filter(Boolean);
    } else {
      listError = `${res.status}: ${(await res.text().catch(() => '')).slice(0, 180)}`;
    }
  } catch (error) {
    listError = String(error);
  }

  const planner = await probePlanner();
  const availableSet = new Set(available);
  const probes = CONFIGURED_MODELS.map((model) => ({
    model,
    ok: available.length ? availableSet.has(model) : model === planner.model && planner.ok,
    status: available.length ? (availableSet.has(model) ? 200 : 404) : (model === planner.model && planner.ok ? 200 : 0),
  }));
  const working = probes.filter((probe) => probe.ok).map((probe) => probe.model);
  if (planner.ok && !working.includes(planner.model)) working.unshift(planner.model);

  return {
    expiresAt: now + PROBE_CACHE_MS,
    available,
    listError,
    probes,
    working,
    planner,
    image: {
      configured: Boolean(process.env.TOOLKIN_DEEPINFRA_API_KEY),
      model: process.env.TOOLKIN_DEEPINFRA_IMAGE_MODEL ?? 'black-forest-labs/FLUX-1-schnell',
      liveProbe: false,
    },
  };
}

async function probePlanner(): Promise<ProbeState['planner']> {
  const result = await callGemini(
    'Return the requested JSON and nothing else.',
    'Return {"ok":true}.',
    {
      jsonOnly: true,
      thinking: 'minimal',
      purpose: 'plan',
    },
  );

  if (!result.ok) {
    return {
      model: result.model ?? MODELS_BY_PURPOSE.plan[0] ?? 'none',
      ok: false,
      status: 0,
      error: (result.error ?? 'planner_probe_failed').slice(0, 400),
      transport: result.transport,
    };
  }

  let parsedOk = false;
  try { parsedOk = JSON.parse(result.text ?? '')?.ok === true; } catch { parsedOk = false; }
  return {
    model: result.model ?? MODELS_BY_PURPOSE.plan[0] ?? 'unknown',
    ok: parsedOk,
    status: parsedOk ? 200 : 502,
    error: parsedOk ? undefined : 'planner_json_invalid',
    transport: result.transport,
  };
}
