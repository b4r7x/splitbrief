export function mountCopy(root: HTMLElement) {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-copy]')];
  const status = root.querySelector<HTMLElement>('.copy-status');
  const abort = new AbortController();
  const labels = new Map(buttons.map((button) => [button, button.textContent]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request = 0;

  function restore() {
    for (const button of buttons) button.textContent = labels.get(button) ?? '[ copy ]';
    if (status) status.textContent = '';
  }

  for (const button of buttons) {
    button.addEventListener(
      'click',
      async () => {
        const source = root.querySelector<HTMLElement>(`#${button.dataset.copy}-command`);
        if (!source) return;
        const current = ++request;
        clearTimeout(timer);
        restore();
        try {
          if (!navigator.clipboard) throw new Error('Clipboard is unavailable');
          await navigator.clipboard.writeText(source.textContent ?? '');
          if (abort.signal.aborted || current !== request) return;
          button.textContent = '[ copied ]';
          if (status) status.textContent = 'Commands copied.';
        } catch {
          if (abort.signal.aborted || current !== request) return;
          if (status) status.textContent = 'Select and copy the commands above.';
        }
        timer = setTimeout(restore, 2400);
      },
      { signal: abort.signal },
    );
  }

  return () => {
    abort.abort();
    request++;
    clearTimeout(timer);
    restore();
  };
}
