import { cors, guard, json } from '../_shared';
import { planApp } from '../_plan';

export const runtime = 'nodejs';

interface Body {
  prompt?: string;
  locale?: string;
}

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin') ?? '') });
}

/**
 * Согласование фич перед сборкой.
 *
 * Человек, просящий «женский календарь», не продумал, что в нём должно быть —
 * и это нормально, продумать должны мы. Роут возвращает список предложенных
 * фич, приложение показывает их галочками, и только после подтверждения
 * начинается генерация.
 *
 * Вызов бесплатный: он идёт на дешёвой модели и стоит доли цента, а брать
 * кредиты за вопрос «что вам нужно» значило бы штрафовать человека за то,
 * что он ещё ничего не получил. Защита от злоупотребления — лимит по IP,
 * общий для всех роутов.
 */
export async function POST(req: Request) {
  const g = await guard(req);
  if (!g.ok) return g.response!;
  const { headers } = g;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400, headers);
  }

  const prompt = (body.prompt ?? '').trim();
  if (prompt.length < 3) return json({ error: 'prompt_too_short' }, 400, headers);
  if (prompt.length > 600) return json({ error: 'prompt_too_long' }, 400, headers);

  const locale = (body.locale ?? 'en').trim();
  const { plan, ok } = await planApp(prompt, locale);

  // Планирование не удалось — приложение просто пропустит экран выбора
  // и соберёт утилиту как раньше. Отказывать здесь незачем.
  if (!ok || plan.features.length === 0) {
    return json({ available: false, title: '', summary: '', features: [] }, 200, headers);
  }

  return json(
    {
      available: true,
      title: plan.title,
      summary: plan.summary,
      kind: plan.kind,
      features: plan.features.map((feature) => ({
        id: feature.id,
        title: feature.title,
        description: feature.description,
        essential: feature.essential,
      })),
    },
    200,
    headers,
  );
}
