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

const objects = (value: JsonValue): Record<string, JsonValue>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, JsonValue> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];

const recordsIn = (value: JsonValue, collection: JsonValue): Record<string, JsonValue>[] => {
  const name = String(collection ?? '');
  return objects(value).filter((item) => String(item.collection ?? '') === name);
};

const fieldValue = (item: Record<string, JsonValue>, key: JsonValue): JsonValue =>
  item[String(key ?? '')] ?? null;

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

  range: (a) => {
    const start = num(a[0]);
    const count = Math.max(0, Math.min(400, Math.round(num(a[1]))));
    const step = a[2] === undefined ? 1 : num(a[2]);
    return Array.from({ length: count }, (_, index) => start + index * step);
  },

  addDays: (a) => num(a[0]) + Math.round(num(a[1])) * DAY_MS,
  startOfDay: (a) => {
    const date = new Date(num(a[0]));
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  },
  /** Целых дней между двумя timestamp. Положительное — второй позже первого. */
  daysBetween: (a) => Math.floor((num(a[1]) - num(a[0])) / DAY_MS),
  /** Компоненты длительности в секундах — для таймеров. */
  minutesOf: (a) => Math.floor(num(a[0]) / 60),
  secondsOf: (a) => Math.floor(num(a[0]) % 60),

  /** Aggregates over the safe flattened `records` builtin.
   * Signatures: fn(records, collection, field, ...).
   */
  valuesBy: (a) => recordsIn(a[0], a[1]).map((item) => fieldValue(item, a[2])),
  sumBy: (a) => recordsIn(a[0], a[1]).reduce((sum, item) => sum + num(fieldValue(item, a[2])), 0),
  avgBy: (a) => {
    const values = recordsIn(a[0], a[1]).map((item) => num(fieldValue(item, a[2])));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  },
  countBy: (a) => recordsIn(a[0], a[1]).length,
  sumWhere: (a) => recordsIn(a[0], a[1])
    .filter((item) => fieldValue(item, a[3]) === (a[4] ?? null))
    .reduce((sum, item) => sum + num(fieldValue(item, a[2])), 0),
  countWhere: (a) => recordsIn(a[0], a[1])
    .filter((item) => fieldValue(item, a[2]) === (a[3] ?? null)).length,
  uniqueBy: (a) => {
    const out: JsonValue[] = [];
    for (const item of recordsIn(a[0], a[1])) {
      const value = fieldValue(item, a[2]);
      if (!out.some((seen) => seen === value)) out.push(value);
    }
    return out;
  },
  latestBy: (a) => {
    const rows = recordsIn(a[0], a[1]);
    if (!rows.length) return null;
    const latest = [...rows].sort((x, y) => num(y.createdAt ?? 0) - num(x.createdAt ?? 0))[0];
    return fieldValue(latest, a[2]);
  },
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS);
