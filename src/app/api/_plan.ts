import { ACTION_NAMES, CAPABILITIES, COMPONENT_TYPES } from '@/lib/dsl';
import { THINKING, callGemini, safeJsonParse } from './_shared';

export type AppKind = 'game' | 'tracker' | 'calculator' | 'timer' | 'converter' | 'ai_tool' | 'image_tool' | 'list' | 'countdown' | 'other';

export interface Feature {
  id: string;
  title: string;
  description: string;
  essential: boolean;
  /** Observable user outcomes, not implementation details. */
  acceptanceCriteria: string[];
  /** Data/AI semantics needed by this specific feature. */
  requiresRecords?: boolean;
  requiresStructuredAi?: boolean;
  /** Exact mechanical minimums. Never list visual substitutes. */
  requiresComponents: string[];
  requiresActions: string[];
  requiresCapabilities: string[];
}

export interface PlannedScreen { id: string; title: string; purpose: string }
export interface PlannedCustomComponent { name: string; purpose: string; strategy: 'compose' | 'extend' }

export interface Plan {
  kind: AppKind;
  title: string;
  capabilities: string[];
  components: string[];
  needsRecords: boolean;
  needsStructuredAi: boolean;
  summary: string;
  navigation: 'single' | 'stack' | 'tabs';
  screens: PlannedScreen[];
  customComponents: PlannedCustomComponent[];
  features: Feature[];
}

const KINDS: AppKind[] = ['game', 'tracker', 'calculator', 'timer', 'converter', 'ai_tool', 'image_tool', 'list', 'countdown', 'other'];
const KIND_SET = new Set<string>(KINDS);
const COMPONENT_SET = new Set<string>(COMPONENT_TYPES);
const ACTION_SET = new Set<string>(ACTION_NAMES);
const CAPABILITY_SET = new Set<string>(CAPABILITIES);

/**
 * Planner-only schema. `_shared` converts this OpenAPI-style representation to
 * Gemini's current responseJsonSchema at the HTTP boundary.
 */
const FEATURE_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    id: { type: 'STRING' },
    title: { type: 'STRING' },
    description: { type: 'STRING' },
    essential: { type: 'BOOLEAN' },
    acceptanceCriteria: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 1, maxItems: 4 },
    requiresRecords: { type: 'BOOLEAN' },
    requiresStructuredAi: { type: 'BOOLEAN' },
    requiresComponents: { type: 'ARRAY', items: { type: 'STRING', enum: COMPONENT_TYPES } },
    requiresActions: { type: 'ARRAY', items: { type: 'STRING', enum: ACTION_NAMES } },
    requiresCapabilities: { type: 'ARRAY', items: { type: 'STRING', enum: [...CAPABILITIES] } },
  },
  required: [
    'id', 'title', 'description', 'essential', 'acceptanceCriteria', 'requiresRecords',
    'requiresStructuredAi', 'requiresComponents', 'requiresActions', 'requiresCapabilities',
  ],
};

const SCREEN_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: { id: { type: 'STRING' }, title: { type: 'STRING' }, purpose: { type: 'STRING' } },
  required: ['id', 'title', 'purpose'],
};

const CUSTOM_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' },
    purpose: { type: 'STRING' },
    strategy: { type: 'STRING', enum: ['compose', 'extend'] },
  },
  required: ['name', 'purpose', 'strategy'],
};

const PLAN_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: KINDS },
    title: { type: 'STRING' },
    summary: { type: 'STRING' },
    navigation: { type: 'STRING', enum: ['single', 'stack', 'tabs'] },
    screens: { type: 'ARRAY', items: SCREEN_SCHEMA, minItems: 1, maxItems: 4 },
    customComponents: { type: 'ARRAY', items: CUSTOM_SCHEMA, maxItems: 8 },
    features: { type: 'ARRAY', items: FEATURE_SCHEMA, minItems: 1, maxItems: 8 },
    needsRecords: { type: 'BOOLEAN' },
    needsStructuredAi: { type: 'BOOLEAN' },
    capabilities: { type: 'ARRAY', items: { type: 'STRING', enum: [...CAPABILITIES] } },
    components: { type: 'ARRAY', items: { type: 'STRING', enum: COMPONENT_TYPES } },
  },
  required: [
    'kind', 'title', 'summary', 'navigation', 'screens', 'customComponents', 'features',
    'needsRecords', 'needsStructuredAi', 'capabilities', 'components',
  ],
  propertyOrdering: [
    'kind', 'title', 'summary', 'navigation', 'screens', 'customComponents', 'features',
    'needsRecords', 'needsStructuredAi', 'capabilities', 'components',
  ],
};

const PLAN_SYSTEM = [
  'You are a senior mobile product manager and UX architect. Plan the PRODUCT first; do not write the runtime JSON yet.',
  'Design the ideal small mobile app for the user request before adapting it to the existing component library.',
  'The runtime supports 1-4 screens, stack or tabs navigation, records, AI/device actions, and safe app-specific composite components.',
  '',
  'FEATURES: propose 3-8 genuinely useful user outcomes when the product needs them, but never pad a simple app with fake features. Return at least 1. Do not merely restate the request or name a UI component.',
  'For each feature include 1-4 acceptanceCriteria: observable statements that make it clear the feature actually works.',
  'Set requiresRecords per feature when that outcome depends on persistent user-created data; set requiresStructuredAi only when that feature needs typed AI output.',
  'requiresComponents/actions/capabilities are STRICT minimums only. If a feature can be implemented with several UX patterns, leave component requirements empty rather than naming a substitute.',
  'Never say Calendar can be replaced by DateField, Chart by ProgressRing, or one AI action by another. Requirements are exact.',
  '',
  'SCREENS: choose the simplest information architecture that makes the app convenient. 1 screen is fine for a calculator; trackers often need Home/Add/History. Maximum 4.',
  'navigation: single for one screen, stack for drill-down/add/edit flows, tabs only when 2-4 peer destinations are used repeatedly.',
  '',
  'CUSTOM COMPONENT GAP ANALYSIS: imagine the ideal control first. If core components would force an awkward UX, propose an app-specific PascalCase component in customComponents.',
  'strategy=compose means it can be built from safe declarative primitives; strategy=extend means it specializes an existing control. Do not propose native code.',
  'Examples: HabitWeekGrid, ExpenseCard, WorkoutSetRow, CycleSummaryCard. Avoid custom components when a normal Button/Text/Card/Field is already ideal.',
  '',
  'components is only a list of likely CORE building blocks, never a whitelist for the builder.',
  'needsRecords=true when user-created entries/history are persistent. needsStructuredAi=true when AI must return numeric/fixed fields rather than prose.',
  'kind game must use Sandbox for the actual continuous game/canvas logic. image_tool uses image capability.',
  'title <= 24 chars. All user-facing title/summary/features/screens are in the user language.',
].join('\n');

/**
 * Used only for the second planner attempt when provider-side structured-output
 * validation rejects a schema. JSON MIME type remains enabled, but no response
 * schema is attached to the HTTP request.
 */
const JSON_CONTRACT = [
  '',
  'Return one JSON object with EXACTLY this top-level shape:',
  '{',
  '  "kind": "tracker|calculator|timer|converter|ai_tool|image_tool|game|list|countdown|other",',
  '  "title": "...", "summary": "...", "navigation": "single|stack|tabs",',
  '  "screens": [{"id":"home","title":"...","purpose":"..."}],',
  '  "customComponents": [{"name":"PascalCaseName","purpose":"...","strategy":"compose|extend"}],',
  '  "features": [{',
  '    "id":"stable-id","title":"...","description":"...","essential":true,',
  '    "acceptanceCriteria":["observable outcome"],',
  '    "requiresRecords":false,"requiresStructuredAi":false,',
  '    "requiresComponents":[],"requiresActions":[],"requiresCapabilities":[]',
  '  }],',
  '  "needsRecords": false, "needsStructuredAi": false, "capabilities": [], "components": []',
  '}',
  'No markdown and no commentary outside the JSON object.',
].join('\n');

const EMPTY_PLAN: Plan = {
  kind: 'other', title: '', capabilities: [], components: [], needsRecords: false,
  needsStructuredAi: false, summary: '', navigation: 'single',
  screens: [{ id: 'home', title: '', purpose: '' }], customComponents: [], features: [],
};

export interface PlanResult {
  plan: Plan;
  ok: boolean;
  /** How the plan was obtained; useful for server diagnostics and tests. */
  mode?: 'structured' | 'json' | 'local';
  /** Provider/parser failure is logged server-side, never shown as raw text in UI. */
  diagnostic?: string;
}

function safeId(value: unknown, fallback: string): string {
  const id = String(value ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return id || fallback;
}

function exactList(raw: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((item): item is string => typeof item === 'string' && allowed.has(item)))];
}

function normalizeFeatures(raw: unknown): Feature[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Feature[] = [];
  for (const item of raw as Partial<Feature>[]) {
    const id = safeId(item?.id, `feature-${out.length + 1}`);
    const title = String(item?.title ?? '').trim();
    if (!title || seen.has(id)) continue;
    seen.add(id);
    const criteria = Array.isArray(item.acceptanceCriteria)
      ? item.acceptanceCriteria.map((x) => String(x).trim()).filter(Boolean).slice(0, 4)
      : [];
    out.push({
      id,
      title: title.slice(0, 70),
      description: String(item.description ?? '').trim().slice(0, 180),
      essential: Boolean(item.essential),
      acceptanceCriteria: criteria.length ? criteria : [String(item.description || title).slice(0, 180)],
      requiresRecords: Boolean(item.requiresRecords),
      requiresStructuredAi: Boolean(item.requiresStructuredAi),
      requiresComponents: exactList(item.requiresComponents, COMPONENT_SET),
      requiresActions: exactList(item.requiresActions, ACTION_SET),
      requiresCapabilities: exactList(item.requiresCapabilities, CAPABILITY_SET),
    });
  }
  return out.slice(0, 8);
}

function normalizeScreens(raw: unknown): PlannedScreen[] {
  if (!Array.isArray(raw)) return EMPTY_PLAN.screens;
  const seen = new Set<string>();
  const out: PlannedScreen[] = [];
  for (const item of raw as Partial<PlannedScreen>[]) {
    const id = safeId(item.id, `screen-${out.length + 1}`).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: String(item.title ?? '').trim().slice(0, 40), purpose: String(item.purpose ?? '').trim().slice(0, 180) });
  }
  return out.length ? out.slice(0, 4) : EMPTY_PLAN.screens;
}

function normalizeCustom(raw: unknown): PlannedCustomComponent[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PlannedCustomComponent[] = [];
  for (const item of raw as Partial<PlannedCustomComponent>[]) {
    let name = String(item.name ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
    if (!/^[A-Z]/.test(name)) name = `App${name || 'Component'}`;
    if (seen.has(name) || COMPONENT_SET.has(name)) continue;
    seen.add(name);
    out.push({ name, purpose: String(item.purpose ?? '').trim().slice(0, 220), strategy: item.strategy === 'extend' ? 'extend' : 'compose' });
  }
  return out.slice(0, 8);
}

function correct(plan: Plan): Plan {
  const capabilities = new Set(plan.capabilities);
  const components = new Set(plan.components);
  if (plan.kind === 'game') { capabilities.add('sandbox'); components.add('Sandbox'); }
  if (plan.kind === 'image_tool') { capabilities.add('image'); components.add('Image'); }
  if (capabilities.has('camera')) components.add('Image');
  if (capabilities.has('image')) components.add('Image');
  return { ...plan, capabilities: [...capabilities], components: [...components] };
}

/** Normalize either a structured-output response or a JSON-only fallback. */
export function normalizePlanCandidate(raw: unknown): Plan | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as Partial<Plan>;
  const features = normalizeFeatures(parsed.features);
  if (features.length < 1) return null;
  const screens = normalizeScreens(parsed.screens);
  let navigation: Plan['navigation'] = parsed.navigation === 'tabs' || parsed.navigation === 'stack' ? parsed.navigation : 'single';
  if (screens.length === 1) navigation = 'single';
  if (screens.length > 1 && navigation === 'single') navigation = 'stack';

  return correct({
    kind: KIND_SET.has(String(parsed.kind)) ? parsed.kind as AppKind : 'other',
    title: String(parsed.title ?? '').trim().slice(0, 24),
    summary: String(parsed.summary ?? '').trim().slice(0, 500),
    navigation,
    screens,
    customComponents: normalizeCustom(parsed.customComponents),
    features,
    needsRecords: Boolean(parsed.needsRecords),
    needsStructuredAi: Boolean(parsed.needsStructuredAi),
    capabilities: exactList(parsed.capabilities, CAPABILITY_SET),
    components: exactList(parsed.components, COMPONENT_SET),
  });
}

function inferKind(request: string): AppKind {
  const q = request.toLocaleLowerCase();
  if (/\b(game|игр[ауы]|juego)\b/.test(q)) return 'game';
  if (/таймер|секундомер|\btimer\b|cron[oó]metro/.test(q)) return 'timer';
  if (/обратн.{0,8}отсч|countdown/.test(q)) return 'countdown';
  if (/конверт|converter|convertir|conversion/.test(q)) return 'converter';
  if (/калькул|calculator|calculadora|расч[её]т/.test(q)) return 'calculator';
  if (/трекер|дневник|уч[её]т|tracker|diary|registro|seguimiento/.test(q)) return 'tracker';
  if (/список|checklist|\blist\b|lista/.test(q)) return 'list';
  if (/картин|изображ|image|imagen|генератор фото/.test(q)) return 'image_tool';
  if (/\bai\b|\bии\b|нейро|assistant|ассистент/.test(q)) return 'ai_tool';
  return 'other';
}

/**
 * Last-resort Product Plan. It is intentionally conservative and does not invent
 * capabilities. The user still gets the mandatory feature-review screen and can
 * edit/add features instead of hitting a dead end because a provider returned
 * malformed JSON. Generation remains protected by the normal validation/repair
 * pipeline and is not charged on failure.
 */
export function createLocalPlan(request: string): Plan {
  const clean = request.replace(/\s+/g, ' ').trim().slice(0, 180);
  const kind = inferKind(clean);
  const needsRecords = kind === 'tracker' || kind === 'list';
  const title = clean.slice(0, 24);
  return correct({
    kind,
    title,
    summary: clean,
    navigation: 'single',
    screens: [{ id: 'home', title, purpose: clean }],
    customComponents: [],
    features: [{
      id: 'core',
      title: clean.slice(0, 70),
      description: clean,
      essential: true,
      acceptanceCriteria: [clean],
      requiresRecords: needsRecords,
      requiresStructuredAi: false,
      requiresComponents: [],
      requiresActions: [],
      requiresCapabilities: [],
    }],
    needsRecords,
    needsStructuredAi: false,
    capabilities: [],
    components: [],
  });
}

/** Derive a build plan from the exact feature selection the user made. */
export function planForFeatures(plan: Plan, selectedIds: string[]): Plan {
  const selected = plan.features.filter((feature) => selectedIds.includes(feature.id));
  const components = new Set<string>();
  const capabilities = new Set<string>();
  const actions = new Set<string>();

  for (const feature of selected) {
    feature.requiresComponents.forEach((item) => components.add(item));
    feature.requiresCapabilities.forEach((item) => capabilities.add(item));
    feature.requiresActions.forEach((item) => actions.add(item));
  }

  // Keep only structural hints; feature-specific requirements are re-derived above.
  for (const item of plan.components) {
    if (['Screen', 'Stack', 'Row', 'Grid', 'Card', 'Section', 'Text', 'Button', 'EmptyState'].includes(item)) components.add(item);
  }

  const recordComponents = new Set(['List', 'Table', 'Gallery', 'Chart', 'LineChart', 'PieChart']);
  const needsRecords = selected.some((feature) => Boolean(feature.requiresRecords))
    || [...actions].some((action) => action.startsWith('records.'))
    || [...components].some((component) => recordComponents.has(component));
  const needsStructuredAi = selected.some((feature) => Boolean(feature.requiresStructuredAi))
    || (capabilities.has('llm') && plan.needsStructuredAi && selected.length === plan.features.length);

  // If every proposed feature was deselected (for example, the user keeps only
  // a custom feature), do not leak the original feature-specific IA into it.
  const emptySelection = selected.length === 0;
  return correct({
    ...plan,
    features: selected,
    components: [...components],
    capabilities: [...capabilities],
    needsRecords,
    needsStructuredAi,
    navigation: emptySelection ? 'single' : plan.navigation,
    screens: emptySelection ? [plan.screens[0] ?? EMPTY_PLAN.screens[0]] : plan.screens,
    customComponents: emptySelection ? [] : plan.customComponents,
  });
}

export async function planApp(request: string, locale: string): Promise<PlanResult> {
  const system = `${PLAN_SYSTEM}\n\nUser language/locale: ${locale}.`;
  const user = `User request: ${JSON.stringify(request.slice(0, 800))}`;
  let diagnostic = '';

  // Attempt 1: current Gemini structured output. This is the highest-quality and
  // most deterministic path when the provider accepts the schema.
  const structured = await callGemini(system, user, {
    jsonOnly: true,
    thinking: THINKING.plan,
    purpose: 'plan',
    responseSchema: PLAN_SCHEMA,
  });
  if (structured.ok) {
    const parsed = safeJsonParse<unknown>(structured.text ?? '', null);
    const plan = normalizePlanCandidate(parsed);
    if (plan) return { ok: true, plan, mode: 'structured' };
    diagnostic = 'structured_response_invalid';
  } else {
    diagnostic = structured.error ?? 'structured_request_failed';
  }

  // Attempt 2: provider-independent JSON mode. This protects the entire feature
  // review flow from a response-schema regression without weakening our own
  // normalizer or signed-plan contract.
  const jsonFallback = await callGemini(`${system}${JSON_CONTRACT}`, user, {
    jsonOnly: true,
    thinking: THINKING.plan,
    purpose: 'plan',
  });
  if (jsonFallback.ok) {
    const parsed = safeJsonParse<unknown>(jsonFallback.text ?? '', null);
    const plan = normalizePlanCandidate(parsed);
    if (plan) {
      console.warn('[toolkin.plan] structured planner failed; JSON fallback succeeded');
      return { ok: true, plan, mode: 'json', diagnostic };
    }
    diagnostic = `${diagnostic}; json_response_invalid`;
  } else {
    diagnostic = `${diagnostic}; ${jsonFallback.error ?? 'json_request_failed'}`;
  }

  // Attempt 3: never make the mandatory review screen a dead end just because
  // model output formatting or a temporary provider outage failed twice. This
  // plan intentionally promises only the user's core request and no capabilities.
  console.error('[toolkin.plan] AI planning unavailable; using conservative local plan:', diagnostic.slice(0, 800));
  return { ok: true, plan: createLocalPlan(request), mode: 'local', diagnostic };
}
