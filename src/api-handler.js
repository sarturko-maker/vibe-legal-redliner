import { state, saveSettings } from './state.js';
import { testConnection } from './utils/ai-bundle.js';
import { render } from './ui.js';

const GEMINI_EXCLUDE = /lite|preview|image|tts|thinking/i;

function pickDefaultModel(models, provider) {
  if (provider === 'gemini') {
    const ideal = models.find(m => /2\.5-flash/i.test(m.id) && !GEMINI_EXCLUDE.test(m.id));
    if (ideal) {
      console.log('[VL-DEBUG] Default model selected', { modelId: ideal.id, reason: '2.5-flash (no excluded variants)' });
      return ideal.id;
    }
    const anyFlash25 = models.find(m => /2\.5-flash/i.test(m.id));
    if (anyFlash25) {
      console.log('[VL-DEBUG] Default model selected', { modelId: anyFlash25.id, reason: '2.5-flash (any variant)' });
      return anyFlash25.id;
    }
    const newerFlash = models.find(m => /flash/i.test(m.id) && !/lite|1\.0|1\.5/i.test(m.id));
    if (newerFlash) {
      console.log('[VL-DEBUG] Default model selected', { modelId: newerFlash.id, reason: 'flash (newer, non-lite)' });
      return newerFlash.id;
    }
  }
  const fallback = models[0].id;
  console.log('[VL-DEBUG] Default model selected', { modelId: fallback, reason: 'fallback (first in list)' });
  return fallback;
}

export async function handleTestConnection() {
  state.isTestingConnection = true;
  render();

  const result = await testConnection({
    provider: state.settings.provider,
    apiKey: state.settings.apiKey
  });

  state.isTestingConnection = false;
  state.connectionTested = true;

  if (result.success) {
    state.availableModels = result.models;
    if (result.models.length > 0 && !result.models.some(m => m.id === state.settings.model)) {
      state.settings.model = pickDefaultModel(result.models, state.settings.provider);
    }
  } else {
    state.availableModels = [];
    alert('Connection failed: ' + result.error);
  }

  saveSettings();
  render();
}
