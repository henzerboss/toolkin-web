import type { JsonValue, RecordField, UiNode } from './specTypes';

interface MutableStep { action?: unknown; collection?: unknown; values?: unknown; [key: string]: unknown }
interface Candidate { fields: Map<string, RecordField>; score: number }

/**
 * Deterministic pre-validation normalization for common model slips.
 *
 * This is intentionally narrow: it never invents product behavior. It only
 * makes explicit data declarations that are already unambiguously present in
 * record actions/UI. Anything ambiguous still goes through the LLM repair loop.
 */
export function normalizeGeneratedSpec(input: unknown): { spec: unknown; applied: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { spec: input, applied: [] };

  let root: Record<string, unknown>;
  try { root = JSON.parse(JSON.stringify(input)) as Record<string, unknown>; }
  catch { return { spec: input, applied: [] }; }

  const applied = new Set<string>();
  const state = isRecord(root.state) ? root.state : {};
  const collections = isRecord(root.collections) ? root.collections : {};
  root.collections = collections;

  const candidates = new Map<string, Candidate>();
  const steps: MutableStep[] = [];
  const nodes: Record<string, unknown>[] = [];

  const visitNode = (node: unknown): void => {
    if (!isRecord(node)) return;
    nodes.push(node);
    if (Array.isArray(node.onPress)) {
      for (const raw of node.onPress) if (isRecord(raw)) steps.push(raw as MutableStep);
    }
    if (Array.isArray(node.children)) node.children.forEach(visitNode);
  };

  if (isRecord(root.screens)) Object.values(root.screens).forEach(visitNode);
  if (isRecord(root.components)) {
    for (const def of Object.values(root.components)) if (isRecord(def)) visitNode(def.template);
  }

  const declaredNames = Object.keys(collections);

  // If exactly one collection exists, an omitted action collection is not
  // ambiguous. Fill it instead of spending a repair request on punctuation.
  for (const step of steps) {
    if (!['records.add', 'records.update', 'records.clear'].includes(String(step.action ?? ''))) continue;
    if ((step.collection === undefined || step.collection === '') && declaredNames.length === 1) {
      step.collection = declaredNames[0];
      applied.add('filled missing record collection');
    }
  }

  for (const step of steps) {
    if (!['records.add', 'records.update'].includes(String(step.action ?? ''))) continue;
    const name = literalCollection(step.collection);
    if (!name || isRecord(collections[name])) continue;
    const values = isRecord(step.values) ? step.values : null;
    if (!values || Object.keys(values).length === 0) continue;
    const candidate = getCandidate(candidates, name);
    for (const [key, raw] of Object.entries(values)) addField(candidate, key, inferKind(key, raw, state));
    candidate.score += 3;
  }

  // Record-backed visual components often expose enough schema information to
  // repair a missing declaration even when add/update lives on another screen.
  for (const node of nodes) {
    const type = String(node.type ?? '');
    const name = literalCollection(node.collection);
    if (!name || isRecord(collections[name])) continue;
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
    if (candidate.fields.size === 0 || candidate.score <= 0 || isRecord(collections[name])) continue;
    const fields = [...candidate.fields.values()];
    const numeric = fields.find((field) => field.kind === 'number');
    collections[name] = { fields, ...(numeric ? { valueField: numeric.key } : {}) };
    applied.add(`declared inferred collection ${name}`);
  }

  // A collection may have been inferred above. Once there is exactly one,
  // omitted collection parameters on record actions/components are again
  // unambiguous. Fill them in a second pass so a generated add+clear or
  // add+history flow does not fail only because one sibling forgot the name.
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

  if (Object.keys(collections).length === 0) delete root.collections;
  return { spec: root, applied: [...applied] };
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
  if (/is[A-Z_]|has[A-Z_]|done|complete|enabled|active|checked/i.test(key)) return 'boolean';

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
  if (/amount|price|cost|total|count|qty|quantity|weight|height|distance|duration|score|rating|calorie|protein|carb|fat|ml|grams?/i.test(key)) return 'number';
  return 'text';
}

function literalCollection(value: unknown): string {
  return typeof value === 'string' && /^[a-z][A-Za-z0-9_-]{0,39}$/.test(value) ? value : '';
}

function humanize(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (m) => m.toUpperCase()).slice(0, 60);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
