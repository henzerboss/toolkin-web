import type { Feature } from '@/app/api/_plan';
import { ACTION_NAMES } from '@/lib/dsl';
import { getStartScreen, type Capability, type FeatureEvidence, type MiniAppSpec, type UiNode } from '@/lib/specTypes';

const LAYOUT_ONLY = new Set(['Screen', 'Stack', 'Row', 'Grid', 'Card', 'Section', 'Divider', 'Spacer', 'EmptyState']);

export interface ImplementationInventory {
  screens: Set<string>;
  components: Set<string>;
  actions: Set<string>;
  capabilities: Set<string>;
  componentScreens: Map<string, Set<string>>;
  actionScreens: Map<string, Set<string>>;
}

function addSite(map: Map<string, Set<string>>, key: string, screen: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(screen);
  map.set(key, set);
}

/**
 * Build the inventory from the UI that a user can actually reach.
 *
 * Older checks walked every screen key and treated a custom-component definition
 * as implementation merely because it existed. That produced both false positives
 * and false negatives. This graph starts from navigation.start/tabs, follows literal
 * nav.go actions, and expands only custom components that are instantiated by a
 * reachable node. Repeat children are included because they become reachable when
 * records exist.
 */
export function analyzeImplementation(spec: MiniAppSpec): ImplementationInventory {
  const screens = new Set<string>();
  const components = new Set<string>();
  const actions = new Set<string>();
  const capabilities = new Set<string>(spec.capabilities);
  const componentScreens = new Map<string, Set<string>>();
  const actionScreens = new Map<string, Set<string>>();

  const queued: string[] = [];
  const queueScreen = (screen: string): void => {
    if (spec.screens[screen] && !screens.has(screen) && !queued.includes(screen)) queued.push(screen);
  };

  queueScreen(getStartScreen(spec));
  if (spec.navigation.mode === 'tabs') for (const tab of spec.navigation.tabs ?? []) queueScreen(tab.screen);

  type StaticLocals = Record<string, unknown>;
  const staticString = (raw: unknown, locals: StaticLocals): string | null => {
    if (typeof raw !== 'string') return null;
    const single = raw.match(/^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/);
    if (!single) return raw.includes('{{') ? null : raw;
    const value = locals[single[1]];
    return typeof value === 'string' && !value.includes('{{') ? value : null;
  };

  const walkNode = (node: UiNode, screen: string, customStack: string[] = [], locals: StaticLocals = {}): void => {
    components.add(node.type);
    addSite(componentScreens, node.type, screen);

    // Core List owns a real per-row delete control in the mobile runtime. It is
    // an implicit runtime action rather than JSON onPress, but it must still
    // count as implementation for Product Plan requirements such as "can delete
    // an incorrect entry". Keeping the inventory aligned with runtime semantics
    // prevents a mechanically false feature_incomplete before semantic QA runs.
    if (node.type === 'List') {
      actions.add('records.remove');
      addSite(actionScreens, 'records.remove', screen);
    }

    if (typeof node.bind === 'string') {
      actions.add('state.set');
      addSite(actionScreens, 'state.set', screen);
    }

    if (Array.isArray(node.onPress)) {
      for (const raw of node.onPress as unknown as Record<string, unknown>[]) {
        const action = typeof raw.action === 'string' ? raw.action : '';
        if (!action) continue;
        actions.add(action);
        addSite(actionScreens, action, screen);
        if (action === 'nav.go') {
          const target = staticString(raw.screen, locals);
          if (target) queueScreen(target);
        }
      }
    }

    const definition = spec.components?.[node.type];
    if (definition && !customStack.includes(node.type)) {
      const rawProps = node.props && typeof node.props === 'object' && !Array.isArray(node.props)
        ? node.props as Record<string, unknown>
        : {};
      const nextLocals: StaticLocals = { ...locals };
      for (const prop of definition.props ?? []) {
        const raw = rawProps[prop.name];
        nextLocals[prop.name] = raw === undefined ? prop.default : raw;
      }
      for (const [name, raw] of Object.entries(rawProps)) if (!(name in nextLocals)) nextLocals[name] = raw;
      walkNode(definition.template, screen, [...customStack, node.type], nextLocals);
    }

    if (Array.isArray(node.children)) for (const child of node.children) walkNode(child, screen, customStack, locals);
  };

  while (queued.length) {
    const screen = queued.shift()!;
    if (screens.has(screen)) continue;
    const root = spec.screens[screen];
    if (!root) continue;
    screens.add(screen);
    walkNode(root, screen);
  }

  return { screens, components, actions, capabilities, componentScreens, actionScreens };
}

export interface FeatureCheck {
  ok: boolean;
  issues: string[];
  implemented: string[];
  missing: { id: string; title: string }[];
  /** Features still need acceptance-criteria auditing after strict minimums pass. */
  needsSemantic: Feature[];
  inventory: ImplementationInventory;
  /** Valid reachable citations from model-supplied evidence; stale citations are ignored, not treated as implementation. */
  evidence: Record<string, FeatureEvidence>;
}

function normalizeEvidence(spec: MiniAppSpec, inventory: ImplementationInventory, feature: Feature): FeatureEvidence {
  const raw = spec.featureEvidence?.[feature.id];
  const screens = [...new Set((raw?.screens ?? []).filter((value) => inventory.screens.has(value)))];
  const components = [...new Set((raw?.components ?? []).filter((value) => inventory.components.has(value)))];
  const actions = [...new Set((raw?.actions ?? []).filter((value) => inventory.actions.has(value) && ACTION_NAMES.includes(value)))];
  const capabilities = [...new Set((raw?.capabilities ?? []).filter((value): value is Capability => inventory.capabilities.has(value) && spec.capabilities.includes(value)))];
  return { screens, components, actions, capabilities };
}

/**
 * Mechanical pre-check only. It intentionally does NOT trust featureEvidence as a
 * proof of semantic correctness. Evidence is model-authored metadata and can be
 * stale after a repair. We verify exact planner minimums here, then a separate
 * acceptance-criteria auditor evaluates the real reachable spec and rewrites the
 * evidence from observed implementation.
 */
export function checkFeatures(spec: MiniAppSpec, features: Feature[]): FeatureCheck {
  const inventory = analyzeImplementation(spec);
  if (!features.length) {
    return { ok: true, issues: [], implemented: [], missing: [], needsSemantic: [], inventory, evidence: {} };
  }

  const issues: string[] = [];
  const implemented: string[] = [];
  const missing: { id: string; title: string }[] = [];
  const needsSemantic: Feature[] = [];
  const evidence: Record<string, FeatureEvidence> = {};

  for (const feature of features) {
    const gaps: string[] = [];
    for (const component of feature.requiresComponents) {
      if (!inventory.components.has(component)) gaps.push(`required component ${component} is not reachable`);
    }
    for (const action of feature.requiresActions) {
      if (!inventory.actions.has(action)) gaps.push(`required action ${action} is not reachable`);
    }
    for (const capability of feature.requiresCapabilities) {
      if (!inventory.capabilities.has(capability)) gaps.push(`required capability ${capability} is not declared`);
    }

    evidence[feature.id] = normalizeEvidence(spec, inventory, feature);

    if (gaps.length) {
      missing.push({ id: feature.id, title: feature.title });
      issues.push(
        `feature "${feature.title}" [${feature.id}] is missing strict implementation minimums: ${[...new Set(gaps)].join(', ')}. ` +
        `Implement the actual reachable flow that satisfies: ${feature.acceptanceCriteria.join('; ')}.`,
      );
      continue;
    }

    // Passing strict minimums does not prove the acceptance criteria. For example,
    // records.add may exist somewhere while a requested delete flow is absent. Every
    // selected feature is therefore semantically audited against the actual spec.
    needsSemantic.push(feature);
  }

  return { ok: issues.length === 0, issues, implemented, missing, needsSemantic, inventory, evidence };
}

export function publicInventory(inventory: ImplementationInventory): {
  screens: string[];
  components: string[];
  actions: string[];
  capabilities: string[];
  componentScreens: Record<string, string[]>;
  actionScreens: Record<string, string[]>;
} {
  return {
    screens: [...inventory.screens].sort(),
    components: [...inventory.components].sort(),
    actions: [...inventory.actions].sort(),
    capabilities: [...inventory.capabilities].sort(),
    componentScreens: Object.fromEntries([...inventory.componentScreens].map(([key, value]) => [key, [...value].sort()])),
    actionScreens: Object.fromEntries([...inventory.actionScreens].map(([key, value]) => [key, [...value].sort()])),
  };
}

export function hasConcreteEvidence(evidence: FeatureEvidence | undefined): boolean {
  if (!evidence) return false;
  return (evidence.components ?? []).some((component) => !LAYOUT_ONLY.has(component))
    || (evidence.actions?.length ?? 0) > 0
    || (evidence.capabilities?.length ?? 0) > 0;
}

/**
 * Cache entries written by the current pipeline already contain auditor-generated
 * evidence. This cheap check lets exact cache hits avoid another model audit while
 * still rejecting stale/invalid citations.
 */
export function checkStoredFeatureEvidence(spec: MiniAppSpec, features: Feature[]): FeatureCheck {
  const base = checkFeatures(spec, features);
  if (!base.ok) return base;

  const issues: string[] = [];
  const implemented: string[] = [];
  const missing: { id: string; title: string }[] = [];
  for (const feature of features) {
    const evidence = base.evidence[feature.id];
    if (!hasConcreteEvidence(evidence)) {
      issues.push(`feature "${feature.title}" [${feature.id}] has no valid verified implementation evidence`);
      missing.push({ id: feature.id, title: feature.title });
    } else {
      implemented.push(feature.id);
    }
  }
  return { ...base, ok: issues.length === 0, issues, implemented, missing, needsSemantic: issues.length ? base.needsSemantic : [] };
}
