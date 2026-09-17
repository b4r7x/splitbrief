import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
import { phaseInputs } from '#testing/helpers/planner-call.js';
import { createApiPlanner, invokeApiTransport } from '../planners/api.js';
import { createPlannerBase } from '../planners/base.js';
import { ONE_SHOT_API_CAPS } from '../planners/types.js';
import { apiBuildTargets, estimateBundleOutputReserve } from './api-budget.js';
import { readApiContextDiagnostic } from './api-context-diagnostic.js';
import { apiConnectionContextKey } from './selected-model.js';

function config(provider = 'lm-studio', contextLength?: number) {
  return makeConfig({
    planner: {
      kind: 'api',
      provider,
      model: 'fixture-model',
      apiBase: 'http://127.0.0.1:1234/v1',
      apiKey: 'fixture-only',
      ...(contextLength === undefined ? {} : { contextLength }),
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('API planning wire budgets', () => {
  it.each(['planner', 'reviewer'] as const)(
    'keeps a late %s output-cap refusal typed and qualitative',
    async (seat) => {
      const provider = 'fixture-custom';
      const apiBase = 'http://127.0.0.1:1234/v1';
      const create = vi.fn(async (): Promise<never> => {
        throw new Error('must not dispatch');
      });
      let failure: unknown;
      try {
        await invokeApiTransport({
          client: { chat: { completions: { create } } },
          model: 'fixture-model',
          prepared: {
            seat,
            provider,
            apiBase,
            overrides: { apiBase },
            selectionId: 'fixture-model',
          },
          planner: { provider, apiBase, apiKey: 'fixture-only' },
          prompt: 'Review.',
          onOutput() {},
          totalDeadlineMs: 1000,
          callContext: {
            callId: 'fixture',
            role: seat === 'planner' ? 'planner' : 'review',
            backendKind: 'api',
          },
          apiContext: {
            contextKey: apiConnectionContextKey(provider, apiBase),
            selectionId: 'fixture-model',
            observedAt: Date.now(),
            applicationContextTokens: 32_768,
            maximumOutputTokens: 1_024,
            budgetSource: 'observed-active',
            loadState: 'loaded',
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(readApiContextDiagnostic(failure)).toMatchObject({
        seat: seat === 'planner' ? 'plan' : 'review',
        cause: 'output-budget',
        requiredOutputTokens: 2_048,
        outputCap: 1_024,
        budgetSource: 'observed-active',
        omittedRequestOptions: ['temperature', 'stream_options.include_usage'],
      });
      if (!(failure instanceof Error)) throw new Error('expected typed refusal');
      expect(failure.message).not.toMatch(/\d/);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each(['research', 'spec', 'plan', 'tasks'] as const)(
    'sends required source and instructions in %s, including a continuation',
    async (call) => {
      await withTempDir('api-phase-source', async (projectDir) => {
        writeFileSync(join(projectDir, 'a.ts'), 'SOURCE_SENTINEL\n');
        writeFileSync(join(projectDir, 'AGENTS.md'), 'INSTRUCTION_SENTINEL\n');
        const prompts: string[] = [];
        const capture = async ({ prompt }: { prompt: string }): Promise<never> => {
          prompts.push(prompt);
          throw new Error('fixture captured prompt');
        };
        const planner = createPlannerBase({
          invokePlan: capture,
          invokeEscalate: capture,
          isAvailable: async () => true,
          backendKind: 'api',
          planningContextBudget: 100_000,
          capabilities: ONE_SHOT_API_CAPS,
        });
        for (const continuationTurn of [undefined, 'Continue with the requested change.']) {
          await expect(
            planner.runPhase({
              call,
              projectDir,
              callbacks: { onOutput() {} },
              inputs: phaseInputs({
                feature: 'Modify `a.ts`.',
                research: 'Research evidence.',
                spec: 'Specification evidence.',
                plan: 'Plan evidence.',
                ...(continuationTurn === undefined ? {} : { continuationTurn }),
              }),
            }),
          ).rejects.toThrow('fixture captured prompt');
        }
        for (const prompt of prompts) {
          expect(prompt).toContain('SOURCE_SENTINEL');
          expect(prompt).toContain('INSTRUCTION_SENTINEL');
          for (const artifact of [
            'Research evidence.',
            'Specification evidence.',
            'Plan evidence.',
          ]) {
            expect(prompt).toContain(artifact);
          }
          expect(prompt.match(/SOURCE_SENTINEL/g)).toHaveLength(1);
        }
      });
    },
  );

  it('fits optional source against one fresh observation and the actual messages, refreshing on the next call', async () => {
    await withTempDir('api-optional-fit', async (projectDir) => {
      mkdirSync(join(projectDir, 'src'));
      writeFileSync(join(projectDir, 'src/required.ts'), 'REQUIRED_SENTINEL\n');
      writeFileSync(join(projectDir, 'src/optional.ts'), 'OPTIONAL_SENTINEL\n'.repeat(4_000));
      let activeContext = 8_192;
      let probes = 0;
      const requests: { messages: { content: string }[]; max_tokens: number }[] = [];
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/api/v1/models')) {
          probes++;
          return new Response(
            JSON.stringify({
              models: [
                {
                  key: 'fixture-model',
                  type: 'llm',
                  max_context_length: 131_072,
                  loaded_instances: [{ id: 'fixture-model:0', context_length: activeContext }],
                },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        expect(String(url)).toContain('/chat/completions');
        requests.push(JSON.parse(String(init?.body)));
        return makeOpenAiSseResponse([{ content: '# Research\nFindings.', finishReason: 'stop' }]);
      });
      const planner = createApiPlanner(config());
      const plan = () =>
        planner.runPhase({
          call: 'research',
          projectDir,
          callbacks: { onOutput() {} },
          inputs: phaseInputs({
            feature: 'Modify `src/required.ts`.',
            codebaseContext: 'src/optional.ts:\n  optional context',
            priorMessages: [{ role: 'user', content: 'Preserve the public interface.' }],
          }),
        });
      await plan();
      expect(probes).toBe(1);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.max_tokens).toBeGreaterThanOrEqual(2_048);
      const prompt = requests[0]?.messages.at(-1)?.content ?? '';
      expect(prompt).toContain('REQUIRED_SENTINEL');
      expect(prompt).toContain('OPTIONAL_SENTINEL');
      expect(prompt).toContain('src/optional.ts — lines');
      expect(prompt.split('OPTIONAL_SENTINEL').length).toBeLessThan(4_000);
      activeContext = 1_024;
      await expect(plan()).rejects.toMatchObject({ kind: 'api-insufficient-context' });
      expect(probes).toBe(2);
      expect(requests).toHaveLength(1);
    });
  });

  it.each(['planner', 'reviewer'] as const)(
    'refuses a custom %s endpoint below the mandatory reserve without dispatch',
    async (seat) => {
      const fetch = vi.fn(() => {
        throw new Error('unexpected external request');
      });
      vi.stubGlobal('fetch', fetch);
      const planner = createApiPlanner(config('fixture-custom', 512), seat);
      let failure: unknown;
      try {
        await planner.review('Review.', '/tmp', { onOutput() {} });
      } catch (error) {
        failure = error;
      }
      expect(readApiContextDiagnostic(failure)).toMatchObject({
        seat: seat === 'planner' ? 'plan' : 'review',
        cause: 'input-budget',
        requiredOutputTokens: 2_048,
      });
      expect(failure).toBeInstanceOf(Error);
      if (failure instanceof Error) expect(failure.message).not.toMatch(/\d/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('reserves empty existing files as modifications and absent files as creations', () => {
    const targets = apiBuildTargets(
      makeTask({
        file: 'empty.ts',
        action: 'modify',
        currentCode: '',
        files: ['empty.ts', 'other.ts', 'new.ts'],
        currentCodeByFile: { 'other.ts': '' },
      }),
    );
    expect(targets).toEqual([
      { path: 'empty.ts', action: 'modify', content: '' },
      { path: 'other.ts', action: 'modify', content: '' },
      { path: 'new.ts', action: 'create' },
    ]);
    expect(estimateBundleOutputReserve(targets)).toBeLessThan(4_096);
  });
});
