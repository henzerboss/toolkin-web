import { THINKING, cors, guard, json } from '../_shared';
import { buildRefinePrompt, buildSystemInstruction } from '../_prompt';
import { generateSpec } from '../_generate';
import { canAfford, charge } from '@/lib/credits';
import { COST } from '@/lib/pricing';
import { validateSpec } from '@/lib/validateSpec';

export const runtime = 'nodejs';

interface Body {
  spec?: unknown;
  instruction?: string;
  locale?: string;
}

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin') ?? '') });
}

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

  const instruction = (body.instruction ?? '').trim();
  if (instruction.length < 2) return json({ error: 'instruction_too_short' }, 400, headers);

  // Спека приходит с устройства, поэтому доверять ей нельзя: сначала проверяем,
  // что чиним валидную утилиту, иначе модель получит мусор и вернёт мусор.
  const current = validateSpec(body.spec);
  if (!current.ok) return json({ error: 'invalid_spec', errors: current.errors }, 400, headers);

  const locale = (body.locale ?? current.spec.manifest.locale ?? 'en').trim();
  const price = COST.refine();

  if (!canAfford(account!, price)) {
    return json({ error: 'insufficient_credits', credits: account!.credits, price }, 402, headers);
  }

  const result = await generateSpec(
    buildSystemInstruction(locale),
    buildRefinePrompt(current.spec, instruction),
    THINKING.refine,
    'refine',
  );

  if (!result.ok) {
    return json(
      { error: result.error, errors: result.errors, attempts: result.attempts },
      result.error === 'validation_failed' ? 422 : 503,
      headers,
    );
  }

  // Модель регулярно забывает поднять версию или меняет id — правим сами,
  // иначе история версий на устройстве схлопнется в одну запись.
  const spec = {
    ...result.spec!,
    id: current.spec.id,
    version: Math.max(current.spec.version + 1, result.spec!.version),
  };

  const charged = await charge(account!.appUserId, 'refine', price, { attempts: result.attempts });

  return json(
    {
      spec,
      attempts: result.attempts,
      credits: charged.credits,
    },
    200,
    headers,
  );
}
