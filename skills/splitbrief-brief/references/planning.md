# Planning

The host session plans once. Research the requested behaviour, affected code, tests, and callers before asking questions.
Use project instruction files and carry every applicable constraint into each brief.
Initialize the run with references/gates.md.

## Planning session

1. Ask at most three questions per round, for at most two rounds.
2. Give each question a default. An empty answer takes the defaults.
3. Record answers and assumptions in the plan artifacts.
4. Write the typed plan below. Keep the behaviour, tests, and callers together under the brief grouping rule.
5. Admit the plan and render briefs with references/brief-format.md.
6. Save `plan.json`, `plan.md`, `tasks.md`, `briefs/index.md`, and one Markdown brief per task.
7. Print the summary, criteria, tasks, dependencies, batches, crew, cadence, validation sources.
8. Print protected operations, selected stages, run directory, and whether `.splitbrief/` is ignored.
9. Apply the optional approval from references/family-map.md after rendering the complete plan and briefs.
10. Record the approval, protected path/operation confirmations, and requested changes for later execution.

## Existing input conversion

An existing typed plan enters admission directly. Do not plan its outcome again.
Convert a prose plan into the same typed contract before dispatch.
Preserve its stated outcome, accepted criteria, exclusions, and decisions.
Add task ids, registered checks, dependencies, and validation commands without changing what the user requested.
Recover the typed contract from a Markdown brief set when those fields are present.
Use references/brief-format.md for Markdown input requirements.
Ask bounded questions only for information the supplied intent and project cannot resolve.
If missing intent prevents a valid contract, pause before dispatch.

## Typed plan

The planning session answers PlanResult. Its transport is `{result: ...}` under PlanAnswerSchema.
Write the plan proposal to `plan.json`; render `plan.md` and `tasks.md` from it.
Use this shape with real ids, commands and paths:

```json
{
  "kind": "plan",
  "summary": "Add a health endpoint",
  "decisions": ["Use the existing router"],
  "criteria": [{"id":"C1","text":"GET /health returns status ok","checkIds":["K1"]}],
  "checks": [],
  "validation": {"language":"typescript","test":"npm test","testPattern":null},
  "tasks": [{
    "id":"T001", "title":"Add the health endpoint", "intent":"Return status ok from GET /health",
    "criteria":["C1"], "checks":[{"id":"K1","kind":"test","value":"src/health.test.ts","required":true}],
    "suggestedFiles":["src/health.ts","src/health.test.ts"], "contextFiles":["src/router.ts"],
    "exclusions":["Do not change authentication behaviour"], "protectedOperations":null,
    "steps":null, "dependsOn":[], "batch":1
  }]
}
```

Keep nullable keys present. Use null when no validation block, steps or protected operations are needed.
Keep each validation key present when its block exists. Its commands and language may be null.
Use a file name pattern with one `*` for `validation.testPattern`, such as `*.test.js` or `test_*.py`.
Use no directory part (`/` or `\`) and no `..`. Use null when no pattern was found.
SPLITBRIEF searches beside the changed file and in the stack's test folders.
SPLITBRIEF emits `discovered_validation_refused` when it refuses a discovered pattern.
It uses the configured pattern, if present. Otherwise, it uses the stack's patterns.
Task ids match `T` plus three digits. Each task has nonblank intent and at least one accepted criterion.
Checks have id, kind, value and required. Register only `test` and `cmd` in these skills.
`render` exists in the engine schema but is unavailable here. A required render criterion blocks pass as unverified.
Every criterion's checkIds must resolve to registered run or task checks. Never infer a check from prose.
Suggested files have at least one entry while the parser requires an anchor file.
Validate dependencies, id uniqueness, criterion coverage, check references and context fit. Repair once before pausing.

## Decisions ledger

Read report decisions as declared deviations; the report contract is in references/implementer-prompt.md.
Append each new decision of a done report to `plan.decisions` as a `T001: <what> — <why>` string before validation. No seat confirms it.
Skip a decision the ledger already holds for that task.
The reviewer judges each decision with a task id against the criteria and the code.
Render the updated plan and refresh every later brief's read-only Plan context.
Include the ledger in consults and reviews. Preserve it on continuation and fixes.
