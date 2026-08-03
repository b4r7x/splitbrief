import { describe, expect, it } from 'vitest';
import { CONFIRM_PHRASE } from '../core/approval/types.js';
import {
  promptCustomRunnerArtifactApproval,
  promptCustomRunnerDisclosure,
} from './custom-runner-prompts.js';

describe('custom runner CLI prompts', () => {
  it('shows the canonical disclosure and returns an exact confirmed response with a reason', async () => {
    const rendered: string[] = [];
    const answers = [CONFIRM_PHRASE, 'I reviewed the executable and its declared environment.'];

    const response = await promptCustomRunnerDisclosure({
      request: {
        tier: 'confirm',
        actionClass: 'network',
        actionDescription: 'Canonical configured-runner disclosure',
        phase: 'planning',
      },
      options: {
        prompt: async () => answers.shift() ?? '',
        write: (text) => rendered.push(text),
      },
    });

    expect(response).toEqual({
      decision: 'confirm',
      phrase: CONFIRM_PHRASE,
      reason: 'I reviewed the executable and its declared environment.',
    });
    expect(rendered.join('')).toContain('Canonical configured-runner disclosure');
  });

  it.each([
    ['a different confirmation phrase', ['I agree', 'Reviewed.']],
    ['a blank confirmation reason', [CONFIRM_PHRASE, '  ']],
  ] as const)('fails closed for %s', async (_label, answers) => {
    let answerIndex = 0;
    const response = await promptCustomRunnerDisclosure({
      request: {
        tier: 'confirm',
        actionClass: 'network',
        actionDescription: 'Canonical configured-runner disclosure',
        phase: 'planning',
      },
      options: { prompt: async () => answers[answerIndex++] ?? '', write: () => {} },
    });

    expect(response.decision).toBe('deny');
  });

  it('shows a control-safe artifact and accepts only an explicit approval', async () => {
    const artifact = '\u001b]52;c;clipboard-secret\u0007Reviewed artifact text';
    const rendered: string[] = [];

    const approved = await promptCustomRunnerArtifactApproval({
      label: 'Custom planner artifact',
      text: artifact,
      options: { prompt: async () => 'yes', write: (text) => rendered.push(text) },
    });
    const rejected = await promptCustomRunnerArtifactApproval({
      label: 'Custom planner artifact',
      text: artifact,
      options: { prompt: async () => '', write: () => {} },
    });

    expect(approved).toEqual({ approved: true });
    expect(rejected).toEqual({ approved: false });
    expect(rendered.join('')).toContain('Custom planner artifact');
    expect(rendered.join('')).toContain('Reviewed artifact text');
    expect(rendered.join('')).not.toContain('clipboard-secret');
    expect(rendered.join('')).not.toContain('\u001b');
  });
});
