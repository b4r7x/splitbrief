import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntimeCommands } from '../../src/core/runtime/commands/registry.js';
import { makeCtx } from '#testing/helpers/runtime-commands.js';

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

const usageSection = section(gettingStarted, '\n## 8. Usage details\n');

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

describe('usage details section', () => {
  it('keeps counters out of the main workflow and closed-run ledger', () => {
    expect(usageSection).toContain(
      'Main workflow screens and the closed-run ledger do not show these counters',
    );
    expect(usageSection).toContain('There is no Show spend control');
  });

  it('names the workflow command for opening live and saved usage details', () => {
    const commands = createRuntimeCommands(makeCtx());
    const usageCommand = commands.find((command) => command.name === '/usage');
    expect(usageCommand?.validScreens).toEqual(['workflow']);
    expect(usageSection).toContain('`/usage`');
    expect(usageSection).toContain('live and saved runs');
  });

  it('distinguishes missing evidence from zero usage or zero cost', () => {
    expect(usageSection).toContain('reported token counters and monetary estimates');
    expect(usageSection).toContain('Unknown usage stays unknown');
    expect(usageSection).toContain('an unpriced run is not a zero-cost run');
  });
});
