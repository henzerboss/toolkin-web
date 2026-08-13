import { ACTIONS, CAPABILITIES, COMPONENT_TYPES } from './dsl';
import type { JsonValue, RecordField } from './specTypes';

interface MutableStep { action?: unknown; collection?: unknown; values?: unknown; [key: string]: unknown }
interface Candidate { fields: Map<string, RecordField>; score: number }

const capabilityByAction = new Map(ACTIONS.filter((action) => action.requires).map((action) => [action.name, action.requires!]));
const knownCapabilities = new Set<string>(CAPABILITIES);
const knownCoreComponents = new Set<string>(COMPONENT_TYPES);

const COMPONENT_ALIASES: Record<string, string> = {
  Container: 'Stack', Column: 'Stack', VStack: 'Stack', VerticalStack: 'Stack',
  HStack: 'Row', HorizontalStack: 'Row',
  Input: 'TextField', TextInput: 'TextField', Switch: 'Toggle', Picker: 'Select', Dropdown: 'Select',
  Label: 'Text', Paragraph: 'Text', Heading: 'Text', Metric: 'Stat', Progress: 'ProgressBar',
  DonutChart: 'PieChart', DatePicker: 'DateField',
};

/**
 * Deterministic compiler pass for model output.
 *
 * The model decides product behaviour and UX. This pass only repairs facts that
 * are already implied by that output: declarations for referenced state/records,
 * action capabilities, safe navigation defaults, small vocabulary aliases and
 * mobile-safe metadata. These mistakes must not spend another LLM round.
 */
export function normalizeGeneratedSpec(input: unknown): { spec: unknown; applied: string[] } {
  if (!isRecord(input)) return { spec: input, applied: [] };

  let root: Record<string, unknown>;
  try { root = JSON.parse(JSON.stringify(input)) as Record<string, unknown>; }
  catch { return { spec: input, applied: [] }; }

  const applied = new Set<string>();

  if (root.schemaVersion === undefined) { root.schemaVersion = 2; applied.add('filled schemaVersion'); }
  if (root.version === undefined) { root.version = 1; applied.add('filled version'); }
  if (typeof root.id !== 'string' || !root.id.trim()) { root.id = 'generated-app'; applied.add('filled id'); }

  const manifest = isRecord(root.manifest) ? root.manifest : {};
  if (!isRecord(root.manifest)) { root.manifest = manifest; applied.add('filled manifest'); }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) { manifest.name = 'Generated app'; applied.add('filled manifest.name'); }
  if (String(manifest.name).length > 40) { manifest.name = String(manifest.name).slice(0, 40); applied.add('trimmed manifest.name'); }
  if (typeof manifest.icon !== 'string' || !manifest.icon.trim()) { manifest.icon = '✨'; applied.add('filled manifest.icon'); }
  if (!['blue','green','amber','violet','rose','teal'].includes(String(manifest.color))) { manifest.color = 'blue'; applied.add('fixed manifest.color'); }
  if (typeof manifest.locale !== 'string' || String(manifest.locale).length < 2) { manifest.locale = 'en'; applied.add('filled manifest.locale'); }

  const state = isRecord(root.state) ? root.state : {};
  if (!isRecord(root.state)) { root.state = state; applied.add('filled state'); }

  const capabilities = new Set<string>();
  if (Array.isArray(root.capabilities)) {
    for (const raw of root.capabilities) if (typeof raw === 'string' && knownCapabilities.has(raw)) capabilities.add(raw);
  }
  root.capabilities = [...capabilities];

  const screens = isRecord(root.screens) ? root.screens : {};
  if (isRecord(root.screens)) normalizeScreenRoots(screens, applied);

  const customComponents = isRecord(root.components) ? root.components : {};
  const renameMap = normalizeCustomComponentNames(customComponents, applied);
  if (renameMap.size) {
    if (isRecord(root.screens)) for (const node of Object.values(screens)) renameComponentUsages(node, renameMap);
    for (const def of Object.values(customComponents)) if (isRecord(def)) renameComponentUsages(def.template, renameMap);
  }

  const collections = isRecord(root.collections) ? root.collections : {};
  root.collections = collections;

  const candidates = new Map<string, Candidate>();
  const steps: MutableStep[] = [];
  const nodes: Record<string, unknown>[] = [];
  let generatedStateCounter = 0;

  const visitNode = (node: unknown, repeatContext?: { alias: string; collection: string }): void => {
    if (!isRecord(node)) return;
    nodes.push(node);

    const alias = typeof node.type === 'string' && COMPONENT_ALIASES[node.type] ? COMPONENT_ALIASES[node.type] : '';
    if (alias) {
      applied.add(`component alias ${String(node.type)} -> ${alias}`);
      node.type = alias;
    }

    normalizeCommonProps(node, applied);

    const type = String(node.type ?? '');
    if (type === 'Sandbox' && !capabilities.has('sandbox')) {
      capabilities.add('sandbox');
      applied.add('declared capability sandbox');
      const html = typeof node.html === 'string' ? node.html : '';
      if (/toolkin\.ask\s*\(/.test(html)) capabilities.add('llm');
      if (/toolkin\.capture\s*\(/.test(html)) capabilities.add('camera');
      if (/toolkin\.image\s*\(/.test(html)) capabilities.add('image');
      if (/toolkin\.notify\s*\(/.test(html)) capabilities.add('notifications');
    }
    if (isBindable(type)) {
      let bind = typeof node.bind === 'string' ? node.bind : '';
      if (!bind) {
        const candidate = firstString(node.stateKey, node.key, node.name);
        if (candidate && /^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) {
          bind = candidate;
          node.bind = candidate;
          applied.add(`filled ${type} bind`);
        }
      }
      if (bind && !bind.includes('{{') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(bind) && !(bind in state)) {
        state[bind] = initialValueForControl(type, node);
        applied.add(`declared state ${bind}`);
      }
      if (!bind) {
        const generated = `field${++generatedStateCounter}`;
        node.bind = generated;
        state[generated] = initialValueForControl(type, node);
        applied.add(`generated bind ${generated}`);
      }
      if (node.label === undefined) {
        const resolvedBind = String(node.bind ?? '');
        node.label = humanize(resolvedBind.replace(/[{}]/g, '') || type);
        applied.add(`filled ${type} label`);
      }
      if (type === 'Select') normalizeSelect(node, state, applied);
    }

    if (type === 'Row' && Array.isArray(node.children) && node.children.length > 3 && node.wrap !== true) {
      node.wrap = true;
      applied.add('enabled Row wrap');
    }

    if (type === 'Repeat' && node.source === undefined && literalCollection(node.collection)) {
      node.source = 'records';
      applied.add('filled Repeat source');
    }
    if (type === 'Repeat' && node.source === 'records' && node.empty === undefined) {
      node.empty = emptyText(String((root.manifest as Record<string, unknown> | undefined)?.locale ?? 'en'));
      applied.add('filled Repeat empty state');
    }

    const currentRepeat = type === 'Repeat'
      ? { alias: typeof node.as === 'string' && node.as ? sanitizeIdentifier(node.as) || 'item' : 'item', collection: literalCollection(node.collection) }
      : repeatContext;

    if (Array.isArray(node.onPress)) {
      const hasPaid = node.onPress.some((raw) => isRecord(raw) && (raw.action === 'llm.ask' || raw.action === 'image.generate'));
      if (type === 'Button' && hasPaid && node.disabled === undefined) {
        node.disabled = 'llmBusy';
        applied.add('guarded paid action with llmBusy');
      }
      for (const raw of node.onPress) if (isRecord(raw)) {
        const step = raw as MutableStep;
        steps.push(step);
        normalizeStep(step, state, capabilities, currentRepeat, applied);
      }
    }

    if (Array.isArray(node.children)) node.children.forEach((child) => visitNode(child, currentRepeat));
  };

  if (isRecord(root.screens)) Object.values(screens).forEach((node) => visitNode(node));
  for (const def of Object.values(customComponents)) if (isRecord(def)) visitNode(def.template);

  // Build/extend record schemas from actual writes and visual consumers.
  const declaredNamesBefore = Object.keys(collections);
  for (const step of steps) {
    if (!['records.add', 'records.update', 'records.clear'].includes(String(step.action ?? ''))) continue;
    if ((step.collection === undefined || step.collection === '') && declaredNamesBefore.length === 1) {
      step.collection = declaredNamesBefore[0];
      applied.add('filled missing record collection');
    }
  }

  for (const step of steps) {
    if (!['records.add', 'records.update'].includes(String(step.action ?? ''))) continue;
    const name = literalCollection(step.collection);
    if (!name) continue;
    const values = isRecord(step.values) ? step.values : null;
    if (!values || Object.keys(values).length === 0) continue;
    const candidate = getCandidate(candidates, name);
    for (const [key, raw] of Object.entries(values)) addField(candidate, key, inferKind(key, raw, state));
    candidate.score += 3;
  }

  for (const node of nodes) {
    const type = String(node.type ?? '');
    const name = literalCollection(node.collection);
    if (!name) continue;
    const candidate = getCandidate(candidates, name);
    if (type === 'Table' && Array.isArray(node.columns)) {
      for (const raw of node.columns) if (isRecord(raw) && typeof raw.key === 'string') addField(candidate, raw.key, inferKind(raw.key, null, state), String(raw.label ?? raw.key));
      candidate.score += 2;
    }
    if (type === 'List') {
      if (typeof node.valueKey === 'string') addField(candidate, node.valueKey, inferKind(node.valueKey, null, state));
      if (typeof node.imageKey === 'string') addField(candidate, node.imageKey, 'image');
      candidate.score += 1;
    }
    if (type === 'PieChart') {
      if (typeof node.groupBy === 'string') addField(candidate, node.groupBy, 'text');
      if (typeof node.valueKey === 'string') addField(candidate, node.valueKey, 'number');
      candidate.score += 2;
    }
    if (type === 'Calendar') {
      if (typeof node.dateKey === 'string') addField(candidate, node.dateKey, 'date');
      candidate.score += 1;
    }
    if (type === 'Gallery' && typeof node.imageKey === 'string') {
      addField(candidate, node.imageKey, 'image');
      candidate.score += 2;
    }
  }

  for (const [name, candidate] of candidates) {
    const existing = isRecord(collections[name]) ? collections[name] as Record<string, unknown> : null;
    const existingFields = existing && Array.isArray(existing.fields) ? existing.fields.filter(isRecord) as Record<string, unknown>[] : [];
    const keys = new Set(existingFields.map((field) => String(field.key ?? '')).filter(Boolean));
    const inferred = [...candidate.fields.values()].filter((field) => !keys.has(field.key));
    if (!existing && candidate.fields.size > 0 && candidate.score > 0) {
      const fields = [...candidate.fields.values()];
      const numeric = fields.find((field) => field.kind === 'number');
      collections[name] = { fields, ...(numeric ? { valueField: numeric.key } : {}) };
      applied.add(`declared inferred collection ${name}`);
    } else if (existing && inferred.length) {
      existing.fields = [...existingFields, ...inferred];
      if (!existing.valueField) {
        const numeric = [...existingFields, ...inferred].find((field) => field.kind === 'number');
        if (numeric) existing.valueField = String(numeric.key);
      }
      applied.add(`extended collection ${name}`);
    }
  }

  sanitizeCollectionSchemas(collections, applied);

  // Once collection schemas are known, fill display metadata that is an
  // unambiguous projection of those fields. This prevents a forgotten Table
  // columns/PieChart groupBy from consuming a semantic repair round.
  for (const node of nodes) {
    const name = literalCollection(node.collection);
    const schema = name && isRecord(collections[name]) ? collections[name] as Record<string, unknown> : null;
    const fields = schema && Array.isArray(schema.fields) ? schema.fields.filter(isRecord) : [];
    if (node.type === 'Table' && (!Array.isArray(node.columns) || node.columns.length === 0) && fields.length) {
      node.columns = fields.slice(0, 4).map((field) => ({ key: String(field.key ?? ''), label: String(field.label ?? humanize(String(field.key ?? ''))) })).filter((field) => field.key);
      applied.add('filled Table columns');
    }
    if (node.type === 'PieChart' && fields.length) {
      if (typeof node.groupBy !== 'string' || !node.groupBy) {
        const group = fields.find((field) => field.kind === 'text') ?? fields[0];
        if (group?.key) { node.groupBy = String(group.key); applied.add('filled PieChart groupBy'); }
      }
      if (typeof node.valueKey !== 'string' || !node.valueKey) {
        const value = fields.find((field) => field.kind === 'number');
        if (value?.key) { node.valueKey = String(value.key); applied.add('filled PieChart valueKey'); }
      }
    }
  }

  const finalNames = Object.keys(collections);
  if (finalNames.length === 1) {
    const only = finalNames[0];
    for (const step of steps) {
      if (!['records.add', 'records.update', 'records.clear'].includes(String(step.action ?? ''))) continue;
      if (step.collection === undefined || step.collection === '') {
        step.collection = only;
        applied.add('filled missing record collection');
      }
    }
    for (const node of nodes) {
      const type = String(node.type ?? '');
      const recordBacked = ['List', 'Table', 'Gallery', 'PieChart'].includes(type) || (type === 'Repeat' && node.source === 'records');
      if (recordBacked && (node.collection === undefined || node.collection === '')) {
        node.collection = only;
        applied.add('filled missing record component collection');
      }
    }
  }

  root.capabilities = [...capabilities];
  root.state = state;
  if (Object.keys(collections).length === 0) delete root.collections;

  if (Array.isArray(root.persist)) {
    const persist = [...new Set(root.persist.filter((key): key is string => typeof key === 'string' && key in state))];
    if (persist.length !== root.persist.length) applied.add('cleaned persist keys');
    root.persist = persist;
  }

  normalizeNavigation(root, applied);
  return { spec: root, applied: [...applied] };
}

function normalizeScreenRoots(screens: Record<string, unknown>, applied: Set<string>): void {
  for (const [name, raw] of Object.entries(screens)) {
    if (!isRecord(raw)) continue;
    if (raw.type !== 'Screen') {
      screens[name] = { type: 'Screen', children: [raw] };
      applied.add(`wrapped screen ${name}`);
    }
  }
}

function normalizeCustomComponentNames(components: Record<string, unknown>, applied: Set<string>): Map<string, string> {
  const renames = new Map<string, string>();
  const used = new Set(Object.keys(components));
  for (const oldName of Object.keys(components)) {
    if (/^[A-Z][A-Za-z0-9]{1,39}$/.test(oldName) && !knownCoreComponents.has(oldName)) continue;
    let base = `App${pascal(oldName) || 'Component'}`.slice(0, 40);
    if (!/^[A-Z]/.test(base)) base = `App${base}`.slice(0, 40);
    let next = base;
    let i = 2;
    while (used.has(next) || knownCoreComponents.has(next)) next = `${base.slice(0, 36)}${i++}`;
    components[next] = components[oldName];
    delete components[oldName];
    used.add(next);
    renames.set(oldName, next);
    applied.add(`renamed custom component ${oldName} -> ${next}`);
  }
  return renames;
}

function renameComponentUsages(raw: unknown, renames: Map<string, string>): void {
  if (!isRecord(raw)) return;
  if (typeof raw.type === 'string' && renames.has(raw.type)) raw.type = renames.get(raw.type)!;
  if (Array.isArray(raw.children)) raw.children.forEach((child) => renameComponentUsages(child, renames));
}

function normalizeCommonProps(node: Record<string, unknown>, applied: Set<string>): void {
  if (node.children !== undefined && !Array.isArray(node.children)) {
    if (isRecord(node.children)) { node.children = [node.children]; applied.add('wrapped children array'); }
  }
  if (node.onPress !== undefined && !Array.isArray(node.onPress)) {
    if (isRecord(node.onPress)) { node.onPress = [node.onPress]; applied.add('wrapped onPress array'); }
  }

  // Runtime expression-bearing props are strings. Models occasionally emit a
  // literal number/boolean even though the intent is perfectly unambiguous.
  const stringProps: Record<string, string[]> = {
    Text: ['value'], Stat: ['label','value'], ProgressRing: ['progress','value'], ProgressBar: ['progress'],
    Badge: ['value'], EmptyState: ['title'], Chart: ['values'], Image: ['source'], Button: ['title'],
    Sandbox: ['html'], LineChart: ['values'], PieChart: ['groupBy'], Repeat: ['source'],
  };
  for (const key of stringProps[String(node.type ?? '')] ?? []) {
    const value = node[key];
    if (value !== undefined && typeof value !== 'string' && (typeof value === 'number' || typeof value === 'boolean' || Array.isArray(value))) {
      node[key] = Array.isArray(value) ? JSON.stringify(value) : String(value);
      applied.add(`coerced ${String(node.type)}.${key} to string`);
    }
  }

  if (node.type === 'Text' && node.value === undefined) {
    const value = firstString(node.text, node.title, node.label);
    if (value) { node.value = value; applied.add('filled Text value'); }
  }
  if (node.type === 'Button' && node.title === undefined) {
    const title = firstString(node.text, node.label, node.value);
    if (title) { node.title = title.slice(0, 120); applied.add('filled Button title'); }
  }
  if (node.type === 'Stat') {
    if (node.label === undefined) node.label = firstString(node.title, node.name) || 'Value';
    if (node.value === undefined) node.value = firstString(node.text, node.amount) || '—';
  }
  if (node.type === 'ProgressBar' && node.progress === undefined && typeof node.value === 'string') node.progress = node.value;
  if (node.type === 'EmptyState' && node.title === undefined) { node.title = 'No data yet'; applied.add('filled EmptyState title'); }
  if ((node.type === 'Chart' || node.type === 'LineChart') && node.values === undefined) { node.values = '[]'; applied.add(`filled ${String(node.type)} values`); }

  if (node.type === 'Select' && Array.isArray(node.options)) {
    node.options = node.options.map((raw) => {
      if (typeof raw === 'string' || typeof raw === 'number') return { value: String(raw), label: String(raw) };
      if (!isRecord(raw)) return raw;
      const value = raw.value ?? raw.id ?? raw.key ?? raw.label;
      const label = raw.label ?? raw.title ?? raw.name ?? value;
      return { ...raw, value: String(value ?? ''), label: String(label ?? value ?? '') };
    }).filter((raw) => isRecord(raw) && typeof raw.value === 'string' && raw.value !== '' && typeof raw.label === 'string');
  }
  if (node.type === 'Table' && Array.isArray(node.columns)) {
    node.columns = node.columns.map((raw) => {
      if (typeof raw === 'string') return { key: raw, label: humanize(raw) };
      if (!isRecord(raw)) return raw;
      const key = raw.key ?? raw.id ?? raw.field;
      const label = raw.label ?? raw.title ?? raw.name ?? key;
      return { ...raw, key: String(key ?? ''), label: String(label ?? key ?? '') };
    }).filter((raw) => isRecord(raw) && typeof raw.key === 'string' && raw.key !== '' && typeof raw.label === 'string');
  }
}

function normalizeSelect(node: Record<string, unknown>, state: Record<string, unknown>, applied: Set<string>): void {
  if (!Array.isArray(node.options)) return;
  const deduped: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const raw of node.options) {
    if (!isRecord(raw) || typeof raw.value !== 'string' || typeof raw.label !== 'string') continue;
    if (seen.has(raw.value)) continue;
    seen.add(raw.value);
    deduped.push(raw);
  }
  if (deduped.length !== node.options.length) { node.options = deduped; applied.add('deduped Select options'); }
  const bind = typeof node.bind === 'string' && !node.bind.includes('{{') ? node.bind : '';
  if (bind && deduped.length && !deduped.some((option) => option.value === state[bind])) {
    state[bind] = deduped[0].value;
    applied.add(`aligned Select state ${bind}`);
  }
}

function normalizeStep(
  step: MutableStep,
  state: Record<string, unknown>,
  capabilities: Set<string>,
  repeatContext: { alias: string; collection: string } | undefined,
  applied: Set<string>,
): void {
  const action = typeof step.action === 'string' ? step.action : '';
  const requiredCapability = capabilityByAction.get(action);
  if (requiredCapability && !capabilities.has(requiredCapability)) {
    capabilities.add(requiredCapability);
    applied.add(`declared capability ${requiredCapability}`);
  }

  if (action.startsWith('state.') && action !== 'state.reset' && typeof step.key === 'string' && !step.key.includes('{{')) {
    const key = step.key;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !(key in state)) {
      state[key] = action === 'state.toggle' ? false : action === 'state.random' && step.chars !== undefined ? '' : inferStateValue(step.value);
      applied.add(`declared action state ${key}`);
    }
  }

  if (action === 'camera.capture' && (typeof step.into !== 'string' || !step.into)) {
    step.into = uniqueStateKey(state, 'capturedPhoto');
    applied.add('filled camera.capture destination');
  }
  if (action === 'image.generate' && (typeof step.into !== 'string' || !step.into)) {
    step.into = uniqueStateKey(state, 'generatedImage');
    applied.add('filled image.generate destination');
  }
  if (action === 'llm.ask' && !isRecord(step.fields) && (typeof step.into !== 'string' || !step.into)) {
    step.into = uniqueStateKey(state, 'aiResult');
    applied.add('filled llm.ask destination');
  }

  if ((action === 'camera.capture' || action === 'image.generate') && typeof step.into === 'string' && !(step.into in state)) {
    state[step.into] = '';
    applied.add(`declared state ${step.into}`);
  }
  if (action === 'llm.ask') {
    if (typeof step.into === 'string' && !(step.into in state)) { state[step.into] = ''; applied.add(`declared state ${step.into}`); }
    if (isRecord(step.fields)) for (const key of Object.keys(step.fields)) if (!(key in state)) {
      state[key] = numericName(key) ? 0 : '';
      applied.add(`declared AI field ${key}`);
    }
  }

  if ((action === 'records.update' || action === 'records.remove') && step.id === undefined && repeatContext?.alias) {
    step.id = `{{${repeatContext.alias}Id}}`;
    applied.add(`filled ${action} id from Repeat`);
  }
  if ((action === 'records.update' || action === 'records.clear') && (step.collection === undefined || step.collection === '') && repeatContext?.collection) {
    step.collection = repeatContext.collection;
    applied.add(`filled ${action} collection from Repeat`);
  }
}

function normalizeNavigation(root: Record<string, unknown>, applied: Set<string>): void {
  if (!isRecord(root.screens)) return;
  const names = Object.keys(root.screens);
  if (!names.length) return;
  const first = names[0];
  const nav = isRecord(root.navigation) ? root.navigation : {};
  if (!isRecord(root.navigation)) { root.navigation = nav; applied.add('filled navigation'); }
  if (typeof nav.start !== 'string' || !names.includes(nav.start)) { nav.start = first; applied.add('fixed navigation.start'); }
  const mode = nav.mode;
  if (names.length === 1) {
    if (mode !== 'single') { nav.mode = 'single'; applied.add('fixed navigation.mode'); }
    delete nav.tabs;
  } else {
    if (!['stack', 'tabs'].includes(String(mode))) { nav.mode = 'stack'; applied.add('fixed navigation.mode'); }
    if (nav.mode === 'tabs') {
      const tabs = Array.isArray(nav.tabs) ? nav.tabs.filter(isRecord).map((raw) => ({
        screen: typeof raw.screen === 'string' ? raw.screen : '',
        label: typeof raw.label === 'string' ? raw.label : humanize(String(raw.screen ?? '')),
        ...(typeof raw.icon === 'string' ? { icon: raw.icon } : {}),
      })).filter((tab) => names.includes(tab.screen)) : [];
      const seen = new Set<string>();
      const unique = tabs.filter((tab) => !seen.has(tab.screen) && Boolean(seen.add(tab.screen))).slice(0, 4);
      if (unique.length < 2 || !unique.some((tab) => tab.screen === nav.start)) {
        nav.mode = 'stack';
        delete nav.tabs;
        applied.add('downgraded invalid tabs to stack');
      } else nav.tabs = unique;
    }
  }
  if (isRecord(nav.titles)) {
    for (const key of Object.keys(nav.titles)) if (!names.includes(key)) delete nav.titles[key];
  }

  // Every generated screen must have a real entry point. If the model designed
  // a detail/history screen but forgot the navigation button, add a compact
  // link on the start screen rather than rejecting the whole otherwise-valid app.
  const targets = new Set<string>([String(nav.start)]);
  if (Array.isArray(nav.tabs)) for (const raw of nav.tabs) if (isRecord(raw) && typeof raw.screen === 'string') targets.add(raw.screen);
  const scanNav = (raw: unknown): void => {
    if (!isRecord(raw)) return;
    if (Array.isArray(raw.onPress)) for (const step of raw.onPress) if (isRecord(step) && step.action === 'nav.go' && typeof step.screen === 'string' && !step.screen.includes('{{')) targets.add(step.screen);
    if (Array.isArray(raw.children)) raw.children.forEach(scanNav);
  };
  Object.values(root.screens).forEach(scanNav);
  const startRoot = root.screens[String(nav.start)];
  if (isRecord(startRoot)) {
    const children = Array.isArray(startRoot.children) ? startRoot.children : [];
    if (!Array.isArray(startRoot.children)) startRoot.children = children;
    for (const screen of names) {
      if (targets.has(screen) || screen === nav.start) continue;
      const title = isRecord(nav.titles) && typeof nav.titles[screen] === 'string' ? String(nav.titles[screen]) : humanize(screen);
      children.push({ type: 'Button', title, variant: 'secondary', onPress: [{ action: 'nav.go', screen }] });
      targets.add(screen);
      applied.add(`added navigation entry to ${screen}`);
    }
  }
}

function sanitizeCollectionSchemas(collections: Record<string, unknown>, applied: Set<string>): void {
  for (const [name, raw] of Object.entries(collections)) {
    if (!isRecord(raw) || !Array.isArray(raw.fields)) continue;
    const seen = new Set<string>();
    const fields: Record<string, unknown>[] = [];
    for (const field of raw.fields) {
      if (!isRecord(field) || typeof field.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.key) || seen.has(field.key)) continue;
      seen.add(field.key);
      fields.push({ key: field.key, label: typeof field.label === 'string' ? field.label : humanize(field.key), kind: validFieldKind(field.kind) ? field.kind : inferKind(field.key, null, {}) });
    }
    if (fields.length !== raw.fields.length) applied.add(`cleaned collection ${name}`);
    raw.fields = fields;
    if (typeof raw.valueField === 'string' && !seen.has(raw.valueField)) {
      const numeric = fields.find((field) => field.kind === 'number');
      if (numeric) raw.valueField = numeric.key;
      else delete raw.valueField;
      applied.add(`fixed collection ${name} valueField`);
    }
  }
}

function getCandidate(map: Map<string, Candidate>, name: string): Candidate {
  let value = map.get(name);
  if (!value) { value = { fields: new Map(), score: 0 }; map.set(name, value); }
  return value;
}

function addField(candidate: Candidate, key: string, kind: RecordField['kind'], label = humanize(key)): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || candidate.fields.has(key)) return;
  candidate.fields.set(key, { key, label, kind });
}

function inferKind(key: string, raw: unknown, state: Record<string, unknown>): RecordField['kind'] {
  if (/image|photo|picture|avatar|receipt|snapshot/i.test(key)) return 'image';
  if (/date|day|time|timestamp|startedAt|endedAt|createdAt/i.test(key)) return 'date';
  if (/^is[A-Z_]|^has[A-Z_]|done|complete|enabled|active|checked/i.test(key)) return 'boolean';
  if (typeof raw === 'number') return 'number';
  if (typeof raw === 'boolean') return 'boolean';
  if (typeof raw === 'string') {
    const exact = raw.match(/^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/)?.[1];
    if (exact && exact in state) {
      const value = state[exact];
      if (typeof value === 'number') return 'number';
      if (typeof value === 'boolean') return 'boolean';
      if (typeof value === 'string' && /image|photo/i.test(exact)) return 'image';
    }
  }
  if (numericName(key)) return 'number';
  return 'text';
}

function initialValueForControl(type: string, node: Record<string, unknown>): JsonValue {
  if (type === 'Toggle') return false;
  if (type === 'TextField') return '';
  if (type === 'Select' && Array.isArray(node.options)) {
    const first = node.options.find((raw) => isRecord(raw) && typeof raw.value === 'string') as Record<string, unknown> | undefined;
    return typeof first?.value === 'string' ? first.value : '';
  }
  return 0;
}

function inferStateValue(raw: unknown): JsonValue {
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string' || raw === null) return raw;
  return 0;
}

function isBindable(type: string): boolean {
  return ['NumberField', 'TextField', 'Slider', 'Stepper', 'Toggle', 'Select', 'Calendar', 'DateField'].includes(type);
}

function literalCollection(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(value) ? value : '';
}

function numericName(key: string): boolean {
  return /amount|price|cost|total|count|qty|quantity|weight|height|distance|duration|score|rating|calorie|protein|carb|fat|ml|grams?|percent|rate|value/i.test(key);
}

function humanize(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (m) => m.toUpperCase()).slice(0, 60);
}
function pascal(value: string): string { return value.replace(/[^A-Za-z0-9]+(.)?/g, (_m, ch: string | undefined) => ch ? ch.toUpperCase() : '').replace(/^./, (m) => m.toUpperCase()); }
function sanitizeIdentifier(value: string): string { const cleaned = value.replace(/[^A-Za-z0-9_]/g, ''); return /^[A-Za-z_]/.test(cleaned) ? cleaned : ''; }
function firstString(...values: unknown[]): string { return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() ?? ''; }
function validFieldKind(value: unknown): value is RecordField['kind'] { return ['number','text','date','image','boolean'].includes(String(value)); }
function emptyText(locale: string): string { return locale.toLowerCase().startsWith('ru') ? 'Пока нет записей' : 'No entries yet'; }
function uniqueStateKey(state: Record<string, unknown>, base: string): string {
  if (!(base in state)) return base;
  let index = 2;
  while (`${base}${index}` in state) index += 1;
  return `${base}${index}`;
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
