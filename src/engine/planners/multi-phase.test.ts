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
