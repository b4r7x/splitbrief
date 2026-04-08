export function buildPlanPrompt(spec: string, projectContext: string, skillsContext?: string): string {
  return `# Write Implementation Plan

You are writing a detailed implementation plan based on the specification below. The plan defines **how** to build the feature.

## Specification
${spec}

## Project Context
${projectContext}
${skillsContext ? `\n${skillsContext}\n` : ''}
## Instructions

Write a complete \`plan.md\` document that provides a concrete implementation blueprint. Another developer (or AI) should be able to follow this plan without needing to make architectural decisions.

## Required Sections

### Summary
One-paragraph summary of the implementation approach.

### Architecture Decisions
Key technical decisions with brief justifications:
- What patterns/approaches to use and why
- What libraries or APIs to leverage
- What tradeoffs were made

### File Structure
List every file that will be created or modified, with a one-line description of each:
\`\`\`
src/
  new-file.ts       # Description of purpose
  modified-file.ts  # What changes and why
\`\`\`

### Dependencies
Any new packages or tools needed. For each, specify:
- Package name and version constraint
- Why it's needed
- Any alternatives considered

### Data Model
If the feature involves new types, interfaces, or data structures, define them here with TypeScript type definitions.

### Key Implementation Details
For each major component:
- Function signatures with parameter and return types
- Core logic description (algorithm, data flow)
- How it integrates with existing code
- Error handling approach

### Testing Strategy
- What to test (unit, integration, edge cases)
- Test file locations
- Key test scenarios with expected inputs/outputs

## Output

Write the complete plan.md content. Be specific  -  use actual file paths, function names, and type definitions from the project.${spec.includes('## Clarifications') ? `

Note: The specification contains a Clarifications section with user decisions. Reference these decisions in your plan.` : ''}`;
}

export function buildRegeneratePrompt(artifactType: 'spec' | 'plan', currentContent: string, feedback: string): string {
  const label = artifactType === 'spec' ? 'Specification' : 'Implementation Plan';
  return `# Regenerate ${label}

The user reviewed the ${artifactType} and has feedback:

## Current ${label}
${currentContent}

## User Feedback
${feedback}

## Instructions

Regenerate the complete ${artifactType}.md incorporating the user's feedback. Output the full updated document, not just the changes.`;
}
