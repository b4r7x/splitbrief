import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { cleanupTempDir, createTempDir } from './temp-dir.js';

export interface ClipboardExecCall {
  file: string;
  args: string[];
  stdin: string;
}

interface SavedEnv {
  path: string | undefined;
  callsPath: string | undefined;
  exitCodes: string | undefined;
}

interface ClipboardExecFixture {
  calls: () => ClipboardExecCall[];
  reset: () => void;
  restore: () => void;
  setExitCodes: (codes: Record<string, number>) => void;
}

const COMMANDS = ['pbcopy', 'clip', 'wl-copy', 'xclip', 'xsel', 'tmux'] as const;
const CALLS_ENV = 'DIPTYCH_TEST_CLIPBOARD_CALLS';
const EXIT_CODES_ENV = 'DIPTYCH_TEST_CLIPBOARD_EXIT_CODES';

// Copies are fire-and-forget spawns polled from the test; under multi-fork load the spawn plus
// the record append can still take seconds, so give the poll generous headroom.
export const CLIPBOARD_EXEC_WAIT_MS = 15_000;

let active: ClipboardExecFixture | null = null;

// The fakes are /bin/sh scripts, not node scripts: the production clipboard runner kills the tool
// after NATIVE_TIMEOUT_MS (2s), and a cold node startup can outlive that on a box running several
// vitest forks at once — the killed fake then records nothing and the copy falls through to OSC-52.
// Each record line is `file<TAB>base64(arg),…<TAB>base64(stdin)` so arbitrary stdin survives sh.
function commandScript(): string {
  return `#!/bin/sh
stdin_b64=$(base64 | tr -d '\\n')
args_b64=''
for a in "$@"; do
  e=$(printf %s "$a" | base64 | tr -d '\\n')
  if [ -z "$args_b64" ]; then args_b64="$e"; else args_b64="$args_b64,$e"; fi
done
file=$(basename "$0")
if [ -n "\${${CALLS_ENV}}" ]; then
  printf '%s\\t%s\\t%s\\n' "$file" "$args_b64" "$stdin_b64" >> "\${${CALLS_ENV}}"
fi
code=0
for pair in \${${EXIT_CODES_ENV}}; do
  case "$pair" in
    "$file="*) code=\${pair#*=} ;;
  esac
done
exit "$code"
`;
}

function restoreEnv(saved: SavedEnv): void {
  if (saved.path === undefined) delete process.env['PATH'];
  else process.env['PATH'] = saved.path;

  if (saved.callsPath === undefined) delete process.env[CALLS_ENV];
  else process.env[CALLS_ENV] = saved.callsPath;

  if (saved.exitCodes === undefined) delete process.env[EXIT_CODES_ENV];
  else process.env[EXIT_CODES_ENV] = saved.exitCodes;
}

function decodeBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function readCalls(callsPath: string): ClipboardExecCall[] {
  if (!existsSync(callsPath)) return [];
  return readFileSync(callsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [file = '', argsField = '', stdinField = ''] = line.split('\t');
      return {
        file,
        args: argsField ? argsField.split(',').map(decodeBase64) : [],
        stdin: decodeBase64(stdinField),
      };
    });
}

export function installClipboardExecFixture(): ClipboardExecFixture {
  active?.restore();

  const root = createTempDir('clipboard-exec');
  const bin = join(root, 'bin');
  const callsPath = join(root, 'calls.jsonl');
  const saved: SavedEnv = {
    path: process.env['PATH'],
    callsPath: process.env[CALLS_ENV],
    exitCodes: process.env[EXIT_CODES_ENV],
  };

  mkdirSync(bin, { recursive: true });
  for (const command of COMMANDS) {
    const commandPath = join(bin, command);
    writeFileSync(commandPath, commandScript());
    chmodSync(commandPath, 0o755);
  }

  process.env['PATH'] = [bin, saved.path].filter(Boolean).join(delimiter);
  process.env[CALLS_ENV] = callsPath;
  process.env[EXIT_CODES_ENV] = '';

  const fixture: ClipboardExecFixture = {
    calls: () => readCalls(callsPath),
    reset: () => {
      rmSync(callsPath, { force: true });
      process.env[EXIT_CODES_ENV] = '';
    },
    restore: () => {
      restoreEnv(saved);
      try {
        cleanupTempDir(root);
      } catch {
        // A straggler fake killed by the production 2s stdin window can recreate calls.jsonl
        // while the dir is deleted; the orphan sits under os.tmpdir(), so leave it to the OS.
      }
      if (active === fixture) active = null;
    },
    setExitCodes: (codes) => {
      process.env[EXIT_CODES_ENV] = Object.entries(codes)
        .map(([file, code]) => `${file}=${code}`)
        .join(' ');
    },
  };

  active = fixture;
  return fixture;
}

export function readClipboardExecCalls(): ClipboardExecCall[] {
  return active?.calls() ?? [];
}

export function resetClipboardExecFixture(): void {
  active?.reset();
}

export function restoreClipboardExecFixture(): void {
  active?.restore();
}

export function setClipboardExitCodes(codes: Record<string, number>): void {
  active?.setExitCodes(codes);
}
