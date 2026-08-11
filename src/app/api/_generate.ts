import { THINKING, callGemini, safeJsonParse, type Purpose, type ThinkingLevel } from './_shared';
import { buildGeneratePrompt, buildRepairPrompt, buildSystemInstruction } from './_prompt';
import { planApp, type Plan } from './_plan';
import { readCache, writeCache } from '@/lib/specCache';
import { validateSpec } from '@/lib/validateSpec';
import type { MiniAppSpec } from '@/lib/specTypes';

export interface SpecAttempt {
  ok: boolean;
  spec?: MiniAppSpec;
  errors?: string[];
  /** Сколько обращений к модели понадобилось — попадает в метрику качества промпта. */
  attempts: number;
  error?: string;
  /** План первого этапа. Полезен для отладки: по нему видно, что модель поняла. */
  plan?: Plan;
  /** Спека взята из кэша — обращений к модели не было. */
  cached?: boolean;
  /** Фактический расход токенов за все вызовы генерации. */
  usage?: { input: number; output: number; thoughts: number };
}

const MAX_REPAIRS = Number.parseInt(process.env.TOOLKIN_MAX_REPAIRS ?? '2', 10);

/**
 * Модель ошибается в спеке примерно в каждом пятом ответе, и почти всегда
 * это мелочь: несуществующий компонент, bind мимо state, забытая capability.
 * Цикл починки поднимает долю успеха с ~80% до ~97% ценой одного лишнего вызова,
 * поэтому он здесь, а не на клиенте — так пользователь не платит за круговой рейс.
 */
export async function generateSpec(
  system: string,
  initialPrompt: string,
  thinking: ThinkingLevel = THINKING.generate,
  purpose: Purpose = 'generate',
): Promise<SpecAttempt> {
  let prompt = initialPrompt;
  let attempts = 0;
  let lastErrors: string[] = [];
  const usage = { input: 0, output: 0, thoughts: 0 };

  for (let round = 0; round <= MAX_REPAIRS; round++) {
    attempts += 1;

    const result = await callGemini(system, prompt, { jsonOnly: true, thinking, purpose });
    if (result.usage) {
      usage.input += result.usage.input;
      usage.output += result.usage.output;
      usage.thoughts += result.usage.thoughts;
    }
    if (!result.ok) return { ok: false, attempts, error: result.error ?? 'model_unavailable', usage };

    const parsed = safeJsonParse<unknown>(result.text ?? '', null);
    if (parsed === null) {
      lastErrors = ['Ответ не является корректным JSON'];
      prompt = buildRepairPrompt(result.text ?? '', lastErrors);
      continue;
    }

    const validation = validateSpec(parsed);
    if (validation.ok) return { ok: true, spec: validation.spec, attempts, usage };

    lastErrors = validation.errors;
    prompt = buildRepairPrompt(JSON.stringify(parsed), lastErrors);
  }

  return { ok: false, attempts, errors: lastErrors, error: 'validation_failed', usage };
}

/**
 * Полный конвейер генерации: сначала план, потом сборка.
 *
 * Разделение даёт три вещи, которых не было у одного длинного вызова.
 * План описывается схемой, поэтому в нём не может оказаться несуществующего
 * компонента. План достаточно прост, чтобы исправить его кодом — «игра значит
 * песочница» перестало быть просьбой к модели и стало правилом. И промпт
 * второго этапа собирается только из нужных разделов: для игры он вдвое
 * короче полного, а короткий промпт модель выполняет точнее.
 *
 * Если планирование не удалось, второй этап идёт с полным промптом — потеря
 * качества, но не отказ.
 */
export async function generateFromRequest(request: string, locale: string): Promise<SpecAttempt> {
  // Кэш до планирования: у одинакового запроса и план будет одинаковым,
  // а примеры-затравки на экране создания вообще одни у всех пользователей.
  const cached = await readCache(request, locale);
  if (cached) return { ok: true, spec: cached, attempts: 0, cached: true };

  const { plan, ok } = await planApp(request, locale);

  const system = buildSystemInstruction(locale, ok ? plan : undefined);
  const prompt = buildGeneratePrompt(request, locale, ok ? plan : undefined);

  const result = await generateSpec(system, prompt);

  if (result.ok && result.spec) await writeCache(request, locale, result.spec, plan.kind);

  // Вызов планирования тоже считается: иначе метрика «сколько обращений к
  // модели стоила генерация» врала бы в меньшую сторону.
  return { ...result, attempts: result.attempts + 1, plan: ok ? plan : undefined };
}
