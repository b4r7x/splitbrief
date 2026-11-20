import { describe, expect, it } from 'vitest';
import { deriveModelCatalogCapability } from '../model-catalog/posture.js';
import type { PickerOption } from '../model-catalog/options.js';
import { planModelRows } from '../model-catalog/row-plan.js';
import type { RightRow } from '../model-catalog/types.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { formatPickerStatusLabel } from '../../../core/readiness/cli-remediation.js';
import { rowPlansFor } from './row-plans.js';

function tool(id: string, displayName: string, status: PickerOption['status']): PickerOption {
  return {
    id,
    displayName,
    kind: 'cli',
    roles: ['planner', 'implementer'],
    modelPolicy: 'optional',
    modelCapability: deriveModelCatalogCapability('optional'),

    permissions: {
      directWrite: false,
      network: true,
      shell: false,
      automaticApproval: false,
      sandbox: 'none',
    },
    status,
    available: status.state === 'ready',
    version: '1.2.0',
  };
}

const unavailable = { state: 'unavailable', remediation: 'Install it.' } as const;
const items = [
  tool('command-code', 'Command Code CLI', unavailable),
  tool('kilo-code', 'Kilo Code CLI', unavailable),
  tool('codex', 'OpenAI Codex CLI', { state: 'ready', remediation: null }),
];
const rightRows: RightRow[] = [
  {
    kind: 'model',
    model: { id: 'openai/gpt-5.6', displayName: 'GPT-5.6' },
    provenance: 'Detected',
    section: '',
    expanded: false,
  },
  {
    kind: 'model',
    model: { id: 'openai/gpt-5.6-mini', displayName: 'GPT-5.6 Mini' },
    provenance: 'Known',
    section: '',
    expanded: false,
  },
];
const catalog = { items, rightRows, currentItem: items[2] };

describe('rowPlansFor', () => {
  it('plans the model rows once for each width the rows ask at', () => {
    const plans = rowPlansFor(catalog);
    const at31 = plans.rowPlanAt(31);
    expect(at31).toEqual(planModelRows({ rows: rightRows, width: 31, providerId: 'codex' }));
    expect(plans.rowPlanAt(31)).toBe(at31);
    const at47 = plans.rowPlanAt(47);
    expect(at47).not.toBe(at31);
    expect(at47).toEqual(planModelRows({ rows: rightRows, width: 47, providerId: 'codex' }));
  });

  it('plans again on the next render, for the rows that render has', () => {
    const first = rowPlansFor(catalog).rowPlanAt(31);
    const fewer = rowPlansFor({ ...catalog, rightRows: rightRows.slice(0, 1) }).rowPlanAt(31);
    expect(fewer).not.toBe(first);
    expect(fewer.rows.size).toBe(1);
    expect(first.rows.size).toBe(2);
  });

  it('names the rows for the tool on the cursor', () => {
    const claude = tool('claude-code', 'Claude Code', { state: 'ready', remediation: null });
    const legacy: RightRow[] = [
      {
        kind: 'model',
        model: { id: 'default' },
        provenance: 'Known',
        section: '',
        expanded: false,
      },
    ];
    const plan = rowPlansFor({ items, rightRows: legacy, currentItem: claude }).rowPlanAt(31);
    expect(plan).toEqual(planModelRows({ rows: legacy, width: 31, providerId: 'claude-code' }));
    expect(plan).not.toEqual(planModelRows({ rows: legacy, width: 31, providerId: undefined }));
  });

  // 20 cells is the tool column's row at a 60x18 terminal, 32 at 80x24.
  it('fits the status words of every tool or of none, at each width it is asked', () => {
    const plans = rowPlansFor(catalog);
    expect(plans.statusesFitAt(20)).toBe(false);
    expect(plans.statusesFitAt(32)).toBe(true);
    expect(plans.statusesFitAt(20)).toBe(false);
    expect(rowPlansFor({ ...catalog, items: items.slice(2) }).statusesFitAt(20)).toBe(true);
  });

  it('fits a status beside the first word of its tool, not only beside its whole name', () => {
    const [longest] = items;
    if (longest === undefined) throw new Error('Expected a tool');
    const status = formatPickerStatusLabel(longest.status) ?? '';
    // One cell short of the whole name, its status and the four cells of row chrome.
    const width = getTerminalCellWidth(`${longest.displayName} ${status}`) + 4 - 1;
    expect(rowPlansFor(catalog).statusesFitAt(width)).toBe(true);
  });
});
