import assert from 'node:assert';
import { validateSpec } from './src/lib/validateSpec';
import { autofix } from './src/lib/autofix';
import { normalizeGeneratedSpec } from './src/lib/normalizeGeneratedSpec';
import { smokeTest } from './src/lib/smokeTest';
import { checkFeatures } from './src/lib/featureCheck';
import type { Feature, Plan } from './src/app/api/_plan';
import { createLocalPlan, normalizePlanCandidate, planForFeatures } from './src/app/api/_plan';
import { toGeminiRestThinkingLevel, toResponseJsonSchema } from './src/app/api/_shared';
import { PIPELINE_VERSION, cacheKey } from './src/lib/specCacheKey';
import { buildGeneratePrompt, buildSystemInstruction } from './src/app/api/_prompt';
import { creditsForProduct } from './src/lib/pricing';
import { signPlanToken, verifyPlanToken } from './src/lib/planToken';
import { DEMO_SPECS } from './src/lib/exampleSpecs';
import type { MiniAppSpec } from './src/lib/specTypes';

const validationErrors = (result: ReturnType<typeof validateSpec>): string => result.ok ? '' : result.errors.join('\n');


// Planner transport: OpenAPI-style schema is converted to the current Gemini
// responseJsonSchema format instead of using the deprecated responseSchema field.
const convertedSchema = toResponseJsonSchema({
  type: 'OBJECT', properties: { features: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 1 } },
  required: ['features'], propertyOrdering: ['features'],
});
assert.strictEqual(convertedSchema.type, 'object');
assert.strictEqual(((convertedSchema.properties as any).features as any).type, 'array');
assert.strictEqual((((convertedSchema.properties as any).features as any).items as any).type, 'string');
assert.strictEqual(toGeminiRestThinkingLevel('medium'), 'MEDIUM');
assert.strictEqual(toGeminiRestThinkingLevel('high'), 'HIGH');

// A JSON-only planner fallback is normalized just as strictly as structured
// output: unknown implementation hints are dropped and a usable plan survives.
const fallbackCandidate = normalizePlanCandidate({
  kind: 'tracker', title: 'Трекер воды', summary: 'Следить за водой', navigation: 'stack',
  screens: [{ id: 'home', title: 'Сегодня', purpose: 'Добавление' }, { id: 'history', title: 'История', purpose: 'История' }],
  customComponents: [], needsRecords: true, needsStructuredAi: false,
  capabilities: ['notifications', 'made-up-capability'], components: ['Button', 'Ghost'],
  features: [{ id: 'add', title: 'Добавлять воду', description: 'Сохраняет порцию', essential: true,
    acceptanceCriteria: ['Порция появляется в истории'], requiresRecords: true, requiresStructuredAi: false,
    requiresComponents: ['Button', 'Ghost'], requiresActions: ['records.add', 'fly'], requiresCapabilities: [] }],
});
assert.ok(fallbackCandidate);
assert.deepStrictEqual(fallbackCandidate?.components, ['Button']);
assert.deepStrictEqual(fallbackCandidate?.features[0].requiresActions, ['records.add']);
assert.ok(!fallbackCandidate?.capabilities.includes('made-up-capability'));

// Even if both AI planner attempts are unavailable/malformed, the mandatory
// review screen can still be populated with a conservative, signed plan.
const localPlan = createLocalPlan('трекер расходов');
assert.strictEqual(localPlan.features.length, 1);
assert.strictEqual(localPlan.features[0].essential, true);
assert.strictEqual(localPlan.kind, 'tracker');

for (const spec of DEMO_SPECS) {
  const result = validateSpec(spec);
  assert.ok(result.ok, `${spec.id}: ${result.ok ? '' : result.errors.join(' | ')}`);
  const smoke = smokeTest(spec);
  assert.ok(smoke.ok, `${spec.id} smoke: ${smoke.issues.join(' | ')}`);
}
console.log('V2 demo specs validate and execute');

// There is intentionally no v1 compatibility layer.
const v1 = { ...DEMO_SPECS[0], schemaVersion: 1 };
assert.ok(!validateSpec(v1).ok, 'schemaVersion 1 must be rejected');

const bad = validateSpec({
  ...DEMO_SPECS[0],
  capabilities: [],
  screens: { home: { type: 'Screen', children: [
    { type: 'Ghost' },
    { type: 'Slider', label: 'X', bind: 'nope' },
    { type: 'Button', title: 'x', onPress: [{ action: 'clipboard.set', value: '1' }, { action: 'fly' }] },
  ] } },
});
assert.ok(!bad.ok);
const badJoined = validationErrors(bad);
assert.match(badJoined, /component "Ghost" does not exist/);
assert.match(badJoined, /bind="nope" is not declared in state/);
assert.match(badJoined, /requires capability "clipboard"/);
assert.match(badJoined, /action "fly" does not exist/);

// Regression for the production failure from 2026-08-12: the model used
// collection "log" in an action but forgot to declare it.
const missingLog = {
  schemaVersion: 2,
  id: 'analysis-log', version: 1,
  manifest: { name: 'Анализ', icon: 'chart', color: 'blue', locale: 'ru' },
  capabilities: [], state: { score: 5, note: '' },
  screens: { analysis: { type: 'Screen', children: [
    { type: 'Button', title: 'Сохранить', onPress: [
      { action: 'records.add', collection: 'log', values: { score: '{{score}}', note: '{{note}}' } },
    ] },
    { type: 'Repeat', source: 'records', collection: 'log', as: 'entry', empty: 'Пока пусто', children: [
      { type: 'Text', value: '{{entryScore | number}}' },
    ] },
  ] } },
  navigation: { start: 'analysis', mode: 'single' },
};
const beforeNormalize = validateSpec(missingLog);
assert.ok(!beforeNormalize.ok);
assert.match(validationErrors(beforeNormalize), /undeclared collection "log"|collection "log" is not declared/);
const normalizedLog = normalizeGeneratedSpec(missingLog);
assert.ok(normalizedLog.applied.some((x) => x.includes('collection log')));
const afterNormalize = validateSpec(normalizedLog.spec);
assert.ok(afterNormalize.ok, afterNormalize.ok ? '' : afterNormalize.errors.join(' | '));
const logSpec = afterNormalize.ok ? afterNormalize.spec : null;
assert.strictEqual(logSpec?.collections?.log.fields.find((f) => f.key === 'score')?.kind, 'number');
console.log('Missing named collection is deterministically recovered before validation');

// Missing collection argument is only autofilled when there is exactly one
// declared collection, so normalization never guesses between two data sets.
const oneCollection = JSON.parse(JSON.stringify(DEMO_SPECS[2]));
oneCollection.screens.home.children[2].onPress[0].collection = undefined;
const oneFixed = normalizeGeneratedSpec(oneCollection);
assert.strictEqual((oneFixed.spec as any).screens.home.children?.[2]?.onPress?.[0]?.collection, 'drinks');
assert.ok(validateSpec(oneFixed.spec).ok);

const twoCollections = JSON.parse(JSON.stringify(DEMO_SPECS[2]));
twoCollections.collections.second = { fields: [{ key: 'value', label: 'Value', kind: 'number' }], valueField: 'value' };
twoCollections.screens.home.children[2].onPress[0].collection = undefined;
const ambiguous = normalizeGeneratedSpec(twoCollections);
assert.ok(!validateSpec(ambiguous.spec).ok, 'ambiguous missing collection must not be guessed');

// Record actions/components are strict about named collections.
const unknownList = JSON.parse(JSON.stringify(DEMO_SPECS[2]));
unknownList.screens.home.children[4].collection = 'ghost';
assert.match(validationErrors(validateSpec(unknownList)), /collection "ghost" is not declared/);

// AI wiring: paid actions must expose busy state and typed numeric values must
// use structured fields rather than free text.
const aiSpec: MiniAppSpec = {
  schemaVersion: 2, id: 'recipe-gen', version: 1,
  manifest: { name: 'Рецепты', icon: 'chef-hat', color: 'green', locale: 'ru' },
  capabilities: ['llm'], state: { products: '', recipe: '' },
  screens: { home: { type: 'Screen', children: [
    { type: 'TextField', label: 'Продукты', bind: 'products', multiline: true },
    { type: 'Button', title: 'Придумать', variant: 'primary', disabled: 'llmBusy', onPress: [
      { action: 'llm.ask', prompt: 'Рецепт из: {{products}}', into: 'recipe' },
    ] },
    { type: 'Text', value: '{{recipe}}', visible: "recipe != ''" },
  ] } },
  navigation: { start: 'home', mode: 'single' },
};
assert.ok(validateSpec(aiSpec).ok);
const noBusy = JSON.parse(JSON.stringify(aiSpec));
delete noBusy.screens.home.children[1].disabled;
assert.match(validationErrors(validateSpec(noBusy)), /llmBusy/);

const kbju: MiniAppSpec = {
  schemaVersion: 2, id: 'kbju', version: 1,
  manifest: { name: 'КБЖУ', icon: 'camera', color: 'amber', locale: 'ru' },
  capabilities: ['camera', 'llm'], state: { photo: '', result: '' },
  collections: { meals: { fields: [
    { key: 'photo', label: 'Фото', kind: 'image' },
    { key: 'kcal', label: 'Ккал', kind: 'number' },
  ], valueField: 'kcal' } },
  screens: { home: { type: 'Screen', children: [
    { type: 'Button', title: 'Камера', disabled: 'llmBusy', onPress: [{ action: 'camera.capture', into: 'photo', source: 'camera' }] },
    { type: 'Button', title: 'Анализ', disabled: 'llmBusy', onPress: [
      { action: 'llm.ask', prompt: 'Оцени блюдо', image: 'photo', into: 'result' },
      { action: 'records.add', collection: 'meals', values: { photo: '{{photo}}', kcal: '{{result}}' } },
    ] },
    { type: 'Text', value: '{{result}}' },
    { type: 'List', collection: 'meals', valueKey: 'kcal', imageKey: 'photo' },
  ] } },
  navigation: { start: 'home', mode: 'single' },
};
const kbjuResult = validateSpec(kbju);
assert.ok(!kbjuResult.ok);
assert.match(validationErrors(kbjuResult), /free-text llm\.ask/);

// Sandbox stays isolated and every record save names its collection.
const game: MiniAppSpec = {
  schemaVersion: 2, id: 'snake', version: 1,
  manifest: { name: 'Змейка', icon: 'device-gamepad', color: 'green', locale: 'ru' },
  capabilities: ['sandbox'], state: { best: 0 },
  collections: { scores: { fields: [{ key: 'score', label: 'Очки', kind: 'number' }], valueField: 'score' } },
  screens: { home: { type: 'Screen', children: [
    { type: 'Stat', label: 'Рекорд', value: '{{best | integer}}' },
    { type: 'Sandbox', ratio: 'square', html: '<canvas id="g"></canvas><script>document.addEventListener("touchstart",function(){toolkin.save({score:10},"scores")});</script>' },
  ] } },
  navigation: { start: 'home', mode: 'single' },
};
assert.ok(validateSpec(game).ok);
const remote = JSON.parse(JSON.stringify(game));
remote.screens.home.children[1].html = '<script src="https://cdn.example.com/x.js"></script><canvas onclick="x()"></canvas>';
assert.match(validationErrors(validateSpec(remote)), /external scripts/);

// Custom component + Repeat + CRUD scenario.
const expenses: MiniAppSpec = {
  schemaVersion: 2, id: 'expenses-v2', version: 1,
  manifest: { name: 'Расходы', icon: 'wallet', color: 'green', locale: 'ru' },
  capabilities: [], state: { amount: 100, category: 'Еда' },
  collections: { expenses: { fields: [
    { key: 'amount', label: 'Сумма', kind: 'number' }, { key: 'category', label: 'Категория', kind: 'text' },
  ], valueField: 'amount' } },
  derived: { total: 'sumBy(records, "expenses", "amount")' },
  components: {
    ExpenseCard: { props: [
      { name: 'id', kind: 'text', required: true }, { name: 'amount', kind: 'value', required: true }, { name: 'category', kind: 'text', required: true },
    ], template: { type: 'Card', children: [
      { type: 'Text', value: '{{category}}' }, { type: 'Text', value: '{{amount | number}}' },
      { type: 'Button', title: 'Удалить', onPress: [{ action: 'records.remove', id: '{{id}}' }] },
    ] } },
  },
  screens: {
    home: { type: 'Screen', children: [
      { type: 'Stat', label: 'Всего', value: '{{total | number}}' },
      { type: 'NumberField', label: 'Сумма', bind: 'amount' },
      { type: 'Button', title: 'Добавить', onPress: [{ action: 'records.add', collection: 'expenses', values: { amount: '{{amount}}', category: '{{category}}' } }] },
      { type: 'Button', title: 'История', onPress: [{ action: 'nav.go', screen: 'history' }] },
    ] },
    history: { type: 'Screen', children: [
      { type: 'Repeat', source: 'records', collection: 'expenses', as: 'expense', empty: 'Пока пусто', children: [
        { type: 'ExpenseCard', props: { id: '{{expenseId}}', amount: '{{expenseAmount}}', category: '{{expenseCategory}}' } },
      ] },
      { type: 'Button', title: 'Назад', onPress: [{ action: 'nav.back' }] },
    ] },
  },
  navigation: { start: 'home', mode: 'stack', titles: { home: 'Расходы', history: 'История' } },
};
const expenseValidation = validateSpec(expenses);
assert.ok(expenseValidation.ok, expenseValidation.ok ? '' : expenseValidation.errors.join(' | '));
assert.ok(smokeTest(expenses).ok, smokeTest(expenses).issues.join(' | '));

// when=false must not execute an action in the simulator.
const conditional = JSON.parse(JSON.stringify(DEMO_SPECS[0]));
conditional.screens.home.children = [
  { type: 'Text', value: '{{bill | number}}' },
  { type: 'Button', title: 'Не менять', onPress: [{ action: 'state.set', key: 'bill', value: 99, when: 'false' }, { action: 'toast', text: 'ok' }] },
];
assert.ok(smokeTest(conditional).ok, smokeTest(conditional).issues.join(' | '));

// Feature acceptance contract is exact; no loose component equivalence.
const promised: Feature[] = [
  { id: 'predict', title: 'Прогноз цикла', description: '', essential: true, acceptanceCriteria: ['Календарь показывает прогноз'], requiresComponents: ['Calendar'], requiresActions: [], requiresCapabilities: [] },
  { id: 'remind', title: 'Напоминание', description: '', essential: false, acceptanceCriteria: ['Можно запланировать напоминание'], requiresComponents: [], requiresActions: ['notify.at'], requiresCapabilities: ['notifications'] },
];
const complete: MiniAppSpec = {
  schemaVersion: 2, id: 'cycle', version: 1,
  manifest: { name: 'Календарь', icon: 'calendar', color: 'rose', locale: 'ru' },
  capabilities: ['notifications'], state: { selected: 1, at: 1 },
  screens: { home: { type: 'Screen', children: [
    { type: 'Calendar', bind: 'selected' },
    { type: 'Button', title: 'Напомнить', onPress: [{ action: 'notify.at', title: 'Скоро', at: '{{at}}' }] },
  ] } },
  navigation: { start: 'home', mode: 'single' },
  featureEvidence: {
    predict: { screens: ['home'], components: ['Calendar'] },
    remind: { screens: ['home'], actions: ['notify.at'], capabilities: ['notifications'] },
  },
};
assert.ok(checkFeatures(complete, promised).ok);
const noReminder = JSON.parse(JSON.stringify(complete));
noReminder.screens.home.children.pop(); noReminder.capabilities = [];
assert.ok(!checkFeatures(noReminder, promised).ok);

// Immutable Product Plan is mandatory and feature deselection recomputes requirements.
process.env.TOOLKIN_PLAN_SECRET = 'test-plan-secret-not-for-production';
const tokenPlan: Plan = {
  kind: 'tracker', title: 'Расходы', summary: 'Учёт расходов', navigation: 'stack',
  screens: [{ id: 'home', title: 'Главная', purpose: 'Сводка' }, { id: 'history', title: 'История', purpose: 'Записи' }],
  customComponents: [], capabilities: [], components: ['List'], needsRecords: true, needsStructuredAi: false,
  features: [{ id: 'add', title: 'Добавление', description: 'Добавить расход', essential: true,
    acceptanceCriteria: ['Расход сохраняется'], requiresRecords: true, requiresStructuredAi: false,
    requiresComponents: [], requiresActions: ['records.add'], requiresCapabilities: [] }],
};
const signed = signPlanToken('трекер расходов', 'ru', tokenPlan);
assert.deepStrictEqual(verifyPlanToken(signed, 'трекер расходов', 'ru'), tokenPlan);
assert.strictEqual(verifyPlanToken(signed, 'другой запрос', 'ru'), null);
assert.strictEqual(verifyPlanToken(`${signed.slice(0, -1)}x`, 'трекер расходов', 'ru'), null);
const deselected = planForFeatures(tokenPlan, []);
assert.strictEqual(deselected.needsRecords, false);

// Prompt itself must encode the strict named-collection invariant.
const promptText = buildGeneratePrompt('трекер расходов', 'ru', tokenPlan);
const systemText = buildSystemInstruction('ru', tokenPlan);
assert.match(systemText, /COLLECTION INVARIANT/);
assert.match(systemText, /explicitly named collection/);
assert.match(promptText, /schemaVersion 2/);
assert.doesNotMatch(systemText, /"records"\s*:/);

// Autofix remains narrow and does not invent product behavior.
const jsHabits = {
  ...DEMO_SPECS[0],
  derived: { tip: 'Math.round(state.bill * state.tipPct / 100)', perPerson: 'tip / Math.max(state.people, 1)' },
};
const fixed = autofix(jsHabits as MiniAppSpec);
assert.deepStrictEqual(Object.values(fixed.spec.derived ?? {}), ['round(bill * tipPct / 100)', 'tip / max(people, 1)']);
assert.ok(validateSpec(fixed.spec).ok);

process.env.TOOLKIN_CREDIT_PACKS = 'credits_100:100,credits_500:550';
assert.strictEqual(creditsForProduct('credits_500'), 550);
assert.strictEqual(creditsForProduct('unknown_pack'), 0);
assert.notStrictEqual(cacheKey('таймер для яиц', 'ru'), cacheKey('таймер для яиц', 'en'));
assert.notStrictEqual(cacheKey('таймер', 'ru'), cacheKey('секундомер', 'ru'));
assert.match(PIPELINE_VERSION, /^v\d+-[0-9a-f]{12}$/);

console.log(`All backend/runtime contract tests passed (${PIPELINE_VERSION})`);
