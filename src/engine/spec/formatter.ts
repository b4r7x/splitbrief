import YAML from 'yaml';
import type { Task } from '../../core/schemas/task.js';
import { TASK_BRIEF_HEADINGS } from './headings.js';

function yamlScalar(value: string): string {
  if (/[\r\n]/.test(value)) return JSON.stringify(value);
  return YAML.stringify(value, { lineWidth: 0 }).replace(/\r?\n$/, '');
}

export function buildScopeLines(scope: Task['scope']): string[] {
  const inBounds = scope?.inBounds ?? [];
  const outOfBounds = scope?.outOfBounds ?? [];
  const approvedOutOfBounds = scope?.approvedOutOfBounds ?? [];
  if (inBounds.length === 0 && outOfBounds.length === 0 && approvedOutOfBounds.length === 0) {
    return [];
  }

  const lines: string[] = [];
  if (inBounds.length > 0) {
    lines.push('**In bounds:**', ...inBounds.map((b) => `- ${b}`));
  }
  if (outOfBounds.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('**Out of bounds:**', ...outOfBounds.map((b) => `- ${b}`));
  }
  if (approvedOutOfBounds.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('**Approved out of bounds:**', ...approvedOutOfBounds.map((b) => `- ${b}`));
  }
  return lines;
}

function fenceBlock(content: string): string {
  let longestRun = 0;
  for (const match of content.matchAll(/`+/g)) {
    if (match[0].length > longestRun) longestRun = match[0].length;
  }
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${content}\n${fence}`;
}

function formatSingleTask(task: Task): string {
  const lines: string[] = [];

  const dependsOnYaml = task.dependsOn.map((id) => `  - ${id}`).join('\n');

  lines.push('---');
  lines.push(`id: ${yamlScalar(task.id)}`);
  lines.push(`title: ${yamlScalar(task.title)}`);
  lines.push(`action: ${yamlScalar(task.action)}`);
  lines.push(`file: ${yamlScalar(task.file)}`);
  if (task.dependsOn.length > 0) {
    lines.push('depends_on:');
    lines.push(dependsOnYaml);
  } else {
    lines.push('depends_on: []');
  }
  lines.push('---');

  lines.push('');
  lines.push(TASK_BRIEF_HEADINGS.description.heading);
  lines.push(task.description);

  if (task.implementationSteps.length > 0) {
    lines.push('');
    lines.push(TASK_BRIEF_HEADINGS.implementationSteps.heading);
    for (let i = 0; i < task.implementationSteps.length; i++) {
      lines.push(`${i + 1}. ${task.implementationSteps[i]}`);
    }
  }

  if (task.tests.length > 0) {
    lines.push('');
    lines.push(TASK_BRIEF_HEADINGS.tests.heading);
    for (const t of task.tests) {
      lines.push(`- ${t}`);
    }
  }

  if (task.constraints.length > 0) {
    lines.push('');
    lines.push(TASK_BRIEF_HEADINGS.constraints.heading);
    for (const c of task.constraints) {
      lines.push(`- ${c}`);
    }
  }

  if (task.signature) {
    lines.push('');
    lines.push(TASK_BRIEF_HEADINGS.signature.heading);
    lines.push(fenceBlock(task.signature));
  }

  if (task.currentCode) {
    lines.push('');
    lines.push(TASK_BRIEF_HEADINGS.currentCode.heading);
    lines.push(fenceBlock(task.currentCode));
  }

  if (task.typeDefs) {
    lines.push('');
    lines.push(TASK_BRIEF_HEADINGS.typeDefs.heading);
    lines.push(fenceBlock(task.typeDefs));
  }

  if (task.pattern) {
    lines.push('');
    lines.push(TASK_BRIEF_HEADINGS.pattern.heading);
    lines.push(task.pattern);
  }

  const scopeLines = buildScopeLines(task.scope);
  if (scopeLines.length > 0) {
    lines.push('', TASK_BRIEF_HEADINGS.scope.heading, ...scopeLines);
  }

  if (task.escalation && task.escalation.length > 0) {
    lines.push('');
    lines.push(TASK_BRIEF_HEADINGS.escalation.heading);
    for (const e of task.escalation) {
      lines.push(`- ${e}`);
    }
  }

  if (task.evidence && task.evidence.length > 0) {
    lines.push('');
    lines.push(TASK_BRIEF_HEADINGS.evidence.heading);
    for (const e of task.evidence) {
      lines.push(`- ${e}`);
    }
  }

  return lines.join('\n');
}

export function formatTasks(tasks: Task[]): string {
  if (tasks.length === 0) return '';
  return tasks.map(formatSingleTask).join('\n');
}
