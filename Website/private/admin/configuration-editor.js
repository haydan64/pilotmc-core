'use strict';
const state = { config: null, schema: null, revision: null, csrf: null, tab: 'discord', dirty: false, busy: false, jsonPending: false };
const $ = selector => document.querySelector(selector);
function message(text, kind = '') { $('#message').textContent = text; $('#message').className = `status ${kind}`; }
function dirty() { state.jsonPending=false; $('#save').disabled=state.busy; state.dirty = true; $('#revision').textContent = `Editing version ${state.revision} · Unsaved changes`; syncJson(); }
function syncJson() { $('#json').value = JSON.stringify(state.config, null, 2); }
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type':'application/json', ...(options.headers || {}) } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { const err = new Error(result.error || `Request failed (${response.status})`); err.status = response.status; throw err; }
  return result;
}
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function defaultValue(schema) {
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties || {}).map(([key,value]) => [key,defaultValue(value)]));
  return schema.type === 'array' ? [] : '';
}
function renderField(schema, value, change, location) {
  if (schema.jsonEditor) {
    const label = element('label', undefined, 'field'); label.append(element('span',schema.title)); const input = element('textarea'); input.value = JSON.stringify(value,null,2); input.setAttribute('aria-label', location);
    input.addEventListener('input', () => { try { const parsed=JSON.parse(input.value); if (!Array.isArray(parsed)) throw new Error(); input.setCustomValidity(''); change(parsed); dirty(); } catch { input.setCustomValidity('Enter a valid JSON array'); } }); label.append(input); return label;
  }
  if (schema.type === 'object') {
    const group=element('fieldset'); group.append(element('legend',schema.title || location));
    for (const [key,child] of Object.entries(schema.properties)) group.append(renderField(child,value[key],next=>{value[key]=next;change(value);}, `${location}.${key}`)); return group;
  }
  if (schema.type === 'array') {
    const container=element('fieldset'); container.append(element('legend',schema.title));
    value.forEach((item,index) => {
      const row=element('div',undefined,'array-item'); const heading=element('div',undefined,'array-heading'); heading.append(element('strong',item.name || item.label || `${schema.items.title || 'Entry'} ${index+1}`));
      const remove=element('button','Remove','danger'); remove.type='button'; remove.addEventListener('click',()=>{value.splice(index,1);change(value);dirty();render();}); heading.append(remove); row.append(heading);
      row.append(renderField(schema.items,item,next=>{value[index]=next;change(value);},`${location}[${index}]`)); container.append(row);
    });
    const add=element('button',`Add ${schema.items.title || 'entry'}`); add.type='button'; add.disabled=value.length>=schema.maxItems; add.addEventListener('click',()=>{value.push(defaultValue(schema.items));change(value);dirty();render();}); container.append(add); return container;
  }
  const label=element('label',undefined,'field'); const input=element(schema.multiline?'textarea':'input'); input.setAttribute('aria-label', location);
  if(schema.type==='boolean'){input.type='checkbox';input.checked=value;label.append(input,document.createTextNode(schema.title));}
  else {label.append(element('span',schema.title));if(!schema.multiline)input.type=schema.type==='integer'?'number':'text';input.value=value;if(schema.minimum!==undefined)input.min=schema.minimum;if(schema.maximum!==undefined)input.max=schema.maximum;if(schema.maxLength)input.maxLength=schema.maxLength;if(schema.minLength){input.minLength=schema.minLength;input.required=true;}if(schema.pattern)input.pattern=schema.pattern;label.append(input);}
  input.addEventListener('input',()=>{change(schema.type==='boolean'?input.checked:schema.type==='integer'?Number(input.value):input.value);dirty();});
  if(schema.description)label.append(element('small',schema.description)); return label;
}
function hydrate(value, schema) {
  if(schema.type==='object'&&schema.properties){const result=value&&typeof value==='object'&&!Array.isArray(value)?value:{};for(const[key,child]of Object.entries(schema.properties))result[key]=hydrate(result[key],child);return result;}
  if(schema.type==='array')return Array.isArray(value)?value.map(item=>hydrate(item,schema.items)):defaultValue(schema);
  return value===undefined?defaultValue(schema):value;
}
function render(){
  const editor=$('#editor');editor.className='';editor.replaceChildren(renderField(state.schema.properties[state.tab],state.config[state.tab],next=>state.config[state.tab]=next,state.tab));
  $('#tabs').replaceChildren(); for(const [key,schema]of Object.entries(state.schema.properties)){const tab=element('button',schema.title,key===state.tab?'selected':'');tab.addEventListener('click',()=>{if(state.jsonPending){message('Select Use JSON to apply your JSON draft before switching sections.');return;}state.tab=key;render();});$('#tabs').append(tab);}syncJson();
}
function statuses(result){
  $('#services').replaceChildren();
  const expected=['backend','discord','website',...result.config.servers.map(server=>`instance:${server.key}`)];
  for(const serviceId of expected){const row=result.services?.find(item=>item.serviceId===serviceId);const container=element('div',undefined,'service');container.append(element('strong',serviceId));
    const online=row && Date.now()-new Date(row.lastSeen).getTime()<90000;
    const text=!row?'Awaiting first connection':!online?`Not reporting · Active v${row.activeRevision}`:row.activeRevision<result.revision?`Restart needed · Active v${row.activeRevision}`:`Current · Version ${row.activeRevision}`;
    container.append(element('span',text,`badge ${!row||!online||row.activeRevision<result.revision?'pending':''}`));$('#services').append(container);
  }
  $('#history').replaceChildren();for(const entry of result.history||[]){const button=element('button',`Version ${entry.revision} · ${new Date(entry.updatedAt).toLocaleString()}`);button.addEventListener('click',async()=>{if(state.dirty&&!confirm('Replace your unsaved draft with this version?'))return;try{const earlier=await request(`/admin/api/configuration/history/${entry.revision}`);state.config=earlier.config;dirty();render();message(`Version ${entry.revision} loaded as a draft. Save to restore it.`);}catch(err){message(err.message,'error');}});$('#history').append(button);}
}
function busy(value){state.busy=value;['save','reload','useJson'].forEach(id=>$('#'+id).disabled=value||!state.config);}
async function load(){busy(true);try{const result=await request('/admin/api/configuration');state.config=result.config;state.schema=result.schema;state.revision=result.revision;state.csrf=result.csrfToken;state.dirty=false;state.jsonPending=false;render();statuses(result);$('#revision').textContent=`Saved version ${state.revision}`;message('Configuration loaded. Changes apply after service restart.');}catch(err){message(err.message,'error');}finally{busy(false);}}
$('#save').addEventListener('click',async()=>{if(state.busy)return;const invalid=Array.from($('#editor').querySelectorAll('input,textarea')).find(input=>!input.checkValidity());if(invalid){invalid.reportValidity();return;}busy(true);try{const result=await request('/admin/api/configuration',{method:'PUT',headers:{'X-Config-CSRF':state.csrf},body:JSON.stringify({config:state.config,expectedRevision:state.revision})});state.revision=result.revision;state.dirty=false;$('#revision').textContent=`Saved version ${state.revision}`;message(`Version ${state.revision} saved. Restart affected services to apply it.`,'good');await refreshStatuses();}catch(err){message(err.status===409?'Another admin changed configuration. Your draft is preserved. Copy its JSON before reloading to reconcile the changes.':err.message,'error');}finally{busy(false);}});
$('#reload').addEventListener('click',()=>{if(!state.dirty||confirm('Discard unsaved configuration changes?'))load();});
$('#json').addEventListener('input',()=>{state.jsonPending=true;state.dirty=true;$('#revision').textContent=`Editing version ${state.revision} · JSON draft — select Use JSON before saving`;$('#save').disabled=true;});
$('#useJson').addEventListener('click',()=>{try{const parsed=JSON.parse($('#json').value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Configuration must be an object');for(const key of Object.keys(state.schema.properties))if(!(key in parsed))throw new Error(`Missing ${key} section`);state.jsonPending=false;state.config=hydrate(parsed,state.schema);dirty();render();busy(false);message('JSON applied to the draft. Save to validate and publish it.');}catch(err){message(err.message,'error');}});
window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
async function refreshStatuses(){try{statuses(await request('/admin/api/configuration'));}catch{/* Editor draft stays intact during connection loss. */}}
setInterval(()=>{if(state.config&&!state.busy)refreshStatuses();},30000);
load();
