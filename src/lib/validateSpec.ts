import { z } from 'zod';
import { ACCENT_COLORS, ACTION_NAMES, ACTIONS, BUILTIN_SCOPE, CAPABILITIES, COMPONENTS, COMPONENT_TYPES, FILTER_NAMES } from './dsl';
import { ExpressionEvaluator, ExpressionError } from './expression';
import { getCollectionSchema, getScreenRoots, type CustomComponentSpec, type MiniAppSpec, type UiNode } from './specTypes';

const jsonValue: z.ZodType = z.lazy(() => z.union([z.string(),z.number(),z.boolean(),z.null(),z.array(jsonValue),z.record(z.string(),jsonValue)]));
const uiNode: z.ZodType = z.lazy(() => z.object({type:z.string().min(1)}).passthrough());
const recordSchema=z.object({fields:z.array(z.object({key:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),label:z.string(),kind:z.enum(['number','text','date','image','boolean'])})).min(1).max(24),valueField:z.string().optional()});
const customProp=z.object({name:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),kind:z.enum(['value','text','bind']),required:z.boolean().optional(),default:jsonValue.optional()});
const customComponent=z.object({description:z.string().max(300).optional(),props:z.array(customProp).max(24).optional(),template:uiNode});
const specSchema=z.object({
 schemaVersion:z.union([z.literal(1),z.literal(2)]),id:z.string().min(1).max(64),version:z.number().int().positive(),
 manifest:z.object({name:z.string().min(1).max(40),icon:z.string().min(1),color:z.enum(ACCENT_COLORS),locale:z.string().min(2)}),
 capabilities:z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length),state:z.record(z.string(),jsonValue),persist:z.array(z.string()).optional(),derived:z.record(z.string(),z.string()).optional(),
 records:recordSchema.optional(),collections:z.record(z.string(),recordSchema).optional(),ui:uiNode.optional(),screens:z.record(z.string(),uiNode).optional(),
 navigation:z.object({start:z.string(),mode:z.enum(['single','stack','tabs']),titles:z.record(z.string(),z.string()).optional(),tabs:z.array(z.object({screen:z.string(),label:z.string(),icon:z.string().optional()})).max(4).optional()}).optional(),
 components:z.record(z.string(),customComponent).optional(),design:z.object({density:z.enum(['compact','comfortable']).optional(),cardStyle:z.enum(['soft','outlined','flat']).optional(),radius:z.enum(['soft','round']).optional()}).optional(),
 featureEvidence:z.record(z.string(),z.object({screens:z.array(z.string()).optional(),components:z.array(z.string()).optional(),actions:z.array(z.string()).optional(),capabilities:z.array(z.enum(CAPABILITIES)).optional()})).optional(),
});
const componentByType=new Map(COMPONENTS.map(c=>[c.type,c]));
const actionByName=new Map(ACTIONS.map(a=>[a.name,a]));
const REQUIRED_ACTION_PARAMS:Record<string,string[]>={
 'state.set':['key','value'],'state.inc':['key'],'state.toggle':['key'],'state.random':['key'],
 'records.add':['values'],'records.update':['id','values'],'records.remove':['id'],'timer.start':['seconds'],'nav.go':['screen'],
 'clipboard.set':['value'],'share':['value'],'toast':['text'],'notify.schedule':['title','body','afterSeconds'],'notify.at':['title','at'],
 'camera.capture':['into'],'image.generate':['prompt','into'],'llm.ask':['prompt'],
};
export type SpecValidation={ok:true;spec:MiniAppSpec}|{ok:false;errors:string[]};
type Step=Record<string,unknown>;

export function validateSpec(input:unknown):SpecValidation{
 const parsed=specSchema.safeParse(input);if(!parsed.success)return{ok:false,errors:parsed.error.issues.map(i=>`${i.path.join('.')||'spec'}: ${i.message}`)};
 const spec=parsed.data as unknown as MiniAppSpec;const errors:string[]=[];const evaluator=new ExpressionEvaluator();const roots=getScreenRoots(spec);
 const ident=/^[A-Za-z_][A-Za-z0-9_]*$/;const reserved=new Set(BUILTIN_SCOPE);
 for(const key of Object.keys(spec.state)){if(!ident.test(key))errors.push(`state.${key}: key must be a valid expression identifier`);if(reserved.has(key))errors.push(`state.${key}: key conflicts with runtime built-in`);}
 for(const key of Object.keys(spec.derived??{})){if(!ident.test(key))errors.push(`derived.${key}: key must be a valid expression identifier`);if(key in spec.state)errors.push(`derived.${key}: conflicts with state key`);if(reserved.has(key))errors.push(`derived.${key}: conflicts with runtime built-in`);}
 if(new Set(spec.capabilities).size!==spec.capabilities.length)errors.push('capabilities: duplicates are not allowed');
 if(!Object.keys(roots).length)errors.push('spec: no ui/screens root is defined');if(Object.keys(roots).length>4)errors.push('screens: maximum 4 generated screens');for(const[name,root]of Object.entries(roots)){if(!/^[a-z][A-Za-z0-9_-]{0,39}$/.test(name))errors.push(`screens.${name}: invalid screen id`);if(spec.schemaVersion===2&&root.type!=='Screen')errors.push(`screens.${name}: v2 screen root must be Screen`);}
 if(spec.schemaVersion===2&&!spec.screens)errors.push('schemaVersion 2: use top-level screens (legacy ui is only for v1 compatibility)');
 if(spec.schemaVersion===2&&spec.ui)errors.push('schemaVersion 2: omit legacy top-level ui');
 if(Object.keys(spec.state).length>80)errors.push('state: maximum 80 keys');if(Object.keys(spec.derived??{}).length>80)errors.push('derived: maximum 80 expressions');if((spec.persist??[]).length>80)errors.push('persist: maximum 80 keys');
 if(!checkComplexity(spec,errors))return{ok:false,errors};
 for(const [key,expression]of Object.entries(spec.derived??{})){try{evaluator.compile(expression);}catch(error){errors.push(`derived.${key}: ${error instanceof ExpressionError?error.message:String(error)}`);}}
 for(const key of spec.persist??[])if(!(key in spec.state))errors.push(`persist: field "${key}" is not in state`);
 checkRecordSchemas(spec,errors);checkNavigation(spec,roots,errors);checkCustomDefinitions(spec,errors,evaluator);
 for(const [name,root]of Object.entries(roots))checkNode(root,spec,errors,evaluator,`screens.${name}`,new Set(),[]);
 if(spec.schemaVersion===2)checkUxV2(spec,errors);checkWiring(spec,errors);if(errors.length>60)errors.length=60;return errors.length?{ok:false,errors}:{ok:true,spec};
}
function checkComplexity(spec:MiniAppSpec,errors:string[]):boolean{
 const roots=[...Object.entries(getScreenRoots(spec)).map(([name,node])=>({node,path:`screens.${name}`,depth:1})),...Object.entries(spec.components??{}).map(([name,def])=>({node:def.template,path:`components.${name}.template`,depth:1}))];
 const stack=[...roots];let nodes=0,actions=0,maxDepth=0;
 while(stack.length){const current=stack.pop()!;nodes++;maxDepth=Math.max(maxDepth,current.depth);if(Array.isArray(current.node.onPress))actions+=current.node.onPress.length;if(Array.isArray(current.node.children)){if(current.node.children.length>40)errors.push(`${current.path}: maximum 40 direct children`);for(let i=0;i<current.node.children.length;i++)stack.push({node:current.node.children[i],path:`${current.path}.children[${i}]`,depth:current.depth+1});}if(nodes>240||actions>160||maxDepth>24)break;}
 if(nodes>240)errors.push('ui: maximum 240 declared nodes');if(actions>160)errors.push('ui: maximum 160 declared action steps');if(maxDepth>24)errors.push('ui: maximum nesting depth is 24');
 return nodes<=240&&actions<=160&&maxDepth<=24;
}
function checkRecordSchemas(spec:MiniAppSpec,errors:string[]):void{
 const schemas={...(spec.records?{default:spec.records}:{}),...(spec.collections??{})};if(Object.keys(schemas).length>12)errors.push('collections: maximum 12 collections');
    if(spec.collections?.default)errors.push('collections.default is reserved; use top-level records for the default collection');
 for(const [name,schema]of Object.entries(schemas)){if(name!=='default'&&!/^[a-z][A-Za-z0-9_-]{0,39}$/.test(name))errors.push(`collection ${name}: invalid collection id`);const keys=new Set<string>();for(const field of schema.fields){if(keys.has(field.key))errors.push(`collection ${name}: duplicate field "${field.key}"`);keys.add(field.key);}if(schema.valueField&&!keys.has(schema.valueField))errors.push(`collection ${name}: valueField "${schema.valueField}" is not a field`);}
}
function checkNavigation(spec:MiniAppSpec,roots:Record<string,UiNode>,errors:string[]):void{
 const nav=spec.navigation;if(!nav){if(Object.keys(roots).length>1)errors.push('navigation: required when more than one screen exists');return;}if(!roots[nav.start])errors.push(`navigation.start: screen "${nav.start}" does not exist`);if(nav.mode==='single'&&Object.keys(roots).length!==1)errors.push('navigation: single mode requires exactly one screen');
 for(const key of Object.keys(nav.titles??{}))if(!roots[key])errors.push(`navigation.titles: screen "${key}" does not exist`);
 if(nav.mode==='tabs'){if(!nav.tabs||nav.tabs.length<2)errors.push('navigation.tabs: tabs mode requires 2-4 tabs');if(nav.tabs&& !nav.tabs.some(tab=>tab.screen===nav.start))errors.push('navigation.tabs: start screen must be one of the tabs');const seen=new Set<string>();for(const tab of nav.tabs??[]){if(!roots[tab.screen])errors.push(`navigation.tabs: screen "${tab.screen}" does not exist`);if(seen.has(tab.screen))errors.push(`navigation.tabs: duplicate screen "${tab.screen}"`);seen.add(tab.screen);}}
}
function checkCustomDefinitions(spec:MiniAppSpec,errors:string[],evaluator:ExpressionEvaluator):void{
 const custom=spec.components??{};if(Object.keys(custom).length>16)errors.push('components: maximum 16 app-specific composite components');
 for(const [name,definition]of Object.entries(custom)){if(!/^[A-Z][A-Za-z0-9]{1,39}$/.test(name))errors.push(`components.${name}: name must be PascalCase`);if(COMPONENT_TYPES.includes(name))errors.push(`components.${name}: conflicts with a core component`);const seen=new Set<string>();for(const prop of definition.props??[]){if(seen.has(prop.name))errors.push(`components.${name}: duplicate prop "${prop.name}"`);seen.add(prop.name);}checkCustomCycle(name,definition,custom,[name],errors);checkNode(definition.template,spec,errors,evaluator,`components.${name}.template`,new Set((definition.props??[]).map(p=>p.name)),[name]);}
}
function checkCustomCycle(owner:string,definition:CustomComponentSpec,all:Record<string,CustomComponentSpec>,stack:string[],errors:string[]):void{
 const visit=(node:UiNode):void=>{if(all[node.type]){if(stack.includes(node.type)){errors.push(`components.${owner}: recursive cycle ${[...stack,node.type].join(' -> ')}`);return;}checkCustomCycle(owner,all[node.type],all,[...stack,node.type],errors);}if(Array.isArray(node.children))node.children.forEach(visit);};visit(definition.template);
}
function checkNode(node:UiNode,spec:MiniAppSpec,errors:string[],evaluator:ExpressionEvaluator,path:string,localProps:Set<string>,customStack:string[]):void{
 const def=componentByType.get(node.type);const custom=spec.components?.[node.type];if(!def&&!custom){errors.push(`${path}: component "${node.type}" does not exist`);return;}
 if(def){for(const prop of def.required??[])if(node[prop]===undefined)errors.push(`${path} (${node.type}): required property "${prop}" is missing`);checkCorePropTypes(node,errors,path);if(def.binds)checkBind(node,spec,errors,path,localProps);}if(custom)checkCustomUsage(node,custom,spec,errors,path);
 if(Array.isArray(node.onPress))node.onPress.forEach((step,index)=>checkStep(step as unknown as Step,spec,errors,evaluator,`${path}.onPress[${index}]`,localProps));else if(node.onPress!==undefined)errors.push(`${path}: onPress must be an array`);
 checkNodeExpressionsAndTemplates(node,evaluator,errors,path);
 if(node.type==='Select'&&Array.isArray(node.options)&&typeof node.bind==='string'&&!node.bind.includes('{{')){const values=(node.options as {value?:unknown}[]).map(x=>x?.value);if(!values.includes(spec.state[node.bind]))errors.push(`${path} (Select): initial state.${node.bind} matches none of options.value`);}
 if(node.type==='Repeat'&&typeof node.source!=='string')errors.push(`${path} (Repeat): source expression is required`);
 if(Array.isArray(node.children))node.children.forEach((child,index)=>checkNode(child,spec,errors,evaluator,`${path}.children[${index}]`,localProps,customStack));
}
function checkCorePropTypes(node:UiNode,errors:string[],path:string):void{
 const stringProps:Record<string,string[]>={Text:['value'],Stat:['label','value'],ProgressRing:['progress','value'],ProgressBar:['progress'],Badge:['value'],EmptyState:['title'],Chart:['values'],Image:['source'],Button:['title'],Sandbox:['html'],LineChart:['values'],PieChart:['groupBy'],Repeat:['source']};
 for(const key of stringProps[node.type]??[])if(node[key]!==undefined&&typeof node[key]!=='string')errors.push(`${path} (${node.type}): property "${key}" must be a string`);
 if(node.type==='Row'&&node.align!==undefined&&typeof node.align!=='string')errors.push(`${path} (Row): property "align" must be a string`);
 if(node.type==='MetricGrid'&&node.items!==undefined){if(!Array.isArray(node.items))errors.push(`${path} (MetricGrid): items must be an array`);else if(node.items.some(item=>!item||typeof item!=='object'||Array.isArray(item)))errors.push(`${path} (MetricGrid): every item must be an object`);}
 if(node.type==='Select'&&node.options!==undefined){if(!Array.isArray(node.options))errors.push(`${path} (Select): options must be an array`);else for(const [i,item]of node.options.entries()){if(!item||typeof item!=='object'||Array.isArray(item)||typeof (item as Record<string,unknown>).value!=='string'||typeof (item as Record<string,unknown>).label!=='string')errors.push(`${path}.options[${i}] (Select): option requires string value and label`);}}
 if(node.type==='Table'&&node.columns!==undefined){if(!Array.isArray(node.columns))errors.push(`${path} (Table): columns must be an array`);else for(const [i,item]of node.columns.entries()){if(!item||typeof item!=='object'||Array.isArray(item)||typeof (item as Record<string,unknown>).key!=='string'||typeof (item as Record<string,unknown>).label!=='string')errors.push(`${path}.columns[${i}] (Table): column requires string key and label`);}}
}
function checkUxV2(spec:MiniAppSpec,errors:string[]):void{
 const roots=getScreenRoots(spec);const staticTargets=new Set<string>([spec.navigation?.start??Object.keys(roots)[0]??'']);let hasDynamicNav=false;for(const tab of spec.navigation?.tabs??[])staticTargets.add(tab.screen);
 const visit=(node:UiNode,path:string,customStack:string[]=[]):void=>{
  if(node.type==='Button'&&typeof node.title==='string'&&!node.title.includes('{{')&&node.title.length>60)errors.push(`${path} (Button): title is too long for a mobile action; keep it under 60 characters`);
  if(node.type==='Row'&&Array.isArray(node.children)&&node.children.length>3&&node.wrap!==true)errors.push(`${path} (Row): more than 3 children requires wrap=true or a vertical/Grid layout on phones`);
  if(node.type==='Select'&&Array.isArray(node.options)){if(node.options.length<2)errors.push(`${path} (Select): provide at least 2 options`);if(node.options.length>12)errors.push(`${path} (Select): more than 12 inline options is unwieldy; simplify the choice or split the flow`);const seen=new Set<string>();for(const raw of node.options){const item=raw as Record<string,unknown>;if(typeof item.value==='string'){if(seen.has(item.value))errors.push(`${path} (Select): duplicate option value "${item.value}"`);seen.add(item.value);}if(typeof item.label==='string'&&item.label.length>40)errors.push(`${path} (Select): option label "${item.label.slice(0,24)}…" is too long for the adaptive selector`);}}
  if(node.type==='Table'&&Array.isArray(node.columns)&&node.columns.length>3)errors.push(`${path} (Table): more than 3 columns is not phone-safe; use cards/Repeat or a drill-down screen`);
  if(node.type==='Repeat'&&node.source==='records'&&node.empty===undefined)errors.push(`${path} (Repeat): record-driven content needs an explicit empty state`);
  if(['NumberField','TextField','Slider','Stepper','Toggle','Select','DateField'].includes(node.type)&&node.label===undefined)errors.push(`${path} (${node.type}): interactive control needs a label for usability/accessibility`);
  if(Array.isArray(node.onPress))for(const raw of node.onPress as unknown as Step[])if(raw.action==='nav.go'&&typeof raw.screen==='string'){if(raw.screen.includes('{{'))hasDynamicNav=true;else staticTargets.add(raw.screen);}
  if(Array.isArray(node.children))node.children.forEach((child,index)=>visit(child,`${path}.children[${index}]`,customStack));
  const custom=spec.components?.[node.type];if(custom&&!customStack.includes(node.type))visit(custom.template,`${path}<${node.type}>`,[...customStack,node.type]);
 };
 for(const[name,root]of Object.entries(roots)){if(!Array.isArray(root.children)||root.children.length===0)errors.push(`screens.${name}: screen is empty`);else if(root.children.length>12)errors.push(`screens.${name}: too many top-level blocks; group related content into Section/Card or split the flow`);visit(root,`screens.${name}`);}
 if(!hasDynamicNav)for(const name of Object.keys(roots))if(!staticTargets.has(name)&&name!==(spec.navigation?.start??''))errors.push(`navigation: screen "${name}" has no static entry point (tab or nav.go)`);
}
function checkBind(node:UiNode,spec:MiniAppSpec,errors:string[],path:string,localProps:Set<string>):void{
 if(typeof node.bind!=='string'){errors.push(`${path} (${node.type}): bind is required`);return;}const dynamic=node.bind.match(/^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/)?.[1];if(dynamic){if(!localProps.has(dynamic))errors.push(`${path}: dynamic bind uses unknown local prop "${dynamic}"`);}else if(!(node.bind in spec.state))errors.push(`${path}: bind="${node.bind}" is not declared in state`);
}
function checkCustomUsage(node:UiNode,definition:CustomComponentSpec,spec:MiniAppSpec,errors:string[],path:string):void{
 const props=node.props&&typeof node.props==='object'&&!Array.isArray(node.props)?node.props as Record<string,unknown>:{};const allowed=new Set((definition.props??[]).map(p=>p.name));
 for(const prop of definition.props??[]){const value=props[prop.name];if(prop.required&&value===undefined&&prop.default===undefined)errors.push(`${path}: required prop "${prop.name}" is missing`);if(prop.kind==='bind'&&value!==undefined){if(typeof value!=='string')errors.push(`${path}: bind prop "${prop.name}" must be a state key string`);else if(!value.includes('{{')&&!(value in spec.state))errors.push(`${path}: bind prop "${prop.name}" refers to unknown state key "${value}"`);}}
 for(const key of Object.keys(props))if(!allowed.has(key))errors.push(`${path}: unknown prop "${key}" for ${node.type}`);
}
function checkStep(step:Step,spec:MiniAppSpec,errors:string[],evaluator:ExpressionEvaluator,path:string,localProps:Set<string>):void{
 const name=typeof step.action==='string'?step.action:'';if(!name){errors.push(`${path}: step has no action field`);return;}const def=actionByName.get(name);if(!def){errors.push(`${path}: action "${name}" does not exist. Available: ${ACTION_NAMES.join(', ')}`);return;}if(def.requires&&!spec.capabilities.includes(def.requires))errors.push(`${path}: action "${name}" requires capability "${def.requires}"`);for(const param of REQUIRED_ACTION_PARAMS[name]??[])if(step[param]===undefined)errors.push(`${path} (${name}): required parameter "${param}" is missing`);
 if(typeof step.when==='string')try{evaluator.compile(step.when);}catch(error){errors.push(`${path}.when: ${String(error)}`);}
 for(const [key,raw]of Object.entries(step)){if(key==='action'||key==='when'||typeof raw!=='string'||!raw.includes('{{'))continue;checkTemplateString(raw,evaluator,errors,`${path}.${key}`);}
 if(name.startsWith('state.')&&name!=='state.reset'&&typeof step.key==='string'){const dynamic=step.key.match(/^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/)?.[1];if(!dynamic&&!(step.key in spec.state))errors.push(`${path}: state key "${step.key}" does not exist`);if(dynamic&&!localProps.has(dynamic))errors.push(`${path}: dynamic state key uses unknown local prop "${dynamic}"`);}
 if(name==='nav.go'&&typeof step.screen==='string'&&!step.screen.includes('{{')&&!getScreenRoots(spec)[step.screen])errors.push(`${path}: nav.go target "${step.screen}" does not exist`);
 const collection=typeof step.collection==='string'&&!step.collection.includes('{{')?step.collection:'default';if(name.startsWith('records.')&&name!=='records.remove'&&!getCollectionSchema(spec,collection))errors.push(`${path}: records action targets undeclared collection "${collection}"`);
 if((name==='records.add'||name==='records.update')&&step.values&&typeof step.values==='object'){const schema=getCollectionSchema(spec,collection);if(schema){const fields=new Set(schema.fields.map(x=>x.key));for(const [key,raw]of Object.entries(step.values as Record<string,unknown>)){if(!fields.has(key))errors.push(`${path}: record field "${key}" is not declared in collection "${collection}"`);if(typeof raw==='string'&&raw.includes('{{'))checkTemplateString(raw,evaluator,errors,`${path}.values.${key}`);}}}
}
const PLACEHOLDER=/\{\{([^}]+)\}\}/g;
function checkTemplateString(raw:string,evaluator:ExpressionEvaluator,errors:string[],path:string):void{
 for(const match of raw.matchAll(PLACEHOLDER)){const body=match[1];const filtered=body.match(/^(.*[^|])\|\s*([A-Za-z]+)\s*$/);if(filtered&&!FILTER_NAMES.includes(filtered[2]))errors.push(`${path}: unknown template filter "${filtered[2]}"`);const expression=(filtered?filtered[1]:body).trim();try{evaluator.compile(expression);}catch(error){errors.push(`${path}: ${error instanceof ExpressionError?error.message:String(error)}`);}}
}
function checkNodeExpressionsAndTemplates(node:UiNode,evaluator:ExpressionEvaluator,errors:string[],path:string):void{
 const exprProps=new Set(['visible','disabled','progress','values']);for(const [key,raw]of Object.entries(node)){if(typeof raw!=='string')continue;if(exprProps.has(key)||(key==='source'&&node.type==='Repeat'))try{evaluator.compile(raw);}catch(error){errors.push(`${path}.${key}: ${String(error)}`);}if(raw.includes('{{'))checkTemplateString(raw,evaluator,errors,`${path}.${key}`);}
}
function collectUsed(spec:MiniAppSpec):{steps:Step[];nodes:UiNode[];serialized:string}{
 const steps:Step[]=[];const nodes:UiNode[]=[];const seenCustom=new Set<string>();const visit=(node:UiNode):void=>{nodes.push(node);if(Array.isArray(node.onPress))for(const raw of node.onPress)if(raw&&typeof raw==='object')steps.push(raw as Step);const custom=spec.components?.[node.type];if(custom&&!seenCustom.has(node.type)){seenCustom.add(node.type);visit(custom.template);}if(Array.isArray(node.children))node.children.forEach(visit);};Object.values(getScreenRoots(spec)).forEach(visit);return{steps,nodes,serialized:JSON.stringify({screens:getScreenRoots(spec),components:[...seenCustom].map(n=>spec.components?.[n])})};
}
function checkWiring(spec:MiniAppSpec,errors:string[]):void{
 const {steps,nodes,serialized}=collectUsed(spec);const named=(name:string)=>steps.filter(s=>s.action===name);const usesPrefix=(prefix:string)=>steps.some(s=>String(s.action??'').startsWith(prefix));
 if(usesPrefix('records.')&&!spec.records&&!Object.keys(spec.collections??{}).length)errors.push('records: record actions are used but no records/collections schema exists');
 for(const step of named('timer.start'))if(step.seconds===undefined)errors.push('timer.start: seconds is missing');if(usesPrefix('timer.')&&!/timerRemaining|timerElapsed|timerRunning|timerFinished/.test(serialized))errors.push('timer: timer actions are used but no UI shows timer state');
 if(/\brandom\s*\(/.test(serialized+JSON.stringify(spec.derived??{})))errors.push('expressions: random() does not exist; use state.random or Sandbox for game randomness');checkAiWiring(spec,steps,serialized,errors);checkSandbox(spec,nodes,errors);
}
function checkSandbox(spec:MiniAppSpec,nodes:UiNode[],errors:string[]):void{
 const sandboxes=nodes.filter(n=>n.type==='Sandbox'&&typeof n.html==='string').map(n=>String(n.html));const boardCells=new Set<string>();for(const node of nodes){if(node.type==='Button'&&Array.isArray(node.onPress)&&node.onPress.length===1){const step=node.onPress[0] as unknown as Step;if(step.action==='state.set'&&typeof step.key==='string')boardCells.add(step.key);}}
 if(boardCells.size>=6&&!sandboxes.length)errors.push('game-like button grid detected; use one Sandbox for game logic/animation instead');if(sandboxes.length&&!spec.capabilities.includes('sandbox'))errors.push('Sandbox: capability "sandbox" is missing');
 for(const html of sandboxes){if(/<script[^>]+src=/i.test(html))errors.push('Sandbox: external scripts are forbidden; inline all code');if(/\b(fetch|XMLHttpRequest|WebSocket|importScripts)\s*\(/.test(html))errors.push('Sandbox: network calls are forbidden/unavailable');if(/https?:\/\//.test(html.replace(/https?:\/\/www\.w3\.org[^"']*/g,'')))errors.push('Sandbox: external links/assets do not load');if(html.length>60000)errors.push('Sandbox: html exceeds 60000 characters');if(!/onclick|addEventListener|touchstart|pointerdown/i.test(html))errors.push('Sandbox: no touch/pointer input handler found');const bridges:[RegExp,typeof CAPABILITIES[number],string][]=[[/toolkin\.ask\s*\(/,'llm','toolkin.ask'],[/toolkin\.capture\s*\(/,'camera','toolkin.capture'],[/toolkin\.image\s*\(/,'image','toolkin.image'],[/toolkin\.notify\s*\(/,'notifications','toolkin.notify']];for(const [pattern,capability,bridge]of bridges)if(pattern.test(html)&&!spec.capabilities.includes(capability))errors.push(`Sandbox: ${bridge} requires capability "${capability}"`);}
}
function checkAiWiring(spec:MiniAppSpec,steps:Step[],serialized:string,errors:string[]):void{
 const asks=steps.filter(s=>s.action==='llm.ask'),captures=steps.filter(s=>s.action==='camera.capture'),images=steps.filter(s=>s.action==='image.generate');
 for(const step of images){const into=typeof step.into==='string'?step.into:'';if(!into)errors.push('image.generate: into is missing');else if(!(into in spec.state))errors.push(`image.generate: into="${into}" is not declared in state`);else if(!serialized.includes(`"source":"${into}"`)&&!serialized.includes(`"source": "${into}"`))errors.push(`image.generate: result "${into}" is never displayed by Image`);}
 for(const step of asks){const fields=step.fields&&typeof step.fields==='object'?step.fields as Record<string,unknown>:null;if(fields){if(!Object.keys(fields).length)errors.push('llm.ask: fields is empty');for(const key of Object.keys(fields))if(!(key in spec.state))errors.push(`llm.ask: fields."${key}" is not declared in state`);}else{const into=typeof step.into==='string'?step.into:'';if(!into)errors.push('llm.ask: set into or fields so the paid answer has a destination');else if(!(into in spec.state))errors.push(`llm.ask: into="${into}" is not declared in state`);else if(!serialized.includes(`{{${into}`))errors.push(`llm.ask: answer "${into}" is never displayed`);}if(step.image!==undefined){const key=String(step.image).replace(/[{}\s]/g,'');if(!(key in spec.state))errors.push(`llm.ask: image="${String(step.image)}" is not declared in state`);if(!captures.length)errors.push('llm.ask: image is used but no camera.capture action exists');}}
 for(const step of captures){const into=typeof step.into==='string'?step.into:'';if(!into)errors.push('camera.capture: into is missing');else if(!(into in spec.state))errors.push(`camera.capture: into="${into}" is not declared in state`);}
 if((asks.length||images.length)&&!/llmBusy/.test(serialized))errors.push('AI/image action: use llmBusy to disable paid action buttons and prevent double charges');
 const photoKeys=captures.map(s=>typeof s.into==='string'?s.into:'').filter(Boolean);for(const photoKey of photoKeys){const saved=steps.some(step=>step.action==='records.add'&&step.values&&typeof step.values==='object'&&Object.values(step.values as Record<string,unknown>).some(v=>typeof v==='string'&&v.includes(photoKey)));if(!saved)continue;const galleryShows=serialized.includes('"type":"Gallery"')&&(photoKey==='photo'||serialized.includes(`"imageKey":"${photoKey}"`));const listShows=serialized.includes(`"imageKey":"${photoKey}"`);if(!galleryShows&&!listShows)errors.push(`records: captured photo "${photoKey}" is saved but history never displays it; use Gallery or imageKey`);}
 for(const step of steps){if(step.action!=='records.add'||!step.values||typeof step.values!=='object')continue;const collection=typeof step.collection==='string'?step.collection:'default';const schema=getCollectionSchema(spec,collection);for(const [key,raw]of Object.entries(step.values as Record<string,unknown>)){if(schema?.fields.find(x=>x.key===key)?.kind!=='number'||typeof raw!=='string')continue;const source=raw.replace(/[{}\s]/g,'');if(asks.some(ask=>ask.into===source&&!ask.fields))errors.push(`records.add: numeric field "${key}" receives free-text llm.ask output; use structured fields`);}}
}
