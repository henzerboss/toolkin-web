import { cors, guard, json } from '../_shared';
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

const SIZES: Record<string, { width: number; height: number }> = {
  square: { width: 1024, height: 1024 },
  portrait: { width: 768, height: 1024 },
  landscape: { width: 1024, height: 768 },
};

const MODEL = process.env.TOOLKIN_IMAGE_MODEL ?? 'black-forest-labs/FLUX-1-schnell';

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

  const size = SIZES[body.aspect ?? 'square'] ?? SIZES.square;

  try {
    const res = await fetch(`https://api.deepinfra.com/v1/inference/${MODEL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        prompt,
        width: size.width,
        height: size.height,
        num_images: 1,
        num_inference_steps: 4,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return json({ error: 'image_provider_failed', detail: detail.slice(0, 300) }, 503, headers);
    }

    const payload = (await res.json()) as { images?: string[] };
    const image = payload.images?.[0];
    if (!image) return json({ error: 'empty_response' }, 503, headers);

    // Списываем только после успеха — как и везде: неудача не должна стоить денег.
    const charged = await charge(account!.appUserId, 'image', price, { appId: body.appId });

    // Провайдер отдаёт готовый data URI; если формат изменится — приводим сами,
    // чтобы клиенту всегда приходило одно и то же.
    const dataUri = image.startsWith('data:') ? image : `data:image/png;base64,${image}`;
    return json({ image: dataUri, credits: charged.credits }, 200, headers);
  } catch (error) {
    return json({ error: 'image_provider_failed', detail: String(error).slice(0, 200) }, 503, headers);
  }
}
