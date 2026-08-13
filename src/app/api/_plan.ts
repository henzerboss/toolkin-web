import { ACTION_NAMES, CAPABILITIES, COMPONENT_TYPES } from '@/lib/dsl';
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

/**
 * Фича — единица продуктовой ценности, которую пользователь может включить
 * или выключить.
 *
 * Поля requires* существуют не для модели, а для проверки: по ним видно,
 * реализована ли фича на самом деле. Пользователь выбрал «напоминания» —
 * значит в спеке обязан быть экшен notify.at, иначе обещание нарушено.
 * Без этой механики список фич был бы декорацией.
 */
export interface Feature {
  id: string;
  title: string;
  description: string;
  /** Основные включены по умолчанию и снимаются пользователем осознанно. */
  essential: boolean;
  requiresComponents: string[];
  requiresActions: string[];
  requiresCapabilities: string[];
}

export interface Plan {
  kind: AppKind;
  title: string;
  capabilities: string[];
  components: string[];
  needsRecords: boolean;
  needsStructuredAi: boolean;
  summary: string;
  features: Feature[];
}

const KINDS: AppKind[] = [
  'game', 'tracker', 'calculator', 'timer', 'converter',
  'ai_tool', 'image_tool', 'list', 'countdown', 'other',
];

/**
 * Схема плана. Перечисления берутся из манифеста DSL, поэтому список
 * компонентов в схеме не может разойтись с рантаймом.
 */
const FEATURE_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    id: { type: 'STRING' },
    title: { type: 'STRING' },
    description: { type: 'STRING' },
    essential: { type: 'BOOLEAN' },
    requiresComponents: { type: 'ARRAY', items: { type: 'STRING', enum: COMPONENT_TYPES } },
    requiresActions: { type: 'ARRAY', items: { type: 'STRING', enum: ACTION_NAMES } },
    requiresCapabilities: { type: 'ARRAY', items: { type: 'STRING', enum: [...CAPABILITIES] } },
  },
  required: ['id', 'title', 'description', 'essential', 'requiresComponents', 'requiresActions', 'requiresCapabilities'],
  propertyOrdering: [
    'id', 'title', 'description', 'essential',
    'requiresComponents', 'requiresActions', 'requiresCapabilities',
  ],
};

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
    features: { type: 'ARRAY', items: FEATURE_SCHEMA, minItems: 3, maxItems: 7 },
  },
  required: [
    'kind', 'title', 'capabilities', 'components',
    'needsRecords', 'needsStructuredAi', 'summary', 'features',
  ],
  // Порядок влияет на качество: модель заполняет поля по очереди, и решение
  // о типе утилиты должно быть принято до выбора компонентов.
  propertyOrdering: [
    'kind', 'title', 'summary', 'features',
    'needsRecords', 'needsStructuredAi', 'capabilities', 'components',
  ],
};

const PLAN_SYSTEM = [
  'You plan small single-screen mobile utilities. You do not write the utility yet.',
  'Decide what kind of thing the request is, then propose the features worth having.',
  '',
  'FEATURES are the point of this step. A person asking for a "period tracker" has not',
  'thought through what it should do — that is your job. Propose 3 to 7 features that',
  'make the utility genuinely useful, ordered by value, and say honestly which are',
  'essential and which are optional. The person will tick them off before you build.',
  '',
  'A good feature is something the person would miss if it were absent:',
  '  period tracker  → cycle prediction, fertile window on a calendar, period logging,',
  '                    reminder before the next period, symptom notes, cycle length stats',
  '  expense tracker → quick entry, split by category, monthly total, chart, export',
  '  water tracker   → daily goal from weight, one-tap portions, progress ring, reminders',
  'A bad feature is a restatement of the request ("tracks periods") or a component name',
  '("has a calendar"). Describe what the person gets, in their language, in one line.',
  '',
  'requiresComponents, requiresActions, requiresCapabilities: the MINIMUM the feature',
  'cannot exist without. These are checked mechanically, so listing extras only causes',
  'false failures. Rules of thumb:',
  '  - leave the lists empty when the feature is just a calculation shown on screen',
  '  - text input, sliders and steppers write state by themselves: no action needed',
  '  - list only a capability when the feature truly needs the device: notifications,',
  '    camera, llm, image',
  '  - never list a component just because it looks nice — only when the feature is',
  '    meaningless without it (a calendar feature genuinely needs Calendar)',
  '',
  'Remember the utility is ONE screen with 4 to 8 blocks. Do not propose features that',
  'would need a second screen or a settings page.',
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
  features: [],
};

export interface PlanResult {
  plan: Plan;
  /** false — планирование не удалось, второй этап пойдёт с полным промптом. */
  ok: boolean;
}

function normalizeFeatures(raw: unknown): Feature[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const features: Feature[] = [];

  for (const item of raw as Partial<Feature>[]) {
    const id = String(item?.id ?? '').trim().slice(0, 40);
    const title = String(item?.title ?? '').trim();
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);

    features.push({
      id,
      title: title.slice(0, 60),
      description: String(item.description ?? '').slice(0, 140),
      essential: Boolean(item.essential),
      requiresComponents: Array.isArray(item.requiresComponents) ? item.requiresComponents : [],
      requiresActions: Array.isArray(item.requiresActions) ? item.requiresActions : [],
      requiresCapabilities: Array.isArray(item.requiresCapabilities) ? item.requiresCapabilities : [],
    });
  }

  return features.slice(0, 7);
}

/**
 * Пересобирает план под выбранные пользователем фичи.
 *
 * Снятая галочка должна убирать из плана и требования этой фичи — иначе
 * утилита получит камеру, о которой человек не просил, и это будет выглядеть
 * как игнорирование его выбора.
 */
export function planForFeatures(plan: Plan, selectedIds: string[]): Plan {
  const selected = plan.features.filter((feature) => selectedIds.includes(feature.id));
  if (selected.length === 0) return plan;

  const components = new Set<string>();
  const capabilities = new Set<string>();
  const actions = new Set<string>();

  for (const feature of selected) {
    feature.requiresComponents.forEach((item) => components.add(item));
    feature.requiresCapabilities.forEach((item) => capabilities.add(item));
    feature.requiresActions.forEach((item) => actions.add(item));
  }

  // Записи и структурированный ответ выводятся из требований фич, а не
  // остаются от первоначального плана.
  const needsRecords = [...actions].some((action) => action.startsWith('records.'));
  const needsStructuredAi = capabilities.has('llm') && plan.needsStructuredAi;

  return correct({
    ...plan,
    features: selected,
    components: [...components],
    capabilities: [...capabilities],
    needsRecords: needsRecords || plan.needsRecords,
    needsStructuredAi,
  });
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
      features: normalizeFeatures(parsed.features),
    }),
    ok: true,
  };
}
