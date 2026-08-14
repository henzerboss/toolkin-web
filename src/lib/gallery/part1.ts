import type { MiniAppSpec } from '../specTypes';

/**
 * Часть 1: калькуляторы и таймеры — самые массовые категории мелких утилит.
 */

export const tipCalculator: MiniAppSpec = {
  schemaVersion: 1, id: 'tip-split', version: 1,
  manifest: { name: 'Чаевые и счёт', icon: 'receipt', color: 'blue', locale: 'ru' },
  capabilities: ['clipboard', 'haptics', 'share'],
  state: { bill: 0, tipPct: 10, people: 2 },
  persist: ['tipPct'],
  derived: {
    tip: 'bill * tipPct / 100',
    total: 'bill + tip',
    perPerson: 'total / max(people, 1)',
  },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'С человека', value: '{{perPerson | money}}', hint: 'Всего {{total | money}}' },
    { type: 'NumberField', label: 'Сумма счёта', bind: 'bill', placeholder: '0' },
    { type: 'Slider', label: 'Чаевые', bind: 'tipPct', min: 0, max: 30, step: 1,
      readout: '{{tipPct}}% · {{tip | money}}' },
    { type: 'Stepper', label: 'Человек', bind: 'people', min: 1, max: 30 },
    { type: 'Row', children: [
      { type: 'Button', title: 'Копировать', onPress: [
        { action: 'clipboard.set', value: '{{perPerson | money}}' },
        { action: 'haptics', kind: 'success' },
        { action: 'toast', text: 'Скопировано' },
      ] },
      { type: 'Button', title: 'Поделиться', onPress: [
        { action: 'share', value: 'С каждого по {{perPerson | money}}' },
      ] },
    ] },
  ] },
};

export const pomodoro: MiniAppSpec = {
  schemaVersion: 1, id: 'pomodoro', version: 1,
  manifest: { name: 'Помодоро', icon: 'clock', color: 'rose', locale: 'ru' },
  capabilities: ['haptics', 'notifications'],
  state: { minutes: 25, mode: 'work' },
  persist: ['minutes'],
  records: { fields: [{ key: 'minutes', label: 'Минут', kind: 'number' }], valueField: 'minutes' },
  derived: {
    totalSeconds: "mode == 'work' ? minutes * 60 : 300",
    progress: 'totalSeconds > 0 ? clamp(timerElapsed / totalSeconds, 0, 1) : 0',
    focusedToday: 'sum(recordValues)',
  },
  ui: { type: 'Screen', children: [
    { type: 'ProgressRing', progress: 'progress',
      value: '{{timerRunning || timerFinished ? timerRemaining : totalSeconds | duration}}',
      label: '{{timerFinished ? "Готово" : timerRunning ? "Идёт" : "Нажмите старт"}}' },
    { type: 'Select', label: 'Режим', bind: 'mode', options: [
      { value: 'work', label: 'Работа' }, { value: 'break', label: 'Перерыв' },
    ] },
    { type: 'Slider', label: 'Длительность', bind: 'minutes', min: 5, max: 60, step: 5,
      readout: '{{minutes}} мин' },
    { type: 'Row', children: [
      { type: 'Button', title: '{{timerRunning ? "Пауза" : "Старт"}}', variant: 'primary', onPress: [
        { action: 'timer.start', seconds: '{{totalSeconds}}', when: '!timerRunning' },
        { action: 'timer.pause', when: 'timerRunning' },
        { action: 'haptics', kind: 'medium' },
      ] },
      { type: 'Button', title: 'Готово', onPress: [
        { action: 'records.add', values: { minutes: '{{minutes}}' } },
        { action: 'timer.reset' },
        { action: 'haptics', kind: 'success' },
      ] },
    ] },
    { type: 'KeyValue', label: 'Сегодня в фокусе', value: '{{focusedToday | integer}} мин' },
  ] },
};

export const eggTimer: MiniAppSpec = {
  schemaVersion: 1, id: 'egg-timer', version: 1,
  manifest: { name: 'Таймер для яиц', icon: 'egg', color: 'amber', locale: 'ru' },
  capabilities: ['haptics', 'notifications'],
  state: { doneness: 'medium', fromFridge: false },
  persist: ['doneness', 'fromFridge'],
  derived: {
    baseSeconds: "doneness == 'soft' ? 240 : doneness == 'medium' ? 390 : 540",
    totalSeconds: 'baseSeconds + (fromFridge ? 45 : 0)',
    progress: 'totalSeconds > 0 ? clamp(timerElapsed / totalSeconds, 0, 1) : 0',
  },
  ui: { type: 'Screen', children: [
    { type: 'ProgressRing', progress: 'progress',
      value: '{{timerRunning || timerFinished ? timerRemaining : totalSeconds | duration}}',
      label: '{{timerFinished ? "Готово" : timerRunning ? "Варится" : "Нажмите старт"}}' },
    { type: 'Select', label: 'Готовность', bind: 'doneness', options: [
      { value: 'soft', label: 'Всмятку' },
      { value: 'medium', label: 'В мешочек' },
      { value: 'hard', label: 'Вкрутую' },
    ] },
    { type: 'Toggle', label: 'Яйца из холодильника', bind: 'fromFridge' },
    { type: 'Row', children: [
      { type: 'Button', title: '{{timerRunning ? "Пауза" : "Старт"}}', variant: 'primary', onPress: [
        { action: 'timer.start', seconds: '{{totalSeconds}}', when: '!timerRunning' },
        { action: 'timer.pause', when: 'timerRunning' },
        { action: 'notify.schedule', title: 'Яйца готовы', body: 'Снимайте с плиты',
          afterSeconds: '{{totalSeconds - timerElapsed}}', when: '!timerRunning' },
        { action: 'haptics', kind: 'medium' },
      ] },
      { type: 'Button', title: 'Сброс', onPress: [{ action: 'timer.reset' }] },
    ] },
  ] },
};

export const unitConverter: MiniAppSpec = {
  schemaVersion: 1, id: 'unit-converter', version: 1,
  manifest: { name: 'Конвертер величин', icon: 'ruler', color: 'teal', locale: 'ru' },
  capabilities: ['clipboard'],
  state: { value: 1, kind: 'length' },
  persist: ['kind'],
  derived: {
    converted: "kind == 'length' ? value / 2.54 : kind == 'weight' ? value * 2.20462 : value * 1.8 + 32",
    unitFrom: "kind == 'length' ? 'см' : kind == 'weight' ? 'кг' : '°C'",
    unitTo: "kind == 'length' ? 'дюймов' : kind == 'weight' ? 'фунтов' : '°F'",
  },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Результат', value: '{{converted | number}} {{unitTo}}',
      hint: '{{value | number}} {{unitFrom}}' },
    { type: 'Select', label: 'Что переводим', bind: 'kind', options: [
      { value: 'length', label: 'Длина' },
      { value: 'weight', label: 'Вес' },
      { value: 'temp', label: 'Температура' },
    ] },
    { type: 'NumberField', label: 'Значение', bind: 'value' },
    { type: 'Button', title: 'Копировать результат', onPress: [
      { action: 'clipboard.set', value: '{{converted | number}}' },
      { action: 'toast', text: 'Скопировано' },
    ] },
  ] },
};

export const passwordGenerator: MiniAppSpec = {
  schemaVersion: 1, id: 'password-generator', version: 1,
  manifest: { name: 'Генератор паролей', icon: 'key', color: 'violet', locale: 'ru' },
  capabilities: ['clipboard', 'haptics'],
  state: { password: '', length: 16, useSymbols: true },
  persist: ['length', 'useSymbols'],
  derived: {
    charset: "useSymbols ? 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*?' : 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'",
    strength: "length >= 20 ? 'Очень надёжный' : length >= 14 ? 'Надёжный' : length >= 10 ? 'Средний' : 'Слабый'",
  },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Пароль', value: "{{password == '' ? 'Нажмите кнопку' : password}}",
      hint: '{{strength}}' },
    { type: 'Slider', label: 'Длина', bind: 'length', min: 8, max: 32, step: 1, readout: '{{length}}' },
    { type: 'Toggle', label: 'Спецсимволы', bind: 'useSymbols' },
    { type: 'Button', title: 'Сгенерировать', variant: 'primary', onPress: [
      { action: 'state.random', key: 'password', chars: '{{charset}}', length: '{{length}}' },
      { action: 'haptics', kind: 'light' },
    ] },
    { type: 'Button', title: 'Копировать', visible: "password != ''", onPress: [
      { action: 'clipboard.set', value: '{{password}}' },
      { action: 'toast', text: 'Скопировано' },
    ] },
  ] },
};
