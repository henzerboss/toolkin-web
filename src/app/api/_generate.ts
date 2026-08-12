import { THINKING, callGemini, safeJsonParse, type Purpose, type ThinkingLevel } from './_shared';
import { buildGeneratePrompt, buildRepairPrompt, buildSystemInstruction } from './_prompt';
import { planApp, planForFeatures, type Plan, type Feature } from './_plan';
import { verifyPlanToken } from '@/lib/planToken';
import { createHash } from 'node:crypto';
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
  /** Missing feature details are returned only on a failed contract; successful apps have none. */
  missingFeatures?: { id: string; title: string }[];
}

const parsedRepairs = Number.parseInt(process.env.TOOLKIN_MAX_REPAIRS ?? '', 10);
const MAX_REPAIRS = Number.isFinite(parsedRepairs) && parsedRepairs >= 0 && parsedRepairs <= 5 ? parsedRepairs : 2;

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

  /**
   * Best mechanically valid candidate is kept only as repair/failure context.
   * A reviewed Product Plan is a contract: a partial app is never charged or shipped.
   */
  let best: { spec: MiniAppSpec; check: ReturnType<typeof checkFeatures> } | null = null;

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
        // Запоминаем самый полный вариант только как контекст для следующей
        // починки. Если попытки закончатся, partial app не отдаётся и не
        // оплачивается — Product Plan остаётся контрактом.
        if (!best || featureCheck.implemented.length > best.check.implemented.length) {
          best = { spec: fixed.spec, check: featureCheck };
        }
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
        missingFeatures: [],
      };
    }

    lastErrors = validation.errors;
    prompt = buildRepairPrompt(JSON.stringify(parsed), lastErrors);
  }

  // A reviewed feature selection is a contract. Returning a partially implemented
  // app and charging for it recreates the exact failure mode this pipeline is
  // designed to eliminate. Keep `best` only as repair context; never ship it.
  if (best) {
    return {
      ok: false,
      attempts,
      usage,
      errors: best.check.issues.length ? best.check.issues : lastErrors,
      error: 'feature_incomplete',
      features: best.check.implemented,
      missingFeatures: best.check.missing,
    };
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
  customFeatures?: string[],
  planToken?: string,
): Promise<SpecAttempt> {
  let sourcePlan: Plan | undefined;
  let planningAttempts = 0;

  if (planToken) {
    sourcePlan = verifyPlanToken(planToken, request, locale) ?? undefined;
    // Never silently substitute a different Product Plan after the person has
    // reviewed feature choices. A bad/expired token must be replanned explicitly.
    if (!sourcePlan) return { ok: false, attempts: 0, error: 'plan_invalid' };
  } else {
    // Backward compatibility for older clients or a failed /plan request.
    const planned = await planApp(request, locale);
    planningAttempts = 1;
    if (planned.ok) sourcePlan = planned.plan;
  }

  let plan = sourcePlan;
  if (plan && planToken && selectedFeatures !== undefined) {
    plan = planForFeatures(plan, selectedFeatures);
  } else if (plan && selectedFeatures?.length) {
    // Legacy clients had no immutable plan token; preserve their old semantics.
    plan = planForFeatures(plan, selectedFeatures);
  }

  if (customFeatures?.length) {
    const custom: Feature[] = customFeatures.map((text, index) => ({
      id: `user-custom-${index + 1}`,
      title: text,
      description: text,
      essential: true,
      acceptanceCriteria: [text],
      requiresComponents: [],
      requiresActions: [],
      requiresCapabilities: [],
    }));
    if (plan) plan = { ...plan, features: [...plan.features, ...custom] };
    else {
      plan = {
        kind: 'other', title: '', summary: request, navigation: 'single',
        screens: [{ id: 'home', title: '', purpose: request }], customComponents: [],
        capabilities: [], components: [], needsRecords: false, needsStructuredAi: false, features: custom,
      };
    }
  }

  // Cache is tied to the actual agreed Product Plan, not just feature IDs.
  // Otherwise two different plans for the same wording could share an incompatible app.
  const planFingerprint = plan
    ? createHash('sha256').update(JSON.stringify(plan)).digest('base64url').slice(0, 20)
    : 'unplanned';
  const cacheSuffix = [
    `#plan=${planFingerprint}`,
    selectedFeatures !== undefined ? `#selected=${[...selectedFeatures].sort().join(',')}` : '',
    customFeatures?.length ? `#custom=${customFeatures.join('|')}` : '',
  ].join('');
  const cached = await readCache(request + cacheSuffix, locale);
  if (cached) {
    // Cache is an optimization, never a trust boundary. Re-run the same
    // mechanical/runtime/feature gates used for a fresh model response before
    // returning or charging for a cached spec. Corrupt or externally written
    // rows are simply ignored and regenerated.
    const validated = validateSpec(cached);
    if (validated.ok) {
      const fixed = autofix(validated.spec);
      const smoke = smokeTest(fixed.spec);
      const checked = smoke.ok ? checkFeatures(fixed.spec, plan?.features ?? []) : null;
      if (checked?.ok) return {
        ok: true, spec: fixed.spec, attempts: planningAttempts, cached: true, plan,
        autofixed: fixed.applied, features: checked.implemented, missingFeatures: [],
      };
    }
  }

  const system = buildSystemInstruction(locale, plan);
  const prompt = buildGeneratePrompt(request, locale, plan);
  const result = await generateSpec(system, prompt, THINKING.generate, 'generate', plan);

  if (result.ok && result.spec) await writeCache(request + cacheSuffix, locale, result.spec, plan?.kind ?? 'other');
  return { ...result, attempts: result.attempts + planningAttempts, plan };
}
