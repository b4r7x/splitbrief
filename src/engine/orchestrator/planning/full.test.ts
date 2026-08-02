import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeCallbacks,
  makePlanner,
  makeBusRecorder,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import type { PlanOptions, Planner } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { runFullPlanning } from './full.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

async function writeProjectSkill(projectDir: string, id: string, name: string, body: string) {
  const dir = join(projectDir, '.claude', 'skills', id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: a skill\n---\n${body}\n`,
  );
}

describe('runFullPlanning — skill rehydration', () => {
  it('rebuilds skills context from persisted state ids when no live skills are supplied', async () => {
    const projectDir = createTempDir('full-skill-rehydrate');
    dirs.push(projectDir);
    const sessionId = 'sess-skill';
    ensureSessionDir(projectDir, sessionId);
    await writeProjectSkill(projectDir, 'auth-skill', 'AuthSkill', 'PERSISTED-SKILL-BODY');

    let captured: PlanOptions | undefined;
    const planner: Planner = makePlanner({
      plan: vi.fn(async (opts: PlanOptions) => {
        captured = opts;
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }),
    });

    const state = {
      ...transition(createInitialState('feat'), { type: 'START' }),
      selectedSkills: ['auth-skill'],
    };

    await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { approve: 'none' } }),
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state,
      feature: 'feat',
      selectedSkills: undefined,
      approveLevel: 'none',
      deferBriefGate: true,
    });

    expect(captured?.skillsContext).toContain('AuthSkill');
    expect(captured?.skillsContext).toContain('PERSISTED-SKILL-BODY');
  });

  it('omits skills context when neither live nor persisted skills exist', async () => {
    const projectDir = createTempDir('full-skill-none');
    dirs.push(projectDir);
    const sessionId = 'sess-skill-none';
    ensureSessionDir(projectDir, sessionId);

    let captured: PlanOptions | undefined;
    const planner: Planner = makePlanner({
      plan: vi.fn(async (opts: PlanOptions) => {
        captured = opts;
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }),
    });

    await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { approve: 'none' } }),
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state: transition(createInitialState('feat'), { type: 'START' }),
      feature: 'feat',
      selectedSkills: undefined,
      approveLevel: 'none',
      deferBriefGate: true,
    });

    expect(captured?.skillsContext).toBeUndefined();
  });
});

describe('runFullPlanning — questions', () => {
  it('non-conversational planner emitting markers → onQuestionAsked invoked', async () => {
    const projectDir = createTempDir('full-questions');
    dirs.push(projectDir);
    const sessionId = 'sess-questions';
    ensureSessionDir(projectDir, sessionId);

    const question: ClarificationQuestion = { id: 'q1', type: 'confirm', text: 'Proceed?' };
    const planner: Planner = makePlanner({
      plan: vi.fn(async (opts: PlanOptions) => {
        opts.callbacks.onQuestion?.([question]);
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }),
    });
    expect(planner.capabilities.supportsConversationalPlanning).toBe(false);

    const onQuestionAsked = vi.fn().mockResolvedValue('skip');

    await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { approve: 'none' } }),
        callbacks: makeCallbacks({ onQuestionAsked }).callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state: transition(createInitialState('feat'), { type: 'START' }),
      feature: 'feat',
      selectedSkills: undefined,
      approveLevel: 'none',
      deferBriefGate: true,
    });

    expect(onQuestionAsked).toHaveBeenCalledWith(question, 1, 1);
  });
});
