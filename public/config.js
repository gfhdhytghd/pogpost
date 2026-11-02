import { $, el, api, post, status, categoryColor, iconFor } from './common.js';
let config;
const palette = { '#66d9c4':'Sea glass','#b5a1ff':'Lavender','#ffbd75':'Apricot gold','#ff9ab8':'Coral rose','#9dcfff':'Sky blue','#e5df88':'Lemon gold' };
const topics = {spoilers:'Spoilers',backseating:'Backseating',other_creators:'Other creators',politics:'Politics'};
for (const [id,name] of Object.entries(topics)) { const label = el('label','check',name); const input = el('input'); input.type='checkbox'; input.value=id; label.prepend(input); $('#forbidden-topics').append(label); }
const fieldMap = { 'moderation-mode':['moderation','mode'],'unsure':['moderation','unsure'],'strictness':['moderation','strictness'],'viewer-limit':['moderation','max_notes_per_viewer'],'allow-anonymous':['moderation','allow_anonymous'],'category-mode':[null,'category_mode'],'category-mismatch':[null,'category_mismatch'],'free-enabled':['payments','free_enabled'],'free-notes':['payments','free_notes'],'points-enabled':['payments','points_enabled'],'points-price':['payments','points_price'],'bits-enabled':['payments','bits_enabled'],'bits-tier':['payments','bits_tier'],'paid-guaranteed':['payments','paid_guaranteed'],'bits-advanced':['payments','bits_advanced_only'],'refund-reject':['payments','refund_on_reject'],'refund-expire':['payments','refund_on_expire'],'refund-never':['payments','refund_on_never'],'max-reveals':['reveal','max_per_moment'],'reveal-duration':['reveal','duration_ms'] };
function field(labelText, value, key, type='text') { const label=el('label','',labelText),input=el('input');input.value=value ?? '';input.dataset.key=key;input.type=type;label.append(input);return label; }
function renderCategories() { $('#category-editors').replaceChildren(); config.categories.forEach((category,index) => { const root=el('div','category-edit');root.dataset.categoryIndex=index;root.append(field('Category name',category.name,'name'),field('Subtitle',category.subtitle,'subtitle'),field('Icon name or symbol',category.icon,'icon'));const label=el('label','','Envelope color'),select=el('select');select.dataset.key='envelope_color';for(const [value,name]of Object.entries(palette)){const option=el('option','',name);option.value=value;select.append(option);}select.value=category.envelope_color;label.append(select);root.append(label,field('Description for AI classification',category.description,'description'),field('Test points override (optional)',category.price,'price','number'));const remove=el('button','small secondary','Remove category');remove.type='button';remove.disabled=config.categories.length<=3;remove.onclick=()=>{collect();config.categories.splice(index,1);renderCategories();};root.append(remove);$('#category-editors').append(root); }); }
function renderMoments() {
  $('#moment-editors').replaceChildren();
  config.moments.forEach((moment,index) => {
    const row = el('div','field-grid moment-editor'); row.dataset.momentIndex = index;
    row.append(field('Moment name',moment.label,'label'));
    const carry = el('label','check','Carry across streams'), checkbox = el('input');
    checkbox.type = 'checkbox'; checkbox.dataset.key = 'long_lived'; checkbox.checked = moment.long_lived; checkbox.disabled = moment.kind === 'builtin'; carry.prepend(checkbox); row.append(carry);
    if (moment.kind === 'declared' || moment.trigger?.type === 'stream_minutes') {
      const label = el('label','','How this moment happens'), select = el('select'); select.dataset.key = 'trigger_type';
      for (const [value,name] of [['manual','You declare it'],['stream_minutes','The stream reaches a minute']]) { const option = el('option','',name); option.value = value; select.append(option); }
      select.value = moment.trigger?.type === 'stream_minutes' ? 'stream_minutes' : 'manual'; label.append(select); row.append(label);
      const timerLabel = field('Stream minute',moment.trigger?.minutes ?? 15,'trigger_minutes','number'); const timer = timerLabel.querySelector('input'); timer.min = '1'; timer.max = '1440'; timer.step = 'any';
      const toggle = () => { timer.disabled = select.value !== 'stream_minutes'; timer.required = !timer.disabled; checkbox.disabled = !timer.disabled; if (!timer.disabled) checkbox.checked = false; }; select.onchange = toggle; toggle(); row.append(timerLabel);
    } else row.append(el('p','small muted',moment.kind === 'twitch' ? 'Confirmed by a Twitch event.' : 'Built-in moment.'));
    $('#moment-editors').append(row);
  });
}
function renderSignals() {
  const signals = config.signals || {clip_poll_enabled:false,chat_spike:{enabled:false,window_seconds:10,min_messages:20,min_viewers:5,cooldown_seconds:60}};
  $('#clips-enabled').checked = signals.clip_poll_enabled;
  $('#chat-spike-enabled').checked = signals.chat_spike.enabled;
  for (const [id,key] of [['chat-window','window_seconds'],['chat-messages','min_messages'],['chat-viewers','min_viewers'],['chat-cooldown','cooldown_seconds']]) $(`#${id}`).value = signals.chat_spike[key];
}

function render() { for(const [id,[group,key]]of Object.entries(fieldMap)){const value=(group?config[group]:config)[key],input=$(`#${id}`);if(input.type==='checkbox')input.checked=value;else input.value=id==='reveal-duration'?value/1000:value;}for(const input of $('#forbidden-topics').querySelectorAll('input'))input.checked=config.moderation.forbidden_topics.includes(input.value);$('#custom-words').value=config.moderation.custom_words.join('\n');renderCategories();renderMoments();renderSignals();$('#config-json').value=JSON.stringify(config,null,2); }
function collect() { for(const [id,[group,key]]of Object.entries(fieldMap)){const input=$(`#${id}`);let value=input.type==='checkbox'?input.checked:input.type==='number'||id==='bits-tier'?Number(input.value):input.value;if(id==='reveal-duration')value*=1000;(group?config[group]:config)[key]=value;}config.moderation.forbidden_topics=[...$('#forbidden-topics').querySelectorAll('input:checked')].map(input=>input.value);config.moderation.custom_words=$('#custom-words').value.split('\n').map(item=>item.trim()).filter(Boolean);for(const root of $('#category-editors').children){const category=config.categories[Number(root.dataset.categoryIndex)];for(const input of root.querySelectorAll('[data-key]')){if(input.dataset.key==='price'){if(input.value)category.price=Number(input.value);else delete category.price;}else category[input.dataset.key]=input.value;}}for(const root of $('#moment-editors').children) {
  const moment=config.moments[Number(root.dataset.momentIndex)];
  for(const input of root.querySelectorAll('[data-key]')) { if (input.dataset.key.startsWith('trigger_')) continue; moment[input.dataset.key]=input.type==='checkbox'?input.checked:input.value; }
  const trigger = root.querySelector('[data-key=trigger_type]');
  if (trigger?.value === 'stream_minutes') { moment.trigger = {type:'stream_minutes',minutes:Number(root.querySelector('[data-key=trigger_minutes]').value)}; moment.kind = 'twitch'; moment.long_lived = false; }
  else if (trigger) { delete moment.trigger; moment.kind = 'declared'; }
}
config.signals = {clip_poll_enabled:$('#clips-enabled').checked,chat_spike:{enabled:$('#chat-spike-enabled').checked,window_seconds:Number($('#chat-window').value),min_messages:Number($('#chat-messages').value),min_viewers:Number($('#chat-viewers').value),cooldown_seconds:Number($('#chat-cooldown').value)}};
return config; }
$('#add-category').onclick=()=>{collect();if(config.categories.length>=6){status('Use between 3 and 6 envelope categories.',true);return;}config.categories.push({id:`category-${crypto.randomUUID().slice(0,8)}`,name:'New category',subtitle:'A note for the moment',icon:'✦',description:'A note in this category.',envelope_color:'#9dcfff'});renderCategories();};
$('#add-moment').onclick=()=>{collect();config.moments.push({id:`moment-${crypto.randomUUID().slice(0,8)}`,label:'A new moment',kind:'declared',long_lived:false});renderMoments();};
$('#load-json').onclick=()=>{$('#config-json').value=JSON.stringify(collect(),null,2);status('The form is loaded into the JSON editor.');};$('#apply-json').onclick=()=>{try{const candidate=JSON.parse($('#config-json').value);if(!candidate.categories||!candidate.moderation||!candidate.payments||!candidate.reveal||!candidate.moments)throw new Error('Include all configuration sections.');config=candidate;render();status('JSON applied to the form. Save changes to update the channel.');}catch(error){status(`Invalid configuration: ${error.message}`,true);}};
$('#save-config').onclick=async()=>{if(!$('#config-form').reportValidity())return;$('#save-config').disabled=true;try{const result=await post('/ebs/config',{config:collect()});config=result.config||result;render();status('Changes saved. New notes use your updated rules.');}catch(error){status(error.message,true);}finally{$('#save-config').disabled=false;}};$('#config-form').onsubmit=event=>event.preventDefault();
try{const result=await api('/ebs/config');config=result.config||result;render();status('Your rules are ready to edit.');}catch(error){status(error.message,true);}
