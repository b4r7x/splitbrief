import { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderThroughFilteredStdin } from '#testing/helpers/filtered-stdin-harness.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createStore } from '../../stores/create.js';
import { completionStore } from '../../stores/ui/completion.js';

const mounted: Array<() => void> = [];

beforeEach(resetAllStores);

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.restoreAllMocks();
});

function mount(element: React.ReactElement) {
  const ui = renderThroughFilteredStdin(element);
  mounted.push(ui.unmount);
  return ui;
}

/** Each key logs the text and the store value that its handler reads, then adds its letter. */
function Keys({ log }: { log: string[] }) {
  const [typed, setTyped] = useState('');
  const open = completionStore.use((s) => s.open);
  useEffect(() => {
    completionStore.setOpen(typed.endsWith('/'));
  }, [typed]);
  useInput((input) => {
    log.push(`${JSON.stringify(input)} typed=${typed} open=${open}`);
    setTyped(typed + input);
  });
  return <Text>{typed}</Text>;
}

it('gives each key of one read the text that the key before it typed', async () => {
  const log: string[] = [];
  const ui = mount(<Keys log={log} />);
  await ui.settled();

  ui.pressBytes('a\x1b[Ab');
  await ui.settled();

  expect(log).toEqual(['"a" typed= open=false', '"" typed=a open=false', '"b" typed=a open=false']);
});

it('gives the next key of one read the store value that an effect of the key before it wrote', async () => {
  const log: string[] = [];
  const ui = mount(<Keys log={log} />);
  await ui.settled();

  ui.pressBytes('/\x1b[Ax');
  await ui.settled();

  expect(log).toEqual(['"/" typed= open=false', '"" typed=/ open=true', '"x" typed=/ open=true']);
});

/** A key sets `typed`, an effect of `typed` sets `derived`, and an effect of `derived` sets `second`. */
function Derived({ log }: { log: string[] }) {
  const [typed, setTyped] = useState('');
  const [derived, setDerived] = useState('');
  const [second, setSecond] = useState('');
  useEffect(() => setDerived(typed.toUpperCase()), [typed]);
  useEffect(() => setSecond(derived.repeat(2)), [derived]);
  useInput((input) => {
    log.push(`${JSON.stringify(input)} derived=${derived} second=${second}`);
    setTyped(typed + input);
  });
  return <Text>{second}</Text>;
}

it('gives the next key of one read the state that each effect of the key before it set', async () => {
  const log: string[] = [];
  const ui = mount(<Derived log={log} />);
  await ui.settled();

  ui.pressBytes('a\x1b[A');
  await ui.settled();

  expect(log).toEqual(['"a" derived= second=', '"" derived=A second=AA']);
});

const offset = createStore(0);

/** Each key writes a store, and an effect of the store value sets state: the run screen's label. */
function Labelled() {
  const lines = offset.use((value) => value);
  const [label, setLabel] = useState('');
  useEffect(() => setLabel(`${lines} lines above`), [lines]);
  useInput(() => offset.set((value) => value + 1));
  return <Text>{label}</Text>;
}

it('takes 120 keys of one read whose store write an effect turns into state', async () => {
  offset.reset();
  const ui = mount(<Labelled />);
  await ui.settled();

  ui.pressBytes('\x1b[B'.repeat(120));
  await ui.settled();

  expect(offset.get()).toBe(120);
  expect(ui.lastFrame()).toContain('120 lines above');
});

function Count() {
  const [count, setCount] = useState(0);
  useInput(() => setCount(count + 1));
  return <Text>{`count ${count}`}</Text>;
}

it('takes a held key of 61 repeats one at a time without a chain of nested renders', async () => {
  const errors = vi.spyOn(console, 'error');
  const ui = mount(<Count />);
  await ui.settled();

  ui.pressBytes('\x1b[B'.repeat(61));
  await ui.settled();

  expect(ui.lastFrame()).toContain('count 61');
  expect(errors).not.toHaveBeenCalled();
});
