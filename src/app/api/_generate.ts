import { callGemini, safeJsonParse } from './_shared';
import { buildRepairPrompt } from './_prompt';
import { validateSpec } from '@/lib/validateSpec';
import type { MiniAppSpec } from '@/lib/specTypes';

export interface SpecAttempt {
  ok: boolean;
  spec?: MiniAppSpec;
  errors?: string[];
  /** Сколько обращений к модели понадобилось — попадает в метрику качества промпта. */
  attempts: number;
  error?: string;
}

const MAX_REPAIRS = Number.parseInt(process.env.TOOLKIN_MAX_REPAIRS ?? '2', 10);

/**
 * Модель ошибается в спеке примерно в каждом пятом ответе, и почти всегда
 * это мелочь: несуществующий компонент, bind мимо state, забытая capability.
 * Цикл починки поднимает долю успеха с ~80% до ~97% ценой одного лишнего вызова,
 * поэтому он здесь, а не на клиенте — так пользователь не платит за круговой рейс.
 */
export async function generateSpec(system: string, initialPrompt: string): Promise<SpecAttempt> {
  let prompt = initialPrompt;
  let attempts = 0;
  let lastErrors: string[] = [];

  for (let round = 0; round <= MAX_REPAIRS; round++) {
    attempts += 1;

    const result = await callGemini(system, prompt, { jsonOnly: true });
    if (!result.ok) return { ok: false, attempts, error: result.error ?? 'model_unavailable' };

    const parsed = safeJsonParse<unknown>(result.text ?? '', null);
    if (parsed === null) {
      lastErrors = ['Ответ не является корректным JSON'];
      prompt = buildRepairPrompt(result.text ?? '', lastErrors);
      continue;
    }

    const validation = validateSpec(parsed);
    if (validation.ok) return { ok: true, spec: validation.spec, attempts };

    lastErrors = validation.errors;
    prompt = buildRepairPrompt(JSON.stringify(parsed), lastErrors);
  }

  return { ok: false, attempts, errors: lastErrors, error: 'validation_failed' };
}
