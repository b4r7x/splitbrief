import { describe, it, expect } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { buildLanguageContext } from './language-context.js';
import * as escalationPrompts from './escalation.js';

describe('hint path deleted', () => {
  it('exports no hint prompt, verdict line or verdict parser', () => {
    expect(escalationPrompts).not.toHaveProperty('buildHintPrompt');
    expect(escalationPrompts).not.toHaveProperty('parseHintVerdict');
    expect(escalationPrompts).not.toHaveProperty('HINT_VERDICT_LINE');
  });

  it('keeps the takeover prompt', () => {
    expect(escalationPrompts).toHaveProperty('buildEscalationPrompt');
  });
});

describe('escalation prompts', () => {
  it('Python full escalation uses Python signature fences', () => {
    const task = makeTask({ signature: 'def load_config(path: str) -> dict[str, str]:' });
    const prompt = escalationPrompts.buildEscalationPrompt({
      task,
      lastAttempt: 'old code',
      error: 'failed',
      languageContext: buildLanguageContext('python'),
      isolationDir: '/work',
      outputMode: 'text',
    });
    expect(prompt).toContain('```python');
    expect(prompt).toContain('Python import statements');
    expect(prompt).not.toMatch(/TypeScript|typescript|```typescript|ESM imports/);
  });

  it('matches the full-escalation output contract to the planner write mode', () => {
    const task = makeTask();
    const common = { task, lastAttempt: 'old code', error: 'failed', isolationDir: '/work' };

    const filePrompt = escalationPrompts.buildEscalationPrompt({ ...common, outputMode: 'files' });
    expect(filePrompt).toContain(`Edit \`${task.file}\` directly in the current working directory`);
    expect(filePrompt).toContain('Make the changes on disk');
    expect(filePrompt).not.toContain('Respond with the complete file content');

    const textPrompt = escalationPrompts.buildEscalationPrompt({ ...common, outputMode: 'text' });
    expect(textPrompt).toContain(`Respond with the complete file content for \`${task.file}\``);
    expect(textPrompt).not.toContain('Make the changes on disk');
  });

  it('holds a files-mode escalation to the workspace rules of its own directory', () => {
    const common = {
      task: makeTask(),
      lastAttempt: 'old code',
      error: 'failed',
      isolationDir: '/work/trees/run-1',
    };

    const filePrompt = escalationPrompts.buildEscalationPrompt({ ...common, outputMode: 'files' });
    expect(filePrompt).toContain(
      '- Stay inside /work/trees/run-1: read, search, write and run shell commands only there',
    );
    expect(filePrompt).toContain('- Use git only to read (status, diff, log, show);');
    expect(filePrompt).toContain('- Dependencies are already installed;');

    const textPrompt = escalationPrompts.buildEscalationPrompt({ ...common, outputMode: 'text' });
    expect(textPrompt).not.toContain('Stay inside');
  });
});
