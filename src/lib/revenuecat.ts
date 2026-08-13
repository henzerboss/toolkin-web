import { grantOnce, setPremiumUntil } from './credits';
import { creditsForProduct, SUBSCRIPTION_CREDITS } from './pricing';

/**
 * Мост между вебхуком RevenueCat и балансом кредитов.
 *
 * Ничего не бросает наружу: событие уже принято, и падение начисления
 * логируется, а не превращается в бесконечные ретраи со стороны RevenueCat.
 * Идемпотентность обеспечивает уникальный eventId в ledger.
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
const SUBSCRIPTION_TYPES = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION']);
const REVOKE_TYPES = new Set(['EXPIRATION', 'REFUND']);

export async function applyRevenueCatEvent(event: Event): Promise<void> {
  try {
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
      // Квота начисляется на каждое продление и защищена eventId от повторной доставки.
      await grantOnce(eventId, appUserId, SUBSCRIPTION_CREDITS(), 'subscription', { productId: event.product_id });
      return;
    }

    if (REVOKE_TYPES.has(type)) {
      await setPremiumUntil(appUserId, null);
    }
  } catch (error) {
    console.error('[toolkin] не удалось применить событие RevenueCat:', error);
  }
}
