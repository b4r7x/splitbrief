import { describe, it, expect } from 'vitest';
import { ConfigSchema } from './config.js';
import { createDefaultConfig } from '../config/load/load.js';

const validConfig = createDefaultConfig();

describe('ConfigSchema palette extension', () => {
  it('parses config without palette field', () => {
    const result = ConfigSchema.parse(validConfig);
    expect(result.palette).toBeUndefined();
  });

  it('parses config with palette.customActions', () => {
    const result = ConfigSchema.parse({
      ...validConfig,
      palette: {
        customActions: [{ id: 'x', label: 'X', command: '/help' }],
      },
    });
    expect(result.palette?.customActions?.[0]?.command).toBe('/help');
  });

  it('throws when id is empty string', () => {
    expect(() =>
      ConfigSchema.parse({
        ...validConfig,
        palette: {
          customActions: [{ id: '', label: 'X', command: '/help' }],
        },
      })
    ).toThrow();
  });

  it('throws when command does not start with /', () => {
    expect(() =>
      ConfigSchema.parse({
        ...validConfig,
        palette: {
          customActions: [{ id: 'x', label: 'X', command: 'no-slash' }],
        },
      })
    ).toThrow();
  });

  it('inferred type: command is string', () => {
    const result = ConfigSchema.parse({
      ...validConfig,
      palette: {
        customActions: [{ id: 'x', label: 'X', command: '/help' }],
      },
    });
    const command: string | undefined = result.palette?.customActions?.[0]?.command;
    expect(typeof command).toBe('string');
  });
});

describe('ConfigSchema approval extension', () => {
  it('parses minimal config without approval field', () => {
    const result = ConfigSchema.parse(validConfig);
    expect(result.approval).toBeUndefined();
  });

  it('parses approval: { enabled: true } with defaults', () => {
    const result = ConfigSchema.parse({ ...validConfig, approval: { enabled: true } });
    expect(result.approval?.enabled).toBe(true);
    expect(result.approval?.feedRejectionsToPlanner).toBe(true);
  });

  it('preserves approval.enabled: false', () => {
    const result = ConfigSchema.parse({ ...validConfig, approval: { enabled: false } });
    expect(result.approval?.enabled).toBe(false);
  });

  it('parses approval.tiers with write_out_of_scope confirm override', () => {
    const result = ConfigSchema.parse({
      ...validConfig,
      approval: { tiers: { write_out_of_scope: 'confirm' } },
    });
    expect(result.approval?.tiers?.write_out_of_scope).toBe('confirm');
  });

  it('preserves approval.headless: true', () => {
    const result = ConfigSchema.parse({ ...validConfig, approval: { headless: true } });
    expect(result.approval?.headless).toBe(true);
  });

  it('preserves approval.feedRejectionsToPlanner: false', () => {
    const result = ConfigSchema.parse({
      ...validConfig,
      approval: { feedRejectionsToPlanner: false },
    });
    expect(result.approval?.feedRejectionsToPlanner).toBe(false);
  });

  it('throws on invalid tier string in tiers map', () => {
    expect(() =>
      ConfigSchema.parse({
        ...validConfig,
        approval: { tiers: { read: 'invalid_tier' } },
      })
    ).toThrow();
  });
});
