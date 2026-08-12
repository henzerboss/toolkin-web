import { THINKING, callGemini, safeJsonParse, type Purpose, type ThinkingLevel } from './_shared';
import { buildGeneratePrompt, buildRepairPrompt, buildSystemInstruction } from './_prompt';
import { planForFeatures, type Plan, type Feature } from './_plan';
import { verifyPlanToken } from '@/lib/planToken';
import { createHash } from 'node:crypto';
import { checkFeatures } from '@/lib/featureCheck';
import { readCache, writeCache } from '@/lib/specCache';
import { autofix } from '@/lib/autofix';
import { normalizeGeneratedSpec } from '@/lib/normalizeGeneratedSpec';
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
const MAX_REPAIRS = Number.isFinite(parsedRepairs) && parsedRepairs >= 0 && parsedRepairs <= 1 ? parsedRepairs : 1;

export type GenerationProgressStage = 'building' | 'validating' | 'repairing' | 'finalizing';
export type GenerationProgress = (stage: GenerationProgressStage) => void | Promise<void>;

async function reportProgress(callback: GenerationProgress | undefined, stage: GenerationProgressStage): Promise<void> {
  if (!callback) return;
  try { await callback(stage); } catch (error) { console.warn('[toolkin.generate.progress]', error); }
}

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
  onProgress?: GenerationProgress,
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
    await reportProgress(onProgress, round === 0 ? 'building' : 'repairing');

    const result = await callGemini(system, prompt, { jsonOnly: true, thinking, purpose });
    if (result.usage) {
      usage.input += result.usage.input;
      usage.output += result.usage.output;
      usage.thoughts += result.usage.thoughts;
    }
    if (!result.ok) {
      console.error(`[toolkin.${purpose}] Gemini request failed:`, (result.error ?? 'unknown').slice(0, 1200));
      return { ok: false, attempts, error: 'model_unavailable', usage };
    }

    const parsed = safeJsonParse<unknown>(result.text ?? '', null);
    if (parsed === null) {
      lastErrors = ['The answer is not valid JSON'];
      prompt = buildRepairPrompt(result.text ?? '', lastErrors);
      continue;
    }

    await reportProgress(onProgress, 'validating');
    const normalized = normalizeGeneratedSpec(parsed);
    const validation = validateSpec(normalized.spec);

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

      await reportProgress(onProgress, 'finalizing');
      return {
        ok: true,
        spec: fixed.spec,
        attempts,
        usage,
        autofixed: [...normalized.applied, ...fixed.applied],
        features: featureCheck.implemented,
        missingFeatures: [],
      };
    }

    lastErrors = validation.errors;
    prompt = buildRepairPrompt(JSON.stringify(normalized.spec), lastErrors);
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
 * Build from the exact signed Product Plan reviewed on the mandatory feature screen.
 * Planning is never repeated or silently bypassed here.
 */
export async function generateFromRequest(
  request: string,
  locale: string,
  selectedFeatures: string[],
  customFeatures: string[],
  planToken: string,
  onProgress?: GenerationProgress,
): Promise<SpecAttempt> {
  const sourcePlan = verifyPlanToken(planToken, request, locale) ?? undefined;
  if (!sourcePlan) return { ok: false, attempts: 0, error: 'plan_invalid' };

  let plan = planForFeatures(sourcePlan, selectedFeatures);

  if (customFeatures.length) {
    const custom: Feature[] = customFeatures.map((text, index) => ({
      id: `user-custom-${index + 1}`,
      title: text,
      description: text,
      essential: true,
      acceptanceCriteria: [text],
      requiresRecords: false,
      requiresStructuredAi: false,
      requiresComponents: [],
      requiresActions: [],
      requiresCapabilities: [],
    }));
    plan = { ...plan, features: [...plan.features, ...custom] };
  }

  if (plan.features.length === 0) return { ok: false, attempts: 0, error: 'plan_required' };

  // Cache is tied to the exact reviewed Product Plan plus the final selection.
  const planFingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('base64url').slice(0, 20);
  const cacheSuffix = [
    `#plan=${planFingerprint}`,
    `#selected=${[...selectedFeatures].sort().join(',')}`,
    customFeatures.length ? `#custom=${customFeatures.join('|')}` : '',
  ].join('');

  const cached = await readCache(request + cacheSuffix, locale);
  if (cached) {
    const normalized = normalizeGeneratedSpec(cached);
    const validated = validateSpec(normalized.spec);
    if (validated.ok) {
      const fixed = autofix(validated.spec);
      const smoke = smokeTest(fixed.spec);
      const checked = smoke.ok ? checkFeatures(fixed.spec, plan.features) : null;
      if (checked?.ok) {
        await reportProgress(onProgress, 'finalizing');
        return {
        ok: true, spec: fixed.spec, attempts: 0, cached: true, plan,
          autofixed: [...normalized.applied, ...fixed.applied], features: checked.implemented, missingFeatures: [],
        };
      }
    }
  }

  // User-written custom features were not part of the original planner pass.
  // Keep the reviewed Product Plan immutable, but give the builder the full
  // capability/data playbook so a custom requirement is not artificially
  // constrained by planner hints that predate it.
  const hasCustomFeatures = plan.features.some((feature) => feature.id.startsWith('user-custom-'));
  const system = buildSystemInstruction(locale, hasCustomFeatures ? undefined : plan);
  const prompt = buildGeneratePrompt(request, locale, plan);
  const result = await generateSpec(system, prompt, THINKING.generate, 'generate', plan, onProgress);

  if (result.ok && result.spec) await writeCache(request + cacheSuffix, locale, result.spec, plan.kind);
  return { ...result, plan };
}
