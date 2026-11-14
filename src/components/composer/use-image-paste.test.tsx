import { Text } from 'ink';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type {
  ClipboardImageResult,
  readClipboardImage,
} from '../../core/attachments/clipboard-image.js';
import { useImagePaste } from './use-image-paste.js';

type ImagePasteQueue = ReturnType<typeof useImagePaste>;

interface HarnessProps {
  read: typeof readClipboardImage;
  attached: Array<{ path: string; at: number }>;
  expose: (queue: ImagePasteQueue) => void;
}

// The composer's attach starts a new input epoch, as each insert into the draft does.
function Harness({ read, attached, expose }: HarnessProps) {
  const [inputEpoch, setInputEpoch] = useState(0);
  const caretRef = useRef(0);
  expose(
    useImagePaste({
      readClipboardImage: read,
      inputEpoch,
      mode: 'normal',
      questionEpoch: undefined,
      disabled: false,
      commandsOnly: false,
      caretRef,
      canAttachImage: () => true,
      attachImage: (path, at) => {
        attached.push({ path, at });
        setInputEpoch((epoch) => epoch + 1);
        return 1;
      },
      insertText: (text) => {
        setInputEpoch((epoch) => epoch + 1);
        return text.length;
      },
    }),
  );
  return <Text>{inputEpoch}</Text>;
}

const mounted: Array<() => void> = [];

function mountQueue(results: Array<Promise<ClipboardImageResult>>) {
  const attached: Array<{ path: string; at: number }> = [];
  const signals: AbortSignal[] = [];
  let queue: ImagePasteQueue | null = null;
  const read: typeof readClipboardImage = ({ signal }) => {
    signals.push(signal);
    const result = results[signals.length - 1];
    if (result === undefined) throw new Error('no clipboard read was expected');
    return result;
  };
  const ui = renderFeature(
    <Harness
      read={read}
      attached={attached}
      expose={(next) => {
        queue = next;
      }}
    />,
  );
  mounted.push(ui.unmount);
  return {
    attached,
    signals,
    queue: (): ImagePasteQueue => {
      if (queue === null) throw new Error('the harness has not rendered');
      return queue;
    },
  };
}

describe('useImagePaste', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    for (const unmount of mounted.splice(0)) unmount();
  });

  it('keeps a second paste behind the read of the first and lands both, in order', async () => {
    const first = Promise.withResolvers<ClipboardImageResult>();
    const second = Promise.withResolvers<ClipboardImageResult>();
    const paste = mountQueue([first.promise, second.promise]);
    await flushEffects();

    paste.queue().enqueue(0);
    await flushEffects();
    paste.queue().enqueue(3);
    await flushEffects();
    expect(paste.signals).toHaveLength(1);
    expect(paste.signals[0]?.aborted).toBe(false);

    first.resolve({ ok: true, path: 'first.png' });
    await vi.waitFor(() => expect(paste.signals).toHaveLength(2));
    expect(paste.attached).toEqual([{ path: 'first.png', at: 0 }]);

    second.resolve({ ok: true, path: 'second.png' });
    await vi.waitFor(() => expect(paste.attached).toHaveLength(2));
    // The first image took one place in front of the second paste, so the second lands after it.
    expect(paste.attached).toEqual([
      { path: 'first.png', at: 0 },
      { path: 'second.png', at: 4 },
    ]);
  });

  it('moves a queued paste with an edit in front of it', async () => {
    const read = Promise.withResolvers<ClipboardImageResult>();
    const paste = mountQueue([read.promise]);
    await flushEffects();

    paste.queue().enqueue(5);
    await flushEffects();
    paste.queue().followEdit({ start: 1, end: 3, text: 'xyz' });
    read.resolve({ ok: true, path: 'moved.png' });
    await vi.waitFor(() => expect(paste.attached).toHaveLength(1));

    expect(paste.attached).toEqual([{ path: 'moved.png', at: 6 }]);
  });
});
