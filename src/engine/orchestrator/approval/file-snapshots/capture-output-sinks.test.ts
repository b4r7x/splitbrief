import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

// A headless run redirected into the project (`--json > run.ndjson`) keeps
// appending to its own sink during every task window. The sink must never be
// reported as a task-window change: attributing it poisons the evidence
// ledger, which in turn defeats the pre-run-baseline excuse in drift analysis.
// The detector identifies the sink by the dev:ino of fd 1, so the flow has to
// run in a child process whose stdout really is the file in the project.
const CHILD_SCRIPT = `
  import { writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { getChangedFilesSinceSnapshot, getChangedFilesSnapshot } from ${JSON.stringify(new URL('./capture.ts', import.meta.url).href)};

  const project = process.env['SPLITBRIEF_TEST_SINK_PROJECT'];
  const resultPath = process.env['SPLITBRIEF_TEST_SINK_RESULT'];
  if (project === undefined || resultPath === undefined) process.exit(72);

  const snapshot = await getChangedFilesSnapshot(project);
  process.stdout.write('{"type":"task_started"}\\n');
  writeFileSync(join(project, 'feature.ts'), 'export const feature = true;\\n');
  const changed = await getChangedFilesSinceSnapshot(project, snapshot);
  writeFileSync(resultPath, JSON.stringify({ snapshot: snapshot.files, changed }));
`;

let dir: string | undefined;
let resultDir: string | undefined;

afterEach(() => {
  if (dir) cleanupTempDir(dir);
  if (resultDir) cleanupTempDir(resultDir);
  dir = undefined;
  resultDir = undefined;
});

describe('getChangedFilesSinceSnapshot with a process output sink in the project', () => {
  it('reports implementer changes but never the growing sink file', () => {
    dir = createTempDir('capture-sinks');
    resultDir = createTempDir('capture-sinks-result');
    createTestGitRepo(dir);
    writeFileSync(join(dir, 'run.ndjson'), '{"type":"phase_started"}\n');

    const resultPath = join(resultDir, 'result.json');
    const sinkFd = openSync(join(dir, 'run.ndjson'), 'a');
    let run: ReturnType<typeof spawnSync>;
    try {
      run = spawnSync(process.execPath, ['--import', 'tsx', '--eval', CHILD_SCRIPT], {
        env: {
          ...process.env,
          SPLITBRIEF_TEST_SINK_PROJECT: dir,
          SPLITBRIEF_TEST_SINK_RESULT: resultPath,
        },
        stdio: ['ignore', sinkFd, 'pipe'],
      });
    } finally {
      closeSync(sinkFd);
    }

    expect(run.stderr?.toString() ?? '').toBe('');
    expect(run.status).toBe(0);

    const result: { snapshot: string[]; changed: string[] } = JSON.parse(
      readFileSync(resultPath, 'utf8'),
    );
    expect(result.snapshot).toContain('run.ndjson');
    expect(readFileSync(join(dir, 'run.ndjson'), 'utf8')).toContain('task_started');
    expect(result.changed).toContain('feature.ts');
    expect(result.changed).not.toContain('run.ndjson');
  });
});
