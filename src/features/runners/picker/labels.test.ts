import { describe, expect, it } from 'vitest';
import {
  CUSTOM_COMMAND_PANE_LINES,
  fallbackInheritanceNotice,
  formatPermissionLabels,
  formatPickerStatusLabel,
  notReadyPane,
} from './labels.js';
import { formatSeatIdentity } from '../../../core/crew/identity.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import { cliReadinessRemediation } from '../../../core/readiness/cli-remediation.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool/catalog.js';
import type { PickerOptionStatus } from '../model-catalog/status.js';

describe('fallbackInheritanceNotice', () => {
  it('warns that saving an inherited REVIEW fallback gives REVIEW its own seat', () => {
    expect(fallbackInheritanceNotice({ slot: 'fallback', role: 'reviewer', inherited: true })).toBe(
      'REVIEW = PLAN · saving here gives REVIEW its own seat',
    );
  });

  it.each([
    ['seat', 'planner', false],
    ['seat', 'planner', true],
    ['seat', 'implementer', false],
    ['seat', 'implementer', true],
    ['seat', 'reviewer', false],
    ['seat', 'reviewer', true],
    ['fallback', 'planner', false],
    ['fallback', 'planner', true],
    ['fallback', 'implementer', false],
    ['fallback', 'implementer', true],
    ['fallback', 'reviewer', false],
  ] as const)('shows no notice for %s / %s / inherited %s', (slot, role, inherited) => {
    expect(fallbackInheritanceNotice({ slot, role, inherited })).toBeUndefined();
  });
});

const codexFacts = {
  tool: 'codex',
  installedVersion: CLI_TOOL_CATALOG.codex.compatibility.testedVersion,
  testedVersion: CLI_TOOL_CATALOG.codex.compatibility.testedVersion,
  compatibility: 'compatible',
} as const;

describe('notReadyPane', () => {
  const savedRunner: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5.4' };
  const cases: ReadonlyArray<{ name: string; status: PickerOptionStatus }> = [
    {
      name: 'unavailable',
      status: {
        state: 'unavailable',
        remediation: cliReadinessRemediation(
          { ...codexFacts, installedVersion: null, compatibility: 'not-checked' },
          'unavailable',
          'picker',
        ),
      },
    },
    {
      name: 'unauthenticated',
      status: {
        state: 'unauthenticated',
        remediation: cliReadinessRemediation(
          { ...codexFacts, auth: 'unauthenticated' },
          'unauthenticated',
          'picker',
        ),
      },
    },
    {
      name: 'unverified version',
      status: {
        state: 'unverified',
        remediation: cliReadinessRemediation(
          { ...codexFacts, installedVersion: null, compatibility: 'unverified' },
          'unverified',
          'picker',
        ),
      },
    },
    {
      name: 'unverified auth',
      status: {
        state: 'unverified',
        remediation: cliReadinessRemediation(
          { ...codexFacts, auth: 'unknown' },
          'unverified',
          'picker',
        ),
      },
    },
    {
      name: 'incompatible',
      status: {
        state: 'incompatible',
        remediation: cliReadinessRemediation(
          { ...codexFacts, compatibility: 'incompatible' },
          'incompatible',
          'picker',
        ),
      },
    },
    {
      name: 'untrusted',
      status: {
        state: 'untrusted',
        remediation: cliReadinessRemediation(codexFacts, 'untrusted', 'picker'),
      },
    },
    {
      name: 'disabled',
      status: {
        state: 'disabled',
        remediation: cliReadinessRemediation(codexFacts, 'disabled', 'picker'),
      },
    },
  ];

  it.each(cases)(
    '$name keeps the status title and the remedy, and promises no Enter',
    ({ status }) => {
      if (status.state === 'ready') throw new Error('a ready tool has no card');
      expect(notReadyPane({ status, savedRunner: undefined })).toEqual({
        label: formatPickerStatusLabel(status),
        lines: [status.remediation, '', 'Its models show here when it is ready.'],
      });
    },
  );

  it('names the saved choice only when the saved runner is passed', () => {
    const status = cases[0]?.status;
    if (status === undefined || status.state === 'ready') throw new Error('missing status');
    const identity = formatSeatIdentity({ seat: savedRunner });
    expect(notReadyPane({ status, savedRunner })?.lines.slice(-2)).toEqual([
      'Saved choice:',
      { whole: identity },
    ]);
    expect(JSON.stringify(notReadyPane({ status, savedRunner: undefined })?.lines)).not.toContain(
      'Saved choice:',
    );
  });

  it('returns undefined for a ready tool', () => {
    expect(
      notReadyPane({ status: { state: 'ready', remediation: null }, savedRunner }),
    ).toBeUndefined();
  });
});

describe('formatPermissionLabels', () => {
  it('lowercases every capability word', () => {
    const all = formatPermissionLabels({
      directWrite: true,
      network: true,
      shell: true,
      automaticApproval: true,
      sandbox: 'cli-managed',
    });
    expect(all.length).toBe(5);
    for (const word of all) expect(word).toBe(word.toLowerCase());
    const modeDependent = formatPermissionLabels({
      directWrite: false,
      network: false,
      shell: false,
      automaticApproval: false,
      sandbox: 'mode-dependent',
    });
    expect(modeDependent[modeDependent.length - 1]).toBe('sandbox varies');
  });

  it('leads with the sandbox posture, which a narrow byline sheds last', () => {
    expect(
      formatPermissionLabels({
        directWrite: true,
        network: true,
        shell: true,
        automaticApproval: true,
        sandbox: 'cli-managed',
      })[0],
    ).toBe('cli sandbox');
  });
});

describe('CUSTOM_COMMAND_PANE_LINES', () => {
  it('names the action, both contracts, both steps and the save rule', () => {
    const card = CUSTOM_COMMAND_PANE_LINES.join('\n');
    expect(card).toContain('Run your own command.');
    expect(card).toContain(`output${SOFT_SEP}reads stdout`);
    expect(card).toContain(`direct${SOFT_SEP}writes files`);
    expect(card).toContain('⏎ picks the contract,');
    expect(card).toContain('then the command.');
    expect(card).toContain('Nothing is saved yet.');
  });

  it('repeats neither the seat the title names nor the command the row spells', () => {
    const card = CUSTOM_COMMAND_PANE_LINES.join('\n');
    expect(card).not.toMatch(/seat/i);
    expect(card).not.toMatch(/current/i);
  });

  it('spends at most the rows the card has at its shortest supported height', () => {
    // 60x18 leaves the card 8 interior rows under its label and the blank below it.
    expect(CUSTOM_COMMAND_PANE_LINES).toHaveLength(8);
  });
});
