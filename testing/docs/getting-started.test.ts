import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = join(import.meta.dirname, '../..');
const gettingStarted = readFileSync(join(projectRoot, 'docs/GETTING-STARTED.md'), 'utf8');
const readme = readFileSync(join(projectRoot, 'README.md'), 'utf8');
const packageVersion = (
  JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { version: string }
).version;

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
    expect(banner).toMatch(/pre-1\.0/);
    expect(banner).toMatch(/makes no claim about the quality of the code/i);
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
