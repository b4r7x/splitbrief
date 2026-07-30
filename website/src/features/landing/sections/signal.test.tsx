import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SignalSection } from './signal.js';

const SEMANTIC_SECTIONS = [
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

function canonicalTaskBrief(): string {
  const taskContract = readFileSync(resolve(process.cwd(), '../docs/TASK-CONTRACT.md'), 'utf8');
  const match = taskContract.match(/````markdown\n(?<brief>---\nid: T003[\s\S]*?)\n````/);
  const brief = match?.groups?.brief;
  if (!brief) {
    throw new Error('Canonical T003 tasks.md example is missing from docs/TASK-CONTRACT.md');
  }
  return brief;
}

describe('SignalSection', () => {
  it('shows the canonical Task Brief transport and its nine semantic sections', () => {
    render(<SignalSection />);

    const section = screen.getByRole('region', { name: 'The signal' });
    const frame = within(section).getByRole('figure', { name: 'tasks.md transport' });
    const transportScroll = within(frame).getByRole('region', {
      name: 'Task Brief transport contents',
    });
    const transport = within(frame).getByText(
      (_, element) =>
        element?.tagName === 'CODE' && element.textContent?.startsWith('---\nid: T003') === true,
    );
    const legend = within(section).getByRole('list', {
      name: 'Task Brief semantic sections',
    });

    expect(transport.textContent).toBe(canonicalTaskBrief());
    expect(transportScroll).toHaveAttribute('tabindex', '0');
    expect(transportScroll).toContainElement(transport);
    expect(within(legend).getAllByRole('listitem')).toHaveLength(9);
    for (const semanticSection of SEMANTIC_SECTIONS) {
      expect(within(legend).getByText(semanticSection)).toBeVisible();
    }
    expect(
      within(section).getByText('The final diff is checked back against the brief.'),
    ).toBeVisible();
  });
});
