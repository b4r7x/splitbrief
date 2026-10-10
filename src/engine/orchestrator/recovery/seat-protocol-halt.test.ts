import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { typedOutputError } from '../../runners/typed-output.js';
import { seatProtocolHaltIssue } from './seat-protocol-halt.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

async function projectWithTools(): Promise<string> {
  const projectDir = createTempDir('seat-protocol-halt');
  dirs.push(projectDir);
  await rememberDetectedTools(projectDir, [
    cliDetectionFor('ready', 'claude-code'),
    cliDetectionFor('ready', 'codex'),
  ]);
  return projectDir;
}

const reviewerProtocolError = typedOutputError.seatProtocol({
  seat: 'reviewer',
  attempts: 2,
  transport: 'fallback',
  errors: 'answer.action: invalid',
  answerPreview: '{}',
});

describe('seatProtocolHaltIssue', () => {
  it('halts and switches an inherited reviewer on the review seat', async () => {
    const issue = await seatProtocolHaltIssue({
      projectDir: await projectWithTools(),
      config: makeConfig({}),
      error: reviewerProtocolError,
      phase: 'implementing',
    });

    expect(issue.seat).toBe('review');
    expect(issue.switchSeat).toEqual({ seat: 'review', candidates: [{ tool: 'codex' }] });
  });

  it('swaps the review seat when a reviewer block declares it', async () => {
    const issue = await seatProtocolHaltIssue({
      projectDir: await projectWithTools(),
      config: makeConfig({ reviewer: { kind: 'cli', tool: 'codex' } }),
      error: reviewerProtocolError,
      phase: 'final-review',
    });

    expect(issue.seat).toBe('review');
    expect(issue.switchSeat).toEqual({ seat: 'review', candidates: [{ tool: 'claude-code' }] });
  });
});
