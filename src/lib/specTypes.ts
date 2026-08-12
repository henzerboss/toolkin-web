export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Expression = string;
export type Template = string;

export type Capability =
  | 'clipboard' | 'haptics' | 'share' | 'notifications'
  | 'camera' | 'scanner' | 'sensors' | 'location' | 'files' | 'network'
  | 'llm' | 'image' | 'sandbox';

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
  kind: 'number' | 'text' | 'date' | 'image' | 'boolean';
}

export interface RecordSchema {
  fields: RecordField[];
  valueField?: string;
}

export interface CustomComponentProp {
  name: string;
  /** value = typed prop; text = semantic text; bind = state-key reference. */
  kind: 'value' | 'text' | 'bind';
  required?: boolean;
  default?: JsonValue;
}

/** Safe app-specific component composed only from the declarative DSL. */
export interface CustomComponentSpec {
  description?: string;
  props?: CustomComponentProp[];
  template: UiNode;
}

export interface NavigationSpec {
  start: string;
  mode: 'single' | 'stack' | 'tabs';
  titles?: Record<string, string>;
  tabs?: { screen: string; label: string; icon?: string }[];
}

export interface DesignSpec {
  density?: 'compact' | 'comfortable';
  cardStyle?: 'soft' | 'outlined' | 'flat';
  radius?: 'soft' | 'round';
}

export interface FeatureEvidence {
  screens?: string[];
  components?: string[];
  actions?: string[];
  capabilities?: Capability[];
}

export interface MiniAppManifest {
  name: string;
  icon: string;
  color: AccentName;
  locale: string;
}

export type AccentName = 'blue' | 'green' | 'amber' | 'violet' | 'rose' | 'teal';

export interface MiniAppSpec {
  /** v1 is supported for installed apps; generators should emit v2. */
  schemaVersion: 1 | 2;
  id: string;
  version: number;
  manifest: MiniAppManifest;
  capabilities: Capability[];
  state: Record<string, JsonValue>;
  persist?: string[];
  derived?: Record<string, Expression>;
  /** v1/default collection compatibility. */
  records?: RecordSchema;
  /** v2 named collections. */
  collections?: Record<string, RecordSchema>;
  /** v1 root; accepted only for backward compatibility. */
  ui?: UiNode;
  /** v2 screen roots. */
  screens?: Record<string, UiNode>;
  navigation?: NavigationSpec;
  /** App-local declarative composite components. Never native source code. */
  components?: Record<string, CustomComponentSpec>;
  design?: DesignSpec;
  /** Traceability from selected Product Plan features to concrete implementation. */
  featureEvidence?: Record<string, FeatureEvidence>;
}

export interface StoredRecord {
  id: string;
  createdAt: number;
  collection?: string;
  values: Record<string, JsonValue>;
}

export function getScreenRoots(spec: MiniAppSpec): Record<string, UiNode> {
  if (spec.screens && Object.keys(spec.screens).length) return spec.screens;
  return spec.ui ? { main: spec.ui } : {};
}

export function getStartScreen(spec: MiniAppSpec): string {
  const roots = getScreenRoots(spec);
  if (spec.navigation?.start && roots[spec.navigation.start]) return spec.navigation.start;
  return Object.keys(roots)[0] ?? 'main';
}

export function getCollectionSchema(spec: MiniAppSpec, collection = 'default'): RecordSchema | undefined {
  if (collection === 'default') return spec.records;
  return spec.collections?.[collection];
}
