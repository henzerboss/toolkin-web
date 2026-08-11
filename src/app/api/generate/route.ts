import { cors, guard, json } from '../_shared';
import { generateFromRequest } from '../_generate';
import { canAfford, charge } from '@/lib/credits';
import { COST } from '@/lib/pricing';

export const runtime = 'nodejs';

interface Body {
  prompt?: string;
  locale?: string;
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

  const locale = (body.locale ?? 'en').trim();
  const price = COST.generate();

  // Баланс проверяется до вызова модели, а списывается после успеха:
  // неудачная генерация не должна стоить пользователю ничего.
  if (!canAfford(account!, price)) {
    return json({ error: 'insufficient_credits', credits: account!.credits, price }, 402, headers);
  }

  const result = await generateFromRequest(prompt, locale);

  if (!result.ok) {
    return json(
      { error: result.error, errors: result.errors, attempts: result.attempts },
      result.error === 'validation_failed' ? 422 : 503,
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

  return json(
    {
      spec: result.spec,
      attempts: result.attempts,
      kind: result.plan?.kind,
      credits: charged.credits,
    },
    200,
    headers,
  );
}
