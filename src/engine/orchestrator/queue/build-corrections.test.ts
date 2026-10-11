import { plainUserMessage } from '../../../core/types/user-input.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeMessage, setupProject } from '#testing/helpers/queue.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { briefCorrections } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { ImplementerResult } from '../../implementers/types.js';
import { recordBriefCorrection, transitionAndSave } from '../state-ops.js';
import { clearPendingQueue } from './clear.js';
import { formatDrainedMessages } from './prompt.js';
import { enqueueUserMessage } from './submit.js';
import {
  absorbBuildCorrections,
  absorbBuildCorrectionsById,
  buildCorrectionInput,
  buildSeatSupportsImages,
  publishBuildImagesAsPaths,
  runWithCorrectionPasses,
} from './build-corrections.js';
import { createSteeringPort, type SteerOutcome } from '../../calls/steering.js';
import { createQueueHandler } from './submit.js';
import { createWriteSequencer } from '../serial-executor.js';
import { makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { trackMidCallDelivery } from './mid-call.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import type { ConfiguredProviderRuntime } from '../../detection/provider-outcomes.js';
import { resolveAutoModel } from '../../../core/providers/model-selection.js';

describe('buildSeatSupportsImages', () => {
  const config = makeConfig({
    implementer: { kind: 'api', provider: 'lm-studio', model: 'fixture' },
  });
  const catalog = {
    lmstudio: {
      id: 'lmstudio',
      models: { fixture: { id: 'fixture', modalities: { input: ['text', 'image'] } } },
    },
  };

  it.each([true, false])('uses the runtime image fact %s before the catalog', (supportsImages) => {
    expect(
      buildSeatSupportsImages({
        config,
        modelCache: {
          getProviderModels: () => [{ id: 'fixture', supportsImages }],
          getModelsDevCatalog: () => catalog,
        },
      }),
    ).toBe(supportsImages);
  });

  it.each([null, [{ id: 'fixture' }]])(
    'uses the catalog when runtime has no image fact: %j',
    (models) => {
      expect(
        buildSeatSupportsImages({
          config,
          modelCache: {
            getProviderModels: () => models,
            getModelsDevCatalog: () => catalog,
          },
        }),
      ).toBe(true);
    },
  );

  it('resolves the automatic model before looking up its image fact', () => {
    const automatic = makeConfig({
      implementer: { kind: 'api', provider: 'ollama', model: 'auto' },
    });
    const id = resolveAutoModel('auto', 'ollama');
    if (id === undefined) throw new Error('Fixture provider has no automatic model');
    expect(
      buildSeatSupportsImages({
        config: automatic,
        modelCache: {
          getProviderModels: (provider, kind) =>
            provider === 'ollama' && kind === 'api' ? [{ id, supportsImages: true }] : null,
          getModelsDevCatalog: () => null,
        },
      }),
    ).toBe(true);
  });

  it('treats a missing cache and a different model as unknown', () => {
    expect(buildSeatSupportsImages({ config })).toBe(false);
    expect(
      buildSeatSupportsImages({
        config,
        modelCache: {
          getProviderModels: () => [{ id: 'other-model', supportsImages: true }],
          getModelsDevCatalog: () => null,
        },
      }),
    ).toBe(false);
    expect(
      buildSeatSupportsImages({
        config: makeConfig({ implementer: { kind: 'agent', command: 'cat', model: 'fixture' } }),
      }),
    ).toBe(false);
  });
});

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) cleanupTempDir(directory);
});

function setupBuild() {
  const ref = {
    ...setupProject(directories),
    config: makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'fixture' } }),
  };
  const task = makeTask();
  const { bus, events } = makeBusRecorder();
  let state = makeImplState([task]);
  saveState(ref, state);
  const enqueue = (text: string) => {
    state = enqueueUserMessage({
      ...ref,
      state,
      message: plainUserMessage(text),
      phase: 'implementing',
      bus,
    }).state;
  };
  const absorb = () => {
    const result = absorbBuildCorrections({ ...ref, state, taskId: task.id, bus });
    state = result.state;
    return result.count;
  };
  return {
    ref,
    task,
    bus,
    events,
    enqueue,
    absorb,
    getState: () => state,
    correctionOptions: {
      onDiscardedUsage: vi.fn(),
      application: {
        wctx: { ...ref, bus },
        state: () => state,
        task,
        workspacePath: ref.projectDir,
      },
    },
  };
}

describe('buildCorrectionInput', () => {
  it.each([true, false])(
    'uses the BUILD runtime image fact %s when two API seats share a provider',
    (supportsImages) => {
      const build = setupBuild();
      const config = makeConfig({
        planner: {
          kind: 'api',
          provider: 'lm-studio',
          model: 'private-model',
          apiBase: 'http://localhost:1234/v1',
        },
        implementer: { kind: 'api', provider: 'lm-studio', model: 'private-model' },
      });
      const configuredProviders: ConfiguredProviderRuntime[] = [
        {
          connection: { role: 'planner', provider: 'lm-studio', contextKey: 'planner' },
          state: 'fresh',
          catalog: 'populated',
          models: [{ id: 'private-model', supportsImages: !supportsImages }],
          fetchedAt: 1,
          validatedAt: 1,
        },
        {
          connection: { role: 'implementer', provider: 'lm-studio', contextKey: 'implementer' },
          state: 'fresh',
          catalog: 'populated',
          models: [{ id: 'private-model', supportsImages }],
          fetchedAt: 1,
          validatedAt: 1,
        },
      ];
      const modelCache: ModelCacheAccessor = {
        getProviderModels: () => null,
        getModelsDevCatalog: () => ({
          lmstudio: {
            id: 'lmstudio',
            models: { 'public-model': { id: 'public-model' } },
          },
        }),
        getScopedProviderRuntime: ({ role, provider }) =>
          configuredProviders.find(
            ({ connection }) => connection.role === role && connection.provider === provider,
          ) ?? null,
      };
      const images = [
        {
          id: 'reference',
          kind: 'image' as const,
          path: '/reference.png',
          mimeType: 'image/png',
          sizeBytes: 12,
        },
      ];
      const state = recordBriefCorrection(
        build.ref,
        build.getState(),
        build.task.id,
        'use the image',
        images,
      );
      const input = buildCorrectionInput(state, build.task, { config, modelCache });
      publishBuildImagesAsPaths({
        config,
        modelCache,
        state,
        taskId: build.task.id,
        bus: build.bus,
        count: images.length,
      });

      expect(input.images).toEqual(supportsImages ? images : undefined);
      expect(input.continuation).toEqual({ steer: 'use the image' });
      expect(build.events).toEqual(
        supportsImages
          ? []
          : [
              expect.objectContaining({
                type: 'build_images_as_paths',
                phase: 'implementing',
                taskId: build.task.id,
                count: 1,
              }),
            ],
      );
    },
  );
});

describe('recordBriefCorrection', () => {
  it('persists and deduplicates correction images on the task lineage', () => {
    const build = setupBuild();
    const image = {
      id: 'reference',
      kind: 'image' as const,
      path: '/reference.png',
      mimeType: 'image/png',
      sizeBytes: 12,
    };
    const first = recordBriefCorrection(
      build.ref,
      build.getState(),
      build.task.id,
      'use the image',
      [image],
    );
    const duplicate = recordBriefCorrection(build.ref, first, build.task.id, 'use the image', [
      image,
    ]);
    expect(duplicate.stateRevision).toBe(first.stateRevision);
    const saved = loadState(build.ref);
    if (saved === null) throw new Error('Correction was not saved');
    expect(buildCorrectionInput(saved, build.task, build.ref)).toEqual({
      images: [image],
      continuation: { steer: 'use the image' },
    });
    expect(buildCorrectionInput(saved, makeTask({ id: 'T099' }), build.ref)).toEqual({});
    expect(
      buildCorrectionInput(saved, makeTask({ id: 'T002', parentId: build.task.id }), build.ref),
    ).toEqual(buildCorrectionInput(saved, build.task, build.ref));
  });

  it('rebases a stale caller before recording a new correction', () => {
    const build = setupBuild();
    const stale = build.getState();
    build.enqueue('keep the queue');
    transitionAndSave(build.ref, build.getState(), {
      type: 'RECORD_CORRECTION',
      taskId: build.task.id,
      text: 'keep the saved correction',
    });

    const next = recordBriefCorrection(build.ref, stale, build.task.id, 'add the next correction');

    expect(briefCorrections(next, build.task.id)).toEqual([
      'keep the saved correction',
      'add the next correction',
    ]);
    expect(next.messageQueue[0]?.text).toBe('keep the queue');
    expect(loadState(build.ref)).toEqual(next);
  });

  it('returns the saved head without writing an already recorded correction', () => {
    const build = setupBuild();
    const stale = build.getState();
    const saved = transitionAndSave(build.ref, stale, {
      type: 'RECORD_CORRECTION',
      taskId: build.task.id,
      text: 'keep this correction once',
    });

    const next = recordBriefCorrection(
      build.ref,
      stale,
      build.task.id,
      'keep this correction once',
    );

    expect(next).toEqual(saved);
    expect(loadState(build.ref)).toEqual(saved);
    expect(briefCorrections(next, build.task.id)).toEqual(['keep this correction once']);
  });
});

describe('absorbBuildCorrections', () => {
  it('records two deliveries of the same image separately while retaining one correction image', () => {
    const build = setupBuild();
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'cursor', model: 'fixture' } });
    const image = {
      id: 'repeated',
      kind: 'image' as const,
      path: '/repeated.png',
      mimeType: 'image/png',
      sizeBytes: 12,
    };
    let state = build.getState();
    for (let delivery = 0; delivery < 2; delivery += 1) {
      state = enqueueUserMessage({
        ...build.ref,
        state,
        message: { ...plainUserMessage('Use the reference'), images: [image] },
        phase: 'implementing',
        bus: build.bus,
      }).state;
      state = absorbBuildCorrections({
        ...build.ref,
        config,
        state,
        taskId: build.task.id,
        bus: build.bus,
      }).state;
      expect(buildCorrectionInput(state, build.task, { config }).images).toBeUndefined();
    }
    expect(state.lineages?.T001?.correctionImages).toEqual([image]);
    expect(build.events.filter((event) => event.type === 'build_images_as_paths')).toEqual([
      expect.objectContaining({ taskId: build.task.id, count: 1 }),
      expect.objectContaining({ taskId: build.task.id, count: 1 }),
    ]);
  });

  it.each([
    [
      'vision API',
      makeConfig({ implementer: { kind: 'api', provider: 'lm-studio', model: 'fixture' } }),
      true,
      true,
    ],
    [
      'text API',
      makeConfig({ implementer: { kind: 'api', provider: 'lm-studio', model: 'fixture' } }),
      false,
      false,
    ],
    [
      'unknown API',
      makeConfig({ implementer: { kind: 'api', provider: 'lm-studio', model: 'fixture' } }),
      undefined,
      false,
    ],
    [
      'codex',
      makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'fixture' } }),
      undefined,
      true,
    ],
    [
      'cursor',
      makeConfig({ implementer: { kind: 'cli', tool: 'cursor', model: 'fixture' } }),
      undefined,
      false,
    ],
    [
      'shell',
      makeConfig({ implementer: { kind: 'shell', command: 'cat', model: 'fixture' } }),
      undefined,
      false,
    ],
  ] as const)(
    'gates correction images for %s and records path delivery once',
    (_name, config, vision, supported) => {
      const build = setupBuild();
      const image = {
        id: 'reference',
        kind: 'image' as const,
        path: '/reference.png',
        mimeType: 'image/png',
        sizeBytes: 12,
      };
      const modelCache: ModelCacheAccessor = {
        getModelsDevCatalog: () => null,
        getProviderModels: () =>
          vision === undefined ? null : [{ id: 'fixture', supportsImages: vision }],
      };
      const state = enqueueUserMessage({
        ...build.ref,
        state: build.getState(),
        message: { ...plainUserMessage('CORRECTION'), images: [image] },
        phase: 'implementing',
        bus: build.bus,
      }).state;
      const opts = {
        ...build.ref,
        config,
        modelCache,
        state,
        taskId: build.task.id,
        bus: build.bus,
      };
      const result = absorbBuildCorrections(opts);
      const input = buildCorrectionInput(result.state, build.task, { config, modelCache });
      expect(input.images).toEqual(supported ? [image] : undefined);
      expect(input.continuation?.steer).toContain('CORRECTION');
      expect(input.continuation?.steer).toContain('[image:reference] = /reference.png');
      expect(build.events.filter((event) => event.type === 'build_images_as_paths')).toEqual(
        supported
          ? []
          : [expect.objectContaining({ phase: 'implementing', taskId: 'T001', count: 1 })],
      );
      expect(absorbBuildCorrections({ ...opts, state: result.state }).count).toBe(0);
      buildCorrectionInput(result.state, build.task, { config, modelCache });
      expect(build.events.filter((event) => event.type === 'build_images_as_paths')).toHaveLength(
        supported ? 0 : 1,
      );
    },
  );

  it('retains images from the delivered mid-call message and leaves other images pending', () => {
    const build = setupBuild();
    const messages = ['delivered', 'pending'].map((id) => ({
      ...plainUserMessage(`Use the ${id} screenshot`),
      images: [
        { id, kind: 'image' as const, path: `/${id}.png`, mimeType: 'image/png', sizeBytes: 12 },
      ],
    }));
    let state = build.getState();
    for (const message of messages) {
      state = enqueueUserMessage({
        ...build.ref,
        state,
        message,
        phase: 'implementing',
        bus: build.bus,
      }).state;
    }
    const id = state.messageQueue[0]?.id;
    if (id === undefined) throw new Error('Image message was not queued');
    const result = absorbBuildCorrectionsById({
      ...build.ref,
      state,
      taskId: build.task.id,
      bus: build.bus,
      ids: [id],
      via: 'mid-call',
    });
    expect(result.count).toBe(1);
    expect(result.state.messageQueue[0]?.deliveredMidCall).toBe(true);
    expect(result.state.messageQueue[1]?.deliveredTo?.implementer).toBeUndefined();
    const input = buildCorrectionInput(result.state, build.task, build.ref);
    expect(input.images).toEqual(messages[0]?.images);
    expect(input.continuation?.steer).toContain('[image:delivered] = /delivered.png');
    expect(input.continuation?.steer).not.toContain('/pending.png');
  });

  it('delivers only the supplied IDs and keeps the other messages pending', () => {
    const build = setupBuild();
    build.enqueue('deliver this message');
    const id = build.getState().messageQueue[0]?.id;
    if (id === undefined) throw new Error('expected a message');
    build.enqueue('keep this message pending');
    const result = absorbBuildCorrectionsById({
      ...build.ref,
      state: build.getState(),
      taskId: build.task.id,
      bus: build.bus,
      ids: [id],
      via: 'mid-call',
    });

    expect(result.count).toBe(1);
    expect(result.state.messageQueue[0]?.deliveredMidCall).toBe(true);
    expect(result.state.messageQueue[1]?.drainedAt).toBeUndefined();
    expect(briefCorrections(result.state, build.task.id)).toEqual([
      expect.stringContaining('deliver this message'),
    ]);
    expect(briefCorrections(result.state, build.task.id)[0]).not.toContain(
      'keep this message pending',
    );
    expect(
      absorbBuildCorrectionsById({
        ...build.ref,
        state: result.state,
        taskId: build.task.id,
        bus: build.bus,
        ids: [id],
        via: 'mid-call',
      }).count,
    ).toBe(0);
  });

  it('delivers two pending messages as one correction and drains them once', () => {
    const build = setupBuild();
    build.enqueue('keep the parser shared');
    build.enqueue('preserve the error text');

    expect(build.absorb()).toBe(2);
    const saved = loadState(build.ref);
    expect(saved?.messageQueue).toHaveLength(2);
    for (const message of saved?.messageQueue ?? []) {
      expect(message.deliveredTo?.implementer).toBeDefined();
      expect(message.drainedAt).toBeDefined();
    }
    const corrections = briefCorrections(build.getState(), build.task.id);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toContain('keep the parser shared');
    expect(corrections[0]).toContain('preserve the error text');
    expect(build.events.filter((event) => event.type === 'queue_drained')).toEqual([
      expect.objectContaining({ seat: 'build', taskId: build.task.id, count: 2 }),
    ]);

    expect(build.absorb()).toBe(0);
    expect(briefCorrections(build.getState(), build.task.id)).toEqual(corrections);
    expect(build.events.filter((event) => event.type === 'queue_drained')).toHaveLength(1);
  });

  it('leaves drained and natively delivered messages untouched', () => {
    const build = setupBuild();
    const ts = new Date().toISOString();
    const messages = [
      { ...makeMessage('already drained'), id: 'drained', drainedAt: ts },
      {
        ...makeMessage('already native'),
        id: 'native',
        deliveredViaNative: true,
        nativeDeliveryState: 'delivered' as const,
      },
      {
        ...makeMessage('already delivered to BUILD'),
        id: 'build',
        deliveredTo: { implementer: ts },
      },
    ];
    saveState(build.ref, { ...build.getState(), messageQueue: messages });

    expect(build.absorb()).toBe(0);
    expect(loadState(build.ref)?.messageQueue).toEqual(messages);
    expect(briefCorrections(build.getState(), build.task.id)).toEqual([]);
    expect(build.events).toEqual([]);
  });

  it('does not deliver a cleared message from a stale caller', () => {
    const build = setupBuild();
    build.enqueue('never mind');
    clearPendingQueue({ ...build.ref, state: build.getState(), bus: build.bus });

    expect(build.absorb()).toBe(0);
    expect(loadState(build.ref)?.messageQueue).toEqual([]);
    expect(briefCorrections(build.getState(), build.task.id)).toEqual([]);
    expect(build.events.filter((event) => event.type === 'queue_drained')).toEqual([]);
  });

  it('keeps persisted corrections and does not record the same batch twice', () => {
    const build = setupBuild();
    build.enqueue('use the existing formatter');
    const correction = formatDrainedMessages(build.getState().messageQueue).trim();
    let saved = transitionAndSave(build.ref, build.getState(), {
      type: 'RECORD_CORRECTION',
      taskId: build.task.id,
      text: 'keep the public signature',
    });
    saved = transitionAndSave(build.ref, saved, {
      type: 'RECORD_CORRECTION',
      taskId: build.task.id,
      text: correction,
    });

    expect(build.absorb()).toBe(1);
    expect(briefCorrections(build.getState(), build.task.id)).toEqual(
      briefCorrections(saved, build.task.id),
    );
    expect(loadState(build.ref)?.messageQueue[0]?.deliveredTo?.implementer).toBeDefined();
  });
});

describe('runWithCorrectionPasses', () => {
  it.each(['first call', 'correction pass'] as const)(
    'counts completed usage once when stopped while settling delivery after the %s',
    async (call) => {
      const build = setupBuild();
      const controller = new AbortController();
      const delivery = Promise.withResolvers<void>();
      const returned = Promise.withResolvers<void>();
      const completed = { inputTokens: 10, outputTokens: 4 };
      const complete = async (): Promise<ImplementerResult> => {
        trackMidCallDelivery(build.ref, 'pending-delivery', delivery.promise);
        returned.resolve();
        return { success: true, output: 'completed', usage: completed };
      };
      const pass = vi.fn(complete);
      const running = runWithCorrectionPasses({
        ...build.correctionOptions,
        ref: build.ref,
        first:
          call === 'first call'
            ? complete
            : async (): Promise<ImplementerResult> => {
                build.enqueue('correct this brief');
                return {
                  success: true,
                  output: 'first',
                  usage: { inputTokens: 3, outputTokens: 2 },
                };
              },
        pass,
        absorb: build.absorb,
        signal: controller.signal,
      });
      await returned.promise;
      await Promise.resolve();
      controller.abort();
      delivery.resolve();
      const result = await running;
      const expected = call === 'first call' ? completed : { inputTokens: 13, outputTokens: 6 };
      const discarded = build.correctionOptions.onDiscardedUsage.mock.calls;

      expect(result.output).toBe('completed');
      expect(result.usage).toBeUndefined();
      expect(discarded).toEqual([[expected]]);
      expect((result.usage?.inputTokens ?? 0) + (discarded[0]?.[0].inputTokens ?? 0)).toBe(
        expected.inputTokens,
      );
      expect((result.usage?.outputTokens ?? 0) + (discarded[0]?.[0].outputTokens ?? 0)).toBe(
        expected.outputTokens,
      );
      expect(pass).toHaveBeenCalledTimes(call === 'first call' ? 0 : 1);
    },
  );

  it.each(['delivered', 'uncertain'] as const)(
    'settles a %s mid-call message before the correction pass',
    async (outcome) => {
      const build = setupBuild();
      let state = build.getState();
      const steering = createSteeringPort();
      const send = Promise.withResolvers<SteerOutcome>();
      steering.attach({
        callId: 'build-call',
        role: 'implementer',
        taskId: build.task.id,
        send: () => send.promise,
      });
      const handler = createQueueHandler({
        ...build.ref,
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        bus: build.bus,
        planner: makePlanner(),
        serialize: createWriteSequencer(),
        steering,
      });
      const absorb = vi.fn(() => {
        const result = absorbBuildCorrections({
          ...build.ref,
          state,
          taskId: build.task.id,
          bus: build.bus,
        });
        state = result.state;
        return result.count;
      });
      const pass = vi.fn(async () => ({ success: true }));
      const returned = Promise.withResolvers<void>();
      const running = runWithCorrectionPasses({
        ...build.correctionOptions,
        ref: build.ref,
        first: async () => {
          await handler(plainUserMessage('keep the correction'), 'implementing');
          returned.resolve();
          return { success: true };
        },
        pass,
        absorb,
      });
      await returned.promise;
      await Promise.resolve();
      expect(absorb).not.toHaveBeenCalled();

      send.resolve(outcome);
      await running;

      expect(pass).toHaveBeenCalledTimes(outcome === 'delivered' ? 0 : 1);
      expect(briefCorrections(state, build.task.id)).toHaveLength(1);
      if (outcome === 'uncertain')
        expect(briefCorrections(state, build.task.id)[0]).toContain(
          'You may have seen this message already during your last call:',
        );
      expect(build.events.filter((event) => event.type === 'queue_drained')).toHaveLength(1);
    },
  );

  it.each(['throw', 'return'] as const)(
    'preserves completed usage when an interrupted pass exits by %s',
    async (exit) => {
      const build = setupBuild();
      const controller = new AbortController();
      const discarded: ImplementerResult['usage'][] = [];
      const onDiscardedUsage = (usage: NonNullable<ImplementerResult['usage']>) => {
        discarded.push(usage);
      };
      const pending = runWithCorrectionPasses({
        ...build.correctionOptions,
        ref: build.ref,
        first: async (): Promise<ImplementerResult> => {
          build.enqueue('correct this brief');
          return { success: true, output: 'first', usage: { inputTokens: 10, outputTokens: 4 } };
        },
        pass: async (): Promise<ImplementerResult> => {
          controller.abort();
          if (exit === 'throw') throw new DOMException('Stopped', 'AbortError');
          return { success: false, output: '', usage: { inputTokens: 2, outputTokens: 1 } };
        },
        absorb: build.absorb,
        signal: controller.signal,
        onDiscardedUsage,
      });

      if (exit === 'throw') await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      else expect((await pending).usage).toEqual({ inputTokens: 2, outputTokens: 1 });
      expect(discarded).toEqual([{ inputTokens: 10, outputTokens: 4 }]);
    },
  );

  it.each(['success', 'failure', 'abort'] as const)(
    'records the first application before absorbing or returning after %s',
    async (outcome) => {
      const build = setupBuild();
      const controller = new AbortController();
      const applied: ImplementerResult = {
        success: outcome !== 'failure',
        output: 'first',
        applyResult: {
          callId: 'first-call',
          status: 'applied',
          candidatePaths: ['src/owned.ts'],
          applied: [
            {
              path: 'src/owned.ts',
              action: 'create',
              beforeSha256: null,
              afterSha256: 'a1',
              diff: '',
              linesAdded: 1,
              linesRemoved: 0,
            },
          ],
          noops: [],
          untouched: [],
        },
      };
      const receipt = () =>
        readEvidenceLedger(build.ref)?.tasks.find((entry) => entry.id === build.task.id)?.apiApply;
      const pass = vi.fn(async (): Promise<ImplementerResult> => {
        expect(receipt()?.callId).toBe('first-call');
        return { success: false, output: 'transport failed' };
      });
      const absorb = vi.fn(() => {
        expect(receipt()?.callId).toBe('first-call');
        return build.absorb();
      });

      await runWithCorrectionPasses({
        ...build.correctionOptions,
        ref: build.ref,
        first: async () => {
          build.enqueue('keep the creation');
          if (outcome === 'abort') controller.abort();
          return applied;
        },
        pass,
        absorb,
        signal: controller.signal,
        application: {
          wctx: { ...build.ref, bus: build.bus },
          state: build.getState,
          task: build.task,
          workspacePath: build.ref.projectDir,
        },
      });

      expect(receipt()?.callId).toBe('first-call');
      expect(pass).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
    },
  );

  it('corrects the same brief after a message arrives during the first call and sums usage', async () => {
    const build = setupBuild();
    const first = vi.fn(async (): Promise<ImplementerResult> => {
      build.enqueue('name the helper parseAmount');
      return {
        success: true,
        output: 'first',
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, reasoningTokens: 2 },
      };
    });
    const steers: string[] = [];
    const pass = vi.fn(async (): Promise<ImplementerResult> => {
      steers.push(briefCorrections(build.getState(), build.task.id).join('\n\n'));
      return {
        success: true,
        output: 'corrected',
        usage: { inputTokens: 7, outputTokens: 5, cacheReadTokens: 1, cacheCreateTokens: 6 },
      };
    });

    const result = await runWithCorrectionPasses({
      ...build.correctionOptions,
      ref: build.ref,
      first,
      pass,
      absorb: build.absorb,
    });

    expect(first).toHaveBeenCalledTimes(1);
    expect(pass).toHaveBeenCalledTimes(1);
    expect(steers[0]).toContain('name the helper parseAmount');
    expect(result.output).toBe('corrected');
    expect(result.usage).toEqual({
      inputTokens: 17,
      outputTokens: 9,
      cacheReadTokens: 4,
      cacheCreateTokens: 6,
      reasoningTokens: 2,
    });
  });

  it('runs only the first call when no messages arrive', async () => {
    const build = setupBuild();
    const result = { success: true, output: 'done' };
    const first = vi.fn(async () => result);
    const pass = vi.fn(async () => result);

    expect(
      await runWithCorrectionPasses({
        ...build.correctionOptions,
        ref: build.ref,
        first,
        pass,
        absorb: build.absorb,
      }),
    ).toEqual(result);
    expect(first).toHaveBeenCalledTimes(1);
    expect(pass).not.toHaveBeenCalled();
  });

  it('leaves pending messages for the retry after a failed first call', async () => {
    const build = setupBuild();
    const failure = { success: false, output: 'failed', error: 'invalid code' };
    const first = async () => {
      build.enqueue('keep the error');
      return failure;
    };
    const pass = vi.fn(async () => failure);

    expect(
      await runWithCorrectionPasses({
        ...build.correctionOptions,
        ref: build.ref,
        first,
        pass,
        absorb: build.absorb,
      }),
    ).toEqual(failure);
    expect(pass).not.toHaveBeenCalled();
    expect(loadState(build.ref)?.messageQueue[0]?.deliveredTo?.implementer).toBeUndefined();
    expect(briefCorrections(build.getState(), build.task.id)).toEqual([]);
  });

  it('leaves pending messages when the signal aborts during the first call', async () => {
    const build = setupBuild();
    const controller = new AbortController();
    const success = { success: true, output: 'done' };
    const first = async () => {
      build.enqueue('wait for me');
      controller.abort();
      return success;
    };
    const pass = vi.fn(async () => success);

    await runWithCorrectionPasses({
      ...build.correctionOptions,
      ref: build.ref,
      first,
      pass,
      absorb: build.absorb,
      signal: controller.signal,
    });

    expect(pass).not.toHaveBeenCalled();
    expect(loadState(build.ref)?.messageQueue[0]?.deliveredTo?.implementer).toBeUndefined();
  });

  it('runs another pass for a message that arrives during a correction pass', async () => {
    const build = setupBuild();
    const first = async () => {
      build.enqueue('first correction');
      return { success: true, output: 'first', usage: { inputTokens: 1, outputTokens: 2 } };
    };
    const steers: string[] = [];
    const pass = vi.fn(async () => {
      steers.push(briefCorrections(build.getState(), build.task.id).join('\n\n'));
      if (steers.length === 1) build.enqueue('second correction');
      return {
        success: true,
        output: `pass ${steers.length}`,
        usage: { inputTokens: 3, outputTokens: 4 },
      };
    });

    const result = await runWithCorrectionPasses({
      ...build.correctionOptions,
      ref: build.ref,
      first,
      pass,
      absorb: build.absorb,
    });

    expect(pass).toHaveBeenCalledTimes(2);
    expect(steers[0]).toContain('first correction');
    expect(steers[0]).not.toContain('second correction');
    expect(steers[1]).toContain('first correction');
    expect(steers[1]).toContain('second correction');
    expect(result.output).toBe('pass 2');
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 10 });
    expect(
      loadState(build.ref)?.messageQueue.every((m) => m.deliveredTo?.implementer !== undefined),
    ).toBe(true);
  });

  it('returns a failed pass with all usage and leaves later messages pending', async () => {
    const build = setupBuild();
    const first = async () => {
      build.enqueue('first correction');
      return { success: true, output: 'first', usage: { inputTokens: 1, outputTokens: 2 } };
    };
    const pass = vi.fn(async () => {
      build.enqueue('next correction');
      return {
        success: false,
        output: 'failed pass',
        error: 'bad edit',
        usage: { inputTokens: 3, outputTokens: 4 },
      };
    });

    const result = await runWithCorrectionPasses({
      ...build.correctionOptions,
      ref: build.ref,
      first,
      pass,
      absorb: build.absorb,
    });

    expect(pass).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: false,
      output: 'failed pass',
      error: 'bad edit',
      usage: { inputTokens: 4, outputTokens: 6 },
    });
    expect(
      loadState(build.ref)?.messageQueue.find((m) => m.text === 'next correction')?.deliveredTo
        ?.implementer,
    ).toBeUndefined();
  });
});
