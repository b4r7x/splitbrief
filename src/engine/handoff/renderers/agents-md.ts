import type { HandoffInput, HandoffPack } from '../types.js';
import { buildBaseFiles, buildTaskListSection } from './base-files.js';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';

export function renderAgentsMd(input: HandoffInput): HandoffPack {
  const base = buildBaseFiles(input);

  const agentsMd = `# Project Instructions

This is a ${SPLITBRIEF_IDENTITY.displayName} Handoff Pack. Work through the tasks listed below in dependency order. Do not stage or commit. Await review.

${buildTaskListSection(input.tasks)}`;

  return {
    files: [...base, { path: 'AGENTS.md', content: agentsMd }],
  };
}
