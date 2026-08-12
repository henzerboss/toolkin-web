import { THINKING, callGemini, cors, guard, json } from '../_shared';
import { canAfford, charge } from '@/lib/credits';
import { COST } from '@/lib/pricing';

export const runtime = 'nodejs';
/** Генерация картинки идёт дольше текста, дефолтных 10 секунд Vercel не хватило бы. */
export const maxDuration = 60;

interface Body {
  prompt?: string;
  appId?: string;
  /** Квадрат по умолчанию: утилиты показывают результат в карточке. */
  aspect?: 'square' | 'portrait' | 'landscape';
}

/**
 * Размер задаётся строкой «ШИРИНАxВЫСОТА» — так его ждёт OpenAI-совместимый API.
 * Базовый берётся из окружения, а соотношение сторон утилита выбирает сама.
 */
const BASE_SIZE = process.env.TOOLKIN_DEEPINFRA_IMAGE_SIZE ?? '1024x1024';
const MODEL = process.env.TOOLKIN_DEEPINFRA_IMAGE_MODEL ?? 'black-forest-labs/FLUX-1-schnell';
const parsedSteps = Number.parseInt(process.env.TOOLKIN_DEEPINFRA_IMAGE_STEPS ?? '', 10);
const STEPS = Number.isFinite(parsedSteps) && parsedSteps >= 1 && parsedSteps <= 4 ? parsedSteps : 4;

function sizeFor(aspect: string | undefined): string {
  const [rawWidth] = BASE_SIZE.split('x');
  const base = Number.parseInt(rawWidth, 10) || 1024;
  const short = Math.round((base * 3) / 4 / 64) * 64;

  if (aspect === 'portrait') return `${short}x${base}`;
  if (aspect === 'landscape') return `${base}x${short}`;
  return BASE_SIZE;
}

/**
 * FLUX понимает только английский: на русском или японском он выдаёт
 * бессмысленный результат вместо ошибки, что хуже отказа. Промпт собирается
 * моделью на языке пользователя и вдобавок содержит его собственный ввод,
 * поэтому переводим перед отправкой.
 *
 * Латиница пропускается без перевода — это лишний вызов и лишняя задержка
 * там, где всё уже правильно.
 */
async function toEnglish(prompt: string): Promise<string> {
  if (process.env.TOOLKIN_IMAGE_TRANSLATE === 'false') return prompt;
  // eslint-disable-next-line no-control-regex
  if (!/[^\u0000-\u024F]/.test(prompt)) return prompt;

  const result = await callGemini(
    'Переведи текст на английский как промпт для генератора изображений. ' +
      'Верни только перевод: без кавычек, пояснений и предисловий. ' +
      'Сохрани все детали, стиль и перечисления.',
    prompt,
    { jsonOnly: false, thinking: THINKING.translate, purpose: 'translate' },
  );

  const translated = (result.text ?? '').trim();
  // Перевод не удался — отправляем оригинал: плохая картинка лучше, чем
  // списанные кредиты и пустой экран.
  return result.ok && translated.length > 1 ? translated : prompt;
}

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin') ?? '') });
}

/**
 * Картинки генерирует FLUX-1-schnell на DeepInfra, а не Gemini: schnell — это
 * четыре шага диффузии, он отвечает за пару секунд и стоит копейки, чего для
 * утилиты вроде «иконка для заметки» более чем достаточно.
 *
 * Ответ возвращается как data URI: сохранять файл на сервере незачем,
 * картинка нужна ровно один раз и живёт дальше на устройстве.
 */
export async function POST(req: Request) {
  const g = await guard(req);
  if (!g.ok) return g.response!;
  const { headers, account } = g;

  const apiKey = process.env.TOOLKIN_DEEPINFRA_API_KEY;
  if (!apiKey) return json({ error: 'image_generation_disabled' }, 501, headers);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400, headers);
  }

  const prompt = (body.prompt ?? '').trim();
  if (prompt.length < 2) return json({ error: 'prompt_required' }, 400, headers);
  if (prompt.length > 1200) return json({ error: 'prompt_too_long' }, 400, headers);

  const price = COST.image();
  if (!canAfford(account!, price)) {
    return json({ error: 'insufficient_credits', credits: account!.credits, price }, 402, headers);
  }

  try {
    const englishPrompt = await toEnglish(prompt);

    // OpenAI-совместимый эндпоинт DeepInfra, а не /v1/inference: у последнего
    // другой формат тела и ответа, и именно на этом генерация не работала.
    const res = await fetch('https://api.deepinfra.com/v1/openai/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        prompt: englishPrompt,
        size: sizeFor(body.aspect),
        n: 1,
        num_inference_steps: STEPS,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return json({ error: 'image_provider_failed', detail: detail.slice(0, 300) }, 503, headers);
    }

    const payload = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
    const entry = payload.data?.[0];
    const base64 = entry?.b64_json;
    if (!base64 && !entry?.url) return json({ error: 'empty_response' }, 503, headers);

    // Списываем только после успеха — как и везде: неудача не должна стоить денег.
    const charged = await charge(account!.appUserId, 'image', price, { appId: body.appId });

    if (!charged.ok) return json({ error: 'insufficient_credits', credits: charged.credits, price }, 402, headers);

    const image = base64 ? `data:image/jpeg;base64,${base64}` : entry!.url!;
    return json(
      { image, credits: charged.credits, prompt: englishPrompt !== prompt ? englishPrompt : undefined },
      200,
      headers,
    );
  } catch (error) {
    return json({ error: 'image_provider_failed', detail: String(error).slice(0, 200) }, 503, headers);
  }
}
