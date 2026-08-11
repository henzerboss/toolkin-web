import { createHash } from 'node:crypto';

/**
 * Версия конвейера генерации. Меняется вручную при правке системного промпта,
 * манифеста DSL или правил валидатора — иначе кэш будет отдавать спеки,
 * собранные по старым правилам, и все улучшения промпта окажутся невидимыми.
 */
export const PIPELINE_VERSION = 'v3-two-stage';

/**
 * Отдельно от specCache.ts намеренно: это чистая функция без обращения к базе,
 * поэтому её можно импортировать в тесты, не поднимая Postgres.
 *
 * Нормализация решает, платим ли мы Gemini дважды за «Таймер для яиц» и
 * «таймер для яиц.» — регистр, пробелы и хвостовая точка результат не меняют.
 */
function normalize(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?…]+$/, '');
}

export function cacheKey(prompt: string, locale: string): string {
  return createHash('sha256').update(`${PIPELINE_VERSION}|${locale}|${normalize(prompt)}`).digest('hex');
}
