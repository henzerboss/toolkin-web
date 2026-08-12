import { THINKING, callGemini, safeJsonParse, type Purpose, type ThinkingLevel } from './_shared';
import { buildGeneratePrompt, buildRepairPrompt, buildSystemInstruction } from './_prompt';
import { planApp, planForFeatures, type Plan } from './_plan';
import { checkFeatures } from '@/lib/featureCheck';
import { readCache, writeCache } from '@/lib/specCache';
import { autofix } from '@/lib/autofix';
import { smokeTest } from '@/lib/smokeTest';
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
  /** Какие механические ошибки починены кодом — видно, что чинить в промпте. */
  autofixed?: string[];
  /** Фичи, дошедшие до готовой утилиты. Приложение показывает их пользователю. */
  features?: string[];
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
  plan?: Plan,
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
      lastErrors = ['The answer is not valid JSON'];
      prompt = buildRepairPrompt(result.text ?? '', lastErrors);
      continue;
    }

    const validation = validateSpec(parsed);

    if (validation.ok) {
      // Механические привычки JavaScript чинятся кодом до пробного прогона:
      // Math.round и state.bill не стоят обращения к модели.
      const fixed = autofix(validation.spec);

      // Форма правильная — теперь проверяем, что оно работает. Валидатор
      // пропускает утилиты, где на экране NaN, а кнопки ничего не меняют:
      // форма безупречна, а пользоваться нечем.
      const smoke = smokeTest(fixed.spec);
      if (!smoke.ok) {
        lastErrors = smoke.issues;
        prompt = buildRepairPrompt(JSON.stringify(fixed.spec), smoke.issues);
        continue;
      }

      // Обещанные фичи проверяются последними: сначала утилита должна
      // работать, потом делать то, на что человек согласился галочками.
      const featureCheck = checkFeatures(fixed.spec, plan?.features ?? []);
      if (!featureCheck.ok) {
        lastErrors = featureCheck.issues;
        prompt = buildRepairPrompt(JSON.stringify(fixed.spec), featureCheck.issues);
        continue;
      }

      return {
        ok: true,
        spec: fixed.spec,
        attempts,
        usage,
        autofixed: fixed.applied,
        features: featureCheck.implemented,
      };
    }

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
export async function generateFromRequest(
  request: string,
  locale: string,
  selectedFeatures?: string[],
): Promise<SpecAttempt> {
  // Кэш учитывает выбранные фичи: та же просьба с другим набором галочек —
  // другая утилита, и отдавать по ней старую спеку нельзя.
  const cacheSuffix = selectedFeatures?.length ? `#${[...selectedFeatures].sort().join(',')}` : '';
  const cached = await readCache(request + cacheSuffix, locale);
  if (cached) return { ok: true, spec: cached, attempts: 0, cached: true };

  const planned = await planApp(request, locale);
  const plan = selectedFeatures?.length ? planForFeatures(planned.plan, selectedFeatures) : planned.plan;
  const ok = planned.ok;

  const system = buildSystemInstruction(locale, ok ? plan : undefined);
  const prompt = buildGeneratePrompt(request, locale, ok ? plan : undefined);

  const result = await generateSpec(system, prompt, THINKING.generate, 'generate', ok ? plan : undefined);

  if (result.ok && result.spec) await writeCache(request + cacheSuffix, locale, result.spec, plan.kind);

  // Вызов планирования тоже считается: иначе метрика «сколько обращений к
  // модели стоила генерация» врала бы в меньшую сторону.
  return { ...result, attempts: result.attempts + 1, plan: ok ? plan : undefined };
}
