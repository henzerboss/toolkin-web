import { MODELS, cors, guard, json } from '../_shared';

export const runtime = 'nodejs';

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin') ?? '') });
}

/**
 * Диагностика конфигурации. Существует потому, что самый частый способ сломать
 * прод здесь — не баг в коде, а снятая с обслуживания модель: Google закрывает
 * старые имена раньше объявленных дат, и запрос начинает отдавать 404.
 *
 * Роут показывает, какие из настроенных моделей ключ реально видит, чтобы не
 * выяснять это по графику ошибок в консоли.
 */
export async function GET(req: Request) {
  const g = await guard(req, { requireAccount: false });
  if (!g.ok) return g.response!;
  const { headers } = g;

  const apiKey = process.env.TOOLKIN_GEMINI_API_KEY;
  if (!apiKey) return json({ ok: false, error: 'TOOLKIN_GEMINI_API_KEY не задан' }, 500, headers);

  let available: string[] = [];
  let listError: string | null = null;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (res.ok) {
      const body = (await res.json()) as { models?: { name?: string }[] };
      available = (body.models ?? [])
        .map((model) => (model.name ?? '').replace(/^models\//, ''))
        .filter(Boolean);
    } else {
      listError = `${res.status}`;
    }
  } catch (error) {
    listError = String(error);
  }

  // ListModels показывает и снятые модели, поэтому проверяем настроенные
  // настоящим вызовом: только он отличает «числится в списке» от «работает».
  const probes = await Promise.all(
    MODELS.map(async (model) => {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
              generationConfig: { maxOutputTokens: 1 },
            }),
          },
        );
        return { model, ok: res.ok, status: res.status };
      } catch (error) {
        return { model, ok: false, status: 0, error: String(error) };
      }
    }),
  );

  const working = probes.filter((probe) => probe.ok).map((probe) => probe.model);

  // Генератор картинок проверяется настоящим вызовом с минимальным промптом:
  // это единственный способ отличить «ключ не задан» от «модель недоступна»
  // и от «поменялся формат ответа».
  const image = await probeImage();

  return json(
    {
      ok: working.length > 0,
      configured: MODELS,
      working,
      probes,
      listError,
      availableCount: available.length,
      // Подсказка, чем заменить, если ни одна из настроенных не отвечает.
      suggestions: available.filter((name) => /flash|pro/.test(name)).slice(0, 12),
      image,
      database: Boolean(process.env.DATABASE_URL),
      clientTokenSet: Boolean(process.env.TOOLKIN_CLIENT_TOKEN),
    },
    working.length > 0 ? 200 : 503,
    headers,
  );
}

async function probeImage(): Promise<Record<string, unknown>> {
  const key = process.env.TOOLKIN_DEEPINFRA_API_KEY;
  if (!key) return { ok: false, reason: 'TOOLKIN_DEEPINFRA_API_KEY не задан' };

  const model = process.env.TOOLKIN_DEEPINFRA_IMAGE_MODEL ?? 'black-forest-labs/FLUX-1-schnell';
  const size = process.env.TOOLKIN_DEEPINFRA_IMAGE_SIZE ?? '1024x1024';

  try {
    const res = await fetch('https://api.deepinfra.com/v1/openai/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, prompt: 'a red circle on white background', size, n: 1 }),
    });

    const text = await res.text();
    if (!res.ok) return { ok: false, model, status: res.status, detail: text.slice(0, 400) };

    const payload = JSON.parse(text) as { data?: { b64_json?: string; url?: string }[] };
    const entry = payload.data?.[0];
    return {
      ok: Boolean(entry?.b64_json || entry?.url),
      model,
      size,
      // Длина base64 подтверждает, что пришла картинка, а не заглушка.
      bytes: entry?.b64_json ? Math.round((entry.b64_json.length * 3) / 4) : 0,
      shape: entry ? Object.keys(entry) : Object.keys(payload),
    };
  } catch (error) {
    return { ok: false, model, detail: String(error).slice(0, 300) };
  }
}
