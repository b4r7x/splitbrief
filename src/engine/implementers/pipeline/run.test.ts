import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createImplementerBase } from './run.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBaseConfig } from '#testing/helpers/factories/implementer-base.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import { createChangeDetector } from '../../change-detection.js';
import { createEventBus } from '../../events/bus.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import { createImplementerPublisher } from '../../orchestrator/events.js';
import { readPacketEvents } from '../../orchestrator/evidence/review-packet/artifacts.js';
import { buildEscalations } from '../../orchestrator/evidence/review-packet/sections.js';
import { createInitialState } from '../../../core/state/machine.js';

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('impl-base');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createImplementerBase — language-aware system preamble', () => {
  it('uses Python system guidance when a Python language context is provided', async () => {
    let seenPrompt = '';
    let seenSystemPreamble = '';
    const invoke = vi.fn().mockImplementation(async (opts) => {
      seenPrompt = opts.prompt;
      seenSystemPreamble = opts.systemPreamble;
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      languageContext: buildLanguageContext('python'),
      onOutput: vi.fn(),
    });

    expect(seenSystemPreamble).toContain('coding agent for Python');
    expect(seenSystemPreamble).not.toContain('TypeScript');
    expect(seenSystemPreamble).not.toContain('Output ONLY');
    expect(seenPrompt).toContain(seenSystemPreamble);
  });
});

describe('createImplementerBase — prompt write contracts', () => {
  it('gives direct-write implementers the isolation editing and validation contract', async () => {
    let seenPrompt = '';
    const invoke = vi.fn().mockImplementation(async (opts) => {
      seenPrompt = opts.prompt;
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));
    const task = makeTask({ evidence: ['npm test -- src/hello.test.ts'] });

    await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(seenPrompt).toContain(
      `Edit ${task.file} directly in the isolation directory. Run the validation commands listed in this Task Brief before finishing. End with a completion report stating which files you wrote and whether the brief's steps were completed.`,
    );
    expect(seenPrompt).not.toContain('Output ONLY the complete file contents');
    expect(seenPrompt).not.toContain('Output the complete file contents');
    expect(seenPrompt).not.toContain('markdown code fences');
  });

  it('keeps the extracted-code complete-file output contract', async () => {
    let seenPrompt = '';
    const invoke = vi.fn().mockImplementation(async (opts) => {
      seenPrompt = opts.prompt;
      return makeRunnerCallResult({
        status: 'completed',
        text: '```ts\nexport const greeting = "hello";\n```',
        usage: null,
      });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: true, invoke }));
    const task = makeTask();

    await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(seenPrompt).toContain('- Output ONLY the complete file contents');
    expect(seenPrompt).toContain(
      `Output the complete file contents for ${task.file}. No markdown fences. No explanations.`,
    );
    expect(seenPrompt).not.toContain('staged working directory');
  });
});

describe('createImplementerBase — non-extracting backends (detectChanges)', () => {
  it('ignores pre-existing dirty files and succeeds only when the backend writes a new file', async () => {
    const prePath = join(projectDir, 'src/pre-existing.ts');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(prePath, 'pre-existing content\n');

    const detectChanges = createChangeDetector('Direct implementer');
    const noChangeImplementer = createImplementerBase(
      makeBaseConfig({
        extractsCode: false,
        detectChanges,
        invoke: vi
          .fn()
          .mockResolvedValue(
            makeRunnerCallResult({ status: 'completed', text: 'done', usage: null }),
          ),
      }),
    );

    const noChange = await noChangeImplementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(noChange.success).toBe(false);
    if (!noChange.success) expect(noChange.error).toContain('without changing any files');

    const newPath = join(projectDir, 'src/new-file.ts');
    const writingImplementer = createImplementerBase(
      makeBaseConfig({
        extractsCode: false,
        detectChanges,
        invoke: vi.fn().mockImplementation(async () => {
          writeFileSync(newPath, 'export const created = true;\n');
          return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
        }),
      }),
    );

    const changed = await writingImplementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(changed.success).toBe(true);
    expect(readFileSync(prePath, 'utf-8')).toBe('pre-existing content\n');
    expect(readFileSync(newPath, 'utf-8')).toBe('export const created = true;\n');
  });

  it('returns success when extractsCode is false and no detectChanges provided', async () => {
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false }));

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
  });

  it('returns failure when detectChanges reports no changes', async () => {
    const detectChanges = vi.fn().mockResolvedValue({ changed: false, output: 'No files changed' });
    const implementer = createImplementerBase(
      makeBaseConfig({
        extractsCode: false,
        detectChanges,
        invoke: vi.fn().mockResolvedValue(
          makeRunnerCallResult({
            status: 'completed',
            text: 'done',
            usage: { inputTokens: 10, outputTokens: 20 },
          }),
        ),
      }),
    );

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('No files changed');
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    }
  });
});

describe('createImplementerBase — wrote-nothing warning', () => {
  it('publishes exactly one coded warning naming the runner and the task when the implementer wrote nothing', async () => {
    const { bus, events } = makeBusRecorder();
    const publisher = createImplementerPublisher(bus);
    const implementer = createImplementerBase(
      makeBaseConfig({
        extractsCode: false,
        publisher,
        detectChanges: vi.fn().mockResolvedValue({
          changed: false,
          output: 'Tool implementer (codex) exited without changing any files',
          reason: 'no-files-changed',
        }),
        invoke: vi
          .fn()
          .mockResolvedValue(
            makeRunnerCallResult({ status: 'completed', text: 'done', usage: null }),
          ),
      }),
    );
    const task = makeTask({ id: 'T001', file: 'src/hello.ts' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      phase: 'implementing',
    });

    expect(result.success).toBe(false);
    const warnings = events.filter((event) => event.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      type: 'warning',
      phase: 'implementing',
      taskId: 'T001',
      category: 'implementer',
      code: 'implementer_wrote_nothing',
    });
    if (warnings[0]?.type === 'warning') {
      expect(warnings[0].message).toContain('T001');
      expect(warnings[0].message).toContain('codex');
    }
  });

  it('lands the wrote-nothing warning in session.jsonl and the review packet warnings list', async () => {
    const sessionId = 't005-wrote-nothing';
    const bus = createEventBus();
    bus.subscribe(createJsonlSink({ projectDir, sessionId }));
    const implementer = createImplementerBase(
      makeBaseConfig({
        extractsCode: false,
        publisher: createImplementerPublisher(bus),
        detectChanges: vi.fn().mockResolvedValue({
          changed: false,
          output: 'Direct implementer exited without changing any files',
          reason: 'no-files-changed',
        }),
        invoke: vi
          .fn()
          .mockResolvedValue(
            makeRunnerCallResult({ status: 'completed', text: 'done', usage: null }),
          ),
      }),
    );

    const result = await implementer.implement({
      task: makeTask({ id: 'T001', file: 'src/hello.ts' }),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      phase: 'implementing',
      sessionId,
    });
    expect(result.success).toBe(false);

    const packetEvents = await readPacketEvents(projectDir, sessionId, []);
    const warnings = buildEscalations({
      state: createInitialState('feat'),
      ledger: null,
      events: packetEvents,
    }).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ type: 'warning', phase: 'implementing', taskId: 'T001' });
    if (warnings[0]?.type === 'warning') {
      expect(warnings[0].message).toContain('T001');
      expect(warnings[0].message).toContain('Direct implementer');
    }
  });

  it('does not publish the wrote-nothing warning when the implementer crashed', async () => {
    const { bus, events } = makeBusRecorder();
    const implementer = createImplementerBase(
      makeBaseConfig({
        extractsCode: false,
        publisher: createImplementerPublisher(bus),
        invoke: vi.fn().mockRejectedValue(new Error('connection refused')),
      }),
    );

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      phase: 'implementing',
    });

    expect(result.success).toBe(false);
    expect(events.filter((event) => event.type === 'warning')).toHaveLength(0);
  });
});

describe('createImplementerBase — retry', () => {
  it.each([
    ['local', 2, 'tsc failed', 0.4, 'Previous attempts failed.'],
    ['hint', 1, 'lint failed', 0.2, 'Your previous attempt had an error.'],
  ] as const)(
    'succeeds on retry for kind "%s" at attempt %i, prompting with the error and setting the temperature',
    async (kind, attempt, error, expectedTemperature, framing) => {
      let seenPrompt = '';
      let seenTemperature: number | undefined;
      const invoke = vi.fn().mockImplementation(async (opts) => {
        seenPrompt = opts.prompt;
        seenTemperature = opts.temperature;
        return makeRunnerCallResult({
          status: 'completed',
          text: '```ts\nconst x = 1;\n```',
          usage: null,
        });
      });
      const implementer = createImplementerBase(
        makeBaseConfig({ invoke, retryTemperatureStep: 0.1 }),
      );
      const task = makeTask({ id: 'T001', file: 'src/retry.ts', action: 'create' });

      const result = await implementer.retry({
        task,
        projectDir,
        config: makeConfig(),
        context: defaultContext,
        onOutput: vi.fn(),
        error,
        attempt,
        kind,
      });

      expect(result.success).toBe(true);
      expect(seenPrompt).toContain(error);
      expect(seenPrompt).toContain(framing);
      expect(seenTemperature).toBe(expectedTemperature);
    },
  );
});

describe('createImplementerBase — thrown provider auth failures', () => {
  it("thrown 401 provider error yields outcome 'unauthenticated' with the provider detail preserved", async () => {
    const { streamError } = await import('../../streaming/stream-errors.js');
    const providerDetail =
      '401 Invalid API key provided: Missing bearer or basic authentication in header.';
    const invoke = vi
      .fn()
      .mockRejectedValue(streamError.httpStatus('openrouter', 401, providerDetail));
    const implementer = createImplementerBase(
      makeBaseConfig({ extractsCode: false, backendKind: 'api', invoke }),
    );

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.outcome).toBe('unauthenticated');
      expect(result.error).toBe(providerDetail);
    }
  });
});

describe('createImplementerBase — unavailabilityReason', () => {
  it('exposes the configured reason on the returned implementer', async () => {
    const implementer = createImplementerBase(
      makeBaseConfig({ unavailabilityReason: () => 'the endpoint is unreachable' }),
    );

    expect(implementer.unavailabilityReason?.()).toBe('the endpoint is unreachable');
  });

  it('reports no reason when none is configured', async () => {
    const implementer = createImplementerBase(makeBaseConfig());

    expect(implementer.unavailabilityReason?.()).toBeUndefined();
  });
});
