/**
 * Цены и размеры пакетов. Отдельно от credits.ts намеренно: это чистый разбор
 * переменных окружения без обращения к базе, поэтому импортируется и роутами,
 * и тестами, не поднимая соединение с Postgres.
 */

const intEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/** Стоимость в кредитах — понятных пользователю единицах, а не токенах модели. */
export const COST = {
  generate: () => intEnv('TOOLKIN_COST_GENERATE', 5),
  refine: () => intEnv('TOOLKIN_COST_REFINE', 2),
  ask: () => intEnv('TOOLKIN_COST_ASK', 1),
  // Дороже текстового вызова, но дешевле генерации утилиты: FLUX-schnell
  // стоит около цента за кадр, и запас нужен на случай смены провайдера.
  image: () => intEnv('TOOLKIN_COST_IMAGE', 3),
};

/** Бесплатные генерации выдаются один раз, а не ежемесячно: их задача — довести до «работает». */


/**
 * Приветственные кредиты. Выдаются один раз при создании аккаунта, а не
 * ежемесячно: их задача — довести человека до момента «работает», дальше
 * подписка или покупка пакета.
 *
 * 30 кредитов это шесть созданий, или четыре создания с парой правок —
 * достаточно, чтобы понять продукт, и мало, чтобы им пользоваться постоянно.
 */
export const WELCOME_CREDITS = () => intEnv('TOOLKIN_WELCOME_CREDITS', 30);

/** Месячная квота подписчика. Начисляется при каждом продлении, не накапливается сверх лимита. */
export const SUBSCRIPTION_CREDITS = () => intEnv('TOOLKIN_SUBSCRIPTION_CREDITS', 400);

/** Сколько кредитов даёт пакет — по product_id из RevenueCat. */
export function creditsForProduct(productId: string | null | undefined): number {
  if (!productId) return 0;
  const map = process.env.TOOLKIN_CREDIT_PACKS ?? 'credits_100:100,credits_500:550,credits_1200:1400';
  for (const pair of map.split(',')) {
    const [id, amount] = pair.split(':').map((part) => part.trim());
    if (id && id === productId) return Number.parseInt(amount, 10) || 0;
  }
  return 0;
}
