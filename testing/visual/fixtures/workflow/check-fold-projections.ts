import { taskId } from '../../../../src/core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../../../src/engine/events/types.js';
import { scenarioId } from '../../contracts/identifiers.js';
import { VISUAL_FIXTURE_EPOCH as epoch } from '../common.js';
import { atRestProjections } from './at-rest-projections.js';
import type { WorkflowFixtureProjection } from './projections.js';

type Check = EngineEventOf<'full_suite'>;

/**
 * A check's id and command, then the time its run took or the id of the earlier check whose result
 * it reuses, and the scenario a render check draws.
 */
type CheckRun = readonly [id: string, command: string, ran: number | string, scenario?: string];

const SIGNUP = 'src/features/signup';

const PLAN_CHECKS: readonly CheckRun[] = [
  ['K1', 'npm run typecheck', 14_200],
  ['K2', 'npm run lint', 6_800],
  ['K3', `npx vitest run ${SIGNUP}/validate-email.test.ts`, 2_400],
  ['K4', `npx vitest run ${SIGNUP}/signup-form.test.tsx`, 9_800],
  ['K5', `npx vitest run ${SIGNUP}/password-strength.test.ts`, 1_100],
  ['K6', `npx vitest run ${SIGNUP}/submit-signup.test.ts`, 3_600],
  ['K7', `npx vitest run ${SIGNUP}/signup-route.test.ts`, 4_900],
  ['K8', 'npm run typecheck', 'K1'],
  ['K9', `npx vitest run ${SIGNUP}/server-errors.test.ts`, 400],
  [
    'K10',
    `npx vitest run ${SIGNUP}/signup-form.test.tsx -t "keeps the typed address after a server error"`,
    7_300,
  ],
  ['K11', `npx vitest run ${SIGNUP}/validate-email.test.ts`, 'K3'],
  ['K12', 'npx vitest run src/lib/http/post-json.test.ts', 1_900],
  ['K13', 'npm run lint', 'K2'],
  ['K14', `npx vitest run ${SIGNUP}`, 31_500],
];

const RENDER_CHECKS: readonly CheckRun[] = (
  [
    ['signup-form-empty', 4_200],
    ['signup-form-filled', 4_600],
    ['signup-form-invalid-email', 3_900],
    ['signup-form-weak-password', 4_100],
    ['signup-form-submitting', 5_300],
    ['signup-form-server-error', 4_800],
    ['signup-success', 3_700],
    ['signup-form-narrow', 6_200],
  ] as const
).map(([scenario, ran], index) => [
  `R${index + 1}`,
  `npm run tui-shots -- --scenario ${scenario} --output /tmp/render-r${index + 1}`,
  ran,
  scenario,
]);

const REVIEWER_CHECKS: readonly CheckRun[] = [
  ['V1', 'npm run typecheck', 'K1'],
  ['V2', 'npm test', 16_400],
  ['V3', `npx vitest run ${SIGNUP}/submit-signup.test.ts`, 'K6'],
  ['V4', `npx vitest run ${SIGNUP}`, 'K14'],
  ['V5', `npx vitest run ${SIGNUP}/submit-signup.test.ts --reporter verbose`, 3_800],
  ['V6', 'npx vitest run src/lib/http', 2_700],
  ['V7', 'npx vitest run src/features/auth/session.test.ts', 1_600],
  ['V8', `npx vitest run ${SIGNUP}/password-strength.test.ts --coverage`, 5_900],
  ['V9', 'npx vitest run src/routes/signup.test.ts', 2_200],
  ['V10', `npx vitest run ${SIGNUP}/server-errors.test.ts --retry 0`, 900],
  ['V11', `npx biome check ${SIGNUP}`, 1_400],
  [
    'V12',
    `npx vitest run ${SIGNUP}/signup-form.test.tsx -t "shows the error under the email field"`,
    6_600,
  ],
  ['V13', 'npx vitest run src/features/auth', 4_300],
  ['V14', 'npx tsc --noEmit -p tsconfig.test.json', 9_700],
  ['V15', `npx vitest run ${SIGNUP}/signup-success.test.tsx`, 1_800],
];

/**
 * Green checks run one after the other from `start`. A reused check ends at once and names the end
 * of the run it reuses, which `ended` holds by check id across the calls of one review.
 */
function ranChecks(
  start: number,
  runs: readonly CheckRun[],
  moment: 'plan' | 'pre-review',
  ended: Map<string, number>,
): Check[] {
  let ts = start;
  return runs.map(([id, command, ran, scenario]) => {
    const check = {
      type: 'full_suite',
      phase: 'final-review',
      status: 'done',
      moment,
      id,
      command,
      ...(scenario !== undefined && { scenario }),
      passed: true,
    } as const;
    if (typeof ran === 'number') {
      ts += ran;
      ended.set(id, ts);
      return { ...check, ts, duration: ran };
    }
    const reused = ended.get(ran);
    if (reused === undefined) throw new Error(`Check ${id} reuses ${ran}, which has not run`);
    ts += 100;
    return { ...check, ts, reusedAt: new Date(reused).toISOString() };
  });
}

/**
 * A run's log with the 37 checks of its final review: the plan checks and the renders run before
 * the review call starts, the reviewer checks after it. `edit` changes a check's outcome.
 */
function withFinalReviewChecks(
  log: readonly EngineEvent[],
  edit: (check: Check) => Check,
): EngineEvent[] {
  return log.flatMap((event): EngineEvent[] => {
    if (event.type !== 'review_started') return [event];
    const ended = new Map<string, number>();
    const plan = ranChecks(event.ts - 125_000, [...PLAN_CHECKS, ...RENDER_CHECKS], 'plan', ended);
    const reviewer = ranChecks(event.ts + 500, REVIEWER_CHECKS, 'pre-review', ended);
    return [...plan.map(edit), event, ...reviewer.map(edit)];
  });
}

function atRestBase(id: string) {
  const base = atRestProjections.find((projection) => projection.scenarioId === id);
  const log = base?.atRest?.log;
  if (base?.atRest === undefined || typeof log !== 'object') {
    throw new Error(`The check fold fixtures require the run of ${id}`);
  }
  return { base, record: base.atRest.record, log };
}

const ready = atRestBase('workflow-ready-to-apply');

// The final review passed with every check green, and the run waits for Apply.
export const checksFoldProjection: WorkflowFixtureProjection = {
  ...ready.base,
  scenarioId: scenarioId('workflow-final-review-checks-fold'),
  atRest: {
    record: {
      ...ready.record,
      ref: { ...ready.record.ref, sessionId: 'visual-final-review-checks-fold' },
    },
    log: withFinalReviewChecks(ready.log, (check) => check),
  },
};

const override = atRestBase('workflow-ready-override');

// The review failed, a plan check is red with two new failing tests, and a reviewer check did not
// run; the run was accepted as is and waits for Apply.
export const checksFailedProjection: WorkflowFixtureProjection = {
  ...override.base,
  scenarioId: scenarioId('workflow-final-review-checks-failed'),
  atRest: {
    record: {
      ...override.record,
      ref: { ...override.record.ref, sessionId: 'visual-final-review-checks-failed' },
    },
    log: withFinalReviewChecks(override.log, (check): Check => {
      if (check.id === 'K4') {
        return {
          ...check,
          passed: false,
          duration: 18_100,
          newFailures: 2,
          preExisting: 0,
          newKeys: [
            `${SIGNUP}/signup-form.test.tsx > rejects an address without a domain`,
            `${SIGNUP}/signup-form.test.tsx > keeps the typed address when the server answers 422 and the field loses focus`,
          ],
        };
      }
      if (check.id !== 'V13') return check;
      return {
        type: 'full_suite',
        ts: check.ts,
        phase: check.phase,
        status: 'not-run',
        moment: check.moment,
        id: check.id,
        command: check.command,
        detail:
          'the command reached for the network, which a check cannot reach: connect ECONNREFUSED 127.0.0.1:5432',
      };
    }),
  },
};

const BASE_PLAN_CHECKS: readonly CheckRun[] = [
  ...PLAN_CHECKS.slice(0, 2),
  ['K3', `npx vitest run ${SIGNUP}`, 31_500],
];

// The final review passed and the run waits for Apply. A reviewer check is red with a pre-existing
// failure only and is red at the run base too; the passed reviewer check passes there.
export const checksBaseProjection: WorkflowFixtureProjection = {
  ...ready.base,
  scenarioId: scenarioId('workflow-final-review-checks-base'),
  atRest: {
    record: {
      ...ready.record,
      ref: { ...ready.record.ref, sessionId: 'visual-final-review-checks-base' },
    },
    log: ready.log.flatMap((event): EngineEvent[] => {
      if (event.type !== 'review_started') return [event];
      const ended = new Map<string, number>();
      const suite = { type: 'full_suite', phase: 'final-review' } as const;
      const typecheck = { ...suite, id: 'V1', command: 'npm run typecheck' } as const;
      const review = { ...suite, id: 'V2', command: 'npm test', moment: 'pre-review' } as const;
      const base = { ...suite, id: 'V2', command: 'npm test', moment: 'base' } as const;
      // The red reviewer check waits on its re-run at the run base, so the re-run ends first.
      return [
        ...ranChecks(event.ts - 53_000, BASE_PLAN_CHECKS, 'plan', ended),
        event,
        ...ranChecks(event.ts + 500, REVIEWER_CHECKS.slice(0, 1), 'pre-review', ended),
        { ...review, ts: event.ts + 700, status: 'running' },
        {
          ...typecheck,
          ts: event.ts + 13_700,
          status: 'done',
          moment: 'base',
          passed: true,
          duration: 13_100,
        },
        { ...base, ts: event.ts + 13_800, status: 'running' },
        { ...review, ts: event.ts + 17_100, status: 'running', waitsOnBase: true },
        { ...base, ts: event.ts + 29_600, status: 'done', passed: false, duration: 15_800 },
        {
          ...review,
          ts: event.ts + 29_700,
          status: 'done',
          passed: false,
          duration: 16_400,
          newFailures: 0,
          preExisting: 1,
          preExistingKeys: ['src/legacy/report.test.ts > total matches the ledger'],
        },
      ];
    }),
  },
};

const RUNNING_BRIEFS = [
  {
    id: taskId('T001'),
    title: 'Add the email and password validators',
    file: `${SIGNUP}/validate.ts`,
  },
  { id: taskId('T002'), title: 'Build the signup form', file: `${SIGNUP}/signup-form.tsx` },
  {
    id: taskId('T003'),
    title: 'Submit the form and show server errors',
    file: `${SIGNUP}/submit.ts`,
  },
] as const;
const RUNNING_BUILD = { tool: 'ollama', model: 'qwen2.5-coder:7b' } as const;
// The gallery's clock stands 42 seconds after the epoch; the running check started twelve seconds
// before it.
const RUNNING_CHECK_START = epoch + 30_000;
const RUNNING_REVIEW_START = RUNNING_CHECK_START - 17_200;
const RUNNING_CHECKS_START = RUNNING_REVIEW_START - 60_000;
const RUNNING_WORKFLOW_START = RUNNING_CHECKS_START - 70_000;
const runningEnded = new Map<string, number>();
const runningPlan = ranChecks(
  RUNNING_CHECKS_START,
  [...PLAN_CHECKS.slice(0, 9), ...RENDER_CHECKS.slice(0, 2)],
  'plan',
  runningEnded,
);

// The final review runs its checks: thirteen are done and the fourteenth still runs.
export const checksRunningProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-final-review-checks-running'),
  feature: 'Add a signup form',
  inputMode: 'normal',
  sidebarVisible: false,
  config: { planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet' } },
  events: [
    {
      type: 'workflow_started',
      ts: RUNNING_WORKFLOW_START,
      phase: 'implementing',
      feature: 'Add a signup form',
    },
    {
      type: 'tasks_planned',
      ts: RUNNING_WORKFLOW_START + 50,
      phase: 'implementing',
      total: RUNNING_BRIEFS.length,
      tasks: RUNNING_BRIEFS.map((brief, index) => ({ ...brief, index, action: 'create' })),
    },
    ...RUNNING_BRIEFS.flatMap((brief, index): EngineEvent[] => [
      {
        type: 'task_started',
        ts: RUNNING_WORKFLOW_START + 1_000 + index * 22_000,
        phase: 'implementing',
        taskId: brief.id,
        title: brief.title,
        index,
        total: RUNNING_BRIEFS.length,
        file: brief.file,
        action: 'create',
        ...RUNNING_BUILD,
      },
      {
        type: 'task_completed',
        ts: RUNNING_WORKFLOW_START + 21_000 + index * 22_000,
        phase: 'implementing',
        taskId: brief.id,
        title: brief.title,
        method: 'local',
        retries: 0,
        duration: 20_000,
        ...RUNNING_BUILD,
      },
    ]),
    ...runningPlan,
    {
      type: 'review_started',
      ts: RUNNING_REVIEW_START,
      phase: 'final-review',
      scope: 'final',
      tool: 'claude-code',
      model: 'sonnet',
    },
    ...ranChecks(
      RUNNING_REVIEW_START + 500,
      REVIEWER_CHECKS.slice(0, 2),
      'pre-review',
      runningEnded,
    ),
    {
      type: 'full_suite',
      ts: RUNNING_CHECK_START,
      phase: 'final-review',
      status: 'running',
      moment: 'pre-review',
      id: 'V3',
      command: `npx vitest run ${SIGNUP}/signup-form.test.tsx -t "shows the error under the email field"`,
    },
  ],
};
