import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import {
  cacheIdentity,
  persistSnapshot,
} from '../../../src/engine/providers/models-dev-cache/store.js';
import { queueCopy } from '../../../src/features/workflow/queue-copy.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { buildSteeringCli, readSteeringLog as readLog } from '../helpers/steer-e2e-workflow.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const CORRECTION = 'API_IMAGE_CORRECTION_FOR_T001';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const WAIT = { timeout: 45_000, interval: 20 };
const PartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string() }) }),
]);
const RequestSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({ role: z.string(), content: z.union([z.string(), z.array(PartSchema)]) }),
  ),
});

beforeAll(buildSteeringCli, 120_000);

it.each([true, false])(
  'delivers a queued PNG through the built API BUILD seat with vision=%s',
  async (vision) => {
    const target = createStopContinueFixture(() => '', { isolation: 'none' });
    const home = useTrustHome('e2e-build-api-image-home');
    const model = vision ? 'fixture-vision' : 'fixture-text';
    const started = join(target.tmpDir, 'build-started');
    const corrected = join(target.tmpDir, 'build-corrected');
    const checks = join(target.tmpDir, 'checks.jsonl');
    const imagePath = join(realpathSync(target.tmpDir), 'reference.png');
    const requests: { method: string | undefined; path: string | undefined; body: unknown }[] = [];
    const release = Promise.withResolvers<void>();
    let buildCalls = 0;
    let serverFailure: unknown;
    let restorePath: (() => void) | undefined;
    const server = createServer((request, response) => {
      const serve = async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString('utf8');
        const body: unknown = text === '' ? undefined : JSON.parse(text);
        requests.push({ method: request.method, path: request.url, body });
        if (request.method === 'GET' && request.url === '/api/v1/models') {
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify({
              models: [
                {
                  key: model,
                  type: 'llm',
                  max_context_length: 200_000,
                  loaded_instances: [{ id: model, context_length: 200_000 }],
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
              data: [{ id: model, object: 'model', owned_by: 'fixture' }],
            }),
          );
          return;
        }
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
          throw new Error(`Unexpected API request: ${request.method} ${request.url}`);
        }
        const call = ++buildCalls;
        RequestSchema.parse(body);
        if (call === 1) {
          writeFileSync(started, '');
          await release.promise;
        } else {
          writeFileSync(corrected, '');
        }
        const reply = JSON.stringify({
          version: 1,
          files: [
            {
              path: MARKER_FILE,
              action: call === 1 ? 'create' : 'modify',
              content:
                call === 1
                  ? MARKER_SOURCE
                  : `${MARKER_SOURCE}export const IMAGE_CORRECTION = true;\n`,
            },
            { path: GREET_FILE, action: call === 1 ? 'create' : 'modify', content: GREET_SOURCE },
          ],
        });
        sendCompletion(response, model, reply);
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
      writeFileSync(imagePath, Buffer.from(PNG, 'base64'));
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
              [model]: {
                id: model,
                limit: { context: 200_000 },
                modalities: { input: vision ? ['text', 'image'] : ['text'], output: ['text'] },
              },
            },
          },
        },
      });
      mkdirSync(join(home.home, '.codex'), { recursive: true });
      writeFileSync(join(home.home, '.codex', 'auth.json'), '{"fixture":true}\n');
      const bin = join(target.tmpDir, 'bin');
      mkdirSync(bin);
      writeFakeNodeCli(
        bin,
        'codex',
        `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (!args.includes('exec') || !args.includes('read-only')) throw new Error('Unexpected planner invocation: ' + args.join(' '));
const prompt = fs.readFileSync(0, 'utf8');
const text = require('node:child_process').execFileSync(process.execPath, [${JSON.stringify(join(target.projectDir, 'tools', 'planner.mjs'))}], { input: prompt, encoding: 'utf8' });
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
`,
      );
      restorePath = activateSafeCliShimPath(bin);
      writeFileSync(
        join(target.projectDir, 'tools', 'check.mjs'),
        `
import { appendFileSync, existsSync } from 'node:fs';
const corrected = existsSync(${JSON.stringify(corrected)});
appendFileSync(${JSON.stringify(checks)}, JSON.stringify({ corrected }) + '\\n');
if (!corrected) throw new Error('Checks ran before the API BUILD correction pass');
`,
      );
      const config = loadConfig(target.projectDir).config;
      writeConfig(target.projectDir, {
        ...config,
        planner: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' },
        implementer: {
          kind: 'api',
          provider: 'lm-studio',
          service: 'lm-studio',
          offering: 'local',
          apiBase,
          model,
          contextLength: 200_000,
        },
        validation: { ...config.validation, testCommand: 'node ./tools/check.mjs' },
        workflow: { ...config.workflow, git: { createBranch: false } },
      });
      await trustDeclaredRunners({
        projectDir: target.projectDir,
        config: loadConfig(target.projectDir).config,
      });
      const tools = await detectAvailableCliTools({
        projectDir: target.projectDir,
        tools: ['codex'],
        authChannels: { codex: 'session' },
        role: 'planner',
      });
      expect(tools[0]?.diagnostic.state).toBe('ready');
      await rememberDetectedTools(target.projectDir, tools);
      const offline = join(target.tmpDir, 'offline.mjs');
      writeFileSync(
        offline,
        `const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return nativeFetch(input, options);
  throw new Error('Network disabled in API image E2E');
};\n`,
      );
      await runWithPtyChild(
        {
          requirement: 'required',
          argv: [
            '--import',
            offline,
            'dist/cli.js',
            'start',
            'smoke',
            '--allow-repo-runners',
            '--project',
            target.projectDir,
          ],
          spawnOptions: {
            name: 'xterm-256color',
            cols: 120,
            rows: 35,
            cwd: REPO_ROOT,
            env: { ...safeChildEnvironment(home.home, [bin]), XDG_STATE_HOME: target.stateHome },
          },
        },
        async (child) => {
          const exit = Promise.withResolvers<PtyExitEvent>();
          let outcome: PtyExitEvent | undefined;
          let terminal = '';
          const exitListener = child.onExit((event) => {
            outcome = event;
            exit.resolve(event);
          });
          const dataListener = child.onData((data) => {
            terminal += data;
          });
          try {
            await expect
              .poll(() => existsSync(started), { ...WAIT, message: 'API BUILD never started' })
              .toBe(true);
            const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
            if (sessionId === undefined) throw new Error('API BUILD started without a run session');
            await expect.poll(() => terminal, WAIT).toContain('Message BUILD on T001');
            child.write(`${CORRECTION} @${imagePath}`);
            await expect.poll(() => terminal, WAIT).toContain('reference.png');
            child.write('\r');
            await expect
              .poll(
                () =>
                  readLog(target.projectDir, sessionId).some(
                    (entry) => entry.kind === 'event' && entry.type === 'message_queued',
                  ),
                WAIT,
              )
              .toBe(true);
            expect(existsSync(checks)).toBe(false);
            release.resolve();
            await expect
              .poll(
                () =>
                  readLog(target.projectDir, sessionId).some(
                    (entry) => entry.kind === 'event' && entry.type === 'workflow_complete',
                  ),
                { ...WAIT, message: 'API image workflow did not complete' },
              )
              .toBe(true);
            expect(serverFailure).toBeUndefined();
            const log = readLog(target.projectDir, sessionId);
            const calls = requests
              .filter((request) => request.path === '/v1/chat/completions')
              .map((request) => RequestSchema.parse(request.body));
            expect(calls).toHaveLength(2);
            const [first, correction] = calls;
            if (first === undefined || correction === undefined)
              throw new Error('Missing API BUILD calls');
            expect(calls.every((call) => call.model === model)).toBe(true);
            expect(imageParts(first)).toEqual([]);
            expect(promptText(first)).not.toContain(CORRECTION);
            expect(promptText(correction)).toContain(CORRECTION);
            const last = correction.messages.at(-1);
            expect(last?.role).toBe('user');
            const state = loadState({ projectDir: target.projectDir, sessionId });
            const image = state?.messageQueue[0]?.images[0];
            if (image === undefined) throw new Error('Queued image was not persisted');
            const pathLine = `[image:${image.id}] = ${imagePath}`;
            expect(promptText(correction)).toContain(pathLine);
            const lastText =
              typeof last?.content === 'string'
                ? last.content
                : last?.content
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join('\n');
            expect(lastText).toContain(CORRECTION);
            expect(lastText).toContain(pathLine);
            expect(state?.phase).toBe('complete');
            expect(state?.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
            expect(state?.lineages?.T001?.correctionImages).toEqual([image]);
            expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
            expect(readFileSync(target.markerPath, 'utf8')).toContain('IMAGE_CORRECTION');
            const pathEvents = log.filter(
              (entry) => entry.kind === 'event' && entry.type === 'build_images_as_paths',
            );
            if (vision) {
              expect(imageParts(correction)).toEqual([
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/png;base64,${readFileSync(imagePath).toString('base64')}`,
                  },
                },
              ]);
              expect(
                Array.isArray(last?.content)
                  ? last.content.filter((part) => part.type === 'image_url')
                  : [],
              ).toEqual(imageParts(correction));
              expect(pathEvents).toEqual([]);
            } else {
              expect(calls.flatMap(imageParts)).toEqual([]);
              expect(pathEvents).toMatchObject([{ taskId: 'T001', data: { count: 1 } }]);
              const copy = queueCopy({ seat: 'build', taskId: 'T001', count: 1 }).imagesAsPaths;
              await expect.poll(() => terminal, WAIT).toContain(copy.value);
              expect(terminal).toContain(copy.label);
            }
            expect(
              log.filter((entry) => entry.kind === 'event' && entry.type === 'queue_drained'),
            ).toHaveLength(1);
            const checkCalls = readFileSync(checks, 'utf8')
              .trim()
              .split('\n')
              .map((line) => z.object({ corrected: z.boolean() }).parse(JSON.parse(line)));
            expect(checkCalls).toHaveLength(2);
            expect(checkCalls.every((call) => call.corrected)).toBe(true);
            child.write('\x11');
            await expect
              .poll(() => outcome, { ...WAIT, message: 'API image CLI did not quit' })
              .toBeDefined();
            expect(outcome?.exitCode, terminal).toBe(0);
          } catch (cause) {
            throw new Error(
              `API image E2E failed; CLI exit: ${outcome?.exitCode}; server: ${String(serverFailure)}\n${terminal}`,
              { cause },
            );
          } finally {
            release.resolve();
            try {
              if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
              await reapOrphanRunners(target.projectDir);
            } finally {
              dataListener.dispose();
              exitListener.dispose();
            }
          }
        },
      );
    } finally {
      release.resolve();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      restorePath?.();
      home.restore();
      cleanupTempDir(target.tmpDir);
    }
  },
);

function imageParts(request: z.infer<typeof RequestSchema>) {
  return request.messages.flatMap((message) =>
    typeof message.content === 'string'
      ? []
      : message.content.filter((part) => part.type === 'image_url'),
  );
}

function promptText(request: z.infer<typeof RequestSchema>) {
  return request.messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n'),
    )
    .join('\n');
}

function sendCompletion(response: ServerResponse, model: string, text: string) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const frame = { id: 'fixture-build', object: 'chat.completion.chunk', created: 1, model };
  response.write(
    `data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}
