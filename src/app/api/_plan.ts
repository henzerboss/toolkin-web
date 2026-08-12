import { ACTION_NAMES, CAPABILITIES, COMPONENT_TYPES } from '@/lib/dsl';
import { THINKING, callGemini, safeJsonParse } from './_shared';

export type AppKind='game'|'tracker'|'calculator'|'timer'|'converter'|'ai_tool'|'image_tool'|'list'|'countdown'|'other';
export interface Feature{
 id:string;title:string;description:string;essential:boolean;
 /** Observable user outcome, not an implementation detail. */
 acceptanceCriteria:string[];
 /** Data/AI semantics needed by this specific feature, so deselection can derive an exact plan. */
 requiresRecords?:boolean;requiresStructuredAi?:boolean;
 /** Exact mechanical minimums. Never list visual substitutes. */
 requiresComponents:string[];requiresActions:string[];requiresCapabilities:string[];
}
export interface PlannedScreen{id:string;title:string;purpose:string;}
export interface PlannedCustomComponent{name:string;purpose:string;strategy:'compose'|'extend';}
export interface Plan{
 kind:AppKind;title:string;capabilities:string[];components:string[];needsRecords:boolean;needsStructuredAi:boolean;summary:string;
 navigation:'single'|'stack'|'tabs';screens:PlannedScreen[];customComponents:PlannedCustomComponent[];features:Feature[];
}
const KINDS:AppKind[]=['game','tracker','calculator','timer','converter','ai_tool','image_tool','list','countdown','other'];
const FEATURE_SCHEMA:Record<string,unknown>={type:'OBJECT',properties:{id:{type:'STRING'},title:{type:'STRING'},description:{type:'STRING'},essential:{type:'BOOLEAN'},acceptanceCriteria:{type:'ARRAY',items:{type:'STRING'},minItems:1,maxItems:4},requiresRecords:{type:'BOOLEAN'},requiresStructuredAi:{type:'BOOLEAN'},requiresComponents:{type:'ARRAY',items:{type:'STRING',enum:COMPONENT_TYPES}},requiresActions:{type:'ARRAY',items:{type:'STRING',enum:ACTION_NAMES}},requiresCapabilities:{type:'ARRAY',items:{type:'STRING',enum:[...CAPABILITIES]}}},required:['id','title','description','essential','acceptanceCriteria','requiresRecords','requiresStructuredAi','requiresComponents','requiresActions','requiresCapabilities']};
const SCREEN_SCHEMA:Record<string,unknown>={type:'OBJECT',properties:{id:{type:'STRING'},title:{type:'STRING'},purpose:{type:'STRING'}},required:['id','title','purpose']};
const CUSTOM_SCHEMA:Record<string,unknown>={type:'OBJECT',properties:{name:{type:'STRING'},purpose:{type:'STRING'},strategy:{type:'STRING',enum:['compose','extend']}},required:['name','purpose','strategy']};
const PLAN_SCHEMA:Record<string,unknown>={type:'OBJECT',properties:{kind:{type:'STRING',enum:KINDS},title:{type:'STRING'},summary:{type:'STRING'},navigation:{type:'STRING',enum:['single','stack','tabs']},screens:{type:'ARRAY',items:SCREEN_SCHEMA,minItems:1,maxItems:4},customComponents:{type:'ARRAY',items:CUSTOM_SCHEMA,maxItems:8},features:{type:'ARRAY',items:FEATURE_SCHEMA,minItems:1,maxItems:8},needsRecords:{type:'BOOLEAN'},needsStructuredAi:{type:'BOOLEAN'},capabilities:{type:'ARRAY',items:{type:'STRING',enum:[...CAPABILITIES]}},components:{type:'ARRAY',items:{type:'STRING',enum:COMPONENT_TYPES}}},required:['kind','title','summary','navigation','screens','customComponents','features','needsRecords','needsStructuredAi','capabilities','components'],propertyOrdering:['kind','title','summary','navigation','screens','customComponents','features','needsRecords','needsStructuredAi','capabilities','components']};

const PLAN_SYSTEM=[
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

function correct(plan:Plan):Plan{
 const capabilities=new Set(plan.capabilities),components=new Set(plan.components);
 if(plan.kind==='game'){capabilities.add('sandbox');components.add('Sandbox');}
 if(plan.kind==='image_tool'){capabilities.add('image');components.add('Image');}
 if(capabilities.has('camera'))components.add('Image');
 if(capabilities.has('image'))components.add('Image');
 return{...plan,capabilities:[...capabilities],components:[...components]};
}
const FALLBACK:Plan={kind:'other',title:'',capabilities:[],components:[],needsRecords:false,needsStructuredAi:false,summary:'',navigation:'single',screens:[{id:'home',title:'',purpose:''}],customComponents:[],features:[]};
export interface PlanResult{plan:Plan;ok:boolean;}
function safeId(value:unknown,fallback:string):string{const id=String(value??'').trim().replace(/[^A-Za-z0-9_-]/g,'-').replace(/^-+|-+$/g,'').slice(0,40);return id||fallback;}
function normalizeFeatures(raw:unknown):Feature[]{if(!Array.isArray(raw))return[];const seen=new Set<string>(),out:Feature[]=[];for(const item of raw as Partial<Feature>[]){const id=safeId(item?.id,`feature-${out.length+1}`),title=String(item?.title??'').trim();if(!title||seen.has(id))continue;seen.add(id);const criteria=Array.isArray(item.acceptanceCriteria)?item.acceptanceCriteria.map(x=>String(x).trim()).filter(Boolean).slice(0,4):[];out.push({id,title:title.slice(0,70),description:String(item.description??'').slice(0,180),essential:Boolean(item.essential),acceptanceCriteria:criteria.length?criteria:[String(item.description||title)],requiresRecords:Boolean(item.requiresRecords),requiresStructuredAi:Boolean(item.requiresStructuredAi),requiresComponents:Array.isArray(item.requiresComponents)?item.requiresComponents:[],requiresActions:Array.isArray(item.requiresActions)?item.requiresActions:[],requiresCapabilities:Array.isArray(item.requiresCapabilities)?item.requiresCapabilities:[]});}return out.slice(0,8);}
function normalizeScreens(raw:unknown):PlannedScreen[]{if(!Array.isArray(raw))return FALLBACK.screens;const seen=new Set<string>(),out:PlannedScreen[]=[];for(const item of raw as Partial<PlannedScreen>[]){const id=safeId(item.id,`screen-${out.length+1}`).toLowerCase();if(seen.has(id))continue;seen.add(id);out.push({id,title:String(item.title??'').slice(0,40),purpose:String(item.purpose??'').slice(0,180)});}return out.length?out.slice(0,4):FALLBACK.screens;}
function normalizeCustom(raw:unknown):PlannedCustomComponent[]{if(!Array.isArray(raw))return[];const seen=new Set<string>(),out:PlannedCustomComponent[]=[];for(const item of raw as Partial<PlannedCustomComponent>[]){let name=String(item.name??'').replace(/[^A-Za-z0-9]/g,'').slice(0,40);if(!/^[A-Z]/.test(name))name=`App${name||'Component'}`;if(seen.has(name)||COMPONENT_TYPES.includes(name))continue;seen.add(name);out.push({name,purpose:String(item.purpose??'').slice(0,220),strategy:item.strategy==='extend'?'extend':'compose'});}return out.slice(0,8);}

/** Derive a build plan from the exact feature selection the user made. */
export function planForFeatures(plan:Plan,selectedIds:string[]):Plan{
 const selected=plan.features.filter(f=>selectedIds.includes(f.id));const components=new Set<string>(),capabilities=new Set<string>(),actions=new Set<string>();
 for(const f of selected){f.requiresComponents.forEach(x=>components.add(x));f.requiresCapabilities.forEach(x=>capabilities.add(x));f.requiresActions.forEach(x=>actions.add(x));}
 // Keep only non-feature-specific structural hints; selected feature requirements are re-added above.
 for(const x of plan.components)if(['Screen','Stack','Row','Grid','Card','Section','Text','Button','EmptyState'].includes(x))components.add(x);
 const recordComponents=new Set(['List','Table','Gallery','Chart','LineChart','PieChart']);
 const needsRecords=selected.some(f=>Boolean(f.requiresRecords))||[...actions].some(a=>a.startsWith('records.'))||[...components].some(c=>recordComponents.has(c));
 const needsStructuredAi=selected.some(f=>Boolean(f.requiresStructuredAi))||(capabilities.has('llm')&&plan.needsStructuredAi&&selected.length===plan.features.length);
 // If the user deselected every proposed feature (for example to keep only a custom feature),
 // do not leak the original feature-specific IA into the derived plan.
 const emptySelection=selected.length===0;
 return correct({...plan,features:selected,components:[...components],capabilities:[...capabilities],needsRecords,needsStructuredAi,
  navigation:emptySelection?'single':plan.navigation,
  screens:emptySelection?[plan.screens[0]??FALLBACK.screens[0]]:plan.screens,
  customComponents:emptySelection?[]:plan.customComponents});
}

export async function planApp(request:string,locale:string):Promise<PlanResult>{
 const system=`${PLAN_SYSTEM}\n\nUser language/locale: ${locale}.`;
 const user=`User request: "${request.slice(0,800)}"`;
 for(let attempt=0;attempt<2;attempt++){
  const result=await callGemini(system,user,{jsonOnly:true,thinking:THINKING.plan,purpose:'plan',responseSchema:PLAN_SCHEMA});
  if(!result.ok)continue;
  const parsed=safeJsonParse<Partial<Plan>|null>(result.text??'',null);if(!parsed?.kind)continue;
  const features=normalizeFeatures(parsed.features);if(features.length<1)continue;
  const screens=normalizeScreens(parsed.screens);let navigation:Plan['navigation']=parsed.navigation==='tabs'||parsed.navigation==='stack'?parsed.navigation:'single';if(screens.length===1)navigation='single';if(screens.length>1&&navigation==='single')navigation='stack';
  return{ok:true,plan:correct({kind:KINDS.includes(parsed.kind)?parsed.kind:'other',title:String(parsed.title??'').slice(0,40),summary:String(parsed.summary??'').slice(0,500),navigation,screens,customComponents:normalizeCustom(parsed.customComponents),features,needsRecords:Boolean(parsed.needsRecords),needsStructuredAi:Boolean(parsed.needsStructuredAi),capabilities:Array.isArray(parsed.capabilities)?parsed.capabilities:[],components:Array.isArray(parsed.components)?parsed.components:[]})};
 }
 return{plan:FALLBACK,ok:false};
}
