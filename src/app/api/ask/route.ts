import { THINKING, callGemini, cors, guard, json, safeJsonParse } from '../_shared';
import { languageName } from '../_prompt';
import { canAfford, charge } from '@/lib/credits';
import { COST } from '@/lib/pricing';

export const runtime = 'nodejs';

interface Body {
  prompt?: string;
  locale?: string;
  /** JPEG в base64 — для утилит вроде «разбери чек по фото». */
  imageBase64?: string;
  appId?: string;
  /**
   * Имя поля → что в него положить. Если задано, модель отвечает JSON,
   * а не свободным текстом.
   */
  fields?: Record<string, string>;
}

const MAX_PROMPT = 4000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin') ?? '') });
}

/**
 * Экшен llm.ask внутри утилиты. В отличие от генерации, здесь ответ —
 * произвольный текст, а не спека, поэтому вывод жёстко ограничивается
 * инструкцией: утилита ждёт короткую строку, а не рассуждение.
 */
export async function POST(req: Request) {
  const g = await guard(req);
  if (!g.ok) return g.response!;
  const { headers, account } = g;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400, headers);
  }

  const prompt = (body.prompt ?? '').trim();
  if (!prompt) return json({ error: 'prompt_required' }, 400, headers);
  if (prompt.length > MAX_PROMPT) return json({ error: 'prompt_too_long' }, 400, headers);

  const image = body.imageBase64;
  if (image && image.length * 0.75 > MAX_IMAGE_BYTES) {
    return json({ error: 'image_too_large' }, 413, headers);
  }

  const price = COST.ask();
  if (!canAfford(account!, price)) {
    return json({ error: 'insufficient_credits', credits: account!.credits, price }, 402, headers);
  }

  const lang = languageName(body.locale);
  let fields: Record<string, string> | null = null;
  if (body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)) {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.fields).slice(0, 16)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(key) || typeof value !== 'string') continue;
      const description = value.trim().slice(0, 240);
      if (description) sanitized[key] = description;
    }
    if (Object.keys(sanitized).length) fields = sanitized;
  }

  /**
   * Структурированный ответ существует потому, что свободный текст нельзя
   * положить в число. Утилита просила калорийность, получала «Калории: 650 ккал,
   * состав…», клала это в поле записи — и в истории появлялся ноль, потому что
   * Number() от такой строки даёт NaN. Разбирать текст выражениями было бы
   * гаданием, поэтому формат задаётся заранее.
   */
  const system = fields
    ? [
        'Ты отвечаешь на запрос изнутри маленькой утилиты на телефоне.',
        `Текстовые значения пиши на языке "${lang}".`,
        'Верни ТОЛЬКО JSON-объект ровно с этими ключами:',
        Object.entries(fields)
          .map(([key, description]) => `  "${key}": ${description}`)
          .join('\n'),
        'Числа возвращай числами, без единиц измерения и без пояснений внутри значения.',
        'Если значение определить нельзя — поставь 0 для чисел и пустую строку для текста.',
        'Никакого markdown и обратных кавычек.',
      ].join('\n')
    : [
        'Ты отвечаешь на запрос изнутри маленькой утилиты на телефоне.',
        `Отвечай на языке "${lang}".`,
        'Ответ должен быть коротким и готовым к показу как есть: без вступлений, без markdown,',
        'без пояснений о том, как ты его получил. Если просят число — верни число.',
        'Если задача невыполнима по имеющимся данным — верни одну фразу с объяснением.',
      ].join(' ');

  const result = await callGemini(system, prompt, {
    imageBase64: image,
    jsonOnly: Boolean(fields),
    thinking: THINKING.ask,
    purpose: 'ask',
  });
  if (!result.ok) return json({ error: result.error ?? 'model_unavailable' }, 503, headers);

  if (fields) {
    const parsed = safeJsonParse<Record<string, unknown> | null>(result.text ?? '', null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return json({ error: 'bad_model_json' }, 502, headers);
    }

    // Validate the usable result before charging. A malformed structured model
    // response is a failed request and must not cost the user credits.
    const values: Record<string, unknown> = {};
    for (const key of Object.keys(fields)) values[key] = parsed[key] ?? null;
    const charged = await charge(account!.appUserId, 'ask', price, { appId: body.appId });
    if (!charged.ok) return json({ error: 'insufficient_credits', credits: charged.credits, price }, 402, headers);
    return json({ values, credits: charged.credits }, 200, headers);
  }

  const text = (result.text ?? '').trim();
  if (!text) return json({ error: 'empty_response' }, 502, headers);
  const charged = await charge(account!.appUserId, 'ask', price, { appId: body.appId });
  if (!charged.ok) return json({ error: 'insufficient_credits', credits: charged.credits, price }, 402, headers);
  return json({ text, credits: charged.credits }, 200, headers);
}
