import prisma from '@/lib/prisma';
import { generateFromRequest, type GenerationProgressStage } from '@/app/api/_generate';
import { canAfford, type Account } from '@/lib/credits';
import type { Prisma } from '@prisma/client';

const STALE_JOB_MS = 10 * 60 * 1000;
const activeJobs = new Set<string>();

function parseStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export type GenerationJobPublic = {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  stage: string;
  attempts: number;
  error?: string;
  spec?: unknown;
  features?: string[];
  missingFeatures?: { id: string; title: string }[];
  credits?: number;
};

export async function createGenerationJob(input: {
  account: Account;
  prompt: string;
  locale: string;
  features: string[];
  customFeatures: string[];
  planToken: string;
  price: number;
}): Promise<{ id: string }> {
  const serializedFeatures = JSON.stringify(input.features);
  const serializedCustomFeatures = JSON.stringify(input.customFeatures);

  // Serialize enqueue decisions per account in PostgreSQL. Mobile retries can
  // arrive almost simultaneously (for example after a connection handover),
  // and a plain "find then create" check has a race window that could start two
  // expensive model jobs. The advisory lock exists only for this transaction.
  const decision = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.account.id}))`;

    // Exact retries are idempotent. If the enqueue response or several status
    // polls were lost, returning the same completed/running job prevents a second
    // model call and, most importantly, prevents charging twice for one tap.
    const exact = await tx.generationJob.findFirst({
      where: {
        accountId: input.account.id,
        prompt: input.prompt,
        locale: input.locale,
        features: serializedFeatures,
        customFeatures: serializedCustomFeatures,
        planToken: input.planToken,
        status: { in: ['pending', 'running', 'completed'] },
        createdAt: { gt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (exact) return { id: exact.id, status: exact.status, updatedAt: exact.updatedAt };

    // A genuinely different app request is not allowed to overlap for the same
    // account. This keeps model spend bounded and makes credit semantics obvious.
    const conflicting = await tx.generationJob.findFirst({
      where: { accountId: input.account.id, status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    if (conflicting) throw new Error('generation_in_progress');

    const job = await tx.generationJob.create({
      data: {
        accountId: input.account.id,
        prompt: input.prompt,
        locale: input.locale,
        features: serializedFeatures,
        customFeatures: serializedCustomFeatures,
        planToken: input.planToken,
        price: input.price,
      },
      select: { id: true },
    });
    return { id: job.id, status: 'pending' as const, updatedAt: new Date() };
  });

  // Old finished jobs are diagnostics, not permanent user data. Cleanup is not
  // part of the enqueue transaction, so it can never delay or roll back a tap.
  void prisma.generationJob.deleteMany({
    where: { completedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
  }).catch(() => undefined);

  if (decision.status === 'pending') kickGenerationJob(decision.id);
  if (decision.status === 'running' && Date.now() - decision.updatedAt.getTime() > STALE_JOB_MS) {
    await prisma.generationJob.updateMany({
      where: { id: decision.id, status: 'running' },
      data: { status: 'pending', stage: 'queued', lockedAt: null },
    });
    kickGenerationJob(decision.id);
  }
  return { id: decision.id };
}

export function kickGenerationJob(jobId: string): void {
  if (activeJobs.has(jobId)) return;
  // The server is a persistent single-instance PM2 process. The DB row is the
  // durable source of truth; this timer merely starts work after the HTTP
  // enqueue response has had a chance to flush.
  setTimeout(() => { void processGenerationJob(jobId); }, 0);
}

async function setStage(jobId: string, stage: GenerationProgressStage): Promise<void> {
  await prisma.generationJob.updateMany({
    where: { id: jobId, status: 'running' },
    data: { stage },
  });
}

export async function processGenerationJob(jobId: string): Promise<void> {
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);
  try {
    const claimed = await prisma.generationJob.updateMany({
      where: { id: jobId, status: 'pending' },
      data: { status: 'running', stage: 'building', lockedAt: new Date(), error: null, errorDetail: null },
    });
    if (claimed.count !== 1) return;

    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
      include: { account: { select: { id: true, appUserId: true, credits: true, welcomeGranted: true, premiumUntil: true } } },
    });
    if (!job) return;

    if (!canAfford(job.account, job.price)) {
      await failJob(jobId, 'insufficient_credits', 'Balance changed before generation started.');
      return;
    }

    const result = await generateFromRequest(
      job.prompt,
      job.locale,
      parseStringArray(job.features),
      parseStringArray(job.customFeatures),
      job.planToken,
      (stage) => setStage(jobId, stage),
    );

    await prisma.generationJob.update({ where: { id: jobId }, data: { attempts: result.attempts } });

    if (!result.ok || !result.spec) {
      await failJob(
        jobId,
        result.error ?? 'generation_failed',
        (result.errors ?? []).slice(0, 20).join(' | ').slice(0, 12000),
      );
      return;
    }

    await setStage(jobId, 'finalizing');
    const completed = await completeJobAndCharge({
      jobId,
      accountId: job.accountId,
      price: job.price,
      spec: result.spec,
      attempts: result.attempts,
      meta: {
        kind: result.plan?.kind,
        features: result.features ?? [],
        missingFeatures: result.missingFeatures ?? [],
        cached: result.cached ?? false,
        tokens: result.usage,
      },
    });
    if (!completed) {
      await failJob(jobId, 'insufficient_credits', 'Balance changed before successful generation could be charged.');
      return;
    }
  } catch (error) {
    console.error('[toolkin.generate.job]', jobId, error);
    await failJob(jobId, 'generation_failed', String(error).slice(0, 12000)).catch(() => undefined);
  } finally {
    activeJobs.delete(jobId);
  }
}


async function completeJobAndCharge(input: {
  jobId: string;
  accountId: string;
  price: number;
  spec: unknown;
  attempts: number;
  meta: Record<string, unknown>;
}): Promise<boolean> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const account = await tx.account.findUnique({ where: { id: input.accountId }, select: { credits: true } });
    if (!account) return false;

    const changed = await tx.account.updateMany({
      where: { id: input.accountId, credits: { gte: input.price } },
      data: { credits: { decrement: input.price } },
    });
    if (changed.count !== 1) return false;

    const fresh = await tx.account.findUnique({ where: { id: input.accountId }, select: { credits: true } });
    const credits = fresh?.credits ?? Math.max(0, account.credits - input.price);
    await tx.ledger.create({
      data: {
        accountId: input.accountId,
        delta: -input.price,
        reason: 'generate',
        eventId: `generate:${input.jobId}`,
        meta: JSON.stringify({ jobId: input.jobId, attempts: input.attempts, ...input.meta }),
      },
    });
    await tx.generationJob.update({
      where: { id: input.jobId },
      data: {
        status: 'completed',
        stage: 'done',
        attempts: input.attempts,
        completedAt: new Date(),
        resultSpec: JSON.stringify(input.spec),
        resultMeta: JSON.stringify({
          kind: input.meta.kind,
          features: input.meta.features ?? [],
          missingFeatures: input.meta.missingFeatures ?? [],
          credits,
        }),
        error: null,
        errorDetail: null,
      },
    });
    return true;
  });
}

async function failJob(jobId: string, error: string, detail: string): Promise<void> {
  await prisma.generationJob.updateMany({
    where: { id: jobId, status: { in: ['pending', 'running'] } },
    data: {
      status: 'failed',
      stage: 'done',
      completedAt: new Date(),
      error: error.slice(0, 120),
      errorDetail: detail.slice(0, 12000),
    },
  });
}

export async function getGenerationJob(appUserId: string, jobId: string): Promise<GenerationJobPublic | null> {
  let job = await prisma.generationJob.findFirst({ where: { id: jobId, account: { is: { appUserId } } } });
  if (!job) return null;

  if (job.status === 'pending') {
    kickGenerationJob(job.id);
  } else if (job.status === 'running' && (!activeJobs.has(job.id) || Date.now() - job.updatedAt.getTime() > STALE_JOB_MS)) {
    // There is only one PM2 application instance. If a row says `running` but
    // this process has no matching in-memory task, the previous process died
    // after claiming it. Recover immediately on the next status poll instead
    // of making the user wait for the stale timeout.
    const reset = await prisma.generationJob.updateMany({
      where: { id: job.id, status: 'running', updatedAt: job.updatedAt },
      data: { status: 'pending', stage: 'queued', lockedAt: null },
    });
    if (reset.count === 1) kickGenerationJob(job.id);
    job = (await prisma.generationJob.findUnique({ where: { id: job.id } })) ?? job;
  }

  const out: GenerationJobPublic = {
    id: job.id,
    status: job.status as GenerationJobPublic['status'],
    stage: job.stage,
    attempts: job.attempts,
  };
  if (job.status === 'failed') out.error = job.error ?? 'generation_failed';
  if (job.status === 'completed' && job.resultSpec) {
    try { out.spec = JSON.parse(job.resultSpec); } catch { out.error = 'generation_result_corrupt'; out.status = 'failed'; }
    try {
      const meta = job.resultMeta ? JSON.parse(job.resultMeta) as Record<string, unknown> : {};
      out.features = Array.isArray(meta.features) ? meta.features.filter((x): x is string => typeof x === 'string') : [];
      out.missingFeatures = Array.isArray(meta.missingFeatures) ? meta.missingFeatures as { id: string; title: string }[] : [];
      if (typeof meta.credits === 'number') out.credits = meta.credits;
    } catch { /* result spec itself is sufficient */ }
  }
  return out;
}
