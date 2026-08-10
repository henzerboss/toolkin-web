import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { FREE_GENERATIONS } from '@/lib/pricing';

/**
 * Кредиты — единственный ресурс, который нельзя считать на клиенте.
 * Баланс живёт здесь, списывается по факту успешного ответа модели,
 * пополняется вебхуком RevenueCat. Клиент получает баланс только для показа.
 */

export type CreditReason = 'generate' | 'refine' | 'ask' | 'purchase' | 'subscription' | 'grant' | 'refund';

export interface Account {
  id: string;
  appUserId: string;
  credits: number;
  freeGenerationsLeft: number;
  premiumUntil: Date | null;
}

export async function ensureAccount(appUserId: string): Promise<Account> {
  return prisma.account.upsert({
    where: { appUserId },
    update: {},
    create: { appUserId, credits: 0, freeGenerationsLeft: FREE_GENERATIONS() },
    select: { id: true, appUserId: true, credits: true, freeGenerationsLeft: true, premiumUntil: true },
  });
}

export function hasPremium(account: Account): boolean {
  return account.premiumUntil !== null && account.premiumUntil.getTime() > Date.now();
}

export interface ChargeResult {
  ok: boolean;
  /** Что именно оплатило действие — приложение показывает это в интерфейсе. */
  paidWith: 'free' | 'credits' | null;
  credits: number;
  freeGenerationsLeft: number;
}

/**
 * Списание идёт после успешного ответа модели, поэтому неудачная генерация
 * пользователю ничего не стоит — иначе первая же ошибка выглядит как обман.
 */
export async function charge(
  appUserId: string,
  reason: CreditReason,
  amount: number,
  meta?: Record<string, unknown>,
): Promise<ChargeResult> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const account = await tx.account.findUnique({ where: { appUserId } });
    if (!account) return { ok: false, paidWith: null, credits: 0, freeGenerationsLeft: 0 };

    // Бесплатные генерации тратятся первыми: пользователь не должен обнаружить,
    // что купленные кредиты ушли, пока бесплатные лежали нетронутыми.
    if (reason === 'generate' && account.freeGenerationsLeft > 0) {
      const updated = await tx.account.update({
        where: { id: account.id },
        data: { freeGenerationsLeft: { decrement: 1 } },
      });
      await tx.ledger.create({
        data: { accountId: account.id, delta: 0, reason, meta: meta ? JSON.stringify(meta) : null },
      });
      return { ok: true, paidWith: 'free', credits: updated.credits, freeGenerationsLeft: updated.freeGenerationsLeft };
    }

    if (account.credits < amount) {
      return { ok: false, paidWith: null, credits: account.credits, freeGenerationsLeft: account.freeGenerationsLeft };
    }

    const updated = await tx.account.update({
      where: { id: account.id },
      data: { credits: { decrement: amount } },
    });
    await tx.ledger.create({
      data: { accountId: account.id, delta: -amount, reason, meta: meta ? JSON.stringify(meta) : null },
    });

    return { ok: true, paidWith: 'credits', credits: updated.credits, freeGenerationsLeft: updated.freeGenerationsLeft };
  });
}

export async function canAfford(account: Account, reason: CreditReason, amount: number): Promise<boolean> {
  if (reason === 'generate' && account.freeGenerationsLeft > 0) return true;
  return account.credits >= amount;
}

export async function grant(
  appUserId: string,
  amount: number,
  reason: CreditReason,
  meta?: Record<string, unknown>,
): Promise<void> {
  if (amount <= 0) return;
  const account = await ensureAccount(appUserId);
  await prisma.$transaction([
    prisma.account.update({ where: { id: account.id }, data: { credits: { increment: amount } } }),
    prisma.ledger.create({
      data: { accountId: account.id, delta: amount, reason, meta: meta ? JSON.stringify(meta) : null },
    }),
  ]);
}

export async function setPremiumUntil(appUserId: string, until: Date | null): Promise<void> {
  const account = await ensureAccount(appUserId);
  await prisma.account.update({ where: { id: account.id }, data: { premiumUntil: until } });
}

/**
 * Идемпотентность: RevenueCat повторяет доставку вебхука при любой ошибке,
 * поэтому одно и то же событие не должно начислить кредиты дважды.
 */
export async function grantOnce(
  eventId: string,
  appUserId: string,
  amount: number,
  reason: CreditReason,
  meta?: Record<string, unknown>,
): Promise<boolean> {
  const existing = await prisma.ledger.findUnique({ where: { eventId } }).catch(() => null);
  if (existing) return false;

  const account = await ensureAccount(appUserId);
  try {
    await prisma.$transaction([
      prisma.ledger.create({
        data: {
          eventId,
          accountId: account.id,
          delta: amount,
          reason,
          meta: meta ? JSON.stringify(meta) : null,
        },
      }),
      prisma.account.update({ where: { id: account.id }, data: { credits: { increment: amount } } }),
    ]);
    return true;
  } catch {
    // Уникальный индекс по eventId — гонка двух доставок разрешается здесь.
    return false;
  }
}
