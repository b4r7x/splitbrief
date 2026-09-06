import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mountCopyButton } from './copy-button';

const IDLE = '$ npm install -g splitbrief';
const NOTICE = 'copied to clipboard';

function fakeButton() {
  const idle = { textContent: IDLE, hidden: false };
  const notice = { textContent: '', hidden: true };
  const classes = new Set<string>();
  let onClick: (() => void) | undefined;
  return {
    classList: {
      add: (token: string) => {
        classes.add(token);
      },
      remove: (token: string) => {
        classes.delete(token);
      },
    },
    querySelector: (selector: string) => (selector === '.cta-idle' ? idle : notice),
    addEventListener: (_type: 'click', listener: () => void) => {
      onClick = listener;
    },
    click: () => onClick?.(),
    text: () =>
      [idle, notice]
        .filter((label) => !label.hidden)
        .map((label) => label.textContent)
        .join(' | '),
    flashing: () => classes.has('copied'),
  };
}

function fakeClipboard() {
  const writes: string[] = [];
  return {
    writes,
    writeText: (text: string) => {
      writes.push(text);
      return Promise.resolve();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('a click copies the install command and announces it', async () => {
  const button = fakeButton();
  const clipboard = fakeClipboard();
  mountCopyButton(button, clipboard);

  await button.click();

  expect(clipboard.writes).toEqual(['npm install -g splitbrief']);
  expect(button.text()).toBe(NOTICE);
  expect(button.flashing()).toBe(true);
});

test('the install line returns after 1.6 s', async () => {
  const button = fakeButton();
  mountCopyButton(button, fakeClipboard());

  await button.click();
  vi.advanceTimersByTime(1599);
  expect(button.text()).toBe(NOTICE);

  vi.advanceTimersByTime(1);
  expect(button.text()).toBe(IDLE);
  expect(button.flashing()).toBe(false);
});

test('a second click keeps the notice up for a fresh 1.6 s', async () => {
  const button = fakeButton();
  mountCopyButton(button, fakeClipboard());

  await button.click();
  vi.advanceTimersByTime(1000);
  await button.click();
  vi.advanceTimersByTime(1000);
  expect(button.text()).toBe(NOTICE);

  vi.advanceTimersByTime(600);
  expect(button.text()).toBe(IDLE);
});

test('a refused clipboard says so without flashing, then the install line returns', async () => {
  const button = fakeButton();
  mountCopyButton(button, { writeText: () => Promise.reject(new Error('denied')) });

  await button.click();
  expect(button.text()).toBe('copy failed');
  expect(button.flashing()).toBe(false);

  vi.advanceTimersByTime(1600);
  expect(button.text()).toBe(IDLE);
});
