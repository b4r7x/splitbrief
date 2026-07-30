/// <reference types="@chialab/vitest-axe/matchers" />

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import matchers from '@chialab/vitest-axe';
import { render, screen, within } from '@testing-library/react';
import { run as axe } from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleSection } from './console.js';

expect.extend(matchers);

afterEach(() => {
  vi.restoreAllMocks();
});

const FRAME_PATH = '/frames/workflow-implementation-120x38.svg';
const FRAME_SHA256 = '77d6ff5190cff8e51072da0ec058a5d4240fdbd1fb71541caffd0262b01e9571';
const FRAME_ALT =
  'SPLITBRIEF mid-implementation, 4 minutes 5 seconds in: tasks 1 and 2 of 3 are complete, and task 3 “Detect available Ollama models” is running on Qwen 2.5 Coder 7B via Ollama, which has edited src/engine/detection/service.ts and src/engine/detection/service.test.ts and is running the detection service tests.';
const COST_WHISPER = 'You pay for the thinking once.';

describe('ConsoleSection', () => {
  it('renders the verified workflow capture without rebuilding the terminal', () => {
    render(<ConsoleSection />);

    const section = screen.getByRole('region', { name: 'The console' });
    const frame = within(section).getByRole('img', { name: FRAME_ALT });
    const frameBytes = readFileSync(resolve(process.cwd(), `public${FRAME_PATH}`));

    expect(frame).toHaveAttribute('src', FRAME_PATH);
    expect(frame).toHaveAttribute('width', '960');
    expect(frame).toHaveAttribute('height', '608');
    expect(frame).not.toHaveAttribute('loading');
    expect(createHash('sha256').update(frameBytes).digest('hex')).toBe(FRAME_SHA256);
    expect(section.querySelector('svg, pre')).toBeNull();
  });

  it('renders exactly one cost whisper', () => {
    render(<ConsoleSection />);

    const section = screen.getByRole('region', { name: 'The console' });

    expect(within(section).getAllByText(COST_WHISPER)).toHaveLength(1);
    expect(section.textContent?.split(COST_WHISPER)).toHaveLength(2);
  });

  it('has no automated accessibility violations', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { container } = render(<ConsoleSection />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
