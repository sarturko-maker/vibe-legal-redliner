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
    if (result.models.length > 0 && !result.models.some(m => m.id === state.settings.model)) {
      state.settings.model = result.models[0].id;
    }
  } else {
    state.availableModels = [];
    alert('Connection failed: ' + result.error);
  }

  saveSettings();
  render();
}
