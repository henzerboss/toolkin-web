import type { MiniAppSpec } from '../specTypes';

/**
 * Часть 2: трекеры и списки — самая массовая категория в сторах после
 * калькуляторов. Здесь же проверяются записи, галочки, фильтры и графики.
 */

export const habitTracker: MiniAppSpec = {
  schemaVersion: 1, id: 'habit-tracker', version: 1,
  manifest: { name: 'Трекер привычек', icon: 'repeat', color: 'green', locale: 'ru' },
  capabilities: ['haptics', 'notifications'],
  state: { draft: '', goal: 5 },
  persist: ['goal'],
  records: { fields: [
    { key: 'title', label: 'Привычка', kind: 'text' },
    { key: 'done', label: 'Выполнено', kind: 'number' },
  ], valueField: 'done' },
  derived: {
    doneToday: 'sum(recordValues)',
    progress: 'clamp(doneToday / max(goal, 1), 0, 1)',
  },
  ui: { type: 'Screen', children: [
    { type: 'Tabs', tabs: [
      { label: 'Сегодня', children: [
        { type: 'ProgressRing', progress: 'progress', value: '{{doneToday | integer}} / {{goal | integer}}',
          label: 'Выполнено сегодня' },
        { type: 'EmptyState', title: 'Привычек пока нет', hint: 'Добавьте первую во вкладке «Привычки»',
          visible: 'recordCount == 0' },
        { type: 'List', titleKey: 'title', checkKey: 'done', filter: '!item_done', showDate: false,
          deletable: false, empty: 'Всё выполнено' },
      ] },
      { label: 'Привычки', children: [
        { type: 'TextField', label: 'Новая привычка', bind: 'draft', placeholder: 'Например, зарядка' },
        { type: 'Button', title: 'Добавить', variant: 'primary', disabled: "draft == ''", onPress: [
          { action: 'records.add', values: { title: '{{draft}}', done: 0 } },
          { action: 'state.set', key: 'draft', value: '' },
          { action: 'haptics', kind: 'light' },
        ] },
        { type: 'List', titleKey: 'title', checkKey: 'done', showDate: false, empty: 'Список пуст' },
        { type: 'Stepper', label: 'Цель на день', bind: 'goal', min: 1, max: 15 },
      ] },
    ] },
  ] },
};

export const todoList: MiniAppSpec = {
  schemaVersion: 1, id: 'todo-list', version: 1,
  manifest: { name: 'Список дел', icon: 'checklist', color: 'blue', locale: 'ru' },
  capabilities: ['haptics'],
  state: { draft: '' },
  records: { fields: [
    { key: 'title', label: 'Задача', kind: 'text' },
    { key: 'done', label: 'Выполнено', kind: 'number' },
  ], valueField: 'done' },
  derived: { left: 'recordCount - sum(recordValues)' },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Осталось', value: '{{left | integer}}',
      hint: 'Всего задач: {{recordCount | integer}}' },
    { type: 'TextField', label: 'Новая задача', bind: 'draft', placeholder: 'Что нужно сделать?' },
    { type: 'Button', title: 'Добавить', variant: 'primary', disabled: "draft == ''", onPress: [
      { action: 'records.add', values: { title: '{{draft}}', done: 0 } },
      { action: 'state.set', key: 'draft', value: '' },
      { action: 'haptics', kind: 'light' },
    ] },
    { type: 'Section', title: 'Активные', children: [
      { type: 'EmptyState', title: 'Задач нет', hint: 'Добавьте первую', visible: 'recordCount == 0' },
      { type: 'List', titleKey: 'title', checkKey: 'done', filter: '!item_done', showDate: false,
        empty: 'Всё сделано' },
    ] },
    { type: 'Section', title: 'Выполненные', children: [
      { type: 'List', titleKey: 'title', checkKey: 'done', filter: 'item_done', showDate: false,
        empty: 'Пока ничего', itemActions: [
          { title: 'Вернуть', onPress: [
            { action: 'records.update', id: '{{itemId}}', values: { done: 0 } },
          ] },
        ] },
    ] },
  ] },
};

export const shoppingList: MiniAppSpec = {
  schemaVersion: 1, id: 'shopping-list', version: 1,
  manifest: { name: 'Список покупок', icon: 'shopping-cart', color: 'teal', locale: 'ru' },
  capabilities: ['haptics', 'share'],
  state: { draft: '', price: 0 },
  records: { fields: [
    { key: 'title', label: 'Товар', kind: 'text' },
    { key: 'price', label: 'Цена', kind: 'number' },
    { key: 'bought', label: 'Куплено', kind: 'number' },
  ], valueField: 'price' },
  derived: { total: 'sum(recordValues)' },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Сумма списка', value: '{{total | money}}',
      hint: 'Позиций: {{recordCount | integer}}' },
    { type: 'TextField', label: 'Товар', bind: 'draft', placeholder: 'Молоко' },
    { type: 'NumberField', label: 'Цена', bind: 'price', placeholder: '0' },
    { type: 'Button', title: 'Добавить', variant: 'primary', disabled: "draft == ''", onPress: [
      { action: 'records.add', values: { title: '{{draft}}', price: '{{price}}', bought: 0 } },
      { action: 'state.set', key: 'draft', value: '' },
      { action: 'state.set', key: 'price', value: 0 },
      { action: 'haptics', kind: 'light' },
    ] },
    { type: 'EmptyState', title: 'Список пуст', hint: 'Добавьте первый товар', visible: 'recordCount == 0' },
    { type: 'List', titleKey: 'title', subtitleKey: 'price', checkKey: 'bought', showDate: false,
      empty: 'Список пуст' },
    { type: 'Button', title: 'Поделиться списком', visible: 'recordCount > 0', onPress: [
      { action: 'share', value: 'Список покупок на {{total | money}}' },
    ] },
  ] },
};

export const expenseTracker: MiniAppSpec = {
  schemaVersion: 1, id: 'expense-tracker', version: 1,
  manifest: { name: 'Учёт расходов', icon: 'wallet', color: 'green', locale: 'ru' },
  capabilities: ['haptics'],
  state: { amount: 0, category: 'food', budget: 30000 },
  persist: ['budget', 'category'],
  records: { fields: [
    { key: 'amount', label: 'Сумма', kind: 'number' },
    { key: 'category', label: 'Категория', kind: 'text' },
  ], valueField: 'amount' },
  derived: {
    spent: 'sum(recordValues)',
    left: 'max(budget - spent, 0)',
    progress: 'clamp(spent / max(budget, 1), 0, 1)',
  },
  ui: { type: 'Screen', children: [
    { type: 'Tabs', tabs: [
      { label: 'Внести', children: [
        { type: 'ProgressRing', progress: 'progress', value: '{{spent | money}}',
          label: 'Осталось {{left | money}}' },
        { type: 'NumberField', label: 'Сумма', bind: 'amount', placeholder: '0' },
        { type: 'Select', label: 'Категория', bind: 'category', options: [
          { value: 'food', label: 'Еда' },
          { value: 'transport', label: 'Транспорт' },
          { value: 'fun', label: 'Досуг' },
        ] },
        { type: 'Button', title: 'Добавить расход', variant: 'primary', disabled: 'amount <= 0', onPress: [
          { action: 'records.add', values: { amount: '{{amount}}', category: '{{category}}' } },
          { action: 'state.set', key: 'amount', value: 0 },
          { action: 'haptics', kind: 'light' },
        ] },
      ] },
      { label: 'Аналитика', children: [
        { type: 'EmptyState', title: 'Данных пока нет', hint: 'Внесите первый расход',
          visible: 'recordCount == 0' },
        { type: 'PieChart', label: 'По категориям', groupBy: 'category', valueKey: 'amount',
          empty: 'Данных пока нет' },
        { type: 'LineChart', label: 'Динамика', values: 'recordValues', empty: 'Данных пока нет' },
        { type: 'List', titleKey: 'amount', subtitleKey: 'category', suffix: ' ₽' },
      ] },
      { label: 'Бюджет', children: [
        { type: 'Section', title: 'Месячный лимит', children: [
          { type: 'NumberField', label: 'Бюджет на месяц', bind: 'budget' },
          { type: 'KeyValue', label: 'Потрачено', value: '{{spent | money}}' },
          { type: 'KeyValue', label: 'Осталось', value: '{{left | money}}' },
        ] },
        { type: 'Button', title: 'Очистить историю', onPress: [{ action: 'records.clear' }] },
      ] },
    ] },
  ] },
};

export const waterTracker: MiniAppSpec = {
  schemaVersion: 1, id: 'water-tracker', version: 1,
  manifest: { name: 'Вода за день', icon: 'droplet', color: 'teal', locale: 'ru' },
  capabilities: ['haptics', 'notifications'],
  state: { weight: 70, portion: 250 },
  persist: ['weight', 'portion'],
  records: { fields: [{ key: 'amount', label: 'Объём', kind: 'number' }], valueField: 'amount' },
  derived: {
    goal: 'round(weight * 30)',
    drunk: 'sum(recordValues)',
    progress: 'clamp(drunk / max(goal, 1), 0, 1)',
    left: 'max(goal - drunk, 0)',
  },
  ui: { type: 'Screen', children: [
    { type: 'ProgressRing', progress: 'progress', value: '{{drunk | integer}} мл',
      label: '{{left > 0 ? "Осталось " + left + " мл" : "Норма выполнена"}}' },
    { type: 'Button', title: 'Выпил {{portion | integer}} мл', variant: 'primary', onPress: [
      { action: 'records.add', values: { amount: '{{portion}}' } },
      { action: 'haptics', kind: 'light' },
    ] },
    { type: 'Chart', label: 'Приёмы за день', values: 'recordValues', empty: 'Отметьте первый стакан' },
    { type: 'Section', title: 'Настройки', children: [
      { type: 'NumberField', label: 'Вес, кг', bind: 'weight' },
      { type: 'Stepper', label: 'Размер порции, мл', bind: 'portion', min: 50, max: 1000, step: 50 },
      { type: 'KeyValue', label: 'Дневная норма', value: '{{goal | integer}} мл' },
    ] },
  ] },
};
