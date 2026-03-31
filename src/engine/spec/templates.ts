import type { Task } from '../../types.js';

export function buildResearchPrompt(feature: string, projectContext: string): string {
  return `# Research Task

You are preparing to implement a new feature. Before writing any specification, you need to deeply understand the existing codebase.

## Feature Request
${feature}

## Project Context
${projectContext}

## Instructions

Analyze this codebase thoroughly:

1. **Read key files**  -  Identify and read the most important source files: entry points, core modules, configuration, and type definitions.

2. **Understand architecture**  -  Map out:
   - How the project is structured (directories, module boundaries)
   - The data flow between components
   - Key abstractions and patterns used
   - How configuration and state are managed

3. **Identify relevant code**  -  Find:
   - Files that will need to be modified for this feature
   - Existing patterns that the new code should follow
   - Related functionality that already exists
   - Shared types, utilities, and helpers that can be reused

4. **Note constraints**  -  Document:
   - Coding conventions (naming, style, error handling)
   - Testing patterns and test infrastructure
   - Build and runtime requirements
   - Any technical debt or limitations that affect this feature

## Output Format

Write a structured research report in markdown with these sections:

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
Initial thoughts on how the feature might fit into the existing architecture.

## User Interaction

After completing your research, if you identify important decisions or design ambiguities that would benefit from user input, embed them as interactive questions using this exact format:

<!-- Q:{"id":"unique_id","type":"choice","text":"Your question here?","options":["Option 1","Option 2","Option 3"],"default":0} -->

Question types:
- "choice": Multiple choice with options array (default is index)
- "input": Free text answer (default is suggested text)
- "confirm": Yes/no (default is boolean)

Rules:
- Maximum 5 questions
- Only ask about decisions that materially impact the spec
- Base questions on what you found in the codebase (not generic)
- If you found the answer in the codebase, don't ask — just use it`;
}

export function buildSpecPrompt(feature: string, researchOutput: string, clarifications?: Array<{question: string, answer: string}>): string {
  return `# Write Feature Specification

You are writing a detailed specification for a new feature. Use the research findings below to ground your spec in the actual codebase.

## Feature Request
${feature}

## Research Findings
${researchOutput}

## Instructions

Write a complete \`spec.md\` document that defines **what** to build (not how). The spec should be detailed enough that a developer unfamiliar with the feature request could implement it correctly.

## Required Sections

### Overview
One-paragraph summary of the feature and its purpose.

### User Scenarios
Concrete usage scenarios showing how users will interact with this feature. Include:
- Primary happy path
- Common variations
- Edge cases and error scenarios

For each scenario, describe the user action and expected outcome.

### Acceptance Criteria
Numbered list of specific, testable criteria that define "done." Each criterion must be verifiable  -  no subjective language like "should be fast" or "should be clean."

### Functional Requirements
Detailed requirements organized by area:
- **Inputs**: What data/configuration does the feature accept?
- **Processing**: What transformations, validations, or logic are involved?
- **Outputs**: What does the feature produce?
- **Error handling**: How should failures be communicated?

### Non-Functional Requirements
Performance, security, compatibility, and other quality constraints relevant to this feature.

### Out of Scope
Explicitly list what this feature does NOT include to prevent scope creep.

## Output

Write the complete spec.md content. Use clear, precise language. Reference specific files and patterns from the research findings where relevant.${clarifications && clarifications.length > 0 ? `

## User Clarifications

The user answered the following questions during research:
${clarifications.map(c => `- Q: ${c.question} → A: ${c.answer}`).join('\n')}

Integrate these answers into the spec. Do not ask about these topics — they are decided.` : ''}`;
}

export function buildPlanPrompt(spec: string, projectContext: string): string {
  return `# Write Implementation Plan

You are writing a detailed implementation plan based on the specification below. The plan defines **how** to build the feature.

## Specification
${spec}

## Project Context
${projectContext}

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

export function buildTasksPrompt(spec: string, plan: string): string {
  return `# Write Implementation Tasks

You are breaking down an implementation plan into atomic, self-contained tasks. Each task will be sent independently to an implementer model for implementation  -  the model will have NO access to the spec, plan, or other tasks. Every task must contain ALL context needed to complete it.

## Specification
${spec}

## Implementation Plan
${plan}

## Instructions

Write a \`tasks.md\` file containing ordered, atomic tasks. Each task represents a single file operation (create or modify one file).

## Task Format

Each task MUST use this exact format:

\`\`\`markdown
---
id: T001
title: Short descriptive title
action: create | modify
file: src/path/to/file.ts
depends_on: [] | [T001, T002]
---

### Description
Detailed explanation of what to implement. Include all relevant context:
- WHY this code is needed (its role in the system)
- HOW it fits with other modules (what imports it, what it imports)
- WHAT specific behavior is expected

### Signature
\\\`\\\`\\\`typescript
// Exact function/type signatures to implement
export function exampleFn(param: Type): ReturnType
\\\`\\\`\\\`

### Type Definitions
\\\`\\\`\\\`typescript
// Copy ALL TypeScript interfaces/types referenced in the function signature,
// tests, or description. Copy verbatim from source files.
// Keep under ~300 tokens. Prioritize types in the function signature.
export interface ExampleType {
  field: string;
}
\\\`\\\`\\\`

### Implementation Steps
1. Step-by-step description of HOW to implement (not just WHAT)
2. Include specific function calls, patterns, and logic flow
3. 3-5 numbered steps maximum

### Tests
- Test case 1: Given X, expect Y
- Test case 2: Given A, expect B
- Edge case: Given null/empty/invalid, expect Z

### Constraints
- Do not add extra exports
- Follow ESM conventions (use .js extensions in imports)
- Any other rules specific to this task
\`\`\`

## Critical Rules

1. **Self-contained**: Each task must inline ALL context needed. Include relevant type definitions, import paths, function signatures from dependencies, and expected patterns. The implementer cannot look up other files.

2. **Atomic**: One task = one file. Either create a new file or modify an existing one. Never split a single file across tasks or combine multiple files in one task.

3. **Dependency-ordered**: Tasks must be ordered so that dependencies come first. Use \`depends_on\` to declare which tasks must complete before this one. If tasks have no dependencies on each other, they can be marked as parallelizable.

4. **Concrete tests**: Every task must include specific test cases with concrete inputs and expected outputs  -  not vague descriptions like "should work correctly."

5. **Inline type definitions**: If a task depends on types defined in another file, copy the relevant type definitions into the task description so the implementer has them.

6. **Implementation steps**: Every task must include 3-5 numbered steps in ### Implementation Steps describing HOW to implement the task. Include specific function calls, patterns to use, and logic flow. The implementer is a small model — it needs concrete guidance, not abstract descriptions.

7. **Type definitions section**: Every task must include a ### Type Definitions section with all TypeScript types referenced in the function signature, tests, or description. Copy the full interface/type definitions verbatim from source files. Max ~300 tokens — prioritize types that appear in the function signature.

8. **Import paths**: Specify exact import paths the implementer should use, including \`.js\` extensions for ESM.

9. **Pattern examples**: If the codebase has an established pattern the task should follow, include a brief example in the task.

## Output

Write the complete tasks.md content with all tasks in dependency order. Group related tasks into phases with a brief purpose statement for each phase.`;
}

export function buildFinalReviewPrompt(spec: string, diff: string): string {
  return `# Final Implementation Review

You are reviewing a completed implementation against its specification. Your job is to verify that the implementation satisfies the spec and identify any issues.

## Specification
${spec}

## Implementation Diff
\`\`\`diff
${diff}
\`\`\`

## Instructions

Review the implementation diff against every acceptance criterion and requirement in the spec. Be thorough but fair  -  minor style differences are acceptable; missing functionality or incorrect behavior is not.

## Review Checklist

1. **Acceptance Criteria**: Check each criterion from the spec. Is it satisfied by the implementation?
2. **Functional Requirements**: Are all inputs handled? Is processing correct? Are outputs as specified?
3. **Error Handling**: Are error cases handled as specified?
4. **Edge Cases**: Are boundary conditions addressed?
5. **Type Safety**: Are types correct and complete?
6. **Code Quality**: Are there obvious bugs, security issues, or performance problems?

## Output Format

Respond with exactly this structure:

### Verdict
One of: \`pass\` | \`pass_with_notes\` | \`fail\`

### Criteria Results
For each acceptance criterion from the spec:
- **[PASS]** or **[FAIL]** Criterion description  -  brief explanation

### Findings
List any issues found, categorized as:
- **Critical**: Breaks functionality or violates a requirement (causes \`fail\` verdict)
- **Warning**: Works but has potential issues (allowed in \`pass_with_notes\`)
- **Note**: Minor observations, suggestions for improvement (informational only)

### Summary
One-paragraph overall assessment.`;
}

export function buildHintPrompt(task: Task, error: string): string {
  return `# Diagnose Implementation Failure

An implementer model attempted to implement the task below but the result failed validation. Provide a concise diagnosis and approach hint  -  do NOT write code.

## Task
**ID**: ${task.id}
**Title**: ${task.title}
**Action**: ${task.action}
**File**: ${task.file}

### Description
${task.description}

${task.signature ? `### Expected Signature\n\`\`\`typescript\n${task.signature}\n\`\`\`` : ''}

### Constraints
${task.constraints.length > 0 ? task.constraints.map(c => `- ${c}`).join('\n') : 'None specified.'}

## Validation Error
\`\`\`
${error}
\`\`\`

## Instructions

In ~500 tokens or less, provide:

1. **Root cause**: What specifically went wrong? Parse the error message and identify the exact issue.
2. **Fix approach**: Describe the approach to fix it in plain language. Be specific  -  mention exact function names, types, or patterns to use.
3. **Common pitfall**: If this is a common mistake (e.g., missing .js extension, wrong import path, incorrect type), say so explicitly.

Do NOT write code. Only explain the diagnosis and approach.`;
}

export function buildEscalationPrompt(task: Task, lastAttempt: string, error: string): string {
  return `# Escalation: Implement Fix

The implementer model failed to implement the task below after multiple attempts. You must provide the correct, complete implementation.

## Task
**ID**: ${task.id}
**Title**: ${task.title}
**Action**: ${task.action}
**File**: ${task.file}

### Description
${task.description}

${task.signature ? `### Expected Signature\n\`\`\`typescript\n${task.signature}\n\`\`\`` : ''}

${task.tests.length > 0 ? `### Tests That Must Pass\n${task.tests.map(t => `- ${t}`).join('\n')}` : ''}

### Constraints
${task.constraints.length > 0 ? task.constraints.map(c => `- ${c}`).join('\n') : 'None specified.'}

## Last Failed Attempt
\`\`\`
${lastAttempt}
\`\`\`

## Validation Error
\`\`\`
${error}
\`\`\`

## Instructions

1. Analyze the failed attempt and the error to understand what went wrong.
2. Write the correct, complete implementation for \`${task.file}\`.
3. Ensure all tests and constraints are satisfied.
4. Follow existing project conventions (ESM imports with .js extensions, pure functions, no classes).

Respond with the complete file content for \`${task.file}\`. Do not include explanations outside the code.`;
}
