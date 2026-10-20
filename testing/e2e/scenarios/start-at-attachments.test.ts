import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentFailureText } from '../../../src/core/attachments/failure.js';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture;
let trustHome: ReturnType<typeof useTrustHome>;
let promptsPath: string;

beforeEach(() => {
  fixture = createStopContinueFixture(
    () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`,
    { isolation: 'none' },
  );
  trustHome = useTrustHome('e2e-start-attachments-home');
  promptsPath = join(fixture.tmpDir, 'planner-prompts.jsonl');
  const plannerPath = join(fixture.tmpDir, 'recording-planner.mjs');
  writeFileSync(
    plannerPath,
    `import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
appendFileSync(${JSON.stringify(promptsPath)}, JSON.stringify(prompt) + '\\n');
const reply = spawnSync(process.execPath, [${JSON.stringify(join(fixture.projectDir, 'tools/planner.mjs'))}], {
  input: prompt,
  encoding: 'utf8',
});
if (reply.status !== 0) throw new Error(reply.stderr);
process.stdout.write(reply.stdout);
`,
  );
  const config = loadConfig(fixture.projectDir).config;
  writeConfig(fixture.projectDir, {
    ...config,
    planner: { ...config.planner, kind: 'shell', command: 'node', args: [plannerPath] },
  });
  const offlinePath = join(fixture.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('Network disabled in attachment E2E'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  trustHome.restore();
  cleanupTempDir(fixture.tmpDir);
});

describe('e2e: start @file attachments', () => {
  it('attaches outside text from a separate argument and supplies it to planning and final review', async () => {
    const path = join(fixture.tmpDir, 'outside-notes.md');
    const marker = `outside-attachment-${fixture.tmpDir}`;
    const content = `The greeting helper must preserve this marker: ${marker}.\n`;
    writeFileSync(path, content);

    const run = await cli(fixture, ['start', 'smoke', `@${path}`]);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout.split('\n')).toContain(`attached files: ${realpathSync(path)} (text)`);
    expect(run.stdout).toContain('done: 1 tasks');

    const prompts: string[] = readFileSync(promptsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('Final Implementation Review');
    expect(prompts[1]).toContain('Final Implementation Review');
    for (const prompt of prompts) expect(prompt).toContain(content);

    const sessions = readdirSync(sessionsRoot(fixture.projectDir));
    expect(sessions).toHaveLength(1);
    const state = readState(fixture, sessions[0] ?? '');
    expect(state.phase).toBe('complete');
    expect(state.plannerContext).toContain(content);
    expect(readFileSync(fixture.greetPath, 'utf8')).toBe(GREET_SOURCE);
  });

  it('says on stderr under --plain that a planner which takes no images dropped the image', async () => {
    const path = join(realpathSync(fixture.tmpDir), 'sketch.png');
    writeFileSync(
      path,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    );

    const run = await cli(fixture, ['start', 'smoke', `@${path}`]);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout.split('\n')).toContain(`attached files: ${path} (image)`);
    expect(run.stderr.split('\n')).toContain('1 image dropped: the planner takes no images.');
    expect(run.stdout).toContain('done: 1 tasks');
  });

  it('keeps @word and @scope/pkg inside the feature as text without attaching files', async () => {
    const feature = 'Implement @word in comments and upgrade @scope/pkg';
    const run = await cli(fixture, ['start', feature]);

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).not.toContain('attached files:');
    const prompts: string[] = readFileSync(promptsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(feature);
    for (const prompt of prompts) expect(prompt).not.toContain('<user-context>');

    const sessions = readdirSync(sessionsRoot(fixture.projectDir));
    expect(sessions).toHaveLength(1);
    const state = readState(fixture, sessions[0] ?? '');
    expect(state.feature).toBe(feature);
    expect(state.plannerContext).toBeUndefined();
  });

  describe('refusals from separate arguments', () => {
    it.each([
      { reason: 'not-found', name: 'missing.md' },
      { reason: 'not-a-file', name: 'directory' },
      { reason: 'not-text', name: 'archive.zip' },
    ] as const)('refuses $reason with exit 2 before any planner call', async ({ reason, name }) => {
      const path = join(fixture.tmpDir, name);
      if (reason === 'not-a-file') mkdirSync(path);
      if (reason === 'not-text') writeFileSync(path, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

      const run = await cli(fixture, ['start', 'smoke', `@${path}`]);
      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(2);
      expect(run.stderr.split('\n')).toContain(`  @${path}: ${attachmentFailureText(reason)}`);
      expect(existsSync(promptsPath)).toBe(false);
      expect(existsSync(sessionsRoot(fixture.projectDir))).toBe(false);
    });
  });
});
