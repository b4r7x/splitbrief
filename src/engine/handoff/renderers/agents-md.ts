import type { HandoffInput, HandoffPack } from '../types.js';
import { buildBaseFiles, taskLink } from './shared.js';

export function renderAgentsMd(input: HandoffInput): HandoffPack {
  const base = buildBaseFiles(input);

  const taskLines = input.tasks.map(taskLink).join('\n');
  const agentsMd = `# Project Instructions

This is a diptych Handoff Pack. Work through the tasks listed below in dependency order. Do not stage or commit. Await review.

## Tasks

${taskLines}
`;

  return {
    files: [
      ...base,
      { path: 'AGENTS.md', content: agentsMd },
    ],
  };
}
