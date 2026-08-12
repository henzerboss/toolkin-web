import { createHash } from 'node:crypto';
import { ACTIONS, COMPONENTS, FILTER_NAMES, FUNCTION_NAMES } from '@/lib/dsl';
import { buildGeneratePrompt, buildRepairPrompt, buildSystemInstruction } from '@/app/api/_prompt';

/**
 * Эпоха кэша. Меняется руками только при изменении правил валидатора —
 * они не отражаются ни в промпте, ни в манифесте, а спека, валидная вчера,
 * после ужесточения проверок может стать невалидной.
 */
const CACHE_EPOCH = 'v7';

/**
 * Отпечаток конвейера считается из самого промпта и манифеста DSL, а не
 * задаётся константой.
 *
 * Константу нужно было помнить и менять при каждой правке промпта. Один
 * забытый раз — и кэш месяцами отдаёт спеки, собранные по старым правилам,
 * а все улучшения выглядят не сработавшими. Проверять это некому: ошибка
 * не даёт ни исключения, ни записи в логе.
 *
 * Хэш включает DSL-манифест и канонические probe-промпты для режима без
 * плана и с репрезентативным Product Plan. Поэтому обычная правка prompt
 * автоматически инвалидирует кэш. CACHE_EPOCH остаётся ручным рубежом только
 * для validator/autofix-семантики, которая не представлена в prompt/DSL.
 */
const CACHE_PROBE_PLAN = {
  kind: 'tracker', title: '__probe__', summary: '__probe__', navigation: 'stack' as const,
  screens: [{ id: 'home', title: 'Home', purpose: 'Probe' }, { id: 'history', title: 'History', purpose: 'Probe' }],
  customComponents: [{ name: 'ProbeCard', purpose: 'Probe', strategy: 'compose' as const }],
  capabilities: ['llm'], components: ['Card', 'Repeat'], needsRecords: true, needsStructuredAi: true,
  features: [{ id: 'probe-feature', title: 'Probe', description: 'Probe', acceptanceCriteria: ['Probe works'] }],
};

const FINGERPRINT = createHash('sha256')
  .update(
    JSON.stringify([
      COMPONENTS.map((component) => [component.type, component.description, component.required, component.binds]),
      ACTIONS.map((action) => [action.name, action.description, action.requires, action.params]),
      FUNCTION_NAMES,
      FILTER_NAMES,
      // Prompt text is part of the executable generation contract. Hash a full
      // no-plan system and a representative planned request so prompt-only
      // improvements cannot be hidden by an old cache entry.
      buildSystemInstruction('en'),
      buildSystemInstruction('en', CACHE_PROBE_PLAN),
      buildGeneratePrompt('__cache_probe__', 'en', CACHE_PROBE_PLAN),
      buildRepairPrompt('__cache_probe__', ['__cache_probe__']),
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
