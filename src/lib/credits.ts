import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { WELCOME_CREDITS } from '@/lib/pricing';

/**
 * Кредиты — единственный ресурс, который нельзя считать на клиенте.
 * Баланс живёт здесь, списывается по факту успешного ответа модели,
 * пополняется вебхуком RevenueCat. Клиент получает баланс только для показа.
 */

export type CreditReason =
  | 'generate' | 'refine' | 'ask' | 'image'
  | 'welcome' | 'purchase' | 'subscription' | 'grant' | 'refund';

export interface Account {
  id: string;
  appUserId: string;
  credits: number;
  welcomeGranted: boolean;
  premiumUntil: Date | null;
}

export async function ensureAccount(appUserId: string): Promise<Account> {
  // Приветственные кредиты начисляются в момент создания аккаунта и попадают
  // в ledger: без записи в журнале потом невозможно отличить подарок от покупки.
  const account = await prisma.account.upsert({
    where: { appUserId },
    update: {},
    create: { appUserId, credits: WELCOME_CREDITS(), welcomeGranted: true },
    select: { id: true, appUserId: true, credits: true, welcomeGranted: true, premiumUntil: true },
  });

  if (account.welcomeGranted) {
    const logged = await prisma.ledger.findFirst({ where: { accountId: account.id, reason: 'welcome' } });
    if (!logged) {
      const eventId = `welcome:${account.id}`;
      try {
        await prisma.ledger.create({
          data: { eventId, accountId: account.id, delta: WELCOME_CREDITS(), reason: 'welcome' },
        });
      } catch (error) {
        // Two first-launch requests may race. The unique eventId makes the
        // bookkeeping entry idempotent; only hide the duplicate, not DB errors.
        const wonByOtherRequest = await prisma.ledger.findUnique({ where: { eventId } }).catch(() => null);
        if (!wonByOtherRequest) throw error;
      }
    }
  }

  return account;
}

export function hasPremium(account: Account): boolean {
  return account.premiumUntil !== null && account.premiumUntil.getTime() > Date.now();
}

export interface ChargeResult {
  ok: boolean;
  credits: number;
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
  if (amount <= 0) {
    const account = await prisma.account.findUnique({ where: { appUserId }, select: { credits: true } });
    return { ok: Boolean(account), credits: account?.credits ?? 0 };
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<ChargeResult> => {
    const account = await tx.account.findUnique({ where: { appUserId }, select: { id: true, credits: true } });
    if (!account) return { ok: false, credits: 0 };

    // The affordability check and decrement must be one SQL predicate. A
    // read-then-update transaction can overspend when two successful model
    // requests finish concurrently against the same balance.
    const changed = await tx.account.updateMany({
      where: { id: account.id, credits: { gte: amount } },
      data: { credits: { decrement: amount } },
    });
    if (changed.count !== 1) {
      const fresh = await tx.account.findUnique({ where: { id: account.id }, select: { credits: true } });
      return { ok: false, credits: fresh?.credits ?? 0 };
    }

    await tx.ledger.create({
      data: { accountId: account.id, delta: -amount, reason, meta: meta ? JSON.stringify(meta) : null },
    });
    const updated = await tx.account.findUnique({ where: { id: account.id }, select: { credits: true } });
    return { ok: true, credits: updated?.credits ?? 0 };
  });
}

export function canAfford(account: Account, amount: number): boolean {
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
  } catch (error) {
    // A duplicate delivery loses on the unique eventId and is safe to ignore.
    // Any other DB failure must propagate so RevenueCat can retry later.
    const duplicate = await prisma.ledger.findUnique({ where: { eventId } }).catch(() => null);
    if (duplicate) return false;
    throw error;
  }
}
