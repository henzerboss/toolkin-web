import type { MiniAppSpec } from './specTypes';

export const tipCalculator: MiniAppSpec = {
  schemaVersion: 2,
  id: 'tip-calculator',
  version: 1,
  manifest: { name: 'Чаевые', icon: 'percent', color: 'blue', locale: 'ru' },
  capabilities: ['clipboard', 'haptics', 'share'],
  state: { bill: 0, tipPct: 10, people: 2 },
  persist: ['tipPct'],
  derived: {
    tip: 'bill * tipPct / 100',
    total: 'bill + tip',
    perPerson: 'total / max(people, 1)',
  },
  screens: {
    home: {
      type: 'Screen',
      children: [
        { type: 'NumberField', label: 'Сумма счёта', bind: 'bill', placeholder: '0' },
        { type: 'Slider', label: 'Чаевые', bind: 'tipPct', min: 0, max: 30, step: 1, readout: '{{tipPct}}% · {{tip | money}}' },
        { type: 'Stepper', label: 'Человек', bind: 'people', min: 1, max: 50 },
        { type: 'Stat', label: 'С человека', value: '{{perPerson | money}}', hint: 'Всего {{total | money}}' },
        { type: 'Row', children: [
          { type: 'Button', title: 'Копировать', onPress: [
            { action: 'clipboard.set', value: '{{perPerson | money}}' },
            { action: 'haptics', kind: 'success' },
            { action: 'toast', text: 'Скопировано' },
          ] },
          { type: 'Button', title: 'Поделиться', onPress: [{ action: 'share', value: 'С каждого по {{perPerson | money}}' }] },
        ] },
      ],
    },
  },
  navigation: { start: 'home', mode: 'single' },
};

export const eggTimer: MiniAppSpec = {
  schemaVersion: 2,
  id: 'egg-timer',
  version: 1,
  manifest: { name: 'Таймер яиц', icon: 'egg', color: 'amber', locale: 'ru' },
  capabilities: ['haptics', 'notifications'],
  state: { doneness: 'medium', fromFridge: false },
  persist: ['doneness', 'fromFridge'],
  derived: {
    baseSeconds: "doneness == 'soft' ? 240 : doneness == 'medium' ? 390 : 540",
    totalSeconds: 'baseSeconds + (fromFridge ? 45 : 0)',
    progress: 'totalSeconds > 0 ? clamp(timerElapsed / totalSeconds, 0, 1) : 0',
  },
  screens: {
    home: {
      type: 'Screen',
      children: [
        { type: 'Select', label: 'Готовность', bind: 'doneness', options: [
          { value: 'soft', label: 'Всмятку' }, { value: 'medium', label: 'В мешочек' }, { value: 'hard', label: 'Вкрутую' },
        ] },
        { type: 'Toggle', label: 'Яйца из холодильника', bind: 'fromFridge' },
        { type: 'ProgressRing', progress: 'progress', value: '{{timerRunning || timerFinished ? timerRemaining : totalSeconds | duration}}', label: '{{timerFinished ? "Готово" : timerRunning ? "Варится" : "Нажмите старт"}}' },
        { type: 'Row', children: [
          { type: 'Button', title: '{{timerRunning ? "Пауза" : "Старт"}}', variant: 'primary', onPress: [
            { action: 'timer.start', seconds: '{{totalSeconds}}', when: '!timerRunning' },
            { action: 'timer.pause', when: 'timerRunning' },
            { action: 'haptics', kind: 'medium' },
            { action: 'notify.schedule', title: 'Яйца готовы', body: 'Снимайте с плиты', afterSeconds: '{{totalSeconds - timerElapsed}}', when: '!timerRunning' },
          ] },
          { type: 'Button', title: 'Сброс', onPress: [{ action: 'timer.reset' }] },
        ] },
      ],
    },
  },
  navigation: { start: 'home', mode: 'single' },
};

export const waterTracker: MiniAppSpec = {
  schemaVersion: 2,
  id: 'water-tracker',
  version: 1,
  manifest: { name: 'Вода за день', icon: 'droplet', color: 'teal', locale: 'ru' },
  capabilities: ['haptics'],
  state: { goal: 2000, portion: 250 },
  persist: ['goal', 'portion'],
  collections: {
    drinks: { fields: [{ key: 'amount', label: 'Объём', kind: 'number' }], valueField: 'amount' },
  },
  derived: {
    drunk: 'sumBy(records, "drinks", "amount")',
    progress: 'clamp(drunk / max(goal, 1), 0, 1)',
    left: 'max(goal - drunk, 0)',
  },
  screens: {
    home: {
      type: 'Screen',
      children: [
        { type: 'ProgressRing', progress: 'progress', value: '{{drunk | integer}}', label: '{{left > 0 ? "Осталось " + left + " мл" : "Норма выполнена"}}' },
        { type: 'Stepper', label: 'Размер порции, мл', bind: 'portion', min: 50, max: 1000, step: 50 },
        { type: 'Button', title: 'Выпил {{portion}} мл', variant: 'primary', onPress: [
          { action: 'records.add', collection: 'drinks', values: { amount: '{{portion}}' } },
          { action: 'haptics', kind: 'light' },
        ] },
        { type: 'Chart', label: 'Последние приёмы', values: 'valuesBy(records, "drinks", "amount")' },
        { type: 'List', collection: 'drinks', valueKey: 'amount', suffix: ' мл', limit: 10, empty: 'Отметьте первый стакан' },
      ],
    },
  },
  navigation: { start: 'home', mode: 'single' },
};

export const DEMO_SPECS: MiniAppSpec[] = [tipCalculator, eggTimer, waterTracker];
