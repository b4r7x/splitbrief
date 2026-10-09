import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../core/schemas/plan.js';
import { createEventBus } from '../../events/bus.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/validation-fixtures.js';
import { runChecks } from './run-checks.js';

const PROBE = [
  'const secrets = ["OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "SSH_AUTH_SOCK"];',
  'const seen = secrets.filter((name) => process.env[name] !== undefined);',
  'console.log("home " + process.env.HOME);',
  'console.log("seen " + (seen.length === 0 ? "none" : seen.join(" ")));',
].join('\n');

describe('the environment of a check SPLITBRIEF runs', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempDir('command-env');
    writeFileSync(join(projectDir, 'probe.cjs'), PROBE);
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node probe.cjs' } }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    cleanupTempDir(projectDir);
  });

  it('runs the project test with the real HOME and without the host secrets', {
    timeout: 60_000,
  }, async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-check-env-canary');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-check-env-canary');
    vi.stubEnv('GITHUB_TOKEN', 'ghp-check-env-canary');
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/check-env-canary.sock');
    const plan: Plan = {
      summary: 'Plan summary',
      decisions: [],
      criteria: [],
      checks: [{ id: 'C1', kind: 'cmd', value: 'npm test', required: true }],
      validation: null,
    };

    const [result] = await runChecks(['C1'], {
      plan,
      projectDir,
      checkoutDir: projectDir,
      config: makeConfig({}),
      bus: createEventBus(),
      phase: 'final-review',
      npmScriptsApproved: false,
    });

    expect(result?.status).toBe('pass');
    expect(result?.output).toContain(`home ${process.env.HOME}`);
    expect(result?.output).toContain('seen none');
    expect(result?.output).not.toContain('canary');
  });
});
