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
  | 'llm'
  | 'image'
  | 'sandbox';

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
  kind: 'number' | 'text' | 'date' | 'image';
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

/**
 * Дочерние узлы с учётом вкладок. Отдельная функция, потому что забыть про
 * tabs в одном из мест обхода — значит перестать видеть половину утилиты:
 * валидатор пропустит ошибки, прогон не нажмёт кнопки, проверка фич не
 * найдёт компонентов.
 */
export function childrenOf(node: UiNode): UiNode[] {
  const children = Array.isArray(node.children) ? node.children : [];
  if (!Array.isArray(node.tabs)) return children;

  const fromTabs = (node.tabs as unknown as { children?: UiNode[] }[]).flatMap(
    (tab) => (Array.isArray(tab?.children) ? tab.children : []),
  );
  return [...children, ...fromTabs];
}
