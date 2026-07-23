import { describe, expect, it } from 'vitest';
import { resolveRenderInputConfig } from './input-config.js';

describe('resolveRenderInputConfig', () => {
  it('uses filtered paste input in fullscreen even when mouse is disabled', () => {
    expect(resolveRenderInputConfig({ fullscreen: true, mouse: false })).toEqual({
      useFilteredStdin: true,
      useMouse: false,
      useHover: false,
      usePaste: true,
    });
  });

  it('does not use terminal input filtering outside fullscreen', () => {
    expect(resolveRenderInputConfig({ fullscreen: false, mouse: true })).toEqual({
      useFilteredStdin: false,
      useMouse: false,
      useHover: false,
      usePaste: false,
    });
  });

  it('enables hover only when mouse and fullscreen are both active', () => {
    expect(resolveRenderInputConfig({ fullscreen: true, mouse: true, hover: true })).toEqual({
      useFilteredStdin: true,
      useMouse: true,
      useHover: true,
      usePaste: true,
    });
    expect(resolveRenderInputConfig({ fullscreen: true, mouse: false, hover: true }).useHover).toBe(
      false,
    );
    expect(resolveRenderInputConfig({ fullscreen: false, mouse: true, hover: true }).useHover).toBe(
      false,
    );
  });
});
