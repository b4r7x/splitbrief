# Verification: Run Readiness / Doctor

This file describes future implementation verification. This documentation-only pack does not require runtime validation, and it must not run live `diptych start` workflows.

## Targeted Commands

Run after implementation:

```bash
npm run typecheck
npm run lint
npm test
```

Targeted Vitest examples should include the new readiness modules and CLI command tests:

```bash
npx vitest run src/core/readiness src/cli/commands/doctor.test.ts src/cli/commands/start.test.ts src/cli/headless.test.ts
```

If the implementation adds TUI rendering tests, run the matching colocated test files directly, for example:

```bash
npx vitest run src/features/workflow/components/readiness-panel.test.tsx
```

## Stubbed Integration Checks

Use temporary fixture projects and stubbed runner adapters. Do not use real planner/implementer models, network APIs, or the user's working checkout for smoke validation.

Doctor fixture checks:

- run `doctor` against a clean fixture project with a valid `.diptych/config.yaml`;
- expect status `ready` or `ready-with-warnings`;
- expect no session directory, `.diptych/active`, worktree, snapshot, config rewrite, planner call, or implementer call;
- run `doctor --json` against the same fixture and expect stable JSON with `status`, `nextAction`, `sections` or `checks`;
- no API keys, bearer tokens, or environment secrets;
- non-zero exit only for `blocked`.

Invalid config:

- create a temporary fixture with invalid nested runner config;
- run `doctor --json`;
- expect `blocked` and config error details consistent with existing `ConfigError` formatting.

Dirty repo:

- create an unstaged file change and an untracked file in a temporary fixture;
- run `doctor`;
- expect warning with dirty/untracked counts and capped examples;
- do not expect staging, stashing, committing, or reset behavior.

Start fixture checks:

- run `start` only in a disposable fixture configured with stub planner and implementer commands that make no network calls and write only inside the fixture;
- assert readiness appears or is emitted before any stubbed planner/implementer invocation;
- warnings can be continued through;
- blockers stop before model calls and before non-readiness workflow side effects;
- existing setup flow still appears when config is missing and no overrides are supplied.

Headless fixture checks:

- run `start --json` only in a disposable stub-runner fixture;
- expect readiness JSON/event before workflow events that would invoke planner/implementer work;
- blockers fail before model calls, allowing only the compact readiness session record if the implementation requires one;
- warnings are included without blocking.

Detach/worktree fixture checks:

- use a separate disposable fixture and a distinct worktree name such as `readiness-smoke-wt`, with a feature string such as `stubbed readiness worktree smoke`;
- flag combination validation still happens before worktree creation;
- clean-source requirement is preserved;
- readiness does not leave behind `.trees/readiness-smoke-wt` or `diptych/readiness-smoke-wt` on failure.

## Optional Manual Smoke

Manual smoke is optional and should be skipped when targeted tests cover the behavior. If it is used, it must run only in a throwaway fixture or temporary worktree with stubbed `shell` planner and implementer commands, no real model credentials, no network access, and cleanup scoped to that disposable fixture.

## Regression Checks

- `diptych init` behavior is unchanged.
- `diptych status --history` behavior is unchanged.
- `diptych resume` behavior is unchanged.
- `workflow.approve` resolution still flows through `resolveApproveLevel`.
- Existing single `implementer` configs still work when `implementerProfiles` is absent.
- No new `index.ts` barrels appear in `src`.
- No `class`, `useMemo`, `useCallback`, `React.memo`, `forwardRef`, `git add`, `git stage`, `git commit`, or `git stash` is introduced.
