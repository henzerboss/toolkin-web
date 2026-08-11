import prisma from '@/lib/prisma';
import { cacheKey } from '@/lib/specCacheKey';
import type { MiniAppSpec } from '@/lib/specTypes';

const ENABLED = process.env.TOOLKIN_SPEC_CACHE !== 'false';

export async function readCache(prompt: string, locale: string): Promise<MiniAppSpec | null> {
  if (!ENABLED) return null;

  try {
    const hash = cacheKey(prompt, locale);
    const row = await prisma.specCache.findUnique({ where: { hash } });
    if (!row) return null;

    await prisma.specCache.update({ where: { hash }, data: { hits: { increment: 1 } } });
    return JSON.parse(row.spec) as MiniAppSpec;
  } catch {
    // Кэш не критичен: при любой проблеме просто генерируем заново.
    return null;
  }
}

export async function writeCache(
  prompt: string,
  locale: string,
  spec: MiniAppSpec,
  kind?: string,
): Promise<void> {
  if (!ENABLED) return;

  try {
    const hash = cacheKey(prompt, locale);
    await prisma.specCache.upsert({
      where: { hash },
      update: { spec: JSON.stringify(spec), kind },
      create: { hash, locale, kind, spec: JSON.stringify(spec) },
    });
  } catch {
    // молча: неудачная запись в кэш не должна ломать успешную генерацию
  }
}
