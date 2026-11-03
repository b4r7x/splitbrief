import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CONFIRM_PHRASE } from '../core/approval/types.js';
import { __testResetProbeActivity, trackProbe } from '../engine/probe-activity.js';
import {
  promptCustomRunnerArtifactApproval,
  promptCustomRunnerDisclosure,
  promptForLine,
} from './custom-runner-prompts.js';
import { watchSlowProbeLines } from './slow-probe-line.js';

describe('promptForLine', () => {
  it('drops the slow-check line while the prompt is open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    __testResetProbeActivity();
    const input = new PassThrough();
    const stdin = vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const lines: string[] = [];
    const stop = watchSlowProbeLines((line) => lines.push(line));
    const probe = Promise.withResolvers<void>();
    const probeRun = trackProbe({ tool: 'codex', check: 'version' }, () => probe.promise);
    try {
      const answer = promptForLine('Trust? ');
      await vi.advanceTimersByTimeAsync(12_000);
      input.write('yes\n');
      await expect(answer).resolves.toBe('yes');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lines).toEqual([]);
    } finally {
      probe.resolve();
      await probeRun;
      stop();
      stdin.mockRestore();
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('custom runner CLI prompts', () => {
  it('shows the canonical disclosure and confirms on the exact phrase alone', async () => {
    const rendered: string[] = [];
    const questions: string[] = [];

    const response = await promptCustomRunnerDisclosure({
      request: {
        tier: 'confirm',
        actionClass: 'runner_trust',
        actionDescription: 'Canonical configured-runner disclosure',
        phase: 'planning',
      },
      options: {
        prompt: async (question) => {
          questions.push(question);
          return CONFIRM_PHRASE;
        },
        write: (text) => rendered.push(text),
      },
    });

    expect(response).toMatchObject({ decision: 'confirm', phrase: CONFIRM_PHRASE });
    expect(questions).toEqual([`Type ${CONFIRM_PHRASE} to trust this exact configured runner: `]);
    expect(rendered.join('')).toContain('Canonical configured-runner disclosure');
  });

  it.each([
    ['a different confirmation phrase', ['I agree']],
    ['a blank answer', ['  ']],
  ] as const)('fails closed for %s', async (_label, answers) => {
    let answerIndex = 0;
    const response = await promptCustomRunnerDisclosure({
      request: {
        tier: 'confirm',
        actionClass: 'runner_trust',
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
