import { execFile } from 'node:child_process';
import { warnError } from '../warn.js';

const NATIVE_TIMEOUT_MS = 2000;

const linuxClipboardArgs = {
  'wl-copy': [],
  xclip: ['-selection', 'clipboard'],
  xsel: ['--clipboard', '--input'],
} as const;

type LinuxCopyTool = keyof typeof linuxClipboardArgs;

const linuxProbeOrder: readonly LinuxCopyTool[] = ['wl-copy', 'xclip', 'xsel'];

let linuxCopy: LinuxCopyTool | null | undefined;

export function _resetLinuxCopyCache(): void {
  linuxCopy = undefined;
}

function exitCodeOf(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = err.code;
    return typeof code === 'number' ? code : null;
  }
  return null;
}

function runWithStdin(
  command: string,
  args: readonly string[],
  input: string,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = execFile(command, [...args], { timeout: NATIVE_TIMEOUT_MS }, (err) => {
      resolve(err ? exitCodeOf(err) : 0);
    });
    // EPIPE just means the tool exited before draining stdin — its exit code is the source of truth.
    // Any other stdin failure is a real write error; surface it and resolve as a failure so a partial
    // write can never combine with a spurious exit-0 into a false "native" success.
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return;
      warnError('clipboard: native stdin write failed', err);
      resolve(1);
    });
    child.stdin?.end(input);
  });
}

async function probeLinuxCopy(text: string): Promise<boolean> {
  for (const tool of linuxProbeOrder) {
    const code = await runWithStdin(tool, linuxClipboardArgs[tool], text);
    if (code === 0) {
      linuxCopy = tool;
      return true;
    }
  }
  linuxCopy = null;
  return false;
}

async function copyNativeLinux(text: string): Promise<boolean> {
  if (linuxCopy === null) return false;
  if (linuxCopy !== undefined) {
    return (await runWithStdin(linuxCopy, linuxClipboardArgs[linuxCopy], text)) === 0;
  }
  return probeLinuxCopy(text);
}

export async function copyNative(text: string): Promise<boolean> {
  switch (process.platform) {
    case 'darwin':
      return (await runWithStdin('pbcopy', [], text)) === 0;
    case 'linux':
      return copyNativeLinux(text);
    case 'win32':
      return (await runWithStdin('clip', [], text)) === 0;
    default:
      return false;
  }
}

export async function tmuxLoadBuffer(text: string): Promise<boolean> {
  if (!process.env['TMUX']) return false;
  const args =
    process.env['LC_TERMINAL'] === 'iTerm2' ? ['load-buffer', '-'] : ['load-buffer', '-w', '-'];
  const code = await runWithStdin('tmux', args, text);
  return code === 0;
}
