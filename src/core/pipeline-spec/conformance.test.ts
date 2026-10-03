import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeNoValidationConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import {
  makeBusRecorder,
  makeImplementer,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { runOwnedPlanningPhase } from '#testing/helpers/planning-phase.js';
import { planFromTasks, typedCallAnswering } from '#testing/helpers/typed-planner.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { renderBlock } from '../../../scripts/skill-blocks.js';
import { handleRetryAndEscalation } from '../../engine/orchestrator/escalation/handle.js';
import {
  MAX_TEST_TAIL_LINES,
  MAX_VALIDATION_OUTPUT_CHARS,
} from '../../engine/orchestrator/validation/stage.js';
import { parseFinalReview } from '../../engine/parsers/final-review.js';
import type { Planner } from '../../engine/planners/types.js';
import { isAuthFailureDiagnostic } from '../../engine/runners/auth-failure.js';
import { isUsageLimitDiagnostic } from '../../engine/runners/usage-limit.js';
import { formatRetryPrompt } from '../../engine/spec/prompt-formatter.js';
import { SIGKILL_DELAY_MS } from '../../lib/process/registry.js';
import { createDefaultConfig } from '../config/load/defaults.js';
import { VALIDATION_STAGES } from '../schemas/enums.js';
import { GenerationCommonFields } from '../schemas/runner-fields.js';
import { ReviewVerdictSchema } from '../schemas/summary.js';
import { transition } from '../state/machine.js';
import { sliceRuleText } from './brief.js';
import { DIVERGENCE_TABLE } from './divergences.js';
import { CAPTURE_LIMITS, GATE_ORDER } from './gates.js';
import { HALT_SIGNATURES } from './halts.js';
import { LADDER, MAX_HINT_ERROR_LENGTH, RETRY_FRAMINGS, type LadderRungId } from './ladder.js';
import { DEFAULT_LOCAL_RETRIES } from './retries.js';
import { VERDICT_RULES } from './review.js';
import { TIMEOUTS } from './timeouts.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('retry budget', () => {
  it('the shipped default config spends the pipeline spec retry count', () => {
    expect(createDefaultConfig().workflow.maxRetries).toBe(DEFAULT_LOCAL_RETRIES);
  });
});

describe('gates', () => {
  it('the validation stage enum is the pipeline spec gate order', () => {
    expect([...VALIDATION_STAGES]).toEqual([...GATE_ORDER]);
  });

  it('the stage runner captures the pipeline spec limits', () => {
    expect(MAX_TEST_TAIL_LINES).toBe(CAPTURE_LIMITS.testTailLines);
    expect(MAX_VALIDATION_OUTPUT_CHARS).toBe(CAPTURE_LIMITS.outputChars);
  });
});

// The `takeover` rung has no entry: the planner advises the implementer, it
// never takes the brief over as a code writer, so no escalating tier answers
// for that rung.
const ESCALATION_TIERS: Partial<Record<LadderRungId, number>> = {
  intermediate: 0,
  hint: 1,
};

describe('retry ladder', () => {
  it('a retry past the last framing opens with the final framing', () => {
    const prompt = formatRetryPrompt({
      task: makeTask(),
      context: defaultContext,
      error: 'type error',
      attempt: 5,
    });
    expect(prompt.split('\n')[0]).toBe(RETRY_FRAMINGS[3]);
  });

  it('the hint composition is budgeted at 4000 characters', () => {
    expect(MAX_HINT_ERROR_LENGTH).toBe(4000);
  });

  it('a brief that never passes spends the local retries then escalates in ladder order', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'conformance-ladder',
      sessionId: 'sess-conformance',
    });
    dirs.push(projectDir);
    const { bus, events } = makeBusRecorder();
    const task = makeTask();

    await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: DEFAULT_LOCAL_RETRIES } }),
        implementer: makeImplementer({
          retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'still broken' }),
        }),
        // A planner that says nothing ends the hint rung before it spends an
        // attempt, so the rung only shows up in the ladder when it answers.
        planner: makePlanner({
          escalateHint: vi.fn().mockResolvedValue({
            success: true,
            output: 'Narrow the type at the call site.',
            code: 0,
            usage: null,
          }),
        }),
        bus,
      }),
      task,
      initialError: 'type error',
      currentState: transition(makeImplState([task]), { type: 'TASK_SENT' }),
    });

    expect(events.filter((e) => e.type === 'task_retry')).toHaveLength(DEFAULT_LOCAL_RETRIES);
    // No intermediate profile is configured, so the optional rung is skipped.
    const expected = LADDER.filter((rung) => rung.optional !== true).flatMap((rung) => {
      const tier = ESCALATION_TIERS[rung.id];
      return tier === undefined ? [] : [tier];
    });
    expect(events.filter((e) => e.type === 'escalate').map((e) => e.tier)).toEqual(expected);
    expect(events.filter((e) => e.type === 'task_escalating')).toHaveLength(1);
  }, 60_000);
});

describe('timeouts', () => {
  // The implementer deadline is a runtime bound, not a parse-time cap: a healthy
  // call that outlives it is ended by the deadline, and an operator may configure
  // a runner timeout past it. Only a non-positive timeout fails the schema.
  it('a configured runner timeout may exceed the implementer deadline', () => {
    expect(GenerationCommonFields.timeout.safeParse(TIMEOUTS.implementerMs).success).toBe(true);
    expect(GenerationCommonFields.timeout.safeParse(TIMEOUTS.implementerMs + 1).success).toBe(true);
    expect(GenerationCommonFields.timeout.safeParse(0).success).toBe(false);
  });

  it('the process registry waits the pipeline spec grace period before SIGKILL', () => {
    expect(SIGKILL_DELAY_MS).toBe(TIMEOUTS.sigtermGraceMs);
  });
});

describe('review verdicts', () => {
  it('the summary schema enumerates the pipeline spec verdict words', () => {
    expect([...ReviewVerdictSchema.options]).toEqual([...VERDICT_RULES.words]);
  });

  it('the final-review parser reads exactly the pipeline spec verdict words', () => {
    for (const word of VERDICT_RULES.words) {
      expect(parseFinalReview(`### Verdict\n\n${word}\n`).verdict).toBe(word);
    }
    expect(parseFinalReview('### Verdict\n\napproved\n').verdict).toBeNull();
  });
});

const ANALYZE_JSON = `\`\`\`json
{"specTaskCoverage":1,"planTaskCoverage":1,"orphanTasks":[],"unaddressedSpecSections":[],"warnings":[]}
\`\`\``;

/** Counts one planner call per model round-trip: each planning call, and each review pass. */
function countingPlanner(): { planner: Planner; calls: () => number } {
  let calls = 0;
  const planner = makePlanner({
    typedCall: typedCallAnswering(() => {
      calls += 1;
      return planFromTasks([makeTask()]);
    }),
    review: async () => {
      calls += 1;
      return { text: ANALYZE_JSON, usage: null };
    },
  });
  return { planner, calls: () => calls };
}

describe('planning', () => {
  it('spends one planner call, the planning session', async () => {
    const counted = countingPlanner();
    await runOwnedPlanningPhase(dirs, {
      planner: counted.planner,
      config: makeNoValidationConfig({ workflow: { approve: 'none' } }),
    });
    expect(counted.calls()).toBe(1);
  });

  it('the skills carry the shared grouping rule and no brief-count limit', () => {
    expect(renderBlock('brief-grouping')).toBe(sliceRuleText());
  });
});

describe('divergences', () => {
  it('exactly one divergence between the CLI and the skills stays by design', () => {
    expect(DIVERGENCE_TABLE.filter((row) => row.owner === 'intentional')).toHaveLength(1);
  });
});

describe('halt signatures', () => {
  it('every auth and usage phrase classifies through its runner diagnostic', () => {
    for (const phrase of HALT_SIGNATURES.auth) {
      expect(isAuthFailureDiagnostic(phrase), phrase).toBe(true);
    }
    for (const phrase of HALT_SIGNATURES.usage) {
      expect(isUsageLimitDiagnostic(phrase), phrase).toBe(true);
    }
  });

  it('the rendered shell halt block carries every phrase of every kind', () => {
    const block = renderBlock('halt-signatures-sh');
    for (const phrases of Object.values(HALT_SIGNATURES)) {
      for (const phrase of phrases) expect(block, phrase).toContain(`*'${phrase}'*`);
    }
  });
});
