(() => {
  const root = document.createElement('div');
  root.id = 'terminal';
  document.body.append(root);
  const terminal = new Terminal({
    allowProposedApi: true,
    cols: 120,
    rows: 32,
    scrollback: 200,
    convertEol: false,
    fontFamily: 'monospace',
    fontSize: 14,
    theme: { background: '#101114', foreground: '#f0f0f0' },
  });
  terminal.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
  terminal.unicode.activeVersion = '15-graphemes';
  terminal.open(root);
  terminal.focus();

  let metaCopyKeys = 0;
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.metaKey && event.key.toLowerCase() === 'c') {
        // Exercise the browser key path without allowing a host clipboard command.
        event.preventDefault();
        metaCopyKeys += 1;
      }
    },
    true,
  );
  let lastCopy = '';
  let selectionChanges = 0;
  const textarea = terminal.textarea;
  textarea.addEventListener('copy', (event) => {
    lastCopy = event.clipboardData?.getData('text/plain') ?? '';
  });
  terminal.onSelectionChange(() => {
    selectionChanges += 1;
  });
  terminal.onData((data) => {
    void window.sendPtyInput(data);
  });

  window.__terminalWrite = (data) =>
    new Promise((resolve) => {
      terminal.write(data, resolve);
    });
  window.__terminalText = () => {
    const buffer = terminal.buffer.active;
    const lines = [];
    for (let row = 0; row < buffer.length; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  };
  window.__terminalFind = (prefix) => {
    const buffer = terminal.buffer.active;
    for (let row = 0; row < buffer.length; row += 1) {
      const line = buffer.getLine(row);
      const text = line?.translateToString(true) ?? '';
      const column = text.indexOf(prefix);
      if (column >= 0) {
        return { row, column, length: line?.length ?? text.length, viewportY: buffer.viewportY };
      }
    }
    return null;
  };
  window.__terminalState = () => ({
    metaCopyKeys,
    hasSelection: terminal.hasSelection(),
    selection: terminal.getSelection(),
    selectionChanges,
    viewportY: terminal.buffer.active.viewportY,
    mouseTrackingMode: terminal.modes.mouseTrackingMode,
  });
  window.__terminalCopy = () => {
    lastCopy = '';
    terminal.focus();
    const transfer = new DataTransfer();
    const event = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    textarea.dispatchEvent(event);
    return {
      defaultPrevented: event.defaultPrevented,
      eventText: transfer.getData('text/plain'),
      listenerText: lastCopy,
    };
  };
  window.__terminalHighlighted = (prefix) => {
    const location = window.__terminalFind(prefix);
    return (
      location !== null &&
      Boolean(terminal.buffer.active.getLine(location.row)?.getCell(location.column)?.isInverse())
    );
  };
  window.__terminalExpectedRange = (first, last) => {
    const start = window.__terminalFind(first);
    const end = window.__terminalFind(last);
    const lines = [];
    for (let row = start.row; row <= end.row; row += 1) {
      lines.push(
        terminal.buffer.active
          .getLine(row)
          .translateToString(true, row === start.row ? start.column : 0),
      );
    }
    return lines.join('\n');
  };
  window.__terminalPaste = (text) => {
    terminal.focus();
    const transfer = new DataTransfer();
    transfer.setData('text/plain', text);
    textarea.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
  };
  window.__terminalForwardSuperCopy = () => window.sendPtyInput('\u001b[99;9u');
  window.__terminalFocus = () => terminal.focus();
  window.__terminalClearSelection = () => terminal.clearSelection();
})();
