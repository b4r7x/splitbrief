import { describe, expect, it } from 'vitest';
import { serializeReadinessCheckJson } from './json.js';

describe('readiness formatting', () => {
  it('gives a concrete installation action for an untrusted executable', () => {
    expect(
      serializeReadinessCheckJson({
        id: 'runners.planner.admission',
        severity: 'blocker',
        summary: 'The CLI executable is not trusted.',
        diagnosticState: 'untrusted-path',
      }).remediation,
    ).toBe(
      'Install the configured CLI outside the project. Put its absolute directory first on PATH, then run `splitbrief doctor` again.',
    );
  });
  it('publishes every seat a shared CLI problem stops', () => {
    expect(
      serializeReadinessCheckJson({
        id: 'runners.preparation.planner',
        severity: 'blocker',
        summary: 'PLAN and REVIEW cannot start with OpenAI Codex CLI.',
        runnerCause: { tool: 'codex', cause: 'missing-binary', seats: ['PLAN', 'REVIEW'] },
      }).seats,
    ).toEqual(['PLAN', 'REVIEW']);
  });
});
