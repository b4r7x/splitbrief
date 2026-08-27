import {
  createTaskCompilationAttemptId,
  OwnedPlannerArtifactSchema,
} from '../../../src/core/schemas/task-compilation.js';
import { sha256Hex } from '../../../src/utils/sha256.js';
import { fauxPlanner } from '#testing/helpers/faux/planner.js';

type PhaseLogicalName = 'spec.md' | 'plan.md' | 'tasks.md';

/** One owned planner phase artifact, digest-consistent with its own text. */
export function phaseResult(input: {
  logicalName: PhaseLogicalName;
  text: string;
  semanticIdPrefix?: string;
}) {
  const { logicalName, text, semanticIdPrefix = 'test' } = input;
  const digest = sha256Hex(text);
  const semanticId = `${semanticIdPrefix}-${logicalName}`;
  return {
    artifact: OwnedPlannerArtifactSchema.parse({
      semanticId,
      programId: null,
      batchId: null,
      attemptId: createTaskCompilationAttemptId(),
      logicalName,
      transport: 'stdout-final',
      text,
      byteLength: Buffer.byteLength(text, 'utf8'),
      sha256: digest,
      runtimeReceipt: digest,
      terminal: { status: 'completed', recordId: semanticId, protocolDigest: digest },
      sourceReceipt: { kind: 'stdout-final', resultDigest: digest },
    }),
  };
}

/** A planner whose plan admits spec and plan but yields no parseable Task Brief, twice. */
export function zeroTaskPlanner(): {
  planner: ReturnType<typeof fauxPlanner>['planner'];
  planCallCount: () => number;
  repairCallCount: () => number;
} {
  const prepared = fauxPlanner({
    plans: [
      {
        spec: '# Admitted Specification\n\nThe workflow must fail closed.',
        plan: '# Admitted Plan\n\nGenerate and validate Task Briefs.',
        tasks: [],
      },
    ],
  });
  const originalPlan = prepared.planner.plan.bind(prepared.planner);
  prepared.planner.plan = async (opts) => {
    const result = await originalPlan(opts);
    return {
      ...result,
      phases: [
        phaseResult({ logicalName: 'spec.md', text: result.spec }),
        phaseResult({ logicalName: 'plan.md', text: result.plan }),
        phaseResult({ logicalName: 'tasks.md', text: 'The planner returned no Task Brief.' }),
      ],
    };
  };

  let repairCallCount = 0;
  prepared.planner.review = async () => {
    repairCallCount += 1;
    return {
      text: 'The tasks-only repair still contains no parseable Task Brief.',
      usage: null,
    };
  };

  return {
    planner: prepared.planner,
    planCallCount: () => prepared.state.planCallCount,
    repairCallCount: () => repairCallCount,
  };
}
