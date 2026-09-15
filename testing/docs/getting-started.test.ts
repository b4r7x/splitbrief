import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFS } from '../../src/core/settings/catalog.js';
import { createRuntimeCommands } from '../../src/core/runtime/commands/registry.js';
import { COPY_TARGETS } from '../../src/core/runtime/commands/types.js';
import { makeCtx } from '#testing/helpers/runtime-commands.js';
import { getWorkflowSidebarWidth } from '../../src/features/workflow/layout/rect.js';

const projectRoot = join(import.meta.dirname, '../..');
const gettingStarted = readFileSync(join(projectRoot, 'docs/GETTING-STARTED.md'), 'utf8');
const readme = readFileSync(join(projectRoot, 'README.md'), 'utf8');
const packageVersion = (
  JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { version: string }
).version;

function section(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  expect(start, `missing heading ${heading}`).toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start + heading.length);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

const costSection = section(gettingStarted, '\n## 8. Spend\n');

// A reader who meets the product through either of these two files has to
// learn what it is before they are told how to run it. The audited state was
// "a validated feature in under five minutes" with no maturity statement
// anywhere in either file.
describe('maturity disclosure', () => {
  it.each([
    ['README.md', readme],
    ['docs/GETTING-STARTED.md', gettingStarted],
  ])('%s states its maturity above the fold', (_path, doc) => {
    const marker = doc.indexOf('**Maturity.**');
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(doc.slice(0, marker).split('\n').length).toBeLessThan(12);

    const banner = doc.slice(marker, marker + 800);
    expect(banner).toMatch(/early software/i);
    expect(banner).toMatch(/no evaluation run has been recorded/i);
  });

  it('keeps the pre-1.0 wording tied to the shipped version', () => {
    // When the package reaches 1.0 this fails, which is the moment the banner
    // has to be rewritten rather than quietly outliving its own claim.
    expect(packageVersion.startsWith('0.')).toBe(true);
    expect(readme).toMatch(/pre-1\.0/);
    expect(gettingStarted).toMatch(/pre-1\.0/);
  });

  it('promises no completion time for a first run', () => {
    for (const doc of [readme, gettingStarted]) {
      expect(doc).not.toMatch(/in (under )?(a few|five|5|two|2|ten|10) minutes/i);
    }
  });
});

describe('install story', () => {
  it('README and docs/GETTING-STARTED.md agree on the install story', () => {
    const globalInstall = /npm install -g splitbrief/;
    expect(globalInstall.test(readme)).toBe(globalInstall.test(gettingStarted));
  });
});

// §8 documented a top status line reading `spent … proj … budget … cache …`
// that no component renders. Every surface it now names is checked against the
// registry or constant that produces it.
describe('spend section', () => {
  it('describes no always-visible cost header', () => {
    expect(costSection).not.toMatch(/top status line/i);
    expect(costSection).not.toMatch(/always visible/i);
    expect(costSection).toMatch(/no persistent cost header/i);
  });

  it('names the sidebar toggle and the width below which it paints nothing', () => {
    const commands = createRuntimeCommands(makeCtx());
    expect(commands.some((command) => command.name === '/sidebar')).toBe(true);
    expect(getWorkflowSidebarWidth({ cols: 119, sidebarVisible: true })).toBe(0);
    expect(getWorkflowSidebarWidth({ cols: 120, sidebarVisible: true })).toBe(0);
    expect(costSection).toContain('`/sidebar`');
    expect(costSection).toContain('at or below 120 columns');
  });

  it('names the Settings toggle that hides every spend figure', () => {
    expect(SETTINGS_DEFS.some((def) => def.id === 'workflow.showSpend')).toBe(true);
    expect(costSection).toContain('workflow.showSpend');
  });

  it('names a copy target the command actually accepts', () => {
    expect(COPY_TARGETS).toContain('cost');
    expect(costSection).toContain('`/copy cost`');
  });
});
