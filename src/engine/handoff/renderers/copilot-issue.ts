import type { HandoffInput, HandoffPack } from '../types.js';

export function renderCopilotIssue(input: HandoffInput): HandoffPack {
  const taskList = input.tasks
    .map((t) => `- **${t.id}** — ${t.title} (\`${t.file}\`, \`${t.action}\`)`)
    .join('\n');

  const acceptanceCriteria = input.tasks
    .flatMap((t) => t.tests.map((test) => `- ${t.id}: ${test}`))
    .join('\n');

  const constraints =
    input.tasks.flatMap((t) => t.constraints.map((c) => `- ${t.id}: ${c}`)).join('\n') ||
    '- none declared';

  const validationLines: string[] = [];
  if (input.validation?.typecheck)
    validationLines.push(`- typecheck: \`${input.validation.typecheck}\``);
  if (input.validation?.lint) validationLines.push(`- lint: \`${input.validation.lint}\``);
  if (input.validation?.test) validationLines.push(`- test: \`${input.validation.test}\``);
  const validation = validationLines.length > 0 ? validationLines.join('\n') : '- none declared';

  const issue = `## Summary

${input.feature}

## Tasks

${taskList}

## Acceptance Criteria

${acceptanceCriteria}

## Constraints

${constraints}

## Validation

${validation}

## Do not

Do not stage or commit. Await review.
`;

  return {
    files: [{ path: 'issue.md', content: issue }],
  };
}
