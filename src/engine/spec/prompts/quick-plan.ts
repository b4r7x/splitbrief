import { TASK_FORMAT_EXAMPLE, buildPrompt } from './shared.js';

export function buildQuickPlanPrompt(feature: string, projectContext: string): string {
  return buildPrompt({
    title: 'Quick Plan: Generate Tasks',
    intro: 'You are implementing a feature in an existing codebase. Briefly analyze the project, then produce an ordered list of atomic implementation tasks.',
    sections: [
      { heading: 'Feature Request', body: feature },
      { heading: 'Project Context', body: projectContext },
      {
        heading: 'Instructions',
        body: `1. Briefly review the codebase structure and identify files to create or modify.
2. Output a \`tasks.md\` file with atomic, self-contained tasks. Each task = one file.

Use this exact format for each task:

${TASK_FORMAT_EXAMPLE}`,
      },
      {
        heading: 'Rules',
        body: `- One task per file. Self-contained with all context inlined.
- Dependency-ordered. Use \`depends_on\` for sequencing.
- No spec or plan document needed — just tasks.`,
      },
    ],
    output: 'Write the complete tasks.md content.',
  });
}
