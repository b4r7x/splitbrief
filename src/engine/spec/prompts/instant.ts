import { TASK_FORMAT_EXAMPLE, buildPrompt, instructionsSection } from './shared.js';

export function buildInstantPrompt(
  feature: string,
  projectContext: string,
  skillsContext?: string,
): string {
  const sections = [
    { heading: 'Feature', body: feature },
    { heading: 'Project Context', body: projectContext },
    ...(skillsContext ? [{ heading: 'Skills', body: skillsContext }] : []),
    instructionsSection(`You are given a tiny feature request — the requester has already decided this change is trivial.

1. Do NOT emit a spec or plan section. Output ONLY a tasks list.
2. A single task is fine; do not over-engineer. 1-5 tasks max.
3. Each task MUST be self-contained so a small local model can implement it without additional context.

Use this exact format for each task:

${TASK_FORMAT_EXAMPLE}`),
  ];

  return buildPrompt({
    title: 'Instant: Generate Tasks',
    intro: 'You are implementing a tiny feature in an existing codebase. Emit a minimal task breakdown — no spec, no plan.',
    sections,
    output: 'Write the complete tasks.md content.',
  });
}
