import crypto from 'node:crypto';
import { applyRevenueCatEvent } from '@/lib/revenuecat';

export const runtime = 'nodejs';

interface Body {
  event?: {
    id?: string;
    type?: string;
    app_user_id?: string | null;
    original_app_user_id?: string | null;
    product_id?: string | null;
    expiration_at_ms?: number | null;
    environment?: string | null;
  };
}

/**
 * RevenueCat шлёт сюда события покупок. Общий секрет передаётся в заголовке
 * Authorization и задаётся в дашборде RevenueCat вместе с URL вебхука.
 *
 * Сравнение через timingSafeEqual, а не через ===: обычное сравнение строк
 * выходит на первом несовпавшем байте, и по времени ответа секрет подбирается.
 */
function isAuthorized(req: Request, expected: string): boolean {
  const provided = req.headers.get('authorization') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const expected = process.env.TOOLKIN_REVENUECAT_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[toolkin] RevenueCat webhook secret is not configured');
    return Response.json({ error: 'webhook_not_configured' }, { status: 503 });
  }
  if (!isAuthorized(req, expected)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }

  const event = body.event;
  if (!event?.type) return Response.json({ ok: true, ignored: 'no_event' });

  try {
    await applyRevenueCatEvent(event);
    return Response.json({ ok: true, type: event.type });
  } catch (error) {
    console.error('[toolkin] вебхук RevenueCat упал:', error);
    // 500 нужен, чтобы RevenueCat повторил доставку: пропущенное событие
    // означает неначисленные кредиты за уже оплаченную покупку.
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({ ok: true, endpoint: 'RevenueCat webhook' });
}
