import { describe, expect, it } from 'vitest';
import { resolveRenderInputConfig } from './input-config.js';

describe('resolveRenderInputConfig', () => {
  it('uses no mouse input in fullscreen when mouse is disabled', () => {
    expect(resolveRenderInputConfig({ fullscreen: true, mouse: false })).toEqual({
      useMouse: false,
      useHover: false,
    });
  });

  it('uses no mouse input outside fullscreen', () => {
    expect(resolveRenderInputConfig({ fullscreen: false, mouse: true })).toEqual({
      useMouse: false,
      useHover: false,
    });
  });

  it('enables hover only when mouse and fullscreen are both active', () => {
    expect(resolveRenderInputConfig({ fullscreen: true, mouse: true, hover: true })).toEqual({
      useMouse: true,
      useHover: true,
    });
    expect(resolveRenderInputConfig({ fullscreen: true, mouse: false, hover: true }).useHover).toBe(
      false,
    );
    expect(resolveRenderInputConfig({ fullscreen: false, mouse: true, hover: true }).useHover).toBe(
      false,
    );
  });
});
