import type { LanguageContext } from './language-context.js';
import { buildLanguageContextSections } from './language-context.js';
import { buildPrompt, instructionsSection, requiredSectionsSection } from './prompt-builder.js';

export function buildSpecPrompt(
  feature: string,
  researchOutput: string,
  languageContext?: LanguageContext,
): string {
  return buildPrompt({
    title: 'Write Feature Specification',
    intro:
      'You are writing a detailed specification for a new feature. Use the research findings below to ground your spec in the actual codebase.',
    sections: [
      { heading: 'Specification', body: feature },
      { heading: 'Research Findings', body: researchOutput },
      ...(languageContext ? buildLanguageContextSections(languageContext) : []),
      instructionsSection(
        'Write a complete `spec.md` document that defines **what** to build (not how). The spec should be detailed enough that a developer unfamiliar with the feature request could implement it correctly.',
      ),
      requiredSectionsSection(`### Overview
One-paragraph summary of the feature and its purpose.

### User Scenarios
Concrete usage scenarios showing how users will interact with this feature. Include:
- Primary happy path
- Common variations
- Edge cases and error scenarios

For each scenario, describe the user action and expected outcome.

### Acceptance Criteria
Numbered list of specific, testable criteria that define "done." Each criterion must be verifiable -- no subjective language like "should be fast" or "should be clean."

### Functional Requirements
Detailed requirements organized by area:
- **Inputs**: What data/configuration does the feature accept?
- **Processing**: What transformations, validations, or logic are involved?
- **Outputs**: What does the feature produce?
- **Error handling**: How should failures be communicated?

### Non-Functional Requirements
Performance, security, compatibility, and other quality constraints relevant to this feature.

### Out of Scope
Explicitly list what this feature does NOT include to prevent scope creep.`),
    ],
    output:
      'Write the complete spec.md content. Use clear, precise language. Reference specific files and patterns from the research findings where relevant.',
  });
}
