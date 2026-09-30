import { PLANNER_DOCUMENT_SECTIONS } from '../../../core/pipeline-spec/planner-documents.js';
import {
  plannerConversationSection,
  buildPrompt,
  EXACT_HEADINGS_INSTRUCTION,
  instructionsSection,
  skillsSection,
} from './builder.js';

export function buildResearchPrompt(
  feature: string,
  projectContext: string,
  skillsContext?: string,
): string {
  return buildPrompt({
    title: 'Research Task',
    intro:
      'You are preparing to implement a new feature. Before writing any specification, you need to deeply understand the existing codebase.',
    sections: [
      plannerConversationSection,
      { heading: 'Specification', body: feature },
      { heading: 'Project Context', body: projectContext },
      ...skillsSection(skillsContext),
      instructionsSection(`Analyze this codebase thoroughly:

1. **Read key files** -- Identify and read the most important source files: entry points, core modules, configuration, and language-specific type or schema definitions.

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
        body: `Write a structured research report in markdown with these sections. ${EXACT_HEADINGS_INSTRUCTION}

### ${PLANNER_DOCUMENT_SECTIONS.research[0]}
Brief summary of what the project does and how it's built.

### ${PLANNER_DOCUMENT_SECTIONS.research[1]}
Key modules, their responsibilities, and how they interact.

### ${PLANNER_DOCUMENT_SECTIONS.research[2]}
Files and functions directly relevant to the requested feature. Include file paths and brief descriptions.

### ${PLANNER_DOCUMENT_SECTIONS.research[3]}
Coding patterns, conventions, and styles found in the codebase that new code must match.

### ${PLANNER_DOCUMENT_SECTIONS.research[4]}
Technical constraints, runtime requirements, and existing limitations.

### ${PLANNER_DOCUMENT_SECTIONS.research[5]}
Initial thoughts on how the feature might fit into the existing architecture.

### ${PLANNER_DOCUMENT_SECTIONS.research[6]}

Identify the project's validation toolchain by reading config files:
- **Language**: Primary programming language as a lowercase name from project manifests and source files
- **Type checker**: Command to run type checking (e.g., \`cargo check\`, \`mypy src/\`, \`go vet ./...\`), or "none"
- **Linter**: Command to run linting (e.g., \`npx biome check\`, \`cargo clippy\`, \`ruff check\`, \`golangci-lint run\`), or "none"
- **Test runner**: Command to run tests (e.g., \`cargo test\`, \`pytest\`, \`go test ./...\`, the project's own test script)
- **Test file pattern**: How test files are named (e.g., \`*_test.go\`, \`test_*.py\`, colocated unit-test suffixes)`,
      },
    ],
  });
}
