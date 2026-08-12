import type { Feature } from '@/app/api/_plan';
import type { MiniAppSpec, UiNode } from '@/lib/specTypes';

/**
 * Проверка, что обещанные фичи есть в собранной утилите.
 *
 * Проверка намеренно снисходительная. Первая версия требовала точного
 * совпадения имён и заворачивала хорошие утилиты: планировщик писал `Stat`,
 * сборщик делал `ProgressRing` — по смыслу одно и то же, — или требовал
 * `state.set` там, где поле ввода с `bind` пишет состояние само, вообще без
 * экшена. Строгость ловила не ошибки, а разные способы сказать одно и то же.
 *
 * Поэтому сравниваются не имена, а роли: «показать результат», «ввести число»,
 * «показать историю». Роль закрыта любым компонентом из своего класса.
 */

/** Компоненты, взаимозаменяемые с точки зрения пользы для пользователя. */
const COMPONENT_GROUPS: string[][] = [
  ['Stat', 'ProgressRing', 'Text'],
  ['NumberField', 'Slider', 'Stepper'],
  ['List', 'Table', 'Gallery', 'Chart', 'LineChart', 'PieChart'],
  ['Chart', 'LineChart', 'PieChart', 'ProgressRing'],
  ['DateField', 'Calendar'],
  ['Image', 'Gallery'],
  ['Select', 'Toggle'],
];

/** Экшены, закрывающие одну и ту же потребность. */
const ACTION_GROUPS: string[][] = [
  ['state.set', 'state.inc', 'state.toggle', 'state.random', 'state.reset'],
  ['records.add', 'records.remove', 'records.clear'],
  ['timer.start', 'timer.pause', 'timer.reset'],
  ['notify.schedule', 'notify.at'],
  ['clipboard.set', 'share'],
  ['llm.ask', 'image.generate'],
];

function satisfied(required: string, present: Set<string>, groups: string[][]): boolean {
  if (present.has(required)) return true;

  for (const group of groups) {
    if (!group.includes(required)) continue;
    if (group.some((alternative) => present.has(alternative))) return true;
  }
  return false;
}

function collect(spec: MiniAppSpec): { components: Set<string>; actions: Set<string> } {
  const components = new Set<string>();
  const actions = new Set<string>();

  const walk = (node: UiNode): void => {
    components.add(node.type);

    // Поле с bind меняет состояние без экшена — для пользователя это ровно
    // то же самое, что нажать кнопку с state.set.
    if (typeof node.bind === 'string') actions.add('state.set');

    if (Array.isArray(node.onPress)) {
      for (const raw of node.onPress as unknown as Record<string, unknown>[]) {
        if (typeof raw?.action === 'string') actions.add(raw.action);
      }
    }
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };

  walk(spec.ui);

  // Песочница самодостаточна: внутри неё может быть что угодно, и требовать
  // от такой утилиты отдельных компонентов бессмысленно.
  if (components.has('Sandbox')) {
    ['Stat', 'Button', 'List', 'Chart'].forEach((type) => components.add(type));
    ['state.set', 'records.add'].forEach((action) => actions.add(action));
  }

  return { components, actions };
}

export interface FeatureCheck {
  ok: boolean;
  /** Инструкции для цикла починки: что именно не реализовано. */
  issues: string[];
  /** Фичи, дошедшие до готовой утилиты. */
  implemented: string[];
  /** Фичи, которых не хватило. Показываются пользователю честно. */
  missing: { id: string; title: string }[];
}

export function checkFeatures(spec: MiniAppSpec, features: Feature[]): FeatureCheck {
  if (features.length === 0) return { ok: true, issues: [], implemented: [], missing: [] };

  const { components, actions } = collect(spec);
  const capabilities = new Set<string>(spec.capabilities);

  const issues: string[] = [];
  const implemented: string[] = [];
  const missing: { id: string; title: string }[] = [];

  for (const feature of features) {
    const gaps: string[] = [];

    for (const component of feature.requiresComponents) {
      if (!satisfied(component, components, COMPONENT_GROUPS)) gaps.push(`component ${component}`);
    }
    for (const action of feature.requiresActions) {
      if (!satisfied(action, actions, ACTION_GROUPS)) gaps.push(`action ${action}`);
    }
    // Права не заменяются ничем: без объявленной capability экшен просто
    // не выполнится, тут снисходительность неуместна.
    for (const capability of feature.requiresCapabilities) {
      if (!capabilities.has(capability)) gaps.push(`capability ${capability}`);
    }

    if (gaps.length === 0) {
      implemented.push(feature.id);
      continue;
    }

    missing.push({ id: feature.id, title: feature.title });
    issues.push(
      `feature "${feature.title}" is missing: ${gaps.join(', ')}. ` +
        'The person ticked this feature, so add it — or use an equivalent component ' +
        'that gives the same result',
    );
  }

  return { ok: issues.length === 0, issues, implemented, missing };
}
