import type { JsonValue, MiniAppSpec, RecordField, UiNode } from '@/lib/specTypes';

interface ContractFeature {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  requiresRecords?: boolean;
  requiresStructuredAi?: boolean;
  requiresComponents?: string[];
  requiresActions?: string[];
  requiresCapabilities?: string[];
}

export interface ContractPlanLike {
  title?: string;
  capabilities?: string[];
  components?: string[];
  needsRecords?: boolean;
  needsStructuredAi?: boolean;
  features?: ContractFeature[];
}

export interface ContractCompileResult {
  spec: MiniAppSpec;
  applied: string[];
}

interface UiWords {
  capture: string;
  analyze: string;
  save: string;
  history: string;
  total: string;
  remaining: string;
  goal: string;
  aiError: string;
}

const WORDS: Record<string, UiWords> = {
  ru: { capture: 'Сделать фото', analyze: 'Распознать', save: 'Сохранить', history: 'История', total: 'Всего', remaining: 'Осталось', goal: 'Цель', aiError: 'Не удалось распознать' },
  uk: { capture: 'Зробити фото', analyze: 'Розпізнати', save: 'Зберегти', history: 'Історія', total: 'Усього', remaining: 'Залишилось', goal: 'Ціль', aiError: 'Не вдалося розпізнати' },
  es: { capture: 'Hacer foto', analyze: 'Analizar', save: 'Guardar', history: 'Historial', total: 'Total', remaining: 'Restante', goal: 'Objetivo', aiError: 'No se pudo analizar' },
  de: { capture: 'Foto aufnehmen', analyze: 'Analysieren', save: 'Speichern', history: 'Verlauf', total: 'Gesamt', remaining: 'Verbleibend', goal: 'Ziel', aiError: 'Analyse fehlgeschlagen' },
  fr: { capture: 'Prendre une photo', analyze: 'Analyser', save: 'Enregistrer', history: 'Historique', total: 'Total', remaining: 'Restant', goal: 'Objectif', aiError: "Échec de l’analyse" },
  it: { capture: 'Scatta foto', analyze: 'Analizza', save: 'Salva', history: 'Cronologia', total: 'Totale', remaining: 'Rimanente', goal: 'Obiettivo', aiError: 'Analisi non riuscita' },
  pt: { capture: 'Tirar foto', analyze: 'Analisar', save: 'Salvar', history: 'Histórico', total: 'Total', remaining: 'Restante', goal: 'Meta', aiError: 'Falha na análise' },
  pl: { capture: 'Zrób zdjęcie', analyze: 'Analizuj', save: 'Zapisz', history: 'Historia', total: 'Razem', remaining: 'Pozostało', goal: 'Cel', aiError: 'Analiza nie powiodła się' },
  tr: { capture: 'Fotoğraf çek', analyze: 'Analiz et', save: 'Kaydet', history: 'Geçmiş', total: 'Toplam', remaining: 'Kalan', goal: 'Hedef', aiError: 'Analiz başarısız' },
  ja: { capture: '写真を撮る', analyze: '解析', save: '保存', history: '履歴', total: '合計', remaining: '残り', goal: '目標', aiError: '解析できませんでした' },
  ko: { capture: '사진 찍기', analyze: '분석', save: '저장', history: '기록', total: '합계', remaining: '남음', goal: '목표', aiError: '분석하지 못했습니다' },
  zh: { capture: '拍照', analyze: '分析', save: '保存', history: '历史', total: '总计', remaining: '剩余', goal: '目标', aiError: '分析失败' },
  en: { capture: 'Take photo', analyze: 'Analyze', save: 'Save', history: 'History', total: 'Total', remaining: 'Remaining', goal: 'Goal', aiError: 'Could not analyze' },
};

const BINDABLE = new Set(['NumberField', 'TextField', 'Slider', 'Stepper', 'Toggle', 'Select', 'Calendar', 'DateField']);
const RECORD_VIEWS = new Set(['List', 'Table', 'Gallery', 'PieChart', 'Repeat']);
const AGGREGATE_VIEWS = new Set(['Stat', 'ProgressBar', 'ProgressRing']);

function cloneSpec(spec: MiniAppSpec): MiniAppSpec {
  return JSON.parse(JSON.stringify(spec)) as MiniAppSpec;
}

function words(locale: string | undefined): UiWords {
  const key = String(locale ?? 'en').toLowerCase().split(/[-_]/)[0];
  return WORDS[key] ?? WORDS.en;
}

function safeIdentifier(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  const startSafe = /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
  return (startSafe || fallback).slice(0, 40);
}

function uniqueKey(container: Record<string, unknown>, preferred: string): string {
  const base = safeIdentifier(preferred, 'autoValue');
  if (!(base in container)) return base;
  let index = 2;
  while (`${base}${index}` in container) index += 1;
  return `${base}${index}`;
}

function fieldInitial(field: RecordField): JsonValue {
  if (field.kind === 'number' || field.kind === 'date') return 0;
  if (field.kind === 'boolean') return false;
  return '';
}

function controlForField(field: RecordField): UiNode | null {
  if (field.kind === 'image') return null;
  if (field.kind === 'number') return { type: 'NumberField', bind: field.key, label: field.label };
  if (field.kind === 'date') return { type: 'DateField', bind: field.key, label: field.label, mode: 'date' };
  if (field.kind === 'boolean') return { type: 'Toggle', bind: field.key, label: field.label };
  return { type: 'TextField', bind: field.key, label: field.label };
}

function collectNodes(root: UiNode, out: UiNode[] = []): UiNode[] {
  out.push(root);
  for (const child of root.children ?? []) collectNodes(child, out);
  return out;
}

function screenNodes(spec: MiniAppSpec): Map<string, UiNode[]> {
  return new Map(Object.entries(spec.screens).map(([id, root]) => [id, collectNodes(root, [])]));
}

function actionSteps(nodes: Iterable<UiNode>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const node of nodes) {
    if (!Array.isArray(node.onPress)) continue;
    for (const raw of node.onPress) if (raw && typeof raw === 'object' && !Array.isArray(raw)) out.push(raw as unknown as Record<string, unknown>);
  }
  return out;
}

function hasAction(nodesByScreen: Map<string, UiNode[]>, action: string): boolean {
  for (const nodes of nodesByScreen.values()) if (actionSteps(nodes).some((step) => step.action === action)) return true;
  return false;
}

function nodesOfType(nodesByScreen: Map<string, UiNode[]>, type: string): { screen: string; node: UiNode }[] {
  const out: { screen: string; node: UiNode }[] = [];
  for (const [screen, nodes] of nodesByScreen) for (const node of nodes) if (node.type === type) out.push({ screen, node });
  return out;
}

function findAction(nodesByScreen: Map<string, UiNode[]>, action: string): { screen: string; node: UiNode; step: Record<string, unknown> } | null {
  for (const [screen, nodes] of nodesByScreen) {
    for (const node of nodes) {
      if (!Array.isArray(node.onPress)) continue;
      for (const raw of node.onPress) {
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as unknown as Record<string, unknown>).action === action) {
          return { screen, node, step: raw as unknown as Record<string, unknown> };
        }
      }
    }
  }
  return null;
}

function ensureChildren(root: UiNode): UiNode[] {
  if (!Array.isArray(root.children)) root.children = [];
  return root.children;
}

function actionRequirement(plan: ContractPlanLike | undefined, action: string): boolean {
  if (!plan) return false;
  return (plan.features ?? []).some((feature) => (feature.requiresActions ?? []).includes(action));
}

function componentRequirement(plan: ContractPlanLike | undefined, component: string): boolean {
  if (!plan) return false;
  return (plan.features ?? []).some((feature) => (feature.requiresComponents ?? []).includes(component))
    || (plan.components ?? []).includes(component);
}

function capabilityRequirement(plan: ContractPlanLike | undefined, capability: string): boolean {
  if (!plan) return false;
  return (plan.capabilities ?? []).includes(capability)
    || (plan.features ?? []).some((feature) => (feature.requiresCapabilities ?? []).includes(capability));
}

function structuredFeature(plan: ContractPlanLike | undefined): ContractFeature | undefined {
  return plan?.features?.find((feature) => feature.requiresStructuredAi)
    ?? plan?.features?.find((feature) => (feature.requiresActions ?? []).includes('llm.ask'));
}

function featurePrompt(feature: ContractFeature | undefined, fallback: string): string {
  if (!feature) return fallback;
  return [feature.title, feature.description, ...(feature.acceptanceCriteria ?? [])]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('. ')
    .slice(0, 1200) || fallback;
}

function pickTargetScreen(spec: MiniAppSpec, nodesByScreen: Map<string, UiNode[]>, purpose: 'ai' | 'records' | 'progress'): string {
  const start = spec.navigation.start in spec.screens ? spec.navigation.start : Object.keys(spec.screens)[0];
  let best = start;
  let bestScore = -1;
  for (const [screen, nodes] of nodesByScreen) {
    let score = screen === start ? 1 : 0;
    const steps = actionSteps(nodes);
    if (purpose === 'ai') {
      if (steps.some((step) => step.action === 'camera.capture' || step.action === 'llm.ask')) score += 10;
      score += nodes.filter((node) => node.type === 'Image').length * 3;
      score += nodes.filter((node) => node.type === 'NumberField' || node.type === 'TextField').length * 2;
      if (/scan|camera|photo|image|analy|add|new/i.test(screen)) score += 3;
    } else if (purpose === 'records') {
      score += nodes.filter((node) => RECORD_VIEWS.has(node.type)).length * 6;
      if (/history|log|list|journal|records/i.test(screen)) score += 4;
    } else {
      score += nodes.filter((node) => AGGREGATE_VIEWS.has(node.type)).length * 6;
      if (/home|summary|dashboard|progress/i.test(screen)) score += 3;
    }
    if (score > bestScore) { best = screen; bestScore = score; }
  }
  return best;
}

function inferFieldFromControl(node: UiNode): RecordField | null {
  const bind = typeof node.bind === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(node.bind) ? node.bind : '';
  if (!bind) return null;
  const label = typeof node.label === 'string' && node.label ? node.label : bind;
  if (node.type === 'NumberField' || node.type === 'Slider' || node.type === 'Stepper') return { key: bind, label, kind: 'number' };
  if (node.type === 'Toggle') return { key: bind, label, kind: 'boolean' };
  if (node.type === 'DateField' || node.type === 'Calendar') return { key: bind, label, kind: 'date' };
  if (node.type === 'TextField' || node.type === 'Select') return { key: bind, label, kind: 'text' };
  return null;
}

function chooseCollection(spec: MiniAppSpec, nodesByScreen: Map<string, UiNode[]>, plan?: ContractPlanLike): string | null {
  for (const nodes of nodesByScreen.values()) {
    for (const step of actionSteps(nodes)) {
      const name = typeof step.collection === 'string' ? step.collection : '';
      if ((step.action === 'records.add' || step.action === 'records.update') && spec.collections?.[name]) return name;
    }
  }
  for (const nodes of nodesByScreen.values()) {
    for (const node of nodes) {
      const name = typeof node.collection === 'string' ? node.collection : '';
      if (name && spec.collections?.[name]) return name;
    }
  }
  const names = Object.keys(spec.collections ?? {});
  if (names.length) return names[0];
  if (!plan?.needsRecords && !(plan?.features ?? []).some((feature) => feature.requiresRecords)) return null;

  const controls = [...nodesByScreen.values()].flat().filter((node) => BINDABLE.has(node.type));
  const fields: RecordField[] = [];
  const seen = new Set<string>();
  for (const node of controls) {
    const field = inferFieldFromControl(node);
    if (!field || seen.has(field.key)) continue;
    if (/^(goal|target|limit|progress|remaining|search|query|filter|selected)/i.test(field.key)) continue;
    seen.add(field.key);
    fields.push(field);
    if (fields.length >= 8) break;
  }
  if (!fields.length) {
    for (const [key, value] of Object.entries(spec.state)) {
      if (seen.has(key) || /^(goal|target|limit|progress|remaining|search|query|filter|selected)/i.test(key)) continue;
      const kind: RecordField['kind'] = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text';
      fields.push({ key, label: key, kind });
      seen.add(key);
      if (fields.length >= 4) break;
    }
  }
  if (!fields.length) fields.push({ key: 'value', label: 'Value', kind: 'text' });
  spec.collections = { ...(spec.collections ?? {}), items: { fields, valueField: fields.find((field) => field.kind === 'number')?.key ?? fields[0].key } };
  return 'items';
}

function ensureStateForCollection(spec: MiniAppSpec, collection: string, applied: Set<string>): void {
  const schema = spec.collections?.[collection];
  if (!schema) return;
  for (const field of schema.fields) {
    if (!(field.key in spec.state)) {
      spec.state[field.key] = fieldInitial(field);
      applied.add(`declared editable state ${field.key}`);
    }
  }
}

function ensureImageField(spec: MiniAppSpec, collection: string, applied: Set<string>): string {
  const schema = spec.collections?.[collection];
  const existing = schema?.fields.find((field) => field.kind === 'image');
  if (existing) return existing.key;
  const photoKey = Object.keys(spec.state).find((key) => /photo|image|picture|img/i.test(key)) ?? uniqueKey(spec.state as Record<string, unknown>, 'photo');
  if (!(photoKey in spec.state)) spec.state[photoKey] = '';
  if (schema && schema.fields.length < 12) {
    schema.fields.unshift({ key: photoKey, label: 'Photo', kind: 'image' });
    applied.add(`added image field ${collection}.${photoKey}`);
  }
  return photoKey;
}

function ensureEditableControls(root: UiNode, spec: MiniAppSpec, collection: string, applied: Set<string>): void {
  const schema = spec.collections?.[collection];
  if (!schema) return;
  const all = collectNodes(root, []);
  const bound = new Set(all.map((node) => typeof node.bind === 'string' ? node.bind : '').filter(Boolean));
  const missing = schema.fields.map(controlForField).filter((node): node is UiNode => node !== null && typeof node.bind === 'string' && !bound.has(node.bind));
  if (!missing.length) return;
  const children = ensureChildren(root);
  const firstRecordView = children.findIndex((node) => RECORD_VIEWS.has(node.type));
  const index = firstRecordView >= 0 ? firstRecordView : children.length;
  children.splice(index, 0, { type: 'Section', children: missing });
  applied.add(`added editable fields for ${collection}`);
}

function recordValues(spec: MiniAppSpec, collection: string): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = {};
  for (const field of spec.collections?.[collection]?.fields ?? []) {
    if (!(field.key in spec.state)) continue;
    values[field.key] = `{{${field.key}}}`;
  }
  return values;
}

function ensurePhotoAiFlow(spec: MiniAppSpec, plan: ContractPlanLike | undefined, collection: string | null, applied: Set<string>): void {
  const needStructured = Boolean(plan?.needsStructuredAi || (plan?.features ?? []).some((feature) => feature.requiresStructuredAi));
  const needLlm = needStructured || capabilityRequirement(plan, 'llm') || actionRequirement(plan, 'llm.ask');
  const needCamera = capabilityRequirement(plan, 'camera') || actionRequirement(plan, 'camera.capture');
  if (!needLlm && !needCamera) return;

  if (needLlm && !spec.capabilities.includes('llm')) { spec.capabilities.push('llm'); applied.add('declared capability llm from plan contract'); }
  if (needCamera && !spec.capabilities.includes('camera')) { spec.capabilities.push('camera'); applied.add('declared capability camera from plan contract'); }

  const nodesByScreen = screenNodes(spec);
  const target = pickTargetScreen(spec, nodesByScreen, 'ai');
  const root = spec.screens[target];
  if (!root) return;
  const w = words(spec.manifest.locale);
  const feature = structuredFeature(plan);

  let photoKey = Object.keys(spec.state).find((key) => /photo|image|picture|img/i.test(key)) ?? '';
  const existingCapture = findAction(nodesByScreen, 'camera.capture');
  if (existingCapture && typeof existingCapture.step.into === 'string') photoKey = existingCapture.step.into;
  if (needCamera) {
    if (!photoKey) photoKey = uniqueKey(spec.state as Record<string, unknown>, 'photo');
    if (!(photoKey in spec.state)) spec.state[photoKey] = '';
    if (collection) photoKey = ensureImageField(spec, collection, applied);
  }

  if (collection) ensureStateForCollection(spec, collection, applied);
  const schema = collection ? spec.collections?.[collection] : undefined;
  let aiFields = (schema?.fields ?? []).filter((field) => field.kind === 'number' || field.kind === 'text').slice(0, 12);
  if (!aiFields.length && needStructured) {
    const fallbackKey = uniqueKey(spec.state as Record<string, unknown>, 'result');
    spec.state[fallbackKey] = '';
    if (schema) schema.fields.push({ key: fallbackKey, label: 'Result', kind: 'text' });
    aiFields = [{ key: fallbackKey, label: 'Result', kind: 'text' }];
    applied.add('added structured AI result field');
  }
  for (const field of aiFields) if (!(field.key in spec.state)) spec.state[field.key] = fieldInitial(field);

  const additions: UiNode[] = [];
  const existingNodes = collectNodes(root, []);

  if (needCamera && photoKey && !existingNodes.some((node) => node.type === 'Image' && node.source === photoKey)) {
    additions.push({ type: 'Image', source: photoKey, ratio: 'square' });
  }

  if (needCamera && !hasAction(nodesByScreen, 'camera.capture')) {
    additions.push({ type: 'Button', title: w.capture, variant: 'secondary', onPress: [{ action: 'camera.capture', into: photoKey, source: 'camera' }] });
    applied.add('added reachable camera.capture flow');
  } else if (existingCapture && photoKey) {
    existingCapture.step.into = photoKey;
  }

  const existingAsk = findAction(nodesByScreen, 'llm.ask');
  if (needLlm && needStructured && aiFields.length) {
    const fields = Object.fromEntries(aiFields.map((field) => [field.key, `${String(field.label)}${field.kind === 'number' ? '; return a number only' : '; short text'}`]));
    const prompt = featurePrompt(feature, 'Analyze the input and fill the requested fields.');
    if (existingAsk) {
      existingAsk.step.prompt = typeof existingAsk.step.prompt === 'string' && existingAsk.step.prompt.trim() ? existingAsk.step.prompt : prompt;
      existingAsk.step.fields = fields;
      delete existingAsk.step.into;
      if (needCamera && photoKey) existingAsk.step.image = photoKey;
      if (existingAsk.node.type === 'Button' && existingAsk.node.disabled === undefined) existingAsk.node.disabled = 'llmBusy';
      applied.add('upgraded llm.ask to structured editable fields');
    } else {
      additions.push({
        type: 'Button', title: w.analyze, variant: 'primary', disabled: 'llmBusy',
        onPress: [{ action: 'llm.ask', prompt, ...(needCamera && photoKey ? { image: photoKey } : {}), fields }],
      });
      additions.push({ type: 'Text', value: '{{llmError}}', variant: 'caption', visible: 'llmError != null' });
      applied.add('added reachable structured llm.ask flow');
    }
  }

  if (collection) {
    ensureEditableControls(root, spec, collection, applied);
    const refreshed = screenNodes(spec);
    if (!hasAction(refreshed, 'records.add')) {
      const values = recordValues(spec, collection);
      if (Object.keys(values).length) {
        additions.push({ type: 'Button', title: w.save, variant: 'primary', onPress: [{ action: 'records.add', collection, values }] });
        applied.add(`added reachable records.add flow for ${collection}`);
      }
    } else {
      const add = findAction(refreshed, 'records.add');
      if (add) {
        add.step.collection = collection;
        const current = add.step.values && typeof add.step.values === 'object' && !Array.isArray(add.step.values)
          ? add.step.values as Record<string, unknown>
          : {};
        add.step.values = { ...recordValues(spec, collection), ...current };
        applied.add(`completed records.add values for ${collection}`);
      }
    }
  }

  if (additions.length) {
    const children = ensureChildren(root);
    const firstRecordView = children.findIndex((node) => RECORD_VIEWS.has(node.type));
    const firstExit = children.findIndex((node) => node.type === 'Button' && Array.isArray(node.onPress) && (node.onPress as unknown as Record<string, unknown>[]).some((step) => step?.action === 'nav.back' || step?.action === 'nav.home'));
    const candidates = [firstRecordView, firstExit].filter((index) => index >= 0);
    const index = candidates.length ? Math.min(...candidates) : children.length;
    children.splice(index, 0, { type: 'Section', title: feature?.title ?? plan?.title ?? undefined, children: additions });
  }
}

function numericValueField(spec: MiniAppSpec, collection: string): string | null {
  const schema = spec.collections?.[collection];
  if (!schema) return null;
  if (schema.valueField && schema.fields.some((field) => field.key === schema.valueField && field.kind === 'number')) return schema.valueField;
  return schema.fields.find((field) => field.kind === 'number')?.key ?? null;
}

function findGoalState(spec: MiniAppSpec): string | null {
  const keys = Object.keys(spec.state);
  const strong = keys.find((key) => /goal|target|limit|norm|budget|max/i.test(key) && typeof spec.state[key] === 'number');
  if (strong) return strong;
  return null;
}

function ensureAggregateFlow(spec: MiniAppSpec, plan: ContractPlanLike | undefined, collection: string | null, applied: Set<string>): void {
  if (!collection) return;
  const nodesByScreen = screenNodes(spec);
  const hasAggregateUi = [...nodesByScreen.values()].flat().some((node) => AGGREGATE_VIEWS.has(node.type));
  const planWantsAggregate = ['Stat', 'ProgressBar', 'ProgressRing'].some((component) => componentRequirement(plan, component));
  if (!hasAggregateUi && !planWantsAggregate) return;

  const valueField = numericValueField(spec, collection);
  if (!valueField) return;
  spec.derived = { ...(spec.derived ?? {}) };
  const totalExpression = `sumBy(records, "${collection}", "${valueField}")`;
  const existingTotal = Object.entries(spec.derived).find(([, expression]) => expression === totalExpression)?.[0];
  const totalKey = existingTotal ?? uniqueKey({ ...spec.state, ...spec.derived }, `autoTotal_${collection}`);
  if (!existingTotal) {
    spec.derived[totalKey] = totalExpression;
    applied.add(`wired live aggregate ${totalKey}`);
  }

  const target = pickTargetScreen(spec, nodesByScreen, 'progress');
  const root = spec.screens[target];
  if (!root) return;
  const w = words(spec.manifest.locale);
  const currentNodes = collectNodes(root, []);
  const totalTemplate = `{{${totalKey} | number}}`;
  let stat = currentNodes.find((node) => node.type === 'Stat' && typeof node.value === 'string' && node.value.includes(totalKey));
  if (!stat) stat = currentNodes.find((node) => node.type === 'Stat' && !(typeof node.value === 'string' && /autoRemaining_/.test(node.value)));
  if (stat) {
    if (stat.value !== totalTemplate) { stat.value = totalTemplate; applied.add('bound Stat to record aggregate'); }
    if (stat.label === undefined) stat.label = w.total;
  } else if (componentRequirement(plan, 'Stat')) {
    ensureChildren(root).unshift({ type: 'Stat', label: w.total, value: totalTemplate });
    applied.add('added aggregate Stat');
  }

  let goalKey = findGoalState(spec);
  const progressNodes = collectNodes(root, []).filter((node) => node.type === 'ProgressBar' || node.type === 'ProgressRing');
  if (progressNodes.length || componentRequirement(plan, 'ProgressBar') || componentRequirement(plan, 'ProgressRing')) {
    if (!goalKey) {
      goalKey = uniqueKey({ ...spec.state, ...spec.derived }, 'autoGoal');
      spec.state[goalKey] = 100;
      const children = ensureChildren(root);
      const hasGoalControl = collectNodes(root, []).some((node) => node.type === 'NumberField' && node.bind === goalKey);
      if (!hasGoalControl) children.unshift({ type: 'NumberField', bind: goalKey, label: w.goal, min: 1 });
      applied.add('added editable progress goal');
    }
    const progressExpression = `clamp(${totalKey} / max(1, ${goalKey}), 0, 1)`;
    const existingProgress = Object.entries(spec.derived).find(([, expression]) => expression === progressExpression)?.[0];
    const progressKey = existingProgress ?? uniqueKey({ ...spec.state, ...spec.derived }, `autoProgress_${collection}`);
    if (!existingProgress) spec.derived[progressKey] = progressExpression;
    for (const node of progressNodes) {
      node.progress = progressKey;
      if (node.value === undefined && node.type === 'ProgressRing') node.value = `{{${totalKey} | number}}`;
    }
    if (!progressNodes.length) {
      ensureChildren(root).unshift({ type: componentRequirement(plan, 'ProgressRing') ? 'ProgressRing' : 'ProgressBar', progress: progressKey, ...(componentRequirement(plan, 'ProgressRing') ? { value: `{{${totalKey} | number}}` } : { value: `{{${totalKey} | number}}` }), label: w.total });
    }
    const remainingExpression = `max(0, ${goalKey} - ${totalKey})`;
    const existingRemaining = Object.entries(spec.derived).find(([, expression]) => expression === remainingExpression)?.[0];
    const remainingKey = existingRemaining ?? uniqueKey({ ...spec.state, ...spec.derived }, `autoRemaining_${collection}`);
    if (!existingRemaining) spec.derived[remainingKey] = remainingExpression;
    if (!collectNodes(root, []).some((node) => node.type === 'Stat' && typeof node.value === 'string' && node.value.includes(remainingKey))) {
      ensureChildren(root).unshift({ type: 'Stat', label: w.remaining, value: `{{${remainingKey} | number}}` });
      applied.add('added remaining metric');
    }
    if (progressNodes.some((node) => node.progress !== progressKey)) applied.add('bound progress to live record aggregate');
  }
}

function ensureHistoryFlow(spec: MiniAppSpec, plan: ContractPlanLike | undefined, collection: string | null, applied: Set<string>): void {
  if (!collection) return;
  const needsRecords = Boolean(plan?.needsRecords || (plan?.features ?? []).some((feature) => feature.requiresRecords));
  if (!needsRecords) return;
  const nodesByScreen = screenNodes(spec);
  const target = pickTargetScreen(spec, nodesByScreen, 'records');
  const root = spec.screens[target];
  if (!root) return;
  const schema = spec.collections?.[collection];
  if (!schema) return;
  const w = words(spec.manifest.locale);
  const valueKey = schema.valueField ?? schema.fields.find((field) => field.kind !== 'image')?.key ?? schema.fields[0]?.key;
  const imageKey = schema.fields.find((field) => field.kind === 'image')?.key;

  const allNodes = collectNodes(root, []);
  const recordViews = allNodes.filter((node) => RECORD_VIEWS.has(node.type));
  for (const node of recordViews) {
    if (node.type === 'Repeat') {
      if (node.source === undefined || node.source === '' || node.source === 'items' || node.source === 'data') node.source = 'records';
      if (node.source === 'records') node.collection = collection;
      if (node.as === undefined) node.as = 'item';
      if (node.empty === undefined) node.empty = '—';
      if (!collectNodes(node, []).some((child) => Array.isArray(child.onPress) && (child.onPress as unknown as Record<string, unknown>[]).some((step) => step?.action === 'records.remove'))) {
        const repeatAlias = typeof node.as === 'string' && node.as ? node.as.replace(/[^A-Za-z0-9_]/g, '') : 'item';
        ensureChildren(node).push({ type: 'Button', title: '×', variant: 'secondary', onPress: [{ action: 'records.remove', id: `{{${repeatAlias}Id}}` }] });
      }
      applied.add(`bound Repeat to ${collection}`);
    } else if (node.type === 'List' || node.type === 'Table' || node.type === 'Gallery' || node.type === 'PieChart') {
      node.collection = collection;
      if (node.type === 'List') {
        if (valueKey && node.valueKey === undefined) node.valueKey = valueKey;
        if (imageKey && node.imageKey === undefined) node.imageKey = imageKey;
      }
      applied.add(`bound ${node.type} to ${collection}`);
    }
  }

  const needsHistoryPrimitive = componentRequirement(plan, 'List') || componentRequirement(plan, 'Repeat') || componentRequirement(plan, 'Table');
  const hasBoundHistory = collectNodes(root, []).some((node) => {
    if (node.type === 'Repeat') return node.source === 'records' && node.collection === collection;
    return (node.type === 'List' || node.type === 'Table') && node.collection === collection;
  });
  if (!hasBoundHistory && (needsHistoryPrimitive || actionRequirement(plan, 'records.remove'))) {
    ensureChildren(root).push({ type: 'Section', title: w.history, children: [{ type: 'List', collection, ...(valueKey ? { valueKey } : {}), ...(imageKey ? { imageKey } : {}), empty: '—' }] });
    applied.add(`added reliable List history for ${collection}`);
  }
}

function ensureRequiredCapabilities(spec: MiniAppSpec, plan: ContractPlanLike | undefined, applied: Set<string>): void {
  if (!plan) return;
  const needed = new Set<string>(plan.capabilities ?? []);
  for (const feature of plan.features ?? []) for (const capability of feature.requiresCapabilities ?? []) needed.add(capability);
  for (const capability of needed) {
    if (!['clipboard','haptics','share','notifications','camera','scanner','sensors','location','files','network','llm','image','sandbox'].includes(capability)) continue;
    if (!spec.capabilities.includes(capability as never)) {
      spec.capabilities.push(capability as never);
      applied.add(`declared plan capability ${capability}`);
    }
  }
}

/**
 * Deterministic Product-Plan contract compiler.
 *
 * Gemini remains responsible for IA/UX and domain choices. This pass only wires
 * runtime semantics that are already implied by the reviewed Product Plan and by
 * the generated state/collection schema. It deliberately avoids domain-specific
 * hardcoding: the same rules work for food, expenses, workouts, inventory, etc.
 */
export function compileFeatureContracts(input: MiniAppSpec, plan?: ContractPlanLike): ContractCompileResult {
  const spec = cloneSpec(input);
  const applied = new Set<string>();
  if (!plan) return { spec, applied: [] };

  ensureRequiredCapabilities(spec, plan, applied);
  let nodesByScreen = screenNodes(spec);
  const collection = chooseCollection(spec, nodesByScreen, plan);
  if (collection) ensureStateForCollection(spec, collection, applied);

  // Structured AI is a transactional flow, not a decorative capability:
  // capture/input -> structured model fields -> editable state -> explicit save.
  ensurePhotoAiFlow(spec, plan, collection, applied);

  // The previous pass may have inserted controls/actions; rebuild the view before
  // wiring history and live aggregates around the same named collection.
  nodesByScreen = screenNodes(spec);
  void nodesByScreen;
  ensureAggregateFlow(spec, plan, collection, applied);
  ensureHistoryFlow(spec, plan, collection, applied);

  return { spec, applied: [...applied] };
}
