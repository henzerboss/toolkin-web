import {
  BUILTIN_SCOPE,
  FILTER_NAMES,
  FUNCTION_NAMES,
  describeActions,
  describeComponents,
} from '@/lib/dsl';
import type { MiniAppSpec } from '@/lib/specTypes';

/** Совпадает со списком локалей приложения; используется, чтобы модель писала подписи на языке пользователя. */
const LANG_NAME: Record<string, string> = {
  en: 'English', ru: 'Russian', es: 'Spanish', it: 'Italian', pt: 'Portuguese', fr: 'French',
  de: 'German', zh: 'Chinese', ja: 'Japanese', tr: 'Turkish', ko: 'Korean', pl: 'Polish',
  uk: 'Ukrainian', nl: 'Dutch', cs: 'Czech', sr: 'Serbian', hr: 'Croatian', da: 'Danish',
  fi: 'Finnish', sk: 'Slovak', no: 'Norwegian', is: 'Icelandic', az: 'Azerbaijani', sq: 'Albanian',
  am: 'Amharic', hy: 'Armenian', af: 'Afrikaans', eu: 'Basque', bn: 'Bengali', my: 'Burmese',
  bg: 'Bulgarian', hu: 'Hungarian', vi: 'Vietnamese', gl: 'Galician', el: 'Greek', ka: 'Georgian',
  gu: 'Gujarati', zu: 'Zulu', id: 'Indonesian', kk: 'Kazakh', kn: 'Kannada', ca: 'Catalan',
  ky: 'Kyrgyz', km: 'Khmer', lo: 'Lao', lv: 'Latvian', lt: 'Lithuanian', mk: 'Macedonian',
  ms: 'Malay', ml: 'Malayalam', mr: 'Marathi', mn: 'Mongolian', ne: 'Nepali', pa: 'Punjabi',
  rm: 'Romansh', ro: 'Romanian', si: 'Sinhala', sl: 'Slovenian', sw: 'Swahili', th: 'Thai',
  ta: 'Tamil', te: 'Telugu', fil: 'Filipino', hi: 'Hindi', sv: 'Swedish', et: 'Estonian',
  ar: 'Arabic', he: 'Hebrew',
};

export function languageName(locale: string | undefined): string {
  const normalized = (locale ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return LANG_NAME[normalized] ?? 'English';
}

/**
 * Системный промпт написан по-английски намеренно.
 *
 * Дело не в экономии токенов — она здесь копеечная. Дело в примерах: модель
 * копирует из них не только структуру, но и язык подписей. Русские образцы
 * перетягивали вывод на русский даже при явной инструкции писать на языке
 * устройства. Плюс сложные структурные инструкции модели держат надёжнее
 * на английском: таких данных в обучении просто больше.
 *
 * Промпт собирается по частям. Полный текст — четырнадцать тысяч знаков, и
 * правила из его середины терялись. Когда известен план, в промпт попадают
 * только относящиеся к делу разделы, и он становится втрое короче: утилите
 * с камерой незачем читать про таймеры и графики.
 */

/** Разделы-инструкции. Ключи совпадают с тем, что решает этап планирования. */
const PLAYBOOK: Record<string, string[]> = {
  timer: [
    'Timer. There is exactly one per utility and its state lives in built-ins, not in state:',
    '  "derived": { "totalSeconds": "minutes * 60" },',
    '  button: { "action": "timer.start", "seconds": "{{totalSeconds}}", "when": "!timerRunning" }',
    '  display: { "type": "ProgressRing", "progress": "totalSeconds > 0 ? clamp(timerElapsed / totalSeconds, 0, 1) : 0",',
    '             "value": "{{timerRemaining | duration}}" }',
    'Never create your own state field for remaining time — nothing decrements it.',
  ],

  records: [
    'Persistent history always uses an explicitly named collection. Never use an undeclared or implicit/default collection:',
    '  "collections": { "drinks": { "fields": [{ "key": "amount", "label": "Amount", "kind": "number" }], "valueField": "amount" } },',
    'Collection fields MUST be an array of {key,label,kind}; never emit fields as an object/map. kind is exactly number | text | date | image | boolean.',
    '  "derived": { "total": "sumBy(records, \"drinks\", \"amount\")" },',
    '  button: { "action": "records.add", "collection": "drinks", "values": { "amount": "{{portion}}" } }',
    'Every records.add/update/clear must include a literal collection name declared in collections.',
    'Every List/Table/Gallery/PieChart that reads records also names its collection. Repeat with source=records must name collection too.',
    'Use Repeat + app-specific cards when that makes the UX better than a generic List. Use Table only for two or three short columns.',
  ],

  countdown: [
    'NEVER hardcode a date in state. Use 0 and treat it as "not set yet"; take today',
    'from nowMs. A literal timestamp makes the app open on some month of a past year.',
    '',
    'Countdown to a date. The word nowMs turns on a one-second clock:',
    '  "derived": { "left": "max(targetMs - nowMs, 0)", "days": "floor(left / 86400000)" }',
    'A date is a number (timestamp in ms), so DateField, daysBetween and notify.at all',
    'understand it directly:',
    '  { "type": "DateField", "label": "Date", "bind": "birthday" }',
    '  { "action": "notify.at", "title": "Birthday", "body": "{{who}}", "at": "{{birthday}}", "repeat": "yearly" }',
    '',
    'Computed days on a calendar. Expressions support array literals and date helpers:',
    '  range(start, count, step)  arithmetic series — range(periodStart, 5, 86400000) is five days',
    '  addDays(timestamp, days)   shift a date',
    '  startOfDay(timestamp)      midnight, so days compare correctly',
    '  [a, b, c]                  a literal list',
    'A cycle calendar therefore looks like this:',
    '  "state": { "lastPeriod": 0, "cycleLength": 28, "periodLength": 5 },',
    '  "derived": {',
    '    "ovulation": "addDays(lastPeriod, cycleLength - 14)",',
    '    "nextPeriod": "addDays(lastPeriod, cycleLength)",',
    '    "periodDays": "range(lastPeriod, periodLength, 86400000)",',
    '    "fertileDays": "range(addDays(ovulation, -4), 6, 86400000)"',
    '  },',
    '  { "type": "Calendar", "bind": "selectedDate", "marks": [',
    '    { "dates": "periodDays", "color": "#C2385F", "label": "Period" },',
    '    { "dates": "fertileDays", "color": "#6244D6", "label": "Fertile" },',
    '    { "dates": "[ovulation]", "color": "#0E7C7B", "label": "Ovulation" } ] }',
    'Wrap a single date in brackets: marks always expects a list.',
  ],

  random: [
    'Randomness. There is no random() function, only an action:',
    '  { "action": "state.random", "key": "password", "chars": "abc...XYZ0123456789", "length": 16 }',
  ],

  llm: [
    'AI utilities. A model call spends the user credits, so the wiring is strict:',
    '  "state": { "products": "", "recipe": "" },',
    '  button: { "type": "Button", "title": "Suggest a recipe", "variant": "primary",',
    '            "disabled": "llmBusy || products == \'\'",',
    '            "onPress": [{ "action": "llm.ask", "prompt": "Suggest a recipe using: {{products}}.",',
    '                         "into": "recipe" }] }',
    '  waiting: { "type": "Text", "value": "Thinking…", "variant": "caption", "visible": "llmBusy" }',
    '  error:   { "type": "Text", "value": "{{llmError}}", "variant": "caption", "visible": "llmError != null" }',
    '  answer:  { "type": "Text", "value": "{{recipe}}", "visible": "recipe != \'\'" }',
    'Disabling the button via llmBusy is mandatory: without it people tap twice and pay twice.',
  ],

  structuredAi: [
    'Numbers from the model. Free text cannot be stored in a number field:',
    'Number("Calories: 650 kcal") is NaN and the history fills with zeros.',
    'Whenever you need a number, ask for structure instead of text:',
    '  "state": { "kcal": 0, "dish": "" },',
    '  { "action": "llm.ask", "prompt": "Analyse the dish in the photo.", "image": "photo",',
    '    "fields": { "kcal": "calories as a number", "dish": "short dish name" } }',
    'Each key of fields is written into the state key of the same name, already parsed.',
    'Use into only for answers that are genuinely free text — a recipe, an explanation.',
  ],

  camera: [
    'Photo utilities. Capture and analysis are two separate actions so the person sees',
    'the frame before credits are spent:',
    '  "state": { "photo": "", "result": "" },',
    '  { "action": "camera.capture", "into": "photo", "source": "camera" }    — take a photo',
    '  { "action": "camera.capture", "into": "photo", "source": "library" }   — pick from gallery',
    '  show the frame: { "type": "Image", "source": "photo", "ratio": "square" }',
    '  { "action": "llm.ask", "prompt": "Estimate the calories.", "image": "photo", "fields": {...} }',
    '',
    'Photos in history. Put the photo and analysis into one explicitly named collection and display it as an image:',
    '  "collections": { "meals": { "fields": [{ "key": "photo", "label": "Photo", "kind": "image" },',
    '                          { "key": "kcal", "label": "Kcal", "kind": "number" }], "valueField": "kcal" } },',
    '  { "action": "records.add", "collection": "meals", "values": { "photo": "{{photo}}", "kcal": "{{kcal}}" } }',
    '  { "type": "Gallery", "collection": "meals", "imageKey": "photo", "columns": 3 }',
  ],

  image: [
    'Image generation:',
    '  { "action": "image.generate", "prompt": "{{idea}}, minimal, flat style",',
    '    "into": "picture", "aspect": "square" }',
    '  { "type": "Image", "source": "picture", "ratio": "square", "empty": "Your picture appears here" }',
    'Write the static part of an image prompt in English — the generator understands',
    'nothing else. User input inside {{...}} is translated by the server automatically.',
    'Disable the button via llmBusy here too: the waiting state is shared.',
  ],

  charts: [
    'Charts are chosen by the task, not by taste:',
    '  Chart      — bars from an explicit array expression, e.g. valuesBy(records, "weights", "value")',
    '  LineChart  — change over time from an explicit array expression',
    '  PieChart   — split a named collection: { "collection": "expenses", "groupBy": "category", "valueKey": "amount" }',
    '  Calendar   — month grid; when showing record dots include collection + dateKey, while computed marks need no collection.',
    'Record-backed visualizations stay empty unless the named collection and fields are declared correctly.',
  ],

  game: [
    'This is a game, so the whole game is ONE Sandbox node. Not a board of Buttons:',
    'buttons cannot have an opponent, cannot animate and cannot use randomness.',
    '  { "type": "Sandbox", "ratio": "square", "html": "<canvas id=g></canvas><script>…</script>" }',
    'The html must be fully self-contained: no external scripts, no fetch, no CDN links —',
    'the sandbox has no network. Use the CSS variables --bg, --surface, --text, --accent',
    'so the game matches the app theme. Handle touch, not mouse: touchstart and touchmove.',
    'Bridges available inside (all return promises):',
    '  toolkin.save({score: 12}, "scores") append an entry to a declared named collection',
    '  toolkin.set("best", 12)          write a state key',
    '  toolkin.get("best")              read a state key or derived value',
    '  toolkin.ask(prompt, fields)      ask the model, spends credits, needs the llm capability',
    '  toolkin.capture("camera")        take a photo, needs the camera capability',
    '  toolkin.image(prompt, "square")  generate a picture, needs the image capability',
    '  toolkin.notify(title, body, sec) local notification, needs notifications',
    '  toolkin.locale                   device locale string',
    'Declare the capability in the spec for every bridge you use — the same permission',
    'check applies inside the sandbox as outside it.',
    'Feasible: snake, breakout, pong, air hockey, tetris, 2048, minesweeper, memory, simon,',
    'sliding puzzle, tic-tac-toe with an opponent, connect four, sokoban, flappy, solitaire.',
    'Not feasible: online multiplayer, sprite or audio files, heavy 3D. Keep html under 60000 chars.',
    'Outside the sandbox keep only the score, the best result and the history.',
  ],
};

interface PromptPlan {
  kind: string;
  capabilities: string[];
  components: string[];
  needsRecords: boolean;
  needsStructuredAi: boolean;
  summary: string;
  title: string;
  navigation?: 'single' | 'stack' | 'tabs';
  screens?: { id: string; title: string; purpose: string }[];
  customComponents?: { name: string; purpose: string; strategy: 'compose' | 'extend' }[];
  features?: { id: string; title: string; description: string; acceptanceCriteria?: string[] }[];
}

/** Какие разделы нужны этому плану. Без плана берутся все. */
function sectionsFor(plan?: PromptPlan): string[] {
  if (!plan) return Object.keys(PLAYBOOK);

  const sections = new Set<string>();
  if (plan.kind === 'game') sections.add('game');
  if (plan.kind === 'timer' || plan.components.includes('ProgressRing')) sections.add('timer');
  if (plan.kind === 'countdown' || plan.components.includes('DateField') || plan.components.includes('Calendar')) {
    sections.add('countdown');
  }
  if (plan.needsRecords) { sections.add('records'); sections.add('charts'); }
  if (plan.capabilities.includes('llm')) sections.add('llm');
  if (plan.needsStructuredAi) sections.add('structuredAi');
  if (plan.capabilities.includes('camera')) sections.add('camera');
  if (plan.capabilities.includes('image')) sections.add('image');
  if (plan.kind === 'game' || plan.kind === 'other') sections.add('random');

  return [...sections];
}

export function buildSystemInstruction(locale: string, plan?: PromptPlan): string {
  const lang = languageName(locale);
  const sections = sectionsFor(plan);

  const lines = [
    'You are a senior mobile product designer and declarative app builder.',
    'You do NOT write React Native or native code. Return ONE JSON object executed by a safe runtime.',
    'Reply with raw JSON only: no markdown, no backticks, no explanations.',
    '',
    `LANGUAGE: write every user-facing label, title, button caption, empty state and hint in ${lang} (locale ${locale}).`,
    'State, derived, collection, screen and prop keys stay in latin camelCase/kebab-case where appropriate.',
    'The examples below use English labels — copy their structure, not their language.',
    '',
    'V2 SPEC SHAPE (generators MUST emit schemaVersion 2):',
    '{',
    '  "schemaVersion": 2,',
    '  "id": "kebab-case-id", "version": 1,',
    `  "manifest": { "name": "short name, max 24 chars", "icon": "icon name", "color": "blue|green|amber|violet|rose|teal", "locale": "${locale}" },`,
    '  "capabilities": [],',
    '  "state": { "key": initialValue },',
    '  "persist": ["state keys that survive closing the app"],',
    '  "derived": { "name": "expression" },',
    '  "collections": { "expenses": { "fields": [...], "valueField": "amount" } },',
    '  "components": { "ExpenseCard": { "description": "...", "props": [...], "template": {...} } },',
    '  "screens": { "home": { "type": "Screen", "children": [...] }, "history": {...} },',
    '  "navigation": { "start": "home", "mode": "single|stack|tabs", "titles": {...}, "tabs": [...] },',
    '  "design": { "density": "compact|comfortable", "cardStyle": "soft|outlined|flat", "radius": "soft|round" },',
    '}',
    '',
    'CORE COMPONENTS:',
    describeComponents(),
    '',
    'SAFE APP-SPECIFIC COMPONENTS:',
    '- If ideal UX needs a control that core components do not express well, define an app-local PascalCase component in spec.components.',
    '- A custom component is DECLARATIVE ONLY. It is composed from core/custom components; never put React/React Native source in it.',
    '- CUSTOM COMPONENT SHAPE IS EXACT: {"description":"...","props":[{"name":"amount","kind":"value","required":true}],"template":{"type":"Card",...}}.',
    '- props MUST be an array, never an object/map. Each prop.kind is exactly value | text | bind. Do not use type:number/string/state there.',
    '- template MUST be one UiNode object and template.type MUST be a plain component-name string. There is no extends/component/widget/type-object syntax in RuntimeSpec.',
    '- Planner strategy "extend" means compose/configure a core component inside template; it does NOT create an extends field in AppSpec.',
    '- Use component props inside its template as {{propName}}. A bind prop may be used as "bind":"{{bindKey}}" and action key:"{{bindKey}}".',
    '- Instantiate it as {"type":"ExpenseCard","props":{"id":"{{expenseId}}","amount":"{{expenseAmount}}"}}.',
    '- Prefer REUSE core -> COMPOSE custom -> EXTEND via a custom wrapper. Use Sandbox only for a genuine canvas/gesture capability gap.',
    '- Do not redefine generic Text/Button/Card just to change styling; the design system owns consistency.',
    '',
    'REPEAT / RECORD-DRIVEN UI:',
    '- Repeat source is an ARRAY EXPRESSION, not a template: {"type":"Repeat","source":"records","collection":"expenses","as":"expense","children":[...]}',
    '- Each stored record exposes expense, expenseIndex and flattened locals such as expenseId, expenseCreatedAt, expenseCollection AND each domain field from values, e.g. expenseAmount and expenseCategory.',
    '- This flattening exists because dot notation is intentionally unsupported. Use those locals in repeated custom cards and records.update/remove actions.',
    '- Keep repeated custom controls simple and cap Repeat with limit when history can grow.',
    '- COLLECTION INVARIANT: every collection name used by an action or record-backed component must exist in spec.collections. Never invent names like log/history without declaring their fields.',
    '',
    'ACTIONS (onPress is an array of steps, executed in order):',
    describeActions(),
    '',
    'NAVIGATION:',
    '- nav.go screen must name an existing spec.screens key. nav.back works for stack flow; nav.home returns to navigation.start.',
    '- tabs are only for 2-4 peer destinations. Add/edit/detail screens should normally use nav.go from a stack flow, not tabs.',
    '',
    'EXPRESSIONS:',
    'Arithmetic, comparisons, && || !, ternary a ? b : c, literals.',
    `Functions: ${FUNCTION_NAMES.join(', ')}. No other functions exist.`,
    'Aggregate signatures are exact:',
    '  valuesBy(records, "expenses", "amount")',
    '  sumBy(records, "expenses", "amount")',
    '  avgBy(records, "expenses", "amount")',
    '  countBy(records, "expenses")',
    '  sumWhere(records, "expenses", "amount", "category", "Food")',
    '  countWhere(records, "expenses", "category", "Food")',
    '  uniqueBy(records, "expenses", "category")',
    '  latestBy(records, "expenses", "amount")',
    'You may reference state keys, derived names, custom-component locals and these built-ins:',
    BUILTIN_SCOPE.join(', ') + '.',
    'Dot notation and index access are NOT supported. Use the provided aggregate functions or flattened locals.',
    '',
    'TEMPLATES AND FORMATTING:',
    'Text/action properties support {{expression | filter}} substitution.',
    `Filters: ${FILTER_NAMES.join(', ')}.`,
    'NEVER manually format numbers. Money, percentages, dates and durations go through filters.',
    'Use visible:"condition" for conditional UI. Design explicit empty states for persistent lists.',
    '',
  ];

  for (const section of sections) lines.push(...PLAYBOOK[section], '');

  lines.push(
    'PRODUCT / UX QUALITY RULES:',
    '1. Implement the Product Plan outcomes, not merely its component names. Every selected feature must satisfy its acceptance criteria.',
    '2. Start from the ideal mobile flow. Do not cram unrelated tasks into one screen just because a core component exists.',
    '3. Use 1-4 screens. A simple calculator should stay one screen; trackers may use Home/Add/History/Settings when that materially improves use.',
    '4. Preserve a clear hierarchy: one obvious primary action per task, secondary actions quieter, related controls grouped in Card/Section/Stack.',
    '5. Use sensible initial values and explicit empty/error/loading states. A fresh install must be understandable before any data exists.',
    '6. Mobile UX is enforced: every input/toggle/select/date control has a short label; Select uses 2-12 unique short options; Row with more than 3 children must wrap; Table has at most 3 short columns. Use Grid/Stack/Card instead of dense horizontal UI.',
    '7. Declare only capabilities actually used. Extra permissions are validation failures.',
    '8. Every bind must resolve to a state key (directly or through a custom bind prop). Select initial value must match an option.',
    '9. Put one-time settings/preferences in persist; put user-created history only in explicitly named collections, not ad-hoc state arrays.',
    '10. The backend audits selected features against the reachable app and writes featureEvidence itself. Do not fake or optimize for featureEvidence; implement the real end-to-end behavior.',
    '11. Never invent unsupported functions/actions/components. If core UX is insufficient, build a safe declarative custom component instead.',
    '12. If a task needs copy/share, add it only when it genuinely helps; do not add decorative features just to fill a screen.',
    '13. Before returning JSON, mentally trace every selected feature from navigation.start: the user must be able to reach the control, trigger the action, and see/store the result. Definitions or orphan screens do not count.',
    '14. Never leave a planned custom component unused. If it is not instantiated by a reachable screen, remove it or instantiate it with real props and behavior.',
  );

  return lines.join('\n');
}

/**
 * Запрос второго этапа. План приходит сюда решённым, поэтому модели остаётся
 * только собрать спеку — выбор между песочницей и кнопками уже сделан и
 * исправлен кодом, а не оставлен на её усмотрение.
 */
export function buildGeneratePrompt(prompt: string, locale: string, plan?: PromptPlan): string {
  const lines = [`User request: "${prompt.slice(0, 600)}"`, `Device locale: ${locale}.`];

  if (plan) {
    lines.push(
      '',
      'IMMUTABLE PRODUCT PLAN. This is the exact plan the person reviewed; do not reinterpret or replace it:',
      `  kind: ${plan.kind}`,
      `  title: ${plan.title}`,
      `  summary: ${plan.summary}`,
      `  navigation: ${plan.navigation ?? 'single'}`,
      `  known minimum capabilities from planned selected outcomes: ${plan.capabilities.join(', ') || '(none)'}`,
      `  likely core building blocks (hints, NOT a whitelist): ${plan.components.join(', ') || '(none)'}`,
      `  known planned need for persistent record history: ${plan.needsRecords ? 'yes' : 'no'}`,
      `  structured model answer: ${plan.needsStructuredAi ? 'yes — use llm.ask fields for typed values' : 'no'}`,
    );
    if (plan.screens?.length) {
      lines.push('  planned screens:', ...plan.screens.map((screen) => `    - ${screen.id}: ${screen.title} — ${screen.purpose}`));
    }
    if (plan.customComponents?.length) {
      lines.push(
        '  component gap analysis:',
        ...plan.customComponents.map((component) => `    - ${component.name} [${component.strategy}]: ${component.purpose}`),
        '  Implement these as safe spec.components when the planned UX still needs them. You may omit one only if a core component is objectively equivalent without UX loss.',
      );
    }
  }

  if (plan?.features?.length) {
    lines.push(
      '',
      'SELECTED FEATURES — hard acceptance contract. Every item must work end-to-end:',
      ...plan.features.flatMap((feature) => [
        `  - [${feature.id}] ${feature.title}: ${feature.description}`,
        ...(feature.acceptanceCriteria ?? []).map((criterion) => `      acceptance: ${criterion}`),
      ]),
      '',
      'The backend will derive featureEvidence after auditing the reachable app. You may omit featureEvidence. Do not substitute metadata for actual implementation.',
      'You may add supporting UX (empty states, navigation, labels, edit/delete controls) when it is necessary to make these features usable. Do not add unrelated product features.',
      'A feature whose id starts with user-custom- was typed by the person after planning. Treat its words as an exact requirement; infer only the minimum additional collections/capabilities/actions needed to make it work.',
    );
  }

  lines.push(
    '',
    'Emit schemaVersion 2. Build the complete production-minded small app: screens, navigation, data model, safe custom components when useful, actions and evidence.',
    'Keep the implementation as simple as possible WITHOUT sacrificing the selected outcomes or mobile usability.',
    'Return the spec JSON only.',
  );
  return lines.join('\n');
}

export function buildRefinePrompt(
  spec: MiniAppSpec,
  instruction: string,
  runtimeErrors: string[] = [],
): string {
  const lines = ['Current spec of the utility:', JSON.stringify(spec), ''];

  if (runtimeErrors.length > 0) {
    // Журнал ошибок идёт перед просьбой пользователя: он объясняет, что
    // именно сломано, тогда как человек обычно пишет только «не работает».
    lines.push(
      'These errors happened while the utility was running. They are the actual bug —',
      'fix them even if the user did not mention them:',
      ...runtimeErrors.map((error) => `  - ${error}`),
      '',
    );
  }

  lines.push(
    `What to change: "${instruction.slice(0, 600)}"`,
    'Return the FULL updated spec, keeping the same id and incrementing version by 1.',
    'Change as little as possible: keep state key names, keep blocks that already work,',
    'keep labels the user has not complained about. A rewrite loses what was already right.',
    'If the utility is a game and is currently built from Button nodes, rebuild it as a Sandbox:',
    'a board of buttons cannot have an opponent or animation.',
    'Return JSON only.',
  );

  return lines.join('\n');
}

/**
 * Промпт цикла починки. Ошибки валидатора уходят модели дословно —
 * они специально сформулированы как инструкции, что именно исправить.
 */
export function buildRepairPrompt(raw: string, errors: string[]): string {
  return [
    'The previous answer failed validation.',
    '',
    'Your JSON:',
    raw.slice(0, 60000),
    '',
    'Errors:',
    errors.map((error) => `- ${error}`).join('\n'),
    '',
    'Fix exactly these errors and return the complete spec JSON. Change nothing else.',
    'IMPORTANT FOR FEATURE ERRORS: featureEvidence is regenerated by the backend and editing it cannot make a feature pass.',
    'If a cited component exists only under spec.components, instantiate it from a reachable screen. A definition alone is not user-visible.',
    'If an action is missing, add it to the onPress flow of a reachable control with all required parameters and wire its state/record outputs into the visible UX.',
    'Do not merely rename evidence or add unreachable screens. Implement the acceptance criterion end-to-end.',
  ].join('\n');
}


/**
 * Last-resort semantic rebuild. A second local patch often keeps the same broken
 * architecture (for example an unused custom card plus metadata claiming it is
 * used). On the final repair budget we let the model simplify/recompose the app
 * while keeping the immutable Product Plan and acceptance outcomes.
 */
export function buildRecoveryPrompt(originalBuildPrompt: string, raw: string, errors: string[]): string {
  return [
    'The current implementation is still incomplete after a targeted repair.',
    'Rebuild the SMALLEST complete RuntimeSpec that satisfies the immutable selected features. You may simplify or replace the broken UI structure.',
    '',
    'ORIGINAL REVIEWED BUILD REQUEST:',
    originalBuildPrompt.slice(0, 24000),
    '',
    'CURRENT SPEC (reuse working state/collections when useful, but do not preserve broken architecture):',
    raw.slice(0, 60000),
    '',
    'OUTSTANDING ERRORS / ACCEPTANCE GAPS:',
    errors.map((error) => `- ${error}`).join('\n'),
    '',
    'Rules for this recovery build:',
    '- Every selected feature must have a real reachable user path starting from navigation.start or a visible tab.',
    '- A custom component definition is useless unless a reachable screen instantiates it.',
    '- Device/AI/record actions must live in reachable onPress flows with required parameters and visible outputs.',
    '- Remove unused custom components/screens instead of preserving them for appearance.',
    '- Prefer core components and simple flows when they can satisfy the same UX; reliability beats decorative complexity.',
    '- Do not spend effort on featureEvidence: the backend audits and writes it after generation.',
    '- Return the COMPLETE schemaVersion 2 spec as raw JSON only.',
  ].join('\n');
}
