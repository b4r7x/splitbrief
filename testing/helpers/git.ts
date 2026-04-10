import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createTestGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'init.txt'), 'init');
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
}
