const RESEARCH_SECTIONS = [
  'Project Overview',
  'Architecture',
  'Relevant Code',
  'Patterns to Follow',
  'Dependencies & Constraints',
  'Implementation Considerations',
  'Validation Tools',
];
const SPEC_SECTIONS = [
  'Overview',
  'User Scenarios',
  'Acceptance Criteria',
  'Functional Requirements',
  'Non-Functional Requirements',
  'Out of Scope',
];
const PLAN_SECTIONS = [
  'Summary',
  'Architecture Decisions',
  'File Structure',
  'Dependencies',
  'Data Model',
  'Key Implementation Details',
  'Testing Strategy',
];

/** The documents an older multi-step planning chain wrote, as a run that stopped mid-chain holds them. */
export const PLANNER_DOCUMENT_FIXTURES = {
  research:
    '# Research\n\n' + RESEARCH_SECTIONS.map((heading) => `## ${heading}\nFindings.`).join('\n\n'),
  spec: '# Spec\n\n' + SPEC_SECTIONS.map((heading) => `## ${heading}\nRequirements.`).join('\n\n'),
  plan:
    '# Plan\n\n' +
    PLAN_SECTIONS.map(
      (heading) =>
        `## ${heading}\n${heading === 'File Structure' ? '### New Files\n- `src/auth.ts`\n  Purpose: the module.\n### Modified Files\nNone.' : 'Implementation details.'}`,
    ).join('\n\n'),
};
