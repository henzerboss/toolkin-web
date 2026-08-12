import { cors, guard, json } from '../_shared';
import { canAfford } from '@/lib/credits';
import { COST } from '@/lib/pricing';
import { createGenerationJob } from '@/lib/generationJobs';
import { verifyPlanToken } from '@/lib/planToken';

export const runtime = 'nodejs';

interface Body {
  prompt?: string;
  locale?: string;
  planToken?: string;
  features?: string[];
  customFeatures?: string[];
}

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin') ?? '') });
}

/**
 * Enqueue only. Keeping the user's HTTPS request open while Gemini + repair +
 * validation runs is inherently fragile behind mobile networks and nginx.
 * The durable job continues in PostgreSQL and the client polls /generate/status.
 */
export async function POST(req: Request) {
  const g = await guard(req);
  if (!g.ok) return g.response!;
  const { headers, account } = g;

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400, headers); }

  const prompt = (body.prompt ?? '').trim();
  if (prompt.length < 3) return json({ error: 'prompt_too_short' }, 400, headers);
  if (prompt.length > 600) return json({ error: 'prompt_too_long' }, 400, headers);

  const localeRaw = (body.locale ?? 'en').trim();
  const locale = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/.test(localeRaw) ? localeRaw.slice(0, 24) : 'en';
  const price = COST.generate();
  if (!canAfford(account!, price)) {
    return json({ error: 'insufficient_credits', credits: account!.credits, price }, 402, headers);
  }

  const features = Array.isArray(body.features)
    ? body.features.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, 80)).filter(Boolean).slice(0, 10)
    : [];
  const customFeatures = Array.isArray(body.customFeatures)
    ? body.customFeatures.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, 120)).filter((item) => item.length > 2).slice(0, 5)
    : [];
  const planToken = typeof body.planToken === 'string' ? body.planToken.slice(0, 20000) : '';
  if (!planToken) return json({ error: 'plan_required' }, 409, headers);
  if (!verifyPlanToken(planToken, prompt, locale)) return json({ error: 'plan_invalid' }, 409, headers);

  try {
    const job = await createGenerationJob({
      account: account!, prompt, locale, features, customFeatures, planToken, price,
    });
    return json({ jobId: job.id, status: 'pending' }, 202, headers);
  } catch (error) {
    if (String(error).includes('generation_in_progress')) {
      return json({ error: 'generation_in_progress' }, 409, headers);
    }
    throw error;
  }
}
