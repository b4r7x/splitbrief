import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../paths.js';
import { readConfigDocument } from './document.js';
import { writeConfig } from './io.js';
import { recordSeatOfRecord } from './record-seat.js';

let tmp = '';

function newProject(): string {
  tmp = createTempDir('record-seat-test');
  return tmp;
}

function configFile(projectDir: string): string {
  return join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
}

function revisionOf(projectDir: string): string {
  const revision = readConfigDocument(projectDir).revision?.rawSha256;
  if (revision === undefined) throw new Error('expected a config revision');
  return revision;
}

describe('recordSeatOfRecord', () => {
  afterEach(() => {
    if (tmp !== '') cleanupTempDir(tmp);
    tmp = '';
  });

  it('writes only the named seat, keeping the other seats and the file comment', async () => {
    const projectDir = newProject();
    writeConfig(
      projectDir,
      makeConfig({
        planner: { kind: 'cli', tool: 'codex' },
        implementer: { kind: 'cli', tool: 'codex' },
        reviewer: { kind: 'cli', tool: 'codex' },
      }),
    );
    writeFileSync(
      configFile(projectDir),
      `# the crew of record\n${readFileSync(configFile(projectDir), 'utf8')}`,
    );
    const planner = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }).planner;

    const result = await recordSeatOfRecord(
      projectDir,
      { seat: 'plan' },
      planner,
      revisionOf(projectDir),
    );

    expect(result).toBe('saved');
    const yaml = readFileSync(configFile(projectDir), 'utf8');
    expect(yaml).toContain('# the crew of record');
    const parsed = YAML.parse(yaml);
    expect(parsed.planner).toEqual({ kind: 'cli', tool: 'claude-code' });
    expect(parsed.implementer).toEqual({ kind: 'cli', tool: 'codex' });
    expect(parsed.reviewer).toEqual({ kind: 'cli', tool: 'codex' });
  });

  it('writes the named implementer profile and leaves the rest of the table', async () => {
    const projectDir = newProject();
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'codex' },
      implementerProfiles: {
        default: 'fast',
        profiles: {
          fast: { kind: 'cli', tool: 'codex' },
          slow: { kind: 'cli', tool: 'opencode' },
        },
      },
    });
    writeConfig(projectDir, config);
    const switched = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } }).implementer;

    const result = await recordSeatOfRecord(
      projectDir,
      { seat: 'build', profile: 'slow' },
      switched,
      revisionOf(projectDir),
    );

    expect(result).toBe('saved');
    const parsed = YAML.parse(readFileSync(configFile(projectDir), 'utf8'));
    expect(parsed.implementer_profiles.profiles.slow).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
    });
    expect(parsed.implementer_profiles.profiles.fast).toMatchObject({
      kind: 'cli',
      tool: 'codex',
    });
  });

  it('keeps the declared fallback the new runner does not carry', async () => {
    const projectDir = newProject();
    writeConfig(
      projectDir,
      makeConfig({
        implementer: {
          kind: 'cli',
          tool: 'codex',
          fallback: { tool: 'opencode' },
        },
      }),
    );
    const switched = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } }).implementer;

    const result = await recordSeatOfRecord(
      projectDir,
      { seat: 'build' },
      switched,
      revisionOf(projectDir),
    );

    expect(result).toBe('saved');
    const parsed = YAML.parse(readFileSync(configFile(projectDir), 'utf8'));
    expect(parsed.implementer).toEqual({
      kind: 'cli',
      tool: 'claude-code',
      fallback: { tool: 'opencode' },
    });
  });

  it('writes the planner when a review seat has no reviewer block of its own', async () => {
    const projectDir = newProject();
    writeConfig(projectDir, makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));
    const switched = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }).planner;

    const result = await recordSeatOfRecord(
      projectDir,
      { seat: 'review' },
      switched,
      revisionOf(projectDir),
    );

    expect(result).toBe('saved');
    const parsed = YAML.parse(readFileSync(configFile(projectDir), 'utf8'));
    expect(parsed.planner).toEqual({ kind: 'cli', tool: 'claude-code' });
    expect(parsed.reviewer).toBeUndefined();
  });

  it('conflicts on a stale revision and writes nothing', async () => {
    const projectDir = newProject();
    writeConfig(projectDir, makeConfig({ planner: { kind: 'cli', tool: 'codex' } }));
    const staleRevision = revisionOf(projectDir);
    writeFileSync(configFile(projectDir), `${readFileSync(configFile(projectDir), 'utf8')}\n`);
    const before = readFileSync(configFile(projectDir), 'utf8');
    const switched = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }).planner;

    const result = await recordSeatOfRecord(projectDir, { seat: 'plan' }, switched, staleRevision);

    expect(result).toBe('conflict');
    expect(readFileSync(configFile(projectDir), 'utf8')).toBe(before);
  });
});
