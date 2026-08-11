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
      fields: z.array(z.object({ key: z.string(), label: z.string(), kind: z.enum(['number', 'text', 'date', 'image']) })),
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
    if (!(key in spec.state)) errors.push(`persist: field "${key}" is not in state — add it to state or drop it from persist`);
  }

  if (spec.records?.valueField && !spec.records.fields.some((f) => f.key === spec.records!.valueField)) {
    errors.push(`records.valueField: "${spec.records.valueField}" is not listed in records.fields`);
  }

  walk(spec.ui, spec, errors, evaluator, 'ui');
  checkWiring(spec, errors);

  if (errors.length > 40) errors.length = 40;
  return errors.length === 0 ? { ok: true, spec } : { ok: false, errors };
}

/**
 * Правила связности. Ловят класс ошибок, который валиден структурно, но даёт
 * утилиту, которая молча ничего не делает — а для пользователя это неотличимо
 * от сломанного приложения и тратит его кредиты впустую.
 *
 * Шаги собираются обходом дерева, а не регулярками по JSON: в параметрах
 * экшенов сплошь и рядом встречаются подстановки вида {{products}}, и любой
 * шаблон с фигурными скобками ломал сопоставление, из-за чего проверки
 * незаметно переставали срабатывать.
 */
type Step = Record<string, unknown>;

function collectSteps(node: UiNode, out: Step[]): void {
  if (Array.isArray(node.onPress)) {
    for (const raw of node.onPress) {
      if (raw && typeof raw === 'object') out.push(raw as Step);
    }
  }
  if (Array.isArray(node.children)) node.children.forEach((child) => collectSteps(child, out));
}

function checkWiring(spec: MiniAppSpec, errors: string[]): void {
  const steps: Step[] = [];
  collectSteps(spec.ui, steps);

  const serialized = JSON.stringify(spec.ui);
  const named = (name: string) => steps.filter((step) => step.action === name);
  const usesPrefix = (prefix: string) => steps.some((step) => String(step.action ?? '').startsWith(prefix));

  if (usesPrefix('records.') && !spec.records) {
    errors.push(
      'records: a records.* action is used but the records block is missing. ' +
        'Add records: { fields: [{key,label,kind}], valueField: "key" } — ' +
        'otherwise entries are not saved and recordValues stays empty',
    );
  }
  if (spec.records && !spec.records.valueField) {
    errors.push('records.valueField: missing — recordValues stays empty and charts and sum() return zero');
  }

  for (const step of named('timer.start')) {
    if (step.seconds === undefined) {
      errors.push('timer.start: seconds is missing — the countdown becomes a stopwatch and shows 00:00');
    }
  }

  if (usesPrefix('timer.') && !/timerRemaining|timerElapsed|timerRunning|timerFinished/.test(serialized)) {
    errors.push(
      'timer: the timer starts but no block shows timerRemaining, timerElapsed, ' +
        'timerRunning or timerFinished — the countdown stays invisible',
    );
  }

  // random() в выражениях нет намеренно: пересчёт derived менял бы результат
  // на каждый рендер. Подсказываем это прямо, иначе модель будет пробовать снова.
  if (/\brandom\s*\(/.test(serialized + JSON.stringify(spec.derived ?? {}))) {
    errors.push('expressions: there is no random() function. Use the state.random action');
  }

  for (const step of named('state.random')) {
    const key = typeof step.key === 'string' ? step.key : null;
    if (key && !(key in spec.state)) errors.push(`state.random: key "${key}" is not in state`);
  }

  checkAiWiring(spec, steps, serialized, errors);
  checkSandbox(spec, errors);
}

/**
 * Песочница исполняет сгенерированный код, поэтому проверяется строже прочего.
 * Внешние скрипты и сетевые вызовы запрещены не из перестраховки: WebView
 * отрезан от сети, такой код просто не заработает, а пользователь увидит
 * пустой прямоугольник вместо игры и не поймёт почему.
 */
function checkSandbox(spec: MiniAppSpec, errors: string[]): void {
  const sandboxes: string[] = [];
  const walkNode = (node: UiNode): void => {
    if (node.type === 'Sandbox' && typeof node.html === 'string') sandboxes.push(node.html);
    if (Array.isArray(node.children)) node.children.forEach(walkNode);
  };
  walkNode(spec.ui);

  if (sandboxes.length > 0 && !spec.capabilities.includes('sandbox')) {
    errors.push('Sandbox: the "sandbox" capability is missing from capabilities');
  }

  for (const html of sandboxes) {
    if (/<script[^>]+src=/i.test(html)) {
      errors.push('Sandbox: external scripts are not loadable — the sandbox has no network. Inline all code');
    }
    if (/\b(fetch|XMLHttpRequest|WebSocket|importScripts)\s*\(/.test(html)) {
      errors.push('Sandbox: network calls do not work inside the sandbox. Remove fetch/XMLHttpRequest/WebSocket');
    }
    if (/https?:\/\//.test(html.replace(/https?:\/\/www\.w3\.org[^"']*/g, ''))) {
      errors.push('Sandbox: external links do not load. Draw with canvas or CSS instead of remote assets');
    }
    if (html.length > 60_000) {
      errors.push('Sandbox: html is too large (limit 60000 characters). Simplify the game');
    }
    if (!/onclick|addEventListener|touchstart/i.test(html)) {
      errors.push('Sandbox: no input handlers found — the game will not react to touch');
    }
  }
}

/**
 * Связки AI-утилит. Отдельно, потому что ошибка здесь не просто ломает утилиту:
 * она тратит кредиты пользователя на вызов, результат которого некуда положить
 * или нечего показать.
 */
function checkAiWiring(spec: MiniAppSpec, steps: Step[], serialized: string, errors: string[]): void {
  const asks = steps.filter((step) => step.action === 'llm.ask');
  const captures = steps.filter((step) => step.action === 'camera.capture');
  const images = steps.filter((step) => step.action === 'image.generate');

  for (const step of images) {
    const into = typeof step.into === 'string' ? step.into : null;
    if (!into) {
      errors.push('image.generate: into is missing — there is nowhere to put the picture and credits are wasted');
    } else if (!(into in spec.state)) {
      errors.push(`image.generate: into="${into}" is not declared in state`);
    } else if (!new RegExp(`"source"\\s*:\\s*"${into}"`).test(serialized)) {
      errors.push(
        `image.generate: the result goes into "${into}" but nothing displays it. ` +
          `Add { "type": "Image", "source": "${into}" }`,
      );
    }
    if (step.prompt === undefined) errors.push('image.generate: prompt is missing');
  }

  if (images.length > 0 && !/llmBusy/.test(serialized)) {
    errors.push(
      'image.generate: llmBusy is never used. Disable the button with "disabled": "llmBusy", ' +
        'otherwise people tap twice and pay twice',
    );
  }

  for (const step of asks) {
    const into = typeof step.into === 'string' ? step.into : null;
    if (!into) {
      errors.push('llm.ask: into is missing — there is nowhere to put the answer and credits are wasted');
    } else if (!(into in spec.state)) {
      errors.push(`llm.ask: into="${into}" is not declared in state`);
    } else if (!serialized.includes(`{{${into}`)) {
      errors.push(
        `llm.ask: the answer goes into "${into}" but no block displays it. ` +
          `Add { "type": "Text", "value": "{{${into}}}", "visible": "${into} != ''" }`,
      );
    }

    if (step.image !== undefined) {
      const key = String(step.image).replace(/[{}\s]/g, '');
      if (!(key in spec.state)) errors.push(`llm.ask: image="${String(step.image)}" is not declared in state`);
      if (captures.length === 0) {
        errors.push('llm.ask: image is set but nothing takes the photo — add a camera.capture action');
      }
    }
  }

  for (const step of captures) {
    const into = typeof step.into === 'string' ? step.into : null;
    if (!into) errors.push('camera.capture: into is missing — there is nowhere to put the photo');
    else if (!(into in spec.state)) errors.push(`camera.capture: into="${into}" is not declared in state`);
  }

  // Ожидание ответа модели длится секунды. Без блокировки кнопки человек
  // нажмёт её повторно и заплатит дважды за один результат.
  if (asks.length > 0 && !/llmBusy/.test(serialized)) {
    errors.push(
      'llm.ask: llmBusy is never used. Disable the button with "disabled": "llmBusy" ' +
        'and show a waiting state, otherwise people tap twice and pay twice',
    );
  }
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
    errors.push(`${path}: component "${node.type}" does not exist. Available: ${COMPONENT_TYPES.join(', ')}`);
    return;
  }

  for (const prop of def.required ?? []) {
    if (node[prop] === undefined) errors.push(`${path} (${node.type}): required property "${prop}" is missing`);
  }

  if (def.binds) {
    if (typeof node.bind !== 'string') {
      errors.push(`${path} (${node.type}): bind is required — the name of a state key`);
    } else if (!(node.bind in spec.state)) {
      errors.push(
        `${path} (${node.type}): bind="${node.bind}" is not declared in state. ` +
          `Available: ${Object.keys(spec.state).join(', ') || '(none)'}`,
      );
    }
  }

  if (node.type === 'Select' && Array.isArray(node.options)) {
    const current = spec.state[String(node.bind)];
    const values = (node.options as { value?: unknown }[]).map((o) => o?.value);
    if (typeof node.bind === 'string' && !values.includes(current)) {
      errors.push(
        `${path} (Select): initial value state.${node.bind} = ${JSON.stringify(current)} ` +
          `matches none of options.value (${values.map((v) => JSON.stringify(v)).join(', ')})`,
      );
    }
  }

  if (node.onPress !== undefined) {
    if (!Array.isArray(node.onPress)) {
      errors.push(`${path} (${node.type}): onPress must be an array of actions`);
    } else {
      node.onPress.forEach((raw, index) =>
        checkStep(raw as Record<string, unknown>, spec, errors, `${path}.onPress[${index}]`),
      );
    }
  }

  if (typeof node.visible === 'string') {
    try {
      evaluator.compile(node.visible);
    } catch (error) {
      errors.push(`${path}.visible: ${error instanceof ExpressionError ? error.message : String(error)}`);
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
    errors.push(`${path}: the step has no action field`);
    return;
  }

  const def = actionByName.get(name);
  if (!def) {
    errors.push(`${path}: action "${name}" does not exist. Available: ${ACTION_NAMES.join(', ')}`);
    return;
  }

  if (def.requires && !spec.capabilities.includes(def.requires)) {
    errors.push(
      `${path}: action "${name}" requires capability "${def.requires}" — ` +
        `add it to capabilities or the step will not run`,
    );
  }

  if (name.startsWith('state.') && typeof step.key === 'string' && !(step.key in spec.state)) {
    errors.push(`${path}: key "${step.key}" is not in state`);
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
