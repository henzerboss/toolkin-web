import type { MiniAppSpec, UiNode } from '@/lib/specTypes';

/**
 * Механическая починка выражений.
 *
 * Модель обучена на JavaScript и пишет `Math.round(x)`, `state.bill`,
 * `items.length` — это не непонимание задачи, а привычка руки. Отправлять
 * такое в цикл починки расточительно: лишний вызов Gemini, лишние секунды
 * ожидания и лишний шанс, что модель заодно переделает работающие блоки.
 *
 * Здесь чинится только то, что имеет однозначное соответствие. Всё
 * неоднозначное по-прежнему уходит модели.
 */

interface Rule {
  pattern: RegExp;
  replace: string | ((match: string, ...groups: string[]) => string);
  note: string;
}

const RULES: Rule[] = [
  // Math.* — самая частая привычка. Все эти функции у нас есть без префикса.
  { pattern: /\bMath\.(round|floor|ceil|abs|min|max|sqrt|pow)\s*\(/g, replace: '$1(', note: 'Math.*' },
  { pattern: /\bMath\.PI\b/g, replace: '3.141592653589793', note: 'Math.PI' },

  // Доступ через объект состояния: state.bill, this.bill, values.bill.
  { pattern: /\b(?:state|values|data|this)\.([A-Za-z_][A-Za-z0-9_]*)/g, replace: '$1', note: 'state.*' },

  // Длина через свойство вместо функции.
  { pattern: /\b([A-Za-z_][A-Za-z0-9_]*)\.length\b/g, replace: 'len($1)', note: '.length' },

  // Опциональная цепочка и нулевое слияние: у нас отсутствующий ключ и так null.
  { pattern: /\?\./g, replace: '.', note: '?.' },
  { pattern: /\?\?/g, replace: '||', note: '??' },

  // Строгие сравнения.
  { pattern: /===/g, replace: '==', note: '===' },
  { pattern: /!==/g, replace: '!=', note: '!==' },

  // Числовые разделители и приведение типов.
  { pattern: /\b(\d)_(\d)/g, replace: '$1$2', note: 'числовой разделитель' },
  { pattern: /\bNumber\s*\(/g, replace: '(', note: 'Number()' },
  { pattern: /\bparseInt\s*\(/g, replace: 'floor(', note: 'parseInt()' },
  { pattern: /\bparseFloat\s*\(/g, replace: '(', note: 'parseFloat()' },

  // Даты: Date.now() у нас nowMs, new Date() в выражениях бессмысленно.
  { pattern: /\bDate\.now\s*\(\s*\)/g, replace: 'nowMs', note: 'Date.now()' },

  // Псевдонимы функций, которые модель придумывает по аналогии.
  { pattern: /\bclamp\s*\(\s*([^,]+),\s*([^,]+),\s*([^)]+)\)/g, replace: 'clamp($1, $2, $3)', note: '' },
  { pattern: /\btoFixed\s*\(/g, replace: 'round(', note: 'toFixed()' },
];

export interface AutofixResult {
  spec: MiniAppSpec;
  /** Что именно чинили — попадает в метрику, чтобы видеть частые привычки. */
  applied: string[];
}

function fixExpression(source: string, applied: Set<string>): string {
  let result = source;
  for (const rule of RULES) {
    const before = result;
    result = result.replace(rule.pattern, rule.replace as string);
    if (result !== before && rule.note) applied.add(rule.note);
  }
  return result;
}

/** Шаблоны чинятся внутри {{...}}: снаружи это обычный текст подписи. */
function fixTemplate(source: string, applied: Set<string>): string {
  if (!source.includes('{{')) return source;
  return source.replace(/\{\{([^}]+)\}\}/g, (_, body: string) => `{{${fixExpression(body, applied)}}}`);
}

/** Свойства, значение которых — выражение целиком, а не шаблон. */
const EXPRESSION_PROPS = new Set([
  'visible', 'disabled', 'progress', 'values', 'when', 'dates', 'source',
]);

function fixNode(node: UiNode, applied: Set<string>): UiNode {
  const result: Record<string, unknown> = { ...node };

  for (const [key, value] of Object.entries(node)) {
    if (key === 'children' || key === 'onPress' || key === 'html') continue;

    if (typeof value === 'string') {
      result[key] = EXPRESSION_PROPS.has(key)
        ? fixExpression(value, applied)
        : fixTemplate(value, applied);
    }
  }

  if (Array.isArray(node.onPress)) {
    result.onPress = (node.onPress as unknown as Record<string, unknown>[]).map((step) => {
      const fixed: Record<string, unknown> = { ...step };
      for (const [key, value] of Object.entries(step)) {
        if (key === 'action' || typeof value !== 'string') continue;
        fixed[key] = key === 'when' ? fixExpression(value, applied) : fixTemplate(value, applied);
      }
      // values у records.add — вложенный объект с шаблонами.
      if (step.values && typeof step.values === 'object') {
        const values: Record<string, unknown> = {};
        for (const [key, raw] of Object.entries(step.values as Record<string, unknown>)) {
          values[key] = typeof raw === 'string' ? fixTemplate(raw, applied) : raw;
        }
        fixed.values = values;
      }
      return fixed;
    });
  }

  if (Array.isArray(node.children)) {
    result.children = node.children.map((child) => fixNode(child, applied));
  }

  // Вкладки: у каждой свой набор узлов, и их тоже надо чинить.
  if (Array.isArray(node.tabs)) {
    result.tabs = (node.tabs as unknown as Record<string, unknown>[]).map((tab) => ({
      ...tab,
      children: Array.isArray(tab.children)
        ? (tab.children as UiNode[]).map((child) => fixNode(child, applied))
        : tab.children,
    }));
  }

  // marks у календаря: каждое множество содержит выражение в dates.
  if (Array.isArray(node.marks)) {
    result.marks = (node.marks as unknown as Record<string, unknown>[]).map((set) => ({
      ...set,
      dates: typeof set.dates === 'string' ? fixExpression(set.dates, applied) : set.dates,
    }));
  }

  return result as unknown as UiNode;
}

export function autofix(spec: MiniAppSpec): AutofixResult {
  const applied = new Set<string>();

  const derived: Record<string, string> = {};
  for (const [key, expression] of Object.entries(spec.derived ?? {})) {
    derived[key] = fixExpression(expression, applied);
  }

  return {
    spec: {
      ...spec,
      ...(spec.derived ? { derived } : {}),
      ui: fixNode(spec.ui, applied),
    },
    applied: [...applied],
  };
}
