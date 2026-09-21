import { describe, expect, it } from 'vitest';
import { envelopeErrorDetail } from './error-envelope.js';

describe('envelopeErrorDetail', () => {
  it('returns a provider diagnosis when present and the caller fallback otherwise', () => {
    expect(
      envelopeErrorDetail(
        { error: { name: ' APIError ', data: { message: ' Rate limit exceeded ' } } },
        'runner error',
      ),
    ).toBe('APIError: Rate limit exceeded');
    expect(
      envelopeErrorDetail({ error: { data: { message: 'Signed out' } } }, 'runner error'),
    ).toBe('Signed out');
    expect(envelopeErrorDetail({ error: { name: 'APIError' } }, 'runner error')).toBe(
      'runner error',
    );
    expect(envelopeErrorDetail({ error: { data: { message: '  ' } } }, 'runner error')).toBe(
      'runner error',
    );
    expect(envelopeErrorDetail({ error: { data: { message: 42 } } }, 'runner error')).toBe(
      'runner error',
    );
  });

  it('reads the flat envelope opencode 2.x emits, typed by `type` instead of `name`', () => {
    // Captured live from `opencode run --standalone --format json` 2.0.12 on 2026-09-21.
    expect(
      envelopeErrorDetail(
        { error: { type: 'provider.quota', message: 'Go usage limit exceeded', status: 429 } },
        'runner error',
      ),
    ).toBe('provider.quota: Go usage limit exceeded');
    expect(envelopeErrorDetail({ error: { message: 'Signed out' } }, 'runner error')).toBe(
      'Signed out',
    );
  });
});
