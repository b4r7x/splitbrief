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
    const prompt = buildEscalationPrompt({
      task,
      lastAttempt: 'old code',
      error: 'failed',
      languageContext: buildLanguageContext('python'),
      outputMode: 'text',
    });
    expect(prompt).toContain('```python');
    expect(prompt).toContain('Python import statements');
    expect(prompt).not.toMatch(/TypeScript|typescript|```typescript|ESM imports/);
  });

  it('matches the full-escalation output contract to the planner write mode', () => {
    const task = makeTask();
    const common = { task, lastAttempt: 'old code', error: 'failed' };

    const filePrompt = buildEscalationPrompt({ ...common, outputMode: 'files' });
    expect(filePrompt).toContain(`Edit \`${task.file}\` directly in the current working directory`);
    expect(filePrompt).toContain('Make the changes on disk');
    expect(filePrompt).not.toContain('Respond with the complete file content');

    const textPrompt = buildEscalationPrompt({ ...common, outputMode: 'text' });
    expect(textPrompt).toContain(`Respond with the complete file content for \`${task.file}\``);
    expect(textPrompt).not.toContain('Make the changes on disk');
  });
});
