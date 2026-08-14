import assert from 'node:assert';
import { validateSpec } from './src/lib/validateSpec';
import { autofix } from './src/lib/autofix';
import { smokeTest } from './src/lib/smokeTest';
import { checkFeatures } from './src/lib/featureCheck';
import type { Feature } from './src/app/api/_plan';
import { PIPELINE_VERSION, cacheKey } from './src/lib/specCacheKey';
import { buildGeneratePrompt, buildSystemInstruction } from './src/app/api/_prompt';
import { creditsForProduct } from './src/lib/pricing';
import { DEMO_SPECS } from './src/lib/exampleSpecs';

// Валидатор сайта и валидатор приложения должны совпадать: спека, принятая
// одним, обязана проходить у другого, иначе человек платит за генерацию,
// которая упадёт уже на устройстве.
for (const spec of DEMO_SPECS) {
  const r = validateSpec(spec);
  assert.ok(r.ok, `${spec.id}: ${r.ok ? '' : r.errors.join(' | ')}`);
}

const bad = validateSpec({
  ...DEMO_SPECS[0],
  capabilities: [],
  ui: {
    type: 'Screen',
    children: [
      { type: 'Ghost' },
      { type: 'Slider', bind: 'nope' },
      { type: 'Button', title: 'x', onPress: [{ action: 'clipboard.set', value: '1' }, { action: 'fly' }] },
    ],
  },
});
assert.ok(!bad.ok);
// Проверяем смысл ошибок, а не их количество: счётчик ломается от любой
// правки теста и ничего не говорит о качестве подсказок для модели.
const joined = bad.errors.join('\n');
assert.match(joined, /component "Ghost" does not exist/);
assert.match(joined, /bind="nope" is not declared in state/);
assert.match(joined, /requires capability "clipboard"/);
assert.match(joined, /action "fly" does not exist/);

// Пакеты кредитов читаются из переменной окружения, а не из кода.
process.env.TOOLKIN_CREDIT_PACKS = 'credits_100:100,credits_500:550';
assert.strictEqual(creditsForProduct('credits_500'), 550);
assert.strictEqual(creditsForProduct('unknown_pack'), 0);
assert.strictEqual(creditsForProduct(null), 0);


// Правила связности: структурно валидная спека, которая молча ничего не делает,
// для пользователя неотличима от сломанной — и стоит ему кредитов.
const wiring: [string, unknown, RegExp][] = [
  ['records без блока records', {
    ...DEMO_SPECS[0], records: undefined,
    ui: { type: 'Screen', children: [
      { type: 'Button', title: 'x', onPress: [{ action: 'records.add', values: { amount: 1 } }] },
    ] },
  }, /records block is missing/],
  ['timer.start без seconds', {
    ...DEMO_SPECS[0],
    ui: { type: 'Screen', children: [
      { type: 'Text', value: '{{timerRemaining | duration}}' },
      { type: 'Button', title: 'x', onPress: [{ action: 'timer.start' }] },
    ] },
  }, /seconds is missing/],
  ['таймер без отображения', {
    ...DEMO_SPECS[0],
    ui: { type: 'Screen', children: [
      { type: 'Button', title: 'x', onPress: [{ action: 'timer.start', seconds: 60 }] },
    ] },
  }, /countdown stays invisible/],
];

for (const [name, spec, pattern] of wiring) {
  const r = validateSpec(spec);
  assert.ok(!r.ok, `${name}: должно было отвергнуться`);
  assert.match(r.errors.join('\n'), pattern, `${name}: ${r.errors.join(' | ')}`);
}
console.log(`Правил связности проверено: ${wiring.length}`);

// AI-утилиты — отдельный сценарий: именно здесь ошибка стоит пользователю денег.
// Подстановка {{...}} в prompt раньше ломала сопоставление по JSON и проверки
// молча не срабатывали, поэтому кейс закреплён тестом.
const aiSpec = {
  schemaVersion: 1, id: 'recipe-gen', version: 1,
  manifest: { name: 'Рецепты', icon: 'chef-hat', color: 'green', locale: 'ru' },
  capabilities: ['llm'],
  state: { products: '', recipe: '' },
  ui: { type: 'Screen', children: [
    { type: 'TextField', label: 'Продукты', bind: 'products', multiline: true },
    { type: 'Button', title: 'Придумать', variant: 'primary', disabled: 'llmBusy',
      onPress: [{ action: 'llm.ask', prompt: 'Рецепт из: {{products}}', into: 'recipe' }] },
    { type: 'Text', value: '{{recipe}}', visible: "recipe != ''" },
  ] },
};
assert.ok(validateSpec(aiSpec).ok, 'корректная AI-утилита должна проходить');

const noBusy = JSON.parse(JSON.stringify(aiSpec));
delete noBusy.ui.children[1].disabled;
const noBusyResult = validateSpec(noBusy);
assert.ok(!noBusyResult.ok);
assert.match(noBusyResult.errors.join('\n'), /llmBusy/);

const noCamera = JSON.parse(JSON.stringify(aiSpec));
noCamera.state.photo = '';
noCamera.ui.children[1].onPress[0].image = 'photo';
assert.match(validateSpec(noCamera).ok ? '' : validateSpec(noCamera).errors.join('\n'), /camera\.capture/);
console.log('AI-связки проверены');

// Игра в песочнице: единственный способ собрать змейку или арканоид.
const game = {
  schemaVersion: 1, id: 'snake', version: 1,
  manifest: { name: 'Змейка', icon: 'device-gamepad', color: 'green', locale: 'ru' },
  capabilities: ['sandbox'],
  state: { best: 0 },
  records: { fields: [{ key: 'score', label: 'Очки', kind: 'number' }], valueField: 'score' },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Рекорд', value: '{{best | integer}}' },
    { type: 'Sandbox', ratio: 'square',
      html: '<canvas id="g"></canvas><script>document.addEventListener("touchstart",function(){toolkin.save({score:10})});</script>' },
  ] },
};
assert.ok(validateSpec(game).ok, 'игра в песочнице должна проходить');

const remote = JSON.parse(JSON.stringify(game));
remote.ui.children[1].html = '<script src="https://cdn.example.com/x.js"></script><canvas onclick="x()"></canvas>';
assert.match(validateSpec(remote).ok ? '' : validateSpec(remote).errors.join('\n'), /external scripts/);
console.log('Песочница проверена');

// Числа из свободного текста и потерянные фото — две ошибки, из-за которых
// трекер КБЖУ писал в историю нули и не показывал снимки.
const kbju = {
  schemaVersion: 1, id: 'kbju', version: 1,
  manifest: { name: 'КБЖУ', icon: 'camera', color: 'amber', locale: 'ru' },
  capabilities: ['camera', 'llm'],
  state: { photo: '', result: '' },
  records: { fields: [
    { key: 'photo', label: 'Фото', kind: 'image' },
    { key: 'kcal', label: 'Ккал', kind: 'number' },
  ], valueField: 'kcal' },
  ui: { type: 'Screen', children: [
    { type: 'Button', title: 'Камера', disabled: 'llmBusy',
      onPress: [{ action: 'camera.capture', into: 'photo', source: 'camera' }] },
    { type: 'Button', title: 'Анализ', disabled: 'llmBusy',
      onPress: [
        { action: 'llm.ask', prompt: 'Оцени блюдо', image: 'photo', into: 'result' },
        { action: 'records.add', values: { photo: '{{photo}}', kcal: '{{result}}' } },
      ] },
    { type: 'Text', value: '{{result}}' },
    { type: 'List', valueKey: 'kcal' },
  ] },
};
const kbjuResult = validateSpec(kbju);
assert.ok(!kbjuResult.ok);
const kbjuErrors = kbjuResult.errors.join('\n');
assert.match(kbjuErrors, /free-text llm\.ask/);
assert.match(kbjuErrors, /nothing displays it/);
console.log('Числа и фото в истории проверены');

// Игровое поле из кнопок: модель упорно строила так, а такая игра
// не может ни ходить за компьютера, ни анимироваться.
const cells = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
const buttonBoard = {
  schemaVersion: 1, id: 'ttt', version: 1,
  manifest: { name: 'Крестики-нолики', icon: 'grid-dots', color: 'teal', locale: 'ru' },
  capabilities: [],
  state: { wins: 0, ...Object.fromEntries(cells.map((c) => [c, ''])) },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Побед', value: '{{wins | integer}}' },
    ...cells.map((c) => ({
      type: 'Button', title: '{{' + c + '}}',
      onPress: [{ action: 'state.set', key: c, value: 'X' }],
    })),
  ] },
};
assert.match(
  validateSpec(buttonBoard).ok ? '' : validateSpec(buttonBoard).errors.join('\n'),
  /game grid/,
);

// Клавиатура калькулятора пишет в одно поле — ложного срабатывания быть не должно.
const keypad = {
  ...buttonBoard, id: 'calc', state: { display: '' },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Итого', value: '{{display}}' },
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => ({
      type: 'Button', title: digit,
      onPress: [{ action: 'state.set', key: 'display', value: digit }],
    })),
  ] },
};
assert.ok(validateSpec(keypad).ok, 'клавиатура не должна считаться игрой');
console.log('Игровое поле из кнопок проверено');

const sys = buildSystemInstruction('ru');
assert.ok(sys.includes('Russian') && sys.includes('llm.ask') && sys.includes('ProgressRing'));

console.log('Ошибки для цикла починки:');
bad.errors.forEach((e) => console.log('  •', e));
console.log(`\nСистемный промпт: ${sys.length} символов.`);
console.log('Проверки сайта пройдены.');

// Сборка промпта по плану: ради неё и затевалась двухэтапная генерация.

// Проверяем сборку промпта по плану — то, ради чего всё затевалось.
const gamePrompt = buildSystemInstruction('ru', {
  kind: 'game', capabilities: ['sandbox'], components: ['Sandbox', 'Stat'],
  needsRecords: false, needsStructuredAi: false, summary: '', title: '',
});
assert.ok(gamePrompt.includes('ONE Sandbox node'), 'у игры должен быть раздел про песочницу');
assert.ok(!gamePrompt.includes('Photo utilities.'), 'у игры не должно быть раздела про камеру');

const photoPrompt = buildSystemInstruction('ru', {
  kind: 'ai_tool', capabilities: ['camera', 'llm'], components: ['Image', 'Gallery'],
  needsRecords: true, needsStructuredAi: true, summary: '', title: '',
});
assert.ok(photoPrompt.includes('Photo utilities.'), 'у фото-утилиты должен быть раздел про камеру');
assert.ok(photoPrompt.includes('"fields"'), 'должен быть раздел про структурный ответ');
assert.ok(!photoPrompt.includes('ONE Sandbox node'), 'у фото-утилиты не должно быть раздела про игры');

const full = buildSystemInstruction('ru');
assert.ok(full.length > photoPrompt.length, 'промпт по плану должен быть короче полного');

const withPlan = buildGeneratePrompt('змейка', 'ru', {
  kind: 'game', capabilities: ['sandbox'], components: ['Sandbox'],
  needsRecords: false, needsStructuredAi: false, summary: 'игра змейка', title: 'Змейка',
});
assert.ok(withPlan.includes('kind: game') && withPlan.includes('Sandbox'));

console.log(`полный промпт: ${full.length}`);
console.log(`игра:          ${gamePrompt.length} (-${Math.round((1 - gamePrompt.length / full.length) * 100)}%)`);
console.log(`фото + ИИ:     ${photoPrompt.length} (-${Math.round((1 - photoPrompt.length / full.length) * 100)}%)`);
console.log('Сборка промпта по плану проверена');

// Кэш спек: нормализация запроса решает, платим ли мы Gemini дважды
// за «Таймер для яиц» и «таймер для яиц.».
assert.strictEqual(
  cacheKey('Таймер для яиц', 'ru'),
  cacheKey('  таймер   для яиц.  ', 'ru'),
  'регистр, пробелы и точка не должны менять ключ',
);
assert.notStrictEqual(cacheKey('таймер для яиц', 'ru'), cacheKey('таймер для яиц', 'en'));
assert.notStrictEqual(cacheKey('таймер', 'ru'), cacheKey('секундомер', 'ru'));
// Отпечаток обязан меняться вместе с манифестом: иначе кэш переживёт
// правку DSL и будет отдавать спеки, собранные по старым правилам.
assert.match(PIPELINE_VERSION, /^v\d+-[0-9a-f]{12}$/, 'версия должна включать отпечаток манифеста');
console.log(`Кэш спек проверен, версия конвейера ${PIPELINE_VERSION}`);

// Женский календарь — тот самый случай, который спека раньше не позволяла
// собрать: овуляция и фертильное окно вычисляются, а не лежат в записях.
const cycleCalendar = {
  schemaVersion: 1, id: 'cycle', version: 1,
  manifest: { name: 'Женский календарь', icon: 'calendar-heart', color: 'rose', locale: 'ru' },
  capabilities: [],
  state: { lastPeriod: 0, cycleLength: 28, periodLength: 5, selectedDate: 0 },
  persist: ['lastPeriod', 'cycleLength'],
  derived: {
    ovulation: 'addDays(lastPeriod, cycleLength - 14)',
    periodDays: 'range(lastPeriod, periodLength, 86400000)',
    fertileDays: 'range(addDays(ovulation, -4), 6, 86400000)',
    daysToNext: 'max(daysBetween(nowMs, addDays(lastPeriod, cycleLength)), 0)',
  },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'До следующих', value: '{{daysToNext | integer}}' },
    { type: 'DateField', label: 'Начало последних', bind: 'lastPeriod' },
    { type: 'Calendar', bind: 'selectedDate', marks: [
      { dates: 'periodDays', color: '#C2385F', label: 'Месячные' },
      { dates: 'fertileDays', color: '#6244D6', label: 'Фертильные' },
      { dates: '[ovulation]', color: '#0E7C7B', label: 'Овуляция' },
    ] },
  ] },
};
assert.ok(validateSpec(cycleCalendar).ok, 'календарь цикла должен собираться');
console.log('Календарь цикла проверен');

// Пробный прогон: главный ответ на «спека валидна, а приложение не работает».
// Валидатор смотрит на форму, прогон исполняет утилиту и смотрит на результат.
for (const spec of DEMO_SPECS) {
  const smoke = smokeTest(spec);
  assert.ok(smoke.ok, `${spec.id} должна проходить прогон: ${smoke.issues.join(' | ')}`);
}

const emptyButton = {
  ...DEMO_SPECS[0], derived: {},
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Итого', value: '{{bill | money}}' },
    { type: 'Button', title: 'Посчитать', onPress: [] },
  ] },
};
const emptyResult = validateSpec(emptyButton);
assert.ok(emptyResult.ok, 'валидатор пустую кнопку не видит — это работа прогона');
assert.match(smokeTest(emptyResult.spec).issues.join('\n'), /does nothing when tapped/);

const staticOnly = {
  ...DEMO_SPECS[0], derived: {},
  ui: { type: 'Screen', children: [{ type: 'Text', value: 'Просто текст' }] },
};
const staticResult = validateSpec(staticOnly);
assert.ok(staticResult.ok);
assert.match(smokeTest(staticResult.spec).issues.join('\n'), /only static text/);

// Автопочинка: привычки JavaScript чинятся кодом, а не вызовом Gemini.
const jsHabits = {
  ...DEMO_SPECS[0],
  derived: {
    tip: 'Math.round(state.bill * state.tipPct / 100)',
    perPerson: 'tip / Math.max(state.people, 1)',
    kind: 'state.people === 1 ? "one" : "many"',
  },
};
const fixed = autofix(jsHabits as never);
assert.deepStrictEqual(
  Object.values(fixed.spec.derived ?? {}),
  ['round(bill * tipPct / 100)', 'tip / max(people, 1)', 'people == 1 ? "one" : "many"'],
);
assert.ok(validateSpec(fixed.spec).ok, 'после автопочинки спека должна быть валидной');
console.log(`Пробный прогон и автопочинка проверены (починено: ${fixed.applied.join(', ')})`);

// Согласование фич: список, показанный пользователю, — это обещание.
// Утилита без обещанной фичи не должна доходить до него.
const promised: Feature[] = [
  { id: 'predict', title: 'Прогноз цикла', description: '', essential: true,
    requiresComponents: ['Calendar'], requiresActions: [], requiresCapabilities: [] },
  { id: 'remind', title: 'Напоминание', description: '', essential: false,
    requiresComponents: [], requiresActions: ['notify.at'], requiresCapabilities: ['notifications'] },
];

const complete = {
  schemaVersion: 1, id: 'c', version: 1,
  manifest: { name: 'Календарь', icon: 'x', color: 'rose', locale: 'ru' },
  capabilities: ['notifications'],
  state: { lastPeriod: 0, selectedDate: 0 },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'До следующих', value: '{{lastPeriod | integer}}' },
    { type: 'Calendar', bind: 'selectedDate' },
    { type: 'Button', title: 'Напомнить',
      onPress: [{ action: 'notify.at', title: 'Скоро', at: '{{lastPeriod}}' }] },
  ] },
} as never;

const allFeatures = checkFeatures(complete, promised);
assert.ok(allFeatures.ok, `все обещанные фичи должны быть на месте: ${allFeatures.issues.join(' | ')}`);
assert.deepStrictEqual(allFeatures.implemented, ['predict', 'remind']);

const withoutReminder = JSON.parse(JSON.stringify(complete));
withoutReminder.ui.children.pop();
withoutReminder.capabilities = [];
const partial = checkFeatures(withoutReminder, promised);
assert.ok(!partial.ok);
assert.match(partial.issues.join('\n'), /is missing: action notify.at/);
assert.deepStrictEqual(partial.implemented, ['predict'], 'реализованное должно остаться в списке');
assert.deepStrictEqual(partial.missing.map((item) => item.id), ['remind']);

// Классы эквивалентности — из-за их отсутствия первая версия заворачивала
// исправные утилиты: планировщик просил Stat, сборщик делал ProgressRing.
const equivalent: Feature[] = [
  { id: 'progress', title: 'Прогресс', description: '', essential: true,
    requiresComponents: ['Stat'], requiresActions: [], requiresCapabilities: [] },
  { id: 'input', title: 'Ввод суммы', description: '', essential: true,
    requiresComponents: [], requiresActions: ['state.set'], requiresCapabilities: [] },
];

const viaRingAndBind = {
  schemaVersion: 1, id: 'e', version: 1,
  manifest: { name: 'Калории', icon: 'x', color: 'amber', locale: 'ru' },
  capabilities: [],
  state: { eaten: 0, goal: 2000 },
  derived: { progress: 'clamp(eaten / max(goal, 1), 0, 1)' },
  ui: { type: 'Screen', children: [
    { type: 'ProgressRing', progress: 'progress', value: '{{eaten | integer}}' },
    { type: 'NumberField', label: 'Съедено', bind: 'eaten' },
  ] },
} as never;

const lenient = checkFeatures(viaRingAndBind, equivalent);
assert.ok(
  lenient.ok,
  `ProgressRing должен закрывать Stat, а bind — state.set: ${lenient.issues.join(' | ')}`,
);
console.log('Согласование фич проверено, эквивалентность работает');

// Вкладки: содержимое каждой обязано быть видно всем анализаторам. Забыть
// про tabs в одном месте обхода — значит перестать видеть половину утилиты.
const tabbed = {
  schemaVersion: 1, id: 'tabbed', version: 1,
  manifest: { name: 'Календарь', icon: 'x', color: 'rose', locale: 'ru' },
  capabilities: ['notifications'],
  state: { lastPeriod: 0, cycleLength: 28, symptom: '' },
  records: { fields: [{ key: 'note', label: 'Симптом', kind: 'text' }], valueField: 'note' },
  derived: { daysToNext: 'max(daysBetween(nowMs, addDays(lastPeriod, cycleLength)), 0)' },
  ui: { type: 'Screen', children: [
    { type: 'Tabs', tabs: [
      { label: 'Цикл', children: [
        { type: 'Stat', label: 'До следующих', value: '{{daysToNext | integer}}' },
        { type: 'DateField', label: 'Начало', bind: 'lastPeriod' },
      ] },
      { label: 'Журнал', children: [
        { type: 'TextField', label: 'Самочувствие', bind: 'symptom' },
        { type: 'Button', title: 'Записать', variant: 'primary', disabled: "symptom == ''",
          onPress: [{ action: 'records.add', values: { note: '{{symptom}}' } }] },
        { type: 'EmptyState', title: 'Пока пусто', visible: 'recordCount == 0' },
        { type: 'List', valueKey: 'note', visible: 'recordCount > 0' },
      ] },
      { label: 'Настройки', children: [
        { type: 'Section', title: 'Цикл', children: [
          { type: 'Stepper', label: 'Длина', bind: 'cycleLength', min: 20, max: 40 },
        ] },
        { type: 'Button', title: 'Напомнить',
          onPress: [{ action: 'notify.at', title: 'Скоро', at: '{{lastPeriod}}' }] },
      ] },
    ] },
  ] },
};

const tabsValid = validateSpec(tabbed);
assert.ok(tabsValid.ok, `вкладки должны валидироваться: ${tabsValid.ok ? '' : tabsValid.errors.join(' | ')}`);

const tabsSmoke = smokeTest(tabsValid.spec);
assert.ok(tabsSmoke.ok, `прогон должен исполнять вкладки: ${tabsSmoke.issues.join(' | ')}`);

// Кнопка во второй вкладке — если обход её не видит, экшен считается отсутствующим.
const tabFeatures: Feature[] = [
  { id: 'log', title: 'Журнал', description: '', essential: true,
    requiresComponents: [], requiresActions: ['records.add'], requiresCapabilities: [] },
  { id: 'remind', title: 'Напоминание', description: '', essential: true,
    requiresComponents: [], requiresActions: ['notify.at'], requiresCapabilities: ['notifications'] },
];
assert.ok(checkFeatures(tabsValid.spec, tabFeatures).ok, 'фичи во вкладках должны находиться');
console.log('Вкладки проверены во всех анализаторах');

// График, привязанный к нечисловому полю, рисует пустоту — утилита работает,
// но выглядит сломанной. Самый обидный вид поломки.
const chartOnText = {
  schemaVersion: 1, id: 'kbju', version: 1,
  manifest: { name: 'Калории', icon: 'x', color: 'amber', locale: 'ru' },
  capabilities: [],
  state: { goal: 2000 },
  records: { fields: [
    { key: 'photo', label: 'Фото', kind: 'image' },
    { key: 'kcal', label: 'Ккал', kind: 'number' },
  ], valueField: 'photo' },
  derived: { eaten: 'sum(recordValues)' },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Съедено', value: '{{eaten | integer}}' },
    { type: 'LineChart', label: 'Динамика', values: 'recordValues' },
  ] },
};
const chartResult = validateSpec(chartOnText);
assert.ok(!chartResult.ok);
assert.match(chartResult.errors.join('\n'), /valueField, and that field must be a number/);

// Дубль миниатюры: Gallery и List с imageKey показывают одно и то же дважды.
const doubleThumb = {
  schemaVersion: 1, id: 'dt', version: 1,
  manifest: { name: 'Фото', icon: 'x', color: 'amber', locale: 'ru' },
  capabilities: ['camera'],
  state: { photo: '' },
  records: { fields: [
    { key: 'photo', label: 'Фото', kind: 'image' },
    { key: 'kcal', label: 'Ккал', kind: 'number' },
  ], valueField: 'kcal' },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Съедено', value: '{{recordCount | integer}}' },
    { type: 'Button', title: 'Снять',
      onPress: [{ action: 'camera.capture', into: 'photo', source: 'camera' }] },
    { type: 'Gallery', imageKey: 'photo', columns: 3 },
    { type: 'List', valueKey: 'kcal', imageKey: 'photo' },
  ] },
};
const dedup = autofix(validateSpec(doubleThumb).ok ? validateSpec(doubleThumb).spec : (doubleThumb as never));
const listNode = (dedup.spec.ui.children as never[])[3] as Record<string, unknown>;
assert.strictEqual(listNode.imageKey, undefined, 'миниатюра в List должна убираться при наличии Gallery');
assert.ok(dedup.applied.includes('дубль миниатюры'));
console.log('Графики и дубль миниатюры проверены');

// Массив, выведенный шаблоном, печатается как JSON — пользователь видит
// квадратные скобки и кавычки вместо списка ингредиентов.
const arrayInTemplate = {
  schemaVersion: 1, id: 'r', version: 1,
  manifest: { name: 'Рецепты', icon: 'x', color: 'amber', locale: 'ru' },
  capabilities: ['llm'],
  state: { products: '', ingredients: [] },
  ui: { type: 'Screen', children: [
    { type: 'TextField', label: 'Продукты', bind: 'products' },
    { type: 'Button', title: 'Рецепт', variant: 'primary', disabled: 'llmBusy',
      onPress: [{ action: 'llm.ask', prompt: '{{products}}', fields: { ingredients: 'массив строк' } }] },
    { type: 'Text', value: '{{ingredients}}' },
  ] },
};
assert.match(
  validateSpec(arrayInTemplate).ok ? '' : validateSpec(arrayInTemplate).errors.join('\n'),
  /is an array but is printed through a template/,
);

// Тот же рецепт с Bullets — валиден.
const withBullets = JSON.parse(JSON.stringify(arrayInTemplate));
withBullets.ui.children[2] = { type: 'Bullets', label: 'Состав', items: 'ingredients' };
assert.ok(validateSpec(withBullets).ok, 'Bullets должен закрывать вывод массива');

// Захардкоженная дата: календарь открывался на позапрошлом году.
const hardcodedDate = {
  schemaVersion: 1, id: 'c', version: 1,
  manifest: { name: 'Календарь', icon: 'x', color: 'rose', locale: 'ru' },
  capabilities: [], state: { lastPeriod: 1738368000000, cycleLength: 28 },
  derived: { next: 'addDays(lastPeriod, cycleLength)' },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Следующие', value: '{{next | date}}' },
    { type: 'DateField', label: 'Начало', bind: 'lastPeriod' },
  ] },
};
assert.match(
  validateSpec(hardcodedDate).ok ? '' : validateSpec(hardcodedDate).errors.join('\n'),
  /hardcoded date/,
);
console.log('Массивы и захардкоженные даты проверены');

// Список дел — самое базовое приложение, какое бывает, и до появления
// галочек и фильтра оно не выражалось вовсе: модель собирала слот на одну
// задачу, потому что отметить пункт выполненным было нечем.
const todo = {
  schemaVersion: 1, id: 'todo', version: 1,
  manifest: { name: 'Мои задачи', icon: 'checklist', color: 'blue', locale: 'ru' },
  capabilities: [],
  state: { draft: '' },
  records: { fields: [
    { key: 'title', label: 'Задача', kind: 'text' },
    { key: 'done', label: 'Выполнено', kind: 'number' },
  ], valueField: 'done' },
  derived: { left: 'recordCount - sum(recordValues)' },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Осталось', value: '{{left | integer}}' },
    { type: 'TextField', label: 'Новая задача', bind: 'draft' },
    { type: 'Button', title: 'Добавить', variant: 'primary', disabled: "draft == ''",
      onPress: [
        { action: 'records.add', values: { title: '{{draft}}', done: 0 } },
        { action: 'state.set', key: 'draft', value: '' },
      ] },
    { type: 'List', titleKey: 'title', checkKey: 'done', filter: '!item_done', showDate: false },
    { type: 'List', titleKey: 'title', checkKey: 'done', filter: 'item_done', showDate: false,
      itemActions: [
        { title: 'Вернуть', onPress: [{ action: 'records.update', id: '{{itemId}}', values: { done: 0 } }] },
      ] },
  ] },
};
const todoResult = validateSpec(todo);
assert.ok(todoResult.ok, `список дел должен собираться: ${todoResult.ok ? '' : todoResult.errors.join(' | ')}`);
assert.ok(smokeTest(todoResult.spec).ok, 'список дел должен проходить прогон');

// Слот вместо списка — ровно то, что модель делала до появления галочек.
const slot = {
  ...todo,
  state: { draft: '', currentTask: '' },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Выполнено', value: '{{recordCount | integer}}' },
    { type: 'Text', value: 'Задача: {{currentTask}}' },
    { type: 'Button', title: 'Завершить', variant: 'primary',
      onPress: [{ action: 'records.add', values: { title: '{{currentTask}}', done: 1 } }] },
    { type: 'List', titleKey: 'title', showDate: false },
  ] },
};
assert.match(
  validateSpec(slot).ok ? '' : validateSpec(slot).errors.join('\n'),
  /do not model a list as a single item in state/,
);
console.log('Список дел и защита от слота проверены');

// Свой виджет: когда готового компонента нет, модель строит недостающее
// песочницей внутри обычного экрана, а не подделывает существующими блоками.
const drawing = {
  schemaVersion: 1, id: 'sketch', version: 1,
  manifest: { name: 'Скетчбук', icon: 'brush', color: 'violet', locale: 'ru' },
  capabilities: ['sandbox'],
  state: { strokes: 0, color: 'black' },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Штрихов', value: '{{strokes | integer}}' },
    { type: 'Select', label: 'Цвет', bind: 'color', options: [
      { value: 'black', label: 'Чёрный' }, { value: 'red', label: 'Красный' },
    ] },
    { type: 'Sandbox', height: 260,
      html: '<canvas id="c"></canvas><script>toolkin.onState(function(s){});document.addEventListener("touchmove",function(){toolkin.set("strokes",1)});</script>' },
    { type: 'Button', title: 'Очистить', onPress: [{ action: 'state.set', key: 'strokes', value: 0 }] },
  ] },
};
const drawingResult = validateSpec(drawing);
assert.ok(drawingResult.ok, `виджет должен собираться: ${drawingResult.ok ? '' : drawingResult.errors.join(' | ')}`);
assert.ok(smokeTest(drawingResult.spec).ok);

// Виджет, не связанный с состоянием, — картинка, а не часть утилиты.
const isolated = JSON.parse(JSON.stringify(drawing));
isolated.ui.children[2].html = '<canvas id="c"></canvas><script>document.addEventListener("touchmove",function(){});</script>';
assert.match(
  validateSpec(isolated).ok ? '' : validateSpec(isolated).errors.join('\n'),
  /never touches toolkin/,
);
console.log('Собственный виджет проверен');
