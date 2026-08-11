import { cors, guard, json } from '../_shared';
import { hasPremium } from '@/lib/credits';
import { COST, SUBSCRIPTION_CREDITS, WELCOME_CREDITS } from '@/lib/pricing';

export const runtime = 'nodejs';

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin') ?? '') });
}

/**
 * Приложение дёргает этот роут при старте и после каждой покупки.
 * Цены отдаются отсюда, а не хардкодятся в клиенте: стоимость действий
 * должна меняться без релиза в сторах.
 */
export async function GET(req: Request) {
  const g = await guard(req);
  if (!g.ok) return g.response!;
  const { headers, account } = g;

  return json(
    {
      credits: account!.credits,
      welcomeCredits: WELCOME_CREDITS(),
      subscriptionCredits: SUBSCRIPTION_CREDITS(),
      premium: hasPremium(account!),
      premiumUntil: account!.premiumUntil?.toISOString() ?? null,
      prices: {
        generate: COST.generate(),
        refine: COST.refine(),
        ask: COST.ask(),
        image: COST.image(),
      },
    },
    200,
    headers,
  );
}
