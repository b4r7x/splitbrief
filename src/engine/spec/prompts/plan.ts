import type { LanguageContext } from './language-context.js';
import { buildLanguageContext, buildLanguageContextSections } from './language-context.js';
import { buildPrompt, instructionsSection, requiredSectionsSection } from './builder.js';
import { TASK_BRIEF_COMPILER_POLICY } from '../../../core/schemas/task-compilation.js';
import { error, matches } from '../../../utils/error.js';

export type PlanPromptSpec = {
  content: string;
  hasClarifications: boolean;
};

export type PlanPromptOptions = Readonly<{
  maxPromptBytes?: number;
}>;

export const planPromptError = {
  tooLarge: (actualBytes: number, maxBytes: number) =>
    error(
      'task_compiler_prompt_too_large',
      `The plan prompt is ${actualBytes} bytes; the bound is ${maxBytes} bytes.`,
      { actualBytes, maxBytes },
    ),
  isTooLarge: matches('task_compiler_prompt_too_large'),
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
  return `## Summary
One-paragraph summary of the implementation approach.

## Architecture Decisions
Key technical decisions with brief justifications:
- What patterns/approaches to use and why
- What libraries or APIs to leverage
- What tradeoffs were made

## File Structure
Use this exact finite grammar. Include both subsections, even when one has no entries. Put every
project-relative file exactly once in encounter order. Each path line must be followed by one or
more indented non-empty purpose lines. Do not use a tree, glob, prose paragraph, inline comment,
provider-chosen pagination, session file, or artifact path:
${fileStructureExample(ctx)}

## Dependencies
Any new packages or tools needed. For each, specify:
- Package name and version constraint
- Why it's needed
- Any alternatives considered

## Data Model
If the feature involves new types, interfaces, structs, schemas, or data structures, define them here with ${ctx.typeAnnotationStyle}.

## Key Implementation Details
For each major component:
- Function signatures with parameter and return types
- Core logic description (algorithm, data flow)
- How it integrates with existing code
- Error handling approach

## Testing Strategy
- What to test (unit, integration, edge cases)
- Test file locations
- Key test scenarios with expected inputs/outputs`;
}

export function buildPlanPrompt(
  spec: PlanPromptSpec,
  projectContext: string,
  skillsContext?: string,
  languageContext?: LanguageContext,
  options?: PlanPromptOptions,
): string {
  const ctx = languageContext ?? buildLanguageContext(undefined);

  const prompt = buildPrompt({
    title: 'Write Implementation Plan',
    intro:
      'You are writing a detailed implementation plan based on the specification below. The plan defines **how** to build the feature, and feeds the next phase: compiling Product Task Briefs the implementer model will execute against. Be concrete enough that brief compilation does not need to invent decisions.',
    sections: [
      { heading: 'Specification', body: spec.content },
      {
        heading: 'Project Context',
        body: `${projectContext}${skillsContext ? `\n${skillsContext}` : ''}`,
      },
      instructionsSection(
        'Write a complete `plan.md` document that provides a concrete implementation blueprint. Another developer (or AI) should be able to follow this plan without needing to make architectural decisions.',
      ),
      ...buildLanguageContextSections(ctx),
      requiredSectionsSection(requiredSections(ctx)),
    ],
    output: outputInstruction(ctx, { hasClarifications: spec.hasClarifications }),
  });
  return assertPlanPromptBound(prompt, options?.maxPromptBytes);
}

export function planPromptByteLength(prompt: string): number {
  return Buffer.byteLength(prompt, 'utf8');
}

export function assertPlanPromptBound(
  prompt: string,
  maxPromptBytes: number = TASK_BRIEF_COMPILER_POLICY.maxPromptBytes,
): string {
  const actualBytes = planPromptByteLength(prompt);
  if (actualBytes > maxPromptBytes) throw planPromptError.tooLarge(actualBytes, maxPromptBytes);
  return prompt;
}

export function buildRegeneratePrompt(
  artifactType: 'spec' | 'plan',
  currentContent: string,
  feedback: string,
): string {
  const label = artifactType === 'spec' ? 'Specification' : 'Implementation Plan';
  return buildPrompt({
    title: `Regenerate ${label}`,
    intro: `The user reviewed the ${artifactType} and has feedback:`,
    sections: [
      { heading: `Current ${label}`, body: currentContent },
      { heading: 'User Feedback', body: feedback },
      instructionsSection(
        `Regenerate the complete ${artifactType}.md incorporating the user's feedback. Output the full updated document, not just the changes.`,
      ),
    ],
  });
}
