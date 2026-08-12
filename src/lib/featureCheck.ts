import type { Feature } from '@/app/api/_plan';
import type { MiniAppSpec, UiNode } from '@/lib/specTypes';

/**
 * Проверка, что обещанные фичи действительно есть в собранной утилите.
 *
 * Это и есть то, ради чего фича описывается требованиями, а не просто текстом.
 * Пользователь видел список и оставил галочку на «напоминании перед следующим
 * циклом» — значит в спеке обязан быть экшен notify.at. Без такой проверки
 * список фич был бы обещанием, которое никто не сдерживает: модель кивает,
 * собирает половину и ошибку никто не замечает.
 *
 * Ненайденные фичи уходят в цикл починки поимённо, а не общим «сделай лучше».
 */

function collect(spec: MiniAppSpec): { components: Set<string>; actions: Set<string> } {
  const components = new Set<string>();
  const actions = new Set<string>();

  const walk = (node: UiNode): void => {
    components.add(node.type);

    if (Array.isArray(node.onPress)) {
      for (const raw of node.onPress as unknown as Record<string, unknown>[]) {
        if (typeof raw?.action === 'string') actions.add(raw.action);
      }
    }
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };

  walk(spec.ui);
  return { components, actions };
}

export interface FeatureCheck {
  ok: boolean;
  /** Инструкции для цикла починки: что именно не реализовано. */
  issues: string[];
  /** Фичи, которые дошли до готовой утилиты. Уходят клиенту как факт. */
  implemented: string[];
}

export function checkFeatures(spec: MiniAppSpec, features: Feature[]): FeatureCheck {
  if (features.length === 0) return { ok: true, issues: [], implemented: [] };

  const { components, actions } = collect(spec);
  const capabilities = new Set<string>(spec.capabilities);

  const issues: string[] = [];
  const implemented: string[] = [];

  for (const feature of features) {
    const missing: string[] = [];

    for (const component of feature.requiresComponents) {
      if (!components.has(component)) missing.push(`component ${component}`);
    }
    for (const action of feature.requiresActions) {
      if (!actions.has(action)) missing.push(`action ${action}`);
    }
    for (const capability of feature.requiresCapabilities) {
      if (!capabilities.has(capability)) missing.push(`capability ${capability}`);
    }

    if (missing.length === 0) {
      implemented.push(feature.id);
      continue;
    }

    issues.push(
      `feature "${feature.title}" was promised to the user but is not implemented: ` +
        `missing ${missing.join(', ')}. Add it — the person explicitly asked for this feature`,
    );
  }

  return { ok: issues.length === 0, issues, implemented };
}
