import type { LanguageContext } from './language-context.js';
import { buildLanguageContext, buildLanguageContextSections } from './language-context.js';
import { buildPrompt, instructionsSection, requiredSectionsSection } from './prompt-builder.js';

type PlanPromptSpec = {
  content: string;
  hasClarifications: boolean;
};

function outputInstruction(hasClarifications: boolean, ctx: LanguageContext): string {
  const base =
    ctx.language === 'TypeScript'
      ? 'Write the complete plan.md content. Be specific -- use actual file paths, function names, and type definitions from the project.'
      : 'Write the complete plan.md content. Be specific -- use actual file paths, function names, and type or data-shape definitions from the project.';
  if (!hasClarifications) return base;

  return `${base}

Note: The specification contains a Clarifications section with user decisions. Reference these decisions in your plan.`;
}

function fileStructureExample(ctx: LanguageContext): string {
  const extension = ctx.fileExtension || '.ext';
  return `\`\`\`
src/
  new-file${extension}       # Description of purpose
  modified-file${extension}  # What changes and why
\`\`\``;
}

function requiredSections(ctx: LanguageContext): string {
  return `### Summary
One-paragraph summary of the implementation approach.

### Architecture Decisions
Key technical decisions with brief justifications:
- What patterns/approaches to use and why
- What libraries or APIs to leverage
- What tradeoffs were made

### File Structure
List every file that will be created or modified, with a one-line description of each:
${fileStructureExample(ctx)}

### Dependencies
Any new packages or tools needed. For each, specify:
- Package name and version constraint
- Why it's needed
- Any alternatives considered

### Data Model
If the feature involves new types, interfaces, structs, schemas, or data structures, define them here with ${ctx.typeAnnotationStyle}.

### Key Implementation Details
For each major component:
- Function signatures with parameter and return types
- Core logic description (algorithm, data flow)
- How it integrates with existing code
- Error handling approach

### Testing Strategy
- What to test (unit, integration, edge cases)
- Test file locations
- Key test scenarios with expected inputs/outputs`;
}

export function buildPlanPrompt(
  spec: PlanPromptSpec,
  projectContext: string,
  skillsContext?: string,
  languageContext?: LanguageContext,
): string {
  const ctx = languageContext ?? buildLanguageContext(undefined);

  return buildPrompt({
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
    output: outputInstruction(spec.hasClarifications, ctx),
  });
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
