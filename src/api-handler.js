/**
 * API connection testing handler
 */

import { state, saveSettings } from './state.js';
import { testConnection } from './utils/ai-bundle.js';
import { render } from './ui.js';

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
    // Set default model if current not in list
    if (!result.models.find(m => m.id === state.settings.model) && result.models.length > 0) {
      state.settings.model = result.models[0].id;
    }
  } else {
    state.availableModels = [];
    alert('Connection failed: ' + result.error);
  }

  saveSettings();
  render();
}
