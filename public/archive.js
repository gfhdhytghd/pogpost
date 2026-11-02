import { $, api, renderReveal, empty, status, el, demo } from './common.js';
if (demo) { $('#archive-write').href = '/panel.html?demo=1'; $('#archive-write').textContent = 'Write a note'; $('.brand').href = '/'; }
let last = '', notes = [];
function render() {
  const selected = $('#archive-session').value;
  const visible = selected ? notes.filter(note => note.stream_session_id === selected) : notes;
  $('#archive-count').textContent = `${visible.length} ${visible.length === 1 ? 'note' : 'notes'}`;
  const root = $('#archive-grid'); root.replaceChildren();
  if (!visible.length) { empty(root, 'The first envelope is still waiting for its moment. Come back after a note opens.'); return; }
  for (const note of [...visible].reverse()) { const card = renderReveal(note, {categories:note.category ? [note.category] : []}); card.classList.add('archive-card'); root.append(card); }
}
async function refresh() {
  try {
    const data = await api('/api/archive'), key = JSON.stringify(data.notes || []); if (key === last) return; last = key; notes = data.notes || [];
    const selected = $('#archive-session').value, select = $('#archive-session'); select.replaceChildren(el('option','','All streams')); select.firstChild.value = '';
    const sessions = [...new Set(notes.map(note => note.stream_session_id).filter(Boolean))];
    for (const id of sessions.reverse()) { const option = el('option','',`Stream ${String(id).slice(0,8)}`); option.value = id; select.append(option); }
    if (sessions.includes(selected)) select.value = selected;
    render(); status('');
  } catch (error) { status(error.message,true); }
}
$('#archive-session').onchange = render;
refresh(); setInterval(refresh,5000);
