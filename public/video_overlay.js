import { api, embedded, parentOrigin, watchPrivateEvents } from './common.js';
import { startStage } from './overlay-stage.js';

/* Twitch viewer overlay: the same stage, read-only. In the panel's Watch view (data-embedded,
   srcdoc) it makes no requests and runs no Twitch helper; it shows only the public snapshots
   its parent panel posts. */
if (embedded) {
  const stage = startStage({});
  addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== parentOrigin || event.data?.type !== 'sealed-presentation') return;
    stage.apply(event.data.presentation);
  });
  window.parent.postMessage({ type: 'sealed-presentation-ready' }, parentOrigin);
} else {
  const load = async () => { const state = await api('/ebs/state'); return state.presentation || { sealedCount: state.sealedCount }; };
  const stage = startStage({ load });
  watchPrivateEvents();
  addEventListener('sealed-refresh', stage.refresh);
}
