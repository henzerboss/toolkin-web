import assert from 'node:assert';
import { validateSpec } from './src/lib/validateSpec';
import { autofix } from './src/lib/autofix';
import { normalizeGeneratedSpec } from './src/lib/normalizeGeneratedSpec';
import { smokeTest } from './src/lib/smokeTest';
import { analyzeImplementation, checkFeatures, checkStoredFeatureEvidence } from './src/lib/featureCheck';
import { compileFeatureContracts } from './src/lib/contractCompiler';
import type { Feature, Plan } from './src/app/api/_plan';
import { createLocalPlan, normalizePlanCandidate, planForFeatures } from './src/app/api/_plan';
import { toGeminiRestThinkingLevel, toResponseJsonSchema } from './src/app/api/_shared';
import { PIPELINE_VERSION, cacheKey } from './src/lib/specCacheKey';
import { buildGeneratePrompt, buildRecoveryPrompt, buildSystemInstruction } from './src/app/api/_prompt';
import { interpretAuditPayload } from './src/app/api/_featureVerifier';
import { creditsForProduct } from './src/lib/pricing';
import { signPlanToken, verifyPlanToken } from './src/lib/planToken';
import { DEMO_SPECS } from './src/lib/exampleSpecs';
import type { MiniAppSpec } from './src/lib/specTypes';

const validationErrors = (result: ReturnType<typeof validateSpec>): string => result.ok ? '' : result.errors.join('\n');


// Structured transport: repository schemas are normalized to lowercase JSON Schema
// before being sent in Interactions API response_format.schema.
const convertedSchema = toResponseJsonSchema({
  type: 'OBJECT', properties: { features: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 1 } },
  required: ['features'], propertyOrdering: ['features'],
});
assert.strictEqual(convertedSchema.type, 'object');
assert.strictEqual(((convertedSchema.properties as any).features as any).type, 'array');
assert.strictEqual((((convertedSchema.properties as any).features as any).items as any).type, 'string');
assert.strictEqual((convertedSchema as any).propertyOrdering, undefined);
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

// Regression for the production failure from 2026-08-13. Gemini produced a
// semantically valid meal schema/custom UI using common alternative JSON
// shapes: collection fields as a map, component props as a map/type aliases,
// and template type through component/type objects. Canonicalization must make
// these shapes strict Spec v2 without spending another model call.
const alternateComponentShapes = {
  schemaVersion: 2,
  id: 'meal-tracker-shapes', version: 1,
  manifest: { name: 'Дневник питания', icon: '🍽️', color: 'green', locale: 'ru' },
  capabilities: [],
  state: { progress: 0.5, progressText: '1200 / 2400', mealTitle: 'Омлет', mealKcal: 420 },
  collections: {
    meals: {
      fields: {
        title: { type: 'string', label: 'Блюдо' },
        kcal: { type: 'number', label: 'Ккал' },
        photo: 'image',
      },
      valueKey: 'kcal',
    },
  },
  components: {
    DailyProgressRing: {
      props: { progress: 'number', value: 'string', label: 'text' },
      template: { component: 'ProgressRing', props: { progress: '{{progress}}', value: '{{value}}', label: '{{label}}' } },
    },
    FoodEntryCard: {
      props: [
        { key: 'title', type: 'string', required: true },
        { name: 'kcal', type: 'number', required: true },
        'subtitle',
        { name: 'recordId', type: 'value' },
      ],
      template: {
        type: { name: 'Card' },
        children: [
          { type: 'Text', value: '{{title}}' },
          { type: 'Text', value: '{{kcal | integer}} kcal' },
        ],
      },
    },
  },
  screens: {
    home: { type: 'Screen', children: [
      { type: 'DailyProgressRing', props: { progress: '{{progress}}', value: '{{progressText}}', label: 'Сегодня' } },
      { type: 'FoodEntryCard', title: '{{mealTitle}}', kcal: '{{mealKcal}}', subtitle: 'Завтрак', recordId: 'demo' },
    ] },
  },
  navigation: { start: 'home', mode: 'single' },
};
const alternateNormalized = normalizeGeneratedSpec(alternateComponentShapes);
const alternateSpec = alternateNormalized.spec as MiniAppSpec;
assert.ok(Array.isArray(alternateSpec.collections?.meals.fields));
assert.strictEqual(alternateSpec.collections?.meals.fields.find((f) => f.key === 'kcal')?.kind, 'number');
assert.strictEqual(alternateSpec.collections?.meals.valueField, 'kcal');
assert.ok(Array.isArray(alternateSpec.components?.DailyProgressRing.props));
assert.strictEqual(alternateSpec.components?.DailyProgressRing.template.type, 'ProgressRing');
assert.ok(Array.isArray(alternateSpec.components?.FoodEntryCard.props));
assert.strictEqual(alternateSpec.components?.FoodEntryCard.template.type, 'Card');
const alternateValidation = validateSpec(alternateSpec);
assert.ok(alternateValidation.ok, alternateValidation.ok ? '' : alternateValidation.errors.join(' | '));
console.log('Alternate collection/custom-component JSON shapes canonicalize to strict Spec v2');


// Regression for the next production failure: recoverable model slips must be
// normalized/autofixed BEFORE the strict validator, otherwise the repair loop
// rejects exactly the errors that deterministic code already knows how to fix.
const recoverable = JSON.parse(JSON.stringify(DEMO_SPECS[0]));
delete recoverable.state.bill;
recoverable.derived.total = 'Math.round(state.bill + state.bill * state.tipPct / 100)';
recoverable.capabilities = [];
delete recoverable.screens.home.children[0].label;
recoverable.screens.home.children[4].children.push({ type: 'Text', value: 'hint' }, { type: 'Text', value: 'hint2' });
recoverable.screens.home.children[4].onPress = undefined;
recoverable.screens.home.children[4].children[0].onPress = { action: 'clipboard.set', value: '{{perPerson | money}}' };
recoverable.navigation = { start: 'ghost', mode: 'tabs', tabs: [{ screen: 'ghost', label: 'Ghost' }] };
const recoveredNormalized = normalizeGeneratedSpec(recoverable);
const recoveredAutofixed = autofix(recoveredNormalized.spec as MiniAppSpec);
const recoveredValidation = validateSpec(recoveredAutofixed.spec);
assert.ok(recoveredValidation.ok, recoveredValidation.ok ? '' : recoveredValidation.errors.join(' | '));
assert.ok((recoveredAutofixed.spec.capabilities ?? []).includes('clipboard'));
assert.ok('bill' in recoveredAutofixed.spec.state);
assert.strictEqual(recoveredAutofixed.spec.navigation.start, 'home');
assert.strictEqual(recoveredAutofixed.spec.navigation.mode, 'single');
assert.strictEqual((recoveredAutofixed.spec.screens.home.children?.[4] as any).wrap, true);
console.log('Recoverable generation slips are fixed before hard validation');

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
assert.ok(checkStoredFeatureEvidence(complete, promised).ok);

// Builder-authored evidence is not a contract anymore. If it goes stale after a
// repair, strict reachable requirements still pass and the semantic auditor will
// regenerate evidence from the actual app instead of rejecting a working flow.
const staleEvidence = JSON.parse(JSON.stringify(complete));
staleEvidence.featureEvidence.predict = { components: ['GhostCalendar'], actions: ['fly'] };
assert.ok(checkFeatures(staleEvidence, promised).ok);
assert.ok(!checkStoredFeatureEvidence(staleEvidence, promised).ok);

// Core List has a real runtime delete affordance even though the generated JSON
// does not contain records.remove. Mechanical feature inventory must model that
// implicit behaviour or it falsely rejects a perfectly working history screen.
const listDeleteSpec = JSON.parse(JSON.stringify(DEMO_SPECS[2])) as MiniAppSpec;
const listDeleteFeature: Feature[] = [{
  id: 'delete-history', title: 'Удаление', description: '', essential: true,
  acceptanceCriteria: ['Пользователь может удалить ошибочную запись'],
  requiresComponents: ['List'], requiresActions: ['records.remove'], requiresCapabilities: [],
}];
const listDeleteInventory = analyzeImplementation(listDeleteSpec);
assert.ok(listDeleteInventory.actions.has('records.remove'));
assert.ok(checkFeatures(listDeleteSpec, listDeleteFeature).ok);

// Product-contract compiler regression: a visually plausible tracker with no
// actual data-flow must be wired deterministically instead of burning builder
// repair rounds. This mirrors the production failure class where scanner fields,
// progress and history existed but camera/AI/save/aggregate bindings did not.
const unwiredTracker: MiniAppSpec = {
  schemaVersion: 2, id: 'unwired-tracker', version: 1,
  manifest: { name: 'Питание', icon: 'camera', color: 'green', locale: 'ru' },
  capabilities: ['camera', 'llm'],
  state: { photo: '', dish: '', kcal: 0, protein: 0, fat: 0, carbs: 0, dailyGoal: 2000, progress: 0, totalKcal: 0 },
  collections: { meals: { fields: [
    { key: 'photo', label: 'Фото', kind: 'image' },
    { key: 'dish', label: 'Блюдо', kind: 'text' },
    { key: 'kcal', label: 'Ккал', kind: 'number' },
    { key: 'protein', label: 'Белки', kind: 'number' },
    { key: 'fat', label: 'Жиры', kind: 'number' },
    { key: 'carbs', label: 'Углеводы', kind: 'number' },
  ], valueField: 'kcal' } },
  screens: {
    home: { type: 'Screen', children: [
      { type: 'Stat', label: 'Калории', value: '{{totalKcal | number}}' },
      { type: 'ProgressBar', progress: 'progress' },
      { type: 'Repeat', source: 'records', as: 'meal', empty: 'Пока пусто', children: [{ type: 'Text', value: '{{mealKcal | number}}' }] },
      { type: 'Button', title: 'Добавить', onPress: [{ action: 'nav.go', screen: 'scanner' }] },
    ] },
    scanner: { type: 'Screen', children: [
      { type: 'Image', source: 'photo', ratio: 'square' },
      { type: 'TextField', label: 'Блюдо', bind: 'dish' },
      { type: 'NumberField', label: 'Ккал', bind: 'kcal' },
      { type: 'NumberField', label: 'Белки', bind: 'protein' },
      { type: 'NumberField', label: 'Жиры', bind: 'fat' },
      { type: 'NumberField', label: 'Углеводы', bind: 'carbs' },
      { type: 'Button', title: 'Назад', onPress: [{ action: 'nav.back' }] },
    ] },
  },
  navigation: { start: 'home', mode: 'stack' },
};
const unwiredPlan: Plan = {
  kind: 'tracker', title: 'Питание', summary: 'Анализ и учёт', navigation: 'stack',
  screens: [{ id: 'home', title: 'Сегодня', purpose: 'Сводка' }, { id: 'scanner', title: 'Добавить', purpose: 'Фото и подтверждение' }],
  customComponents: [], capabilities: ['camera', 'llm'], components: ['Stat', 'ProgressBar', 'Repeat'], needsRecords: true, needsStructuredAi: true,
  features: [
    { id: 'ai-food', title: 'Анализ фото', description: 'Распознать данные и дать исправить', essential: true,
      acceptanceCriteria: ['Фото анализируется', 'Данные можно исправить перед сохранением'], requiresRecords: true, requiresStructuredAi: true,
      requiresComponents: [], requiresActions: ['camera.capture', 'llm.ask', 'records.add'], requiresCapabilities: ['camera', 'llm'] },
    { id: 'progress', title: 'Прогресс', description: 'Живая сумма и прогресс', essential: true,
      acceptanceCriteria: ['Сумма обновляется', 'Прогресс обновляется'], requiresRecords: true, requiresStructuredAi: false,
      requiresComponents: ['Stat', 'ProgressBar'], requiresActions: [], requiresCapabilities: [] },
    { id: 'history', title: 'История', description: 'Список и удаление', essential: true,
      acceptanceCriteria: ['Записи видны', 'Запись можно удалить'], requiresRecords: true, requiresStructuredAi: false,
      requiresComponents: ['Repeat'], requiresActions: ['records.remove'], requiresCapabilities: [] },
  ],
};
const contractedTracker = compileFeatureContracts(unwiredTracker, unwiredPlan);
const contractedNormalized = normalizeGeneratedSpec(contractedTracker.spec);
const contractedFixed = autofix(contractedNormalized.spec as MiniAppSpec);
const contractedValidation = validateSpec(contractedFixed.spec);
assert.ok(contractedValidation.ok, contractedValidation.ok ? '' : contractedValidation.errors.join(' | '));
const contractedInventory = analyzeImplementation(contractedFixed.spec);
for (const action of ['camera.capture', 'llm.ask', 'records.add', 'records.remove']) assert.ok(contractedInventory.actions.has(action), `missing compiled action ${action}`);
assert.ok(Object.values(contractedFixed.spec.derived ?? {}).some((expression) => expression.includes('sumBy(records, "meals", "kcal")')));
assert.ok((contractedFixed.spec.screens.home.children ?? []).some((node) => node.type === 'Repeat' && node.collection === 'meals'));
assert.ok(smokeTest(contractedFixed.spec).ok, smokeTest(contractedFixed.spec).issues.join(' | '));
console.log('Product contract compiler wires records, structured AI, progress and history');

// Semantic verifier regression: the auditor now evaluates criteria independently.
// This prevents contradictory feature-level answers ("the summary is reactive"
// while simultaneously listing the same criterion as missing) from discarding a
// valid app. Evidence is still restricted to the actual reachable inventory.
const criterionAudit = interpretAuditPayload({ results: [
  { id: 'predict', criteria: [
    { index: 0, implemented: true, reason: 'Calendar visibly shows the forecast', screens: ['home'], components: ['Calendar'], actions: [], capabilities: [] },
  ] },
  { id: 'remind', criteria: [
    { index: 0, implemented: true, reason: 'Reachable button schedules the notification', screens: ['home'], components: ['Button'], actions: ['notify.at'], capabilities: ['notifications'] },
  ] },
] }, complete, promised, analyzeImplementation(complete));
assert.ok(criterionAudit.ok, criterionAudit.issues.join(' | '));
assert.deepStrictEqual(criterionAudit.implemented.sort(), ['predict', 'remind']);

const incompleteAudit = interpretAuditPayload({ results: [
  { id: 'predict', criteria: [] },
] }, complete, promised, analyzeImplementation(complete));
assert.ok(!incompleteAudit.ok);
assert.strictEqual(incompleteAudit.unavailable, true, 'incomplete QA output is verifier failure, not feature failure');

// Reachability matters: unused custom definitions and orphan screens must not
// satisfy a feature. Instantiated custom components are expanded so actions in
// their templates count on the calling screen.
const reachableComposite = JSON.parse(JSON.stringify(expenses));
reachableComposite.components.UnusedCamera = { template: { type: 'Button', title: 'Ghost', onPress: [{ action: 'camera.capture', into: 'photo', source: 'camera' }] } };
reachableComposite.capabilities = ['camera'];
const reachableInventory = analyzeImplementation(reachableComposite);
assert.ok(reachableInventory.components.has('ExpenseCard'));
assert.ok(reachableInventory.actions.has('records.remove'));
assert.ok(!reachableInventory.components.has('UnusedCamera'));
assert.ok(!reachableInventory.actions.has('camera.capture'));

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
assert.match(systemText, /Core List already renders a per-row delete button/);
const recoveryText = buildRecoveryPrompt(promptText, JSON.stringify(complete), ['missing history delete']);
assert.match(recoveryText, /core List is newest-first and includes per-row deletion/);
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
