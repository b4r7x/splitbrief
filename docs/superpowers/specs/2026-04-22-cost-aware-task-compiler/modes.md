# Modes

Diptych keeps four presets. They are positioning tools, not the product itself.

| Mode | Planner work | Ceremony | Default fit |
|---|---|---|---|
| `instant` | Minimal planning, direct Task Brief output | Lowest | Tiny fixes, renames, obvious one-step changes |
| `quick` | Short planning pass that still produces a Task Brief | Low | Small tasks that need a little structure |
| `standard` | Complete planning pass and Task Brief compilation | Medium | Normal feature work |
| `speckit` | Spec-driven planning with extra checks and review depth | High | Large, risky, cross-team, or compliance-sensitive work |

## Positioning

### `instant`

Use when the user wants speed and the task is trivial enough that extra ceremony would only add cost.

The planner should produce the narrowest useful Task Brief and move on.

### `quick`

Use when the task is still small, but the implementer should not guess.

This is the default “small work” mode: the planner adds just enough structure to keep execution honest.

### `standard`

Use for ordinary feature work.

This is the balanced mode: enough planning to reduce rework, not so much that every request turns into a project.

### `speckit`

Use when the work is large, risky, externally visible, or needs stronger traceability.

This mode is for situations where the planner should spend more to reduce downstream ambiguity, and where the final evidence matters as much as the implementation itself.

## Mode guidance

- Prefer `instant` for obvious edits.
- Prefer `quick` when the task is small but not trivial.
- Prefer `standard` for most feature work.
- Prefer `speckit` when the cost of a mistake is high or the handoff needs to be audited.

## Positioning rule

The mode should reflect the cost and risk of the work, not the user’s habit.

The product should make it easier to choose less ceremony for small work and more ceremony for serious work.
