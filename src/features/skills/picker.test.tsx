import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import type { SkillMeta } from '../../core/skills/types.js';
import { skillsStore } from '../../stores/project/skills.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { glyph } from '../../lib/glyphs.js';
import { SkillsPicker } from './picker.js';

const PAGE_DOWN = '\u001b[6~';
const HOME = '\u001b[H';
const END = '\u001b[F';
const ARROW_DOWN = '\u001b[B';
const SPACE = ' ';
const ENTER = '\r';

function skill(id: string, scope: SkillMeta['scope'] = 'global'): SkillMeta {
  return {
    id,
    name: id,
    description: `${id} description`,
    path: `/tmp/${id}`,
    scope,
  };
}

describe('SkillsPicker', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 100, rows: 28, isSmall: false });
  });

  afterEach(() => {
    resetAllStores();
  });

  it('toggles the highlighted skill after PageDown navigation', async () => {
    const skills = Array.from({ length: 8 }, (_, i) => skill(`skill-${i}`));
    skillsStore.setAvailable(skills);

    const ui = renderFeature(<SkillsPicker />);
    await tick(20);

    ui.stdin.write(PAGE_DOWN);
    await tick(20);
    ui.stdin.write(SPACE);
    await tick(20);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('skills · 1 selected');

    ui.stdin.write(ENTER);
    await tick(20);
    expect([...skillsStore.get().selected]).toEqual(['skill-7']);
    ui.unmount();
  });

  it('right-aligns the selected marker on a selected description row at the row edge', async () => {
    skillsStore.setAvailable([skill('alpha'), skill('bravo')]);

    const ui = renderFeature(<SkillsPicker />);
    await tick(20);
    ui.stdin.write(ARROW_DOWN);
    await tick(20);
    ui.stdin.write(SPACE);
    await tick(20);

    const selectedLine = stripAnsiStyles(ui.lastFrame() ?? '')
      .split('\n')
      .find((line) => line.includes('bravo'));
    expect(selectedLine).toBeDefined();
    // The selected marker right-aligns to the inner content edge; the restored OverlayPanel frame (border +
    // padding) now sits to its right, so strip that trailing chrome before the edge check.
    expect((selectedLine ?? '').replace(/[\s|│]+$/u, '').endsWith(glyph('check'))).toBe(true);
    ui.unmount();
  });

  it('keeps Down then Space toggling the highlighted skill', async () => {
    skillsStore.setAvailable([skill('alpha'), skill('bravo')]);

    const ui = renderFeature(<SkillsPicker />);
    await tick(20);

    ui.stdin.write(ARROW_DOWN);
    await tick(20);
    ui.stdin.write(SPACE);
    await tick(20);
    ui.stdin.write(ENTER);
    await tick(20);

    expect([...skillsStore.get().selected]).toEqual(['bravo']);
    ui.unmount();
  });

  it('shows all skills without a false more row when they fit the terminal', async () => {
    const skills = Array.from({ length: 6 }, (_, i) => skill(`skill-${i}`));
    skillsStore.setAvailable(skills);

    const ui = renderFeature(<SkillsPicker />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    for (const item of skills) {
      expect(frame).toContain(item.name);
    }
    expect(frame).not.toContain('more');
    ui.unmount();
  });

  it('renders both skill sections within the terminal row budget', async () => {
    const terminalRows = 18;
    terminalSizeStore.__testReset({ cols: 100, rows: terminalRows, isSmall: false });
    skillsStore.setAvailable([
      skill('project-alpha', 'project'),
      skill('project-bravo', 'project'),
      skill('global-charlie', 'global'),
    ]);

    const ui = renderFeature(<SkillsPicker />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(terminalRows);
    for (const label of ['project', 'global', 'project-alpha', 'project-bravo', 'global-charlie']) {
      expect(frame).toContain(label);
    }
    expect(frame).not.toContain('more');
    ui.unmount();
  });

  it('keeps rows=6 in a compact filter state when no list rows fit', async () => {
    const terminalRows = 6;
    terminalSizeStore.__testReset({ cols: 80, rows: terminalRows, isSmall: true });
    skillsStore.setAvailable([skill('alpha', 'project')]);

    const ui = renderFeature(<SkillsPicker />);
    await tick(20);

    ui.stdin.write('alpha-filter');
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(terminalRows);
    expect(stripAnsiStyles(frame)).toContain('skills · 0 selected');
    expect(frame).toContain('alpha-filter');
    expect(frame).toContain('⏎ confirm');
    expect(frame).not.toContain('no matching skills');
    expect(frame).not.toContain('╭');
    expect(frame).not.toContain('╰');
    ui.unmount();
  });

  it('sanitizes terminal controls in skill labels and descriptions', async () => {
    skillsStore.setAvailable([
      {
        id: 'unsafe',
        name: 'alpha\u001b[31m\nbeta',
        description: 'safe\u0007\u001b]0;owned\u0007desc\u001b[2K',
        path: '/tmp/unsafe',
        scope: 'global',
      },
    ]);

    const ui = renderFeature(<SkillsPicker />);
    await tick(20);

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('alphabeta');
    expect(frame).toContain('safedesc');
    expect(frame).not.toContain('owned');
    expect(frame).not.toContain('\u001b');
    expect(frame).not.toContain('\u0007');
    ui.unmount();
  });

  it('treats Home and End as navigation before Space toggles', async () => {
    const skills = Array.from({ length: 4 }, (_, i) => skill(`skill-${i}`));
    skillsStore.setAvailable(skills);

    const ui = renderFeature(<SkillsPicker />);
    await tick(20);

    ui.stdin.write(END);
    await tick(20);
    ui.stdin.write(SPACE);
    await tick(20);
    ui.stdin.write(HOME);
    await tick(20);
    ui.stdin.write(SPACE);
    await tick(20);
    ui.stdin.write(ENTER);
    await tick(20);

    expect([...skillsStore.get().selected].sort()).toEqual(['skill-0', 'skill-3']);
    ui.unmount();
  });

  it('marks a selected skill with a trailing selected marker and drops the checkbox column', async () => {
    skillsStore.setAvailable([skill('alpha'), skill('bravo')]);

    const ui = renderFeature(<SkillsPicker />);
    await tick(20);

    ui.stdin.write(ARROW_DOWN);
    await tick(20);
    ui.stdin.write(SPACE);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(glyph('check'));
    expect(frame).not.toContain('[x]');
    expect(frame).not.toContain('[ ]');
    ui.unmount();
  });

  it('appends Space to the query instead of toggling while typing', async () => {
    skillsStore.setAvailable([skill('alpha'), skill('bravo')]);

    const ui = renderFeature(<SkillsPicker />);
    await tick(20);

    ui.stdin.write('a');
    await tick(20);
    ui.stdin.write(SPACE);
    await tick(20);

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('skills · 0 selected');
    ui.unmount();
  });

  it('renders dim lowercase group headers', async () => {
    skillsStore.setAvailable([skill('proj', 'project'), skill('glob', 'global')]);

    const ui = renderFeature(<SkillsPicker />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('project');
    expect(frame).toContain('global');
    expect(frame).not.toContain('Project');
    expect(frame).not.toContain('Global');
    ui.unmount();
  });
});

describe('SkillsPicker row activation', () => {
  beforeEach(() => {
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 100, rows: 28, isSmall: false });
  });

  afterEach(() => {
    resetAllStores();
    _resetMouseZones();
  });

  it('toggles the clicked skill without saving and closing', async () => {
    skillsStore.setAvailable([skill('alpha', 'project'), skill('bravo', 'project')]);

    const ui = renderFeature(<SkillsPicker />);
    await tick(20);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('skills · 0 selected');

    const zones = collectClickableZones({ cols: 100, rows: 28 });
    zones.get('list-row:bravo')?.();
    await tick(20);

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('skills · 1 selected');
    expect(skillsStore.get().selected.size).toBe(0);
    ui.unmount();
  });

  it('confirms the click-toggled selection on Enter', async () => {
    skillsStore.setAvailable([skill('alpha', 'project'), skill('bravo', 'project')]);

    const ui = renderFeature(<SkillsPicker />);
    await tick(20);

    const zones = collectClickableZones({ cols: 100, rows: 28 });
    zones.get('list-row:bravo')?.();
    await tick(20);
    expect(skillsStore.get().selected.size).toBe(0);

    ui.stdin.write(ENTER);
    await tick(20);

    expect([...skillsStore.get().selected]).toEqual(['bravo']);
    ui.unmount();
  });
});
