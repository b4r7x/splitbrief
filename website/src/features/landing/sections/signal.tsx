import { BorderedFrame } from '../../../components/bordered-frame.js';
import { PanelStrip } from '../../../components/panel-strip.js';
import './signal.css';

const TASK_BRIEF_SECTIONS = [
  'Identity',
  'Intent',
  'Scope',
  'Code Context',
  'Implementation Plan',
  'Validation',
  'Constraints',
  'Escalation',
  'Evidence',
] as const;

const TASK_BRIEF_TRANSPORT = `---
id: T003
title: Add email validation to SignupForm
action: modify
file: src/features/auth/signup-form.tsx
depends_on: []
---

### Description
Validate the email field in src/features/auth/signup-form.tsx before submission so malformed values are rejected inline.

### Implementation Steps
1. Add a local validateEmail helper that trims the value and returns an error for a missing or repeated @ sign.
2. Call validateEmail from the form submit handler before the existing submission branch.
3. Render the returned message beside the email field and preserve the current successful-submit behavior.

### Tests
- Submitting a whitespace-padded valid address continues to the existing successful-submit branch.
- Submitting personexample.com renders Enter a valid email address and does not submit.
- Submitting person@@example.com renders Enter a valid email address and does not submit.

### Constraints
- Do not add a dependency.
- Preserve the existing successful-submit behavior and form accessibility.

### Signature
\`\`\`
function validateEmail(value: string): string | null
\`\`\`

### Current Code
\`\`\`
function handleSubmit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  onSubmit({ email });
}
\`\`\`

### Type Definitions
\`\`\`
type SignupFormProps = { onSubmit: (input: { email: string }) => void };
\`\`\`

### Scope
**In bounds:**
- Email normalization, validation, and inline error rendering in the target component.

**Out of bounds:**
- Shared validation utilities and server-side validation.

### Escalation
- Stop if product requirements differ on accepted email syntax or the component has no established inline-error pattern.

### Evidence
- Focused form tests show whitespace normalization, single-@ validation, and submission blocking.
- Typecheck and the existing auth form tests pass.`;

export function SignalSection() {
  return (
    <PanelStrip className="signal-section" id="signal" legend="The signal">
      <div className="signal-section__layout">
        <BorderedFrame className="signal-section__frame" label="tasks.md transport">
          <section
            aria-label="Task Brief transport contents"
            className="signal-section__transport-scroll"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: axe and Safari require a keyboard-focusable scroll region.
            tabIndex={0}
          >
            <pre className="signal-section__transport">
              <code>{TASK_BRIEF_TRANSPORT}</code>
            </pre>
          </section>
        </BorderedFrame>

        <div className="signal-section__contract">
          <p className="signal-section__eyebrow">Contract legend / 09 sections</p>
          <p className="signal-section__statement">
            <strong>The Task Brief is a nine-section contract on disk.</strong> The planner writes
            it. You approve it. The implementer executes exactly it.
          </p>
          <ol aria-label="Task Brief semantic sections" className="signal-section__legend">
            {TASK_BRIEF_SECTIONS.map((section, index) => (
              <li key={section}>
                <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <span>{section}</span>
              </li>
            ))}
          </ol>
          <p className="signal-section__drift">The final diff is checked back against the brief.</p>
        </div>
      </div>
    </PanelStrip>
  );
}
