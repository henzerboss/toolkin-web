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
    'Record history. The records.add action works only together with a records block:',
    '  "records": { "fields": [{ "key": "amount", "label": "Amount", "kind": "number" }], "valueField": "amount" },',
    '  "derived": { "total": "sum(recordValues)" },',
    '  button: { "action": "records.add", "values": { "amount": "{{portion}}" } }',
    'Without the records block entries vanish on close and recordValues stays empty.',
    'Default to List for showing history — it is readable on a narrow screen.',
    'Use Table only for two or three short numeric columns; four columns do not fit a phone.',
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
    'Photos in history. The photo field must go into records together with the rest,',
    'and be displayed by Gallery or as a List thumbnail — otherwise a file path is',
    'printed instead of the picture:',
    '  "records": { "fields": [{ "key": "photo", "label": "Photo", "kind": "image" },',
    '                          { "key": "kcal", "label": "Kcal", "kind": "number" }], "valueField": "kcal" },',
    '  { "action": "records.add", "values": { "photo": "{{photo}}", "kcal": "{{kcal}}" } }',
    '  { "type": "Gallery", "imageKey": "photo", "columns": 3 }',
    'Pick ONE way to show photos in history: either a Gallery grid or a List with',
    'imageKey. Both together print the same picture twice and look like a layout bug.',
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
    '  Chart      — bars over recent entries, values: "recordValues"',
    '  LineChart  — change over time (weight, steps, temperature)',
    '  PieChart   — split by category: { "groupBy": "category", "valueKey": "amount" }',
    '  Calendar   — month grid with marks: { "bind": "selectedDate", "dateKey": "date" }',
    'All of them read the record history, so they stay empty without a records block.',
  ],

  game: [
    'This is a game, so the whole game is ONE Sandbox node. Not a board of Buttons:',
    'buttons cannot have an opponent, cannot animate and cannot use randomness.',
    '  { "type": "Sandbox", "ratio": "square", "html": "<canvas id=g></canvas><script>…</script>" }',
    'The html must be fully self-contained: no external scripts, no fetch, no CDN links —',
    'the sandbox has no network. Use the CSS variables --bg, --surface, --text, --accent',
    'so the game matches the app theme. Handle touch, not mouse: touchstart and touchmove.',
    'Bridges available inside (all return promises):',
    '  toolkin.save({score: 12})        append an entry to the record history',
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
  features?: { id: string; title: string; description: string }[];
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
    'You build small single-screen utilities for a mobile app.',
    'You do NOT write code. You return ONE JSON object — a declarative spec executed by a runtime.',
    'Reply with raw JSON only: no markdown, no backticks, no explanations.',
    '',
    `LANGUAGE: write every label, title, button caption and hint in ${lang} (locale ${locale}).`,
    'Keys of state and derived stay in latin camelCase.',
    'The examples below use English labels — copy their structure, not their language.',
    '',
    'SPEC SHAPE:',
    '{',
    '  "schemaVersion": 1,',
    '  "id": "kebab-case-id",',
    '  "version": 1,',
    `  "manifest": { "name": "short name, max 24 chars", "icon": "icon name", "color": "blue|green|amber|violet|rose|teal", "locale": "${locale}" },`,
    '  "capabilities": [...],',
    '  "state": { "key": initialValue },',
    '  "persist": ["keys that survive closing the app"],',
    '  "derived": { "name": "expression" },',
    '  "records": { "fields": [{"key","label","kind"}], "valueField": "key" },',
    '  "ui": { "type": "Screen", "children": [...] }',
    '}',
    '',
    'COMPONENTS (nothing else exists):',
    describeComponents(),
    '',
    'ACTIONS (onPress is an array of steps, executed in order):',
    describeActions(),
    '',
    'EXPRESSIONS:',
    'Arithmetic, comparisons, && || !, ternary a ? b : c, literals.',
    `Functions: ${FUNCTION_NAMES.join(', ')}. No other functions exist.`,
    'You may reference only state keys, derived names and these built-ins:',
    BUILTIN_SCOPE.join(', ') + '.',
    'Dot notation and index access are NOT supported.',
    '',
    'TEMPLATES AND FORMATTING:',
    'Text properties support {{expression | filter}} substitution.',
    `Filters: ${FILTER_NAMES.join(', ')}.`,
    'NEVER format numbers yourself. Money, percentages, dates and durations go through a filter,',
    'otherwise the screen shows 880.0000000000001 and the currency will not match the device.',
    'Hide a block until data is ready: "visible": "bill > 0" on any node.',
    '',
  ];

  for (const section of sections) {
    lines.push(...PLAYBOOK[section], '');
  }

  lines.push(
    'SCREEN DESIGN. A vertical stack of identical cards reads as a dump, not as an app.',
    'Give the screen a shape:',
    '',
    '  Tabs when the utility has more than one job. Three tabs at most, named by what',
    '  the person does there — "Today / History / Settings", not "Tab 1 / Tab 2".',
    '  State is shared, so a value entered on one tab is visible on another.',
    '    { "type": "Tabs", "tabs": [',
    '      { "label": "Today",   "children": [ … ] },',
    '      { "label": "History", "children": [ … ] } ] }',
    '',
    '  Section to group related inputs under a heading — settings that are adjusted once',
    '  belong in their own section, away from the daily controls.',
    '',
    '  EmptyState next to every history block, hidden once data appears:',
    '    { "type": "EmptyState", "title": "No entries yet", "hint": "Tap Add to log the first one",',
    '      "visible": "recordCount == 0" }',
    '    { "type": "List", "valueKey": "amount", "visible": "recordCount > 0" }',
    '  Without it the screen looks broken on the very first launch — which is exactly',
    '  the moment the person decides whether to keep the app.',
    '',
    '  KeyValue for secondary numbers. Three Stat blocks in a row means no accent at all;',
    '  one Stat plus two KeyValue rows means a clear hierarchy.',
    '',
    'QUALITY RULES:',
    '1. Exactly one Stat or ProgressRing per screen or per tab — the main result.',
    '2. Declare only the capabilities you actually use in actions. An extra permission is a rejection.',
    '3. Every bind must exist in state. A Select initial value must match one of options.value.',
    '4. The utility must be useful the moment it opens: put sensible defaults, not zeros everywhere.',
    '5. Without tabs keep it to 4–8 blocks; with tabs up to 6 per tab. Depth beats length:',
    '   a person scrolling past ten cards has already lost the main number.',
    '6. Put settings the person adjusts once (goal, portion size, units) into persist.',
    '7. If the result is worth copying or sending, add a clipboard.set or share button.',
    '8. One primary button per screen. Everything else is secondary — two blue buttons',
    '   side by side means the person has to read both to know which one to press.',
    '9. Anything the person adjusts once (goal, cycle length, units) goes into a Settings',
    '   tab or a Section at the bottom, never above the daily controls.',
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
      'The plan is already decided. Follow it exactly:',
      `  kind: ${plan.kind}`,
      `  title: ${plan.title}`,
      `  capabilities: ${plan.capabilities.join(', ') || '(none)'}`,
      `  components to use: ${plan.components.join(', ')}`,
      `  record history: ${plan.needsRecords ? 'yes' : 'no'}`,
      `  structured model answer: ${plan.needsStructuredAi ? 'yes — use llm.ask with fields' : 'no'}`,
      `  summary: ${plan.summary}`,
    );
  }

  if (plan?.features?.length) {
    // Фичи идут последними и списком: человек уже согласился на этот набор
    // галочками, поэтому это не пожелание, а обязательство.
    lines.push(
      '',
      'The person picked these features. Every one of them must work in the built utility —',
      'their presence is checked automatically and a missing one is a failure:',
      ...plan.features.map((feature) => `  - ${feature.title}: ${feature.description}`),
      '',
      'Do not add anything beyond this list. Extra blocks make the single screen unusable.',
    );
  }

  lines.push('', 'Use exactly these capabilities and build the screen from these components.');
  lines.push('Build one utility that solves exactly this request.', 'Return the spec JSON only.');
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
    raw.slice(0, 12000),
    '',
    'Errors:',
    errors.map((error) => `- ${error}`).join('\n'),
    '',
    'Fix exactly these errors and return the complete spec JSON. Change nothing else.',
  ].join('\n');
}
