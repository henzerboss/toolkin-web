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

/**
 * Toolkin generated-app contract.
 *
 * There is intentionally one format only: schemaVersion 2. The product has not
 * shipped a previous public runtime, so carrying v1 branches would add failure
 * modes without protecting real user data.
 */
export interface MiniAppSpec {
  schemaVersion: 2;
  id: string;
  version: number;
  manifest: MiniAppManifest;
  capabilities: Capability[];
  state: Record<string, JsonValue>;
  persist?: string[];
  derived?: Record<string, Expression>;
  /** Every persistent record set is explicitly named. */
  collections?: Record<string, RecordSchema>;
  /** One to four screen roots. */
  screens: Record<string, UiNode>;
  navigation: NavigationSpec;
  /** App-local declarative composite components. Never native source code. */
  components?: Record<string, CustomComponentSpec>;
  design?: DesignSpec;
  /** Traceability from selected Product Plan features to concrete implementation. */
  featureEvidence?: Record<string, FeatureEvidence>;
}

export interface StoredRecord {
  id: string;
  createdAt: number;
  collection: string;
  values: Record<string, JsonValue>;
}

export function getScreenRoots(spec: MiniAppSpec): Record<string, UiNode> {
  return spec.screens;
}

export function getStartScreen(spec: MiniAppSpec): string {
  if (spec.navigation.start && spec.screens[spec.navigation.start]) return spec.navigation.start;
  return Object.keys(spec.screens)[0] ?? 'home';
}

export function getCollectionSchema(spec: MiniAppSpec, collection: string): RecordSchema | undefined {
  return spec.collections?.[collection];
}
