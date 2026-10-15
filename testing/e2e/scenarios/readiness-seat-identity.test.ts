import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import YAML from 'yaml';
import { z } from 'zod';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import {
  activateCompatibleCliShim,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { spawnCli } from '../helpers/live-cli-harness.js';

const DoctorRecordSchema = z.object({
  type: z.literal('readiness_report'),
  report: z.object({
    checks: z.array(
      z.object({
        id: z.string(),
        summary: z.string(),
        modelSelection: z.enum(['auto', 'unset', 'explicit']).optional(),
      }),
    ),
  }),
});

let tmp: string;
let projectDir: string;
let restoreShim: () => void;

beforeEach(() => {
  tmp = createTempDir('e2e-readiness-identities');
  projectDir = join(tmp, 'project');
  mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
  restoreShim = activateCompatibleCliShim(
    installCompatibleCliShim({
      directory: join(tmp, 'bin'),
      tool: 'claude-code',
      authChannel: 'session',
    }),
  );
});

afterEach(() => {
  restoreShim();
  cleanupTempDir(tmp);
});

function configure(model?: string, effort?: 'high', reviewer = true): void {
  const runner = { kind: 'cli', tool: 'claude-code', model, effort } as const;
  writeFileSync(
    join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE),
    YAML.stringify(
      makeConfig({ planner: runner, implementer: runner, ...(reviewer && { reviewer: runner }) }),
    ),
  );
}

function cli(json: boolean): ReturnType<typeof spawnCli> {
  return spawnCli({
    args: [
      '--import',
      'tsx',
      'src/cli.ts',
      'doctor',
      '--project',
      projectDir,
      ...(json ? ['--json'] : []),
    ],
    stateHome: join(tmp, 'state'),
    timeoutMs: 30_000,
  });
}

it('prints the same Claude alias and effort in human and JSON readiness', async () => {
  configure('sonnet', 'high');
  const human = await cli(false);
  const out = stripVTControlCharacters(human.stdout);
  expect(out, human.stderr).toContain('PLAN Claude Code CLI · Sonnet 5.5 · high configured.');
  expect(out).toContain('REVIEW Claude Code CLI · Sonnet 5.5 · high configured.');
  expect(out).toContain('BUILD Claude Code CLI · Sonnet 5.5 · high configured.');
  expect(out).not.toMatch(/runners\.|context\.|Command options:|00000000-0000/);

  const json = await cli(true);
  const record = DoctorRecordSchema.parse(JSON.parse(json.stdout.trim()));
  expect(record.report.checks.find((check) => check.id === 'runners.planner.configured')).toEqual({
    id: 'runners.planner.configured',
    summary: 'PLAN Claude Code CLI · Sonnet 5.5 · high configured.',
    modelSelection: 'explicit',
  });
});

it('prints auto for automatic and unset models while retaining selection metadata', async () => {
  for (const model of ['auto', undefined]) {
    configure(model);
    const json = await cli(true);
    const record = DoctorRecordSchema.parse(JSON.parse(json.stdout.trim()));
    expect(record.report.checks.find((check) => check.id === 'runners.planner.configured')).toEqual(
      {
        id: 'runners.planner.configured',
        summary: 'PLAN Claude Code CLI · auto configured.',
        modelSelection: model === undefined ? 'unset' : 'auto',
      },
    );
  }
});

it('names the PLAN seat as REVIEW in human and JSON readiness without a reviewer block', async () => {
  configure('sonnet', 'high', false);
  const human = await cli(false);
  const out = stripVTControlCharacters(human.stdout);
  expect(out, human.stderr).toContain('REVIEW = PLAN · Claude Code CLI · Sonnet 5.5 · high.');
  expect(out).toContain('REVIEW uses the tool and model of PLAN.');

  const json = await cli(true);
  const record = DoctorRecordSchema.parse(JSON.parse(json.stdout.trim()));
  expect(record.report.checks.find((check) => check.id === 'runners.reviewer.inherited')).toEqual({
    id: 'runners.reviewer.inherited',
    summary: 'REVIEW = PLAN · Claude Code CLI · Sonnet 5.5 · high.',
    modelSelection: 'explicit',
  });
});
