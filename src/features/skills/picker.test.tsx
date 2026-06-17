import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { SkillMeta } from '../../core/skills/types.js';
import { skillsStore } from '../../stores/project/skills.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
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
    expect(ui.lastFrame() ?? '').toContain('Planner Skills (1 selected)');

    ui.stdin.write(ENTER);
    await tick(20);
    expect([...skillsStore.get().selected]).toEqual(['skill-5']);
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
});
