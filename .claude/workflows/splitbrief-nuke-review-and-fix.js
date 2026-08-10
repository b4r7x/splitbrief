export const meta = {
  name: 'splitbrief-nuke-review-and-fix',
  description: 'nuke-review over the whole uncommitted git diff, then fix every skeptic-confirmed finding',
  phases: [
    { title: 'Recon', detail: 'resolve the diff, split into areas, precompute blast radius' },
    { title: 'Audit', detail: '4 charter auditors per area (behavioral, security, structural, quality)' },
    { title: 'Skeptic', detail: 'one batched session skeptic per area — refute every candidate' },
    { title: 'Spec', detail: 'fix-spec architect batches confirmed findings by disjoint files' },
    { title: 'Fix', detail: 'implementers on disjoint batches' },
    { title: 'Validate', detail: 'fresh validator: every finding closed, focused gates, real e2e' },
  ],
}

const REPO = 'the repository you are running in (your working directory)'

const HOUSE_RULES = `
HOUSE RULES — CLAUDE.md, non-negotiable:
- NEVER run \`git add\`, \`git stage\`, \`git commit\`, or \`git stash\`. Every change stays an unstaged working-tree modification; the user reviews and commits by hand. A PreToolUse hook blocks these — a "BLOCKED:" message means stop and report.
- ESM only, \`.js\` extension in every relative import. Node 22+, TypeScript 6, Vitest 4, Biome 2, Zod 4, Ink 6 / React 19.
- Zero runtime classes in production source. Zero barrels (no re-export-only index.ts anywhere in src/). Zero memoization (no useMemo / useCallback / React.memo — store selectors replace them). No forwardRef / useImperativeHandle.
- \`src/engine/\` must never import from ink, react, \`src/features/\`, \`src/components/\`, or \`src/hooks/\`.
- kebab-case filenames. Tests colocated as \`foo.test.ts\` beside \`foo.ts\`.
- No decorative comments, no section banners. A comment earns its place by explaining WHY where a reader would otherwise be misled.
- No unsafe assertions in production: no incidental \`!\`, no broad \`as\`. The sanctioned exceptions are listed in CLAUDE.md — treat anything outside that list as a finding.
- Errors propagate from internal functions; callers decide. See docs/ERRORS.md.

TIME BUDGET — the user's explicit instruction: \`npm run test-ci\` takes about an hour. DO NOT RUN IT. Focused vitest files, \`npx tsc --noEmit\`, and \`npx biome check <files>\` only, plus the real end-to-end vehicles named below.

The canonical docs to read BEFORE judging an area: docs/ARCHITECTURE.md, docs/ENGINE.md (orchestrator + EventBus), docs/PLANNERS-AND-IMPLEMENTERS.md (runner kinds, Task Brief, tokens), docs/STORES-AND-UI.md, docs/APPROVAL-AND-RECOVERY.md, docs/SUBSYSTEMS.md, docs/LAYERS.md, docs/INVARIANTS.md, docs/CODE-STANDARD.md, and \`.specify/memory/constitution.md\`. A documented intentional decision is NOT a finding.
`

const CONTEXT = `
You are reviewing SPLITBRIEF in your working directory (branch main). The working tree is intentionally dirty: this review's subject IS the uncommitted diff — roughly 155 changed TypeScript files, ~4800 insertions, spanning the orchestrator, the runner layer, readiness, the spec/brief parser and the streaming path. Two bug fixes landed today and are part of the diff: a Task Brief fence-unwrap fix in src/engine/spec/tasks/blocks.ts, and a TUI streaming/event-dedup fix. Both are in scope and get no deference.

${HOUSE_RULES}
`

const RECON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['diffStat', 'areas', 'skillMap', 'securitySurfaces'],
  properties: {
    diffStat: {
      type: 'object',
      additionalProperties: false,
      required: ['files', 'insertions', 'deletions'],
      properties: {
        files: { type: 'integer' },
        insertions: { type: 'integer' },
        deletions: { type: 'integer' },
      },
    },
    areas: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title', 'changedFiles', 'blastRadius', 'summary'],
        properties: {
          key: { type: 'string', description: 'short kebab-case id, e.g. "orchestrator-run"' },
          title: { type: 'string' },
          changedFiles: {
            type: 'array',
            description: 'repo-relative paths of the CHANGED files this area owns — every changed code file must appear in exactly one area',
            items: { type: 'string' },
          },
          blastRadius: {
            type: 'array',
            description: 'repo-relative paths of UNCHANGED files that import, or are imported by, this area\'s changed files — where auditors trace into',
            items: { type: 'string' },
          },
          summary: { type: 'string', description: 'what changed here, in two or three sentences' },
        },
      },
    },
    skillMap: {
      type: 'array',
      description: 'file extension -> locally installed amplifier skills that auditors MUST load',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ext', 'skills'],
        properties: {
          ext: { type: 'string' },
          skills: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    securitySurfaces: {
      type: 'array',
      description: 'detected surfaces from stack-adapters.md: web | CLI | library | daemon | infra | ai',
      items: { type: 'string' },
    },
    notes: { type: 'string' },
  },
}

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['lens', 'severity', 'severityJustification', 'sites', 'trace', 'proposedFix', 'refutationAttempt'],
        properties: {
          lens: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          severityJustification: { type: 'string', description: 'consequence AND reachability, one sentence' },
          sites: {
            type: 'array',
            minItems: 1,
            description: 'every involved site — each MUST carry a verbatim quoted source line',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'line', 'quotedSource'],
              properties: {
                file: { type: 'string' },
                line: { type: 'integer' },
                quotedSource: { type: 'string' },
              },
            },
          },
          trace: {
            type: 'array',
            minItems: 1,
            description: 'numbered hops proving the claim end to end',
            items: { type: 'string' },
          },
          proposedFix: { type: 'string', description: 'imperative, one to three sentences' },
          refutationAttempt: { type: 'string', description: 'the strongest reason this is NOT real — mandatory' },
        },
      },
    },
    checklistCoverage: { type: 'string', description: 'which numbered checklist items you executed and what each returned' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateRef', 'verdict', 'reason'],
        properties: {
          candidateRef: { type: 'string', description: 'charter/index as given to you' },
          verdict: { type: 'string', enum: ['confirm', 'reject'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          questionFailed: { type: 'string', description: '1-5 when rejecting, "-" when confirming' },
          reason: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          summary: { type: 'string', description: 'one line restating the defect, for the fix spec' },
          proposedFix: { type: 'string' },
        },
      },
    },
  },
}

const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'batches'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'approve-with-nits', 'request-changes'] },
    rationale: { type: 'string' },
    batches: {
      type: 'array',
      description: 'disjoint file batches — no file may appear in two batches',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'files', 'tasks'],
        properties: {
          key: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'finding', 'file', 'change', 'accept'],
              properties: {
                id: { type: 'string' },
                finding: { type: 'string' },
                file: { type: 'string' },
                change: { type: 'string', description: 'imperative, exact' },
                accept: { type: 'string', description: 'mechanically checkable: a grep, a test run, or a quoted line' },
              },
            },
          },
        },
      },
    },
    deferred: {
      type: 'array',
      description: 'confirmed findings deliberately NOT fixed, each with the reason',
      items: { type: 'string' },
    },
  },
}

phase('Recon')
log('Resolving the uncommitted diff into review areas with precomputed blast radius')

const recon = await agent(
  `${CONTEXT}

You are the RECON CLERK for a nuke-review. You write NOTHING to the repository. Produce the scope the auditors will work from.

1. Resolve the diff. Tracked changes: \`git diff --name-only HEAD\`. Untracked: \`git ls-files --others --exclude-standard\`. EXCLUDE: anything under \`.nuke/\`, \`.splitbrief/\`, \`dist/\`, \`node_modules/\`, lockfiles (package-lock.json), and generated output. KEEP docs/*.md and CHANGELOG.md — doc drift against changed behavior is in scope for the security/hygiene charter.
2. Report the real diff stat (files, insertions, deletions) over that filtered set.
3. Split the CHANGED CODE files into 3–5 areas along module boundaries, balanced at roughly 15–35 files each (a colocated \`foo.test.ts\` belongs to the same area as \`foo.ts\`). Do NOT split a coherent subsystem across areas — the orchestrator, the runner layer, the spec/brief parser, readiness+core, and the streaming/planner path are the natural seams. Every changed code file must land in exactly ONE area. Docs go to whichever area owns the behavior they describe.
4. For each area compute the BLAST RADIUS: unchanged files that import the area's changed files, or that the area's changed files import, where a changed export/signature/schema/config value is involved. Use grep over import statements and call sites. Cap each area's blast radius at the ~25 most relevant paths, most-coupled first.
5. Build the file-type → skill map: list the LOCAL skill library once (the skills available to you) and match it against the extensions in scope. \`.ts\` → the type-discipline and clean-code class skills present locally; \`.tsx\` → the React guide class skill; note the anti-slop and testing skills if present. Name only skills that actually exist locally.
6. Classify the security surfaces present in the diff per stack-adapters.md: web / CLI / library / daemon / infra / ai. SPLITBRIEF is a CLI that spawns external coding agents and speaks to LLM APIs — enumerate every surface you find evidence for, and say what the evidence is in \`notes\`.

Return the structured result. Keep \`summary\` fields short; the auditors read the files themselves.`,
  { label: 'recon', phase: 'Recon', schema: RECON_SCHEMA, effort: 'high' },
)

if (!recon) {
  log('Recon returned nothing — cannot compose the wave')
  return { status: 'ABORTED', reason: 'recon produced no scope' }
}

log(`Scope: ${recon.diffStat.files} files, +${recon.diffStat.insertions}/-${recon.diffStat.deletions} across ${recon.areas.length} areas`)
log(`Surfaces: ${recon.securitySurfaces.join(', ')} · skills: ${recon.skillMap.map((m) => `${m.ext}→${m.skills.join('/')}`).join(' · ')}`)

const SKILL_MAP_TEXT = recon.skillMap
  .map((m) => `- ${m.ext} → ${m.skills.length ? m.skills.join(', ') : '(none — the quality bar carries the lens)'}`)
  .join('\n')

const FINDING_SCHEMA_TEXT = `
THE CANDIDATE FINDING SCHEMA — a candidate missing ANY of these is invalid. Discard it; do not report it.
1. lens + severity (critical | high | medium | low | info) + a one-sentence severity justification stating CONSEQUENCE and REACHABILITY.
2. file:line for every involved site.
3. A verbatim quoted source line for every cited site. Quote what is actually there — a paraphrase invalidates the finding.
4. A numbered end-to-end trace proving the claim.
5. A proposed fix, imperative, one to three sentences.
6. A refutation attempt: the strongest reason this is NOT real. If you cannot refute it, report it. If your own refutation convinces you, discard it.

SEVERITY CALIBRATION — you are judged on this; a skeptic recalibrates and recalibrations bind.
- critical: broken behavior or exploitable exposure on a real path, no mitigating control.
- high: wrong behavior or a security gap one realistic precondition away; or rot actively spreading.
- medium: real defect or debt with bounded blast radius where the fix clearly improves the code.
- low: hygiene or idiom violation with no behavioral consequence.
- info: observation, no action strictly required.
Rate against THIS repo's threat model and conventions, not an imagined ideal. When torn between low and medium, write the trace first — if the trace shows a consequence, it is medium.

SIDE-EFFECT TRACING DUTY: every changed export, signature, schema field, or config value in your file list must be traced to its callers and consumers in your blast-radius list. A changed contract with untraced callers is an automatic candidate.
`

const CHARTERS = [
  {
    key: 'behavioral',
    lenses: 'correctness, errors, tests, performance',
    checklist: `1. Trace each entry point in your area end-to-end; at every branch ask "what input makes this branch wrong?" — off-by-one, empty, null/undefined, unicode, concurrent access.
2. Grep every public or recently changed function for its callers; verify each caller survives the current signature and semantics.
3. Hunt swallowed failures: empty \`catch {}\`, \`.catch(() => {})\`, floating promises, thrown strings.
4. Judge every fallback value (\`?? default\`, \`|| fallback\`, zero-value returns): does it hide a failure that should surface?
5. For each test file in your area: does it assert observable behavior (outputs, state transitions, emitted events) or implementation details (internal calls, private state, mock wiring)? Flag the latter. Flag any test that mocks the project's OWN modules.
6. List critical paths with no test at all, and boundary values with no edge coverage.
7. Scan hot paths against the JS/TS hot spots: sync fs/crypto on request paths, sequential \`await\` in loops where \`Promise.all\` fits, unbounded caches, re-render storms.
8. Grep for shared mutable module-level state touched from concurrent or async paths; trace whether interleaving can corrupt it.
9. Check devex behavior: package scripts actually run, documented env vars exist, flags match the docs.`,
  },
  {
    key: 'security',
    lenses: 'security, hygiene, ai',
    checklist: `1. State which surfaces your area touches (web / CLI / library / daemon / infra / ai) and apply ONLY the matching threat rows.
2. CLI surface: shell and argument injection (array args, \`--\` separators), path traversal, predictable temp files, untrusted content echoed to the terminal as ANSI escapes. This repo spawns external coding agents — scrutinise every \`spawn\`, argv construction, and env assembly.
3. Grep for secrets in source, config, fixtures, CI files, and error messages: keys, tokens, passwords, connection strings. Trace credential VALUES: this repo bridges host CLI credentials into sandboxes (src/engine/runners/sandbox-env.ts) and redacts them from transcripts — verify no path leaks a credential into a log, an event, a session.jsonl, or a diagnostic message.
4. Name every external input (argv, env, files read, network responses, LLM output) that reaches use without validation at the boundary.
5. Trace untrusted content to sinks: prompt, terminal, shell, file path, object merge, URL fetch. LLM output is untrusted input here.
6. Check manifests for install scripts and unpinned or git-sourced dependencies.
7. Hygiene: every declared gate command still runs; scripts referenced by docs and CI exist; config drift between files; docs that lie about the changed behavior; stale TODO/FIXME. Read the changed docs/*.md against the changed code and flag every claim that is now false.
8. AI surface: trace every path where untrusted content (user input, file contents, tool results, planner output) reaches a prompt or a tool argument; grep the orchestrator's retry/escalation loops for iteration, cost, and token caps and flag their absence; trace PII and secrets into prompts and model-call logs; flag LLM output consumed as trusted input (executed, written to disk, merged into config) without validation.`,
  },
  {
    key: 'structural',
    lenses: 'architecture, structure, dry, dead-code',
    checklist: `1. Build the import graph of your area: cycles, wrong-direction imports (this repo forbids \`src/engine/\` → ink/react/features/components/hooks), god modules imported by most of the scope.
2. Flag files past ~500 lines or mixing concerns — look for a restructuring that DELETES complexity rather than adding a layer.
3. Grep for 3+ occurrences of near-identical logic, types, constants, or validation; check whether a canonical helper already exists and is being bypassed. This diff is large and was written in several passes — near-duplicates are the expected failure mode.
4. Flag thin wrappers and pass-through layers that add no behavior.
5. Flag logic outside its canonical layer per docs/LAYERS.md and docs/STRUCTURE.md, and misplaced files.
6. Dead code: grep each changed export for importers; flag unused exports/imports/vars, unreachable branches, commented-out blocks, re-exports nothing consumes. A newly added export with zero consumers is a finding.
7. Flag non-atomic update flows: multi-step state changes observable or interruptible half-done — session state, snapshots, worktrees, lockfiles.
8. Verify boundaries match docs/INVARIANTS.md; run the repo's own invariant checks mentally against the diff (zero barrels, zero memoization, no index.ts in src/).`,
  },
  {
    key: 'quality',
    lenses: 'simplicity, slop, types, conventions, stack',
    checklist: `1. Grep every type escape hatch in your area: \`any\`, broad \`as\`, \`as unknown as\`, non-null \`!\`, \`@ts-ignore\`, \`@ts-expect-error\`. Judge each against the sanctioned-exception list in CLAUDE.md — anything outside that list is a finding.
2. Flag missing exhaustiveness on discriminated unions and enum switches.
3. Flag ad-hoc object shapes crossing module boundaries where a named contract (a Zod schema or a declared type) should exist.
4. AI slop: comments restating code, defensive over-coding (null checks on non-nullables, try/catch on infallible operations), AI-voice naming (enhanced/robust/graceful/comprehensive), verbose patterns replaceable by an idiom. This diff was largely machine-written — hunt accordingly, but do NOT flag the repo's deliberate explanatory comments, which document WHY and are house style.
5. KISS/YAGNI: premature abstraction, factories for one or two variants, speculative config, single-use helpers, deep nesting, cleverness.
6. Read CLAUDE.md and the docs first; flag violations, naming-content mismatches, placement-rule breaks. A documented intentional decision is NOT a finding.
7. Run the checklist of every amplifier skill mapped to your file types, verbatim, on the matching files.`,
  },
]

phase('Audit')
log(`Dispatching ${CHARTERS.length * recon.areas.length} charter auditors (${CHARTERS.length} charters x ${recon.areas.length} areas)`)

const auditJobs = []
for (const area of recon.areas) {
  for (const charter of CHARTERS) {
    auditJobs.push({ area, charter })
  }
}

const auditResults = await parallel(
  auditJobs.map((job) => () =>
    agent(
      `${CONTEXT}

You are the **${job.charter.key.toUpperCase()}** charter auditor for the area **${job.area.title}** (\`${job.area.key}\`).

Your bundled lenses: ${job.charter.lenses}.

What changed here: ${job.area.summary}

CHANGED FILES — the material under judgment (read every one):
${job.area.changedFiles.map((f) => `- ${f}`).join('\n')}

BLAST RADIUS — unchanged files to trace INTO when a changed contract reaches them:
${job.area.blastRadius.map((f) => `- ${f}`).join('\n') || '- (none computed)'}

MANDATORY AMPLIFIER SKILLS — load these before hunting, and where one ships a review checklist, run that checklist verbatim on the matching files:
${SKILL_MAP_TEXT}

Detected security surfaces for this repo: ${recon.securitySurfaces.join(', ')}.

YOUR CHECKLIST — execute every numbered item, skip nothing silently, and report in \`checklistCoverage\` what each item returned:
${job.charter.checklist}

${FINDING_SCHEMA_TEXT}

You are READ-ONLY on the repository. Do not edit, create, or delete a single file there. Write any scratch notes to your own temp directory outside it.

Report candidates only. Quality beats quantity: a wrong candidate costs a skeptic's judgment and your charter's credibility. Zero candidates is a legitimate result — say so and show your checklist coverage.`,
      { label: `audit:${job.area.key}/${job.charter.key}`, phase: 'Audit', schema: CANDIDATE_SCHEMA, effort: 'high' },
    ),
  ),
)

const byArea = new Map()
auditJobs.forEach((job, i) => {
  const result = auditResults[i]
  if (!result?.candidates?.length) return
  const list = byArea.get(job.area.key) ?? []
  for (const candidate of result.candidates) {
    list.push({ ...candidate, ref: `${job.area.key}/${job.charter.key}/${list.length + 1}`, area: job.area.key, charter: job.charter.key })
  }
  byArea.set(job.area.key, list)
})

const totalCandidates = [...byArea.values()].reduce((n, list) => n + list.length, 0)
log(`${totalCandidates} candidates from ${auditResults.filter(Boolean).length}/${auditJobs.length} auditors — dispatching skeptics by area locality`)

if (totalCandidates === 0) {
  return { verdict: 'approve', rationale: 'no auditor produced a candidate', diffStat: recon.diffStat, areas: recon.areas.length }
}

phase('Skeptic')

const skepticInputs = [...byArea.entries()].filter(([, list]) => list.length > 0)

const verdictResults = await parallel(
  skepticInputs.map(([areaKey, candidates]) => () =>
    agent(
      `${CONTEXT}

You are the batched SKEPTIC for area **${areaKey}**. You did NOT author any of these candidates. Your charter is to REFUTE, not to confirm.

For EVERY candidate below, answer all five questions with evidence, then return one verdict per candidate. Batching shares context; it NEVER merges judgments — one explicit verdict per candidate, always.

1. **Real?** Factually true at the cited lines. OPEN every cited file. Verify each quoted line exists VERBATIM. Re-walk the trace hop by hop. A verdict formed from the claim text alone is invalid.
2. **Duplicate?** Of another candidate in this same batch that you have already confirmed? Confirm the first, reject the rest as duplicates.
3. **Intentional?** Permitted or mandated by CLAUDE.md, the docs, \`.specify/memory/constitution.md\`, or an inline comment documenting the decision. This repo documents its deliberate exceptions — check the sanctioned-exception list before confirming any type-escape finding.
4. **In scope?** Inside the uncommitted diff or its blast radius. A pre-existing defect the diff merely touches is IN scope only if the diff made it reachable or worse — say which.
5. **Worth fixing?** Would the proposed fix genuinely improve the code, or churn it? This question is the gate that decides what gets fixed next, so answer it as if you are the one paying for the edit.

Uncertain after full end-to-end research → REJECT, with a written reason. High signal beats high count.

SEVERITY RECALIBRATION is part of question 1 and BINDS: a real defect carrying an inflated severity is half-wrong. Return the corrected severity on every confirm.
- critical: broken behavior or exploitable exposure on a real path, no mitigating control.
- high: wrong behavior or a security gap one realistic precondition away; or rot actively spreading.
- medium: real defect or debt with bounded blast radius; the fix clearly improves the code.
- low: hygiene or idiom violation with no behavioral consequence.
- info: observation; no action strictly required.

Each candidate arrives with its author's own refutation attempt. YOUR work starts where that stopped — extend it, never repeat it.

On every CONFIRM also return: \`file\`, \`line\`, a one-line \`summary\` of the defect, and the \`proposedFix\` you would actually accept (rewrite the author's if it is wrong or too broad).

CANDIDATES (${candidates.length}):
${JSON.stringify(candidates, null, 2)}

You are READ-ONLY on the repository.`,
      { label: `skeptic:${areaKey}`, phase: 'Skeptic', schema: VERDICT_SCHEMA, effort: 'high' },
    ),
  ),
)

const confirmed = []
const rejected = []
for (const result of verdictResults.filter(Boolean)) {
  for (const v of result.verdicts) {
    if (v.verdict === 'confirm') confirmed.push(v)
    else rejected.push(v)
  }
}

const bySeverity = (s) => confirmed.filter((f) => (f.severity ?? 'medium') === s).length
log(`Skeptics: ${confirmed.length} confirmed (${bySeverity('critical')}C/${bySeverity('high')}H/${bySeverity('medium')}M/${bySeverity('low')}L/${bySeverity('info')}I), ${rejected.length} rejected`)

if (confirmed.length === 0) {
  return {
    verdict: 'approve',
    rationale: 'every candidate was refuted by an independent skeptic',
    diffStat: recon.diffStat,
    candidates: totalCandidates,
    rejected: rejected.map((r) => `${r.candidateRef}: ${r.reason}`),
  }
}

phase('Spec')

const spec = await agent(
  `${CONTEXT}

You are the FIX-SPEC ARCHITECT. Independent skeptics confirmed the findings below over the uncommitted diff. Turn them into an executable fix spec.

CONFIRMED FINDINGS (${confirmed.length}):
${JSON.stringify(confirmed, null, 2)}

REJECTED (for your awareness — never resurrect one):
${rejected.map((r) => `- ${r.candidateRef}: ${r.reason}`).join('\n')}

Rules:
- Open the cited files. A finding whose fix you cannot state exactly does not belong in the spec — move it to \`deferred\` with the reason.
- Batch tasks by DISJOINT files: no file may appear in two batches, because the batches run in parallel and would collide. Group findings that touch the same file into the same batch even across areas.
- Every \`accept\` must be mechanically checkable by the implementer or a validator: a grep that must match or not match, a focused vitest file that must pass, or a quoted line that must be present. "Looks better" is not an accept criterion.
- Order tasks inside a batch so an earlier task never invalidates a later one's quoted line.
- Keep each \`change\` MINIMAL and at the root cause. Reject any fix that is a band-aid at the symptom site.
- The user's instruction is "fix what's needed". Every skeptic-confirmed finding passed question 5 (worth fixing), so the default is FIX. Defer only when a fix would require a design decision the user has not made, or would exceed the diff's scope — and say exactly that in \`deferred\`.
- Set \`verdict\`: request-changes if any confirmed critical/high, approve-with-nits if only medium and below, approve if the confirmed set is purely informational.

You are READ-ONLY on the repository — you write the plan, not the code.`,
  { label: 'fix-spec', phase: 'Spec', schema: SPEC_SCHEMA, effort: 'high' },
)

if (!spec || spec.batches.length === 0) {
  return {
    verdict: spec?.verdict ?? 'request-changes',
    rationale: 'findings confirmed but no executable batch was produced',
    confirmed,
    rejected: rejected.length,
  }
}

log(`Verdict ${spec.verdict} — ${spec.batches.length} disjoint fix batches, ${spec.batches.reduce((n, b) => n + b.tasks.length, 0)} tasks`)

phase('Fix')

const fixReports = await parallel(
  spec.batches.map((batch) => () =>
    agent(
      `${CONTEXT}

You are the IMPLEMENTER for fix batch **${batch.key}**. Apply exactly these tasks and nothing else.

FILES YOU OWN (no other agent touches them — do not edit anything outside this list):
${batch.files.map((f) => `- ${f}`).join('\n')}

TASKS:
${batch.tasks.map((t) => `### ${t.id}\nFinding: ${t.finding}\nFile: ${t.file}\nChange: ${t.change}\nAccept: ${t.accept}`).join('\n\n')}

Requirements:
- Read every file before you edit it. Make the MINIMAL change at the root cause; no while-I'm-here refactors, no drive-by renames, no reformatting untouched lines.
- Where a task changes behavior, add or extend the COLOCATED test that proves it. The test must assert observable behavior, never the fix's implementation — a test that would pass without the fix is a defect.
- Load the amplifier skills mapped to the file types you touch before writing:
${SKILL_MAP_TEXT}
- After each task, evaluate its \`accept\` criterion and paste the result verbatim.
- When done with the whole batch: run the colocated vitest files for every file you touched, then \`npx tsc --noEmit\`, then \`npx biome check\` on the changed files. Paste all three outputs. NEVER \`npm run test-ci\`.
- If a task turns out to be wrong — the finding does not hold when you read the code, or the fix would break a caller — DO NOT force it. Skip it and report exactly why. A skipped task with a reason is a good outcome; a wrong edit is not.
- Delete every temporary probe or scratch file you created inside the repository.

Report: per task, DONE or SKIPPED with the reason, the exact files and line ranges you changed, the accept-criterion result, and the three gate outputs.`,
      { label: `fix:${batch.key}`, phase: 'Fix', effort: 'high' },
    ),
  ),
)

phase('Validate')

const validation = await agent(
  `${CONTEXT}

You are a FRESH VALIDATOR. You wrote none of this and you must not trust the implementers' reports.

CONFIRMED FINDINGS THAT WERE SUPPOSED TO BE FIXED:
${JSON.stringify(confirmed.map((f) => ({ ref: f.candidateRef, severity: f.severity, file: f.file, line: f.line, summary: f.summary })), null, 2)}

DEFERRED BY THE ARCHITECT (must still be open, and that is acceptable):
${(spec.deferred ?? []).join('\n') || '(none)'}

IMPLEMENTER REPORTS:
${fixReports.filter(Boolean).map((r, i) => `--- batch ${spec.batches[i]?.key ?? i} ---\n${r}`).join('\n\n')}

Verify in this order and paste every output VERBATIM:

1. **Every finding is actually closed.** For each one, open the cited file and prove the defect is gone — quote the current line. A finding the implementer called DONE but whose code is unchanged is a failure. A finding "fixed" by deleting the code that exercised it is a failure. Report per finding: CLOSED / NOT CLOSED / DEFERRED.
2. **No collateral damage.** Run the colocated vitest files for every changed file. Then \`npx tsc --noEmit\`. Then \`npx biome check\` on the changed files. Verbatim output. DO NOT run \`npm run test-ci\` — the user's explicit instruction; it takes about an hour.
3. **The repo's own invariant gate.** Run \`npx tsx scripts/check-invariants.ts\` and paste the result — it is fast and it enforces the house rules (zero barrels, zero memoization, layering).
4. **The tool still works end to end.** This is mandatory and it is the point of the exercise. Build a throwaway project OUTSIDE the repository: a fresh temp directory, \`git init\`, a \`package.json\` with \`"type": "module"\`, a \`hello.js\` containing \`export function hello() { return "hi"; }\`, and a \`.splitbrief/config.yaml\` copied from the repository's own \`.splitbrief/config.yaml\` (claude-code planner and implementer, \`model: auto\`). Then run a REAL workflow against the REAL \`claude\` CLI from that directory:
     npx tsx <repo>/src/cli.ts start --json --mode instant "add a divide function to hello.js"
   It must reach \`brief_quality_passed\`, then \`task_completed\`, and \`hello.js\` must actually contain the new function. Paste the decisive events and the resulting file. If it fails, that is a NOT CLEAN verdict no matter how good the unit tests look.
5. **Working tree hygiene.** \`git status --short\` in ${REPO}: nothing staged, nothing committed, no stray probe scripts, no \`.bak\` files, no leftover temp tests. List every changed path and confirm each one is either part of the original diff under review or a deliberate fix from this run.

Your first line must be exactly one of:
- "CLEAN — <one line>"
- "NOT CLEAN — <what still fails>", followed by the verbatim failing output and the precise finding each implementer must address.

Be adversarial. If the end-to-end run did not actually happen, the verdict is NOT CLEAN.`,
  { label: 'validate', phase: 'Validate', effort: 'high' },
)

return {
  verdict: spec.verdict,
  rationale: spec.rationale,
  diffStat: recon.diffStat,
  areas: recon.areas.map((a) => ({ key: a.key, files: a.changedFiles.length })),
  candidates: totalCandidates,
  confirmed: confirmed.map((f) => ({ ref: f.candidateRef, severity: f.severity, file: f.file, line: f.line, summary: f.summary })),
  rejectedCount: rejected.length,
  deferred: spec.deferred ?? [],
  validation,
}
