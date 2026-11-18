import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { trustedShimGate, writeFakeCli } from '#testing/helpers/command-shim.js';
import { CURSOR_REFUSAL_CHUNKS } from '#testing/helpers/cursor-refusal.js';
import { expireDeadlineAfterFile } from '#testing/helpers/fake-timers.js';
import { killOrphanRunner } from '#testing/helpers/orphan-runner.js';
import { promptCliScript } from '#testing/helpers/prompt-cli-script.js';
import { makeFifo, stderrHandshake, writeStderr } from '#testing/helpers/stderr-handshake.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { groupExists, SIGKILL_DELAY_MS } from '../../../../lib/process/termination.js';
import { shellQuoteArg } from '../../../../utils/shell-quote.js';
import { createSteeringPort } from '../../../calls/steering.js';
import { claudeCodeImplementerAdapter } from '../claude-code/adapter.js';
import type { CliImplementerAdapter } from '../contract.js';
import { cursorImplementerAdapter } from '../cursor/adapter.js';
import { opencodeImplementerAdapter } from '../opencode/adapter.js';
import { invokeProcessCli } from './invoke.js';
import type { InvokeProcessCliContext } from './types.js';

function invoke(
  dir: string,
  body: string,
  options: Pick<
    InvokeProcessCliContext,
    'onEvent' | 'onSpawned' | 'steering' | 'installedVersion'
  > & {
    unreadPrompt?: string;
    adapter?: CliImplementerAdapter;
    environment?: Record<string, string>;
  } = {},
) {
  const adapter = options.adapter ?? cursorImplementerAdapter;
  writeFakeCli(
    dir,
    adapter.descriptor.command,
    options.unreadPrompt === undefined ? promptCliScript({ body }) : body,
  );
  const { executable } = trustedShimGate({ dir, tool: adapter.descriptor.id });
  return invokeProcessCli(adapter, {
    invocation: {
      executable,
      args: [],
      cwd: dir,
      environment: options.environment ?? {},
      promptTransport: { kind: 'stdin' },
      signal: undefined,
    },
    prompt: options.unreadPrompt ?? 'Build the brief.',
    callContext: {
      callId: 'cursor-refusal',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: adapter.descriptor.displayName,
    },
    onEvent: options.onEvent,
    onSpawned: options.onSpawned,
    steering: options.steering,
    installedVersion: options.installedVersion,
  });
}

const cursorRefusal = CURSOR_REFUSAL_CHUNKS.join('').trim();
const phraseSplit = cursorRefusal.indexOf('weekly usage') + 'weekly us'.length;
const cutCursorRefusal = [
  cursorRefusal.slice(0, phraseSplit),
  cursorRefusal.slice(phraseSplit, cursorRefusal.indexOf('\n') + 1),
  cursorRefusal.slice(cursorRefusal.indexOf('\n') + 1),
];

it.each([
  ['cursor-between-sentences', CURSOR_REFUSAL_CHUNKS, 'usage-limit'],
  [
    'sign-in',
    ['Your session ended. Please sign in.\n', 'Open the desktop app to reconnect.\n'],
    'unauthenticated',
  ],
  ['cursor-inside-phrase', cutCursorRefusal, 'usage-limit'],
] as const)('quotes the full refusal on natural exit 1 (%s)', async (_name, chunks, code) => {
  await withTempDir('cursor-refusal-chunks', async (dir) => {
    const handshake = stderrHandshake(dir, chunks);
    try {
      const result = await invoke(dir, `${handshake.body}\nexit 1`, handshake);
      expect(result.error).toMatchObject({ code, message: chunks.join('').trim() });
    } finally {
      handshake.close();
    }
  });
});

it('quotes the refusal when a text-exit tool exits 0 without a result', async () => {
  await withTempDir('opencode-refusal-exit-zero', async (dir) => {
    const chunks = ['Error: Out of credits.\n', 'Add credits in your provider console.\n'];
    const handshake = stderrHandshake(dir, chunks);
    try {
      const result = await invoke(dir, `${handshake.body}\nexit 0`, {
        adapter: opencodeImplementerAdapter,
        onEvent: handshake.onEvent,
      });
      expect(result.error).toMatchObject({ code: 'usage-limit', message: chunks.join('').trim() });
    } finally {
      handshake.close();
    }
  });
});

it('quotes the live refusal through SIGTERM and reaps the group', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await withTempDir('cursor-live-refusal', async (dir) => {
      const ready = join(dir, 'ready');
      const hold = makeFifo(join(dir, 'hold'));
      const handshake = stderrHandshake(dir, CURSOR_REFUSAL_CHUNKS);
      const finalLine = 'The connection has been closed.';
      const trap = ['wait "$holder" 2>/dev/null', writeStderr(`${finalLine}\n`), 'exit 1'].join(
        '\n',
      );
      const body = [
        `/bin/cat ${shellQuoteArg(hold)} </dev/null >/dev/null &`,
        'holder=$!',
        `trap ${shellQuoteArg(trap)} TERM`,
        handshake.body,
        `printf '%s\\n' "$holder" > ${shellQuoteArg(ready)}`,
        'wait "$holder"',
      ].join('\n');
      let pid: number | undefined;
      try {
        const pending = invoke(dir, body, {
          onEvent: handshake.onEvent,
          onSpawned: (child) => {
            pid = child.pid;
          },
        });
        await expireDeadlineAfterFile(ready, pending);
        const result = await pending;
        expect(result.error).toMatchObject({
          code: 'usage-limit',
          message: `${cursorRefusal}\n${finalLine}`,
        });
        if (pid === undefined) throw new Error('The fixture did not spawn a process group');
        expect(groupExists(pid)).toBe(false);
        const holder = Number(readFileSync(ready, 'utf8'));
        expect(() => process.kill(holder, 0)).toThrow(/ESRCH/);
      } finally {
        handshake.close();
      }
    });
  } finally {
    vi.useRealTimers();
  }
});

it('quotes the whole refusal during the stdin-incomplete drain', async () => {
  await withTempDir('cursor-unread-prompt', async (dir) => {
    const hold = makeFifo(join(dir, 'hold'));
    const handshake = stderrHandshake(dir, CURSOR_REFUSAL_CHUNKS);
    const trap = ['wait "$holder" 2>/dev/null', handshake.body, 'exit 1'].join('\n');
    const body = [
      `/bin/cat ${shellQuoteArg(hold)} </dev/null >/dev/null &`,
      'holder=$!',
      `trap ${shellQuoteArg(trap)} TERM`,
      'exec 0<&-',
      'wait "$holder"',
    ].join('\n');
    try {
      const result = await invoke(dir, body, {
        unreadPrompt: 'x'.repeat(2 * 1024 * 1024),
        onEvent: handshake.onEvent,
      });
      expect(result.error).toMatchObject({ code: 'usage-limit', message: cursorRefusal });
    } finally {
      handshake.close();
    }
  });
});

it('quotes the refusal when a detached descendant holds stderr open', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await withTempDir('cursor-held-stderr', async (dir) => {
      const hold = makeFifo(join(dir, 'hold'));
      const pidFile = join(dir, 'holder');
      const startHolder = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const holder = spawn('/bin/cat', [${JSON.stringify(hold)}], {
  detached: true,
  stdio: ['ignore', 'ignore', 'inherit'],
});
holder.unref();
writeFileSync(${JSON.stringify(pidFile)}, String(holder.pid));
`;
      const handshake = stderrHandshake(dir, CURSOR_REFUSAL_CHUNKS);
      const exited = Promise.withResolvers<void>();
      const body = [
        `${shellQuoteArg(process.execPath)} -e ${shellQuoteArg(startHolder)}`,
        handshake.body,
        'exit 1',
      ].join('\n');
      try {
        const pending = invoke(dir, body, {
          onEvent: handshake.onEvent,
          onSpawned: (child) => child.once('exit', () => exited.resolve()),
        });
        await exited.promise;
        await vi.advanceTimersByTimeAsync(2 * SIGKILL_DELAY_MS);
        const result = await pending;
        expect(result.error).toMatchObject({ code: 'usage-limit', message: cursorRefusal });
      } finally {
        handshake.close();
        killOrphanRunner(Number(readFileSync(pidFile, 'utf8')));
      }
    });
  } finally {
    vi.useRealTimers();
  }
});

it('quotes only the matched line for a fixed signature', async () => {
  await withTempDir('cursor-fixed-signature', async (dir) => {
    const stderr = 'Error: not logged in\nOpen settings to check your account.\n';
    const result = await invoke(dir, [writeStderr(stderr), 'exit 1'].join('\n'));
    expect(result.error).toMatchObject({
      code: 'unauthenticated',
      message: 'Error: not logged in',
    });
  });
});

it('keeps the words of a failed terminal that names its own halt', async () => {
  await withTempDir('cursor-failed-terminal', async (dir) => {
    const message = 'Not logged in. Run cursor-agent login.';
    const terminal = JSON.stringify({ type: 'result', subtype: 'error', result: message });
    const result = await invoke(
      dir,
      [
        `printf '%s\\n' ${shellQuoteArg(terminal)}`,
        writeStderr('Error: model not found\n'),
        'exit 1',
      ].join('\n'),
    );
    expect(result.error?.message).toBe(message);
  });
});

it('keeps a successful terminal with exit 0', async () => {
  await withTempDir('cursor-success-terminal', async (dir) => {
    const result = await invoke(
      dir,
      [
        `printf '%s\\n' '{"type":"result","subtype":"success"}'`,
        writeStderr('Error: model not found\n'),
        'exit 0',
      ].join('\n'),
    );
    expect(result.status).toBe('completed');
  });
});

const fixedSignIn = 'Error: not logged in';
const paddedPrefix = 'x'.repeat(40_000);
const diagnostic = `HTTP 401 Unauthorized\n${'  at input.js:3\n'.repeat(61)}Please sign in again in Settings.`;

for (const { name, prefix, lastWrite, expected } of [
  {
    name: 'A detects a refusal before eviction',
    prefix: `${paddedPrefix}\n`,
    lastWrite: `${fixedSignIn}\n${'z'.repeat(45_000)}`,
    expected: fixedSignIn,
  },
  {
    name: 'A preserves the fixed signature line',
    prefix: `${paddedPrefix}\n${fixedSignIn}\n`,
    lastWrite: 'z'.repeat(40_000),
    expected: fixedSignIn,
  },
  {
    name: 'B classifies the whole diagnostic on one write',
    prefix: '',
    lastWrite: `${diagnostic}\n`,
    expected: diagnostic,
  },
])
  it(name, async () => {
    await withTempDir('cursor-final-sign-in', async (dir) => {
      const handshake = stderrHandshake(dir, prefix === '' ? [] : [prefix, '']);
      const write = `require('node:fs').writeSync(2, ${JSON.stringify(lastWrite)}); process.exitCode = 1;`;
      try {
        const result = await invoke(
          dir,
          `${handshake.body}\nexec ${shellQuoteArg(process.execPath)} -e ${shellQuoteArg(write)}`,
          handshake,
        );
        expect(result.error).toMatchObject({ code: 'unauthenticated', message: expected });
      } finally {
        handshake.close();
      }
    });
  });

it.each([56, 57])('keeps the sign-in classification window with %i stack lines', async (frames) => {
  const signature = 'HTTP 401 Unauthorized';
  const message = `${signature}\n${'  at input.js:3\n'.repeat(frames)}Please sign in again in Settings.`;
  const write = `require('node:fs').writeSync(2, ${JSON.stringify(`${message}\n`)})`;
  const emit = `${shellQuoteArg(process.execPath)} -e ${shellQuoteArg(write)}`;

  await withTempDir('cursor-sign-in-with-prompt', async (dir) => {
    const result = await invoke(dir, `${emit}\nexit 1`);
    expect(result.error).toMatchObject({ code: 'unauthenticated', message: signature });
  });

  await withTempDir('cursor-sign-in-unread-prompt', async (dir) => {
    const hold = makeFifo(join(dir, 'hold'));
    const trap = ['wait "$holder" 2>/dev/null', emit, 'exit 1'].join('\n');
    const body = [
      '#!/bin/sh',
      `/bin/cat ${shellQuoteArg(hold)} </dev/null >/dev/null &`,
      'holder=$!',
      `trap ${shellQuoteArg(trap)} TERM`,
      'exec 0<&-',
      'wait "$holder"',
    ].join('\n');
    const result = await invoke(dir, body, { unreadPrompt: 'x'.repeat(2 * 1024 * 1024) });
    expect(result.error).toMatchObject({ code: 'unauthenticated', message });
  });
});

it('A keeps a credential fragment out of the refusal', async () => {
  await withTempDir('cursor-refusal-credential', async (dir) => {
    const credential = 'fixture-only-fictional-credential-example';
    const suffix = 'tional-credential-example';
    const oldTailBytes = Math.ceil((65_536 - '\n[... output truncated ...]\n'.length) / 2);
    const handshake = stderrHandshake(dir, [
      `${' '.repeat(40_000)}\n${fixedSignIn}\n`,
      `${credential}${' '.repeat(oldTailBytes - suffix.length)}`,
    ]);
    try {
      const result = await invoke(dir, `${handshake.body}\nexit 1`, {
        environment: { CURSOR_API_KEY: credential },
        onEvent: handshake.onEvent,
      });
      expect(result.error?.message).not.toContain(suffix);
      expect(result.error).toMatchObject({ code: 'unauthenticated', message: fixedSignIn });
    } finally {
      handshake.close();
    }
  });
});

it('A preserves the stdin transport diagnostic', async () => {
  await withTempDir('cursor-padded-stdin', async (dir) => {
    const note = 'server closed its input pipe';
    const hold = makeFifo(join(dir, 'hold'));
    const trap = [
      'wait "$holder" 2>/dev/null',
      writeStderr(`${' '.repeat(40_000)}${note}${' '.repeat(40_000)}`),
      'exit 0',
    ].join('\n');
    const body = [
      '#!/bin/sh',
      `/bin/cat ${shellQuoteArg(hold)} </dev/null >/dev/null &`,
      'holder=$!',
      `trap ${shellQuoteArg(trap)} TERM`,
      'exec 0<&-',
      'wait "$holder"',
    ].join('\n');
    const result = await invoke(dir, body, { unreadPrompt: 'p'.repeat(2 * 1024 * 1024) });
    expect(result.error).toMatchObject({
      code: 'prompt-transport-error',
      message: expect.stringContaining(note),
    });
  });
});

const earlyRefusal = 'Error: Out of credits.';
const shutdownInstruction = 'Buy more credits from settings.';
const terminalSignIn = 'Not logged in. Run cursor-agent login.';

for (const { name, subtype, message, expected } of [
  {
    name: 'C drains the SIGTERM instruction after a generic failed terminal',
    subtype: 'error',
    message: 'Request failed.',
    expected: `${earlyRefusal}\n${shutdownInstruction}`,
  },
  {
    name: 'C uses exit 73 after a successful terminal',
    subtype: 'success',
    message: terminalSignIn,
    expected: `${earlyRefusal}\n${shutdownInstruction}`,
  },
  {
    name: 'D keeps the halt from a failed terminal after stderr',
    subtype: 'error',
    message: terminalSignIn,
    expected: terminalSignIn,
  },
])
  it(name, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await withTempDir('cursor-terminal-drain', async (dir) => {
        const namesHalt = subtype === 'error' && message === terminalSignIn;
        const terminal = JSON.stringify({ type: 'result', subtype, result: message });
        const parsed = Promise.withResolvers<void>();
        const exited = Promise.withResolvers<number | null>();
        const handshake = stderrHandshake(dir, [`${earlyRefusal}\n`, '']);
        const hold = makeFifo(join(dir, 'hold'));
        const trap = [
          'wait "$holder" 2>/dev/null',
          writeStderr(`${shutdownInstruction}\n`),
          'exit 73',
        ].join('\n');
        const body = [
          `/bin/cat ${shellQuoteArg(hold)} </dev/null >/dev/null &`,
          'holder=$!',
          ...(namesHalt ? [] : [`trap ${shellQuoteArg(trap)} TERM`]),
          handshake.body,
          `printf '%s\\n' ${shellQuoteArg(terminal)}`,
          'wait "$holder"',
        ].join('\n');
        try {
          const pending = invoke(dir, body, {
            adapter: {
              ...cursorImplementerAdapter,
              parse: (line) => {
                if (namesHalt) vi.advanceTimersByTime(100);
                parsed.resolve();
                return cursorImplementerAdapter.parse(line);
              },
            },
            onEvent: handshake.onEvent,
            onSpawned: (child) => child.once('exit', exited.resolve),
          });
          const sawTerminal = await Promise.race([
            parsed.promise.then(() => true),
            pending.then(() => false),
          ]);
          expect(sawTerminal).toBe(true);
          vi.advanceTimersByTime(namesHalt ? SIGKILL_DELAY_MS - 100 : SIGKILL_DELAY_MS);
          const result = await pending;
          expect(await exited.promise).toBe(namesHalt ? null : 73);
          expect(result.status).toBe('failed');
          expect(result.error?.message).toBe(expected);
        } finally {
          handshake.close();
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });

it('C lets a steered tool close after its terminal while the clock is held', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await withTempDir('claude-steered-refusal', async (dir) => {
      const terminal = JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Request failed.',
        session_id: 's',
      });
      const handshake = stderrHandshake(dir, [`${earlyRefusal}\n`, '']);
      const trap = [writeStderr(`${shutdownInstruction}\n`), 'exit 73'].join('\n');
      const body = [
        '#!/bin/sh',
        'IFS= read -r prompt',
        `trap ${shellQuoteArg(trap)} TERM`,
        handshake.body,
        `printf '%s\\n' ${shellQuoteArg(terminal)}`,
        'IFS= read -r extra',
        writeStderr(`${shutdownInstruction}\n`),
        'exit 1',
      ].join('\n');
      const exited = Promise.withResolvers<number | null>();
      try {
        const result = await invoke(dir, body, {
          adapter: claudeCodeImplementerAdapter,
          steering: createSteeringPort(),
          installedVersion: '2.1.296',
          unreadPrompt: 'Build the brief.',
          onEvent: handshake.onEvent,
          onSpawned: (child) => child.once('exit', exited.resolve),
        });
        expect(result.error).toMatchObject({
          code: 'usage-limit',
          message: `${earlyRefusal}\n${shutdownInstruction}`,
        });
        expect(await exited.promise).toBe(1);
      } finally {
        handshake.close();
      }
    });
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ['init', { type: 'system', subtype: 'init', session_id: 's' }, 1],
  [
    'a second success',
    { type: 'result', subtype: 'success', result: 'Background task finished.' },
    0,
  ],
] as const)('keeps a failed steered result followed by %s', async (_name, next, exitCode) => {
  await withTempDir('claude-steered-trailing-frame', async (dir) => {
    const first = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Request failed.',
      session_id: 's',
    };
    const handshake = stderrHandshake(dir, [`${earlyRefusal}\n`, '']);
    const body = [
      '#!/bin/sh',
      'IFS= read -r prompt',
      handshake.body,
      `printf '%s\\n' ${shellQuoteArg(JSON.stringify(first))} ${shellQuoteArg(JSON.stringify(next))}`,
      `exit ${exitCode}`,
    ].join('\n');
    try {
      const result = await invoke(dir, body, {
        adapter: claudeCodeImplementerAdapter,
        steering: createSteeringPort(),
        installedVersion: '2.1.296',
        unreadPrompt: 'Build the brief.',
        onEvent: handshake.onEvent,
      });
      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'usage-limit', message: earlyRefusal },
      });
    } finally {
      handshake.close();
    }
  });
});
