import { THINKING, callGemini, safeJsonParse, type Purpose, type ThinkingLevel } from './_shared';
import { buildGeneratePrompt, buildRecoveryPrompt, buildRepairPrompt, buildSystemInstruction } from './_prompt';
import { planForFeatures, type Plan, type Feature } from './_plan';
import { verifyPlanToken } from '@/lib/planToken';
import { createHash } from 'node:crypto';
import { checkFeatures, checkStoredFeatureEvidence } from '@/lib/featureCheck';
import { auditFeatureImplementation } from './_featureVerifier';
import { readCache, writeCache } from '@/lib/specCache';
import { autofix } from '@/lib/autofix';
import { normalizeGeneratedSpec } from '@/lib/normalizeGeneratedSpec';
import { smokeTest } from '@/lib/smokeTest';
import { validateSpec } from '@/lib/validateSpec';
import { compileFeatureContracts } from '@/lib/contractCompiler';
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
const MAX_REPAIRS = Number.isFinite(parsedRepairs) && parsedRepairs >= 0 && parsedRepairs <= 2 ? parsedRepairs : 2;

export type GenerationProgressStage = 'building' | 'validating' | 'repairing' | 'finalizing';
export type GenerationProgress = (stage: GenerationProgressStage) => void | Promise<void>;

const APP_SPEC_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: ['schemaVersion', 'id', 'version', 'manifest', 'capabilities', 'state', 'screens', 'navigation'],
  properties: {
    schemaVersion: { type: 'number', enum: [2] },
    id: { type: 'string' },
    version: { type: 'number' },
    manifest: {
      type: 'object',
      additionalProperties: true,
      required: ['name', 'icon', 'color', 'locale'],
      properties: {
        name: { type: 'string' }, icon: { type: 'string' }, locale: { type: 'string' },
        color: { type: 'string', enum: ['blue', 'green', 'amber', 'violet', 'rose', 'teal'] },
      },
    },
    capabilities: {
      type: 'array',
      items: { type: 'string', enum: ['clipboard','haptics','share','notifications','camera','scanner','sensors','location','files','network','llm','image','sandbox'] },
    },
    state: { type: 'object', additionalProperties: true },
    collections: { type: 'object', additionalProperties: true },
    screens: { type: 'object', additionalProperties: true },
    navigation: {
      type: 'object',
      additionalProperties: true,
      required: ['start', 'mode'],
      properties: { start: { type: 'string' }, mode: { type: 'string', enum: ['single', 'stack', 'tabs'] } },
    },
    components: { type: 'object', additionalProperties: true },
    featureEvidence: { type: 'object', additionalProperties: true },
  },
};

async function reportProgress(callback: GenerationProgress | undefined, stage: GenerationProgressStage): Promise<void> {
  if (!callback) return;
  try { await callback(stage); } catch (error) { console.warn('[toolkin.generate.progress]', error); }
}

function repairPromptForRound(originalPrompt: string, spec: unknown, errors: string[], round: number): string {
  const raw = typeof spec === 'string' ? spec : JSON.stringify(spec);
  // round 0 failure -> targeted repair; round 1 failure -> final semantic rebuild
  // when MAX_REPAIRS=2. For other configured values the final available round
  // still gets the recovery prompt.
  return MAX_REPAIRS > 0 && round + 1 >= MAX_REPAIRS
    ? buildRecoveryPrompt(originalPrompt, raw, errors)
    : buildRepairPrompt(raw, errors);
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
  let best: { spec: MiniAppSpec; issues: string[]; implemented: string[]; missing: { id: string; title: string }[] } | null = null;

  for (let round = 0; round <= MAX_REPAIRS; round++) {
    attempts += 1;
    await reportProgress(onProgress, round === 0 ? 'building' : 'repairing');

    const result = await callGemini(system, prompt, { jsonOnly: true, thinking, purpose, responseSchema: APP_SPEC_RESPONSE_SCHEMA });
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

    // Expression autofix MUST run before strict validation. The previous order
    // made the validator reject exactly the Math.round/state.foo/=== slips that
    // autofix was designed to repair, so many perfectly recoverable specs never
    // reached the fixer at all.
    const preFixed = autofix(normalized.spec as MiniAppSpec);

    // Product-level semantics are compiled deterministically before validation.
    // The model chooses IA/UX, while mandatory runtime data-flow implied by the
    // reviewed Product Plan (records, live aggregates, photo -> structured AI ->
    // editable fields -> save) is wired by code instead of spending repair rounds.
    const contracted = compileFeatureContracts(preFixed.spec, plan);
    const renormalized = normalizeGeneratedSpec(contracted.spec);
    const postFixed = autofix(renormalized.spec as MiniAppSpec);
    const allApplied = [...preFixed.applied, ...contracted.applied, ...renormalized.applied, ...postFixed.applied];
    const validation = validateSpec(postFixed.spec);

    if (validation.ok) {
      const fixed = { spec: validation.spec, applied: allApplied };

      // Форма правильная — теперь проверяем, что оно работает. Валидатор
      // пропускает утилиты, где на экране NaN, а кнопки ничего не меняют:
      // форма безупречна, а пользоваться нечем.
      const smoke = smokeTest(fixed.spec);
      if (!smoke.ok) {
        lastErrors = smoke.issues;
        prompt = repairPromptForRound(initialPrompt, fixed.spec, smoke.issues, round);
        continue;
      }

      // Product Plan is a real contract. First enforce exact mechanical
      // minimums on the reachable UI graph, then independently audit every
      // acceptance criterion. Builder-authored featureEvidence is metadata only;
      // it is never trusted as proof and is overwritten after a successful audit.
      const mechanical = checkFeatures(fixed.spec, plan?.features ?? []);
      if (!mechanical.ok) {
        if (!best || mechanical.implemented.length > best.implemented.length) {
          best = { spec: fixed.spec, issues: mechanical.issues, implemented: mechanical.implemented, missing: mechanical.missing };
        }
        lastErrors = mechanical.issues;
        prompt = repairPromptForRound(initialPrompt, fixed.spec, mechanical.issues, round);
        continue;
      }

      const audit = await auditFeatureImplementation(fixed.spec, plan?.features ?? [], mechanical.inventory);
      if (audit.usage) {
        usage.input += audit.usage.input;
        usage.output += audit.usage.output;
        usage.thoughts += audit.usage.thoughts;
      }

      if (!audit.ok) {
        // If the lightweight auditor itself is temporarily unavailable, a spec
        // with previously valid reachable evidence may still proceed. Fresh apps
        // normally take the semantic path; this fallback prevents an audit-model
        // outage from throwing away a mechanically sound generation.
        if (audit.unavailable) {
          const fallback = checkStoredFeatureEvidence(fixed.spec, plan?.features ?? []);
          if (fallback.ok) {
            fixed.spec.featureEvidence = fallback.evidence;
            await reportProgress(onProgress, 'finalizing');
            return {
              ok: true,
              spec: fixed.spec,
              attempts,
              usage,
              autofixed: [...normalized.applied, ...fixed.applied],
              features: fallback.implemented,
              missingFeatures: [],
            };
          }
          // A provider outage cannot be repaired by asking the builder to mutate
          // a valid app. Fail without charging; the async job can be retried later.
          return {
            ok: false,
            attempts,
            usage,
            error: 'model_unavailable',
            errors: ['Feature verification service is temporarily unavailable'],
          };
        }

        if (!best || audit.implemented.length > best.implemented.length) {
          best = { spec: fixed.spec, issues: audit.issues, implemented: audit.implemented, missing: audit.missing };
        }
        lastErrors = audit.issues;
        prompt = repairPromptForRound(initialPrompt, fixed.spec, audit.issues, round);
        continue;
      }

      fixed.spec.featureEvidence = audit.evidence;
      await reportProgress(onProgress, 'finalizing');
      return {
        ok: true,
        spec: fixed.spec,
        attempts,
        usage,
        autofixed: [...normalized.applied, ...fixed.applied],
        features: audit.implemented,
        missingFeatures: [],
      };
    }

    lastErrors = validation.errors;
    prompt = repairPromptForRound(initialPrompt, postFixed.spec, lastErrors, round);
  }

  // A reviewed feature selection is a contract. Returning a partially implemented
  // app and charging for it recreates the exact failure mode this pipeline is
  // designed to eliminate. Keep `best` only as repair context; never ship it.
  if (best) {
    return {
      ok: false,
      attempts,
      usage,
      errors: best.issues.length ? best.issues : lastErrors,
      error: 'feature_incomplete',
      features: best.implemented,
      missingFeatures: best.missing,
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
    const preFixed = autofix(normalized.spec as MiniAppSpec);
    const contracted = compileFeatureContracts(preFixed.spec, plan);
    const renormalized = normalizeGeneratedSpec(contracted.spec);
    const postFixed = autofix(renormalized.spec as MiniAppSpec);
    const validated = validateSpec(postFixed.spec);
    if (validated.ok) {
      const fixed = { spec: validated.spec, applied: [...preFixed.applied, ...contracted.applied, ...renormalized.applied, ...postFixed.applied] };
      const smoke = smokeTest(fixed.spec);
      const checked = smoke.ok ? checkStoredFeatureEvidence(fixed.spec, plan.features) : null;
      if (checked?.ok) {
        fixed.spec.featureEvidence = checked.evidence;
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
