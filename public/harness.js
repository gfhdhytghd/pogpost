/* Local-only Twitch Extension stand-in. Tokens come from the local server. */
(() => {
  const query = new URLSearchParams(location.search);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || query.get('demo') !== '1') return;
  const authorized = [], contexts = [], listeners = new Map();
  let auth;
  const role = query.get('role') === 'broadcaster' ? 'broadcaster' : 'viewer';
  fetch(`/demo/auth?viewer=${encodeURIComponent(query.get('viewer') || 'one')}&role=${role}`, { credentials: 'same-origin' })
    .then(r => { if (!r.ok) throw new Error('Local demo authentication failed'); return r.json(); })
    .then(value => { auth = { token: value.token, channelId: value.channelId, userId: 'local-demo', clientId: 'local-demo' }; authorized.forEach(fn => fn(auth)); })
    .catch(error => { window.dispatchEvent(new CustomEvent('sealed-auth-error', { detail: error.message })); });
  const ext = {
    viewer: { isLinked: false, id: null },
    onAuthorized(fn) { authorized.push(fn); if (auth) fn(auth); },
    onContext(fn) { contexts.push(fn); fn({ hlsLatencyBroadcaster: Number(query.get('latency') || 0) }, ['hlsLatencyBroadcaster']); },
    listen(topic, fn) { listeners.set(topic, fn); },
    unlisten(topic) { listeners.delete(topic); },
    actions: { async requestIdShare() { const response = await fetch(`/demo/auth?viewer=${encodeURIComponent(query.get('viewer') || 'one')}&role=${role}&shared=1`, {credentials:'same-origin'}); if (!response.ok) return; const value=await response.json(); auth={...auth,token:value.token}; ext.viewer.isLinked=true; ext.viewer.id='local-linked-viewer'; authorized.forEach(fn=>fn(auth)); window.dispatchEvent(new CustomEvent('sealed-identity-shared')); } },
    bits: { useBits() { throw new Error('TEST MODE — no real charge. Live Bits are disabled.'); }, onTransactionComplete() {}, onTransactionCancelled() {} },
    configuration: { broadcaster: { content: '{}' }, onChanged(fn) { fn(); } }
  };
  window.Twitch = { ext };
  window.SealedHarness = { setContext(context) { contexts.forEach(fn => fn(context, Object.keys(context))); }, publish(topic, message) { listeners.get(topic)?.(topic, 'application/json', JSON.stringify(message)); }, get authorizedCount() { return authorized.length; }, get contextCount() { return contexts.length; }, get listenerCount() { return listeners.size; } };
})();
