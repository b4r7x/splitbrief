import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { spawnCli } from '../helpers/live-cli-harness.js';
import { buildSteeringCli } from '../helpers/steer-e2e-workflow.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';
import { transcriptText } from '../helpers/transcript-text.js';

const SESSION = 'claude-parallel-subagents';
type Frame = Record<string, unknown>;

function assistant(content: Frame[], parent: string | null = null): Frame {
  return {
    type: 'assistant',
    message: { role: 'assistant', content },
    parent_tool_use_id: parent,
    session_id: SESSION,
  };
}

/** A main message streams partial deltas; a sub-agent message is one whole record, as Claude Code sends it. */
function message(text: string, parent: string | null = null): Frame[] {
  if (parent !== null) return [assistant([{ type: 'text', text }], parent)];
  const streamEvent = (event: Frame): Frame => ({
    type: 'stream_event',
    event,
    session_id: SESSION,
    parent_tool_use_id: null,
  });
  return [
    streamEvent({ type: 'message_start', message: { role: 'assistant', content: [] } }),
    streamEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    assistant([{ type: 'text', text }]),
    streamEvent({ type: 'content_block_stop', index: 0 }),
  ];
}

function toolUse(id: string, name: string, parent: string | null = null): Frame {
  return assistant([{ type: 'tool_use', id, name, input: {} }], parent);
}

function toolResult(id: string, parent: string | null = null): Frame {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    parent_tool_use_id: parent,
    session_id: SESSION,
  };
}

/** The BUILD reply: two sub-agents speak one after the other, and B runs a tool before A ends. */
const BUILD_FRAMES: Frame[] = [
  ...message('Checking.'),
  toolUse('toolu_a', 'Task'),
  toolUse('toolu_b', 'Task'),
  ...message('Reading the tests.', 'toolu_a'),
  ...message('Looking at it.', 'toolu_b'),
  toolUse('toolu_r', 'Read', 'toolu_b'),
  toolResult('toolu_r', 'toolu_b'),
  ...message('Found 3.', 'toolu_a'),
  toolResult('toolu_a'),
  toolResult('toolu_b'),
  ...message('Done.'),
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done.',
    session_id: SESSION,
    usage: { input_tokens: 10, output_tokens: 5 },
  },
];

/** A Claude Code BUILD seat that writes both declared files and prints `BUILD_FRAMES`. */
function installClaude(bin: string): void {
  writeFakeNodeCli(
    bin,
    'claude',
    `
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('claude 2.1.296'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const emit = entry => console.log(JSON.stringify({ session_id: ${JSON.stringify(SESSION)}, ...entry }));
const build = prompt => {
  fs.mkdirSync('src', { recursive: true });
  fs.writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
  fs.writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
  emit({ type: 'system', subtype: 'init' });
  if (args.includes('--input-format')) emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: prompt } });
  for (const frame of ${JSON.stringify(BUILD_FRAMES)}) emit(frame);
};
if (args.includes('--input-format')) {
  const lines = readline.createInterface({ input: process.stdin });
  lines.once('line', line => {
    build(JSON.parse(line).message.content);
    lines.close();
    process.stdin.destroy();
  });
} else {
  build(fs.readFileSync(0, 'utf8'));
}
`,
  );
}

beforeAll(buildSteeringCli, 120_000);

it('gives each parallel sub-agent of a Claude Code BUILD seat its own row', async () => {
  const target = createStopContinueFixture(() => '', { isolation: 'none' });
  const home = useTrustHome('claude-parallel-subagents-home');
  let restorePath: (() => void) | undefined;
  try {
    mkdirSync(join(home.home, '.claude'), { recursive: true });
    writeFileSync(join(home.home, '.claude', '.credentials.json'), '{"fixture":true}\n');
    const bin = join(target.tmpDir, 'bin');
    mkdirSync(bin);
    installClaude(bin);
    restorePath = activateSafeCliShimPath(bin);
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
    });
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
      pathEnv: process.env.PATH ?? '',
    });
    const tools = await detectAvailableCliTools({
      projectDir: target.projectDir,
      tools: ['claude-code'],
    });
    expect(tools[0]?.diagnostic.state, JSON.stringify(tools[0]?.diagnostic)).toBe('ready');
    await rememberDetectedTools(target.projectDir, tools);
    const offline = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offline,
      "globalThis.fetch = async () => { throw new Error('Network disabled in Claude parallel sub-agents E2E'); };\n",
    );
    const outcome = await spawnCli({
      args: [
        '--import',
        offline,
        'dist/cli.js',
        'start',
        'smoke',
        '--json',
        '--allow-repo-runners',
        '--project',
        target.projectDir,
      ],
      stateHome: target.stateHome,
      timeoutMs: 60_000,
      reapProjectDir: target.projectDir,
    });
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
    expect(readFileSync(target.markerPath, 'utf8')).toBe(MARKER_SOURCE);

    const sessionIds = readdirSync(sessionsRoot(target.projectDir));
    expect(sessionIds).toHaveLength(1);
    const sessionId = sessionIds[0];
    if (sessionId === undefined) throw new Error('Expected one session directory');
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });

    const lines = transcriptText(events).split('\n');
    const reading = lines.filter((line) => line.includes('Reading the tests.'));
    expect(reading).toHaveLength(1);
    expect(reading[0]).not.toContain('Looking');
    const subagentText = (id: string) =>
      events.flatMap((event) =>
        event.type === 'planner_text' && event.subagentId === id ? [event.text] : [],
      );
    expect(subagentText('toolu_a')).toEqual(['Reading the tests.', 'Found 3.']);
    expect(subagentText('toolu_b')).toEqual(['Looking at it.']);
  } finally {
    restorePath?.();
    home.restore();
    cleanupTempDir(target.tmpDir);
  }
});
