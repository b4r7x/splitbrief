import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupScreen } from '../../../src/app/screens/setup.js';
import { configPath } from '../../../src/core/config/load/document.js';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { toYaml } from '../../../src/core/config/load/transform.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createProductionDetectionDeps } from '../../../src/engine/detection/deps.js';
import { glyph } from '../../../src/lib/glyphs.js';
import { configStore } from '../../../src/stores/project/config.js';
import { detectionStore } from '../../../src/stores/project/detection.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;
let home: ReturnType<typeof createTrustHome> | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  restorePath?.();
  home?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
});

function freshProject() {
  fixture = createStopContinueFixture(() => '');
  unlinkSync(configPath(fixture.projectDir));
  home = createTrustHome('e2e-no-config-home');
  const bin = join(fixture.tmpDir, 'bin');
  mkdirSync(bin);
  restorePath = activateSafeCliShimPath(bin);
  const offline = join(fixture.tmpDir, 'offline.mjs');
  writeFileSync(
    offline,
    "globalThis.fetch = async () => { throw new Error('Network disabled in no-config E2E'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offline}`);
  vi.stubEnv('XDG_CONFIG_HOME', join(home.home, 'config'));
  vi.stubEnv('XDG_DATA_HOME', join(home.home, 'data'));
  return { target: fixture, bin, home: home.home, calls: join(fixture.tmpDir, 'calls.jsonl') };
}

function readyClaude(bin: string, calls: string, hostHome: string) {
  mkdirSync(join(hostHome, '.claude'), { recursive: true });
  writeFileSync(join(hostHome, '.claude', '.credentials.json'), '{"fixture":true}\n');
  const plan = {
    result: makePlanProposal({
      tasks: [
        makeTaskSpec({
          suggestedFiles: ['src/greet.mjs'],
          checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
          steps: ['Write src/greet.mjs.'],
        }),
      ],
    }),
  };
  const review = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
  writeFakeNodeCli(
    bin,
    'claude',
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('claude ${CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion}'); process.exit(0); }
if (args.includes('--help')) { console.log('Claude Code fixture'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const emit = value => console.log(JSON.stringify(value));
const answer = text => {
  const seat = text.includes('Choose the checks for this review') ? 'checks' : text.includes('Final Implementation Review') ? 'review' : text.startsWith('# Plan the change') ? 'plan' : 'build';
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ seat, args }) + '\\n');
  if (seat === 'build') { fs.mkdirSync('src', { recursive: true }); fs.writeFileSync('src/greet.mjs', "export const greet = () => 'hello';\\n"); }
  const value = seat === 'plan' ? ${JSON.stringify(plan)} : seat === 'review' ? ${JSON.stringify(review)} : seat === 'checks' ? { commands: [], declined: [], reason: 'The plan check covers this change.' } : 'Done.';
  emit({ type: 'system', subtype: 'init', session_id: 'first-run-ready' });
  emit({ type: 'result', session_id: 'first-run-ready', result: typeof value === 'string' ? value : JSON.stringify(value), ...(typeof value === 'string' ? {} : { structured_output: value }), usage: { input_tokens: 10, output_tokens: 5 } });
};
if (args.includes('--input-format')) {
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.once('line', line => { const content = JSON.parse(line).message.content; answer(typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\\n')); lines.close(); process.stdin.destroy(); });
} else answer(fs.readFileSync(0, 'utf8'));
`,
  );
}

function readyCodex(bin: string, calls: string, hostHome: string) {
  mkdirSync(join(hostHome, '.codex'), { recursive: true });
  writeFileSync(join(hostHome, '.codex', 'auth.json'), '{"fixture":true}\n');
  const plan = {
    result: makePlanProposal({
      tasks: [
        makeTaskSpec({
          suggestedFiles: ['src/greet.mjs'],
          checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
          steps: ['Write src/greet.mjs.'],
        }),
      ],
    }),
  };
  const review = passingVerdict({ kind: 'final', taskIds: [], criterionIds: [] });
  writeFakeNodeCli(
    bin,
    'codex',
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}'); process.exit(0); }
if (args.includes('--help')) { console.log('Codex fixture'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
const seat = prompt.includes('Final Implementation Review') ? 'review' : 'plan';
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ seat, args }) + '\\n');
const value = seat === 'review' ? ${JSON.stringify(review)} : ${JSON.stringify(plan)};
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
`,
  );
}

describe('e2e: headless start without config', () => {
  it.each([false, true])(
    'starts and saves explicit shell seats with no detected tools, json=%s',
    async (json) => {
      const { target } = freshProject();
      const planner = join(target.projectDir, 'tools', 'planner.mjs');
      const implementer = join(target.projectDir, 'tools', 'implementer.mjs');
      const plan = {
        result: makePlanProposal({
          tasks: [
            makeTaskSpec({
              suggestedFiles: ['src/greet.mjs'],
              checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
              steps: ['Write src/greet.mjs.'],
            }),
          ],
        }),
      };
      const review = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
      writeFileSync(
        planner,
        `let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const value = prompt.startsWith('# Plan the change') ? ${JSON.stringify(plan)} : prompt.startsWith('# Choose the checks for this review') ? { commands: [], declined: [], reason: 'The plan check covers this change.' } : ${JSON.stringify(review)};
console.log(JSON.stringify(value));\n`,
      );
      writeFileSync(
        implementer,
        `for await (const chunk of process.stdin) void chunk;
console.log(${JSON.stringify(JSON.stringify({ version: 1, files: [{ path: 'src/greet.mjs', action: 'create', content: "export const greet = () => 'hello';\n" }] }))});\n`,
      );
      const run = await cli(
        target,
        [
          'start',
          '--planner-command',
          process.execPath,
          '--planner-args',
          planner,
          '--implementer-command',
          process.execPath,
          '--implementer-args',
          implementer,
          '--implementer-model',
          'fixture',
          '--implementer-context-length',
          '200000',
          '--reviewer-command',
          process.execPath,
          '--reviewer-args',
          planner,
          'Add a greeting helper',
        ],
        { json, timeoutMs: 90_000 },
      );
      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
      const config = loadConfig(target.projectDir).config;
      expect(config.planner).toMatchObject({
        kind: 'shell',
        command: process.execPath,
        args: [planner],
      });
      expect(config.implementer).toMatchObject({
        kind: 'shell',
        command: process.execPath,
        args: [implementer],
      });
      expect(config.reviewer).toMatchObject({
        kind: 'shell',
        command: process.execPath,
        args: [planner],
      });
      expect(run.stderr.match(/Saved a ready crew to/g)).toHaveLength(1);
      const session = readActive(target.projectDir);
      if (session === null) throw new Error('Expected a ready run');
      expect(readState(target, session).phase).toBe('complete');
    },
  );

  it.each(['spec', 'review', 'init'] as const)(
    'saves a Codex crew on a Codex-only machine for %s',
    async (command) => {
      const { target, bin, calls, home } = freshProject();
      readyCodex(bin, calls, home);
      if (command === 'review')
        writeFileSync(join(target.projectDir, 'change.txt'), 'Review me.\n');
      const run = await cli(
        target,
        command === 'init'
          ? ['init', '--yes']
          : command === 'spec'
            ? ['spec', 'Add a greeting helper']
            : ['review'],
      );
      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
      const config = loadConfig(target.projectDir).config;
      expect(config.planner).toEqual({ kind: 'cli', tool: 'codex' });
      expect(config.implementer).toEqual({ kind: 'cli', tool: 'codex' });
      expect(readFileSync(configPath(target.projectDir), 'utf8')).not.toMatch(/claude-code|ollama/);
      expect(run.stderr.match(/Saved a ready crew to/g)).toHaveLength(1);
      expect(readFileSync(join(target.projectDir, '.gitignore'), 'utf8')).toContain('.splitbrief/');
      if (command !== 'init')
        expect(readFileSync(calls, 'utf8')).toContain(
          `"seat":"${command === 'spec' ? 'plan' : 'review'}"`,
        );
    },
  );

  it.each(['spec', 'review', 'init'] as const)(
    'leaves config absent and gives the setup remedy without tools for %s',
    async (command) => {
      const { target } = freshProject();
      const run = await cli(
        target,
        command === 'init'
          ? ['init', '--yes']
          : command === 'spec'
            ? ['spec', 'Add a greeting helper']
            : ['review'],
      );
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('No config found and no ready crew is available.');
      expect(run.stderr).toContain('splitbrief init');
      expect(existsSync(configPath(target.projectDir))).toBe(false);
    },
  );

  it.each([false, true])(
    'starts with a detected ready build seat while Ollama is unavailable, json=%s',
    async (json) => {
      const { target, bin, calls, home } = freshProject();
      readyClaude(bin, calls, home);
      const run = await cli(target, ['start', 'Add a greeting helper'], {
        json,
        timeoutMs: 90_000,
      });
      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
      const config = loadConfig(target.projectDir).config;
      expect(config.planner).toMatchObject({ kind: 'cli', tool: 'claude-code' });
      expect(config.implementer).toMatchObject({ kind: 'cli', tool: 'claude-code' });
      expect(readFileSync(calls, 'utf8')).toContain('"seat":"build"');
      const session = readActive(target.projectDir);
      if (session === null) throw new Error('Expected a ready run');
      expect(readState(target, session).phase).toBe('complete');
      expect(run.stderr).toContain('Saved a ready crew to .splitbrief/config.yaml.');
    },
  );

  it('leaves config absent and names the next step when no crew is ready', async () => {
    const { target } = freshProject();
    const run = await cli(target, ['start', 'Add a greeting helper']);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('No config found and no ready crew is available.');
    expect(run.stderr).toContain('splitbrief init');
    expect(existsSync(configPath(target.projectDir))).toBe(false);
    expect(readActive(target.projectDir)).toBeNull();
  });

  it.each(['planner', 'implementer'] as const)(
    'fills the other seat from detection and preserves a partial %s override',
    async (seat) => {
      const { target, bin, calls, home } = freshProject();
      readyClaude(bin, calls, home);
      const run = await cli(target, [
        'start',
        `--${seat}`,
        'claude-code',
        `--${seat}-model`,
        'sonnet',
        'Add a greeting helper',
      ]);
      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
      const config = loadConfig(target.projectDir).config;
      expect(config.planner).toEqual({ kind: 'cli', tool: 'claude-code' });
      expect(config.implementer).toEqual({ kind: 'cli', tool: 'claude-code' });
      expect(readFileSync(calls, 'utf8')).toContain('"--model","sonnet"');
      expect(readFileSync(calls, 'utf8')).toContain('"seat":"build"');
      expect(run.stderr).toContain('Saved a ready crew to .splitbrief/config.yaml.');
    },
  );

  it.each(['planner', 'implementer', 'reviewer'])(
    'leaves config absent with a %s override when no tool is ready',
    async (seat) => {
      const { target } = freshProject();
      const run = await cli(target, ['start', `--${seat}`, 'claude-code', 'Add a greeting helper']);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('No config found and no ready crew is available.');
      expect(existsSync(configPath(target.projectDir))).toBe(false);
      expect(readActive(target.projectDir)).toBeNull();
    },
  );

  it('refuses an unavailable explicit seat before saving a ready default crew', async () => {
    const { target, bin, calls, home } = freshProject();
    readyClaude(bin, calls, home);
    const run = await cli(target, ['start', '--implementer', 'opencode', 'Add a greeting helper']);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('BUILD is unavailable');
    expect(existsSync(configPath(target.projectDir))).toBe(false);
    expect(existsSync(calls)).toBe(false);
    expect(readActive(target.projectDir)).toBeNull();
  });

  it.each([true, false])(
    'checks the API endpoint and model before saving, explicit tool=%s',
    async (explicitTool) => {
      const { target, bin, calls, home } = freshProject();
      readyClaude(bin, calls, home);
      const probes = join(target.tmpDir, 'api-probes.jsonl');
      writeFileSync(
        join(target.tmpDir, 'offline.mjs'),
        `import { appendFileSync } from 'node:fs';
globalThis.fetch = async input => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('http://127.0.0.1:12434/')) {
    appendFileSync(${JSON.stringify(probes)}, url + '\\n');
    return Response.json({ models: [{ name: 'another-model' }] });
  }
  throw new Error('Network disabled in no-config E2E');
};\n`,
      );
      const run = await cli(target, [
        'start',
        ...(explicitTool ? ['--implementer', 'ollama'] : []),
        '--implementer-model',
        'selected-model',
        '--implementer-api-base',
        'http://127.0.0.1:12434/v1',
        'Add a greeting helper',
      ]);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('BUILD is unavailable');
      expect(existsSync(configPath(target.projectDir))).toBe(false);
      expect(existsSync(probes)).toBe(true);
      expect(readFileSync(probes, 'utf8')).toContain('http://127.0.0.1:12434/');
      expect(existsSync(calls)).toBe(false);
      expect(readActive(target.projectDir)).toBeNull();
    },
  );

  it('starts without overrides after Setup continues with an endpoint override', async () => {
    const { target, bin, calls, home } = freshProject();
    readyClaude(bin, calls, home);
    resetAllStores();
    configStore.load(target.projectDir, {
      implementer: {
        model: 'custom-coder',
        apiBase: 'http://127.0.0.1:12434/v1',
      },
    });
    const effective = configStore.get().config;
    if (effective === null) throw new Error('Expected a loaded config');
    const { sourceContexts } = createProductionDetectionDeps({
      config: effective,
      projectDir: target.projectDir,
    });
    const cliTools = [cliDetectionFor('ready', 'claude-code')];
    const request = detectionStore.beginRefresh({
      contexts: { readiness: 'setup-api', modelsDev: 'setup-models', cliModels: 'setup-cli' },
    });
    detectionStore.publish({
      request,
      result: { cliTools, providers: [], catalog: {}, cliModels: [], generation: 1 },
    });
    detectionStore.setDetection({
      cliTools,
      providers: [],
      providerOutcomes: sourceContexts.configuredProviders?.map((connection) => ({
        connection,
        state: 'fresh',
        catalog: 'populated',
        models: [{ id: 'custom-coder' }],
        fetchedAt: 1,
        validatedAt: 1,
      })),
    });
    routerStore.init({ screen: 'setup', onComplete: 'home' });
    const ui = renderFeature(createElement(SetupScreen));
    try {
      await vi.waitFor(() => expect(ui.lastFrame() ?? '').toContain('Set up your crew'));
      for (let step = 0; step < 12; step += 1) {
        if (
          (ui.lastFrame() ?? '')
            .split('\n')
            .some((row) => row.includes(`${glyph('liveBar')} Continue`))
        )
          break;
        ui.stdin.write('\u001B[B');
        await tick(20);
      }
      ui.stdin.write('\r');
      await vi.waitFor(() => expect(routerStore.get().screen).toBe('home'));
      expect(loadConfig(target.projectDir).config.implementer).toEqual({
        kind: 'cli',
        tool: 'claude-code',
      });
    } finally {
      ui.unmount();
    }
    const run = await cli(target, ['start', 'Add a greeting helper']);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(readFileSync(calls, 'utf8')).toContain('"seat":"build"');
    const session = readActive(target.projectDir);
    if (session === null) throw new Error('Expected a ready run');
    expect(readState(target, session).phase).toBe('complete');
  });

  it.each(['partial-ollama', 'custom-listed', 'custom-missing'] as const)(
    'keeps the selected API connection through headless preparation and execution: %s',
    async (connection) => {
      const { target, bin, calls, home } = freshProject();
      readyClaude(bin, calls, home);
      const custom = connection !== 'partial-ollama';
      const apiBase = custom ? 'https://custom.example.test/v1' : 'http://127.0.0.1:12434/v1';
      if (custom) {
        writeFileSync(
          configPath(target.projectDir),
          JSON.stringify(
            toYaml(
              makeConfig({
                implementer: {
                  provider: 'custom-api',
                  model: 'custom-coder',
                  apiBase,
                  apiKey: 'inline-test-key',
                },
                workflow: { approve: 'none', isolation: 'none' },
              }),
            ),
          ),
        );
      }
      const probes = join(target.tmpDir, 'selected-api.jsonl');
      writeFileSync(
        join(target.tmpDir, 'offline.mjs'),
        `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(${JSON.stringify(apiBase.replace(/\/v1$/, '/'))})) throw new Error('Offline default');
  if (url.endsWith('/chat/completions')) {
    const body = JSON.parse(init.body);
    appendFileSync(${JSON.stringify(probes)}, JSON.stringify({ model: body.model, url }) + '\\n');
    const answer = JSON.stringify({ version: 1, files: [{ path: 'src/greet.mjs', action: 'create', content: "export const greet = () => 'hello';\\n" }] });
    return new Response('data: ' + JSON.stringify({ id: 'api-build', choices: [{ index: 0, delta: { content: answer }, finish_reason: 'stop' }] }) + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
  }
  return Response.json({ models: [{ name: 'custom-coder' }], data: [{ id: ${JSON.stringify(connection === 'custom-missing' ? 'other-model' : 'custom-coder')} }] });
};\n`,
      );
      const run = await cli(
        target,
        [
          'start',
          ...(custom
            ? []
            : ['--implementer-api-base', apiBase, '--implementer-model', 'custom-coder']),
          'Add a greeting helper',
        ],
        { json: true, timeoutMs: 90_000 },
      );
      if (connection === 'custom-missing') {
        expect(run.exitCode).toBe(1);
        expect(run.stdout).toContain('does not serve');
        expect(existsSync(probes)).toBe(false);
        expect(existsSync(calls)).toBe(false);
      } else {
        expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(readFileSync(probes, 'utf8')).toContain('"model":"custom-coder"');
        expect(readFileSync(probes, 'utf8')).toContain(`${apiBase}/chat/completions`);
        if (!custom)
          expect(loadConfig(target.projectDir).config.implementer).toEqual({
            kind: 'cli',
            tool: 'claude-code',
          });
      }
    },
  );

  it('keeps a config another process saves during tool detection', async () => {
    const { target, bin, calls, home } = freshProject();
    readyClaude(bin, calls, home);
    const external = 'version: 3\nworkflow:\n  approve: none\n';
    const shim = join(bin, 'claude.cjs');
    const script = readFileSync(shim, 'utf8');
    writeFileSync(
      shim,
      script.replace(
        "if (args[0] === 'auth') {",
        `if (args[0] === 'auth') { fs.writeFileSync(${JSON.stringify(configPath(target.projectDir))}, ${JSON.stringify(external)});`,
      ),
    );
    const run = await cli(target, ['start', 'Add a greeting helper']);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('Config changed during setup. Retry the command.');
    expect(readFileSync(configPath(target.projectDir), 'utf8')).toBe(external);
    expect(existsSync(calls)).toBe(false);
    expect(readActive(target.projectDir)).toBeNull();
  });
});
