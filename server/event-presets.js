import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEventPreset } from './event-definitions.js';

const PRESET_DIRECTORY = fileURLToPath(new URL('../presets/', import.meta.url));
const CATALOG = Object.freeze([
  Object.freeze({ id: 'ksp', file: 'ksp.json', label: 'Kerbal Space Program', description: 'Launch, destructive explosion, landing, EVA, flag planting, and parachute deployment.' }),
  Object.freeze({ id: 'generic', file: 'generic.json', label: 'General games', description: 'First death, victory screen, and boss defeated.' }),
]);

export const BUILTIN_EVENT_PRESET_IDS = Object.freeze(CATALOG.map(preset => preset.id));

/** Public definitions only. Catalog entries never come from directory listings or request paths. */
export async function listEventPresets({ catalogDir = PRESET_DIRECTORY } = {}) {
  return Promise.all(CATALOG.map(async ({ id, file, label, description }) => {
    try {
      const preset = await loadEventPreset(path.join(catalogDir, file));
      return { id, label, description, events: preset.events };
    } catch {
      throw Object.assign(new Error(`The built-in ${id} event preset is unavailable.`), { status: 503, code: 'event_presets_unavailable' });
    }
  }));
}
