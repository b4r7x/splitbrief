import { describe, it, expect } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { buildLanguageContext } from './language-context.js';
import { buildEscalationPrompt, buildHintPrompt } from './escalation.js';

describe('escalation prompts', () => {
  it('TypeScript hint includes the ESM pitfall', () => {
    const prompt = buildHintPrompt(makeTask(), 'failed', buildLanguageContext('typescript'));
    expect(prompt).toContain('missing .js extension');
  });

  it('Python hint has no TypeScript or ESM-specific pitfall', () => {
    const prompt = buildHintPrompt(makeTask(), 'failed', buildLanguageContext('python'));
    expect(prompt).toContain('Python');
    expect(prompt).not.toMatch(/TypeScript|typescript|missing \.js extension|ESM imports/);
  });

  it('Python full escalation uses Python signature fences', () => {
    const task = makeTask({ signature: 'def load_config(path: str) -> dict[str, str]:' });
    const prompt = buildEscalationPrompt(task, 'old code', 'failed', buildLanguageContext('python'));
    expect(prompt).toContain('```python');
    expect(prompt).toContain('Python import statements');
    expect(prompt).not.toMatch(/TypeScript|typescript|```typescript|ESM imports/);
  });
});
