import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';

const TINY_SPEC_DIR = '.tiny-spec';
const CURRENT_DIR = 'current';

function currentDir(projectDir: string): string {
  return join(projectDir, TINY_SPEC_DIR, CURRENT_DIR);
}

export function ensureTinySpecDir(projectDir: string): void {
  mkdirSync(currentDir(projectDir), { recursive: true });
}

export function writeSpecFile(projectDir: string, filename: string, content: string): void {
  ensureTinySpecDir(projectDir);
  writeFileSync(join(currentDir(projectDir), filename), content, 'utf-8');
}

export function readSpecFile(projectDir: string, filename: string): string | null {
  const filePath = join(currentDir(projectDir), filename);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

export function validateTaskPath(projectDir: string, filePath: string): string {
  if (isAbsolute(filePath)) {
    throw new Error(`Path '${filePath}' escapes project directory`);
  }
  const resolved = resolve(join(projectDir, filePath));
  if (!resolved.startsWith(resolve(projectDir))) {
    throw new Error(`Path '${filePath}' escapes project directory`);
  }
  return resolved;
}

export function acquireLock(projectDir: string): void {
  ensureTinySpecDir(projectDir);
  const lockPath = join(projectDir, TINY_SPEC_DIR, 'lock');
  if (existsSync(lockPath)) {
    const content = readFileSync(lockPath, 'utf-8');
    const pid = parseInt(content.trim(), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0);
        throw new Error(`Another tiny-spec instance is running (PID: ${pid})`);
      } catch (err: unknown) {
        if (err instanceof Error && err.message.startsWith('Another tiny-spec')) throw err;
      }
    }
  }
  writeFileSync(lockPath, String(process.pid), 'utf-8');
}

export function releaseLock(projectDir: string): void {
  const lockPath = join(projectDir, TINY_SPEC_DIR, 'lock');
  try {
    unlinkSync(lockPath);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
