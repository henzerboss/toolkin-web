import { grantOnce, setPremiumUntil } from './credits';
import { creditsForProduct, SUBSCRIPTION_CREDITS } from './pricing';

/**
 * Мост между вебхуком RevenueCat и балансом кредитов.
 *
 * Ошибки базы намеренно пробрасываются в route: RevenueCat должен получить 5xx
 * и повторить доставку, иначе оплаченная покупка может остаться без кредитов.
 * Идемпотентность повторов обеспечивает уникальный eventId в ledger.
 */

type Event = {
  id?: string;
  type?: string;
  app_user_id?: string | null;
  original_app_user_id?: string | null;
  product_id?: string | null;
  expiration_at_ms?: number | null;
  entitlement_ids?: string[] | null;
  environment?: string | null;
};

const PURCHASE_TYPES = new Set(['NON_RENEWING_PURCHASE']);
const SUBSCRIPTION_TYPES = new Set(['INITIAL_PURCHASE', 'RENEWAL']);
const REVOKE_TYPES = new Set(['EXPIRATION']);

export async function applyRevenueCatEvent(event: Event): Promise<void> {
  const appUserId = (event.app_user_id ?? event.original_app_user_id ?? '').trim();
  const type = (event.type ?? '').toUpperCase();
  if (!appUserId || !type) return;

  // Sandbox не должен наливать кредиты в боевую базу.
  if ((event.environment ?? '').toUpperCase() === 'SANDBOX' && process.env.TOOLKIN_ALLOW_SANDBOX !== 'true') return;

  const eventId = event.id ?? `${type}:${appUserId}:${event.expiration_at_ms ?? ''}`;

  if (PURCHASE_TYPES.has(type)) {
    const amount = creditsForProduct(event.product_id);
    if (amount > 0) {
      await grantOnce(eventId, appUserId, amount, 'purchase', { productId: event.product_id });
    }
    return;
  }

  if (SUBSCRIPTION_TYPES.has(type)) {
    const until = event.expiration_at_ms ? new Date(event.expiration_at_ms) : null;
    await setPremiumUntil(appUserId, until);
    // INITIAL_PURCHASE/RENEWAL represent a new subscription period. PRODUCT_CHANGE
    // and UNCANCELLATION are state changes and must not mint another monthly quota.
    await grantOnce(eventId, appUserId, SUBSCRIPTION_CREDITS(), 'subscription', { productId: event.product_id });
    return;
  }

  if (REVOKE_TYPES.has(type)) {
    await setPremiumUntil(appUserId, null);
  }
}
