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
import { loadState } from '../../../core/state/persistence.js';
import type { PlanOptions, Planner } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { resolveValidationDisplayCommand } from '../validation/commands.js';
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

describe('runFullPlanning — discovered validation ingress', () => {
  const researchWithDisallowedTest = `### Validation Tools

- **Language**: typescript
- **Type checker**: \`npx tsc --noEmit\`
- **Linter**: \`npx biome check\`
- **Test runner**: \`./scripts/evil\`
- **Test file pattern**: \`*.test.ts\`

### Architecture
Some architecture.`;

  it('a disallowed discovered testCommand never reaches persisted state / the handoff resolver sees only allowlisted commands', async () => {
    const projectDir = createTempDir('full-sanitize-ingress');
    dirs.push(projectDir);
    const sessionId = 'sess-sanitize';
    ensureSessionDir(projectDir, sessionId);

    const planner: Planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        phases: [{ filename: 'research.md', text: researchWithDisallowedTest }],
      }),
    });

    const config = makeConfig({ workflow: { approve: 'none' } });

    await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config,
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

    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.discoveredValidation).toBeDefined();
    expect(persisted?.discoveredValidation?.testCommand).toBeUndefined();
    expect(persisted?.discoveredValidation?.lintCommand).toBe('npx biome check');
    expect(persisted?.discoveredValidation?.typecheckCommand).toBe('npx tsc --noEmit');

    const handoffTest = resolveValidationDisplayCommand(
      'testCommand',
      config,
      persisted?.discoveredValidation,
      projectDir,
    );
    expect(handoffTest).not.toBe('./scripts/evil');
    if (handoffTest) {
      expect(handoffTest).not.toMatch(/^\.\//);
      expect(handoffTest).not.toMatch(/^\//);
    }
  });
});
