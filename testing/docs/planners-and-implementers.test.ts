import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLI_READINESS_STATES } from '../../src/core/discovery/detection.js';
import {
  ANTIGRAVITY_CLI_ADMISSION_VERDICT,
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  CLI_TOOL_TRUST,
  CURSOR_CLI_ADMISSION_VERDICT,
  EXCLUDED_CLI_TOOL_IDS,
  type CliToolId,
} from '../../src/core/runners/cli-tool-catalog.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DOC_PATH = join(REPO_ROOT, 'docs/PLANNERS-AND-IMPLEMENTERS.md');
const DOC = readFileSync(DOC_PATH, 'utf8');

const ADMITTED_SUPPORT_HEADING = '##### Admitted support summary';
const POSTURE_HEADING = '##### Posture, trust, and auth';
const OMIT_HEADING = '##### Blocked admission candidates (OMIT)';
const EXCLUDED_HEADING = '##### Excluded researched candidates';

function sectionBetween(startHeading: string, endHeading: string | null): string {
  const start = DOC.indexOf(startHeading);
  expect(start, `missing section ${startHeading}`).toBeGreaterThanOrEqual(0);
  const bodyStart = start + startHeading.length;
  const end = endHeading === null ? DOC.length : DOC.indexOf(endHeading, bodyStart);
  expect(end, `missing end heading after ${startHeading}`).toBeGreaterThan(bodyStart);
  return DOC.slice(bodyStart, end);
}

function admittedSupportSection(): string {
  return sectionBetween(ADMITTED_SUPPORT_HEADING, POSTURE_HEADING);
}

function postureSection(): string {
  return sectionBetween(POSTURE_HEADING, '##### Readiness states');
}

function omitSection(): string {
  return sectionBetween(OMIT_HEADING, EXCLUDED_HEADING);
}

function excludedSection(): string {
  return sectionBetween(EXCLUDED_HEADING, '### api');
}

function formatRoles(roles: readonly ('planner' | 'implementer')[]): string {
  return roles.join(', ');
}

function formatModelPolicy(id: CliToolId): string {
  const policy = CLI_TOOL_CATALOG[id].modelPolicy;
  return `${policy.planner} / ${policy.implementer}`;
}

function formatDirectWrite(id: CliToolId): string {
  const write = CLI_TOOL_CATALOG[id].directWrite;
  return `${write.planner ? 'yes' : 'no'} / ${write.implementer ? 'yes' : 'no'}`;
}

function formatSandbox(id: CliToolId): string {
  const sandbox = CLI_TOOL_CATALOG[id].sandbox;
  return `${sandbox.planner} / ${sandbox.implementer}`;
}

function implementerAutoApproval(id: CliToolId): string {
  const flags = CLI_TOOL_TRUST[id].implementer.autoAllowFlags;
  return flags.length === 0 ? '—' : flags.join(', ');
}

function credentialEnv(id: CliToolId): string {
  const channels = CLI_TOOL_CATALOG[id].auth.channels;
  const env = [
    ...new Set(channels.flatMap((channel) => (channel.id === 'api-key' ? channel.env : []))),
  ];
  if (env.length === 0) {
    const providerDependent = channels.some((channel) => channel.id === 'provider-dependent');
    return providerDependent ? 'inherited from provider config' : '—';
  }
  return env.map((name) => `\`${name}\``).join(', ');
}

function authChannelLabels(id: CliToolId): string {
  return CLI_TOOL_CATALOG[id].auth.channels.map((channel) => channel.id).join(', ');
}

describe('canonical CLI runner matrix docs', () => {
  it('anchors the matrix to the runtime catalog module', () => {
    expect(DOC).toContain('src/core/runners/cli-tool-catalog.ts');
    expect(DOC).toContain('testing/docs/planners-and-implementers.test.ts');
    expect(DOC).toContain('#### Canonical CLI runner matrix');
  });

  it('keeps admitted support rows aligned with runtime IDs, versions, and postures', () => {
    const support = admittedSupportSection();

    for (const id of CLI_TOOL_IDS) {
      const descriptor = CLI_TOOL_CATALOG[id];
      const row = new RegExp(`\\| \`${id}\` \\|`, 'm');

      expect(support, `missing admitted support row for ${id}`).toMatch(row);
      expect(support).toContain(`| \`${descriptor.command}\` |`);
      expect(support).toContain(formatRoles(descriptor.roles));
      expect(support).toContain(descriptor.compatibility.testedVersion);
      expect(support).toContain(descriptor.compatibility.evidence.asOf);
      expect(support).toContain(formatModelPolicy(id));
      expect(support).toContain(descriptor.billing);
    }

    expect(support.match(/^\| `tool` \|/m)).not.toBeNull();
    const admittedRows = [...support.matchAll(/^\| `([^`]+)` \|/gm)]
      .map((match) => match[1])
      .filter((id) => id !== 'tool');
    expect(admittedRows).toEqual([...CLI_TOOL_IDS]);
  });

  it('keeps posture and trust rows aligned with runtime catalog postures', () => {
    const posture = postureSection();

    for (const id of CLI_TOOL_IDS) {
      const descriptor = CLI_TOOL_CATALOG[id];
      const row = new RegExp(`\\| \`${id}\` \\|`, 'm');

      expect(posture, `missing posture row for ${id}`).toMatch(row);
      expect(posture).toContain(formatDirectWrite(id));
      expect(posture).toContain(formatSandbox(id));
      expect(posture).toContain(implementerAutoApproval(id));
      expect(posture).toContain(authChannelLabels(id));
      expect(posture).toContain(credentialEnv(id));
      expect(posture).toContain(
        `${descriptor.shell.planner ? 'yes' : 'no'} / ${descriptor.shell.implementer ? 'yes' : 'no'}`,
      );
      expect(posture).toContain(
        `${descriptor.network.planner ? 'yes' : 'no'} / ${descriptor.network.implementer ? 'yes' : 'no'}`,
      );
    }
  });

  it('documents Command Code without a credential environment variable', () => {
    const posture = postureSection();
    const row = posture.split('\n').find((line) => line.startsWith('| `command-code` |'));

    expect(row, 'missing posture row for command-code').toBeDefined();
    expect(row?.trimEnd().endsWith('| — |')).toBe(true);
    expect(DOC).not.toMatch(/COMMAND.?CODE.*_API_KEY/i);
  });

  it('documents every CLI readiness state and check ID pattern', () => {
    const readiness = sectionBetween('##### Readiness states', '##### Minimal configuration');

    for (const state of CLI_READINESS_STATES) {
      expect(readiness).toContain(`\`${state}\``);
    }
    expect(readiness).toContain('runners.cli.<tool>.readiness');
    expect(readiness).toContain('deriveCliReadiness()');
  });

  it('records Cursor as admitted and Antigravity as a blocked OMIT candidate', () => {
    expect(CURSOR_CLI_ADMISSION_VERDICT).toBe('PASS');
    expect(ANTIGRAVITY_CLI_ADMISSION_VERDICT).toBe('OMIT');

    const support = admittedSupportSection();
    const omit = omitSection();

    expect(support).toMatch(/\| `cursor` \|/);
    expect(omit).not.toContain('| `cursor` |');
    expect(omit).toContain('| `antigravity` |');
    expect(omit).toContain('OMIT');
    expect(omit).toContain('2026-07-31');
    expect(omit).toContain('Candidate runtime adapter sources must remain absent');

    expect(omit).toContain('.nuke/release-evidence/antigravity.json');
    expect(omit).toContain('conditional consumer route replacing legacy Gemini CLI');
    expect(DOC).toContain('ANTIGRAVITY_CLI_ADMISSION_VERDICT');
    expect(DOC).toContain('CURSOR_CLI_ADMISSION_VERDICT');
  });

  it('records excluded candidate verdict wording without support rows', () => {
    const support = admittedSupportSection();
    const excluded = excludedSection();

    for (const id of EXCLUDED_CLI_TOOL_IDS.filter((id) => id !== 'antigravity')) {
      expect(support).not.toMatch(new RegExp(`\\| \`${id}\` \\|`));
      expect(excluded).toContain(`| \`${id}\` |`);
    }

    expect(excluded).toContain('written Kiro/AWS permission');
    expect(excluded).toContain('credentialed stable-2.x staged fixture');
    expect(excluded).toContain('2026-06-18');
    expect(excluded).toContain('conditional Antigravity route');
    expect(excluded).toContain('separate Gemini API provider path');
    expect(excluded).toContain('| `auggie` | DEFER |');
    expect(excluded).toContain('| `junie` | DEFER |');
    expect(excluded).toContain('| `qwen` | REJECT |');
    expect(excluded).toContain('| `cline` | FUTURE |');
    expect(excluded).toContain('generic/BYOK');
  });
});
