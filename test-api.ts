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
assert.match(joined, /компонента "Ghost" не существует/);
assert.match(joined, /bind="nope" не объявлен в state/);
assert.match(joined, /требует capability "clipboard"/);
assert.match(joined, /экшена "fly" не существует/);

// Пакеты кредитов читаются из переменной окружения, а не из кода.
process.env.TOOLKIN_CREDIT_PACKS = 'credits_100:100,credits_500:550';
assert.strictEqual(creditsForProduct('credits_500'), 550);
assert.strictEqual(creditsForProduct('unknown_pack'), 0);
assert.strictEqual(creditsForProduct(null), 0);

const sys = buildSystemInstruction('ru');
assert.ok(sys.includes('Russian') && sys.includes('llm.ask') && sys.includes('ProgressRing'));

console.log('Ошибки для цикла починки:');
bad.errors.forEach((e) => console.log('  •', e));
console.log(`\nСистемный промпт: ${sys.length} символов.`);
console.log('Проверки сайта пройдены.');
