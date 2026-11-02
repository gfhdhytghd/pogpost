/** One definition of selectable moments, shared by the server and viewer/operator UI. */
export function groupMomentChoices(moments = [], definitions = []) {
  const rows = Array.isArray(moments) ? moments : [];
  const byId = new Map(rows.map(moment => [moment.id, moment]));
  const used = new Set();
  const current_profile = [];
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    const moment = byId.get(definition.id);
    if (moment && !used.has(moment.id)) { current_profile.push(moment); used.add(moment.id); }
  }
  const stream_general = [];
  for (const moment of rows) {
    const general = moment.kind === 'twitch' || (moment.kind === 'builtin' && ['start', 'end'].includes(moment.id));
    if (general && !used.has(moment.id)) { stream_general.push(moment); used.add(moment.id); }
  }
  return {current_profile, stream_general};
}
