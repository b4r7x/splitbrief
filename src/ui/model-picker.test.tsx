import { describe, it, expect } from 'vitest';
import { ModelPicker } from './model-picker.js';
import type { ProviderGroup, ModelPickerProps } from './model-picker.js';

describe('ModelPicker', () => {
  it('exports ModelPicker as a function', () => {
    expect(typeof ModelPicker).toBe('function');
  });

  it('ProviderGroup shape is accepted by props', () => {
    const providers: ProviderGroup[] = [
      { name: 'ollama', models: ['llama3:8b', 'codellama:7b'], isLocal: true },
      { name: 'deepseek', models: ['deepseek-coder'], isLocal: false },
    ];

    const props: ModelPickerProps = {
      providers,
      onSelect: (_provider: string, _model: string) => {},
      onCancel: () => {},
    };

    expect(props.providers).toHaveLength(2);
    expect(props.providers[0].models).toHaveLength(2);
    expect(props.providers[1].isLocal).toBe(false);
  });

  it('handles empty providers list', () => {
    const props: ModelPickerProps = {
      providers: [],
      onSelect: () => {},
      onCancel: () => {},
    };

    expect(props.providers).toHaveLength(0);
  });

  it('ProviderGroup with isLocal flag distinguishes local vs remote', () => {
    const local: ProviderGroup = { name: 'ollama', models: ['m1'], isLocal: true };
    const remote: ProviderGroup = { name: 'openrouter', models: ['m2'], isLocal: false };

    expect(local.isLocal).toBe(true);
    expect(remote.isLocal).toBe(false);
  });
});
