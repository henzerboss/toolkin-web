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
  'camera', 'scanner', 'sensors', 'location', 'files', 'network', 'llm',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const COMPONENTS: ComponentDef[] = [
  { type: 'Screen', description: 'корневой контейнер с вертикальным скроллом', container: true },
  { type: 'Row', description: 'горизонтальный ряд; align: start | center | between', container: true },
  { type: 'Text', description: 'текст; value, variant: title | body | caption', required: ['value'] },
  { type: 'Stat', description: 'крупный результат — ровно один на экран; label, value, hint', required: ['label', 'value'] },
  { type: 'ProgressRing', description: 'кольцо прогресса; progress (0..1), value — надпись в центре, label', required: ['progress', 'value'] },
  { type: 'Chart', description: 'столбики по записям; values — выражение, дающее список чисел', required: ['values'] },
  { type: 'NumberField', description: 'ввод числа; bind, label, placeholder', binds: true },
  { type: 'TextField', description: 'ввод текста; bind, label, multiline', binds: true },
  { type: 'Slider', description: 'слайдер; bind, label, min, max, step, readout', binds: true },
  { type: 'Stepper', description: 'счётчик кнопками ±; bind, label, min, max, step', binds: true },
  { type: 'Toggle', description: 'переключатель; bind, label', binds: true },
  { type: 'Select', description: 'сегментированный выбор; bind, label, options: [{value,label}]', binds: true, required: ['options'] },
  { type: 'Button', description: 'кнопка; title, variant: primary | secondary, onPress — массив экшенов', required: ['title'] },
  { type: 'List', description: 'история записей; valueKey, suffix, limit, empty', required: [] },
];

export const ACTIONS: ActionDef[] = [
  { name: 'state.set', description: 'записать значение', requires: null, params: ['key', 'value'] },
  { name: 'state.inc', description: 'прибавить к числу', requires: null, params: ['key', 'by', 'min', 'max'] },
  { name: 'state.toggle', description: 'инвертировать булево', requires: null, params: ['key'] },
  { name: 'state.reset', description: 'вернуть начальное состояние', requires: null, params: [] },
  { name: 'records.add', description: 'добавить запись в историю', requires: null, params: ['values'] },
  { name: 'records.remove', description: 'удалить запись', requires: null, params: ['id'] },
  { name: 'records.clear', description: 'очистить историю', requires: null, params: [] },
  { name: 'timer.start', description: 'запустить обратный отсчёт', requires: null, params: ['seconds'] },
  { name: 'timer.pause', description: 'поставить на паузу', requires: null, params: [] },
  { name: 'timer.reset', description: 'сбросить таймер', requires: null, params: [] },
  { name: 'clipboard.set', description: 'скопировать в буфер', requires: 'clipboard', params: ['value'] },
  { name: 'share', description: 'системный шеринг', requires: 'share', params: ['value'] },
  { name: 'haptics', description: 'вибро-отклик; kind: light | medium | success | warning | error', requires: 'haptics', params: ['kind'] },
  { name: 'toast', description: 'короткое сообщение', requires: null, params: ['text'] },
  { name: 'notify.schedule', description: 'локальное уведомление', requires: 'notifications', params: ['title', 'body', 'afterSeconds'] },
  { name: 'llm.ask', description: 'запрос к модели, тратит кредиты; результат кладётся в into', requires: 'llm', params: ['prompt', 'into', 'imageUri'] },
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
  'recordCount', 'recordValues',
  'timerRunning', 'timerElapsed', 'timerRemaining', 'timerFinished',
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
    const cap = a.requires ? ` [требует capability "${a.requires}"]` : '';
    return `- ${a.name}${params}: ${a.description}${cap}`;
  }).join('\n');
}
