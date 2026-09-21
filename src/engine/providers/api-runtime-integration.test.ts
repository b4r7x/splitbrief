import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type OpenAI from 'openai';
import type { Config } from '../../core/schemas/config.js';
import { createApiImplementer } from '../implementers/api.js';
import { createPlanner, createReviewer } from '../runners/factory.js';
import type { RunnerFactoryAuthority } from '../runners/factory-gates.js';
import type { RunnerSlot } from '../runners/prepared-execution.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import { TIMEOUTS } from '../../core/pipeline-spec/timeouts.js';
import { admitApiCall, type PreparedApiSeat } from './api-budget.js';
import type { ProviderDef } from './types.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { callPhase } from '#testing/helpers/planner-call.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

type WireRequest = {
  baseURL: string;
  model: string;
  maxTokens: number | undefined;
  messages: { role: string; content: string }[];
  /** The bound the seat gave the SDK client this request went out on. */
  clientTimeoutMs: number | undefined;
};

const dispatches: WireRequest[] = [];

vi.mock('./client/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client/connection.js')>()),
  createClientFromProvider: (
    provider: ProviderDef,
    clientOpts: { readonly timeoutMs?: number | undefined } = {},
  ) =>
    ({
      chat: {
        completions: {
          create: async (request: {
            model: string;
            max_tokens?: number;
            messages: { role: string; content: string }[];
          }) => {
            dispatches.push({
              baseURL: provider.baseURL,
              model: request.model,
              maxTokens: request.max_tokens,
              messages: request.messages,
              clientTimeoutMs: clientOpts.timeoutMs,
            });
            return (async function* () {
              yield chunk(request.model, '```ts\nexport const x = 1;\n```', null);
              yield chunk(request.model, null, 'stop');
            })();
          },
        },
      },
    }) as unknown as OpenAI,
}));

function chunk(model: string, content: string | null, finishReason: string | null) {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  };
}

/** One entry of a fake LM Studio native inventory, per port. */
type CatalogModel = Readonly<{
  key: string;
  /** The architectural ceiling the server reports. */
  maximumContextTokens?: number;
  /** The context of the loaded instance, i.e. the active context. */
  activeContextTokens?: number;
}>;

const catalogs = new Map<string, readonly CatalogModel[]>();
let catalogRequests: string[];

function nativeInventory(models: readonly CatalogModel[]): unknown {
  return {
    models: models.map((model) => ({
      key: model.key,
      type: 'llm',
      ...(model.maximumContextTokens !== undefined && {
        max_context_length: model.maximumContextTokens,
      }),
      ...(model.activeContextTokens !== undefined && {
        loaded_instances: [{ id: `${model.key}:0`, context_length: model.activeContextTokens }],
      }),
    })),
  };
}

function catalogFetch(input: unknown): Promise<Response> {
  const url = new URL(String(input));
  catalogRequests.push(`${url.port}${url.pathname}`);
  if (url.pathname !== '/api/v1/models') {
    return Promise.resolve(new Response('not found', { status: 404 }));
  }
  return Promise.resolve(
    new Response(JSON.stringify(nativeInventory(catalogs.get(url.port) ?? [])), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function lmStudioSeat(port: string, model: string, contextLength?: number) {
  return {
    kind: 'api' as const,
    provider: 'lm-studio' as const,
    service: 'lm-studio',
    offering: 'local' as const,
    apiBase: `http://127.0.0.1:${port}/v1`,
    model,
    ...(contextLength !== undefined && { contextLength }),
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    version: 3,
    planner: lmStudioSeat('1234', 'plan-model'),
    implementer: lmStudioSeat('5678', 'build-model'),
    validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
    workflow: { maxRetries: 3, compactionFormat: 'auto' },
    ...overrides,
  } as Config;
}

function authority(
  cfg: Config,
  slot: RunnerSlot,
  runner: Config['planner'],
): RunnerFactoryAuthority {
  const preparationId = `api-runtime-${slot.role}`;
  return {
    preparedConfig: cfg as RunnerFactoryAuthority['preparedConfig'],
    preparationId,
    slot,
    gates: [makeRunnerGate(runner, slot, preparationId)],
  };
}

function preparedSeat(seat: PreparedApiSeat['seat'], port: string, model: string): PreparedApiSeat {
  const apiBase = `http://127.0.0.1:${port}/v1`;
  return { seat, provider: 'lm-studio', apiBase, overrides: { apiBase }, selectionId: model };
}

const MESSAGES = [
  { role: 'system' as const, content: 'You are a careful engineer.' },
  { role: 'user' as const, content: 'Write the smallest change that satisfies the brief.' },
];

let projectDir: string;

beforeEach(() => {
  dispatches.length = 0;
  catalogRequests = [];
  catalogs.clear();
  projectDir = createTempDir('api-runtime-integration');
  vi.stubGlobal('fetch', catalogFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupTempDir(projectDir);
});

describe('three-seat identity and budget', () => {
  it('resolves one budget from identical facts, whatever seat asks', async () => {
    for (const port of ['1234', '4321', '5678']) {
      catalogs.set(port, [
        { key: 'same-model', maximumContextTokens: 200_000, activeContextTokens: 40_000 },
      ]);
    }

    const [plan, review, build] = await Promise.all([
      admitApiCall({
        prepared: preparedSeat('planner', '1234', 'same-model'),
        dispatch: {
          provider: 'lm-studio',
          apiBase: 'http://127.0.0.1:1234/v1',
          model: 'same-model',
        },
        messages: MESSAGES,
      }),
      admitApiCall({
        prepared: preparedSeat('reviewer', '4321', 'same-model'),
        dispatch: {
          provider: 'lm-studio',
          apiBase: 'http://127.0.0.1:4321/v1',
          model: 'same-model',
        },
        messages: MESSAGES,
      }),
      admitApiCall({
        prepared: preparedSeat('implementer', '5678', 'same-model'),
        dispatch: {
          provider: 'lm-studio',
          apiBase: 'http://127.0.0.1:5678/v1',
          model: 'same-model',
        },
        messages: MESSAGES,
        buildTargets: [{ path: 'src/new.ts', action: 'create' }],
      }),
    ]);

    if (plan.kind !== 'admitted' || review.kind !== 'admitted' || build.kind !== 'admitted') {
      throw new Error('every seat should have been admitted');
    }

    // The active context is the budget, the architectural maximum is only a
    // ceiling, and none of it depends on which seat is asking.
    for (const admitted of [plan, review, build]) {
      expect(admitted.context.applicationContextTokens).toBe(40_000);
      expect(admitted.context.budgetSource).toBe('observed-active');
      expect(admitted.context.maximumContextTokens).toBe(200_000);
      expect(admitted.measurement.applicationContextTokens).toBe(40_000);
      expect(admitted.measurement.inputEstimate).toBe(plan.measurement.inputEstimate);
      expect(admitted.measurement.estimationMargin).toBe(plan.measurement.estimationMargin);
      expect(admitted.measurement.outputCap).toBe(plan.measurement.outputCap);
    }
    expect(review.measurement).toEqual(plan.measurement);

    // Only the output reserve is role-shaped: BUILD has to fit a whole file.
    expect(build.measurement.outputReserve).toBeGreaterThan(plan.measurement.outputReserve);
  });

  it('observes and dispatches the review seat on its own endpoint, never the planner one', async () => {
    catalogs.set('1234', [{ key: 'plan-model', activeContextTokens: 40_000 }]);
    catalogs.set('4321', [{ key: 'review-model', activeContextTokens: 40_000 }]);
    const cfg = config({ reviewer: lmStudioSeat('4321', 'review-model') } as Partial<Config>);

    const reviewer = await createReviewer(
      cfg,
      authority(cfg, { role: 'reviewer' }, resolveReviewerRunner(cfg).runner),
    );
    await reviewer.review('review this change', projectDir, { onOutput: () => {} });

    expect(catalogRequests).toEqual(['4321/api/v1/models']);
    expect(dispatches).toEqual([
      expect.objectContaining({ baseURL: 'http://127.0.0.1:4321/v1', model: 'review-model' }),
    ]);

    const planner = await createPlanner(cfg, {
      ...authority(cfg, { role: 'planner' }, cfg.planner),
      initialSessionId: null,
    });
    await callPhase(planner, { projectDir, callbacks: { onOutput: () => {} } });

    expect(catalogRequests).toEqual(['4321/api/v1/models', '1234/api/v1/models']);
    expect(dispatches.at(-1)?.baseURL).toBe('http://127.0.0.1:1234/v1');
  });

  it('refuses when the endpoint or model moved after the seat was prepared', async () => {
    catalogs.set('5678', [{ key: 'build-model', activeContextTokens: 40_000 }]);
    catalogs.set('9999', [{ key: 'other-model', activeContextTokens: 40_000 }]);

    const prepared = config();
    const implementer = createApiImplementer(prepared);
    const moved = config({ implementer: lmStudioSeat('9999', 'other-model') } as Partial<Config>);

    const result = await implementer.implement({
      task: makeTask({ id: 'T001', file: 'src/moved.ts', action: 'create' }),
      projectDir,
      config: moved,
      context: { name: 'p', dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/changed after it was prepared/);
    // The moved endpoint is never contacted, not even for its catalog.
    expect(catalogRequests).toEqual([]);
    expect(dispatches).toEqual([]);
  });

  it('rebudgets against the active context of the moment, and refuses once it is too small', async () => {
    const cfg = config();
    const planner = await createPlanner(cfg, {
      ...authority(cfg, { role: 'planner' }, cfg.planner),
      initialSessionId: null,
    });
    const plan = () => callPhase(planner, { projectDir, callbacks: { onOutput: () => {} } });

    catalogs.set('1234', [{ key: 'plan-model', activeContextTokens: 8_000 }]);
    await plan();
    const roomy = dispatches.at(-1)?.maxTokens;

    // The server reloaded the model with a smaller context between calls.
    catalogs.set('1234', [{ key: 'plan-model', activeContextTokens: 5_000 }]);
    await plan();
    const cramped = dispatches.at(-1)?.maxTokens;

    expect(roomy).toBeDefined();
    expect(cramped).toBeDefined();
    expect(cramped).toBeLessThan(roomy as number);
    expect(cramped).toBe((roomy as number) - 3_000);

    catalogs.set('1234', [{ key: 'plan-model', activeContextTokens: 2_000 }]);
    await expect(plan()).rejects.toMatchObject({ kind: 'api-insufficient-context' });
    expect(dispatches).toHaveLength(2);
  });

  it('bounds a seat that configured no timeout by its own role budget, client included', async () => {
    catalogs.set('1234', [{ key: 'plan-model', activeContextTokens: 40_000 }]);
    catalogs.set('5678', [{ key: 'build-model', activeContextTokens: 40_000 }]);
    const cfg = config();

    const planner = await createPlanner(cfg, {
      ...authority(cfg, { role: 'planner' }, cfg.planner),
      initialSessionId: null,
    });
    await callPhase(planner, { projectDir, callbacks: { onOutput: () => {} } });
    expect(dispatches.at(-1)?.clientTimeoutMs).toBe(TIMEOUTS.reviewerMs);

    await createApiImplementer(cfg).implement({
      task: makeTask({ id: 'T003', file: 'src/bounded.ts', action: 'create' }),
      projectDir,
      config: cfg,
      context: { name: 'p', dir: projectDir },
      onOutput: () => {},
    });
    expect(dispatches.at(-1)?.clientTimeoutMs).toBe(TIMEOUTS.implementerMs);

    const bounded = config({
      implementer: { ...lmStudioSeat('5678', 'build-model'), timeout: 90_000 },
    } as Partial<Config>);
    await createApiImplementer(bounded).implement({
      task: makeTask({ id: 'T004', file: 'src/bounded-2.ts', action: 'create' }),
      projectDir,
      config: bounded,
      context: { name: 'p', dir: projectDir },
      onOutput: () => {},
    });
    expect(dispatches.at(-1)?.clientTimeoutMs).toBe(90_000);
  });

  it('refuses rather than asking for a rewrite of current code that does not fit', async () => {
    catalogs.set('5678', [{ key: 'build-model', activeContextTokens: 200_000 }]);
    const cfg = config({
      implementer: lmStudioSeat('5678', 'build-model', 2_000),
    } as Partial<Config>);
    const implementer = createApiImplementer(cfg);
    // A BUILD answer carries the file whole, so the baseline is never cut to
    // fit: the call is refused with its own figures before anything is sent.
    const huge = Array.from({ length: 4_000 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/huge.ts'), huge);

    const result = await implementer.implement({
      task: makeTask({ id: 'T002', file: 'src/huge.ts', action: 'modify', currentCode: huge }),
      projectDir,
      config: cfg,
      context: { name: 'p', dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(
      /needs \d+ output tokens for this call, above the 8192-token output cap\. Nothing was dispatched\./,
    );
    expect(dispatches).toEqual([]);
  });
});
