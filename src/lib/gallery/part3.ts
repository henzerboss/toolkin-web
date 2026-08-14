import type { MiniAppSpec } from '../specTypes';

/**
 * Часть 3: даты, здоровье и дневники. Здесь проверяются календарь,
 * вычисляемые отметки, уведомления и защита от расчётов по незаданной дате.
 */

export const cycleCalendar: MiniAppSpec = {
  schemaVersion: 1, id: 'cycle-calendar', version: 1,
  manifest: { name: 'Женский календарь', icon: 'calendar-heart', color: 'rose', locale: 'ru' },
  capabilities: ['notifications'],
  state: { lastPeriod: 0, cycleLength: 28, periodLength: 5, selectedDate: 0, symptom: '' },
  persist: ['cycleLength', 'periodLength'],
  records: { fields: [
    { key: 'note', label: 'Симптом', kind: 'text' },
    { key: 'day', label: 'Дата', kind: 'date' },
  ], valueField: 'day' },
  derived: {
    ovulation: 'addDays(lastPeriod, cycleLength - 14)',
    nextPeriod: 'addDays(lastPeriod, cycleLength)',
    periodDays: 'range(lastPeriod, periodLength, 86400000)',
    fertileDays: 'range(addDays(ovulation, -4), 6, 86400000)',
    daysLeft: 'max(daysBetween(nowMs, nextPeriod), 0)',
    cycleDay: 'daysBetween(lastPeriod, nowMs) + 1',
  },
  ui: { type: 'Screen', children: [
    { type: 'Tabs', tabs: [
      { label: 'Цикл', children: [
        { type: 'EmptyState', title: 'Отметьте начало цикла',
          hint: 'После этого появится прогноз', visible: 'lastPeriod == 0' },
        { type: 'Stat', label: 'До нового цикла', value: '{{daysLeft | integer}}',
          hint: 'День цикла: {{cycleDay | integer}}', visible: 'lastPeriod > 0' },
        { type: 'KeyValue', label: 'Овуляция', value: '{{ovulation | date}}', visible: 'lastPeriod > 0' },
        { type: 'Calendar', bind: 'selectedDate', dateKey: 'day', marks: [
          { dates: 'periodDays', color: '#C2385F', label: 'Месячные' },
          { dates: 'fertileDays', color: '#6244D6', label: 'Фертильные' },
          { dates: '[ovulation]', color: '#0E7C7B', label: 'Овуляция' },
        ] },
        { type: 'DateField', label: 'Начало последних месячных', bind: 'lastPeriod',
          placeholder: 'Не выбрано' },
      ] },
      { label: 'Журнал', children: [
        { type: 'TextField', label: 'Как самочувствие', bind: 'symptom', multiline: true },
        { type: 'Button', title: 'Записать', variant: 'primary', disabled: "symptom == ''", onPress: [
          { action: 'records.add', values: { note: '{{symptom}}', day: '{{nowMs}}' } },
          { action: 'state.set', key: 'symptom', value: '' },
        ] },
        { type: 'EmptyState', title: 'Записей пока нет', visible: 'recordCount == 0' },
        { type: 'List', titleKey: 'note', empty: 'Записей пока нет' },
      ] },
      { label: 'Настройки', children: [
        { type: 'Section', title: 'Параметры цикла', children: [
          { type: 'Stepper', label: 'Длина цикла', bind: 'cycleLength', min: 20, max: 40 },
          { type: 'Stepper', label: 'Длительность месячных', bind: 'periodLength', min: 2, max: 10 },
        ] },
        { type: 'Button', title: 'Напомнить за 2 дня', visible: 'lastPeriod > 0', onPress: [
          { action: 'notify.at', title: 'Скоро месячные', body: 'Через два дня',
            at: '{{addDays(nextPeriod, -2)}}', repeat: 'none' },
          { action: 'toast', text: 'Напоминание поставлено' },
        ] },
      ] },
    ] },
  ] },
};

export const weightDiary: MiniAppSpec = {
  schemaVersion: 1, id: 'weight-diary', version: 1,
  manifest: { name: 'Дневник веса', icon: 'scale', color: 'blue', locale: 'ru' },
  capabilities: ['haptics'],
  state: { weight: 70, height: 175, target: 65 },
  persist: ['height', 'target'],
  records: { fields: [{ key: 'weight', label: 'Вес', kind: 'number' }], valueField: 'weight' },
  derived: {
    bmi: 'height > 0 ? weight / pow(height / 100, 2) : 0',
    bmiLabel: "bmi < 18.5 ? 'Недостаток' : bmi < 25 ? 'Норма' : bmi < 30 ? 'Избыток' : 'Ожирение'",
    toTarget: 'weight - target',
    average: 'recordCount > 0 ? avg(recordValues) : 0',
  },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Индекс массы тела', value: '{{bmi | number}}', hint: '{{bmiLabel}}' },
    { type: 'NumberField', label: 'Вес сегодня, кг', bind: 'weight' },
    { type: 'Button', title: 'Записать', variant: 'primary', onPress: [
      { action: 'records.add', values: { weight: '{{weight}}' } },
      { action: 'haptics', kind: 'light' },
    ] },
    { type: 'KeyValue', label: 'До цели', value: '{{toTarget | number}} кг' },
    { type: 'KeyValue', label: 'Средний вес', value: '{{average | number}} кг' },
    { type: 'LineChart', label: 'Динамика', values: 'recordValues', empty: 'Сделайте первую запись' },
    { type: 'Section', title: 'Параметры', children: [
      { type: 'NumberField', label: 'Рост, см', bind: 'height' },
      { type: 'NumberField', label: 'Цель, кг', bind: 'target' },
    ] },
  ] },
};

export const moodDiary: MiniAppSpec = {
  schemaVersion: 1, id: 'mood-diary', version: 1,
  manifest: { name: 'Дневник настроения', icon: 'mood-smile', color: 'violet', locale: 'ru' },
  capabilities: ['haptics'],
  state: { mood: 3, note: '' },
  records: { fields: [
    { key: 'mood', label: 'Настроение', kind: 'number' },
    { key: 'note', label: 'Заметка', kind: 'text' },
  ], valueField: 'mood' },
  derived: {
    average: 'recordCount > 0 ? avg(recordValues) : 0',
    label: "mood == 1 ? 'Плохо' : mood == 2 ? 'Так себе' : mood == 3 ? 'Нормально' : mood == 4 ? 'Хорошо' : 'Отлично'",
  },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Среднее настроение', value: '{{average | number}}',
      hint: 'Записей: {{recordCount | integer}}' },
    { type: 'Slider', label: 'Как вы сейчас', bind: 'mood', min: 1, max: 5, step: 1, readout: '{{label}}' },
    { type: 'TextField', label: 'Что происходит', bind: 'note', multiline: true, placeholder: 'Необязательно' },
    { type: 'Button', title: 'Записать', variant: 'primary', onPress: [
      { action: 'records.add', values: { mood: '{{mood}}', note: '{{note}}' } },
      { action: 'state.set', key: 'note', value: '' },
      { action: 'haptics', kind: 'light' },
    ] },
    { type: 'LineChart', label: 'Динамика', values: 'recordValues', empty: 'Сделайте первую запись' },
    { type: 'List', titleKey: 'note', subtitleKey: 'mood', empty: 'Записей пока нет' },
  ] },
};

export const birthdayCalendar: MiniAppSpec = {
  schemaVersion: 1, id: 'birthdays', version: 1,
  manifest: { name: 'Дни рождения', icon: 'cake', color: 'amber', locale: 'ru' },
  capabilities: ['notifications'],
  state: { who: '', birthday: 0, selectedDate: 0 },
  records: { fields: [
    { key: 'who', label: 'Кто', kind: 'text' },
    { key: 'day', label: 'Дата', kind: 'date' },
  ], valueField: 'day' },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Дней рождения в списке', value: '{{recordCount | integer}}' },
    { type: 'Calendar', bind: 'selectedDate', dateKey: 'day' },
    { type: 'Section', title: 'Добавить', children: [
      { type: 'TextField', label: 'Имя', bind: 'who', placeholder: 'Кто именинник' },
      { type: 'DateField', label: 'Дата рождения', bind: 'birthday', placeholder: 'Не выбрано' },
      { type: 'Button', title: 'Добавить и напомнить', variant: 'primary',
        disabled: "who == '' || birthday == 0", onPress: [
          { action: 'records.add', values: { who: '{{who}}', day: '{{birthday}}' } },
          { action: 'notify.at', title: 'День рождения', body: '{{who}}', at: '{{birthday}}',
            repeat: 'yearly' },
          { action: 'state.set', key: 'who', value: '' },
          { action: 'toast', text: 'Напоминание поставлено' },
        ] },
    ] },
    { type: 'EmptyState', title: 'Список пуст', hint: 'Добавьте первого именинника',
      visible: 'recordCount == 0' },
    { type: 'List', titleKey: 'who', subtitleKey: 'day', empty: 'Список пуст' },
  ] },
};

export const eventCountdown: MiniAppSpec = {
  schemaVersion: 1, id: 'event-countdown', version: 1,
  manifest: { name: 'Обратный отсчёт', icon: 'hourglass', color: 'violet', locale: 'ru' },
  capabilities: ['share', 'notifications'],
  state: { title: '', targetDate: 0 },
  persist: ['title', 'targetDate'],
  derived: {
    daysLeft: 'max(daysBetween(nowMs, targetDate), 0)',
    hoursLeft: 'max(floor((targetDate - nowMs) / 3600000), 0)',
  },
  ui: { type: 'Screen', children: [
    { type: 'EmptyState', title: 'Выберите дату события',
      hint: 'И увидите, сколько осталось', visible: 'targetDate == 0' },
    { type: 'Stat', label: "{{title == '' ? 'До события' : title}}", value: '{{daysLeft | integer}}',
      hint: 'дней · {{hoursLeft | integer}} ч', visible: 'targetDate > 0' },
    { type: 'TextField', label: 'Название события', bind: 'title', placeholder: 'Отпуск' },
    { type: 'DateField', label: 'Дата события', bind: 'targetDate', placeholder: 'Не выбрано' },
    { type: 'Button', title: 'Поделиться', visible: 'targetDate > 0', onPress: [
      { action: 'share', value: 'До события «{{title}}» осталось {{daysLeft | integer}} дней' },
    ] },
  ] },
};
