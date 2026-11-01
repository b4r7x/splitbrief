import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import {
  cacheIdentity,
  persistSnapshot,
} from '../../../src/engine/providers/models-dev-cache/store.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';

const MODEL = 'fixture-review';
const WAIT = { timeout: 60_000, interval: 25 };

function sendCompletion(response: ServerResponse, text: string) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const frame = { id: 'fixture-review', object: 'chat.completion.chunk', created: 1, model: MODEL };
  response.write(
    `data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}

it('shows reviewing changes, not answering again, after a stop cut a refused reviewer answer before its repair', async () => {
  const target = createStopContinueFixture(
    () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`,
    { isolation: 'none' },
  );
  const home = useTrustHome('review-refusal-stop');
  const verdict = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
  const log: string[] = [];
  let completions = 0;
  let refusalServed = false;
  let firstHeld = false;
  let probeHeld = false;
  let thirdHeld = false;
  const releaseThird = Promise.withResolvers<void>();
  let serverFailure: unknown;
  const server = createServer((request, response) => {
    const closed = new Promise<void>((resolveClosed) =>
      response.once('close', () => resolveClosed()),
    );
    const serve = async () => {
      for await (const chunk of request) void chunk;
      log.push(`${request.method} ${request.url}`);
      if (request.method === 'GET' && request.url === '/api/v1/models') {
        if (refusalServed && !probeHeld) {
          probeHeld = true;
          await closed;
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            models: [
              {
                key: MODEL,
                type: 'llm',
                max_context_length: 200_000,
                loaded_instances: [{ id: MODEL, context_length: 200_000 }],
              },
            ],
          }),
        );
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: MODEL, object: 'model', owned_by: 'fixture' }],
          }),
        );
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        throw new Error(`Unexpected API request: ${request.method} ${request.url}`);
      }
      const call = ++completions;
      if (call === 1) {
        firstHeld = true;
        await closed;
        return;
      }
      if (call === 2) {
        refusalServed = true;
        sendCompletion(response, '{"bogus":true}');
        return;
      }
      thirdHeld = true;
      await Promise.race([releaseThird.promise, closed]);
      sendCompletion(response, JSON.stringify(verdict));
    };
    void serve().catch((cause: unknown) => {
      serverFailure = cause;
      response.statusCode = 500;
      response.end(String(cause));
    });
  });
  try {
    await new Promise<void>((resolveListening, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListening);
    });
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('API server has no TCP address');
    const apiBase = `http://127.0.0.1:${address.port}/v1`;
    const identity = cacheIdentity({ cacheDir: join(home.home, '.splitbrief', 'cache') });
    await persistSnapshot(identity, {
      sourceUrl: identity.sourceUrl,
      parserVersion: identity.parserVersion,
      catalogState: 'populated',
      fetchedAt: Date.now(),
      validatedAt: Date.now(),
      catalog: {
        lmstudio: {
          id: 'lmstudio',
          models: {
            [MODEL]: {
              id: MODEL,
              limit: { context: 200_000 },
              modalities: { input: ['text'], output: ['text'] },
            },
          },
        },
      },
    });
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      reviewer: {
        kind: 'api',
        provider: 'lm-studio',
        service: 'lm-studio',
        offering: 'local',
        apiBase,
        model: MODEL,
        contextLength: 200_000,
      },
    });
    const env: Readonly<Record<string, string>> = {
      ...safeChildEnvironment(home.home),
      XDG_STATE_HOME: target.stateHome,
    };
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
      pathEnv: env.PATH ?? '',
    });
    const offline = join(target.tmpDir, 'offline.mjs');
    mkdirSync(target.tmpDir, { recursive: true });
    writeFileSync(
      offline,
      `const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return nativeFetch(input, options);
  throw new Error('Network disabled in review refusal E2E');
};\n`,
    );
    await runWithPtyChild(
      {
        requirement: 'required',
        argv: [
          '--import',
          'tsx',
          '--import',
          offline,
          'src/cli.ts',
          'start',
          'smoke',
          '--allow-repo-runners',
          '--project',
          target.projectDir,
        ],
        spawnOptions: {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: resolve(import.meta.dirname, '../../..'),
          env,
        },
      },
      async (child) => {
        const exit = Promise.withResolvers<PtyExitEvent>();
        let outcome: PtyExitEvent | undefined;
        const terminal = new XtermHeadless.Terminal({
          cols: 120,
          rows: 40,
          allowProposedApi: true,
          convertEol: true,
          scrollback: 0,
          logLevel: 'off',
        });
        const screen = () =>
          Array.from(
            { length: 40 },
            (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
          ).join('\n');
        let answeringAgainFrame: string | undefined;
        let stoppingBriefFrame: string | undefined;
        const dataListener = child.onData((data) =>
          terminal.write(data, () => {
            if (screen().includes('answering again')) answeringAgainFrame = screen();
            if (/Stopping T\d/.test(screen())) stoppingBriefFrame = screen();
          }),
        );
        const exitListener = child.onExit((event) => {
          outcome = event;
          exit.resolve(event);
        });
        const stopAndResume = async () => {
          child.write('\x1b');
          await expect.poll(screen, WAIT).toContain('Stop options');
          child.write('\x1b');
          await expect.poll(screen, WAIT).toContain('Back to sessions');
          child.write('\r');
        };
        try {
          await expect
            .poll(() => firstHeld, { ...WAIT, message: `no first review call\n${log.join('\n')}` })
            .toBe(true);
          await stopAndResume();
          await expect
            .poll(() => probeHeld, { ...WAIT, message: `no repair probe\n${log.join('\n')}` })
            .toBe(true);
          await stopAndResume();
          await expect
            .poll(() => thirdHeld, { ...WAIT, message: `no third review call\n${log.join('\n')}` })
            .toBe(true);
          // The byline paints last and only a running call waits for its response, so this one
          // sample is a whole frame of the third call. The row before the call also names the seat.
          let frame = '';
          await expect
            .poll(
              () => {
                frame = screen();
                return frame;
              },
              { timeout: 10_000 },
            )
            .toContain('Waiting for response');
          expect(frame).toContain('Review · LM Studio · Fixture Review · reviewing changes');
          expect(frame).not.toContain('answering again');
          expect(frame.match(/seat answer did not match its contract/g)).toHaveLength(1);
          expect(frame).toContain('The reviewer seat answer did not match its contract.');
          expect(frame).toContain('Wrong or missing value in tasks, criteria, findings, fixTasks,');
          expect(frame).toContain('Asking the seat again.');
          releaseThird.resolve();
          await expect.poll(screen, WAIT).toContain('Complete · 1/1 briefs passed');
          child.write('\x11');
          await expect.poll(() => outcome, { timeout: 10_000 }).toBeDefined();
          expect(outcome?.exitCode, screen()).toBe(0);
          expect(answeringAgainFrame).toBeUndefined();
          expect(stoppingBriefFrame).toBeUndefined();
        } finally {
          releaseThird.resolve();
          if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
          await reapOrphanRunners(target.projectDir);
          dataListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      },
    );
    expect(serverFailure).toBeUndefined();
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('CLI started without a run');
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(
      events.filter((event) => event.type === 'warning' && event.code === 'seat_answer_refused'),
    ).toMatchObject([{ category: 'reviewer' }]);
    expect(events.filter((event) => event.type === 'turn_interrupted')).toHaveLength(2);
    expect(
      events.filter((event) => event.type === 'runner_call_started' && event.role === 'review'),
    ).toHaveLength(3);
  } finally {
    server.close();
    home.restore();
    cleanupTempDir(target.tmpDir);
  }
});
