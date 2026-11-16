import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findLaunchingUnitTests, projectFiles } from './unit-test-launches.js';

// Build fixture markers from parts so this unit test does not flag its own source.
const gitRepoHelper = ['createTest', 'GitRepo'].join('');
const gitLaunch = ['execFileSync(', "'git"].join('');
const execPathShim = ['#!$', '{process.execPath}'].join('');
const trackedWorkflow = ['runTracked', 'Workflow('].join('');
const shellShebang = ['#!', '/bin/sh'].join('');
const toolShimHelper = ['install', 'ToolShim'].join('');

describe('unit test launches', () => {
  let root: string;

  const write = (relPath: string, source: string): void => {
    const fullPath = join(root, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, source);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'unit-test-launches-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports the first launch marker in each unit file and ignores integration files and fakes', () => {
    write('src/a.test.ts', `${gitRepoHelper}(dir);\n${gitLaunch}', ['init']);\n`);
    write('src/b.integration.test.ts', `${gitRepoHelper}(dir);\n`);
    write('src/c.test.ts', 'const deps = { runWorkflow: vi.fn() };\n');
    write('src/d.test.ts', `${gitLaunch}', ['init']);\n`);

    expect(findLaunchingUnitTests(root)).toEqual([
      `src/a.test.ts: ${gitRepoHelper}`,
      `src/d.test.ts: ${gitLaunch}`,
    ]);
  });

  it('collects colocated integration files and files under testing/integration', () => {
    write('src/b.integration.test.ts', `${gitRepoHelper}(dir);\n`);
    write('testing/integration/x/y.test.ts', '');
    write('src/a.test.ts', '');

    expect(projectFiles('integration', root)).toEqual([
      'src/b.integration.test.ts',
      'testing/integration/x/y.test.ts',
    ]);
  });

  it('reports a node shim that uses the runtime executable', () => {
    write('src/shim.test.ts', `${execPathShim}\n`);

    expect(findLaunchingUnitTests(root)).toEqual([`src/shim.test.ts: ${execPathShim}`]);
  });

  it('reports the tracked run loop helper', () => {
    write('src/tracked.test.ts', `${trackedWorkflow}ctx);\n`);

    expect(findLaunchingUnitTests(root)).toEqual([`src/tracked.test.ts: ${trackedWorkflow}`]);
  });

  it('reports a shell script that reads its arguments and the tool shim helper', () => {
    write(
      'src/argv.test.ts',
      `const script = ['${shellShebang}', 'if [ "$1" = "--version" ]; then', 'fi'];\n`,
    );
    write('src/log.test.ts', `const script = '${shellShebang}\\nprintf "%s" "$*" >> log';\n`);
    write('src/helper.test.ts', `await ${toolShimHelper}(dir, 'codex', script);\n`);

    expect(findLaunchingUnitTests(root)).toEqual([
      `src/argv.test.ts: ${shellShebang}`,
      `src/helper.test.ts: ${toolShimHelper}`,
      `src/log.test.ts: ${shellShebang}`,
    ]);
  });

  it('ignores a shell script that reads no argument', () => {
    write('src/data.test.ts', `writeFileSync(file, '${shellShebang}\\nexit 0\\n');\n`);

    expect(findLaunchingUnitTests(root)).toEqual([]);
  });

  it('names a missing project in its error', () => {
    expect(() => projectFiles('missing', root)).toThrow('Vitest project not found: missing');
  });
});
