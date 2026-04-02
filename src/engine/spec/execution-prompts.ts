import type { Task } from '../../types.js';

export function buildHintPrompt(task: Task, error: string): string {
  return `# Diagnose Implementation Failure

An implementer model attempted to implement the task below but the result failed validation. Provide a concise diagnosis and approach hint  -  do NOT write code.

## Task
**ID**: ${task.id}
**Title**: ${task.title}
**Action**: ${task.action}
**File**: ${task.file}

### Description
${task.description}

${task.signature ? `### Expected Signature\n\`\`\`typescript\n${task.signature}\n\`\`\`` : ''}

### Constraints
${task.constraints.length > 0 ? task.constraints.map(c => `- ${c}`).join('\n') : 'None specified.'}

## Validation Error
\`\`\`
${error}
\`\`\`

## Instructions

In ~500 tokens or less, provide:

1. **Root cause**: What specifically went wrong? Parse the error message and identify the exact issue.
2. **Fix approach**: Describe the approach to fix it in plain language. Be specific  -  mention exact function names, types, or patterns to use.
3. **Common pitfall**: If this is a common mistake (e.g., missing .js extension, wrong import path, incorrect type), say so explicitly.

Do NOT write code. Only explain the diagnosis and approach.`;
}

export function buildEscalationPrompt(task: Task, lastAttempt: string, error: string): string {
  return `# Escalation: Implement Fix

The implementer model failed to implement the task below after multiple attempts. You must provide the correct, complete implementation.

## Task
**ID**: ${task.id}
**Title**: ${task.title}
**Action**: ${task.action}
**File**: ${task.file}

### Description
${task.description}

${task.signature ? `### Expected Signature\n\`\`\`typescript\n${task.signature}\n\`\`\`` : ''}

${task.tests.length > 0 ? `### Tests That Must Pass\n${task.tests.map(t => `- ${t}`).join('\n')}` : ''}

### Constraints
${task.constraints.length > 0 ? task.constraints.map(c => `- ${c}`).join('\n') : 'None specified.'}

## Last Failed Attempt
\`\`\`
${lastAttempt}
\`\`\`

## Validation Error
\`\`\`
${error}
\`\`\`

## Instructions

1. Analyze the failed attempt and the error to understand what went wrong.
2. Write the correct, complete implementation for \`${task.file}\`.
3. Ensure all tests and constraints are satisfied.
4. Follow existing project conventions (ESM imports with .js extensions, pure functions, no classes).

Respond with the complete file content for \`${task.file}\`. Do not include explanations outside the code.`;
}
