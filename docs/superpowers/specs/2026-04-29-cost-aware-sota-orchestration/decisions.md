# Decisions

## D1 - Use Superpowers Briefs For Implementation

Use `docs/superpowers/specs/.../agent-briefs/*` as the implementation handoff format.

Reason: this work is explicitly meant for multiple fresh AI contexts. Superpowers briefs let the coordinator keep only the decision map while workers receive small, executable slices.

## D2 - Defaults Stay Cheap And Deterministic

Deterministic estimates, static profile readiness, routing previews, and trace summaries are default surfaces.

Planner-powered estimate review is opt-in.

Reason: calling the smarter model to decide whether to save money can erase the saving. The user should choose when extra judgment is worth the cost.

## D3 - The User Selects Models

Diptych should not silently decide that a different planner or implementer should be used.

It may show estimate data, profile fit, confidence, and warnings in diagnostics. It may route among user-configured implementer profiles if that is already the configured product behavior. It must not invent a smarter model assignment by itself.

## D4 - Warnings Are Silent In Normal Start

Normal start should show blockers only.

Warnings and info belong in:

- `diptych doctor`
- `diptych doctor --json`
- trace/explain artifacts
- detailed review surfaces when the user opens them.

Reason: warnings are useful when debugging but noisy during normal use. A missing `contextLength` is not a reason to interrupt the user if a conservative fallback exists.

## D5 - Missing Optional Profile Metadata Is Non-Breaking

These are not blockers by themselves:

- missing `contextLength`
- missing `costTier`
- inferred `writesFiles`
- unavailable non-default profile
- unpriced profile

They should lower confidence, use conservative fallbacks, skip unavailable profiles when possible, or appear in doctor output.

They become blockers only when no usable implementer remains for the requested run.

## D6 - Task Review Gate Is Opt-In

Default should remain fast:

```text
taskReview: "none"
```

Supported values should be:

```text
none | failed | every
```

`failed` can be considered later as a friendlier default only after the UX is proven.

## D7 - Auto-Split Is Opt-In And Narrow

Auto-split should only target tasks that overflow cheap implementer context or have low routing confidence.

It must not rewrite the whole plan by default. It should preserve user edits and make the split visible before execution.

## D8 - Parallel Worktrees Are Deferred

Parallel isolated worktrees may help later, but not in this pack.

Reason: the hard part is not spawning workers. The hard part is merge/review/integration, which likely needs the smarter planner or a strong deterministic merge strategy. That can increase cost and complexity before the core sequential product is excellent.

## D9 - Behavior Tests Only

Do not add tests for tiny hook wrappers or private helper call counts.

Test:

- CLI output and exit behavior
- generated artifacts
- routing decisions
- rendered review/summary output
- readiness blocker/warning classification
- user-visible task review state

## D10 - Main Context Does Not Implement Everything

The main context should:

- read docs and current code shape,
- assign bounded briefs,
- review diffs,
- run validation,
- synthesize the final result.

It should not carry every implementation detail in one large context.
