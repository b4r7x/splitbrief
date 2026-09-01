import { beforeEach, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import type { PickerOption } from './model-catalog/options.js';
import { deriveModelCatalogCapability } from './model-catalog/posture.js';
import type { ModelOption } from './model-catalog/recency.js';
import { glyph } from '../../lib/glyphs.js';
import type { ProvenanceWord } from '../../core/providers/provenance.js';
import type { RightAxisName, RightRow, RouteAuthState } from './model-catalog/rows.js';
import { renderModelRow, renderToolRow } from './tool-row.js';

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
): RightRow {
  return { kind: 'axis', model, axis, providerPrefix: '', value, choices: [], steps, last };
}

function routeRow(auth: RouteAuthState): RightRow {
  return {
    kind: 'route',
    model: { id: 'openai/gpt-5.6' },
    variant: { fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai' },
    tagWidth: 6,
    auth,
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
    renderModelRow({ row, isCursor: false, maxWidth, currentModel, sectioned: false }),
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

  it('renders custom/default model provenance without parens badges', async () => {
    const customUi = renderFeature(
      renderModelRow({
        row: modelRow({ id: 'my-org/custom', isCustom: true }, 'Custom'),
        isCursor: false,
        maxWidth: 40,
        currentModel: undefined,
        sectioned: false,
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
        row: { kind: 'action', action: 'browse-catalog', text: 'Browse the full catalog' },
        isCursor: false,
        maxWidth: 60,
        currentModel: undefined,
        sectioned: false,
      }),
    );
    await tick(20);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Browse the full catalog');
    expect(frame).toContain(glyph('disclosureClosed'));
    expect(frame).not.toContain(glyph('statusFailed'));
    ui.unmount();
  });

  it('keeps the Default word on the Auto row even inside a sectioned list', async () => {
    const ui = renderFeature(
      renderModelRow({
        row: modelRow({ id: 'auto' }, 'Default'),
        isCursor: false,
        maxWidth: 40,
        currentModel: 'auto',
        sectioned: true,
      }),
    );
    await tick(20);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Auto');
    expect(frame).toContain('Default');
    ui.unmount();
  });

  it('drops the provenance word when the section header already carries it', async () => {
    const ui = renderFeature(
      renderModelRow({
        row: modelRow({ id: 'opus' }, 'Known', 'Fallback'),
        isCursor: false,
        maxWidth: 40,
        currentModel: undefined,
        sectioned: true,
      }),
    );
    await tick(20);
    expect(ui.lastFrame() ?? '').not.toContain('Known');
    ui.unmount();
  });

  it('renders a route row with its tag, and drops the glyph at the floor width', async () => {
    const wide = renderFeature(
      renderModelRow({
        row: routeRow({ kind: 'configured', source: 'oauth' }),
        isCursor: false,
        maxWidth: 40,
        currentModel: undefined,
        sectioned: false,
      }),
    );
    await tick(20);
    const wideFrame = wide.lastFrame() ?? '';
    expect(wideFrame).toContain('openai');
    expect(wideFrame).toContain(glyph('stageDone'));
    wide.unmount();

    // 22 cells is the 60-column column width; below 26 the glyph and the indent go.
    const floor = renderFeature(
      renderModelRow({
        row: routeRow({ kind: 'configured', source: 'oauth' }),
        isCursor: false,
        maxWidth: 22,
        currentModel: undefined,
        sectioned: false,
      }),
    );
    await tick(20);
    const floorFrame = floor.lastFrame() ?? '';
    expect(floorFrame).toContain('openai');
    expect(floorFrame).not.toContain(glyph('stageDone'));
    floor.unmount();
  });

  it('renders an unchecked route as the tag alone', async () => {
    const ui = renderFeature(
      renderModelRow({
        row: routeRow({ kind: 'unchecked' }),
        isCursor: false,
        maxWidth: 40,
        currentModel: undefined,
        sectioned: false,
      }),
    );
    await tick(20);
    const frame = (ui.lastFrame() ?? '').trim();
    expect(frame).toBe('openai');
    ui.unmount();
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

    it('signposts a multi-option family with the composed summary, not an options count', async () => {
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
        }),
      );
      await tick(20);
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('GPT-5.6 Luna');
      expect(frame).toMatch(/High · Fast/);
      expect(frame).not.toMatch(/12 options/);
      expect(frame).not.toContain('options');
      expect(frame).not.toContain('providers');
      expect(frame).not.toContain('Detected');
      ui.unmount();
    });

    it('drops the summary from an expanded family and keeps it on a collapsed one', async () => {
      const luna: ModelOption = {
        id: 'gpt-5.6-luna-high',
        displayName: 'GPT-5.6 Luna',
        variants: [
          { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
          { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
        ],
      };
      const expanded = renderFeature(
        renderModelRow({
          row: { ...modelRow(luna, 'Detected'), expanded: true },
          isCursor: false,
          maxWidth: 60,
          currentModel: 'gpt-5.6-luna-high',
          sectioned: false,
        }),
      );
      await tick(20);
      const expandedFrame = expanded.lastFrame() ?? '';
      expect(expandedFrame).toContain('GPT-5.6 Luna');
      expect(expandedFrame).not.toContain('Standard');
      expect(expandedFrame).toContain(glyph('disclosureOpen'));
      expanded.unmount();

      const collapsed = renderFeature(
        renderModelRow({
          row: modelRow(luna, 'Detected'),
          isCursor: false,
          maxWidth: 60,
          currentModel: 'gpt-5.6-luna-high',
          sectioned: false,
        }),
      );
      await tick(20);
      const collapsedFrame = collapsed.lastFrame() ?? '';
      expect(collapsedFrame).toContain('Standard');
      expect(collapsedFrame).toContain(glyph('disclosureClosed'));
      collapsed.unmount();
    });

    it('keeps the model name whole by dropping the context length, then the summary', async () => {
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

      // The three-axis summary and the context length together push the name under
      // its floor, so the context goes first and the name stays whole.
      const tight = await frameAt(40);
      expect(tight).toContain('Claude Opus 5');
      expect(tight).toContain('Low · Standard · Off');
      expect(tight).not.toContain('1M');

      // Narrower still, the summary cannot buy its place either.
      const tighter = await frameAt(38);
      expect(tighter).toContain('Claude Opus 5');
      expect(tighter).not.toContain('Standard');
      expect(tighter).toContain('1M');
    });

    it('sheds the context length, then the summary, and clips the Stale word rather than drop it', async () => {
      // A collapsed family carries no other staleness signal, and the disclosure
      // spells the summary out again one keypress away, so the tail sheds in that order.
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
      const frameAt = (maxWidth: number): Promise<string> =>
        rowFrame(modelRow(grok, 'Stale'), maxWidth, 'cursor-grok-4.6-low');

      const wide = await frameAt(48);
      expect(wide).toContain('Low · Standard · Off');
      expect(wide).toContain('Stale');
      expect(wide).not.toContain('272K');

      const tight = await frameAt(26);
      expect(tight).toContain('Stale');
      expect(tight).not.toContain('272K');
      expect(tight).not.toContain('Standard');

      // Below the name floor the word still goes out: it costs the name cells, but
      // an empty column would leave the row with nothing to say it is stale.
      const floored = await frameAt(21);
      expect(floored).toContain('Stale');
      expect(floored).not.toContain('Cursor Grok 4.6');

      // Narrower still, ListRow clips it. A flagged row reads as flagged either way.
      const clipped = await frameAt(18);
      expect(clipped).toContain('St…');
      expect(clipped).not.toContain('Stale');
    });

    it('keeps the provenance word rather than fall back to a summary that would fit', async () => {
      // One axis, so the summary is narrower than the word beside it: the only shape
      // where a summary-only tail would fit a room the provenance word cannot.
      const grok: ModelOption = {
        id: 'cursor-grok-4.6-low',
        displayName: 'Cursor Grok 4.6',
        contextLength: 272_000,
        variants: [
          { fullId: 'cursor-grok-4.6-low', providerPrefix: '', tag: 'Low' },
          { fullId: 'cursor-grok-4.6-max', providerPrefix: '', tag: 'Max' },
        ],
      };
      const frameAt = (maxWidth: number): Promise<string> =>
        rowFrame(modelRow(grok, 'Stale'), maxWidth, 'cursor-grok-4.6-low');

      // Room for one of them: the word the row cannot recover elsewhere wins.
      const word = await frameAt(26);
      expect(word).toContain('Stale');
      expect(word).not.toContain('Low');

      // Room for neither, though the summary alone would have fit: the word still goes
      // out, paid for out of the name's cells.
      const floored = await frameAt(23);
      expect(floored).toContain('Stale');
      expect(floored).not.toContain('Low');
      expect(floored).not.toContain('Cursor Grok');
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
        }),
      );
      await tick(20);
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Stale 2…');
      expect(frame).not.toContain(glyph('disclosureClosed'));
      ui.unmount();
    });

    it('hangs axis rows off the parent and closes the block with the last-child glyph', async () => {
      // The grid is full both ways, so effort and speed are both axes the row builder
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
        }),
      );
      const effort = renderFeature(
        renderModelRow({
          row: axisRow(luna, 'effort', 'High'),
          isCursor: false,
          maxWidth: width,
          currentModel: undefined,
          sectioned: false,
        }),
      );
      const speed = renderFeature(
        renderModelRow({
          row: axisRow(luna, 'speed', 'Standard', true),
          isCursor: false,
          maxWidth: width,
          currentModel: undefined,
          sectioned: false,
        }),
      );
      await tick(20);
      const parentLine = stripAnsiStyles(parent.lastFrame() ?? '').split('\n')[0] ?? '';
      const effortLine = stripAnsiStyles(effort.lastFrame() ?? '').split('\n')[0] ?? '';
      const speedLine = stripAnsiStyles(speed.lastFrame() ?? '').split('\n')[0] ?? '';

      expect(effortLine.startsWith(`  ${glyph('treeBranch')}${glyph('divider')} effort`)).toBe(
        true,
      );
      expect(speedLine.startsWith(`  ${glyph('treeLast')}${glyph('divider')} speed`)).toBe(true);
      expect(effortLine).not.toContain(glyph('treeLast'));

      // The cycle affordance stands in the parent's disclosure column, so nothing shifts.
      expect(effortLine).toContain(glyph('connectorSame'));
      expect(speedLine).toContain(glyph('connectorSame'));
      expect(effortLine.indexOf(glyph('connectorSame'))).toBe(
        parentLine.indexOf(glyph('disclosureOpen')),
      );
      expect(speedLine.indexOf(glyph('connectorSame'))).toBe(
        effortLine.indexOf(glyph('connectorSame')),
      );
      parent.unmount();
      effort.unmount();
      speed.unmount();
    });

    it('keeps the axis value whole in a column too narrow to also hold the cycle glyph', async () => {
      const luna: ModelOption = {
        id: 'gpt-5.6-luna-high',
        displayName: 'GPT-5.6 Luna',
        variants: [
          { fullId: 'gpt-5.6-luna-high', providerPrefix: '', tag: '1M High' },
          { fullId: 'gpt-5.6-luna-high-fast', providerPrefix: '', tag: 'High Fast' },
        ],
      };
      const lineAt = (maxWidth: number): Promise<string> =>
        rowLine(axisRow(luna, 'speed', 'Standard', true), maxWidth);

      // A value the column truncated away is a value space cannot be seen to cycle.
      const floored = await lineAt(22);
      expect(floored).toContain('Standard');
      expect(floored).toContain(glyph('treeLast'));
      expect(floored).not.toContain(glyph('connectorSame'));

      // 20 is the widest column where the check cells the floor gives back are the
      // only thing keeping the value whole.
      const narrow = await lineAt(20);
      expect(narrow).toContain('Standard');
      expect(narrow).not.toContain(glyph('connectorSame'));

      const roomy = await lineAt(23);
      expect(roomy).toContain('Standard');
      expect(roomy).toContain(glyph('connectorSame'));
    });

    it('drops the cycle mark on an axis with nowhere to step and holds its cells', async () => {
      const model: ModelOption = {
        id: 'gpt-5',
        displayName: 'GPT-5',
        variants: [
          { fullId: 'gpt-5', providerPrefix: '', tag: 'Medium' },
          { fullId: 'gpt-5-high', providerPrefix: '', tag: 'High' },
        ],
      };
      const lineFor = (steps: boolean): Promise<string> =>
        rowLine(axisRow(model, 'speed', 'Standard', true, steps), 60);

      const dead = await lineFor(false);
      const live = await lineFor(true);

      expect(dead).not.toContain(glyph('connectorSame'));
      expect(live).toContain(glyph('connectorSame'));
      // The mark goes but its cells stay, so the value column does not slide right.
      expect(dead.indexOf('Standard')).toBe(live.indexOf('Standard'));
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
          row: axisRow(luna, 'effort', 'High'),
          isCursor: false,
          maxWidth: 60,
          currentModel: undefined,
          sectioned: false,
        }),
      );
      await tick(20);
      expect(effort.lastFrame() ?? '').toContain('effort');
      expect(effort.lastFrame() ?? '').toContain('High');
      effort.unmount();

      const speed = renderFeature(
        renderModelRow({
          row: axisRow(luna, 'speed', 'Fast'),
          isCursor: false,
          maxWidth: 60,
          currentModel: undefined,
          sectioned: false,
        }),
      );
      await tick(20);
      expect(speed.lastFrame() ?? '').toContain('speed');
      expect(speed.lastFrame() ?? '').toContain('Fast');
      speed.unmount();
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
        }),
      );
      await tick(20);
      expect(ui.lastFrame() ?? '').toContain(glyph('check'));
      ui.unmount();
    });
  });

  describe('variant axis rows', () => {
    beforeEach(() => {
      forceUnicodeGlyphs();
    });

    const hybrid: ModelOption = {
      id: 'openai/gpt-5.6-luna-high',
      displayName: 'GPT-5.6 Luna',
      variants: [
        { fullId: 'openai/gpt-5.6-luna-high', providerPrefix: 'openai', tag: 'High' },
        { fullId: 'openai/gpt-5.6-luna-low', providerPrefix: 'openai', tag: 'Low' },
      ],
    };

    it('draws a variant axis row with the drafted preset', async () => {
      const line = await rowLine(axisRow(hybrid, 'variant', 'xhigh', true), 60);
      expect(line).toContain('variant');
      expect(line).toContain('xhigh');
    });

    it('draws the cycle mark for a ladder that can step', async () => {
      const line = await rowLine(axisRow(hybrid, 'variant', 'high', true), 60);
      expect(line).toContain(glyph('connectorSame'));
    });

    it('drops the cycle mark for a ladder with nowhere to step', async () => {
      const line = await rowLine(axisRow(hybrid, 'variant', 'max', true, false), 60);
      expect(line).toContain('max');
      expect(line).not.toContain(glyph('connectorSame'));
    });

    it('drops the mark but keeps the cells below the axis floor width', async () => {
      const variant = await rowLine(axisRow(hybrid, 'variant', 'high', true), 22);
      const effort = await rowLine(axisRow(hybrid, 'effort', 'High'), 22);
      expect(variant).not.toContain(glyph('connectorSame'));
      expect(variant.indexOf('high')).toBe(effort.indexOf('High'));
    });

    it('closes the child block on the last axis row', async () => {
      const last = await rowLine(axisRow(hybrid, 'variant', 'high', true), 60);
      const branch = await rowLine(axisRow(hybrid, 'variant', 'high'), 60);
      expect(last.startsWith(`  ${glyph('treeLast')}${glyph('divider')} variant`)).toBe(true);
      expect(branch.startsWith(`  ${glyph('treeBranch')}${glyph('divider')} variant`)).toBe(true);
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
});
