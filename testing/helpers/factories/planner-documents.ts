import { PLANNER_DOCUMENT_SECTIONS } from '../../../src/core/pipeline-spec/planner-documents.js';

/** The documents an older multi-step planning chain wrote, as a run that stopped mid-chain holds them. */
export const PLANNER_DOCUMENT_FIXTURES = {
  research:
    '# Research\n\n' +
    PLANNER_DOCUMENT_SECTIONS.research.map((heading) => `## ${heading}\nFindings.`).join('\n\n'),
  spec:
    '# Spec\n\n' +
    PLANNER_DOCUMENT_SECTIONS.spec.map((heading) => `## ${heading}\nRequirements.`).join('\n\n'),
  plan:
    '# Plan\n\n' +
    PLANNER_DOCUMENT_SECTIONS.plan
      .map(
        (heading) =>
          `## ${heading}\n${heading === 'File Structure' ? '### New Files\n- `src/auth.ts`\n  Purpose: the module.\n### Modified Files\nNone.' : 'Implementation details.'}`,
      )
      .join('\n\n'),
};
