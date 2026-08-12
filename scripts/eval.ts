/**
 * Прогон качества генерации.
 *
 * Существует потому, что до сих пор каждая правка промпта проверялась одним
 * скриншотом: становилось лучше или хуже — было неизвестно. Здесь набор
 * запросов прогоняется через настоящий конвейер, и на выходе три числа,
 * которые можно сравнить до и после изменения.
 *
 *   TOOLKIN_GEMINI_API_KEY=... npx tsx scripts/eval.ts
 *   TOOLKIN_GEMINI_API_KEY=... npx tsx scripts/eval.ts --thinking low --runs 2
 *
 * Ключевая метрика — доля спек, прошедших валидатор С ПЕРВОЙ попытки.
 * Итоговая доля после починки почти всегда близка к единице и потому
 * бесполезна для сравнения: она прячет то, сколько лишних вызовов и секунд
 * ожидания стоит каждая генерация.
 */
import { buildGeneratePrompt, buildRepairPrompt, buildSystemInstruction } from '../src/app/api/_prompt';
import { callGemini, safeJsonParse, type ThinkingLevel } from '../src/app/api/_shared';
import { planApp } from '../src/app/api/_plan';
import { validateSpec } from '../src/lib/validateSpec';
import { autofix } from '../src/lib/autofix';
import { smokeTest } from '../src/lib/smokeTest';

interface Case {
  prompt: string;
  /** Чего мы ждём от результата — проверяется поверх валидатора. */
  expect?: (spec: Record<string, unknown>) => string | null;
}

const hasCapability = (name: string) => (spec: Record<string, unknown>) =>
  Array.isArray(spec.capabilities) && (spec.capabilities as string[]).includes(name)
    ? null
    : `ожидалась capability "${name}"`;

const hasComponent = (type: string) => (spec: Record<string, unknown>) => {
  const implementation = JSON.stringify({ screens: spec.screens, components: spec.components });
  return implementation.includes(`"${type}"`) ? null : `ожидался компонент ${type}`;
};

const both = (...checks: ((spec: Record<string, unknown>) => string | null)[]) =>
  (spec: Record<string, unknown>) => checks.map((check) => check(spec)).filter(Boolean).join('; ') || null;

/**
 * Набор намеренно смещён в сторону того, что ломалось: игры, фото, числа от
 * модели. Ровные калькуляторы модель собирает и без подсказок, и держать их
 * в наборе значит завышать метрику.
 */
const CASES: Case[] = [
  { prompt: 'калькулятор чаевых с делением счёта на компанию' },
  { prompt: 'таймер для варки яиц с поправкой на холодильник' },
  { prompt: 'трекер выпитой воды с нормой по весу' },
  { prompt: 'генератор паролей с настройкой длины и символов' },
  { prompt: 'обратный отсчёт до даты' },
  { prompt: 'конвертер сантиметров в дюймы' },
  { prompt: 'счётчик отжиманий с историей подходов' },
  { prompt: 'калькулятор ипотечного платежа' },

  { prompt: 'змейка', expect: both(hasCapability('sandbox'), hasComponent('Sandbox')) },
  { prompt: 'арканоид с рекордом', expect: both(hasCapability('sandbox'), hasComponent('Sandbox')) },
  { prompt: 'крестики-нолики против компьютера', expect: hasComponent('Sandbox') },
  { prompt: 'игра Саймон на четыре цвета', expect: hasComponent('Sandbox') },
  { prompt: 'пятнашки', expect: hasComponent('Sandbox') },
  { prompt: '2048', expect: hasComponent('Sandbox') },

  {
    prompt: 'счётчик калорий по фото с историей снимков',
    expect: both(hasCapability('camera'), hasCapability('llm'), hasComponent('Gallery')),
  },
  {
    prompt: 'определитель растений по фотографии',
    expect: both(hasCapability('camera'), hasCapability('llm')),
  },
  { prompt: 'генератор рецептов из products в холодильнике', expect: hasCapability('llm') },
  { prompt: 'генератор иконок для заметок', expect: hasCapability('image') },

  { prompt: 'трекер расходов с разбивкой по категориям', expect: hasComponent('PieChart') },
  { prompt: 'дневник веса с графиком динамики', expect: hasComponent('LineChart') },
  { prompt: 'календарь дней рождений с напоминаниями', expect: hasCapability('notifications') },
  { prompt: 'трекер привычек на месяц' },
];

interface Outcome {
  prompt: string;
  firstPass: boolean;
  attempts: number;
  errors: string[];
  expectationFailure: string | null;
  ms: number;
  kind: string;
  promptChars: number;
}

async function runCase(item: Case, thinking: ThinkingLevel, maxRepairs: number): Promise<Outcome> {
  const started = Date.now();

  // Прогон идёт тем же двухэтапным путём, что и прод: мерить одноэтапную
  // генерацию, когда в бою работает двухэтапная, значит мерить не то.
  const { plan, ok } = await planApp(item.prompt, 'ru');
  const system = buildSystemInstruction('ru', ok ? plan : undefined);
  let prompt = buildGeneratePrompt(item.prompt, 'ru', ok ? plan : undefined);
  let firstErrors: string[] = [];
  const meta = { kind: ok ? plan.kind : 'n/a', promptChars: system.length };

  for (let round = 0; round <= maxRepairs; round++) {
    const result = await callGemini(system, prompt, { jsonOnly: true, thinking });
    if (!result.ok) {
      return {
        prompt: item.prompt, firstPass: false, attempts: round + 1,
        errors: [`модель недоступна: ${result.error}`], expectationFailure: null,
        ms: Date.now() - started, ...meta,
      };
    }

    const parsed = safeJsonParse<Record<string, unknown> | null>(result.text ?? '', null);
    const validation = parsed ? validateSpec(parsed) : { ok: false as const, errors: ['ответ не является JSON'] };

    if (validation.ok) {
      // Тот же порядок, что в проде: механическая починка, потом прогон.
      const fixed = autofix(validation.spec);
      const smoke = smokeTest(fixed.spec);

      if (smoke.ok) {
        const expectationFailure = item.expect ? item.expect(fixed.spec as unknown as Record<string, unknown>) : null;
        return {
          prompt: item.prompt, firstPass: round === 0, attempts: round + 1,
          errors: firstErrors, expectationFailure, ms: Date.now() - started, ...meta,
        };
      }

      if (round === 0) firstErrors = smoke.issues;
      prompt = buildRepairPrompt(JSON.stringify(fixed.spec), smoke.issues);
      continue;
    }

    if (round === 0) firstErrors = validation.errors;
    prompt = buildRepairPrompt(JSON.stringify(parsed ?? {}), validation.errors);
  }

  return {
    prompt: item.prompt, firstPass: false, attempts: maxRepairs + 1,
    errors: firstErrors, expectationFailure: 'не собралась даже после починки',
    ms: Date.now() - started, ...meta,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const thinking = (valueOf(args, '--thinking') ?? 'high') as ThinkingLevel;
  const runs = Number.parseInt(valueOf(args, '--runs') ?? '1', 10);
  const maxRepairs = Number.parseInt(process.env.TOOLKIN_MAX_REPAIRS ?? '2', 10);

  if (!process.env.TOOLKIN_GEMINI_API_KEY) {
    console.error('Нужен TOOLKIN_GEMINI_API_KEY в окружении');
    process.exit(1);
  }

  console.log(`Прогон: ${CASES.length} запросов × ${runs}, thinking=${thinking}\n`);

  const outcomes: Outcome[] = [];
  for (let run = 0; run < runs; run++) {
    // Последовательно, а не Promise.all: параллельные запросы упираются
    // в лимит запросов в минуту, и часть прогона превращается в ошибки сети,
    // которые выглядят как падение качества.
    for (const item of CASES) {
      const outcome = await runCase(item, thinking, maxRepairs);
      outcomes.push(outcome);

      const mark = outcome.expectationFailure ? '✗' : outcome.firstPass ? '✓' : '~';
      const note = outcome.expectationFailure ?? (outcome.firstPass ? '' : `починка ×${outcome.attempts - 1}`);
      console.log(
        `${mark} ${item.prompt.padEnd(44)} ${outcome.kind.padEnd(11)} ` +
          `${(outcome.ms / 1000).toFixed(1)}s ${note}`,
      );
    }
  }

  report(outcomes);
}

function report(outcomes: Outcome[]): void {
  const total = outcomes.length;
  const firstPass = outcomes.filter((item) => item.firstPass).length;
  const expectationsChecked = outcomes.filter((item) => item.expectationFailure !== null).length;
  const avgSeconds = outcomes.reduce((sum, item) => sum + item.ms, 0) / total / 1000;

  console.log('\n─────────────────────────────────────');
  console.log(`С первой попытки:      ${firstPass}/${total} (${Math.round((firstPass / total) * 100)}%)`);
  console.log(`Не оправдали ожиданий: ${expectationsChecked}/${total}`);
  console.log(`Среднее время:         ${avgSeconds.toFixed(1)}s`);

  const avgPrompt = outcomes.reduce((sum, item) => sum + item.promptChars, 0) / total;
  console.log(`Средний промпт:        ${Math.round(avgPrompt)} символов`);

  // Разбивка по типам показывает, где именно теряется качество: обычно это
  // один-два типа, а не всё сразу.
  const byKind = new Map<string, { total: number; pass: number }>();
  for (const outcome of outcomes) {
    const entry = byKind.get(outcome.kind) ?? { total: 0, pass: 0 };
    entry.total += 1;
    if (outcome.firstPass && !outcome.expectationFailure) entry.pass += 1;
    byKind.set(outcome.kind, entry);
  }
  console.log('\nПо типам утилит:');
  [...byKind.entries()]
    .sort((a, b) => a[1].pass / a[1].total - b[1].pass / b[1].total)
    .forEach(([kind, entry]) => console.log(`  ${kind.padEnd(12)} ${entry.pass}/${entry.total}`));

  // Гистограмма причин показывает, какое правило промпта чинить следующим.
  const reasons = new Map<string, number>();
  for (const outcome of outcomes) {
    for (const error of outcome.errors) {
      // Группируем по сути ошибки, а не по пути в дереве: раньше в отчёте
      // было десять строк вида ui.children[4].onPress[0] и по ним нельзя
      // было понять, что именно чинить в промпте.
      const message = error.split(': ').slice(1).join(': ') || error;
      const key = message.replace(/"[^"]*"/g, '"…"').slice(0, 70);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  }

  if (reasons.size > 0) {
    console.log('\nЧастые причины починки:');
    [...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([reason, count]) => console.log(`  ${String(count).padStart(3)}  ${reason}`));
  }
}

function valueOf(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}

void main();
