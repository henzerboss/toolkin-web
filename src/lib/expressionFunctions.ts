import type { JsonValue } from './specTypes';

type Fn = (args: JsonValue[]) => JsonValue;

const num = (value: JsonValue): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const list = (value: JsonValue): number[] =>
  Array.isArray(value) ? value.map(num) : [num(value)];

const DAY_MS = 86_400_000;

/**
 * Единственный источник функций для выражений. Модель получает этот список
 * в системном промпте, парсер отвергает всё остальное.
 */
export const FUNCTIONS: Record<string, Fn> = {
  min: (a) => Math.min(...a.map(num)),
  max: (a) => Math.max(...a.map(num)),
  abs: (a) => Math.abs(num(a[0])),
  round: (a) => {
    const factor = 10 ** num(a[1] ?? 0);
    return Math.round(num(a[0]) * factor) / factor;
  },
  floor: (a) => Math.floor(num(a[0])),
  ceil: (a) => Math.ceil(num(a[0])),
  sqrt: (a) => Math.sqrt(Math.max(0, num(a[0]))),
  pow: (a) => num(a[0]) ** num(a[1]),
  clamp: (a) => Math.min(Math.max(num(a[0]), num(a[1])), num(a[2])),

  len: (a) => {
    const value = a[0];
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'string') return value.length;
    return 0;
  },
  sum: (a) => list(a[0]).reduce((acc, value) => acc + value, 0),
  avg: (a) => {
    const values = list(a[0]);
    return values.length === 0 ? 0 : values.reduce((acc, v) => acc + v, 0) / values.length;
  },

  coalesce: (a) => a.find((value) => value !== null && value !== '') ?? null,
  ifElse: (a) => (a[0] === null || a[0] === false || a[0] === 0 || a[0] === '' ? a[2] ?? null : a[1] ?? null),

  concat: (a) => a.map((value) => (value === null ? '' : String(value))).join(''),
  upper: (a) => String(a[0] ?? '').toUpperCase(),
  lower: (a) => String(a[0] ?? '').toLowerCase(),

  now: () => Date.now(),
  /** Целых дней между двумя timestamp. Положительное — второй позже первого. */
  daysBetween: (a) => Math.floor((num(a[1]) - num(a[0])) / DAY_MS),
  /** Компоненты длительности в секундах — для таймеров. */
  minutesOf: (a) => Math.floor(num(a[0]) / 60),
  secondsOf: (a) => Math.floor(num(a[0]) % 60),
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS);
