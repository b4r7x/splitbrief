import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attachment } from '../../src/core/schemas/attachment.js';

export function installClaudeShim(shimDir: string, bodyLines: string[]): string {
  const shimPath = join(shimDir, 'claude');
  const body = bodyLines
    .map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    .join('\n');
  writeFileSync(shimPath, `#!/bin/bash\n${body}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return shimPath;
}

export function installClaudeNodeShim(shimDir: string, script: string): string {
  const shimPath = join(shimDir, 'claude');
  writeFileSync(shimPath, `#!/usr/bin/env node\n${script}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return shimPath;
}

export function installClaudeRecordingShim(shimDir: string): {
  argvFile: string;
  stdinFile: string;
} {
  const argvFile = join(shimDir, 'argv.txt');
  const stdinFile = join(shimDir, 'stdin.txt');
  const shimPath = join(shimDir, 'claude');
  const script = [
    '#!/bin/bash',
    `printf '%s\\n' "$@" > '${argvFile}'`,
    `cat > '${stdinFile}'`,
    `printf '%s\\n' '{"type":"result","result":"ok"}'`,
  ].join('\n');
  writeFileSync(shimPath, `${script}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return { argvFile, stdinFile };
}

export function installClaudeFailingShim(
  shimDir: string,
  bodyLines: string[],
  exitCode: number,
): string {
  const shimPath = join(shimDir, 'claude');
  const body = bodyLines
    .map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    .join('\n');
  writeFileSync(shimPath, `#!/bin/bash\n${body}\nexit ${exitCode}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return shimPath;
}

export function installClaudeSlowShim(shimDir: string, bodyLines: string[]): string {
  const shimPath = join(shimDir, 'claude');
  const body = bodyLines
    .map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    .join('\n');
  writeFileSync(shimPath, `#!/bin/bash\n${body}\nsleep 5\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return shimPath;
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
