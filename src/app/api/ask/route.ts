import { callGemini, cors, guard, json } from '../_shared';
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
  if (!(await canAfford(account!, 'ask', price))) {
    return json({ error: 'insufficient_credits', credits: account!.credits, price }, 402, headers);
  }

  const lang = languageName(body.locale);
  const system = [
    'Ты отвечаешь на запрос изнутри маленькой утилиты на телефоне.',
    `Отвечай на языке "${lang}".`,
    'Ответ должен быть коротким и готовым к показу как есть: без вступлений, без markdown,',
    'без пояснений о том, как ты его получил. Если просят число — верни число.',
    'Если задача невыполнима по имеющимся данным — верни одну фразу с объяснением.',
  ].join(' ');

  const result = await callGemini(system, prompt, { imageBase64: image, jsonOnly: false });
  if (!result.ok) return json({ error: result.error ?? 'model_unavailable' }, 503, headers);

  const charged = await charge(account!.appUserId, 'ask', price, { appId: body.appId });

  return json(
    { text: (result.text ?? '').trim(), credits: charged.credits, paidWith: charged.paidWith },
    200,
    headers,
  );
}
