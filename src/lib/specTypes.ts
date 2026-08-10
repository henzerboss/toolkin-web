export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Выражение вида `bill * (1 + tipPct / 100)`. Вычисляется ExpressionEvaluator. */
export type Expression = string;

/** Строка, которая может содержать подстановки: `С человека: {{perPerson | money}}`. */
export type Template = string;

export type Capability =
  | 'clipboard'
  | 'haptics'
  | 'share'
  | 'notifications'
  | 'camera'
  | 'scanner'
  | 'sensors'
  | 'location'
  | 'files'
  | 'network'
  | 'llm';

export interface ActionStep {
  action: string;
  [param: string]: JsonValue | undefined;
}

export interface UiNode {
  type: string;
  children?: UiNode[];
  [prop: string]: JsonValue | UiNode[] | undefined;
}

export interface RecordField {
  key: string;
  label: Template;
  kind: 'number' | 'text' | 'date';
}

export interface RecordSchema {
  fields: RecordField[];
  /** Поле, по которому строится график и агрегаты. */
  valueField?: string;
}

export interface MiniAppManifest {
  name: string;
  icon: string;
  color: AccentName;
  locale: string;
}

export type AccentName = 'blue' | 'green' | 'amber' | 'violet' | 'rose' | 'teal';

export interface MiniAppSpec {
  schemaVersion: 1;
  id: string;
  version: number;
  manifest: MiniAppManifest;
  capabilities: Capability[];
  /** Начальное состояние. Ключи доступны в выражениях по имени. */
  state: Record<string, JsonValue>;
  /** Поля, которые переживают закрытие утилиты. */
  persist?: string[];
  /** Вычисляемые значения. Пересчитываются при каждом изменении state. */
  derived?: Record<string, Expression>;
  records?: RecordSchema;
  ui: UiNode;
}

export interface StoredRecord {
  id: string;
  createdAt: number;
  values: Record<string, JsonValue>;
}
