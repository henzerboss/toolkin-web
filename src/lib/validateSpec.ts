import { z } from 'zod';
import {
  ACCENT_COLORS,
  ACTION_NAMES,
  ACTIONS,
  CAPABILITIES,
  COMPONENTS,
  COMPONENT_TYPES,
} from './dsl';
import { ExpressionEvaluator, ExpressionError } from './expression';
import type { MiniAppSpec, UiNode } from './specTypes';

const jsonValue: z.ZodType = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);

const specSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(64),
  version: z.number().int().positive(),
  manifest: z.object({
    name: z.string().min(1).max(40),
    icon: z.string().min(1),
    color: z.enum(ACCENT_COLORS),
    locale: z.string().min(2),
  }),
  capabilities: z.array(z.enum(CAPABILITIES)),
  state: z.record(z.string(), jsonValue),
  persist: z.array(z.string()).optional(),
  derived: z.record(z.string(), z.string()).optional(),
  records: z
    .object({
      fields: z.array(z.object({ key: z.string(), label: z.string(), kind: z.enum(['number', 'text', 'date']) })),
      valueField: z.string().optional(),
    })
    .optional(),
  ui: z.object({ type: z.string() }).loose(),
});

const componentByType = new Map(COMPONENTS.map((c) => [c.type, c]));
const actionByName = new Map(ACTIONS.map((a) => [a.name, a]));

export type SpecValidation =
  | { ok: true; spec: MiniAppSpec }
  | { ok: false; errors: string[] };

/**
 * Ошибки формулируются так, чтобы их можно было без обработки отправить обратно
 * модели: не «invalid_type at ui.children.0», а что именно чинить и чем заменить.
 */
export function validateSpec(input: unknown): SpecValidation {
  const parsed = specSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'spec'}: ${issue.message}`),
    };
  }

  const spec = parsed.data as unknown as MiniAppSpec;
  const errors: string[] = [];
  const evaluator = new ExpressionEvaluator();

  for (const [key, expression] of Object.entries(spec.derived ?? {})) {
    try {
      evaluator.compile(expression);
    } catch (error) {
      errors.push(`derived.${key}: ${error instanceof ExpressionError ? error.message : String(error)}`);
    }
  }

  for (const key of spec.persist ?? []) {
    if (!(key in spec.state)) errors.push(`persist: поля "${key}" нет в state — добавь его в state или убери из persist`);
  }

  if (spec.records?.valueField && !spec.records.fields.some((f) => f.key === spec.records!.valueField)) {
    errors.push(`records.valueField: "${spec.records.valueField}" не описан в records.fields`);
  }

  walk(spec.ui, spec, errors, evaluator, 'ui');

  if (errors.length > 40) errors.length = 40;
  return errors.length === 0 ? { ok: true, spec } : { ok: false, errors };
}

function walk(
  node: UiNode,
  spec: MiniAppSpec,
  errors: string[],
  evaluator: ExpressionEvaluator,
  path: string,
): void {
  const def = componentByType.get(node.type);
  if (!def) {
    errors.push(`${path}: компонента "${node.type}" не существует. Доступны: ${COMPONENT_TYPES.join(', ')}`);
    return;
  }

  for (const prop of def.required ?? []) {
    if (node[prop] === undefined) errors.push(`${path} (${node.type}): обязательное свойство "${prop}" отсутствует`);
  }

  if (def.binds) {
    if (typeof node.bind !== 'string') {
      errors.push(`${path} (${node.type}): нужен bind — имя ключа из state`);
    } else if (!(node.bind in spec.state)) {
      errors.push(
        `${path} (${node.type}): bind="${node.bind}" не объявлен в state. ` +
          `Есть: ${Object.keys(spec.state).join(', ') || '(пусто)'}`,
      );
    }
  }

  if (node.type === 'Select' && Array.isArray(node.options)) {
    const current = spec.state[String(node.bind)];
    const values = (node.options as { value?: unknown }[]).map((o) => o?.value);
    if (typeof node.bind === 'string' && !values.includes(current)) {
      errors.push(
        `${path} (Select): начальное значение state.${node.bind} = ${JSON.stringify(current)} ` +
          `не совпадает ни с одним options.value (${values.map((v) => JSON.stringify(v)).join(', ')})`,
      );
    }
  }

  if (node.onPress !== undefined) {
    if (!Array.isArray(node.onPress)) {
      errors.push(`${path} (${node.type}): onPress должен быть массивом экшенов`);
    } else {
      node.onPress.forEach((raw, index) =>
        checkStep(raw as Record<string, unknown>, spec, errors, `${path}.onPress[${index}]`),
      );
    }
  }

  checkTemplates(node, errors, evaluator, path);

  if (Array.isArray(node.children)) {
    node.children.forEach((child, index) => walk(child, spec, errors, evaluator, `${path}.children[${index}]`));
  }
}

function checkStep(step: Record<string, unknown>, spec: MiniAppSpec, errors: string[], path: string): void {
  const name = typeof step?.action === 'string' ? step.action : null;
  if (!name) {
    errors.push(`${path}: у шага нет поля action`);
    return;
  }

  const def = actionByName.get(name);
  if (!def) {
    errors.push(`${path}: экшена "${name}" не существует. Доступны: ${ACTION_NAMES.join(', ')}`);
    return;
  }

  if (def.requires && !spec.capabilities.includes(def.requires)) {
    errors.push(
      `${path}: экшен "${name}" требует capability "${def.requires}" — ` +
        `добавь её в capabilities, иначе шаг не выполнится`,
    );
  }

  if (name.startsWith('state.') && typeof step.key === 'string' && !(step.key in spec.state)) {
    errors.push(`${path}: ключа "${step.key}" нет в state`);
  }
}

const PLACEHOLDER = /\{\{([^}]+)\}\}/g;

/** Выражения внутри шаблонов проверяются тем же парсером, что и на устройстве. */
function checkTemplates(node: UiNode, errors: string[], evaluator: ExpressionEvaluator, path: string): void {
  for (const [key, raw] of Object.entries(node)) {
    if (typeof raw !== 'string' || !raw.includes('{{')) continue;

    for (const match of raw.matchAll(PLACEHOLDER)) {
      const body = match[1];
      const filtered = body.match(/^(.*[^|])\|\s*([A-Za-z]+)\s*$/);
      const expression = (filtered ? filtered[1] : body).trim();
      try {
        evaluator.compile(expression);
      } catch (error) {
        errors.push(`${path}.${key}: ${error instanceof ExpressionError ? error.message : String(error)}`);
      }
    }
  }
}
