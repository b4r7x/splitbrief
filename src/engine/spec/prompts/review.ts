export function buildFinalReviewPrompt(spec: string, diff: string): string {
  return `# Final Implementation Review

You are reviewing a completed implementation against its specification. Your job is to verify that the implementation satisfies the spec and identify any issues.

## Specification
${spec}

## Implementation Diff
\`\`\`diff
${diff}
\`\`\`

## Instructions

Review the implementation diff against every acceptance criterion and requirement in the spec. Be thorough but fair  -  minor style differences are acceptable; missing functionality or incorrect behavior is not.

## Review Checklist

1. **Acceptance Criteria**: Check each criterion from the spec. Is it satisfied by the implementation?
2. **Functional Requirements**: Are all inputs handled? Is processing correct? Are outputs as specified?
3. **Error Handling**: Are error cases handled as specified?
4. **Edge Cases**: Are boundary conditions addressed?
5. **Type Safety**: Are types correct and complete?
6. **Code Quality**: Are there obvious bugs, security issues, or performance problems?

## Output Format

Respond with exactly this structure:

### Verdict
One of: \`pass\` | \`pass_with_notes\` | \`fail\`

### Criteria Results
For each acceptance criterion from the spec:
- **[PASS]** or **[FAIL]** Criterion description  -  brief explanation

### Findings
List any issues found, categorized as:
- **Critical**: Breaks functionality or violates a requirement (causes \`fail\` verdict)
- **Warning**: Works but has potential issues (allowed in \`pass_with_notes\`)
- **Note**: Minor observations, suggestions for improvement (informational only)

### Summary
One-paragraph overall assessment.`;
}
