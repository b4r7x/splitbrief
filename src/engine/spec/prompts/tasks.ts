import { sliceRuleText } from '../../../core/pipeline-spec/brief.js';
import type { LanguageContext } from './language-context.js';
import { READ_ONLY_CONTEXT_HEADING, TASK_BRIEF_HEADINGS } from '../headings.js';

const H = TASK_BRIEF_HEADINGS;

/** The gates are SPLITBRIEF's, so a brief never orders the implementer to run them. */
export const GATES_ARE_SPLITBRIEFS =
  "Name the test files and cases only: the implementer writes or changes the test files among the brief's files, and SPLITBRIEF runs typecheck, lint and the affected tests after every brief. Never tell the implementer to run a test, typecheck, lint, format, screenshot or render command.";

const EVIDENCE_PROOF =
  "(the focused tests that pass, the changed files, the behavior a reviewer can check). Renders and gate runs are the review seat's and SPLITBRIEF's evidence, not the implementer's steps.";

const SCOPE_MEANING =
  '`files` are the suggested files; **Out of bounds** lists the explicit exclusions the reviewer checks.';

export function briefContract(ctx: LanguageContext): string {
  return `Every brief must cover these nine semantic sections, even when one is brief. Each section renders the plan task fields the template maps to it:

1. **Identity** — frontmatter \`id\`, \`title\`, \`action\`, \`file\`, optional \`files\`, \`depends_on\`, from the task's \`id\`, \`title\`, \`suggestedFiles\` and \`dependsOn\`.
2. **Intent** — \`${H.description.heading}\`: the task's \`intent\`, what the change is and why it matters.
3. **Scope** — \`${H.scope.heading}\` with \`**Out of bounds:**\` and optional \`**Approved out of bounds:**\` bullet lists, from the task's \`exclusions\`. REQUIRED. ${SCOPE_MEANING}
4. **Code Context** — \`${H.signature.heading}\`, \`${H.typeDefs.heading}\` and \`${H.pattern.heading}\`, copied verbatim from the project when relevant, and one \`${READ_ONLY_CONTEXT_HEADING} — <path>\` section with the current code of each of the task's \`contextFiles\`. The implementer reads the files it suggests itself, and searches only for a symbol the brief names.
5. **Implementation Plan** — \`${H.implementationSteps.heading}\`: the task's \`steps\`, 3-5 numbered steps with concrete function calls and patterns.
6. **Validation** — \`${H.tests.heading}\`: the task's test checks, REQUIRED concrete test cases with specific inputs and expected outputs, in every brief. No phrases like "should work correctly", and no deferring the cases to whichever brief owns the test file.
7. **Constraints** — \`${H.constraints.heading}\`: invariants, dependency rules, ${ctx.importConvention}, refusal conditions, and the task's \`protectedOperations\` as protected writes the user confirms.
8. **Escalation** — \`${H.escalation.heading}\`: bullets describing when the implementer must stop and ask instead of guessing. Required whenever the brief contains plausible ambiguity.
9. **Evidence** — \`${H.evidence.heading}\`: the task's checks and the criteria they prove, REQUIRED bullets describing the reviewable proof that should exist when the brief is done ${EVIDENCE_PROOF}

Every brief must also leave typecheck, lint and tests green on its own. Never plan for a failing gate: when a change would break a sibling file, widen the brief's \`files\` to include it, keep the change backward compatible with an optional property and a default, or split the work so each brief lands whole. Before a brief deletes or renames an export, its \`files\` name every consumer found by searching the whole repository — \`src/\` and \`testing/\` alike, colocated and sibling tests included.`;
}

export function criticalRules(ctx: LanguageContext): string {
  return `1. **Self-contained**: Each brief must inline the context the implementer cannot read in the files it suggests: the current code of its context files, ${ctx.typeAnnotationStyle}, import paths, function signatures from dependencies, and expected patterns.

2. **Coherent**: ${sliceRuleText()}

3. **Dependency-ordered**: Briefs must be ordered so dependencies come first. Use \`depends_on\` to declare which briefs must complete first; a brief of a later batch names the briefs it follows. Independent briefs can run in parallel.

4. **Concrete validation**: Every \`${H.tests.heading}\` block must list specific test cases with concrete inputs and expected outputs, as \`-\` bullets. This holds for every brief, including one whose test file a different brief owns: list the cases that verify THIS brief's change. Never replace the bullets with prose that defers validation to another brief. ${GATES_ARE_SPLITBRIEFS}

5. **Inline type definitions**: Copy referenced ${ctx.typeAnnotationStyle} or data shape definitions verbatim into \`${H.typeDefs.heading}\`. Max ~300 tokens — prioritize definitions that appear in the function signature.

6. **Import paths**: Specify exact imports using ${ctx.importConvention}.

7. **Escalation, not guessing**: If a brief could be interpreted multiple ways, list those decision points under \`${H.escalation.heading}\` rather than baking a guess into the steps.

8. **Evidence is not implementation**: \`${H.evidence.heading}\` describes the proof that survives after the brief is done, not the steps that produce it.

9. **Reserved delimiter**: Outside fenced code blocks, lines containing only \`---\` are reserved for Task Brief frontmatter delimiters. Never use a bare \`---\` as a horizontal rule or phase-heading separator.`;
}

/** The implementer gets the run's skills beside every brief, so a brief restates none of them. */
export const SKILLS_WITH_EVERY_BRIEF =
  'Every brief reaches the implementer together with the Active Project Skills section: do not copy that section into a brief, and do not point a brief at skill files.';
