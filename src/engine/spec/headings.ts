export const TASK_BRIEF_HEADINGS = {
  description: { heading: '### Description', keys: ['description', 'what to do'] },
  signature: { heading: '### Signature', keys: ['signature', 'function signature'] },
  typeDefs: { heading: '### Type Definitions', keys: ['type definitions', 'types'] },
  pattern: { heading: '### Pattern', keys: ['pattern'] },
  implementationSteps: {
    heading: '### Implementation Steps',
    keys: ['implementation steps'],
  },
  tests: { heading: '### Tests', keys: ['tests'] },
  constraints: { heading: '### Constraints', keys: ['constraints'] },
  currentCode: { heading: '### Current Code', keys: ['current code'] },
  scope: { heading: '### Scope', keys: ['scope'] },
  escalation: { heading: '### Escalation', keys: ['escalation'] },
  evidence: { heading: '### Evidence', keys: ['evidence'] },
} as const;

export const REQUIRED_BRIEF_SECTIONS = [
  'Description (Intent)',
  'Scope',
  'Implementation Steps',
  'Tests (Validation)',
  'Constraints',
  'Escalation',
  'Evidence',
  'Type Definitions',
] as const;
