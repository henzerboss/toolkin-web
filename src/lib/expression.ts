import type { Expression, JsonValue } from './specTypes';
import { FUNCTIONS } from './expressionFunctions';

/**
 * Вычисляет выражения из спеки без eval и без доступа к области видимости хоста.
 * Разрешены: литералы, идентификаторы из scope, арифметика, сравнения,
 * логические операторы, тернарник и вызовы функций из белого списка.
 * Всё остальное — синтаксическая ошибка на этапе разбора.
 */

export class ExpressionError extends Error {
  constructor(message: string, readonly source: string) {
    super(`${message} — в выражении "${source}"`);
    this.name = 'ExpressionError';
  }
}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'end' };

type Node =
  | { t: 'lit'; v: JsonValue }
  | { t: 'ident'; name: string }
  | { t: 'unary'; op: string; arg: Node }
  | { t: 'binary'; op: string; left: Node; right: Node }
  | { t: 'ternary'; cond: Node; yes: Node; no: Node }
  | { t: 'call'; name: string; args: Node[] };

const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '<', '>', '(', ')', ',', '?', ':', '!'];

/** Приоритеты бинарных операторов. Выше — сильнее связывает. */
const BINDING: Record<string, number> = {
  '||': 1, '&&': 2,
  '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (ch === ' ' || ch === '\t' || ch === '\n') { i += 1; continue; }

    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      const value = Number(src.slice(i, j));
      if (Number.isNaN(value)) throw new ExpressionError(`Некорректное число "${src.slice(i, j)}"`, src);
      tokens.push({ kind: 'num', value });
      i = j;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const close = src.indexOf(ch, i + 1);
      if (close === -1) throw new ExpressionError('Незакрытая строка', src);
      tokens.push({ kind: 'str', value: src.slice(i + 1, close) });
      i = close + 1;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }

    const op = OPERATORS.find((candidate) => src.startsWith(candidate, i));
    if (!op) throw new ExpressionError(`Недопустимый символ "${ch}"`, src);
    tokens.push({ kind: 'op', value: op });
    i += op.length;
  }

  tokens.push({ kind: 'end' });
  return tokens;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[], private readonly src: string) {}

  parse(): Node {
    const node = this.expression(0);
    if (this.peek().kind !== 'end') throw new ExpressionError('Лишние символы в конце', this.src);
    return node;
  }

  private peek(): Token { return this.tokens[this.pos]; }

  private next(): Token { return this.tokens[this.pos++]; }

  private eat(op: string): void {
    const token = this.next();
    if (token.kind !== 'op' || token.value !== op) {
      throw new ExpressionError(`Ожидался "${op}"`, this.src);
    }
  }

  private isOp(op: string): boolean {
    const token = this.peek();
    return token.kind === 'op' && token.value === op;
  }

  private expression(minBinding: number): Node {
    let left = this.unary();

    for (;;) {
      const token = this.peek();
      if (token.kind !== 'op') break;

      if (token.value === '?' && minBinding === 0) {
        this.next();
        const yes = this.expression(0);
        this.eat(':');
        const no = this.expression(0);
        left = { t: 'ternary', cond: left, yes, no };
        continue;
      }

      const binding = BINDING[token.value];
      if (binding === undefined || binding < minBinding) break;

      this.next();
      const right = this.expression(binding + 1);
      left = { t: 'binary', op: token.value, left, right };
    }

    return left;
  }

  private unary(): Node {
    if (this.isOp('-') || this.isOp('!')) {
      const op = (this.next() as { value: string }).value;
      return { t: 'unary', op, arg: this.unary() };
    }
    return this.primary();
  }

  private primary(): Node {
    const token = this.next();

    if (token.kind === 'num') return { t: 'lit', v: token.value };
    if (token.kind === 'str') return { t: 'lit', v: token.value };

    if (token.kind === 'name') {
      if (token.value === 'true') return { t: 'lit', v: true };
      if (token.value === 'false') return { t: 'lit', v: false };
      if (token.value === 'null') return { t: 'lit', v: null };

      if (this.isOp('(')) {
        this.eat('(');
        const args: Node[] = [];
        if (!this.isOp(')')) {
          args.push(this.expression(0));
          while (this.isOp(',')) { this.next(); args.push(this.expression(0)); }
        }
        this.eat(')');
        if (!FUNCTIONS[token.value]) {
          throw new ExpressionError(`Неизвестная функция "${token.value}"`, this.src);
        }
        return { t: 'call', name: token.value, args };
      }

      return { t: 'ident', name: token.value };
    }

    if (token.kind === 'op' && token.value === '(') {
      const inner = this.expression(0);
      this.eat(')');
      return inner;
    }

    throw new ExpressionError('Неожиданный конец выражения', this.src);
  }
}

export type Scope = Record<string, JsonValue>;

export class ExpressionEvaluator {
  private readonly cache = new Map<Expression, Node>();

  /** Разбирает выражение заранее — используется валидатором спеки. */
  compile(source: Expression): void {
    this.astFor(source);
  }

  evaluate(source: Expression, scope: Scope): JsonValue {
    return this.exec(this.astFor(source), scope, source);
  }

  /** Не бросает: непригодное выражение даёт null, чтобы одна опечатка не роняла экран. */
  evaluateSafe(source: Expression, scope: Scope): JsonValue {
    try {
      return this.evaluate(source, scope);
    } catch {
      return null;
    }
  }

  private astFor(source: Expression): Node {
    const cached = this.cache.get(source);
    if (cached) return cached;
    const ast = new Parser(tokenize(source), source).parse();
    this.cache.set(source, ast);
    return ast;
  }

  private exec(node: Node, scope: Scope, src: string): JsonValue {
    switch (node.t) {
      case 'lit':
        return node.v;

      case 'ident': {
        // Только собственные поля: иначе `constructor` или `toString`
        // вернули бы объекты из прототипа и открыли доступ к рантайму хоста.
        if (!Object.prototype.hasOwnProperty.call(scope, node.name)) return null;
        const value = scope[node.name];
        return value === undefined || typeof value === 'function' ? null : value;
      }

      case 'unary': {
        const arg = this.exec(node.arg, scope, src);
        return node.op === '-' ? -toNumber(arg) : !truthy(arg);
      }

      case 'ternary':
        return truthy(this.exec(node.cond, scope, src))
          ? this.exec(node.yes, scope, src)
          : this.exec(node.no, scope, src);

      case 'call': {
        const fn = FUNCTIONS[node.name];
        if (!fn) throw new ExpressionError(`Неизвестная функция "${node.name}"`, src);
        return fn(node.args.map((arg) => this.exec(arg, scope, src)));
      }

      case 'binary':
        return this.binary(node, scope, src);
    }
  }

  private binary(node: Extract<Node, { t: 'binary' }>, scope: Scope, src: string): JsonValue {
    const left = this.exec(node.left, scope, src);

    if (node.op === '&&') return truthy(left) ? this.exec(node.right, scope, src) : left;
    if (node.op === '||') return truthy(left) ? left : this.exec(node.right, scope, src);

    const right = this.exec(node.right, scope, src);

    switch (node.op) {
      case '+':
        return typeof left === 'string' || typeof right === 'string'
          ? `${stringify(left)}${stringify(right)}`
          : toNumber(left) + toNumber(right);
      case '-': return toNumber(left) - toNumber(right);
      case '*': return toNumber(left) * toNumber(right);
      case '/': {
        const divisor = toNumber(right);
        return divisor === 0 ? 0 : toNumber(left) / divisor;
      }
      case '%': {
        const divisor = toNumber(right);
        return divisor === 0 ? 0 : toNumber(left) % divisor;
      }
      case '==': return left === right;
      case '!=': return left !== right;
      case '<': return toNumber(left) < toNumber(right);
      case '<=': return toNumber(left) <= toNumber(right);
      case '>': return toNumber(left) > toNumber(right);
      case '>=': return toNumber(left) >= toNumber(right);
      default:
        throw new ExpressionError(`Неизвестный оператор "${node.op}"`, src);
    }
  }
}

export function toNumber(value: JsonValue): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function truthy(value: JsonValue): boolean {
  if (value === null || value === false) return false;
  if (value === 0 || value === '') return false;
  return true;
}

export function stringify(value: JsonValue): string {
  if (value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
