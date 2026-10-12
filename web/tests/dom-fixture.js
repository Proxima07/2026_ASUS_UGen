// Mount controls from the shipped HTML: missing IDs return null instead of
// inventing elements. This exercises main.js wiring, not isolated prototypes.
export class Element {
  constructor(tag,attributes={}){
    this.tag=tag;this.attributes=new Map(Object.entries(attributes));this.children=[];this.listeners=new Map();this.parentElement=null;this.textContent='';this.value='';this.files=[];this.hidden='hidden'in attributes;this.disabled='disabled'in attributes;this.open=false;
    this.dataset=Object.fromEntries(Object.entries(attributes).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5),value]));
    this.classes=new Set((attributes.class||'').split(/\s+/));this.classList={toggle:(name,active)=>active?this.classes.add(name):this.classes.delete(name),contains:name=>this.classes.has(name)};
  }
  addEventListener(type,callback){const values=this.listeners.get(type)||[];values.push(callback);this.listeners.set(type,values);}
  async emit(type){await Promise.all((this.listeners.get(type)||[]).map(callback=>callback({preventDefault(){},target:this})));}
  setAttribute(name,value){this.attributes.set(name,value);}
  removeAttribute(name){this.attributes.delete(name);}
  append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const node of this.children)node.parentElement=null;this.children=[];this.append(...nodes);}
  remove(){const list=this.parentElement?.children;if(list){const index=list.indexOf(this);if(index>=0)list.splice(index,1);}this.parentElement=null;}
  before(node){const parent=this.parentElement;if(!parent)return;node.remove();const index=parent.children.indexOf(this);parent.children.splice(index,0,node);node.parentElement=parent;}
  focus(){}scrollIntoView(){}
}
export function mount(html){
  const all=[],stack=[],events=new Map();
  for(const token of html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)||[]){
    if(token.startsWith('<!--')||token.startsWith('<!'))continue;
    if(token.startsWith('</')){stack.pop();continue;}
    if(token.startsWith('<')){
      const tag=token.match(/^<([\w-]+)/)?.[1];if(!tag)continue;const attributes={};
      for(const [,key,quoted,bare]of token.matchAll(/\s+([\w-]+)(?:="([^"]*)"|=([^\s>]+))?/g))attributes[key]=quoted??bare??'';
      const element=new Element(tag,attributes);all.push(element);stack.at(-1)?.append(element);
      if(!['meta','link','input','br','hr','img','source','path','rect'].includes(tag)&&!token.endsWith('/>'))stack.push(element);
    }else if(stack.length)stack.at(-1).textContent+=token.trim();
  }
  function matches(node,selector){if(selector.startsWith('#'))return node.attributes.get('id')===selector.slice(1);if(selector.startsWith('.'))return node.classes.has(selector.slice(1));if(selector.startsWith('['))return node.attributes.has(selector.slice(1,-1));return node.tag===selector;}
  return {hidden:false,querySelector:selector=>all.find(node=>matches(node,selector))||null,querySelectorAll:selector=>all.filter(node=>matches(node,selector)),createElement:tag=>new Element(tag),
    addEventListener(type,callback){const list=events.get(type)||[];list.push(callback);events.set(type,list);},async emit(type){await Promise.all((events.get(type)||[]).map(callback=>callback()));}};
}
export const deferred=()=>{let resolve;const promise=new Promise(ok=>resolve=ok);return {promise,resolve};};
export const settle=async()=>{for(let count=0;count<30;count++)await Promise.resolve();};
export const json=value=>({ok:true,status:200,headers:{get:()=>null},json:async()=>value});

