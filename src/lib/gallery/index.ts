import type { MiniAppSpec } from '../specTypes';
import * as part1 from './part1';
import * as part2 from './part2';
import * as part3 from './part3';
import * as part4 from './part4';

/**
 * Галерея готовых утилит.
 *
 * Две задачи сразу. Для пользователя это ответ на вопрос «а что вообще можно
 * попросить»: в первую минуту после установки нельзя полагаться на генерацию —
 * сеть, кредиты, неудачный промпт, — а здесь всё открывается мгновенно и
 * офлайн, и любую утилиту можно доработать правкой под себя.
 *
 * Для нас это регрессионный набор. Каждая спека прогоняется валидатором и
 * пробным прогоном на каждой правке DSL: то, что перестало собираться,
 * показывает дыру в языке сразу, а не через месяц по жалобе.
 *
 * Категории подобраны по тому, что реально скачивают: трекеры привычек,
 * бюджет, фокус-таймеры, дневники, здоровье, определение растений,
 * планирование питания, пароли, рисование.
 */
export const GALLERY: MiniAppSpec[] = [
  part1.tipCalculator,
  part1.pomodoro,
  part1.eggTimer,
  part1.unitConverter,
  part1.passwordGenerator,

  part2.habitTracker,
  part2.todoList,
  part2.shoppingList,
  part2.expenseTracker,
  part2.waterTracker,

  part3.cycleCalendar,
  part3.weightDiary,
  part3.moodDiary,
  part3.birthdayCalendar,
  part3.eventCountdown,

  part4.calorieScanner,
  part4.plantIdentifier,
  part4.recipeGenerator,
  part4.snakeGame,
  part4.sketchpad,
];

/** Группы для экрана галереи — по задаче, а не по внутреннему типу. */
export const GALLERY_GROUPS: { title: string; ids: string[] }[] = [
  { title: 'Считать', ids: ['tip-split', 'unit-converter', 'password-generator'] },
  { title: 'Отслеживать', ids: ['habit-tracker', 'todo-list', 'shopping-list', 'expense-tracker', 'water-tracker'] },
  { title: 'Время', ids: ['pomodoro', 'egg-timer', 'event-countdown'] },
  { title: 'Здоровье', ids: ['cycle-calendar', 'weight-diary', 'mood-diary', 'calorie-scanner'] },
  { title: 'С ИИ', ids: ['plant-identifier', 'recipe-generator'] },
  { title: 'Разное', ids: ['birthdays', 'snake-game', 'sketchpad'] },
];
