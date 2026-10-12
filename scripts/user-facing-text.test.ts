import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findUserFacingTextViolations, userFacingFiles } from './user-facing-text.js';

describe('user-facing text', () => {
  let root: string;

  const write = (relPath: string, source: string): void => {
    const fullPath = join(root, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, source);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'user-facing-text-'));
    write(
      'package.json',
      JSON.stringify({
        files: ['dist/', 'docs/GUIDE.md', './README.md', 'CHANGELOG.md', 'LICENSE'],
      }),
    );
    write(
      '.claude-plugin/marketplace.json',
      JSON.stringify({ plugins: [{ skills: ['./skills/pipeline'] }] }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the shipped Markdown from package.json files and adds the website copy', () => {
    write('README.md', '');
    write('CHANGELOG.md', '');
    write('docs/GUIDE.md', '');
    write('docs/README.md', '');
    write('docs/MAINTAINER.md', '');
    write('website/index.html', '');
    write('website/build/site.ts', '');
    write('website/build/site.test.ts', '');
    write('website/src/lib/copy.ts', '');

    expect(userFacingFiles(root)).toEqual([
      '.claude-plugin/marketplace.json',
      'CHANGELOG.md',
      'README.md',
      'docs/GUIDE.md',
      'docs/README.md',
      'website/build/site.ts',
      'website/index.html',
      'website/src/lib/copy.ts',
    ]);
  });

  it('reports each internal marker with its file and line', () => {
    write(
      'CHANGELOG.md',
      [
        '## [0.2.0]',
        '- cursor: not verified live in this release.',
        '- The retry path is untested on Linux.',
        '- Details in `.nuke/2026-09-21-session-handoff.md`.',
        '- The reviewer answers the consult (owner decision 2026-10-09).',
        '- The owner does not hold a subscription.',
        '- Fixes N-7, DOC-2, REL-04, CLR-01, WD-3 and S11.',
        '- The limit wording was captured live.',
        '- Cursor has no captured wording.',
        '- **Known gaps.** Copilot is not covered.',
      ].join('\n'),
    );
    write('README.md', '');
    write('docs/GUIDE.md', '');

    expect(findUserFacingTextViolations(root)).toEqual([
      'CHANGELOG.md:2: not verified live',
      'CHANGELOG.md:3: untested',
      'CHANGELOG.md:4: .nuke/ path',
      'CHANGELOG.md:5: owner decision',
      'CHANGELOG.md:6: the owner',
      'CHANGELOG.md:7: finding id',
      'CHANGELOG.md:8: captured live',
      'CHANGELOG.md:9: no captured',
      'CHANGELOG.md:10: known gaps',
    ]);
  });

  it('adds the terms of the optional local term list', () => {
    write(
      'CHANGELOG.md',
      [
        '- Zephyr implemented it in the night shift.',
        '- Pick `gpt-5-zephyr` (GPT-5-Zephyr) for long runs.',
      ].join('\n'),
    );
    write('README.md', '');
    write('docs/GUIDE.md', '');

    expect(findUserFacingTextViolations(root)).toEqual([]);

    write('.nuke/user-facing-terms.txt', 'Zephyr\nnight shift\n\n');

    expect(findUserFacingTextViolations(root)).toEqual([
      'CHANGELOG.md:1: Zephyr',
      'CHANGELOG.md:1: night shift',
    ]);
  });

  it('passes product vocabulary that resembles a marker', () => {
    write(
      'docs/GUIDE.md',
      [
        'A criterion the verdict leaves `unverified` blocks pass.',
        'The row reads `1 not verified at the run base`.',
        'Receipts live in the owner-only trust store.',
        'Upload the artifact to S3 with a T-0004 task id.',
        'Solve it on Solaris.',
        'The workspace-base snapshot holds the captured uncommitted files.',
      ].join('\n'),
    );
    write('README.md', '');
    write('CHANGELOG.md', '');

    expect(findUserFacingTextViolations(root)).toEqual([]);
  });

  it('scans the skills a user can install but not the internal ones', () => {
    write('README.md', '');
    write('CHANGELOG.md', '');
    write('docs/GUIDE.md', '');
    write('skills/pipeline/SKILL.md', '---\nname: pipeline\n---\nAsk the owner.');
    write('skills/pipeline/references/run.md', 'See `.nuke/handoff.md`.');
    write('.claude/skills/helper/SKILL.md', '---\nname: helper\n---\nAsk the owner.');
    write(
      'skills/supervise/SKILL.md',
      '---\nname: supervise\nmetadata:\n  internal: true\n---\nAsk the owner.',
    );
    write(
      '.claude/skills/lanes/SKILL.md',
      '---\nname: lanes\nmetadata:\n  internal: true\n---\nAsk the owner.',
    );

    expect(findUserFacingTextViolations(root)).toEqual([
      '.claude/skills/helper/SKILL.md:4: the owner',
      'skills/pipeline/SKILL.md:4: the owner',
      'skills/pipeline/references/run.md:1: .nuke/ path',
    ]);
  });

  it('scans the website copy but not maintainer docs', () => {
    write('README.md', '');
    write('CHANGELOG.md', '');
    write('docs/GUIDE.md', '');
    write('docs/MAINTAINER.md', 'The owner decides.');
    write('website/index.html', '<p>The owner decides.</p>');

    expect(findUserFacingTextViolations(root)).toEqual(['website/index.html:1: the owner']);
  });
});
