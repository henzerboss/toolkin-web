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
