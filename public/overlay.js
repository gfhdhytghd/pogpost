import { api, query } from './common.js';
import { startStage } from './overlay-stage.js';

/* OBS overlay. With ?operator=1 inside the console's same-origin frame, it also shows the
   Open and Close controls; the console performs the action. */
startStage({ load: () => api('/api/overlay'), operator: query.get('operator') === '1' && window.parent !== window });
