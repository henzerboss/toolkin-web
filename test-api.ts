import assert from 'node:assert';
import { validateSpec } from './src/lib/validateSpec';
import { buildSystemInstruction } from './src/app/api/_prompt';
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

const sys = buildSystemInstruction('ru');
assert.ok(sys.includes('Russian') && sys.includes('llm.ask') && sys.includes('ProgressRing'));

console.log('Ошибки для цикла починки:');
bad.errors.forEach((e) => console.log('  •', e));
console.log(`\nСистемный промпт: ${sys.length} символов.`);
console.log('Проверки сайта пройдены.');
