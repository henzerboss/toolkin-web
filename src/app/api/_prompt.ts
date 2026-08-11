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
 * в промпте перетягивали вывод на русский даже при явной инструкции писать
 * на языке устройства. Плюс сложные структурные инструкции модели держат
 * надёжнее на английском: таких данных в обучении просто больше.
 *
 * Язык интерфейса создаваемой утилиты задаётся отдельной строкой ниже и от
 * языка самого промпта не зависит.
 */
export function buildSystemInstruction(locale: string): string {
  const lang = languageName(locale);

  return [
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
    '',
    'REQUIRED WIRING (without it the utility silently does nothing):',
    '',
    'Timer. There is exactly one per utility and its state lives in built-ins, not in state:',
    '  "derived": { "totalSeconds": "minutes * 60" },',
    '  button: { "action": "timer.start", "seconds": "{{totalSeconds}}", "when": "!timerRunning" }',
    '  display: { "type": "ProgressRing", "progress": "totalSeconds > 0 ? clamp(timerElapsed / totalSeconds, 0, 1) : 0",',
    '             "value": "{{timerRemaining | duration}}" }',
    'Never create your own state field for remaining time — nothing decrements it.',
    '',
    'Record history. The records.add action works only together with a records block:',
    '  "records": { "fields": [{ "key": "amount", "label": "Amount", "kind": "number" }], "valueField": "amount" },',
    '  "derived": { "total": "sum(recordValues)" },',
    '  button: { "action": "records.add", "values": { "amount": "{{portion}}" } }',
    'Without the records block entries vanish on close and recordValues stays empty.',
    '',
    'Countdown to a date. The word nowMs turns on a one-second clock:',
    '  "derived": { "left": "max(targetMs - nowMs, 0)", "days": "floor(left / 86400000)" }',
    '',
    'Randomness. There is no random() function, only an action:',
    '  { "action": "state.random", "key": "password", "chars": "abc...XYZ0123456789", "length": 16 }',
    '',
    'Hide a block until data is ready: "visible": "bill > 0" on any node.',
    '',
    'AI utilities. A model call spends the user\'s credits, so the wiring is strict:',
    '  "capabilities": ["llm"],',
    '  "state": { "products": "", "recipe": "" },',
    '  button: { "type": "Button", "title": "Suggest a recipe", "variant": "primary",',
    '            "disabled": "llmBusy || products == \'\'",',
    '            "onPress": [{ "action": "llm.ask",',
    '                         "prompt": "Suggest a recipe using: {{products}}. Short, step by step.",',
    '                         "into": "recipe" }] }',
    '  waiting: { "type": "Text", "value": "Thinking…", "variant": "caption", "visible": "llmBusy" }',
    '  error:   { "type": "Text", "value": "{{llmError}}", "variant": "caption", "visible": "llmError != null" }',
    '  answer:  { "type": "Text", "value": "{{recipe}}", "visible": "recipe != \'\'" }',
    'Disabling the button via llmBusy is mandatory: without it people tap twice and pay twice.',
    '',
    'Photo utilities. Capture and analysis are two separate actions so the person sees',
    'the frame before credits are spent:',
    '  "capabilities": ["camera", "llm"],',
    '  "state": { "photo": "", "result": "" },',
    '  { "action": "camera.capture", "into": "photo", "source": "camera" }    — take a photo',
    '  { "action": "camera.capture", "into": "photo", "source": "library" }   — pick from gallery',
    '  show the frame: { "type": "Image", "source": "photo", "ratio": "square" }',
    '  { "action": "llm.ask", "prompt": "Estimate the calories of this dish.", "image": "photo", "into": "result" }',
    '',
    'Photos in history. To keep and show photos, the photo field must go into records',
    'together with the rest, and be displayed by Gallery or as a List thumbnail —',
    'otherwise a file path is printed instead of the picture:',
    '  "records": { "fields": [{ "key": "photo", "label": "Photo", "kind": "image" },',
    '                          { "key": "kcal", "label": "Kcal", "kind": "number" }], "valueField": "kcal" },',
    '  { "action": "records.add", "values": { "photo": "{{photo}}", "kcal": "{{result}}" } }',
    '  { "type": "Gallery", "imageKey": "photo", "columns": 3 }',
    '  or { "type": "List", "valueKey": "kcal", "imageKey": "photo", "suffix": " kcal" }',
    '',
    'Dates and reminders. A date is a number (timestamp in ms), so daysBetween,',
    'nowMs and notify.at understand it directly:',
    '  "capabilities": ["notifications"],',
    '  "state": { "birthday": 0, "who": "" },',
    '  { "type": "DateField", "label": "Date", "bind": "birthday" }',
    '  "derived": { "daysLeft": "max(daysBetween(nowMs, birthday), 0)" }',
    '  { "action": "notify.at", "title": "Birthday", "body": "{{who}}", "at": "{{birthday}}", "repeat": "yearly" }',
    '',
    'Charts are chosen by the task, not by taste:',
    '  Chart      — bars over recent entries, values: "recordValues"',
    '  LineChart  — change over time (weight, steps, temperature)',
    '  PieChart   — split by category: { "groupBy": "category", "valueKey": "amount" }',
    '  Calendar   — month grid with marks: { "bind": "selectedDate", "dateKey": "date" }',
    '  Table      — columns by record fields: [{ "key": "amount", "label": "Amount" }]',
    'PieChart, Calendar, Table and Gallery read the record history, so they stay empty',
    'without a records block.',
    '',
    'Choosing how to show history. Default to List — it is readable on a narrow screen.',
    'Use Table only for two or three short numeric columns; four columns do not fit a phone.',
    'When entries contain a photo, use Gallery or a List thumbnail rather than a Table.',
    '',
    'Image generation. A separate capability, pricier than text — add it only when the',
    'utility is really about pictures (icons, covers, interior ideas):',
    '  "capabilities": ["image"],',
    '  "state": { "idea": "", "picture": "" },',
    '  { "action": "image.generate", "prompt": "{{idea}}, minimal, flat style",',
    '    "into": "picture", "aspect": "square" }',
    '  { "type": "Image", "source": "picture", "ratio": "square", "empty": "Your picture appears here" }',
    'Write the static part of an image prompt in English — the generator understands',
    'nothing else. User input inside {{...}} is translated by the server automatically.',
    'Disable the button via llmBusy here too: the waiting state is shared.',
    '',
    'GAMES AND CANVAS. Anything with a continuous loop — snake, breakout, air hockey,',
    'pong — is not expressible declaratively. For those use a sandbox:',
    '  "capabilities": ["sandbox"],',
    '  { "type": "Sandbox", "ratio": "square", "html": "<canvas id=g></canvas><script>…</script>" }',
    'The html must be fully self-contained: no external scripts, no fetch, no CDN links —',
    'the sandbox has no network. Use the CSS variables --bg, --surface, --text, --accent',
    'so the game matches the app theme. Handle touch, not mouse: touchstart and touchmove.',
    'Two bridges are available inside: toolkin.save({score: 12}) appends an entry to the',
    'record history, toolkin.set("best", 12) writes a state key. Use them to keep records,',
    'then show them with List or Chart outside the sandbox.',
    'Turn-based grid games (tic-tac-toe, memory) can also be built from ordinary components',
    'with Row and Button — prefer that when there is no animation loop.',
    '',
    'QUALITY RULES:',
    '1. Exactly one Stat or ProgressRing per screen — the main result of the utility.',
    '2. Declare only the capabilities you actually use in actions. An extra permission is a rejection.',
    '3. Every bind must exist in state. A Select initial value must match one of options.value.',
    '4. The utility must be useful the moment it opens: put sensible defaults, not zeros everywhere.',
    '5. Keep it to 4–8 nodes. A utility is one screen, not an application.',
    '6. Put settings the person adjusts once (goal, portion size, units) into persist.',
    '7. If the result is worth copying or sending, add a clipboard.set or share button.',
    '8. Check yourself before answering: every records.* action — is there a records block?',
    '   every timer.start — does it have seconds and a block showing timerRemaining?',
  ].join('\n');
}

export function buildGeneratePrompt(prompt: string, locale: string): string {
  return [
    `User request: "${prompt.slice(0, 600)}"`,
    `Device locale: ${locale}.`,
    'Build one utility that solves exactly this request.',
    'Return the spec JSON only.',
  ].join('\n');
}

export function buildRefinePrompt(spec: MiniAppSpec, instruction: string): string {
  return [
    'Current spec of the utility:',
    JSON.stringify(spec),
    '',
    `What to change: "${instruction.slice(0, 600)}"`,
    'Return the FULL updated spec, keeping the same id and incrementing version by 1.',
    'Do not rewrite what was not asked about: keep state key names and blocks that already work.',
    'Return JSON only.',
  ].join('\n');
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
