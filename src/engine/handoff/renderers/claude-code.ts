import type { HandoffInput, HandoffPack } from '../types.js';
import { buildBaseFiles, buildTaskListSection } from './base-files.js';

export function renderClaudeCode(input: HandoffInput): HandoffPack {
  const base = buildBaseFiles(input);

  const claudeMd = `# Claude Instructions

Read \`CLAUDE.md\` in the source repo first before making any changes.

Work through the tasks in dependency order. Do not stage or commit. Await review.

${buildTaskListSection(input.tasks)}`;

  const agentDef = `# diptych-handoff Agent

Read tasks in the \`tasks/\` directory in dependency order and implement them.

- Do NOT stage or commit any changes.
- After implementing each task, run typecheck, lint, and test to verify.
- Await human review before any destructive operations.
`;

  return {
    files: [
      ...base,
      { path: 'CLAUDE.md', content: claudeMd },
      { path: '.claude/agents/diptych-handoff.md', content: agentDef },
    ],
  };
}
