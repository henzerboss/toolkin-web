import { ExpressionEvaluator } from '@/lib/expression';
import { childrenOf, type JsonValue, type MiniAppSpec, type UiNode } from '@/lib/specTypes';

/**
 * Пробный прогон спеки на сервере.
 *
 * Валидатор проверяет форму: компонент существует, bind объявлен, право
 * заявлено. Этого мало — прогон качества показал утилиты, прошедшие валидацию
 * и при этом неработающие. Форма может быть безупречной, а на экране NaN,
 * пустой результат или кнопка, которая ничего не меняет.
 *
 * Здесь спека исполняется по-настоящему: считаются derived, разворачиваются
 * шаблоны, нажимаются все кнопки, проверяется, что состояние изменилось и
 * что на экран попадают числа, а не «undefined». Найденное уходит в цикл
 * починки такими же инструктивными фразами, как и ошибки валидатора.
 *
 * Это не полноценный рантайм — здесь нет React, устройства и сети. Задача
 * скромнее: поймать то, что сломается у пользователя на первом же касании.
 */

interface Issue {
  path: string;
  message: string;
}

const BUILTINS: Record<string, JsonValue> = {
  nowMs: Date.now(),
  recordCount: 0,
  recordValues: [],
  timerRunning: false,
  timerElapsed: 0,
  timerRemaining: 0,
  timerFinished: false,
  llmBusy: false,
  llmError: null,
};

/** Значения-заглушки для полей, которые пользователь заполнит сам. */
function seedState(spec: MiniAppSpec): Record<string, JsonValue> {
  const state: Record<string, JsonValue> = { ...spec.state };

  // Нули заменяем на единицу: половина утилит делит на введённое значение,
  // и проверка на нулевом состоянии показала бы деление на ноль везде,
  // хотя у пользователя такого не будет.
  for (const [key, value] of Object.entries(state)) {
    if (typeof value === 'number' && value === 0) state[key] = 1;
  }
  return state;
}

class Simulator {
  private state: Record<string, JsonValue>;
  private records: Record<string, JsonValue>[] = [];
  readonly issues: Issue[] = [];

  constructor(
    private readonly spec: MiniAppSpec,
    private readonly evaluator: ExpressionEvaluator,
    /**
     * 'fresh' — состояние ровно как при первом открытии, 'filled' — с
     * подставленными значениями. Первый режим ловит NaN и пустые результаты
     * на стартовом экране, второй — ошибки в формулах, которые проявляются
     * только когда пользователь что-то ввёл.
     */
    mode: 'fresh' | 'filled' = 'filled',
  ) {
    this.state = mode === 'fresh' ? { ...spec.state } : seedState(spec);
  }

  get scope(): Record<string, JsonValue> {
    const scope: Record<string, JsonValue> = {
      ...this.state,
      ...BUILTINS,
      recordCount: this.records.length,
      recordValues: this.recordValues(),
    };

    for (const [key, expression] of Object.entries(this.spec.derived ?? {})) {
      try {
        scope[key] = this.evaluator.evaluate(expression, scope);
      } catch (error) {
        this.issues.push({
          path: `derived.${key}`,
          message: `expression fails at runtime: ${error instanceof Error ? error.message : String(error)}`,
        });
        scope[key] = null;
      }
    }

    return scope;
  }

  private recordValues(): number[] {
    const field = this.spec.records?.valueField;
    if (!field) return [];
    return this.records.map((record) => Number(record[field] ?? 0));
  }

  /** Проверяет, что все derived дают осмысленные значения. */
  checkDerived(): void {
    const scope = this.scope;

    for (const key of Object.keys(this.spec.derived ?? {})) {
      const value = scope[key];

      if (typeof value === 'number' && !Number.isFinite(value)) {
        this.issues.push({
          path: `derived.${key}`,
          message:
            'evaluates to NaN or Infinity with normal input. Guard the divisor with max(x, 1) ' +
            'or check the formula',
        });
      }
    }
  }

  /** Разворачивает шаблон и жалуется, если на экран попадёт мусор. */
  checkTemplate(source: string, path: string): void {
    if (!source.includes('{{')) return;

    for (const match of source.matchAll(/\{\{([^}]+)\}\}/g)) {
      const body = match[1];
      const filtered = body.match(/^(.*[^|])\|\s*([A-Za-z]+)\s*$/);
      const expression = (filtered ? filtered[1] : body).trim();
      const filter = filtered?.[2];

      let value: JsonValue;
      try {
        value = this.evaluator.evaluate(expression, this.scope);
      } catch (error) {
        this.issues.push({
          path,
          message: `template {{${expression}}} fails: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      if (typeof value === 'number' && !Number.isFinite(value)) {
        this.issues.push({ path, message: `template {{${expression}}} shows NaN on screen` });
      }

      // Число без фильтра выводится как 880.0000000000001 — это самая
      // заметная для пользователя неряшливость и её видно только прогоном.
      if (typeof value === 'number' && !filter && !Number.isInteger(value)) {
        this.issues.push({
          path,
          message:
            `template {{${expression}}} prints a fractional number without a filter. ` +
            'Add | number, | money or | integer',
        });
      }
    }
  }

  /** Выполняет шаги кнопки и проверяет, что что-то изменилось. */
  pressButton(node: UiNode, path: string): void {
    if (!Array.isArray(node.onPress)) return;

    if (node.onPress.length === 0) {
      this.issues.push({ path, message: 'button has an empty onPress and does nothing when tapped' });
      return;
    }

    const before = JSON.stringify(this.state);
    const recordsBefore = this.records.length;
    let touchesDevice = false;

    for (const raw of node.onPress as unknown as Record<string, JsonValue>[]) {
      const action = String(raw.action ?? '');

      if (raw.when !== undefined && typeof raw.when === 'string') {
        try {
          this.evaluator.evaluate(raw.when, this.scope);
        } catch (error) {
          this.issues.push({
            path: `${path}.when`,
            message: `condition fails: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      const resolve = (value: JsonValue | undefined): JsonValue => {
        if (typeof value !== 'string') return value ?? null;
        const single = value.match(/^\{\{([^}|]+)\}\}$/);
        if (!single) return value;
        try {
          return this.evaluator.evaluate(single[1].trim(), this.scope);
        } catch {
          return null;
        }
      };

      switch (action) {
        case 'state.set':
          if (typeof raw.key === 'string') this.state[raw.key] = resolve(raw.value);
          break;
        case 'state.inc': {
          const key = String(raw.key ?? '');
          const delta = raw.by === undefined ? 1 : Number(resolve(raw.by));
          this.state[key] = Number(this.state[key] ?? 0) + delta;
          break;
        }
        case 'state.toggle':
          if (typeof raw.key === 'string') this.state[raw.key] = !this.state[raw.key];
          break;
        case 'state.random':
          if (typeof raw.key === 'string') this.state[raw.key] = raw.chars ? 'sample' : 1;
          break;
        case 'records.add': {
          const values: Record<string, JsonValue> = {};
          for (const [key, source] of Object.entries((raw.values ?? {}) as Record<string, JsonValue>)) {
            const value = resolve(source);
            values[key] = value;

            // Число, пришедшее строкой — та самая причина нулей в истории.
            const field = this.spec.records?.fields.find((item) => item.key === key);
            if (field?.kind === 'number' && typeof value === 'string' && Number.isNaN(Number(value))) {
              this.issues.push({
                path: `${path}.records.add`,
                message: `"${key}" is a number field but receives non-numeric text — the history will show 0`,
              });
            }
          }
          this.records.push(values);
          break;
        }
        case 'records.clear':
          this.records = [];
          break;
        default:
          // Экшены устройства здесь не выполняются, но их наличие означает,
          // что кнопка делает работу и без изменения состояния.
          touchesDevice = true;
      }
    }

    const changed = JSON.stringify(this.state) !== before || this.records.length !== recordsBefore;
    if (!changed && !touchesDevice) {
      this.issues.push({
        path,
        message: 'pressing this button changes nothing — the utility will feel broken',
      });
    }
  }
}

function walk(node: UiNode, path: string, visit: (node: UiNode, path: string) => void): void {
  visit(node, path);
  childrenOf(node).forEach((child, index) => walk(child, `${path}.children[${index}]`, visit));
}

export interface SmokeResult {
  ok: boolean;
  issues: string[];
}

/**
 * Прогоняет спеку и возвращает проблемы в том же виде, что и валидатор:
 * человекочитаемыми инструкциями, готовыми уйти в цикл починки.
 */
export function smokeTest(spec: MiniAppSpec): SmokeResult {
  const evaluator = new ExpressionEvaluator();

  // Первый экран проверяется отдельно: утилита, показывающая NaN до того,
  // как пользователь что-то ввёл, выглядит сломанной сразу при открытии —
  // и именно это чаще всего видит человек.
  const fresh = new Simulator(spec, evaluator, 'fresh');
  fresh.checkDerived();
  walk(spec.ui, 'ui', (node, path) => {
    for (const key of ['value', 'label', 'hint']) {
      const raw = node[key];
      if (typeof raw === 'string') fresh.checkTemplate(raw, `${path}.${key} (on first open)`);
    }
  });

  const simulator = new Simulator(spec, evaluator);
  simulator.checkDerived();

  walk(spec.ui, 'ui', (node, path) => {
    // Тексты, которые увидит пользователь.
    for (const key of ['value', 'label', 'title', 'hint', 'readout', 'empty', 'placeholder']) {
      const raw = node[key];
      if (typeof raw === 'string') simulator.checkTemplate(raw, `${path}.${key}`);
    }

    // Выражения-условия.
    for (const key of ['visible', 'disabled', 'progress', 'values']) {
      const raw = node[key];
      if (typeof raw !== 'string') continue;
      try {
        evaluator.compile(raw);
      } catch (error) {
        simulator.issues.push({
          path: `${path}.${key}`,
          message: `expression fails: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    if (node.type === 'Button') simulator.pressButton(node, path);
  });

  // Утилита без единого показанного результата бесполезна, даже если валидна.
  const serialized = JSON.stringify(spec.ui);
  const hasSandbox = serialized.includes('"Sandbox"');
  if (!hasSandbox && !/\{\{/.test(serialized)) {
    simulator.issues.push({
      path: 'ui',
      message: 'nothing on the screen shows a computed value — the utility displays only static text',
    });
  }

  // Дубликаты между двумя прогонами схлопываем: одна и та же формула
  // ломается в обоих режимах, а модели важно разнообразие причин.
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const issue of [...fresh.issues, ...simulator.issues]) {
    const line = `${issue.path}: ${issue.message}`;
    const key = issue.message.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(line);
    if (issues.length >= 12) break;
  }

  return { ok: issues.length === 0, issues };
}
