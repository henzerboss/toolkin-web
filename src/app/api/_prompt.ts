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

export function buildSystemInstruction(locale: string): string {
  const lang = languageName(locale);

  return [
    'Ты собираешь маленькие утилиты для мобильного приложения.',
    'Ты НЕ пишешь код. Ты возвращаешь ОДИН объект JSON — декларативную спеку, которую исполняет рантайм.',
    'Ответ — строго JSON без markdown, без обратных кавычек, без пояснений.',
    '',
    `ЯЗЫК: все подписи, заголовки, тексты кнопок и подсказки пиши на языке "${lang}" (locale ${locale}).`,
    'Названия ключей state, derived и служебные значения — латиницей в camelCase.',
    '',
    'СТРУКТУРА СПЕКИ:',
    '{',
    '  "schemaVersion": 1,',
    '  "id": "kebab-case-id",',
    '  "version": 1,',
    `  "manifest": { "name": "короткое имя ≤ 24 символов", "icon": "имя иконки", "color": "blue|green|amber|violet|rose|teal", "locale": "${locale}" },`,
    '  "capabilities": [...],',
    '  "state": { "ключ": начальноеЗначение },',
    '  "persist": ["ключи, которые переживают закрытие"],',
    '  "derived": { "имя": "выражение" },',
    '  "records": { "fields": [{"key","label","kind"}], "valueField": "ключ" },',
    '  "ui": { "type": "Screen", "children": [...] }',
    '}',
    '',
    'КОМПОНЕНТЫ (других не существует):',
    describeComponents(),
    '',
    'ЭКШЕНЫ (в onPress — массив шагов, выполняются по порядку):',
    describeActions(),
    '',
    'ВЫРАЖЕНИЯ:',
    'Арифметика, сравнения, && || !, тернарник a ? b : c, литералы.',
    `Функции: ${FUNCTION_NAMES.join(', ')}. Других функций нет.`,
    'Обращаться можно только к ключам state, к именам из derived и к встроенным:',
    BUILTIN_SCOPE.join(', ') + '.',
    'Точечная нотация и доступ по индексу НЕ поддерживаются.',
    '',
    'ШАБЛОНЫ И ФОРМАТИРОВАНИЕ:',
    'В текстовых свойствах доступна подстановка {{выражение | фильтр}}.',
    `Фильтры: ${FILTER_NAMES.join(', ')}.`,
    'НИКОГДА не форматируй числа сам: деньги, проценты, даты и длительности выводи только через фильтр,',
    'иначе на экране появится 880.0000000000001, а валюта и разделители не совпадут с устройством.',
    '',
    'ПРАВИЛА КАЧЕСТВА:',
    '1. Ровно один Stat или ProgressRing на экран — главный результат утилиты.',
    '2. Объявляй в capabilities только то, что реально используешь в экшенах. Лишнее право — отказ.',
    '3. Каждый bind обязан существовать в state. Начальное значение Select обязано совпадать с одним из options.value.',
    '4. Утилита должна быть полезна сразу при открытии: подставляй разумные начальные значения, а не нули везде.',
    '5. Держи 4–8 узлов. Утилита — это один экран, а не приложение.',
    '6. Ключи, которые пользователь настроил один раз (цель, размер порции, единицы), добавляй в persist.',
    '7. Если результат имеет смысл скопировать или отправить — добавь кнопку с clipboard.set или share.',
  ].join('\n');
}

export function buildGeneratePrompt(prompt: string, locale: string): string {
  return [
    `Запрос пользователя: "${prompt.slice(0, 600)}"`,
    `Локаль устройства: ${locale}.`,
    'Собери одну утилиту, максимально точно решающую именно этот запрос.',
    'Верни только JSON спеки.',
  ].join('\n');
}

export function buildRefinePrompt(spec: MiniAppSpec, instruction: string): string {
  return [
    'Текущая спека утилиты:',
    JSON.stringify(spec),
    '',
    `Что нужно изменить: "${instruction.slice(0, 600)}"`,
    'Верни ПОЛНУЮ обновлённую спеку целиком, сохранив id и увеличив version на 1.',
    'Не переписывай то, о чём не просили: сохрани имена ключей state и уже работающие блоки.',
    'Верни только JSON.',
  ].join('\n');
}

/**
 * Промпт цикла починки. Ошибки валидатора уходят модели дословно —
 * они специально сформулированы как инструкции, что именно исправить.
 */
export function buildRepairPrompt(raw: string, errors: string[]): string {
  return [
    'Предыдущий ответ не прошёл валидацию.',
    '',
    'Твой JSON:',
    raw.slice(0, 12000),
    '',
    'Ошибки:',
    errors.map((error) => `- ${error}`).join('\n'),
    '',
    'Исправь ровно эти ошибки и верни полную спеку JSON целиком. Ничего больше не меняй.',
  ].join('\n');
}
