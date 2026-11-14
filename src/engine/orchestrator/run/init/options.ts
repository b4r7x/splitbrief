import type { Attachment } from '../../../../core/schemas/attachment.js';
import type { Config } from '../../../../core/schemas/config.js';
import type { Summary } from '../../../../core/schemas/summary.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import type { SpecMetadata } from '../../../../core/sessions/spec-files.js';
import type { SkillMeta } from '../../../../core/skills/types.js';
import type { UserMessageInput } from '../../../../core/types/user-input.js';
import type { EventSink, EventBus } from '../../../events/types.js';
import type { Implementer } from '../../../implementers/types.js';
import type { Planner } from '../../../planners/types.js';
import type { ModelCacheAccessor } from '../../../providers/model/runtime-snapshot.js';
import type { Reviewer } from '../../../planners/reviewer.js';
import type { PreparedExecution } from '../../../runners/prepare-execution/prepared.js';
import type { RunIsolation } from '../../isolation/types.js';
import type { SummaryBase } from '../../summary/build.js';
import type { StreamingSink } from '../../task/streaming-feed.js';
import type {
  OrchestratorCallbacks,
  WorkflowSinks,
  WorkflowContext,
  ResumeContextHolder,
} from '../../types.js';

export type RunWorkflowOptions = {
  prepared: PreparedExecution;
  callbacks: OrchestratorCallbacks;
  sinks: WorkflowSinks;
  savedState?: WorkflowState | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  signal?: AbortSignal | undefined;
  /**
   * What the operator said when they continued this run. It seeds the first
   * step's continuation, so that step composes it into its own prompt.
   */
  steer?: UserMessageInput | undefined;
  /** Set when the run continues by itself after a boundary park that only changed a seat. */
  resumeCause?: 'seat-change' | undefined;
  /** Headless mode: install one stdout sink (NDJSON, or text under `plain`); the CLI skips the TUI. */
  headless?: boolean | undefined;
  /** `--plain`: the run's single stdout sink renders text instead of NDJSON. */
  plain?: boolean | undefined;
  /** Optional caller-owned sink on the run's bus. The React workflow layer bridges engine events to its stores through it; `runHeadless` under `--plain` keeps the last `error` event from it as the cause of a failed run. */
  tuiSink?: EventSink | undefined;
  /** Test-only: an externally owned bus (the e2e harness supplies one). */
  eventBus?: EventBus | undefined;
  /** Test-only: subscribe an extra sink to the bus (used by integration tests for recording). */
  _eventSink?: EventSink | undefined;
  /** Test-only: inject a pre-built planner (avoids spawning real subprocesses in tests). */
  _planner?: Planner | undefined;
  /** Test-only: inject a pre-built implementer (avoids spawning real subprocesses in tests). */
  _implementer?: Implementer | undefined;
  /** Test-only: inject a pre-built reviewer (avoids spawning real subprocesses in tests). */
  _reviewer?: Reviewer | undefined;
  /** Model cache accessor for pricing/cost lookups — injected from composition layer. */
  modelCache?: ModelCacheAccessor | undefined;
  /** Implementer context length sourced from boot provider detection (not explicit config/CLI/env). Injected from composition layer. */
  detectedContextLength?: number | undefined;
  /** Drains pending attachments from the store — injected from composition layer. */
  drainPendingAttachments?: (() => Attachment[]) | undefined;
  streamingSink?: StreamingSink | undefined;
};

export type InitResult =
  | {
      ok: true;
      state: WorkflowState;
      wctx: WorkflowContext;
    }
  | { ok: false; summary: Summary; bus: EventBus; phase: WorkflowState['phase'] };

export type InitializeWorkflowArgs = {
  opts: RunWorkflowOptions;
  config: Config;
  sessionId: string;
  summaryBase: SummaryBase;
  metadata: SpecMetadata;
  setTrackedState: (s: WorkflowState) => void;
  getTrackedState?: (() => WorkflowState | undefined) | undefined;
  resumeHolder: ResumeContextHolder;
  isolation: RunIsolation;
  savedState?: WorkflowState | undefined;
  newWorkflow?: boolean | undefined;
};
