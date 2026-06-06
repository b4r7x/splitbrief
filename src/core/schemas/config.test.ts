import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../config/load/io.js';
import { ConfigSchema } from './config.js';

const validConfig = createDefaultConfig();

function issuesFor(input: unknown) {
  const result = ConfigSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues;
}

function hasIssueAtPath(issues: ReturnType<typeof issuesFor>, path: string): boolean {
  return issues.some((issue) => issue.path.join('.') === path);
}

describe('ConfigSchema user config contracts', () => {
  it('validates palette custom actions users can invoke from the command palette', () => {
    const valid = ConfigSchema.safeParse({
      ...validConfig,
      palette: {
        customActions: [{ id: 'open-docs', label: 'Open docs', command: '/docs' }],
      },
    });
    expect(valid.success).toBe(true);

    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          palette: {
            customActions: [{ id: '', label: 'Open docs', command: '/docs' }],
          },
        }),
        'palette.customActions.0.id',
      ),
    ).toBe(true);

    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          palette: {
            customActions: [{ id: 'open-docs', label: 'Open docs', command: 'docs' }],
          },
        }),
        'palette.customActions.0.command',
      ),
    ).toBe(true);
  });

  it('rejects unknown approval tiers before they can change write approvals', () => {
    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          approval: { tiers: { write_out_of_scope: 'always' } },
        }),
        'approval.tiers.write_out_of_scope',
      ),
    ).toBe(true);
  });

  it('defaults workflow compaction format and rejects unknown formats', () => {
    expect(
      ConfigSchema.parse({
        ...validConfig,
        workflow: { ...validConfig.workflow, compactionFormat: undefined },
      }).workflow.compactionFormat,
    ).toBe('auto');

    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          workflow: { ...validConfig.workflow, compactionFormat: 'markdown' },
        }),
        'workflow.compactionFormat',
      ),
    ).toBe(true);
  });

  it('validates implementer profile names and default profile references', () => {
    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          implementerProfiles: {
            default: 'missing-profile',
            profiles: {
              'local-qwen': {
                kind: 'api',
                provider: 'ollama',
                apiBase: 'http://localhost:11434/v1',
                model: 'qwen2.5-coder:7b',
              },
            },
          },
        }),
        'implementerProfiles.default',
      ),
    ).toBe(true);

    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          implementerProfiles: {
            profiles: {
              'Local Qwen': {
                kind: 'api',
                provider: 'ollama',
                apiBase: 'http://localhost:11434/v1',
                model: 'qwen2.5-coder:7b',
              },
            },
          },
        }),
        'implementerProfiles.profiles.Local Qwen',
      ),
    ).toBe(true);

    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          implementerProfiles: { profiles: {} },
        }),
        'implementerProfiles.profiles',
      ),
    ).toBe(true);
  });
});
