import { buildPrompt, instructionsSection } from './shared.js';

export interface ConstitutionPromptInput {
  feature: string;
  spec: string;
  constitutionContent: string;
}

export function buildConstitutionPrompt(input: ConstitutionPromptInput): string {
  const { feature, spec, constitutionContent } = input;
  return buildPrompt({
    title: 'Constitution Check',
    intro:
      'You are given a feature description, an optional spec, and a project constitution. Identify any violations of constitutional principles.',
    sections: [
      { heading: 'Constitution', body: constitutionContent || '(no constitution.md present)' },
      { heading: 'Feature', body: feature },
      {
        heading: 'Spec',
        body: spec || '(spec not yet written; evaluate against the feature description)',
      },
      instructionsSection(`A violation is "hard" if it would require rewriting core architecture or violates a non-negotiable principle. A violation is "soft" if it is a style or convention concern.

If no violations are found, output: { "passed": true, "violations": [] }

Output STRICT JSON only. Do not include any prose outside the JSON block. Wrap the JSON in a fenced \`\`\`json block.`),
      {
        heading: 'Output Format',
        body: `\`\`\`json
{
  "passed": true,
  "violations": [
    { "principle": "<principle name>", "reason": "<why this violates>", "severity": "hard" }
  ]
}
\`\`\``,
      },
    ],
  });
}
