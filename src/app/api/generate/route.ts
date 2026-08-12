import { cors, guard, json } from '../_shared';
import { generateFromRequest } from '../_generate';
import { canAfford, charge } from '@/lib/credits';
import { COST } from '@/lib/pricing';

export const runtime = 'nodejs';

interface Body {
  prompt?: string;
  locale?: string;
  /** Signed immutable Product Plan returned by /plan. */
  planToken?: string;
  /** Идентификаторы фич, оставленных пользователем. */
  features?: string[];
  /** Фичи, дописанные пользователем своими словами. */
  customFeatures?: string[];
}

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin') ?? '') });
}

export async function POST(req: Request) {
  const g = await guard(req);
  if (!g.ok) return g.response!;
  const { headers, account } = g;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400, headers);
  }

  const prompt = (body.prompt ?? '').trim();
  if (prompt.length < 3) return json({ error: 'prompt_too_short' }, 400, headers);
  if (prompt.length > 600) return json({ error: 'prompt_too_long' }, 400, headers);

  const localeRaw = (body.locale ?? 'en').trim();
  const locale = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/.test(localeRaw) ? localeRaw.slice(0, 24) : 'en';
  const price = COST.generate();

  // Баланс проверяется до вызова модели, а списывается после успеха:
  // неудачная генерация не должна стоить пользователю ничего.
  if (!canAfford(account!, price)) {
    return json({ error: 'insufficient_credits', credits: account!.credits, price }, 402, headers);
  }

  const features = Array.isArray(body.features)
    ? body.features.filter((item) => typeof item === 'string').map((item) => item.trim().slice(0, 80)).filter(Boolean).slice(0, 10)
    : undefined;

  const customFeatures = Array.isArray(body.customFeatures)
    ? body.customFeatures
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim().slice(0, 120))
        .filter((item) => item.length > 2)
        .slice(0, 5)
    : undefined;

  const planToken = typeof body.planToken === 'string' ? body.planToken.slice(0, 20000) : undefined;
  const result = await generateFromRequest(prompt, locale, features, customFeatures, planToken);

  if (!result.ok) {
    return json(
      { error: result.error, errors: result.errors, attempts: result.attempts },
      result.error === 'validation_failed' || result.error === 'feature_incomplete' ? 422 : result.error === 'plan_invalid' ? 409 : 503,
      headers,
    );
  }

  // Расход пишется в журнал: без него себестоимость генерации остаётся
  // догадкой, а понять, окупается ли старшая модель, нельзя.
  const charged = await charge(account!.appUserId, 'generate', price, {
    attempts: result.attempts,
    kind: result.plan?.kind,
    cached: result.cached ?? false,
    tokens: result.usage,
  });

  if (!charged.ok) return json({ error: 'insufficient_credits', credits: charged.credits, price }, 402, headers);

  return json(
    {
      spec: result.spec,
      attempts: result.attempts,
      kind: result.plan?.kind,
      features: result.features,
      missingFeatures: result.missingFeatures,
      credits: charged.credits,
    },
    200,
    headers,
  );
}
