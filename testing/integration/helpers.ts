import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FIXTURE_PACKAGE_JSON, FIXTURE_TSCONFIG, FIXTURE_INDEX_TS, FIXTURE_INDEX_TEST_TS } from './fixtures.js';

const exec = promisify(execFile);

export interface FixtureProject {
  dir: string;
  cleanup: () => Promise<void>;
}

export async function createFixtureProject(): Promise<FixtureProject> {
  const dir = await mkdtemp(join(tmpdir(), 'tiny-spec-test-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'package.json'), FIXTURE_PACKAGE_JSON);
  await writeFile(join(dir, 'tsconfig.json'), FIXTURE_TSCONFIG);
  await writeFile(join(dir, 'src', 'index.ts'), FIXTURE_INDEX_TS);
  await writeFile(join(dir, 'tests', 'index.test.ts'), FIXTURE_INDEX_TEST_TS);
  await exec('git', ['init'], { cwd: dir });
  await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await exec('git', ['add', '.'], { cwd: dir });
  await exec('git', ['commit', '-m', 'init'], { cwd: dir });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
