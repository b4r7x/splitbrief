import { TASK_FORMAT_EXAMPLE, buildPrompt } from './shared.js';

export function buildTasksPrompt(spec: string, plan: string): string {
  return buildPrompt({
    title: 'Write Implementation Tasks',
    intro: 'You are breaking down an implementation plan into atomic, self-contained tasks. Each task will be sent independently to an implementer model for implementation  -  the model will have NO access to the spec, plan, or other tasks. Every task must contain ALL context needed to complete it.',
    sections: [
      { heading: 'Specification', body: spec },
      { heading: 'Implementation Plan', body: plan },
      {
        heading: 'Instructions',
        body: `Write a \`tasks.md\` file containing ordered, atomic tasks. Each task represents a single file operation (create or modify one file).`,
      },
      {
        heading: 'Task Format',
        body: `Each task MUST use this exact format:

${TASK_FORMAT_EXAMPLE}`,
      },
      {
        heading: 'Critical Rules',
        body: `1. **Self-contained**: Each task must inline ALL context needed. Include relevant type definitions, import paths, function signatures from dependencies, and expected patterns. The implementer cannot look up other files.

2. **Atomic**: One task = one file. Either create a new file or modify an existing one. Never split a single file across tasks or combine multiple files in one task.

3. **Dependency-ordered**: Tasks must be ordered so that dependencies come first. Use \`depends_on\` to declare which tasks must complete before this one. If tasks have no dependencies on each other, they can be marked as parallelizable.

4. **Concrete tests**: Every task must include specific test cases with concrete inputs and expected outputs  -  not vague descriptions like "should work correctly."

5. **Inline type definitions**: If a task depends on types defined in another file, copy the relevant type definitions into the task description so the implementer has them.

6. **Implementation steps**: Every task must include 3-5 numbered steps in ### Implementation Steps describing HOW to implement the task. Include specific function calls, patterns to use, and logic flow. The implementer is a small model — it needs concrete guidance, not abstract descriptions.

7. **Type definitions section**: Every task must include a ### Type Definitions section with all TypeScript types referenced in the function signature, tests, or description. Copy the full interface/type definitions verbatim from source files. Max ~300 tokens — prioritize types that appear in the function signature.

8. **Import paths**: Specify exact import paths the implementer should use, including \`.js\` extensions for ESM.

9. **Pattern examples**: If the codebase has an established pattern the task should follow, include a brief example in the task.`,
      },
    ],
    output: 'Write the complete tasks.md content with all tasks in dependency order. Group related tasks into phases with a brief purpose statement for each phase.',
  });
}
