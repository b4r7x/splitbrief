import { describe, expect, it } from 'vitest';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { runMultiPhasePlanning } from './multi-phase.js';

function completed(text: string) {
  return makeRunnerCallResult({ status: 'completed', text });
}

const callbacks = { onOutput: () => {} };

describe('runMultiPhasePlanning artifact admission', () => {
  it('does not pass an invalid spec to the plan phase', async () => {
    const prompts: string[] = [];
    const outputs = ['# Research\n\nFindings.', 'Which scope should tasks.md cover?'];

    await expect(
      runMultiPhasePlanning(
        {
          invokePlan: async ({ prompt }) => {
            prompts.push(prompt);
            return completed(outputs[prompts.length - 1] ?? '');
          },
        },
        { feature: 'feature', projectDir: '/tmp', callbacks },
      ),
    ).rejects.toMatchObject({
      kind: 'planning-invalid-artifact',
      data: { phase: 'specifying', filename: 'spec.md' },
    });

    expect(prompts).toHaveLength(2);
  });

  it('does not pass an invalid plan to the task phase', async () => {
    const prompts: string[] = [];
    const outputs = [
      '# Research\n\nFindings.',
      '# Spec\n\nRequirements.',
      'Which scope should tasks.md cover?',
    ];

    await expect(
      runMultiPhasePlanning(
        {
          invokePlan: async ({ prompt }) => {
            prompts.push(prompt);
            return completed(outputs[prompts.length - 1] ?? '');
          },
        },
        { feature: 'feature', projectDir: '/tmp', callbacks },
      ),
    ).rejects.toMatchObject({
      kind: 'planning-invalid-artifact',
      data: { phase: 'planning', filename: 'plan.md' },
    });

    expect(prompts).toHaveLength(3);
  });
});

const tasksMarkdown = `---
id: T001
title: Add the health route
action: create
file: src/health.ts
depends_on: []
---

### Description
Add it.

### Implementation Steps
1. Write the handler.

### Tests
- returns 200
`;

describe('runMultiPhasePlanning task phase', () => {
  it('builds one tasks prompt and parses the reply strictly', async () => {
    const prompts: string[] = [];
    const outputs = [
      '# Research\n\nFindings.',
      '# Spec\n\nRequirements.',
      '# Plan\n\n## File Structure\n### New Files\n- `src/health.ts`\n  Purpose: the route.',
      tasksMarkdown,
    ];

    const result = await runMultiPhasePlanning(
      {
        invokePlan: async ({ prompt }) => {
          prompts.push(prompt);
          return completed(outputs[prompts.length - 1] ?? '');
        },
      },
      { feature: 'feature', projectDir: '/tmp', callbacks },
    );

    expect(prompts).toHaveLength(4);
    expect(prompts[3]).toContain('Compile Product Task Briefs');
    expect(result.tasks.map((task) => task.file)).toEqual(['src/health.ts']);
  });

  it('spec and tasks prompts carry skills', async () => {
    const prompts: string[] = [];
    const outputs = [
      '# Research\n\nFindings.',
      '# Spec\n\nRequirements.',
      '# Plan\n\n## File Structure\n### New Files\n- `src/health.ts`\n  Purpose: the route.',
      tasksMarkdown,
    ];

    await runMultiPhasePlanning(
      {
        invokePlan: async ({ prompt }) => {
          prompts.push(prompt);
          return completed(outputs[prompts.length - 1] ?? '');
        },
      },
      {
        feature: 'feature',
        projectDir: '/tmp',
        callbacks,
        skillsContext: '## Active Project Skills\n\n### AuthSkill\nSKILL-BODY',
      },
    );

    expect(prompts[1]).toContain('## Active Project Skills');
    expect(prompts[1]).toContain('SKILL-BODY');
    expect(prompts[3]).toContain('## Active Project Skills');
    expect(prompts[3]).toContain('SKILL-BODY');
  });
});
