import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const execFileAsync = promisify(execFile);
const gateScript = join(process.cwd(), 'skills/splitbrief-run/scripts/splitbrief-gate.sh');
const slug = '2026-09-13-094954-demo';

let project: string;

beforeEach(() => {
  project = createTempDir('splitbrief-gate');
});

afterEach(() => {
  cleanupTempDir(project);
});

function writeRun(...rows: string[]): void {
  const runDir = join(project, '.splitbrief/runs', slug);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'progress.md'),
    [
      '# SPLITBRIEF progress',
      '',
      '| Brief | File | Status | Attempts | Rung | Gates | Drift |',
      '|---|---|---|---|---|---|---|',
      ...rows,
      '',
    ].join('\n'),
  );
  writeFileSync(join(project, '.splitbrief/current-run'), runDir);
}

function runGate(host?: string): Promise<{ stdout: string }> {
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', SPLITBRIEF_PROJECT_DIR: project };
  if (host !== undefined) env.SPLITBRIEF_HOST = host;
  return execFileAsync('sh', [gateScript], { env });
}

const unfinished = `splitbrief run ${slug} not finished: T002 running — re-read progress.md and continue`;

describe('splitbrief-gate.sh', () => {
  it('no running or pending rows → exit 0 and empty stdout', async () => {
    writeRun(
      '| T001 | src/a.ts | done | 1 | — | pass | none |',
      '| T002 | src/b.ts | done | 2 | retry | pass | none |',
    );

    const { stdout } = await runGate();

    expect(stdout).toBe('');
  });

  it('default host prints decision block', async () => {
    writeRun(
      '| T001 | src/a.ts | done | 1 | — | pass | none |',
      '| T002 | src/b.ts | running | 1 | — | — | — |',
    );

    const { stdout } = await runGate();

    expect(JSON.parse(stdout)).toEqual({ decision: 'block', reason: unfinished });
  });

  it('SPLITBRIEF_HOST=cursor prints followup_message', async () => {
    writeRun(
      '| T001 | src/a.ts | done | 1 | — | pass | none |',
      '| T002 | src/b.ts | running | 1 | — | — | — |',
    );

    const { stdout } = await runGate('cursor');

    expect(JSON.parse(stdout)).toEqual({ followup_message: unfinished });
  });

  it('SPLITBRIEF_HOST=antigravity prints decision continue', async () => {
    writeRun(
      '| T001 | src/a.ts | done | 1 | — | pass | none |',
      '| T002 | src/b.ts | running | 1 | — | — | — |',
    );

    const { stdout } = await runGate('antigravity');

    expect(JSON.parse(stdout)).toEqual({ decision: 'continue', reason: unfinished });
  });
});
