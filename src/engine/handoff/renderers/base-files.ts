import type { Task } from '../../../core/schemas/task.js';
import type { HandoffFile, HandoffInput } from '../types.js';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';

function listOrNone(items: string[] | undefined): string {
  if (!items || items.length === 0) return 'none declared';
  return items.map((s) => `- ${s}`).join('\n');
}

export function formatTaskBrief(task: Task): string {
  const dependsOn = task.dependsOn.length > 0 ? task.dependsOn.join(', ') : 'none';

  const scopeInBounds = listOrNone(task.scope?.inBounds);
  const scopeOutOfBounds = listOrNone(task.scope?.outOfBounds);

  const currentCodeSection =
    task.action === 'modify' && task.currentCode
      ? `\n**Current Code:**\n\`\`\`\n${task.currentCode}\n\`\`\``
      : '';

  const steps = task.implementationSteps.map((step, i) => `${i + 1}. ${step}`).join('\n');

  const tests = task.tests.map((t) => `- ${t}`).join('\n');
  const constraints = listOrNone(task.constraints);

  return `---
briefHash: <placeholder>
taskId: ${task.id}
---

# ${task.id} — ${task.title}

**File:** \`${task.file}\` (\`${task.action}\`)
**Depends on:** ${dependsOn}

## Intent

${task.description}

## Scope

**In bounds:**
${scopeInBounds}
**Out of bounds:**
${scopeOutOfBounds}

## Code Context

**Signature:** ${task.signature ?? 'none declared'}
**Pattern:** ${task.pattern ?? 'none declared'}
**Type Defs:** ${task.typeDefs || 'none declared'}${currentCodeSection}

## Implementation Steps

${steps}

## Validation

${tests}

## Constraints

${constraints}

## Escalation

${listOrNone(task.escalation)}

## Evidence

${listOrNone(task.evidence)}
`;
}

export function taskLink(task: Task): string {
  return `- [${task.id}](tasks/${task.id}.md) — ${task.title}`;
}

export function buildTaskListSection(tasks: Task[]): string {
  return `## Tasks\n\n${tasks.map(taskLink).join('\n')}\n`;
}

export function buildBaseFiles(input: HandoffInput & { tasks: Task[] }): HandoffFile[] {
  const files: HandoffFile[] = [];

  const readme = `# Handoff Pack

This folder contains a ${SPLITBRIEF_IDENTITY.displayName} Handoff Pack for: **${input.feature}**

Run \`claude\`, \`codex exec\`, or \`cursor\` in this folder. Work through the tasks in the \`tasks/\` directory in dependency order.
`;
  files.push({ path: 'README.md', content: readme });

  for (const task of input.tasks) {
    files.push({
      path: `tasks/${task.id}.md`,
      content: formatTaskBrief(task),
    });
  }

  if (input.spec) {
    files.push({ path: 'spec.md', content: input.spec });
  }
  if (input.plan) {
    files.push({ path: 'plan.md', content: input.plan });
  }
  if (input.constitution) {
    files.push({ path: 'constitution.md', content: input.constitution });
  }

  return files;
}
