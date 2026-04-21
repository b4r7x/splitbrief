import { buildPrompt, instructionsSection } from './shared.js';

export function buildAnalyzePrompt(spec: string, plan: string, tasks: string): string {
  return buildPrompt({
    title: 'Spec ↔ Plan ↔ Tasks Analysis',
    intro:
      'Cross-check the three artifacts and emit coverage metrics. Identify gaps where the plan or tasks fail to address parts of the spec.',
    sections: [
      { heading: 'Spec', body: spec },
      { heading: 'Plan', body: plan },
      { heading: 'Tasks', body: tasks },
      instructionsSection(`Compute coverage metrics across the three artifacts:
- specTaskCoverage: fraction of spec requirements referenced by at least one task (0..1)
- planTaskCoverage: fraction of plan steps referenced by at least one task (0..1)
- orphanTasks: task IDs with no corresponding spec or plan anchor
- unaddressedSpecSections: spec section headings not covered by any task
- warnings: any cross-artifact inconsistencies you notice

Output STRICT JSON only, wrapped in a fenced \`\`\`json block. Do not include prose outside the JSON.`),
      {
        heading: 'Output Format',
        body: `\`\`\`json
{
  "specTaskCoverage": 1.0,
  "planTaskCoverage": 1.0,
  "orphanTasks": [],
  "unaddressedSpecSections": [],
  "warnings": []
}
\`\`\``,
      },
    ],
  });
}
