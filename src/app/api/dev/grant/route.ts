import { cors, guard, json } from '../../_shared';
import { grant, setPremiumUntil } from '@/lib/credits';
import { SUBSCRIPTION_CREDITS } from '@/lib/pricing';

export const runtime = 'nodejs';

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin') ?? '') });
}

/**
 * Начисление кредитов и премиума без оплаты — для разработки в Expo Go, где
 * нативного модуля RevenueCat нет и настоящую покупку сделать нельзя.
 *
 * Выключен по умолчанию. Без явного TOOLKIN_ALLOW_DEV_GRANT=true роут отвечает
 * 404, потому что открытая ручка «дай кредитов» на проде — это раздача денег.
 */
export async function POST(req: Request) {
  if (process.env.TOOLKIN_ALLOW_DEV_GRANT !== 'true') {
    return new Response('Not found', { status: 404 });
  }

  const g = await guard(req);
  if (!g.ok) return g.response!;
  const { headers, account } = g;

  let body: { credits?: number; premiumDays?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400, headers);
  }

  const credits = Math.max(0, Math.min(10_000, Math.floor(body.credits ?? 0)));
  if (credits > 0) {
    await grant(account!.appUserId, credits, 'grant', { source: 'dev' });
  }

  let subscriptionCredits = 0;
  if (body.premiumDays && body.premiumDays > 0) {
    const until = new Date(Date.now() + body.premiumDays * 86_400_000);
    await setPremiumUntil(account!.appUserId, until);

    // В бою квоту подписчика начисляет вебхук RevenueCat. Здесь его нет,
    // поэтому начисляем сами — иначе после «покупки» в Expo Go подписка
    // активна, а кредитов нет, и весь сценарий выглядит сломанным.
    subscriptionCredits = SUBSCRIPTION_CREDITS();
    await grant(account!.appUserId, subscriptionCredits, 'subscription', { source: 'dev' });
  }

  return json({ ok: true, credits, subscriptionCredits, premiumDays: body.premiumDays ?? 0 }, 200, headers);
}
