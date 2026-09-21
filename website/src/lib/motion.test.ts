import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMotion } from './motion.js';
import type { Frame, Scene } from './scene.js';

function createBrowser() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  let now = 0;
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    fonts: { ready: Promise.resolve() },
    documentElement: { toggleAttribute: vi.fn(), removeAttribute: vi.fn() },
  });
  const media = Object.assign(new EventTarget(), { matches: false });
  const button = Object.assign(new EventTarget(), {
    disabled: false,
    textContent: '',
    setAttribute: vi.fn(),
  }) as unknown as HTMLButtonElement;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('matchMedia', () => media);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextId;
    callbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  function advance(milliseconds = 16) {
    now += milliseconds;
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback(now);
  }
  return { callbacks, window, document, media, button, advance };
}

function createScene(order: string[] = []) {
  const frames: Frame[] = [];
  const scene: Scene = {
    measure: vi.fn(() => {
      order.push('measure');
    }),
    readScroll: vi.fn(() => {
      order.push('read');
    }),
    paint: vi.fn((frame) => {
      order.push('paint');
      frames.push(frame);
      return false;
    }),
    destroy: vi.fn(),
  };
  return { scene, frames };
}

describe('motion lifecycle', () => {
  let browser: ReturnType<typeof createBrowser>;
  let motion: ReturnType<typeof createMotion>;

  beforeEach(() => {
    browser = createBrowser();
    motion = createMotion();
  });
  afterEach(() => {
    motion.destroy();
    vi.unstubAllGlobals();
  });

  it('measures all scenes before reading and painting them from one animation frame', async () => {
    const order: string[] = [];
    const first = createScene(order);
    const second = createScene(order);
    const scenes = [first.scene, second.scene];
    motion.start(scenes, [browser.button]);
    motion.start(scenes, [browser.button]);
    await Promise.resolve();
    expect(browser.callbacks.size).toBe(1);
    browser.advance();
    expect(order).toEqual(['measure', 'measure', 'read', 'read', 'paint', 'paint']);
    expect(first.scene.destroy).not.toHaveBeenCalled();
    expect(browser.callbacks.size).toBe(0);
    order.length = 0;
    browser.advance(1000);
    expect(order).toEqual([]);
    browser.window.dispatchEvent(new Event('resize'));
    browser.advance();
    expect(order).toEqual(['measure', 'measure', 'read', 'read', 'paint', 'paint']);
    expect(first.frames.at(-1)?.deltaMs).toBe(16);
  });

  it('pauses the background while still rendering scroll changes', async () => {
    const { scene, frames } = createScene();
    motion.start([scene], [browser.button]);
    await Promise.resolve();
    browser.advance();
    browser.button.dispatchEvent(new Event('click'));
    browser.advance();
    expect(browser.callbacks.size).toBe(0);
    expect(browser.button.textContent).toBe('Resume motion');
    expect(browser.document.documentElement.toggleAttribute).toHaveBeenLastCalledWith(
      'data-motion-paused',
      true,
    );
    browser.window.dispatchEvent(new Event('scroll'));
    browser.advance(3000);
    expect(frames).toHaveLength(3);
    expect(frames.at(-1)?.deltaMs).toBe(16);
    expect(browser.callbacks.size).toBe(0);
    browser.button.dispatchEvent(new Event('click'));
    browser.advance();
    expect(browser.document.documentElement.toggleAttribute).toHaveBeenLastCalledWith(
      'data-motion-paused',
      false,
    );
    expect(browser.callbacks.size).toBe(0);
  });

  it('paints reduced motion once and follows scroll and preference changes', async () => {
    const { scene, frames } = createScene();
    browser.media.matches = true;
    motion.start([scene], [browser.button]);
    await Promise.resolve();
    browser.advance();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.snap).toBe(true);
    expect(browser.button.disabled).toBe(true);
    expect(browser.callbacks.size).toBe(0);
    browser.window.dispatchEvent(new Event('scroll'));
    browser.advance();
    expect(frames).toHaveLength(2);
    expect(browser.callbacks.size).toBe(0);
    browser.media.matches = false;
    browser.media.dispatchEvent(new Event('change'));
    browser.advance();
    expect(frames.at(-1)?.snap).toBe(false);
    expect(browser.button.disabled).toBe(false);
    expect(browser.callbacks.size).toBe(0);
  });

  it('runs frames while a scene settles and sleeps after the final paint', async () => {
    const { scene, frames } = createScene();
    let settling = true;
    const paint = scene.paint;
    scene.paint = (frame) => {
      paint(frame);
      return settling;
    };
    motion.start([scene], []);
    await Promise.resolve();
    browser.advance();
    expect(browser.callbacks.size).toBe(1);
    browser.advance(1000);
    expect(frames.at(-1)?.deltaMs).toBe(48);
    settling = false;
    browser.advance();
    expect(browser.callbacks.size).toBe(0);
    browser.advance(1000);
    expect(frames).toHaveLength(3);
    motion.invalidate();
    browser.advance();
    expect(frames.at(-1)?.deltaMs).toBe(16);
    expect(browser.callbacks.size).toBe(0);
  });

  it('cancels hidden frames and disposes listeners and pending font callbacks', async () => {
    const { scene, frames } = createScene();
    let resolveFonts = () => {};
    browser.document.fonts.ready = new Promise<void>((resolve) => {
      resolveFonts = resolve;
    });
    motion.start([scene], [browser.button]);
    browser.advance();
    motion.invalidate();
    expect(browser.callbacks.size).toBe(1);
    browser.document.hidden = true;
    browser.document.dispatchEvent(new Event('visibilitychange'));
    expect(browser.callbacks.size).toBe(0);
    browser.advance(10000);
    browser.document.hidden = false;
    browser.document.dispatchEvent(new Event('visibilitychange'));
    browser.advance();
    expect(frames.at(-1)?.deltaMs).toBe(16);
    motion.destroy();
    motion.destroy();
    resolveFonts();
    await Promise.resolve();
    browser.window.dispatchEvent(new Event('scroll'));
    browser.window.dispatchEvent(new Event('resize'));
    browser.button.dispatchEvent(new Event('click'));
    browser.media.dispatchEvent(new Event('change'));
    expect(browser.callbacks.size).toBe(0);
    expect(scene.destroy).toHaveBeenCalledTimes(1);
    const next = createScene();
    motion.start([next.scene], [browser.button]);
    browser.advance();
    expect(next.scene.paint).toHaveBeenCalledOnce();
    expect(browser.callbacks.size).toBe(0);
  });
});
