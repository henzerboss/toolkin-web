import type { Feature } from '@/app/api/_plan';
import { ACTION_NAMES, COMPONENT_TYPES } from '@/lib/dsl';
import { getScreenRoots, type MiniAppSpec, type UiNode } from '@/lib/specTypes';

interface Inventory { components:Set<string>; actions:Set<string>; screens:Set<string>; }
function collect(spec:MiniAppSpec):Inventory{
 const components=new Set<string>(),actions=new Set<string>(),screens=new Set(Object.keys(getScreenRoots(spec))),visitedCustom=new Set<string>();
 const walk=(node:UiNode):void=>{components.add(node.type);if(typeof node.bind==='string')actions.add('state.set');if(Array.isArray(node.onPress))for(const raw of node.onPress as unknown as Record<string,unknown>[])if(typeof raw.action==='string')actions.add(raw.action);if(spec.components?.[node.type]&&!visitedCustom.has(node.type)){visitedCustom.add(node.type);walk(spec.components[node.type].template);}if(Array.isArray(node.children))node.children.forEach(walk);};Object.values(getScreenRoots(spec)).forEach(walk);return{components,actions,screens};
}
export interface FeatureCheck{ok:boolean;issues:string[];implemented:string[];missing:{id:string;title:string}[];}
export function checkFeatures(spec:MiniAppSpec,features:Feature[]):FeatureCheck{
 if(!features.length)return{ok:true,issues:[],implemented:[],missing:[]};const inventory=collect(spec),caps=new Set<string>(spec.capabilities),issues:string[]=[],implemented:string[]=[],missing:{id:string;title:string}[]=[];
 for(const feature of features){const gaps:string[]=[];for(const c of feature.requiresComponents)if(!inventory.components.has(c))gaps.push(`required component ${c}`);for(const a of feature.requiresActions)if(!inventory.actions.has(a))gaps.push(`required action ${a}`);for(const c of feature.requiresCapabilities)if(!caps.has(c))gaps.push(`required capability ${c}`);
  const evidence=spec.featureEvidence?.[feature.id];const count=(evidence?.screens?.length??0)+(evidence?.components?.length??0)+(evidence?.actions?.length??0)+(evidence?.capabilities?.length??0);
  if(!evidence||!count)gaps.push('featureEvidence is missing');else{for(const x of evidence.screens??[])if(!inventory.screens.has(x))gaps.push(`evidence screen ${x} does not exist`);for(const x of evidence.components??[])if(!inventory.components.has(x))gaps.push(`evidence component ${x} is not used`);for(const x of evidence.actions??[])if(!inventory.actions.has(x))gaps.push(`evidence action ${x} is not used`);for(const x of evidence.capabilities??[])if(!caps.has(x))gaps.push(`evidence capability ${x} is not declared`);const structural=new Set(['Screen','Stack','Row','Grid','Card','Section','Text','Button','Divider','Spacer','EmptyState']);const meaningfulComponents=(evidence.components??[]).filter((x)=>!structural.has(x)).length;const concrete=meaningfulComponents+(evidence.actions?.length??0)+(evidence.capabilities?.length??0);if(!concrete&&!feature.requiresComponents.length&&!feature.requiresActions.length&&!feature.requiresCapabilities.length)gaps.push('featureEvidence must cite a behavioral/specialized component, action or capability; layout/Text alone does not prove a feature');}
  for(const a of evidence?.actions??[])if(!ACTION_NAMES.includes(a))gaps.push(`unknown evidence action ${a}`);for(const c of evidence?.components??[])if(!COMPONENT_TYPES.includes(c)&&!spec.components?.[c])gaps.push(`unknown evidence component ${c}`);
  const unique=[...new Set(gaps)];if(!unique.length)implemented.push(feature.id);else{missing.push({id:feature.id,title:feature.title});issues.push(`feature "${feature.title}" [${feature.id}] is not proven/implemented: ${unique.join(', ')}. Implement its acceptance criteria (${feature.acceptanceCriteria.join('; ')}) and update featureEvidence with exact elements that do the work.`);}
 }
 return{ok:!issues.length,issues,implemented,missing};
}
