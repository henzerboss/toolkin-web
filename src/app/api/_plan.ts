import { CAPABILITIES, COMPONENT_TYPES } from '@/lib/dsl';
import { THINKING, callGemini, safeJsonParse } from './_shared';

/**
 * Первый этап генерации: короткий план вместо сразу спеки.
 *
 * Зачем он нужен. Системный промпт разросся до четырнадцати тысяч знаков, и
 * правила из его середины модель теряла — отсюда игры, собранные из кнопок,
 * и числа, вытащенные из свободного текста. Дублирование правил в конце помогло
 * частично, но это подпорка.
 *
 * План решает то же самое архитектурно. Он маленький, целиком описывается
 * схемой, и потому ограниченное декодирование гарантирует: в нём не окажется
 * несуществующего компонента или возможности. А главное — план настолько
 * прост, что его ошибки можно исправить кодом, а не уговорами: если тип
 * «игра», песочница добавляется принудительно, и никакой промпт для этого
 * больше не нужен.
 *
 * Дальше второй этап получает промпт втрое короче — только те разделы,
 * которые относятся к выбранному типу утилиты.
 */

export type AppKind =
  | 'game'
  | 'tracker'
  | 'calculator'
  | 'timer'
  | 'converter'
  | 'ai_tool'
  | 'image_tool'
  | 'list'
  | 'countdown'
  | 'other';

export interface Plan {
  kind: AppKind;
  title: string;
  capabilities: string[];
  components: string[];
  needsRecords: boolean;
  needsStructuredAi: boolean;
  summary: string;
}

const KINDS: AppKind[] = [
  'game', 'tracker', 'calculator', 'timer', 'converter',
  'ai_tool', 'image_tool', 'list', 'countdown', 'other',
];

/**
 * Схема плана. Перечисления берутся из манифеста DSL, поэтому список
 * компонентов в схеме не может разойтись с рантаймом.
 */
const PLAN_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: KINDS },
    title: { type: 'STRING' },
    capabilities: { type: 'ARRAY', items: { type: 'STRING', enum: [...CAPABILITIES] } },
    components: { type: 'ARRAY', items: { type: 'STRING', enum: COMPONENT_TYPES } },
    needsRecords: { type: 'BOOLEAN' },
    needsStructuredAi: { type: 'BOOLEAN' },
    summary: { type: 'STRING' },
  },
  required: ['kind', 'title', 'capabilities', 'components', 'needsRecords', 'needsStructuredAi', 'summary'],
  // Порядок влияет на качество: модель заполняет поля по очереди, и решение
  // о типе утилиты должно быть принято до выбора компонентов.
  propertyOrdering: [
    'kind', 'title', 'needsRecords', 'needsStructuredAi', 'capabilities', 'components', 'summary',
  ],
};

const PLAN_SYSTEM = [
  'You plan small single-screen mobile utilities. You do not write the utility yet.',
  'Decide what kind of thing the request is and which building blocks it needs.',
  '',
  'kind:',
  '  game       — anything played: snake, breakout, tic-tac-toe, memory, puzzle, reaction test',
  '  tracker    — records something over time: water, weight, expenses, workouts',
  '  calculator — computes a result from inputs: tips, mortgage, BMI, percentages',
  '  timer      — countdown or interval: eggs, pomodoro, workout rounds',
  '  converter  — units, currencies, sizes',
  '  ai_tool    — the model answers something: recipes, translation, photo analysis',
  '  image_tool — generates pictures',
  '  list       — checklists, shopping lists',
  '  countdown  — days until a date, anniversaries, birthdays',
  '',
  'needsRecords: true when entries accumulate over time and history matters.',
  'needsStructuredAi: true when a number or a fixed field must come back from the model.',
  'summary: one sentence on what the utility does, in the user language.',
  'title: short name for the utility, max 24 characters, in the user language.',
].join('\n');

/**
 * Детерминированная коррекция плана.
 *
 * Всё, что здесь чинится, раньше пытались объяснить модели словами и
 * повторяли по три раза в промпте. План достаточно прост, чтобы просто
 * исправить его кодом — и тогда правило перестаёт быть вероятностным.
 */
function correct(plan: Plan): Plan {
  const capabilities = new Set(plan.capabilities);
  const components = new Set(plan.components);

  if (plan.kind === 'game') {
    // Игра целиком живёт в песочнице. Именно это правило модель нарушала чаще
    // всего, собирая поле из кнопок, которое не может ни ходить за противника,
    // ни анимироваться.
    capabilities.add('sandbox');
    components.add('Sandbox');
    ['Button', 'Select', 'Slider', 'Stepper', 'Toggle'].forEach((type) => components.delete(type));
  }

  if (plan.kind === 'image_tool') {
    capabilities.add('image');
    components.add('Image');
  }

  if (capabilities.has('camera')) {
    components.add('Image');
    // Снимок в истории должен быть виден: иначе в таблицу печатается путь
    // к файлу, а пользователь считает, что фото не сохранилось.
    if (plan.needsRecords) components.add('Gallery');
  }

  if (capabilities.has('image')) components.add('Image');
  if (capabilities.has('llm') && plan.kind === 'image_tool') capabilities.add('image');

  if (plan.needsRecords && !components.has('Gallery') && !components.has('Table')) {
    components.add('List');
  }

  // Календарь без выбора даты бесполезен: задать точку отсчёта нечем.
  if (components.has('Calendar')) components.add('DateField');

  return {
    ...plan,
    capabilities: [...capabilities],
    components: [...components],
  };
}

const FALLBACK: Plan = {
  kind: 'other',
  title: '',
  capabilities: [],
  components: [],
  needsRecords: false,
  needsStructuredAi: false,
  summary: '',
};

export interface PlanResult {
  plan: Plan;
  /** false — планирование не удалось, второй этап пойдёт с полным промптом. */
  ok: boolean;
}

export async function planApp(request: string, locale: string): Promise<PlanResult> {
  const result = await callGemini(
    `${PLAN_SYSTEM}\n\nUser language: ${locale}.`,
    `User request: "${request.slice(0, 600)}"`,
    { jsonOnly: true, thinking: THINKING.plan, purpose: 'plan', responseSchema: PLAN_SCHEMA },
  );

  if (!result.ok) return { plan: FALLBACK, ok: false };

  const parsed = safeJsonParse<Partial<Plan> | null>(result.text ?? '', null);
  if (!parsed?.kind) return { plan: FALLBACK, ok: false };

  return {
    plan: correct({
      kind: KINDS.includes(parsed.kind) ? parsed.kind : 'other',
      title: String(parsed.title ?? ''),
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
      components: Array.isArray(parsed.components) ? parsed.components : [],
      needsRecords: Boolean(parsed.needsRecords),
      needsStructuredAi: Boolean(parsed.needsStructuredAi),
      summary: String(parsed.summary ?? ''),
    }),
    ok: true,
  };
}
