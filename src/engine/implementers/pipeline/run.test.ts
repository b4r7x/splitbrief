import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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
import { readInterruptedPartial } from '../../orchestrator/continuation.js';
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

  it("names the call's own directory, never the project context's", async () => {
    let seenPrompt = '';
    const invoke = vi.fn().mockImplementation(async (opts) => {
      seenPrompt = opts.prompt;
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(seenPrompt).toContain(`- Stay inside ${projectDir}:`);
    expect(seenPrompt).toContain('- Use git only to read (status, diff, log, show);');
    expect(seenPrompt).toContain('- Dependencies are already installed;');
    expect(seenPrompt).not.toContain(defaultContext.dir);
  });
});

describe('createImplementerBase — continuation', () => {
  it('keeps the brief body and trails the partial, the changed files and the steer', async () => {
    let seenPrompt = '';
    const invoke = vi.fn().mockImplementation(async (opts) => {
      seenPrompt = opts.prompt;
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));
    const task = makeTask({ id: 'T007', title: 'Add the retry ladder' });

    await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      continuation: {
        partial: 'I started editing retry.ts',
        steer: 'keep the existing signature',
        extra: 'These declared files already changed since the task started: src/retry.ts',
      },
    });

    // The brief is still the prompt; the continuation is a note on the end of it.
    expect(seenPrompt).toContain('Add the retry ladder');
    expect(seenPrompt).toContain('I started editing retry.ts');
    expect(seenPrompt).toContain('src/retry.ts');
    expect(seenPrompt).toContain('keep the existing signature');
    expect(seenPrompt.indexOf('Add the retry ladder')).toBeLessThan(
      seenPrompt.indexOf('I started editing retry.ts'),
    );
  });

  it('sends the brief alone when nothing was interrupted', async () => {
    let seenPrompt = '';
    const invoke = vi.fn().mockImplementation(async (opts) => {
      seenPrompt = opts.prompt;
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    await implementer.implement({
      task: makeTask({ title: 'Add the retry ladder' }),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(seenPrompt).toContain('Add the retry ladder');
    expect(seenPrompt).not.toContain('[Continuation]');
  });

  it('keeps the retry findings when a reopened brief is continued', async () => {
    let seenPrompt = '';
    const invoke = vi.fn().mockImplementation(async (opts) => {
      seenPrompt = opts.prompt;
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    await implementer.retry({
      task: makeTask({ title: 'Add the retry ladder' }),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      error: 'the reviewer says the error is swallowed',
      attempt: 1,
      kind: 'local',
      continuation: { partial: 'I was half way', steer: 'start from the top' },
    });

    expect(seenPrompt).toContain('the reviewer says the error is swallowed');
    expect(seenPrompt).toContain('I was half way');
    expect(seenPrompt).toContain('start from the top');
  });

  it("keeps a direct writer's cut output as the partial a continue reads back", async () => {
    const sessionId = 'direct-writer-cut';
    const controller = new AbortController();
    const narration = 'I rewrote the first half of src/hello.ts.';
    const invoke = vi.fn().mockImplementation(async (opts) => {
      opts.onOutput(narration);
      controller.abort();
      return makeRunnerCallResult({
        status: 'aborted',
        text: narration,
        error: { code: 'user-abort', message: 'stopped' },
      });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      sessionId,
      signal: controller.signal,
    });

    expect(await readInterruptedPartial({ projectDir, sessionId })).toBe(narration);
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
      `Edit ${task.file} directly in the isolation directory. SPLITBRIEF runs the typecheck, lint and test gates after you hand back, so run at most the focused test files the brief lists, once. End your reply with the one JSON report object the rules describe: status done with the files you changed, or status blocked with your question and the files you need.`,
    );
    expect(seenPrompt).not.toContain('Output ONLY the complete file contents');
    expect(seenPrompt).not.toContain('Output the complete file contents');
    expect(seenPrompt).not.toContain('markdown code fences');
    // The whole prompt, preamble through footer, gives the gates to SPLITBRIEF and fences nothing.
    expect(seenPrompt).toContain("SPLITBRIEF runs the project's typecheck, lint and test gates");
    expect(seenPrompt).not.toMatch(/run the brief's typecheck|Run the validation commands/);
    expect(seenPrompt).not.toMatch(/Edit ONLY|out of bounds\.|outside scope/);
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

  it("carries the run's skills context on the first attempt and on a retry", async () => {
    const prompts: string[] = [];
    const invoke = vi.fn().mockImplementation(async (opts) => {
      prompts.push(opts.prompt);
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));
    const skillsContext = '## Active Project Skills\n\n### AuthSkill\nBUILD-SKILL-BODY';
    const call = {
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: { ...defaultContext, skillsContext },
      onOutput: vi.fn(),
    };

    await implementer.implement(call);
    await implementer.retry({ ...call, error: 'tsc failed', attempt: 1, kind: 'local' });

    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain(skillsContext);
      expect(prompt.indexOf(skillsContext)).toBeLessThan(prompt.indexOf('## Task:'));
    }
  });

  it("carries the run's plan context on the first attempt and on a retry", async () => {
    const prompts: string[] = [];
    const invoke = vi.fn().mockImplementation(async (opts) => {
      prompts.push(opts.prompt);
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));
    const call = {
      task: makeTask({ criteria: ['C1'] }),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      plan: {
        summary: 'Greet people by name',
        decisions: [{ text: 'PLAN-DECISION: keep the greeting in one module', taskId: null }],
        criteria: [{ id: 'C1', text: 'A name gets a greeting', checkIds: [] }],
      },
    };

    await implementer.implement(call);
    await implementer.retry({ ...call, error: 'tsc failed', attempt: 1, kind: 'local' });

    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain('PLAN-DECISION: keep the greeting in one module');
      expect(prompt).toContain('C1: A name gets a greeting');
    }
  });

  it("hands the call the directories of the run's attached skills", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue(makeRunnerCallResult({ status: 'completed', text: 'done', usage: null }));
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));
    const skillRoots = ['/home/me/.claude/skills/auth'];

    await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: { ...defaultContext, skillRoots },
      onOutput: vi.fn(),
    });

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ skillRoots }));
  });
});

describe('createImplementerBase — typed implementer report', () => {
  const doneReport = {
    status: 'done',
    filesChanged: ['src/hello.ts'],
    touchedNotSuggested: [],
    notes: null,
    decisions: [],
  } as const;
  const blockedReport = {
    status: 'blocked',
    question: 'Which store should the cache use?',
    filesNeeded: ['src/store.ts'],
  } as const;

  it('carries the report a direct reply ends with on a successful attempt', async () => {
    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: `I wrote the module.\n${JSON.stringify(doneReport)}`,
        usage: null,
      }),
    );
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    expect(result.report).toEqual(doneReport);
    expect(result.blocked).toBeUndefined();
  });

  it('returns a blocked report as blocked before the workspace is checked for changes', async () => {
    const detectChanges = vi.fn().mockResolvedValue({ changed: false, output: 'no changes' });
    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: `I need the store before I can continue.\n${JSON.stringify(blockedReport)}`,
        usage: null,
      }),
    );
    const implementer = createImplementerBase(
      makeBaseConfig({ extractsCode: false, detectChanges, invoke }),
    );

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.blocked).toEqual({
      question: blockedReport.question,
      filesNeeded: blockedReport.filesNeeded,
    });
    expect(result.report).toEqual(blockedReport);
    expect(detectChanges).not.toHaveBeenCalled();
  });

  it('takes the last JSON object, so a blocked report after a done-shaped one wins', async () => {
    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: `${JSON.stringify(doneReport)}\nActually, I am blocked.\n${JSON.stringify(blockedReport)}`,
        usage: null,
      }),
    );
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.blocked).toEqual({
      question: blockedReport.question,
      filesNeeded: blockedReport.filesNeeded,
    });
  });

  it('leaves the result unchanged when the reply carries no valid report', async () => {
    for (const text of [
      'done, no report',
      '{"status":"done"}',
      '{"status":"other","question":"q","filesNeeded":[]}',
    ]) {
      const invoke = vi
        .fn()
        .mockResolvedValue(makeRunnerCallResult({ status: 'completed', text, usage: null }));
      const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

      const result = await implementer.implement({
        task: makeTask(),
        projectDir,
        config: makeConfig(),
        context: defaultContext,
        onOutput: vi.fn(),
      });

      expect(result.success).toBe(true);
      expect(result.report).toBeUndefined();
      expect(result.blocked).toBeUndefined();
    }
  });

  it('surfaces a blocked file-bundle as blocked and writes nothing', async () => {
    const blockedBundle = {
      version: 1,
      blocked: { question: 'Which store should the cache use?', filesNeeded: ['src/store.ts'] },
    };
    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: JSON.stringify(blockedBundle),
        usage: null,
      }),
    );
    const implementer = createImplementerBase(
      makeBaseConfig({ extractsCode: true, outputContract: 'file-bundle-v1', invoke }),
    );

    const result = await implementer.implement({
      task: makeTask({ file: 'src/hello.ts', action: 'create' }),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.blocked).toEqual({
      question: 'Which store should the cache use?',
      filesNeeded: ['src/store.ts'],
    });
    expect(result.applyResult).toBeUndefined();
    expect(existsSync(join(projectDir, 'src/hello.ts'))).toBe(false);
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
    ['consult', 1, 'lint failed', 0.2, 'Your previous attempt had an error.'],
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

describe('createImplementerBase — isolation audit', () => {
  let isolationDir: string;

  beforeEach(() => {
    isolationDir = createTempDir('impl-base-isolation');
    createTestGitRepo(isolationDir);
  });

  afterEach(() => {
    cleanupTempDir(isolationDir);
  });

  function isolatedCall() {
    return {
      task: makeTask(),
      projectDir: isolationDir,
      fileIgnoreProjectDir: projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    };
  }

  it('warns on a file written into the checkout and lets the call stand', async () => {
    const { bus, events } = makeBusRecorder();
    const invoke = vi.fn().mockImplementation(async (opts) => {
      expect(opts.checkoutDir).toBe(projectDir);
      writeFileSync(join(isolationDir, 'src.ts'), 'export {};\n');
      writeFileSync(join(projectDir, 'escaped.ts'), 'export {};\n');
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(
      makeBaseConfig({ extractsCode: false, invoke, publisher: createImplementerPublisher(bus) }),
    );

    const result = await implementer.implement({ ...isolatedCall(), phase: 'implementing' });

    expect(result.success).toBe(true);
    expect(events.filter((event) => event.type === 'warning')).toEqual([
      expect.objectContaining({
        taskId: 'T001',
        category: 'implementer',
        code: 'checkout_changed_during_call',
        message:
          'Task T001: your checkout changed while Ollama ran — escaped.ts; nothing there was reverted',
      }),
    ]);
    expect(existsSync(join(projectDir, 'escaped.ts'))).toBe(true);
  });

  it("halts when the checkout's git state changed during the call", async () => {
    const invoke = vi.fn().mockImplementation(async () => {
      writeFileSync(join(isolationDir, 'src.ts'), 'export {};\n');
      execSync('git branch topic', { cwd: projectDir, stdio: 'pipe' });
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    const result = await implementer.implement(isolatedCall());

    expect(result).toMatchObject({
      success: false,
      outcome: 'checkout-changed',
      error: 'branch topic',
    });
  });

  it('keeps the tripwire evidence ahead of what the audit found', async () => {
    const invoke = vi.fn().mockImplementation(async () => {
      execSync('git branch escaped', { cwd: projectDir, stdio: 'pipe' });
      return makeRunnerCallResult({
        status: 'failed',
        text: '',
        error: {
          code: 'implementer-left-isolation',
          message: `ran git in ${projectDir} (your checkout) with Bash: git -C ${projectDir} branch escaped`,
        },
      });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    const result = await implementer.implement(isolatedCall());

    expect(result.outcome).toBe('implementer-left-isolation');
    expect(result.error).toBe(
      `ran git in ${projectDir} (your checkout) with Bash: git -C ${projectDir} branch escaped; ran while your checkout changed: branch escaped`,
    );
  });

  it('reports what a stopped call changed without halting on it', async () => {
    const { bus, events } = makeBusRecorder();
    const controller = new AbortController();
    const invoke = vi.fn().mockImplementation(async () => {
      execSync('git branch topic', { cwd: projectDir, stdio: 'pipe' });
      controller.abort();
      return makeRunnerCallResult({
        status: 'aborted',
        text: '',
        error: { code: 'user-abort', message: 'stopped' },
      });
    });
    const implementer = createImplementerBase(
      makeBaseConfig({ extractsCode: false, invoke, publisher: createImplementerPublisher(bus) }),
    );

    const result = await implementer.implement({
      ...isolatedCall(),
      phase: 'implementing',
      signal: controller.signal,
    });

    expect(result.outcome).toBe('user-abort');
    expect(events.filter((event) => event.type === 'warning')).toEqual([
      expect.objectContaining({
        code: 'implementer_left_isolation',
        message:
          'Task T001 was stopped; its implementer ran while your checkout changed: branch topic',
      }),
    ]);
  });

  it('reports a call that throws on a stop as user-abort', async () => {
    const controller = new AbortController();
    const invoke = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    const result = await implementer.implement({ ...isolatedCall(), signal: controller.signal });

    expect(result).toMatchObject({ success: false, error: 'Aborted', outcome: 'user-abort' });
  });

  it('lets a call that stayed in its isolation directory stand', async () => {
    const invoke = vi.fn().mockImplementation(async () => {
      writeFileSync(join(isolationDir, 'src.ts'), 'export {};\n');
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    const result = await implementer.implement(isolatedCall());

    expect(result.success).toBe(true);
  });

  it('audits an extracted-code writer the same way', async () => {
    const invoke = vi.fn().mockImplementation(async () => {
      execSync('git branch topic', { cwd: projectDir, stdio: 'pipe' });
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: true, invoke }));

    const result = await implementer.implement(isolatedCall());

    expect(result).toMatchObject({
      success: false,
      outcome: 'checkout-changed',
      error: 'branch topic',
    });
  });

  it('audits nothing for a call that runs in the checkout itself', async () => {
    const invoke = vi.fn().mockImplementation(async (opts) => {
      expect(opts.checkoutDir).toBeUndefined();
      writeFileSync(join(projectDir, 'written.ts'), 'export {};\n');
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    const result = await implementer.implement({
      ...isolatedCall(),
      projectDir,
      fileIgnoreProjectDir: projectDir,
    });

    expect(result.success).toBe(true);
  });
});

describe('createImplementerBase — git writes during a run worktree call', () => {
  let worktreeDir: string;

  beforeEach(() => {
    worktreeDir = createTempDir('impl-base-worktree');
    execSync(`git worktree add -q -b splitbrief/run-1 ${worktreeDir}`, {
      cwd: projectDir,
      stdio: 'pipe',
    });
  });

  afterEach(() => {
    cleanupTempDir(worktreeDir);
  });

  async function callThat(act: () => void) {
    const invoke = vi.fn().mockImplementation(async () => {
      writeFileSync(join(worktreeDir, 'src.ts'), 'export {};\n');
      act();
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));
    return implementer.implement({
      task: makeTask(),
      projectDir: worktreeDir,
      fileIgnoreProjectDir: projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });
  }

  const inWorktree = (command: string) => () =>
    execSync(`git ${command}`, { cwd: worktreeDir, stdio: 'pipe' });
  const inCheckout = (command: string) => () =>
    execSync(`git ${command}`, { cwd: projectDir, stdio: 'pipe' });

  it('halts on a stash taken in the worktree', async () => {
    writeFileSync(join(worktreeDir, 'init.txt'), 'edited before the stash\n');

    const result = await callThat(inWorktree('stash -q'));

    expect(result).toMatchObject({ outcome: 'checkout-changed', error: 'stash' });
  });

  it('halts on a hook change', async () => {
    const result = await callThat(() =>
      writeFileSync(join(projectDir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n'),
    );

    expect(result).toMatchObject({ outcome: 'checkout-changed', error: 'hook pre-commit' });
  });

  it('halts on a topic branch created from the worktree', async () => {
    const result = await callThat(inWorktree('branch topic'));

    expect(result).toMatchObject({ outcome: 'checkout-changed', error: 'branch topic' });
  });

  it('halts on git add inside the run worktree', async () => {
    const result = await callThat(inWorktree('add src.ts'));

    expect(result).toMatchObject({ outcome: 'checkout-changed', error: 'run worktree index' });
  });

  it('halts on git commit inside the run worktree', async () => {
    const result = await callThat(() => {
      inWorktree('add src.ts')();
      inWorktree('commit -qm escaped')();
    });

    expect(result).toMatchObject({
      outcome: 'checkout-changed',
      error: 'run worktree branch splitbrief/run-1 · run worktree index',
    });
  });

  it("lets a user commit on the checkout's current branch stand", async () => {
    const result = await callThat(() => {
      writeFileSync(join(projectDir, 'init.txt'), 'the user edits\n');
      inCheckout('commit -qam user-commit')();
    });

    expect(result.outcome).not.toBe('checkout-changed');
    expect(result.success).toBe(true);
  });
});
