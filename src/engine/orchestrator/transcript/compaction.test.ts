import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createEventBus } from '../../events/bus.js';
import type { EngineEvent, EventBus } from '../../events/types.js';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { approvalsFile, sessionDir, SESSION_LOG_FILE } from '../../../core/paths.js';
import { ConfigSchema, type Config } from '../../../core/schemas/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';
import type { RunnerGate } from '../../runners/prepared-execution.js';
import {
  customRunnerSecurityPosture,
  resolveCustomRunnerTrustFile,
} from '../../runners/custom-trust.js';
import { resolveConfiguredCustomRunner } from '../../runners/configured-custom.js';
import {
  compactResumeTranscript,
  keepRecentCountForThreshold,
  performManualCompaction as performPreparedManualCompaction,
} from './compaction.js';

let dirs: string[] = [];

function plannerGate(config: Config, preparationId: string): RunnerGate {
  const slot = { role: 'planner' as const };
  const configured = resolveConfiguredCustomRunner(config, 'planner');
  if (configured !== null) {
    return {
      kind: configured.command.contract === 'output' ? 'shell' : 'agent',
      slot,
      preparationId,
      command: {
        kind: 'configured-custom',
        invocation: {
          kind: 'custom-runner-invocation',
          runner: configured,
          posture: customRunnerSecurityPosture('planner', configured.command.contract),
          executable: executableReceipt(configured.command.executable),
          authorization: 'explicit-grant',
          scope: {
            projectIdentity: `sha256:${'a'.repeat(64)}`,
            definitionId: configured.command.id,
            definitionDigest: `sha256:${'b'.repeat(64)}`,
          },
        },
      },
    };
  }

  const runner = config.planner;
  switch (runner.kind) {
    case 'cli':
      return {
        kind: 'cli',
        slot,
        preparationId,
        tool: runner.tool,
        executable: executableReceipt(),
      };
    case 'api':
      return {
        kind: 'api',
        slot,
        preparationId,
        provider: runner.provider,
        endpointOrigin: new URL(runner.apiBase).origin,
      };
    case 'agent-sdk':
      return { kind: 'agent-sdk', slot, preparationId, provider: 'anthropic' };
    case 'shell':
      return { kind: 'shell', slot, preparationId, command: { kind: 'validated-config' } };
    case 'agent':
      return { kind: 'agent', slot, preparationId, command: { kind: 'validated-config' } };
  }
}

function performManualCompaction(opts: {
  config: Config;
  ref: { projectDir: string; sessionId: string };
  bus?: EventBus;
}) {
  const preparationId = 'manual-compaction-preparation';
  const { bus, ...rest } = opts;
  return performPreparedManualCompaction({
    ...rest,
    preparationId,
    gates: [plannerGate(opts.config, preparationId)],
    bus: bus ?? createEventBus(),
  });
}

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('transcript-compaction-test');
  dirs.push(projectDir);
  const sessionId = 'sess-transcript';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function writeSessionLog(projectDir: string, sessionId: string, entries: unknown[]): void {
  const filePath = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function seedCustomRunnerSurface(projectDir: string, sessionId: string): void {
  writeFileSync(approvalsFile(projectDir), '{"version":1,"grants":[]}\n');
  const artifactCandidate = join(
    sessionDir(projectDir, sessionId),
    '.custom-runner-review',
    'existing-call',
    'result',
  );
  mkdirSync(dirname(artifactCandidate), { recursive: true });
  writeFileSync(artifactCandidate, 'pre-existing review candidate');
}

describe('keepRecentCountForThreshold', () => {
  it('returns threshold minus one for typical values', () => {
    expect(keepRecentCountForThreshold(10)).toBe(9);
    expect(keepRecentCountForThreshold(20)).toBe(19);
  });

  it('clamps to at least 1', () => {
    expect(keepRecentCountForThreshold(1)).toBe(1);
    expect(keepRecentCountForThreshold(0)).toBe(1);
  });
});

describe('compactResumeTranscript', () => {
  it('surfaces the planner usage from the summarization call', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: 1000, role: 'user', phase: 'planning', text: 'first' },
      { kind: 'message', ts: 1001, role: 'assistant', phase: 'planning', text: 'second' },
      { kind: 'message', ts: 1002, role: 'user', phase: 'planning', text: 'third' },
    ]);

    const result = await compactResumeTranscript({
      projectDir,
      sessionId,
      keepRecentCount: 1,
      planner: {
        summarize: async () => ({
          text: '## Summary',
          usage: { inputTokens: 1200, outputTokens: 90 },
        }),
      },
    });

    expect(result.summary).toBe('## Summary');
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 90 });
  });

  it('returns null usage when nothing needs summarizing', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: 1000, role: 'user', phase: 'planning', text: 'only message' },
    ]);

    const result = await compactResumeTranscript({
      projectDir,
      sessionId,
      keepRecentCount: 10,
      planner: {
        summarize: async () => {
          throw new Error('should not summarize');
        },
      },
    });

    expect(result.entriesRemoved).toBe(0);
    expect(result.usage).toBeNull();
  });
});

describe('performManualCompaction', () => {
  it('compacting a session with nothing to summarize is a no-op', async () => {
    const { projectDir, sessionId } = setupProject();

    await expect(
      performManualCompaction({ config: makeConfig(), ref: { projectDir, sessionId } }),
    ).resolves.toEqual({ status: 'compacted', summary: '', entriesRemoved: 0 });
  });

  it('publishes a cost update on the caller bus when compaction books planner usage', async () => {
    const { projectDir, sessionId } = setupProject();
    writeCompactionTriggeringLog(projectDir, sessionId);
    saveState({ projectDir, sessionId }, createInitialState('manual-compaction-usage'));
    const planner = await startUsageReportingPlanner();
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));

    try {
      await expect(
        performManualCompaction({
          config: makeConfig({
            planner: {
              kind: 'api',
              provider: 'custom-compaction-planner',
              model: 'test-model',
              apiBase: `http://127.0.0.1:${planner.port}/v1`,
              apiKey: 'test-key',
              contextLength: 8192,
            },
            workflow: { compactionFormat: 'freeform' },
          }),
          ref: { projectDir, sessionId },
          bus,
        }),
      ).resolves.toMatchObject({ status: 'compacted', entriesRemoved: 2 });
    } finally {
      await planner.close();
    }

    expect(events.filter((event) => event.type === 'cost_update')).toEqual([
      expect.objectContaining({
        type: 'cost_update',
        tokenUsage: expect.objectContaining({ plannerInput: 42, plannerOutput: 17 }),
      }),
    ]);
  });

  it('retains the legacy shell result when no custom command matches', async () => {
    const { projectDir, sessionId } = setupProject();

    await expect(
      performManualCompaction({
        config: makeConfig({ planner: { kind: 'shell', command: 'cat', outputFormat: 'text' } }),
        ref: { projectDir, sessionId },
      }),
    ).resolves.toEqual({ status: 'unsupported', plannerName: 'shell' });
  });

  it.each(['output', 'direct'] as const)(
    'rejects configured %s planners before custom-runner setup can affect the session',
    async (contract) => {
      await expectConfiguredManualCompactionHasNoEffects({ contract, seedTriggeringLog: false });
    },
  );
});

type ManualCompactionEffects = Readonly<{
  childStarted: string;
  stageCwd: string;
  prompt: string;
  declaredEnvironment: string;
}>;

type ConfiguredManualCompactionFixture = Readonly<{
  config: Config;
  declaredEnvironmentName: string;
  declaredEnvironmentValue: string;
  effects: ManualCompactionEffects;
}>;

let manualCompactionSequence = 0;

function configuredManualCompactionFixture(input: {
  projectDir: string;
  contract: 'output' | 'direct';
}): ConfiguredManualCompactionFixture {
  manualCompactionSequence += 1;
  const { projectDir, contract } = input;
  const declaredEnvironmentName = `COMPACTION_R7_${contract.toUpperCase()}_${process.pid}_${manualCompactionSequence}`;
  const effects = {
    childStarted: join(projectDir, `configured-${contract}-child-started`),
    stageCwd: join(projectDir, `configured-${contract}-stage-cwd`),
    prompt: join(projectDir, `configured-${contract}-prompt`),
    declaredEnvironment: join(projectDir, `configured-${contract}-declared-environment`),
  };
  const command = {
    label: `Manual R7 ${contract} planner`,
    contract,
    executable: process.execPath,
    argv: [
      '-e',
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(effects.childStarted)}, 'started');`,
        `fs.writeFileSync(${JSON.stringify(effects.stageCwd)}, process.cwd());`,
        `fs.writeFileSync(${JSON.stringify(effects.declaredEnvironment)}, process.env[${JSON.stringify(declaredEnvironmentName)}] ?? 'missing');`,
        "let prompt = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { prompt += chunk; });",
        `process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(effects.prompt)}, prompt); process.stdout.write('summary'); });`,
      ].join('\n'),
    ],
    outputFormat: 'text' as const,
    idleWarnMs: 300_000,
    idleKillMs: 1_800_000,
    env: [declaredEnvironmentName],
  };
  const config = ConfigSchema.parse({
    ...makeConfig(),
    planner: {
      kind: contract === 'output' ? 'shell' : 'agent',
      command: command.executable,
      args: command.argv,
      outputFormat: command.outputFormat,
      idleWarnMs: command.idleWarnMs,
      idleKillMs: command.idleKillMs,
      env: command.env,
    },
    customCommands: { [`manual-r7-${contract}-${manualCompactionSequence}`]: command },
  });

  return {
    config,
    declaredEnvironmentName,
    declaredEnvironmentValue: `manual-compaction-r7-${contract}-${manualCompactionSequence}`,
    effects,
  };
}

async function startUsageReportingPlanner(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'compacted summary' }, index: 0 }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 17 } })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function writeCompactionTriggeringLog(projectDir: string, sessionId: string): void {
  writeSessionLog(
    projectDir,
    sessionId,
    Array.from({ length: 12 }, (_, index) => ({
      kind: 'message',
      ts: 1_000 + index,
      role: index % 2 === 0 ? 'user' : 'assistant',
      phase: 'planning',
      text: `compaction message ${index + 1}`,
    })),
  );
}

function readOptionalFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function manualCompactionSurface(
  projectDir: string,
  sessionId: string,
  effects: ManualCompactionEffects,
  trustReceipt: string,
) {
  const sessionRoot = sessionDir(projectDir, sessionId);
  const artifactReviewRoot = join(sessionRoot, '.custom-runner-review');
  const artifactCandidate = join(artifactReviewRoot, 'existing-call', 'result');
  return {
    approvalReceipt: readOptionalFile(approvalsFile(projectDir)),
    artifactCandidate: readOptionalFile(artifactCandidate),
    artifactReviewRoot: existsSync(artifactReviewRoot),
    childStarted: readOptionalFile(effects.childStarted),
    declaredEnvironment: readOptionalFile(effects.declaredEnvironment),
    prompt: readOptionalFile(effects.prompt),
    sessionLog: readOptionalFile(join(sessionRoot, SESSION_LOG_FILE)),
    stageCwd: readOptionalFile(effects.stageCwd),
    trustReceipt: readOptionalFile(trustReceipt),
  };
}

function restoreEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function expectConfiguredManualCompactionHasNoEffects(input: {
  contract: 'output' | 'direct';
  seedTriggeringLog: boolean;
}) {
  const { contract, seedTriggeringLog } = input;
  const { projectDir, sessionId } = setupProject();
  const homeDir = createTempDir('transcript-compaction-home');
  dirs.push(homeDir);
  const fixture = configuredManualCompactionFixture({ projectDir, contract });
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousDeclaredValue = process.env[fixture.declaredEnvironmentName];

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env[fixture.declaredEnvironmentName] = fixture.declaredEnvironmentValue;

  try {
    const trustReceipt = resolveCustomRunnerTrustFile();
    seedCustomRunnerSurface(projectDir, sessionId);
    if (seedTriggeringLog) writeCompactionTriggeringLog(projectDir, sessionId);
    const before = manualCompactionSurface(projectDir, sessionId, fixture.effects, trustReceipt);

    expect(before).toMatchObject({
      approvalReceipt: '{"version":1,"grants":[]}\n',
      artifactCandidate: 'pre-existing review candidate',
      artifactReviewRoot: true,
      childStarted: null,
      declaredEnvironment: null,
      prompt: null,
      stageCwd: null,
      trustReceipt: null,
    });

    await expect(
      performManualCompaction({ config: fixture.config, ref: { projectDir, sessionId } }),
    ).resolves.toEqual({
      status: 'unsupported',
      plannerName: contract === 'output' ? 'shell' : 'agent',
    });

    expect(manualCompactionSurface(projectDir, sessionId, fixture.effects, trustReceipt)).toEqual(
      before,
    );
  } finally {
    restoreEnvironmentValue(fixture.declaredEnvironmentName, previousDeclaredValue);
    restoreEnvironmentValue('HOME', previousHome);
    restoreEnvironmentValue('USERPROFILE', previousUserProfile);
  }
}

describe('configured manual compaction side effects', () => {
  it.each(['output', 'direct'] as const)(
    'returns unsupported before a configured %s planner can create any custom-runner effect',
    async (contract) => {
      await expectConfiguredManualCompactionHasNoEffects({ contract, seedTriggeringLog: true });
    },
  );
});
