import { beforeEach, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { cursorModelOptions } from '#testing/helpers/factories/cursor-models.js';
import { mergeOptionFamilies } from './model-catalog/option-merge.js';
import type { PickerOption } from './model-catalog/options.js';
import { deriveModelCatalogCapability } from './model-catalog/posture.js';
import type { ModelOption } from './model-catalog/recency.js';
import { glyph } from '../../lib/glyphs.js';
import { getTheme } from '../../components/theme.js';
import { ELLIPSIS } from '../../utils/display-text.js';
import type { ProvenanceWord } from '../../core/providers/provenance.js';
import {
  AUTO_ROW_METADATA,
  BROWSE_CATALOG_TEXT,
  type RightAxisName,
  type RightRow,
  type RouteAuthState,
  type TreeLead,
} from './model-catalog/rows.js';
import { renderModelRow, renderToolRow } from './tool-row.js';

const AUTH = { hasOracle: false, providerAuth: undefined };

function modelRow(
  model: ModelOption,
  provenance: ProvenanceWord,
  section = '',
): Extract<RightRow, { kind: 'model' }> {
  return { kind: 'model', model, provenance, section, expanded: false };
}

function axisRow(
  model: ModelOption,
  axis: RightAxisName,
  value: string,
  last = false,
  steps = true,
  tree: TreeLead = { depth: 1, parentContinues: false },
): RightRow {
  return { kind: 'axis', model, axis, providerPrefix: '', value, choices: [], steps, last, tree };
}

function routeRow(
  auth: RouteAuthState,
  tree: TreeLead = { depth: 1, parentContinues: false },
): RightRow {
  return {
    kind: 'route',
    model: { id: 'openai/gpt-5.6' },
    variant: { fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai' },
    last: true,
    auth,
    tree,
  };
}

function pickerItem(
  item: Omit<PickerOption, 'modelCapability'> & { modelPolicy: PickerOption['modelPolicy'] },
): PickerOption {
  return {
    ...item,
    modelCapability: deriveModelCatalogCapability(item.modelPolicy),
  };
}

async function rowFrame(row: RightRow, maxWidth: number, currentModel?: string): Promise<string> {
  const ui = renderFeature(
    renderModelRow({
      row,
      isCursor: false,
      maxWidth,
      currentModel,
      sectioned: false,
      auth: AUTH,
    }),
  );
  await tick(20);
  const frame = ui.lastFrame() ?? '';
  ui.unmount();
  return frame;
}

async function rowLine(row: RightRow, maxWidth: number, currentModel?: string): Promise<string> {
  return stripAnsiStyles(await rowFrame(row, maxWidth, currentModel)).split('\n')[0] ?? '';
}

const readyPermissions = {
  directWrite: false,
  network: true,
  shell: false,
  automaticApproval: false,
  sandbox: 'none' as const,
};

describe('runner row grammar', () => {
  it('renders dim status suffixes without parens badges', async () => {
    const unavailable = pickerItem({
      id: 'deepseek',
      displayName: 'DeepSeek',
      kind: 'api',
      roles: ['implementer'],
      modelPolicy: 'per-call',
      billing: 'api-metered',
      permissions: readyPermissions,
      status: { state: 'unavailable', remediation: 'Start DeepSeek and refresh detection.' },
      available: false,
    });
    const ui = renderFeature(
      renderToolRow({
        item: unavailable,
        isCursor: false,
        isSelected: false,
        isContext: false,
        maxWidth: 40,
        currentCommand: undefined,
        currentCommandKind: undefined,
      }),
    );
    await tick(20);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Unavailable');
    expect(frame).not.toContain('(Unavailable)');
    ui.unmount();
  });

  it('shows stable unavailable, auth, and mismatch semantics from status', async () => {
    const cases: Array<{ status: PickerOption['status']; label: string }> = [
      {
        status: { state: 'unauthenticated', remediation: 'Set API key.' },
        label: 'Auth required',
      },
      {
        status: { state: 'incompatible', remediation: 'Install tested version.' },
        label: 'Incompatible',
      },
      {
        status: { state: 'untrusted', remediation: 'Trust executable.' },
        label: 'Untrusted',
      },
    ];

    for (const { status, label } of cases) {
      const item = pickerItem({
        id: 'codex',
        displayName: 'Codex',
        kind: 'cli',
        roles: ['planner', 'implementer'],
        modelPolicy: 'optional',
        billing: 'subscription-included',
        permissions: { ...readyPermissions, directWrite: true, automaticApproval: true },
        status,
        available: false,
      });
      const ui = renderFeature(
        renderToolRow({
          item,
          isCursor: false,
          isSelected: false,
          isContext: false,
          maxWidth: 60,
          currentCommand: undefined,
          currentCommandKind: undefined,
        }),
      );
      await tick(20);
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Codex');
      expect(frame).toContain(label);
      ui.unmount();
    }
  });

  it('keeps the current marker visible when the configured runner is not ready', async () => {
    const brokenCurrent = pickerItem({
      id: 'claude-code',
      displayName: 'Claude Code',
      kind: 'cli',
      roles: ['planner', 'implementer'],
      modelPolicy: 'optional',
      billing: 'subscription-included',
      permissions: readyPermissions,
      status: { state: 'incompatible', remediation: 'Install tested version.' },
      available: false,
      isCurrent: true,
    });
    const ui = renderFeature(
      renderToolRow({
        item: brokenCurrent,
        isCursor: false,
        isSelected: false,
        isContext: false,
        maxWidth: 50,
        currentCommand: undefined,
        currentCommandKind: undefined,
      }),
    );
    await tick(20);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(glyph('check'));
    expect(frame).toContain('Incompatible');
    ui.unmount();
  });

  it('renders a versioned tool with a bare dim version, no v-prefix or parens', async () => {
    const tool = pickerItem({
      id: 'claude-code',
      displayName: 'Claude Code',
      kind: 'cli',
      roles: ['planner', 'implementer'],
      modelPolicy: 'optional',
      billing: 'subscription-included',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
      version: '1.2.3',
    });
    const ui = renderFeature(
      renderToolRow({
        item: tool,
        isCursor: false,
        isSelected: false,
        isContext: false,
        maxWidth: 40,
        currentCommand: undefined,
        currentCommandKind: undefined,
      }),
    );
    await tick(20);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('1.2.3');
    expect(frame).not.toContain('(1.2.3)');
    expect(frame).not.toContain('v1.2.3');
    ui.unmount();
  });

  it('paints a status word with a warning metadata colour and leaves a version dim', () => {
    const unavailable = pickerItem({
      id: 'deepseek',
      displayName: 'DeepSeek',
      kind: 'api',
      roles: ['implementer'],
      modelPolicy: 'per-call',
      billing: 'api-metered',
      permissions: readyPermissions,
      status: { state: 'unavailable', remediation: 'Start DeepSeek and refresh detection.' },
      available: false,
    });
    const ready = pickerItem({
      id: 'claude-code',
      displayName: 'Claude Code',
      kind: 'cli',
      roles: ['planner', 'implementer'],
      modelPolicy: 'optional',
      billing: 'subscription-included',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
      version: '1.2.3',
    });
    const rowArgs = {
      isCursor: false,
      isSelected: false,
      isContext: false,
      maxWidth: 40,
      currentCommand: undefined,
      currentCommandKind: undefined,
    } as const;
    const unavailableColor = renderToolRow({ item: unavailable, ...rowArgs }).props.metadataColor;
    const readyColor = renderToolRow({ item: ready, ...rowArgs }).props.metadataColor;
    expect(unavailableColor).toBe(getTheme().warning);
    expect(readyColor).not.toBe(unavailableColor);
  });

  it('renders custom/default model provenance without parens badges', async () => {
    const customUi = renderFeature(
      renderModelRow({
        row: modelRow({ id: 'my-org/custom', isCustom: true }, 'Custom'),
        isCursor: false,
        maxWidth: 40,
        currentModel: undefined,
        sectioned: false,
        auth: AUTH,
      }),
    );
    await tick(20);
    const customFrame = customUi.lastFrame() ?? '';
    expect(customFrame).toContain('Custom');
    expect(customFrame).not.toContain('(Custom)');
    customUi.unmount();

    const defaultUi = renderFeature(
      renderModelRow({
        row: modelRow({ id: 'gpt-5.4' }, 'Known'),
        isCursor: false,
        maxWidth: 40,
        currentModel: undefined,
        sectioned: false,
        auth: AUTH,
      }),
    );
    await tick(20);
    const defaultFrame = defaultUi.lastFrame() ?? '';
    expect(defaultFrame).toContain('GPT-5.4');
    expect(defaultFrame).not.toContain('Known');
    expect(defaultFrame).not.toContain('Catalog');
    expect(defaultFrame).not.toContain('Detected');
    defaultUi.unmount();
  });

  it('marks a stale retained model without calling it detected', async () => {
    const ui = renderFeature(
      renderModelRow({
        row: modelRow({ id: 'retained-model', membership: 'stale', isStale: true }, 'Stale'),
        isCursor: false,
        maxWidth: 60,
        currentModel: undefined,
        sectioned: false,
        auth: AUTH,
      }),
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Stale');
    expect(frame).not.toContain('Detected');
    expect(frame).not.toContain('Confirmed');
    ui.unmount();
  });

  it('shows a floored context window on a model row', async () => {
    const million = renderFeature(
      renderModelRow({
        row: modelRow({ id: 'gpt-5.6', contextLength: 1_048_576 }, 'Detected'),
        isCursor: false,
        maxWidth: 60,
        currentModel: undefined,
        sectioned: false,
        auth: AUTH,
      }),
    );
    await tick(20);
    const millionFrame = million.lastFrame() ?? '';
    expect(millionFrame).toContain('1M');
    expect(millionFrame).not.toContain('1.0M');
    million.unmount();

    const thousands = renderFeature(
      renderModelRow({
        row: modelRow({ id: 'gpt-5.6-mini', contextLength: 262_144 }, 'Detected'),
        isCursor: false,
        maxWidth: 60,
        currentModel: undefined,
        sectioned: false,
        auth: AUTH,
      }),
    );
    await tick(20);
    expect(thousands.lastFrame() ?? '').toContain('262K');
    thousands.unmount();
  });

  it('renders the browse-catalog escape as an affordance, not a failure', async () => {
    forceUnicodeGlyphs();
    const ui = renderFeature(
      renderModelRow({
        row: { kind: 'action', action: 'browse-catalog', text: BROWSE_CATALOG_TEXT },
        isCursor: false,
        maxWidth: 60,
        currentModel: undefined,
        sectioned: false,
        auth: AUTH,
      }),
    );
    await tick(20);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain(BROWSE_CATALOG_TEXT);
    expect(frame).not.toContain(glyph('disclosureClosed'));
    expect(frame).not.toContain(glyph('statusFailed'));
    ui.unmount();
  });

  it('renders tool decides on the Auto row, not Default, inside a section and outside one', async () => {
    for (const sectioned of [true, false]) {
      const ui = renderFeature(
        renderModelRow({
          row: modelRow({ id: 'auto' }, 'Known'),
          isCursor: false,
          maxWidth: 40,
          currentModel: 'auto',
          sectioned,
          auth: AUTH,
        }),
      );
      await tick(20);
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Auto');
      expect(frame).toContain(AUTO_ROW_METADATA);
      expect(frame).not.toContain('Default');
      ui.unmount();
    }
  });

  it('puts a detail string in the metadata cell, not the label', async () => {
    const row = modelRow({ id: 'opus', displayName: 'Opus 5', detail: 'opus · 1M' }, 'Known');
    const el = renderModelRow({
      row,
      isCursor: false,
      maxWidth: 60,
      currentModel: undefined,
      sectioned: false,
      auth: AUTH,
    });
    expect(el.props.label).toBe('Opus 5');
    expect(el.props.metadata).toBe('opus · 1M');
    expect(el.props.label).not.toContain('opus · 1M');
    const line = await rowLine(row, 60);
    expect(line).toContain('Opus 5');
    expect(line).toContain('opus · 1M');
  });

  it('places the vendor tag left of the context size in the metadata cell', async () => {
    const row = modelRow(
      {
        id: 'claude-fable-5.1',
        displayName: 'Claude Fable 5.1',
        vendorTag: 'no ZDR',
        contextLength: 1_000_000,
      },
      'Known',
    );
    const el = renderModelRow({
      row,
      isCursor: false,
      maxWidth: 80,
      currentModel: undefined,
      sectioned: false,
      auth: AUTH,
    });
    expect(el.props.label).toBe('Claude Fable 5.1');
    expect(el.props.label).not.toContain('no ZDR');
    expect(el.props.label).not.toContain('1M');
    const metadata = el.props.metadata ?? '';
    expect(metadata).toContain('no ZDR');
    expect(metadata).toContain('1M');
    expect(metadata.indexOf('no ZDR')).toBeLessThan(metadata.indexOf('1M'));
    const line = await rowLine(row, 80);
    expect(line).toContain('no ZDR');
    expect(line).toContain('1M');
  });

  it('falls back to the formatted context length, and leaves metadata empty when neither is present', () => {
    const withSize = renderModelRow({
      row: modelRow({ id: 'gpt-5.6', displayName: 'GPT-5.6', contextLength: 1_000_000 }, 'Known'),
      isCursor: false,
      maxWidth: 40,
      currentModel: undefined,
      sectioned: false,
      auth: AUTH,
    });
    expect(withSize.props.metadata).toBe('1M');
    expect(withSize.props.label).not.toContain('1M');

    const empty = renderModelRow({
      row: modelRow({ id: 'plain', displayName: 'Plain' }, 'Known'),
      isCursor: false,
      maxWidth: 40,
      currentModel: undefined,
      sectioned: false,
      auth: AUTH,
    });
    expect(empty.props.metadata).toBeUndefined();
    expect(empty.props.label).toBe('Plain');
  });

  it('drops the provenance word when the section header already carries it', async () => {
    const ui = renderFeature(
      renderModelRow({
        row: modelRow({ id: 'opus' }, 'Known', 'Fallback'),
        isCursor: false,
        maxWidth: 40,
        currentModel: undefined,
        sectioned: true,
        auth: AUTH,
      }),
    );
    await tick(20);
    expect(ui.lastFrame() ?? '').not.toContain('Known');
    ui.unmount();
  });

  it('renders a route row with its tag', async () => {
    forceUnicodeGlyphs();
    const line = await rowLine(routeRow({ kind: 'configured', source: 'oauth' }), 40);
    expect(line).toContain('openai');
    expect(line).toContain('signed in');
    expect(line).not.toContain(glyph('stageDone'));
    expect(line).not.toContain(glyph('stagePending'));
    expect(line).not.toContain(glyph('statusWarning'));
    expect(line.includes(glyph('treeBranch')) || line.includes(glyph('treeLast'))).toBe(true);
  });

  it('renders an unchecked route as the tag alone', async () => {
    forceUnicodeGlyphs();
    const line = await rowLine(routeRow({ kind: 'unchecked' }), 40);
    expect(line).toContain('openai');
    expect(line).not.toContain('signed in');
  });

  it('renders one add-custom-command launcher instead of per-kind add rows', async () => {
    const launcher = pickerItem({
      id: 'custom-command',
      displayName: 'Custom command',
      kind: 'custom-command',
      roles: ['planner', 'implementer'],
      modelPolicy: 'none',
      billing: 'unknown',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
    });
    const ui = renderFeature(
      renderToolRow({
        item: launcher,
        isCursor: false,
        isSelected: false,
        isContext: false,
        maxWidth: 40,
        currentCommand: undefined,
        currentCommandKind: undefined,
      }),
    );
    await tick();

    expect(ui.lastFrame()).toContain('+ Add custom command…');
    expect(ui.lastFrame()).not.toContain('Add shell command');
    expect(ui.lastFrame()).not.toContain('Add agent command');
    ui.unmount();
  });

  it('renders the custom-command launcher without a dot lead, and a tool row with one', async () => {
    const launcher = pickerItem({
      id: 'custom-command',
      displayName: 'Custom command',
      kind: 'custom-command',
      roles: ['planner', 'implementer'],
      modelPolicy: 'none',
      billing: 'unknown',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
    });
    const tool = pickerItem({
      id: 'claude-code',
      displayName: 'Claude Code',
      kind: 'cli',
      roles: ['planner', 'implementer'],
      modelPolicy: 'optional',
      billing: 'subscription-included',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
    });
    const rowArgs = {
      isCursor: false,
      isSelected: false,
      isContext: false,
      maxWidth: 40,
      currentCommand: undefined,
      currentCommandKind: undefined,
    } as const;
    expect(renderToolRow({ item: launcher, ...rowArgs }).props.defaultLead).toBe('blank');
    expect(renderToolRow({ item: tool, ...rowArgs }).props.defaultLead).toBe('dot');
    expect(
      renderToolRow({
        item: launcher,
        ...rowArgs,
        currentCommand: 'my-tool --json',
        currentCommandKind: 'shell',
      }).props.defaultLead,
    ).toBe('dot');

    const launcherUi = renderFeature(renderToolRow({ item: launcher, ...rowArgs }));
    await tick(20);
    expect(stripAnsiStyles(launcherUi.lastFrame() ?? '')).not.toContain('·');
    launcherUi.unmount();

    const toolUi = renderFeature(renderToolRow({ item: tool, ...rowArgs }));
    await tick(20);
    expect(stripAnsiStyles(toolUi.lastFrame() ?? '')).toContain('·');
    toolUi.unmount();
  });

  describe('merged provider rows', () => {
    beforeEach(() => {
      forceUnicodeGlyphs();
    });

    const MERGED: ModelOption = {
      id: 'github-copilot/gpt-5.6',
      contextLength: 128_000,
      variants: [
        { fullId: 'github-copilot/gpt-5.6', providerPrefix: 'github-copilot', tag: 'copilot' },
        { fullId: 'kilo/openrouter/gpt-5.6', providerPrefix: 'kilo/openrouter', tag: 'openrouter' },
      ],
    };

    it('signposts a multi-provider row with a provider count, no tags or glyphs', async () => {
      const ui = renderFeature(
        renderModelRow({
          row: modelRow(MERGED, 'Detected'),
          isCursor: false,
          maxWidth: 60,
          currentModel: undefined,
          sectioned: false,
          auth: AUTH,
        }),
      );
      await tick(20);
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('GPT-5.6');
      expect(frame).toContain('2 providers');
      expect(frame).not.toContain('copilot');
      expect(frame).not.toContain('●');
      expect(frame).not.toContain('○');
      ui.unmount();
    });

    it('signposts a multi-option family with its option count, not an axis value', async () => {
      const luna: ModelOption = {
        id: 'gpt-5.6-luna-high-fast',
        displayName: 'GPT-5.6 Luna',
        variants: [
          { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
          { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
          { fullId: 'gpt-5.6-luna-max-fast', providerPrefix: '', tag: 'Max Fast' },
        ],
      };
      const ui = renderFeature(
        renderModelRow({
          row: modelRow(luna, 'Detected'),
          isCursor: false,
          maxWidth: 60,
          currentModel: 'gpt-5.6-luna-high-fast',
          sectioned: false,
          auth: AUTH,
        }),
      );
      await tick(20);
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('GPT-5.6 Luna');
      expect(frame).toContain('3 options');
      expect(frame).not.toMatch(/\bhigh\b/);
      expect(frame).not.toMatch(/\bon\b/);
      expect(frame).not.toContain('providers');
      expect(frame).not.toContain('Detected');
      ui.unmount();
    });

    it('keeps the count on an expanded family, so the chip is not an expansion-state signal', async () => {
      const luna: ModelOption = {
        id: 'gpt-5.6-luna-high',
        displayName: 'GPT-5.6 Luna',
        variants: [
          { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
          { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
        ],
      };
      const count = /2 options/;
      const expanded = renderFeature(
        renderModelRow({
          row: { ...modelRow(luna, 'Detected'), expanded: true },
          isCursor: false,
          maxWidth: 60,
          currentModel: 'gpt-5.6-luna-high',
          sectioned: false,
          auth: AUTH,
        }),
      );
      await tick(20);
      const expandedFrame = expanded.lastFrame() ?? '';
      expect(expandedFrame).toContain('GPT-5.6 Luna');
      expect(expandedFrame).toMatch(count);
      expect(expandedFrame).toContain(glyph('disclosureOpen'));
      expanded.unmount();

      const collapsed = renderFeature(
        renderModelRow({
          row: modelRow(luna, 'Detected'),
          isCursor: false,
          maxWidth: 60,
          currentModel: 'gpt-5.6-luna-high',
          sectioned: false,
          auth: AUTH,
        }),
      );
      await tick(20);
      const collapsedFrame = collapsed.lastFrame() ?? '';
      expect(collapsedFrame).toMatch(count);
      expect(collapsedFrame).toContain(glyph('disclosureClosed'));
      collapsed.unmount();
    });

    it('keeps the model name whole by shrinking the count, never the reverse', async () => {
      const opus: ModelOption = {
        id: 'claude-opus-5-low',
        displayName: 'Claude Opus 5',
        contextLength: 1_000_000,
        variants: [
          { fullId: 'claude-opus-5-low', providerPrefix: '', tag: 'Low' },
          { fullId: 'claude-opus-5-low-fast', providerPrefix: '', tag: 'Low Fast' },
          { fullId: 'claude-opus-5-thinking-high', providerPrefix: '', tag: 'Thinking' },
          { fullId: 'claude-opus-5-thinking-high-fast', providerPrefix: '', tag: 'Thinking Fast' },
        ],
      };
      const frameAt = (maxWidth: number): Promise<string> =>
        rowFrame(modelRow(opus, 'Detected'), maxWidth, 'claude-opus-5-low');

      const wide = await frameAt(60);
      expect(wide).toContain('Claude Opus 5');
      expect(wide).toContain('4 options');
      expect(wide).toContain('1M');

      const narrow = await frameAt(30);
      expect(narrow).toContain('Claude Opus 5');
      expect(narrow).not.toContain('4 options');
    });

    it('keeps Stale in the tail while the count pays first', async () => {
      const grok: ModelOption = {
        id: 'cursor-grok-4.6-low',
        displayName: 'Cursor Grok 4.6',
        contextLength: 272_000,
        variants: [
          { fullId: 'cursor-grok-4.6-low', providerPrefix: '', tag: 'Low' },
          { fullId: 'cursor-grok-4.6-low-fast', providerPrefix: '', tag: 'Low Fast' },
          { fullId: 'cursor-grok-4.6-thinking-high', providerPrefix: '', tag: 'Thinking' },
        ],
      };
      const wide = await rowFrame(modelRow(grok, 'Stale'), 60, 'cursor-grok-4.6-low');
      expect(wide).toContain('3 options');
      expect(wide).toContain('Stale');
      expect(wide).toContain('272K');

      const squeezed = renderModelRow({
        row: modelRow(grok, 'Stale'),
        isCursor: false,
        maxWidth: 32,
        currentModel: 'cursor-grok-4.6-low',
        sectioned: false,
        auth: AUTH,
      }).props;
      expect(squeezed.label).toBe('Cursor Grok 4.6');
      expect(squeezed.metadata).toContain('Stale');
      expect(squeezed.metadata).not.toContain('3 options');
    });

    it('drops the count rather than painting a bare digit when the noun no longer fits', () => {
      const opus48: ModelOption = {
        id: 'claude-opus-4-8',
        displayName: 'Claude Opus 4.8',
        contextLength: 200_000,
        variants: [
          { fullId: 'claude-opus-4-8', providerPrefix: '', tag: '' },
          { fullId: 'claude-opus-4-8-fast', providerPrefix: '', tag: 'Fast' },
        ],
      };
      const wide = renderModelRow({
        row: modelRow(opus48, 'Detected'),
        isCursor: false,
        maxWidth: 60,
        currentModel: undefined,
        sectioned: false,
        auth: AUTH,
      }).props;
      expect(wide.metadata).toContain('2 options');
      expect(wide.metadata).toContain('200K');

      const squeezed = renderModelRow({
        row: modelRow(opus48, 'Detected'),
        isCursor: false,
        maxWidth: 32,
        currentModel: undefined,
        sectioned: false,
        auth: AUTH,
      }).props;
      expect(squeezed.metadata).toContain('200K');
      expect(squeezed.metadata).not.toMatch(/\b2\b/);
    });

    it('leaves a non-family row to ListRow at a width that clips the family chip', async () => {
      const retained: ModelOption = {
        id: 'retained-model',
        membership: 'stale',
        contextLength: 272_000,
      };
      const ui = renderFeature(
        renderModelRow({
          row: modelRow(retained, 'Stale'),
          isCursor: false,
          maxWidth: 21,
          currentModel: undefined,
          sectioned: false,
          auth: AUTH,
        }),
      );
      await tick(20);
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Stale');
      expect(frame).toContain('…');
      expect(frame).not.toContain(glyph('disclosureClosed'));
      ui.unmount();
    });

    it('hangs axis rows off the parent and closes the block with the last-child glyph', async () => {
      // The grid is full both ways, so effort and fast are both axes the row builder
      // would emit and both ladders have somewhere to step.
      const luna: ModelOption = {
        id: 'gpt-5.6-luna-high',
        displayName: 'GPT-5.6 Luna',
        variants: [
          { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
          { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
          { fullId: 'gpt-5.6-luna-low', providerPrefix: '', tag: 'Low' },
          { fullId: 'gpt-5.6-luna-low-fast', providerPrefix: '', tag: 'Low Fast' },
        ],
      };
      const width = 60;
      const parent = renderFeature(
        renderModelRow({
          row: { ...modelRow(luna, 'Detected'), expanded: true },
          isCursor: false,
          maxWidth: width,
          currentModel: 'gpt-5.6-luna-high',
          sectioned: false,
          auth: AUTH,
        }),
      );
      const effort = renderFeature(
        renderModelRow({
          row: axisRow(luna, 'effort', 'high'),
          isCursor: false,
          maxWidth: width,
          currentModel: undefined,
          sectioned: false,
          auth: AUTH,
        }),
      );
      const fast = renderFeature(
        renderModelRow({
          row: axisRow(luna, 'fast', 'off', true),
          isCursor: false,
          maxWidth: width,
          currentModel: undefined,
          sectioned: false,
          auth: AUTH,
        }),
      );
      await tick(20);
      const parentLine = stripAnsiStyles(parent.lastFrame() ?? '').split('\n')[0] ?? '';
      const effortLine = stripAnsiStyles(effort.lastFrame() ?? '').split('\n')[0] ?? '';
      const fastLine = stripAnsiStyles(fast.lastFrame() ?? '').split('\n')[0] ?? '';

      expect(effortLine.startsWith(`  ${glyph('treeBranch')}${glyph('divider')} effort`)).toBe(
        true,
      );
      expect(fastLine.startsWith(`  ${glyph('treeLast')}${glyph('divider')} fast`)).toBe(true);
      expect(effortLine).not.toContain(glyph('treeLast'));

      // The axis row spends its trailing cell on nothing, so the value column stops one
      // cell short of the parent's disclosure and both axes end in the same column.
      expect(effortLine).not.toContain(glyph('connectorSame'));
      expect(fastLine).not.toContain(glyph('connectorSame'));
      expect(effortLine.indexOf('high') + 'high'.length).toBe(
        fastLine.indexOf('off') + 'off'.length,
      );
      expect(parentLine.indexOf(glyph('disclosureOpen'))).toBeGreaterThan(
        effortLine.indexOf('high') + 'high'.length,
      );
      parent.unmount();
      effort.unmount();
      fast.unmount();
    });

    it('keeps the axis value whole and never paints the filter arrow', async () => {
      const luna: ModelOption = {
        id: 'gpt-5.6-luna-high',
        displayName: 'GPT-5.6 Luna',
        variants: [
          { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
          { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
        ],
      };
      const line = await rowLine(axisRow(luna, 'fast', 'off', true), 60);

      expect(line).toContain('off');
      expect(line).toContain(glyph('treeLast'));
      expect(line).not.toContain(glyph('connectorSame'));
    });

    it('renders the same cells whether or not the ladder can step', async () => {
      const model: ModelOption = {
        id: 'gpt-5',
        displayName: 'GPT-5',
        variants: [
          { fullId: 'gpt-5', providerPrefix: '', tag: 'Medium' },
          { fullId: 'gpt-5-high', providerPrefix: '', tag: 'High' },
        ],
      };
      const lineFor = (steps: boolean): Promise<string> =>
        rowLine(axisRow(model, 'fast', 'off', true, steps), 60);

      const dead = await lineFor(false);
      const live = await lineFor(true);

      expect(dead).not.toContain(glyph('connectorSame'));
      expect(live).not.toContain(glyph('connectorSame'));
      // The trailing cell is blank either way, so the value column does not slide right.
      expect(dead.indexOf('off')).toBe(live.indexOf('off'));
    });

    it('renders axis rows with the axis label and current value', async () => {
      const luna: ModelOption = {
        id: 'gpt-5.6-luna-high-fast',
        displayName: 'GPT-5.6 Luna',
        variants: [
          { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
          { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
        ],
      };
      const effort = renderFeature(
        renderModelRow({
          row: axisRow(luna, 'effort', 'high'),
          isCursor: false,
          maxWidth: 60,
          currentModel: undefined,
          sectioned: false,
          auth: AUTH,
        }),
      );
      await tick(20);
      expect(effort.lastFrame() ?? '').toContain('effort');
      expect(effort.lastFrame() ?? '').toContain('high');
      effort.unmount();

      const fast = renderFeature(
        renderModelRow({
          row: axisRow(luna, 'fast', 'on'),
          isCursor: false,
          maxWidth: 60,
          currentModel: undefined,
          sectioned: false,
          auth: AUTH,
        }),
      );
      await tick(20);
      expect(fast.lastFrame() ?? '').toContain('fast');
      expect(fast.lastFrame() ?? '').toContain('on');
      fast.unmount();
    });

    it('counts distinct provider routes, not variant spellings', async () => {
      const threeSpellings: ModelOption = {
        id: 'github-copilot/gpt-5.6',
        contextLength: 128_000,
        variants: [
          { fullId: 'github-copilot/gpt-5.6', providerPrefix: 'github-copilot', tag: 'copilot' },
          {
            fullId: 'github-copilot/gpt-5.6-high',
            providerPrefix: 'github-copilot',
            tag: 'copilot',
          },
          {
            fullId: 'kilo/openrouter/gpt-5.6',
            providerPrefix: 'kilo/openrouter',
            tag: 'openrouter',
          },
        ],
      };
      const frame = await rowFrame(modelRow(threeSpellings, 'Detected'), 60);

      expect(frame).toContain('2 providers');
      expect(frame).not.toContain('3 providers');
    });

    it('spells a Cursor family count from the factory, never from a pasted number', async () => {
      const families = mergeOptionFamilies(cursorModelOptions()).filter(
        (model) => (model.variants ?? []).length >= 2,
      );
      const family = families[0];
      if (family === undefined) throw new Error('cursorModelOptions() merged into no family');
      const count = (family.variants ?? []).length;

      const frame = await rowFrame(modelRow(family, 'Detected'), 60);

      expect(frame).toContain(`${count} options`);
    });

    it('gives a variant-less row with a ladder a disclosure chevron, and one without none', async () => {
      const withLadder: ModelOption = {
        id: 'opus',
        displayName: 'Opus 5',
        membership: 'confirmed',
        contextLength: 1_000_000,
        effortChoices: ['low', 'medium', 'high'],
      };
      const withoutLadder: ModelOption = {
        id: 'haiku',
        displayName: 'Haiku 4.5',
        membership: 'confirmed',
        contextLength: 200_000,
        effortChoices: [],
      };

      const laddered = await rowFrame(modelRow(withLadder, 'Detected'), 60, 'opus');
      const bare = await rowFrame(modelRow(withoutLadder, 'Detected'), 60, 'opus');

      expect(laddered).toContain(glyph('disclosureClosed'));
      expect(bare).not.toContain(glyph('disclosureClosed'));
      expect(bare).not.toContain(glyph('disclosureOpen'));
    });

    it('opens the chevron on an expanded flag-channel row', async () => {
      const withLadder: ModelOption = {
        id: 'opus',
        displayName: 'Opus 5',
        membership: 'confirmed',
        contextLength: 1_000_000,
        effortChoices: ['low', 'medium', 'high'],
      };
      const frame = await rowFrame(
        { ...modelRow(withLadder, 'Detected'), expanded: true },
        60,
        'opus',
      );

      expect(frame).toContain(glyph('disclosureOpen'));
      expect(frame).not.toContain(glyph('disclosureClosed'));
    });

    it('puts the flag-channel chevron after the metadata and before the check', async () => {
      const withLadder: ModelOption = {
        id: 'opus',
        displayName: 'Opus 5',
        membership: 'confirmed',
        contextLength: 1_000_000,
        effortChoices: ['low', 'medium', 'high'],
      };
      const line = await rowLine(modelRow(withLadder, 'Detected'), 60, 'opus');

      expect(line.indexOf('1M')).toBeGreaterThan(-1);
      expect(line.indexOf(glyph('disclosureClosed'))).toBeGreaterThan(line.indexOf('1M'));
      expect(line.indexOf(glyph('check'))).toBeGreaterThan(line.indexOf(glyph('disclosureClosed')));
    });

    it('still renders the option count on an expanded family', async () => {
      const luna: ModelOption = {
        id: 'gpt-5.6-luna-high',
        displayName: 'GPT-5.6 Luna',
        contextLength: 1_000_000,
        variants: [
          { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
          { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
          { fullId: 'gpt-5.6-luna-low', providerPrefix: '', tag: 'Low' },
        ],
      };

      const collapsed = await rowFrame(modelRow(luna, 'Detected'), 60, 'gpt-5.6-luna-high');
      const expanded = await rowFrame(
        { ...modelRow(luna, 'Detected'), expanded: true },
        60,
        'gpt-5.6-luna-high',
      );

      expect(collapsed).toContain('3 options');
      expect(expanded).toContain('3 options');
      expect(expanded).toContain('1M');
    });

    it('renders a single-variant row without any provider annotation', async () => {
      const ui = renderFeature(
        renderModelRow({
          row: modelRow(
            {
              id: 'openrouter/gemini-3-flash',
              variants: [
                {
                  fullId: 'openrouter/gemini-3-flash',
                  providerPrefix: 'openrouter',
                  tag: 'openrouter',
                },
              ],
            },
            'Detected',
          ),
          isCursor: false,
          maxWidth: 60,
          currentModel: undefined,
          sectioned: true,
          auth: AUTH,
        }),
      );
      await tick(20);
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain('providers');
      expect(frame).not.toContain('openrouter');
      ui.unmount();
    });

    it('marks the row configured when any variant spelling matches the saved model', async () => {
      const ui = renderFeature(
        renderModelRow({
          row: modelRow(MERGED, 'Detected'),
          isCursor: false,
          maxWidth: 60,
          currentModel: 'kilo/openrouter/gpt-5.6',
          sectioned: false,
          auth: AUTH,
        }),
      );
      await tick(20);
      expect(ui.lastFrame() ?? '').toContain(glyph('check'));
      ui.unmount();
    });
  });

  it('shows the configured command with its saved contract on the launcher row', async () => {
    const launcher = pickerItem({
      id: 'custom-command',
      displayName: 'Custom command',
      kind: 'custom-command',
      roles: ['planner', 'implementer'],
      modelPolicy: 'none',
      billing: 'unknown',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
    });

    for (const [kind, contractWord] of [
      ['shell', 'output'],
      ['agent', 'direct'],
    ] as const) {
      const ui = renderFeature(
        renderToolRow({
          item: launcher,
          isCursor: false,
          isSelected: false,
          isContext: false,
          maxWidth: 40,
          currentCommand: 'my-tool --json',
          currentCommandKind: kind,
        }),
      );
      await tick();
      expect(ui.lastFrame()).toContain(`${contractWord} · my-tool --json`);
      ui.unmount();
    }
  });

  it('renders displayName when present and falls back to formatModelName when absent', async () => {
    const withName = renderFeature(
      renderModelRow({
        row: modelRow({ id: 'custom-coder-v1', displayName: 'Claude Opus 4.5' }, 'Known'),
        isCursor: false,
        maxWidth: 40,
        currentModel: undefined,
        sectioned: false,
        auth: AUTH,
      }),
    );
    await tick(20);
    expect(withName.lastFrame() ?? '').toContain('Claude Opus 4.5');
    withName.unmount();

    const withoutName = renderFeature(
      renderModelRow({
        row: modelRow({ id: 'custom-coder-v1' }, 'Known'),
        isCursor: false,
        maxWidth: 40,
        currentModel: undefined,
        sectioned: false,
        auth: AUTH,
      }),
    );
    await tick(20);
    expect(withoutName.lastFrame() ?? '').toContain('Custom Coder V1');
    withoutName.unmount();
  });

  it('renders context state with dim liveBar and keeps the checkmark column unchanged when isContext is true and isCursor is false', async () => {
    const item = pickerItem({
      id: 'claude-code',
      displayName: 'Claude Code',
      kind: 'cli',
      roles: ['planner', 'implementer'],
      modelPolicy: 'optional',
      billing: 'subscription-included',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
      isCurrent: true,
    });

    const contextUi = renderFeature(
      renderToolRow({
        item,
        isCursor: false,
        isSelected: false,
        isContext: true,
        maxWidth: 50,
        currentCommand: undefined,
        currentCommandKind: undefined,
      }),
    );
    await tick(20);
    const contextFrame = contextUi.lastFrame() ?? '';
    expect(stripAnsiStyles(contextFrame)).toContain(glyph('liveBar'));
    expect(stripAnsiStyles(contextFrame)).toContain(glyph('check'));
    expect(stripAnsiStyles(contextFrame)).toContain('Claude Code');
    expect(stripAnsiStyles(contextFrame)).not.toContain('·');
    contextUi.unmount();

    const defaultUi = renderFeature(
      renderToolRow({
        item,
        isCursor: false,
        isSelected: false,
        isContext: false,
        maxWidth: 50,
        currentCommand: undefined,
        currentCommandKind: undefined,
      }),
    );
    await tick(20);
    const defaultFrame = defaultUi.lastFrame() ?? '';
    expect(stripAnsiStyles(defaultFrame)).not.toContain(glyph('liveBar'));
    expect(stripAnsiStyles(defaultFrame)).toContain('·');
    expect(stripAnsiStyles(defaultFrame)).toContain(glyph('check'));
    expect(stripAnsiStyles(defaultFrame)).toContain('Claude Code');
    defaultUi.unmount();
  });

  describe('expanded block tree', () => {
    beforeEach(() => {
      forceUnicodeGlyphs();
    });

    it('draws a parent spine on a depth-2 axis only while the parent continues', async () => {
      const model: ModelOption = { id: 'gpt-5.6', displayName: 'GPT-5.6' };
      const continued = await rowLine(
        axisRow(model, 'fast', 'off', false, true, { depth: 2, parentContinues: true }),
        60,
      );
      const closed = await rowLine(
        axisRow(model, 'fast', 'off', false, true, { depth: 2, parentContinues: false }),
        60,
      );
      const mid = glyph('treeMid');
      const branch = glyph('treeBranch');
      expect(continued.indexOf(mid)).toBeGreaterThan(-1);
      expect(continued.indexOf(mid)).toBeLessThan(continued.indexOf(branch));
      expect(closed).not.toContain(mid);
      expect(closed).toContain(branch);
    });

    it('truncates a long route tag with the shared ellipsis at a narrow width', async () => {
      const row: RightRow = {
        kind: 'route',
        model: { id: 'openai/gpt-5.6' },
        variant: {
          fullId: 'openai/gpt-5.6',
          providerPrefix: 'openai',
          tag: 'opencode-go-plus-a-long-provider-tag',
        },
        last: true,
        auth: { kind: 'unchecked' },
        tree: { depth: 1, parentContinues: false },
      };
      const line = await rowLine(row, 24);
      expect(line).toContain(ELLIPSIS);
      expect(line).not.toContain('opencode-go-plus-a-long-provider-tag');
    });

    it('checks only the persisted route among siblings', async () => {
      const current = 'openai/gpt-5.6';
      const marked = await rowLine(routeRow({ kind: 'unchecked' }), 40, current);
      const sibling: RightRow = {
        kind: 'route',
        model: { id: 'openai/gpt-5.6' },
        variant: {
          fullId: 'opencode-go/gpt-5.6',
          providerPrefix: 'opencode-go',
          tag: 'opencode-go',
        },
        last: false,
        auth: { kind: 'unchecked' },
        tree: { depth: 1, parentContinues: false },
      };
      const unmarked = await rowLine(sibling, 40, current);
      expect(marked).toContain(glyph('check'));
      expect(unmarked).not.toContain(glyph('check'));
    });

    it('reserves the same trailing and check cells on axis, expandable, and non-expandable rows', async () => {
      const family: ModelOption = {
        id: 'gpt-5.6-luna-high',
        displayName: 'GPT-5.6 Luna',
        variants: [
          { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
          { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
        ],
      };
      const width = 60;
      const axis = await rowLine(axisRow(family, 'effort', 'high'), width);
      const expandable = await rowLine(modelRow(family, 'Detected'), width);
      const auto = await rowLine(modelRow({ id: 'auto' }, 'Default'), width);
      const lastPainted = (line: string): number => line.trimEnd().length;
      // Ink trims reserved blank cells. Axis and Auto paint nothing there, so they
      // share a last non-space column; the family paints the trailing chevron two
      // cells further, which is the trailW the others leave blank.
      expect(lastPainted(axis)).toBe(lastPainted(auto));
      expect(lastPainted(expandable)).toBe(lastPainted(auto) + 2);
      expect(expandable).toContain(glyph('disclosureClosed'));
    });

    it('puts the chevron in the trailing cell of an expanded family, exactly once', async () => {
      const luna: ModelOption = {
        id: 'gpt-5.6-luna-high',
        displayName: 'GPT-5.6 Luna',
        variants: [
          { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
          { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
        ],
      };
      const line = await rowLine(
        { ...modelRow(luna, 'Detected'), expanded: true },
        60,
        'gpt-5.6-luna-high',
      );
      const open = glyph('disclosureOpen');
      const closed = glyph('disclosureClosed');
      expect(line.split(open).length - 1).toBe(1);
      expect(line).not.toContain(closed);
    });
  });
});
