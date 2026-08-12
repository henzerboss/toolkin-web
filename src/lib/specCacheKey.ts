import { createHash } from 'node:crypto';
import { ACTIONS, COMPONENTS, FILTER_NAMES, FUNCTION_NAMES } from '@/lib/dsl';

/**
 * Эпоха кэша. Меняется руками только при изменении правил валидатора —
 * они не отражаются ни в промпте, ни в манифесте, а спека, валидная вчера,
 * после ужесточения проверок может стать невалидной.
 */
const CACHE_EPOCH = 'v4';

/**
 * Отпечаток конвейера считается из самого промпта и манифеста DSL, а не
 * задаётся константой.
 *
 * Константу нужно было помнить и менять при каждой правке промпта. Один
 * забытый раз — и кэш месяцами отдаёт спеки, собранные по старым правилам,
 * а все улучшения выглядят не сработавшими. Проверять это некому: ошибка
 * не даёт ни исключения, ни записи в логе.
 *
 * Импортируется манифест, а не текст промпта: промпт собирается по плану и
 * различается от запроса к запросу, а манифест плюс эпоха однозначно задают
 * правила, по которым спека была построена.
 */
const FINGERPRINT = createHash('sha256')
  .update(
    JSON.stringify([
      COMPONENTS.map((component) => [component.type, component.description, component.required, component.binds]),
      ACTIONS.map((action) => [action.name, action.description, action.requires, action.params]),
      FUNCTION_NAMES,
      FILTER_NAMES,
    ]),
  )
  .digest('hex')
  .slice(0, 12);

export const PIPELINE_VERSION = `${CACHE_EPOCH}-${FINGERPRINT}`;

/**
 * Нормализация решает, платим ли мы Gemini дважды за «Таймер для яиц» и
 * «таймер для яиц.» — регистр, пробелы и хвостовая точка результат не меняют.
 */
function normalize(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?…]+$/, '');
}

export function cacheKey(prompt: string, locale: string): string {
  return createHash('sha256').update(`${PIPELINE_VERSION}|${locale}|${normalize(prompt)}`).digest('hex');
}
