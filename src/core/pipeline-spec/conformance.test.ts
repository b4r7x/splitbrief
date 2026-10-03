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
import {
  consultCallAnswering,
  guidanceConsult,
  planFromTasks,
  typedCallAnswering,
} from '#testing/helpers/typed-planner.js';
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
import { VALIDATION_STAGES } from '../schemas/enums.js';
import { GenerationCommonFields } from '../schemas/runner-fields.js';
import { ReviewVerdictSchema } from '../schemas/summary.js';
import { transition } from '../state/machine.js';
import { BOUNDS } from './bounds.js';
import { sliceRuleText } from './brief.js';
import { DIVERGENCE_TABLE } from './divergences.js';
import { CAPTURE_LIMITS, GATE_ORDER } from './gates.js';
import { HALT_SIGNATURES } from './halts.js';
import { LADDER, RETRY_FRAMINGS } from './ladder.js';
import { DEFAULT_LOCAL_RETRIES } from './retries.js';
import { VERDICT_RULES } from './review.js';
import { TIMEOUTS } from './timeouts.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('retry budget', () => {
  it('the ladder spends one local retry from the pipeline spec', () => {
    expect(DEFAULT_LOCAL_RETRIES).toBe(1);
    expect(LADDER.filter((rung) => rung.count === 'DEFAULT_LOCAL_RETRIES')).toHaveLength(1);
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

// The retired intermediate and hint rungs publish no `escalate` rows; the
// consult rung answers through the planner's typed session instead.
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

  it('the consult composition is budgeted at 4000 characters', () => {
    expect(BOUNDS.consultFailingOutputChars).toBe(4000);
  });

  it('a brief that never passes spends the local retries then consults the planner', async () => {
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
        config: makeNoValidationConfig(),
        implementer: makeImplementer({
          retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'still broken' }),
        }),
        planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
        bus,
      }),
      task,
      initialError: 'type error',
      currentState: transition(makeImplState([task]), { type: 'TASK_SENT' }),
    });

    expect(events.filter((e) => e.type === 'task_retry')).toHaveLength(DEFAULT_LOCAL_RETRIES);
    expect(events.filter((e) => e.type === 'task_escalating')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'consult_answered').length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.type === 'escalate')).toEqual([]);
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
