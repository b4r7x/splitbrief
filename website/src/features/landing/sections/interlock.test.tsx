/// <reference types="@chialab/vitest-axe/matchers" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import matchers from '@chialab/vitest-axe';
import { render, screen, within } from '@testing-library/react';
import { run as axe } from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InterlockSection } from './interlock.js';

expect.extend(matchers);

afterEach(() => {
  vi.restoreAllMocks();
});

const PHASE_RAIL = 'Spec › Plan › Briefs → Build → Verify';
const CONTROL_LINES = [
  'Review gates pause on spec, plan, and briefs when active; declared file writes route through auto, sticky, or confirm tiers.',
  'Enabled checks run in order: typecheck → lint → test.',
  'Failures retry locally, then climb configured escalation tiers; exhausted paths surface recovery.',
  'Snapshot restores are hash-guarded against user edits; saved sessions resume from disk.',
] as const;

describe('InterlockSection', () => {
  it('renders the product phase rail with source-owned labels and connectors', () => {
    render(<InterlockSection />);

    const rail = screen.getByRole('list', { name: 'Workflow phase rail' });
    const railSource = readFileSync(
      resolve(process.cwd(), '../src/features/workflow/layout/chrome-rows.ts'),
      'utf8',
    );
    const labelSource = readFileSync(
      resolve(process.cwd(), '../src/core/phase-display.ts'),
      'utf8',
    );
    const glyphSource = readFileSync(resolve(process.cwd(), '../src/lib/glyphs.ts'), 'utf8');

    expect(rail.textContent).toBe(PHASE_RAIL);
    expect(within(rail).getAllByRole('listitem')).toHaveLength(5);
    expect(railSource).toContain(
      "export const RAIL_STAGES = ['spec', 'plan', 'briefs', 'build', 'verify'] as const;",
    );
    expect(labelSource).toContain('.map((word) => capitalize(word))');
    expect(glyphSource).toContain("connectorSame: '›'");
    expect(glyphSource).toContain("connectorHandoff: '→'");
  });

  it('presents the four orchestration controls as one ruled ledger', () => {
    render(<InterlockSection />);

    const section = screen.getByRole('region', { name: 'The interlock' });
    const controls = within(section).getByRole('list', { name: 'Orchestration controls' });

    expect(within(controls).getAllByRole('listitem')).toHaveLength(4);
    for (const line of CONTROL_LINES) {
      expect(within(controls).getByText(line)).toBeVisible();
    }
  });

  it('has no automated accessibility violations', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { container } = render(<InterlockSection />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
