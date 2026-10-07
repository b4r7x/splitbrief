import { join } from 'node:path';
import type { Attachment } from '../../src/core/schemas/attachment.js';
import { writeFakeCli, writeFakeNodeCli } from './command-shim.js';

export function installClaudeShim(shimDir: string, bodyLines: string[]): string {
  const body = bodyLines
    .map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    .join('\n');
  return writeFakeCli(shimDir, 'claude', `${body}\n`);
}

export function installClaudeNodeShim(shimDir: string, script: string): string {
  return writeFakeNodeCli(shimDir, 'claude', script);
}

export function installClaudeRecordingShim(shimDir: string): {
  argvFile: string;
  stdinFile: string;
} {
  const argvFile = join(shimDir, 'argv.txt');
  const stdinFile = join(shimDir, 'stdin.txt');
  const script = [
    `printf '%s\\n' "$@" > '${argvFile}'`,
    `cat > '${stdinFile}'`,
    `printf '%s\\n' '{"type":"result","result":"ok"}'`,
  ].join('\n');
  writeFakeCli(shimDir, 'claude', `${script}\n`);
  return { argvFile, stdinFile };
}

export function installClaudeFailingShim(
  shimDir: string,
  bodyLines: string[],
  exitCode: number,
): string {
  const body = bodyLines
    .map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    .join('\n');
  return writeFakeCli(shimDir, 'claude', `${body}\nexit ${exitCode}\n`);
}

export function installClaudeSlowShim(shimDir: string, bodyLines: string[]): string {
  const body = bodyLines
    .map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    .join('\n');
  // `exec` keeps the shim itself the only process: it stands for a CLI that
  // speaks and then hangs, not for a CLI that spawned a child to hang for it.
  return writeFakeCli(shimDir, 'claude', `${body}\nexec sleep 5\n`);
}

export function makeClaudeTestImage(path: string): Attachment {
  return {
    id: path,
    kind: 'image',
    path,
    mimeType: 'image/png',
    sizeBytes: 1,
  };
}
