import { PLANNER_DOCUMENT_SECTIONS } from '../../../core/pipeline-spec/planner-documents.js';
import type { LanguageContext } from './language-context.js';
import { buildLanguageContext, buildLanguageContextSections } from './language-context.js';
import {
  plannerConversationSection,
  buildPrompt,
  instructionsSection,
  requiredSectionsSection,
} from './builder.js';
import { error } from '../../../utils/error.js';
import { PLAN_PROMPT_MAX_BYTES } from '../../../core/pipeline-spec/brief.js';

export type PlanPromptSpec = {
  content: string;
  hasClarifications: boolean;
};

export type PlanPromptInput = Readonly<{
  spec: PlanPromptSpec;
  projectContext: string;
  skillsContext?: string | undefined;
  languageContext?: LanguageContext | undefined;
  maxPromptBytes?: number | undefined;
}>;

export type RegeneratePromptInput = Readonly<{
  artifactType: 'spec' | 'plan';
  currentContent: string;
  feedback: string;
}>;

export const planPromptError = {
  tooLarge: (actualBytes: number, maxBytes: number) =>
    error(
      'plan_prompt_too_large',
      `The plan prompt is ${actualBytes} bytes; the bound is ${maxBytes} bytes.`,
      { actualBytes, maxBytes },
    ),
} as const;

function outputInstruction(ctx: LanguageContext, opts: { hasClarifications: boolean }): string {
  const base =
    ctx.language === 'TypeScript'
      ? 'Write the complete plan.md content. Be specific -- use actual file paths, function names, and type definitions from the project.'
      : 'Write the complete plan.md content. Be specific -- use actual file paths, function names, and type or data-shape definitions from the project.';
  if (!opts.hasClarifications) return base;

  return `${base}

Note: The specification contains a Clarifications section with user decisions. Reference these decisions in your plan.`;
}

function fileStructureExample(ctx: LanguageContext): string {
  const extension = ctx.fileExtension || '.ext';
  return `### New Files
- \`src/new-file${extension}\`
  Purpose: describe the file's one concrete responsibility.

### Modified Files
- \`src/modified-file${extension}\`
  Purpose: describe the exact existing behavior to change and why.`;
}

function requiredSections(ctx: LanguageContext): string {
  return `## ${PLANNER_DOCUMENT_SECTIONS.plan[0]}
One-paragraph summary of the implementation approach.

## ${PLANNER_DOCUMENT_SECTIONS.plan[1]}
Key technical decisions with brief justifications:
- What patterns/approaches to use and why
- What libraries or APIs to leverage
- What tradeoffs were made

## ${PLANNER_DOCUMENT_SECTIONS.plan[2]}
List every project-relative file the change touches with one indented purpose line each;
group the files of one slice together in the order a brief would write them.
Include both subsections, even when one has no entries:
${fileStructureExample(ctx)}

## ${PLANNER_DOCUMENT_SECTIONS.plan[3]}
Any new packages or tools needed. For each, specify:
- Package name and version constraint
- Why it's needed
- Any alternatives considered

## ${PLANNER_DOCUMENT_SECTIONS.plan[4]}
If the feature involves new types, interfaces, structs, schemas, or data structures, define them here with ${ctx.typeAnnotationStyle}.

## ${PLANNER_DOCUMENT_SECTIONS.plan[5]}
For each major component:
- Function signatures with parameter and return types
- Core logic description (algorithm, data flow)
- How it integrates with existing code
- Error handling approach

## ${PLANNER_DOCUMENT_SECTIONS.plan[6]}
- What to test (unit, integration, edge cases)
- Test file locations
- Key test scenarios with expected inputs/outputs`;
}

export function buildPlanPrompt(input: PlanPromptInput): string {
  const ctx = input.languageContext ?? buildLanguageContext(undefined);

  const prompt = buildPrompt({
    title: 'Write Implementation Plan',
    intro:
      'You are writing a detailed implementation plan based on the specification below. The plan defines **how** to build the feature, and feeds the next phase: compiling Product Task Briefs the implementer model will execute against. Be concrete enough that brief compilation does not need to invent decisions.',
    sections: [
      plannerConversationSection,
      { heading: 'Specification', body: input.spec.content },
      {
        heading: 'Project Context',
        body: `${input.projectContext}${input.skillsContext ? `\n${input.skillsContext}` : ''}`,
      },
      instructionsSection(
        'Write a complete `plan.md` document that provides a concrete implementation blueprint. Another developer (or AI) should be able to follow this plan without needing to make architectural decisions.',
      ),
      ...buildLanguageContextSections(ctx),
      requiredSectionsSection(requiredSections(ctx)),
    ],
    output: outputInstruction(ctx, { hasClarifications: input.spec.hasClarifications }),
  });
  return assertPlanPromptBound(prompt, input.maxPromptBytes);
}

export function planPromptByteLength(prompt: string): number {
  return Buffer.byteLength(prompt, 'utf8');
}

export function assertPlanPromptBound(
  prompt: string,
  maxPromptBytes: number = PLAN_PROMPT_MAX_BYTES,
): string {
  const actualBytes = planPromptByteLength(prompt);
  if (actualBytes > maxPromptBytes) throw planPromptError.tooLarge(actualBytes, maxPromptBytes);
  return prompt;
}

export function buildRegeneratePrompt(input: RegeneratePromptInput): string {
  const label = input.artifactType === 'spec' ? 'Specification' : 'Implementation Plan';
  return buildPrompt({
    title: `Regenerate ${label}`,
    intro: `The user reviewed the ${input.artifactType} and has feedback:`,
    sections: [
      plannerConversationSection,
      { heading: `Current ${label}`, body: input.currentContent },
      { heading: 'User Feedback', body: input.feedback },
      instructionsSection(
        `Regenerate the complete ${input.artifactType}.md incorporating the user's feedback. Output the full updated document, not just the changes.`,
      ),
    ],
  });
}
