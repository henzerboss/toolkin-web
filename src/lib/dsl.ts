/**
 * Манифест DSL мини-приложений.
 *
 * Один и тот же файл лежит в приложении (src/domain/spec/dsl.ts) и здесь.
 * Из него собирается описание для системного промпта и по нему же валидируется
 * ответ модели — так промпт не может пообещать компонент, которого нет в рантайме.
 *
 * Приложение при старте проверяет, что каждый компонент отсюда зарегистрирован
 * в ComponentRegistry, поэтому расхождение выявляется на первом же запуске,
 * а не на спеке, которую уже увидел пользователь.
 */

export interface ComponentDef {
  type: string;
  description: string;
  /** Обязательные свойства узла. */
  required?: string[];
  /** Привязка к ключу state. */
  binds?: boolean;
  container?: boolean;
}

export interface ActionDef {
  name: string;
  description: string;
  requires: Capability | null;
  params: string[];
}

export const CAPABILITIES = [
  'clipboard', 'haptics', 'share', 'notifications',
  'camera', 'scanner', 'sensors', 'location', 'files', 'network', 'llm', 'image',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const COMPONENTS: ComponentDef[] = [
  { type: 'Screen', description: 'root container with vertical scroll', container: true },
  { type: 'Row', description: 'horizontal row; align: start | center | between', container: true },
  { type: 'Text', description: 'text; value, variant: title | body | caption', required: ['value'] },
  { type: 'Stat', description: 'the main result — exactly one per screen; label, value, hint', required: ['label', 'value'] },
  { type: 'ProgressRing', description: 'progress ring; progress (0..1), value is the label inside, label', required: ['progress', 'value'] },
  { type: 'Chart', description: 'bars over record history; values is an expression returning a list of numbers', required: ['values'] },
  { type: 'NumberField', description: 'number input; bind, label, placeholder', binds: true },
  { type: 'TextField', description: 'text input; bind, label, multiline', binds: true },
  { type: 'Slider', description: 'slider; bind, label, min, max, step, readout', binds: true },
  { type: 'Stepper', description: 'counter with ± buttons; bind, label, min, max, step', binds: true },
  { type: 'Toggle', description: 'switch; bind, label', binds: true },
  { type: 'Select', description: 'segmented choice; bind, label, options: [{value,label}]', binds: true, required: ['options'] },
  { type: 'Button', description: 'button; title, variant: primary | secondary, onPress is a list of actions', required: ['title'] },
  { type: 'Image', description: 'picture from a state field (photo or generated); source is the key name, ratio: square | portrait | landscape', required: ['source'] },
  { type: 'Gallery', description: 'grid of photos from record history; imageKey is the record field with the file path, columns 2–4', required: [] },
  { type: 'LineChart', description: 'line over recent entries; values is an expression returning a list of numbers (usually recordValues)', required: ['values'] },
  { type: 'PieChart', description: 'donut chart by category; groupBy is the record field to group by, valueKey is what to sum', required: ['groupBy'] },
  { type: 'Calendar', description: 'month grid; bind holds the selected date (timestamp), dateKey is the record field to mark', binds: true },
  { type: 'DateField', description: 'date or time picker; bind holds a timestamp in ms, mode: date | time', binds: true },
  { type: 'Table', description: 'table over record history; columns: [{key,label}] — one per records field', required: ['columns'] },
  { type: 'List', description: 'record history; valueKey is the record field, imageKey adds a thumbnail, suffix, limit', required: [] },
];

export const ACTIONS: ActionDef[] = [
  { name: 'state.set', description: 'write a value', requires: null, params: ['key', 'value'] },
  { name: 'state.inc', description: 'add to a number', requires: null, params: ['key', 'by', 'min', 'max'] },
  { name: 'state.toggle', description: 'invert a boolean', requires: null, params: ['key'] },
  { name: 'state.random', description: 'random number (min, max) or string (chars, length) — the only source of randomness', requires: null, params: ['key', 'min', 'max', 'integer', 'chars', 'length'] },
  { name: 'state.reset', description: 'restore the initial state', requires: null, params: [] },
  { name: 'records.add', description: 'append an entry to history', requires: null, params: ['values'] },
  { name: 'records.remove', description: 'delete an entry', requires: null, params: ['id'] },
  { name: 'records.clear', description: 'wipe the history', requires: null, params: [] },
  { name: 'timer.start', description: 'start the countdown; seconds is required', requires: null, params: ['seconds'] },
  { name: 'timer.pause', description: 'pause it', requires: null, params: [] },
  { name: 'timer.reset', description: 'reset the timer', requires: null, params: [] },
  { name: 'clipboard.set', description: 'copy to clipboard', requires: 'clipboard', params: ['value'] },
  { name: 'share', description: 'system share sheet', requires: 'share', params: ['value'] },
  { name: 'haptics', description: 'haptic feedback; kind: light | medium | success | warning | error', requires: 'haptics', params: ['kind'] },
  { name: 'toast', description: 'short message', requires: null, params: ['text'] },
  { name: 'notify.schedule', description: 'notification after N seconds', requires: 'notifications', params: ['title', 'body', 'afterSeconds'] },
  { name: 'notify.at', description: 'notification on a date (timestamp in ms); repeat: none | daily | yearly — for birthdays', requires: 'notifications', params: ['title', 'body', 'at', 'repeat'] },
  { name: 'notify.cancelAll', description: 'cancel every scheduled notification of this utility', requires: 'notifications', params: [] },
  { name: 'camera.capture', description: 'photo from camera (source: camera) or gallery (source: library); the file path goes into `into`', requires: 'camera', params: ['into', 'source'] },
  { name: 'image.generate', description: 'generate a picture from a description; the result goes into `into`; aspect: square | portrait | landscape', requires: 'image', params: ['prompt', 'into', 'aspect'] },
  { name: 'llm.ask', description: 'model request, spends credits; the answer goes into `into`; image is the state key holding a photo', requires: 'llm', params: ['prompt', 'into', 'image'] },
];

/** Функции, доступные в выражениях. Всё остальное парсер отвергает. */
export const FUNCTION_NAMES = [
  'min', 'max', 'abs', 'round', 'floor', 'ceil', 'sqrt', 'pow', 'clamp',
  'len', 'sum', 'avg', 'coalesce', 'ifElse', 'concat', 'upper', 'lower',
  'now', 'daysBetween', 'minutesOf', 'secondsOf',
];

/** Фильтры форматирования в шаблонах: {{выражение | фильтр}}. */
export const FILTER_NAMES = ['money', 'number', 'integer', 'percent', 'date', 'time', 'duration'];

/** Значения, которые рантайм подставляет в область видимости сам. */
export const BUILTIN_SCOPE = [
  'nowMs',
  'llmBusy', 'llmError',
  'recordCount', 'recordValues',
  'timerRunning', 'timerElapsed', 'timerRemaining', 'timerFinished',
];

/** Свойства, которые понимает любой узел независимо от типа. */
export const UNIVERSAL_PROPS = [
  'visible', // выражение; узел не рендерится, если ложно
];

export const ACCENT_COLORS = ['blue', 'green', 'amber', 'violet', 'rose', 'teal'] as const;

export const COMPONENT_TYPES = COMPONENTS.map((c) => c.type);
export const ACTION_NAMES = ACTIONS.map((a) => a.name);

export function describeComponents(): string {
  return COMPONENTS.map((c) => `- ${c.type}: ${c.description}`).join('\n');
}

export function describeActions(): string {
  return ACTIONS.map((a) => {
    const params = a.params.length ? ` (${a.params.join(', ')})` : '';
    const cap = a.requires ? ` [requires capability "${a.requires}"]` : '';
    return `- ${a.name}${params}: ${a.description}${cap}`;
  }).join('\n');
}
