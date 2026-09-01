import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = join(import.meta.dirname, '../..');

const docs = {
  workflow: readFileSync(join(projectRoot, 'docs/WORKFLOW.md'), 'utf8'),
  approval: readFileSync(join(projectRoot, 'docs/APPROVAL-AND-RECOVERY.md'), 'utf8'),
  taskContract: readFileSync(join(projectRoot, 'docs/TASK-CONTRACT.md'), 'utf8'),
  usage: readFileSync(join(projectRoot, 'docs/USAGE-EXAMPLES.md'), 'utf8'),
  cli: readFileSync(join(projectRoot, 'docs/CLI-REFERENCE.md'), 'utf8'),
  stores: readFileSync(join(projectRoot, 'docs/STORES-AND-UI.md'), 'utf8'),
  planners: readFileSync(join(projectRoot, 'docs/PLANNERS-AND-IMPLEMENTERS.md'), 'utf8'),
  testing: readFileSync(join(projectRoot, 'docs/TESTING.md'), 'utf8'),
  configuration: readFileSync(join(projectRoot, 'docs/CONFIGURATION.md'), 'utf8'),
  howItWorks: readFileSync(join(projectRoot, 'docs/HOW-IT-WORKS.md'), 'utf8'),
  troubleshooting: readFileSync(join(projectRoot, 'docs/TROUBLESHOOTING.md'), 'utf8'),
} as const;

const claims = [
  [
    'workflow-contract-outcome-is-authoritative',
    'workflow',
    'The binary deterministic contract outcome is authoritative; the numeric score is diagnostic telemetry only.',
  ],
  [
    'workflow-bounded-repair-enters-blocked',
    'workflow',
    'After the existing bounded automatic repair is exhausted, persist `CONTRACT BLOCKED` and expose retry, edit, and reject.',
  ],
  [
    'workflow-manual-retry-is-cross-client',
    'workflow',
    'A manual retry is a first-class, no-comment, idempotent operation shared by TUI, RPC, IPC/attach, and headless projections.',
  ],
  [
    'workflow-approval-requires-zero-errors',
    'workflow',
    'Approval is impossible until a current report has zero errors.',
  ],
  [
    'workflow-evidence-spine-binary-primary-line',
    'workflow',
    'The primary line is binary outcome, not score.',
  ],
  ['workflow-v4-state', 'workflow', 'stateVersion: 4'],
  [
    'approval-standard-speckit-policy',
    'approval',
    'standard / Speckit initial and their continuations',
  ],
  ['approval-quick-policy', 'approval', 'Quick | none | retry, edit, reject'],
  [
    'approval-resume-observes-without-calls',
    'approval',
    'resume / attach | restore persisted allowance; make zero calls merely to observe',
  ],
  ['approval-auto-split-has-no-automatic-repair', 'approval', 'auto-split review | none'],
  [
    'approval-observers-make-no-calls',
    'approval',
    'RPC / IPC / headless / native observation | zero calls merely to observe',
  ],
  [
    'task-contract-zero-error-admission',
    'taskContract',
    'A Task Brief may enter implementation only when the current deterministic Brief Quality report has zero errors.',
  ],
  ['task-contract-warnings-non-blocking', 'taskContract', 'Warnings remain non-blocking'],
  [
    'task-contract-no-quality-override',
    'taskContract',
    'an invalid brief must never be advanced through an approval override',
  ],
  [
    'task-contract-quality-artifact',
    'taskContract',
    'The report is written to the session folder as `brief-quality.json`.',
  ],
  [
    'task-contract-durable-recovery-evidence',
    'taskContract',
    'Recovery leaves durable, inspectable evidence for the initial quality result, automatic repair exhaustion, each accepted manual retry, each provider failure, user edits or queued input, and conscious rejection.',
  ],
  ['usage-typed-retry-command', 'usage', '"action": "retry"'],
  ['usage-blocked-refusal-code', 'usage', 'brief_contract_blocked'],
  ['usage-unresolved-outcome', 'usage', 'UNRESOLVED'],
  ['usage-rpc-resume-example', 'usage', 'splitbrief resume --rpc'],
  ['cli-typed-response-envelope', 'cli', '{ "type": "ack" | "error" | "status", ... }'],
  ['cli-comment-free-retry', 'cli', '`retry` needs no fabricated comment.'],
  [
    'cli-headless-recovery-exit',
    'cli',
    'The command fails with exit code 1 for **every** pending recovery status',
  ],
  [
    'cli-live-rpc-attach-rule',
    'cli',
    'Live `continue` / `last` targets reject `--rpc` rather than attaching.',
  ],
  ['stores-review-path', 'stores', '`src/stores/workflow/review.ts`'],
  ['stores-sidebar-breakpoint', 'stores', 'The sidebar rule is exact: it renders iff `cols > 120`'],
  ['stores-full-width-composer', 'stores', 'always terminal-originated: `x = 0`, `width = cols`'],
  [
    'publication-planner-never-canonical',
    'planners',
    'A planner never gains canonical write authority.',
  ],
  [
    'publication-compatibility-projections',
    'planners',
    'the fixed `tasks.md`, `brief-quality.json`, `spec.md`, and `plan.md` files are compatibility projections of that generation',
  ],
  ['publication-owner-commit', 'workflow', 'committed by the sole fenced owner commit'],
  [
    'publication-projections-after-commit',
    'workflow',
    'only after that commit are the fixed `tasks.md` and `brief-quality.json` files',
  ],
  [
    'publication-authority-order',
    'howItWorks',
    'The Task Brief itself is published in authority order.',
  ],
  [
    'publication-projections-never-authority',
    'taskContract',
    'fixed files are projections, never authority.',
  ],
  [
    'transport-exact-tuple',
    'planners',
    'declared transport, terminal contract, containment profile, credential channel, envelope version, and a verified conformance proof',
  ],
  [
    'transport-stdout-final-current-call',
    'planners',
    "`stdout-final` derives the candidate from the current call's authoritative final response only.",
  ],
  [
    'transport-declared-file-lease',
    'planners',
    '`declared-file` hands the child one host-prepared, invocation-unique lease',
  ],
  [
    'transport-no-auto-source',
    'planners',
    'There is no `auto` source, source priority, prose sniffing, or filesystem search.',
  ],
  [
    'transport-configuration-exact-tuple',
    'configuration',
    'The Task Brief compiler admits a backend only on an exact tuple: runtime identity, effective role vector, declared transport, terminal contract, containment profile, credential channel, envelope version, and a verified conformance proof',
  ],
  [
    'compiler-four-item-batches',
    'planners',
    'compiles the manifest in deterministic four-item batches, at most 64 real dispatches per operation, each batch in a fresh detached session scope that cannot read, replace, expire, resume, or report into the workflow planner session',
  ],
  [
    'compiler-finite-batch-size',
    'workflow',
    'deterministic four-item batches, at most 64 real dispatches per operation',
  ],
  [
    'compiler-mode-boundary',
    'planners',
    "standard and speckit run the compiler's detached batches, and quick stays single-call while accepting only a current-call result.",
  ],
  [
    'compiler-fails-closed',
    'planners',
    'returns the typed zero-dispatch refusal `task_compiler_capability_unsupported`, and no combination is downgraded to a weaker mode.',
  ],
  [
    'support-required-baseline',
    'planners',
    'means OpenCode 1.18.15 is the production planner once its full factory-path conformance passes',
  ],
  [
    'support-unsupported-zero-dispatch',
    'planners',
    'means a typed zero-dispatch refusal no matter what a candidate claims',
  ],
  [
    'support-exact-version-bound',
    'configuration',
    'For supported backends, the tested version yields a full capability receipt, while other detected versions are admitted with runtime-drift evidence and a run warning.',
  ],
  [
    'support-conformance-gated-inactive',
    'configuration',
    'Conformance-gated rows stay inactive until their complete row passes; unsupported rows (Copilot, Cursor, Command Code, shell, agent) refuse with typed fail-closed zero dispatches regardless of what a candidate claims.',
  ],
  [
    'support-copilot-cursor-command-code-refused',
    'configuration',
    'Copilot, Cursor, and Command Code stay implementer-side in V1: their planner rows are compiler-unsupported and refuse with a typed zero-dispatch error',
  ],
  [
    'support-shell-planner-refused',
    'configuration',
    'a `shell` planner is compiler-unsupported in V1, because the legacy shell planner lacks compiler containment and final-response conformance',
  ],
  [
    'support-agent-planner-refused',
    'configuration',
    'a `kind: agent` planner is compiler-unsupported in V1, because its ambient session-file behavior violates exact lease ownership',
  ],
  [
    'support-adapter-owned-overrides',
    'configuration',
    'Authority-bearing options are adapter-owned and cannot be overridden.',
  ],
  [
    'support-conformance-factory-proof',
    'testing',
    'The production factory path must prove, per backend and exact version: the effective read-only role, filesystem containment, exact current-call output, final-response semantics, detached sessions, the hard call envelope, hostile configuration handling, credential isolation, and zero dispatch on failed preflight.',
  ],
  [
    'support-live-checks-not-admission',
    'testing',
    'are opt-in drift evidence: they verify reality on a real machine with real credentials and never replace the deterministic matrix as the admission proof',
  ],
  [
    'roles-pinned-and-effect-verified',
    'planners',
    'The role vector is pinned and effect-verified per backend',
  ],
  [
    'roles-missing-role-unsupported',
    'planners',
    'A role that is missing, overridden, falls back, prompts interactively, or cannot be verified makes the backend unsupported for that role.',
  ],
  ['roles-opencode-plan-build', 'planners', '| `opencode` | `--agent plan` | `--agent build` |'],
  ['roles-kilo-plan-code', 'planners', '| `kilo-code` | `--agent plan` | `--agent code --auto` |'],
  [
    'roles-claude-plan-acceptEdits',
    'planners',
    '| `claude-code` | `--permission-mode plan` (Read, Glob, Grep, Plan only) | `--permission-mode acceptEdits` |',
  ],
  [
    'roles-codex-readonly-workspace-write',
    'planners',
    '| `codex` | `--sandbox read-only --ask-for-approval never` exec, ambient config and rules ignored, ephemeral detached | `--sandbox workspace-write --ask-for-approval never` in the staged checkout |',
  ],
  [
    'budget-no-cap-missing-pricing',
    'workflow',
    'pricing alone does not refuse an otherwise eligible bounded recovery operation',
  ],
  [
    'budget-provider-dependent-reservation',
    'workflow',
    'admission records a provider-dependent reservation with the accounting key',
  ],
  ['budget-unknown-never-zero', 'workflow', 'USD is absent or unknown, never `0`.'],
  [
    'budget-maxbudget-fails-closed',
    'workflow',
    'configured, recovery refuses before provider dispatch unless the reservation',
  ],
  [
    'budget-refusal-codes',
    'workflow',
    'spend uses `brief_budget_unknown`, a known finite amount beyond the cap uses',
  ],
  [
    'budget-tracking-paused',
    'workflow',
    'with the coded `tracking_paused` warning instead of being treated as `$0`.',
  ],
  [
    'budget-not-zero-cost-reservation',
    'approval',
    'a provider-dependent reservation is not a zero-cost reservation.',
  ],
  [
    'budget-never-invents-price',
    'planners',
    'SPLITBRIEF never invents a price or synthesises token counts for a runner that reported none',
  ],
  ['budget-unknown-provider-cost-not-zero', 'configuration', 'Unknown provider cost is not zero.'],
  [
    'disposition-exactly-three',
    'workflow',
    'returns exactly one of `ready-for-tasks`, `parked`, or `terminal`.',
  ],
  [
    'disposition-never-inferred',
    'workflow',
    'never inferred from cancellation, failure, task count, score, artifact',
  ],
  ['disposition-parked-retains', 'workflow', 'A parked result retains the recovery epoch'],
  [
    'disposition-parked-zero-calls',
    'workflow',
    'zero implementer or task-loop calls. A terminal result never enters execution.',
  ],
  [
    'disposition-how-it-works',
    'howItWorks',
    'Planning ends in exactly one of three dispositions: `ready-for-tasks`,',
  ],
  ['disposition-observation-no-repair', 'troubleshooting', 'Observation never retries or repairs.'],
  ['permit-only-current', 'workflow', 'Only a current execution permit authorizes task execution.'],
  [
    'permit-only-current-approval',
    'approval',
    'Only a current execution permit authorizes task execution.',
  ],
  [
    'permit-only-current-task-contract',
    'taskContract',
    'Only a current execution permit authorizes task execution.',
  ],
  [
    'permit-ready-plus-persisted',
    'workflow',
    '`runTasksAndReview` requires `ready-for-tasks` plus a persisted permit matching',
  ],
  [
    'permit-proposal-only',
    'workflow',
    'because the planning result is only a proposal and the persisted',
  ],
  [
    'permit-unapproved-non-executable',
    'workflow',
    'A published but unapproved generation is explicitly',
  ],
  [
    'ui-contract-first-surface',
    'howItWorks',
    'The brief review surface is contract-first: it leads with `CONTRACT READY` or `CONTRACT BLOCKED`, the durable cause, and the valid actions. Score and task count are diagnostic only.',
  ],
  ['ui-score-task-count-diagnostic-stores', 'stores', 'Score and task count are diagnostic only.'],
  ['ui-score-task-count-diagnostic-how', 'howItWorks', 'Score and task count are diagnostic only.'],
  [
    'ui-primary-status-binary',
    'stores',
    'outcome — `CONTRACT READY`, `CONTRACT BLOCKED`, or the corresponding non-ready',
  ],
  [
    'ui-projection-wins-over-score',
    'stores',
    'render as the primary state, never `0 tasks · quality 0.80`.',
  ],
  [
    'prohibited-planner-mode-no-authority',
    'planners',
    'Planner mode does not grant artifact authority.',
  ],
  [
    'prohibited-flag-bounds-not-proof',
    'planners',
    'A `--agent plan`, `--permission-mode plan`, or `--sandbox read-only` flag bounds what the tool may do; it does not prove what the process could reach, what its output means, or that an artifact is fresh.',
  ],
  [
    'prohibited-no-cli-flag-proves',
    'configuration',
    'Planner mode does not grant artifact authority, and no CLI flag proves read-only behavior.',
  ],
  [
    'prohibited-flag-not-effect-proof',
    'testing',
    'Planner mode does not grant artifact authority.',
  ],
  ['prohibited-unknown-cost-not-zero', 'configuration', 'Unknown provider cost is not zero.'],
] as const;

const REQ_050_DIMENSIONS = [
  'publication',
  'transport',
  'compiler',
  'support',
  'roles',
  'budget',
  'disposition',
  'permit',
  'ui',
  'prohibited',
] as const;

const ALL_DOCS = Object.values(docs).join('\n');

describe('Brief Recovery documentation contract', () => {
  it('keeps the canonical claim matrix at 89 behaviors', () => {
    expect(claims).toHaveLength(89);
  });

  it.each(REQ_050_DIMENSIONS)('names at least one REQ-050 claim in dimension %s', (dimension) => {
    const named = claims.filter(([id]) => id.startsWith(`${dimension}-`));
    expect(named.length, `no ${dimension} claims in the matrix`).toBeGreaterThan(0);
  });

  it.each(claims)('%s is stated exactly in its canonical document', (_id, document, claim) => {
    expect(docs[document], `${document} is missing: ${claim}`).toContain(claim);
  });

  it('never claims a CLI flag alone proves read-only behavior', () => {
    for (const claim of ['a flag proves', 'flag by itself proves', 'flag itself proves']) {
      expect(ALL_DOCS, `docs must not claim "${claim}"`).not.toContain(claim);
    }
  });

  it('never claims unknown cost equals zero', () => {
    for (const claim of [
      'unknown cost equals zero',
      'unknown cost is zero',
      'unknown cost is treated as zero',
      'unknown cost is 0',
    ]) {
      expect(ALL_DOCS, `docs must not claim "${claim}"`).not.toContain(claim);
    }
  });
});
