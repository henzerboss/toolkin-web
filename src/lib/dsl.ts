/** Shared manifest for the generated-app declarative runtime. */
export interface ComponentDef {
  type: string;
  description: string;
  required?: string[];
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
  'camera', 'scanner', 'sensors', 'location', 'files', 'network', 'llm', 'image', 'sandbox',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const COMPONENTS: ComponentDef[] = [
  { type: 'Screen', description: 'screen root with adaptive vertical scroll', container: true },
  { type: 'Stack', description: 'vertical semantic group; gap: xs | sm | md | lg | xl; padding optional', container: true },
  { type: 'Row', description: 'horizontal row; align: start | center | between; wrap may be true', container: true },
  { type: 'Grid', description: 'adaptive 2–4 column grid; columns, gap', container: true },
  { type: 'Card', description: 'visual content group; title/subtitle optional', container: true },
  { type: 'Section', description: 'semantic screen section; title/subtitle optional', container: true },
  { type: 'Repeat', description: 'repeat children over an array expression; source, as, optional collection/limit/empty', required: ['source'], container: true },
  { type: 'Text', description: 'text; value, variant: title | body | caption', required: ['value'] },
  { type: 'Stat', description: 'prominent metric; label, value, hint', required: ['label', 'value'] },
  { type: 'MetricGrid', description: 'compact metric cards; items: [{label,value,hint}]', required: ['items'] },
  { type: 'ProgressRing', description: 'circular progress; progress 0..1, value, label', required: ['progress', 'value'] },
  { type: 'ProgressBar', description: 'compact progress; progress 0..1, optional label/value', required: ['progress'] },
  { type: 'Badge', description: 'compact status/category pill; value', required: ['value'] },
  { type: 'Divider', description: 'visual divider' },
  { type: 'Spacer', description: 'controlled vertical spacing; size: xs | sm | md | lg | xl' },
  { type: 'EmptyState', description: 'empty-state explanation; title, subtitle', required: ['title'] },
  { type: 'Chart', description: 'bars; values is an expression returning numbers', required: ['values'] },
  { type: 'NumberField', description: 'number input; bind, label, placeholder', binds: true },
  { type: 'TextField', description: 'text input; bind, label, multiline', binds: true },
  { type: 'Slider', description: 'slider; bind, label, min, max, step, readout', binds: true },
  { type: 'Stepper', description: 'counter with ±; bind, label, min, max, step', binds: true },
  { type: 'Toggle', description: 'switch; bind, label', binds: true },
  { type: 'Select', description: 'adaptive choice; 1–4 options segmented, larger sets wrap into a phone-safe grid; bind, label, options', binds: true, required: ['options'] },
  { type: 'Button', description: 'button; title, variant: primary | secondary, onPress actions; grow=true only inside rows when equal width is desired', required: ['title'] },
  { type: 'Image', description: 'picture from a state field; source is state-key name, ratio', required: ['source'] },
  { type: 'Sandbox', description: 'isolated self-contained HTML/JS for a capability gap such as game/canvas; no network', required: ['html'] },
  { type: 'Gallery', description: 'photo grid from a named record collection; collection/imageKey/columns', required: ['collection'] },
  { type: 'LineChart', description: 'line chart; values is an expression returning numbers', required: ['values'] },
  { type: 'PieChart', description: 'donut chart by record category; collection, groupBy, valueKey', required: ['collection', 'groupBy'] },
  { type: 'Calendar', description: 'month grid; bind selected timestamp, collection/dateKey record dots, marks computed timestamps', binds: true },
  { type: 'DateField', description: 'date/time picker; bind timestamp ms; mode date | time', binds: true },
  { type: 'Table', description: 'record table; collection, columns [{key,label}], limit', required: ['collection', 'columns'] },
  { type: 'List', description: 'record history; collection, valueKey/imageKey/suffix/limit', required: ['collection'] },
];

export const ACTIONS: ActionDef[] = [
  { name: 'state.set', description: 'write a value', requires: null, params: ['key', 'value'] },
  { name: 'state.inc', description: 'add to a number', requires: null, params: ['key', 'by', 'min', 'max'] },
  { name: 'state.toggle', description: 'invert a boolean', requires: null, params: ['key'] },
  { name: 'state.random', description: 'random number/string; only deterministic DSL randomness source', requires: null, params: ['key', 'min', 'max', 'integer', 'chars', 'length'] },
  { name: 'state.reset', description: 'restore initial state', requires: null, params: [] },
  { name: 'records.add', description: 'append record to collection', requires: null, params: ['collection', 'values'] },
  { name: 'records.update', description: 'update record by id', requires: null, params: ['id', 'collection', 'values'] },
  { name: 'records.remove', description: 'delete record by id', requires: null, params: ['id'] },
  { name: 'records.clear', description: 'clear one explicitly named collection', requires: null, params: ['collection'] },
  { name: 'timer.start', description: 'start countdown; seconds required', requires: null, params: ['seconds'] },
  { name: 'timer.pause', description: 'pause countdown', requires: null, params: [] },
  { name: 'timer.reset', description: 'reset countdown', requires: null, params: [] },
  { name: 'nav.go', description: 'navigate to generated-app screen; screen required, replace optional', requires: null, params: ['screen', 'replace'] },
  { name: 'nav.back', description: 'go back in generated-app navigation', requires: null, params: [] },
  { name: 'nav.home', description: 'return to generated-app start screen', requires: null, params: [] },
  { name: 'clipboard.set', description: 'copy to clipboard', requires: 'clipboard', params: ['value'] },
  { name: 'share', description: 'system share sheet', requires: 'share', params: ['value'] },
  { name: 'haptics', description: 'haptic feedback', requires: 'haptics', params: ['kind'] },
  { name: 'toast', description: 'short message', requires: null, params: ['text'] },
  { name: 'notify.schedule', description: 'notification after N seconds', requires: 'notifications', params: ['title', 'body', 'afterSeconds'] },
  { name: 'notify.at', description: 'notification at timestamp; repeat none | daily | yearly', requires: 'notifications', params: ['title', 'body', 'at', 'repeat'] },
  { name: 'notify.cancelAll', description: 'cancel scheduled notifications', requires: 'notifications', params: [] },
  { name: 'camera.capture', description: 'capture camera/library image into state', requires: 'camera', params: ['into', 'source'] },
  { name: 'image.generate', description: 'generate image into state', requires: 'image', params: ['prompt', 'into', 'aspect'] },
  { name: 'llm.ask', description: 'model request; either into free text or structured fields; image is a state-key name', requires: 'llm', params: ['prompt', 'into', 'fields', 'image'] },
];

export const FUNCTION_NAMES = [
  'min', 'max', 'abs', 'round', 'floor', 'ceil', 'sqrt', 'pow', 'clamp',
  'len', 'sum', 'avg', 'coalesce', 'ifElse', 'concat', 'upper', 'lower',
  'now', 'daysBetween', 'minutesOf', 'secondsOf', 'range', 'addDays', 'startOfDay',
  'valuesBy', 'sumBy', 'avgBy', 'countBy', 'sumWhere', 'countWhere', 'uniqueBy', 'latestBy',
];
export const FILTER_NAMES = ['money', 'number', 'integer', 'percent', 'date', 'time', 'duration'];
export const BUILTIN_SCOPE = [
  'nowMs', 'llmBusy', 'llmError', 'recordCount', 'records', 'currentScreen',
  'timerRunning', 'timerElapsed', 'timerRemaining', 'timerFinished',
];
export const UNIVERSAL_PROPS = ['visible', 'testId'];
export const ACCENT_COLORS = ['blue', 'green', 'amber', 'violet', 'rose', 'teal'] as const;
export const COMPONENT_TYPES = COMPONENTS.map((c) => c.type);
export const ACTION_NAMES = ACTIONS.map((a) => a.name);
export function describeComponents(): string { return COMPONENTS.map((c) => `- ${c.type}: ${c.description}`).join('\n'); }
export function describeActions(): string {
  return ACTIONS.map((a) => {
    const params = a.params.length ? ` (${a.params.join(', ')})` : '';
    const cap = a.requires ? ` [requires capability "${a.requires}"]` : '';
    return `- ${a.name}${params}: ${a.description}${cap}`;
  }).join('\n');
}
