import { buildPrompt, instructionsSection } from './shared.js';

export function buildResearchPrompt(feature: string, projectContext: string, skillsContext?: string): string {
  return buildPrompt({
    title: 'Research Task',
    intro: 'You are preparing to implement a new feature. Before writing any specification, you need to deeply understand the existing codebase.',
    sections: [
      { heading: 'Specification', body: feature },
      { heading: 'Project Context', body: `${projectContext}${skillsContext ? `\n${skillsContext}` : ''}` },
      instructionsSection(`Analyze this codebase thoroughly:

1. **Read key files** -- Identify and read the most important source files: entry points, core modules, configuration, and type definitions.

2. **Understand architecture** -- Map out:
   - How the project is structured (directories, module boundaries)
   - The data flow between components
   - Key abstractions and patterns used
   - How configuration and state are managed

3. **Identify relevant code** -- Find:
   - Files that will need to be modified for this feature
   - Existing patterns that the new code should follow
   - Related functionality that already exists
   - Shared types, utilities, and helpers that can be reused

4. **Note constraints** -- Document:
   - Coding conventions (naming, style, error handling)
   - Testing patterns and test infrastructure
   - Build and runtime requirements
   - Any technical debt or limitations that affect this feature`),
      {
        heading: 'Output Format',
        body: `Write a structured research report in markdown with these sections:

### Project Overview
Brief summary of what the project does and how it's built.

### Architecture
Key modules, their responsibilities, and how they interact.

### Relevant Code
Files and functions directly relevant to the requested feature. Include file paths and brief descriptions.

### Patterns to Follow
Coding patterns, conventions, and styles found in the codebase that new code must match.

### Dependencies & Constraints
Technical constraints, runtime requirements, and existing limitations.

### Implementation Considerations
Initial thoughts on how the feature might fit into the existing architecture.`,
      },
      {
        heading: 'User Interaction',
        body: `After completing your research, if you identify important decisions or design ambiguities that would benefit from user input, embed them as interactive questions using this exact format:

<!-- Q:{"id":"unique_id","type":"choice","text":"Your question here?","options":["Option 1","Option 2","Option 3"],"default":0} -->

Question types:
- "choice": Multiple choice with options array (default is index)
- "input": Free text answer (default is suggested text)
- "confirm": Yes/no (default is boolean)

Rules:
- Maximum 5 questions
- Only ask about decisions that materially impact the spec
- Base questions on what you found in the codebase (not generic)
- If you found the answer in the codebase, don't ask — just use it`,
      },
    ],
  });
}
