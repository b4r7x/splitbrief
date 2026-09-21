#!/usr/bin/env node

import { readFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const [engine, artifact, recording] = process.argv.slice(2);
const marker = 'COPY-ME-ASCII-Alpha 123';

if (engine === 'ghostty') {
  runGhostty(resolve(artifact ?? ''));
} else if (engine === 'kitty') {
  runKitty(resolve(artifact ?? ''));
} else {
  throw new Error(
    'usage: terminal-engine-compat.mjs ghostty /path/to/ghostty-vt.wasm [recording.ansi] | kitty /path/to/kitty [recording.ansi]',
  );
}

function fail(message) {
  throw new Error(message);
}

function check(name, result) {
  if (result !== 0) fail(`${name} returned ${result}`);
}

function runGhostty(wasmPath) {
  const bytes = readFileSync(wasmPath);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  const e = instance.exports;
  const decoder = new TextDecoder();

  const alloc = (length) => {
    const pointer = e.ghostty_wasm_alloc(length);
    if (!pointer) fail(`Ghostty allocation failed for ${length} bytes`);
    return pointer;
  };
  const view = () => new Uint8Array(e.memory.buffer);
  const dataView = () => new DataView(e.memory.buffer);
  const opaque = (create) => {
    const slot = e.ghostty_wasm_alloc_opaque();
    if (!slot) fail('Ghostty opaque allocation failed');
    check('opaque constructor', create(slot));
    const handle = e.ghostty_wasm_take_opaque(slot);
    e.ghostty_wasm_free_opaque(slot);
    if (!handle) fail('Ghostty constructor returned a null handle');
    return handle;
  };
  const write = (bytesToWrite) => {
    const pointer = alloc(bytesToWrite.length);
    view().set(bytesToWrite, pointer);
    return pointer;
  };
  const readAllocatedText = (pointerSlot, lengthSlot) => {
    const pointer = dataView().getUint32(pointerSlot, true);
    const length = dataView().getUint32(lengthSlot, true);
    const text = decoder.decode(view().slice(pointer, pointer + length));
    e.ghostty_free(0, pointer, length);
    return text;
  };
  const formatSelection = (terminal, selectionPointer) => {
    const options = alloc(16);
    const d = dataView();
    d.setUint32(options, 16, true);
    d.setUint32(options + 4, 0, true);
    d.setUint8(options + 8, 0);
    d.setUint8(options + 9, 1);
    d.setUint32(options + 12, selectionPointer, true);
    const outputPointer = alloc(4);
    const outputLength = alloc(4);
    check(
      'Ghostty selection formatting',
      e.ghostty_terminal_selection_format_alloc(terminal, 0, options, outputPointer, outputLength),
    );
    return readAllocatedText(outputPointer, outputLength);
  };

  const terminalSlot = e.ghostty_wasm_alloc_opaque();
  check('Ghostty terminal creation', e.ghostty_terminal_new(0, terminalSlot, 120, 32));
  const terminal = e.ghostty_wasm_take_opaque(terminalSlot);
  e.ghostty_wasm_free_opaque(terminalSlot);
  const source = recording
    ? readFileSync(recording, 'utf8')
    : 'GHOSTTY COPY-ME-ASCII\r\nUNICODE λ漢字';
  const expectedText = recording ? marker : source.replaceAll('\r\n', '\n');
  const sourceBytes = new TextEncoder().encode(source);
  const sourcePointer = write(sourceBytes);
  e.ghostty_terminal_vt_write(terminal, sourcePointer, sourceBytes.length);
  e.ghostty_wasm_free(sourcePointer, sourceBytes.length);

  const allSelection = alloc(32);
  dataView().setUint32(allSelection, 32, true);
  check('Ghostty select-all', e.ghostty_terminal_select_all(terminal, allSelection));
  const allText = formatSelection(terminal, allSelection);
  if (recording ? !allText.includes(marker) : allText !== expectedText) {
    fail(`Ghostty select-all mismatch: ${JSON.stringify(allText)}`);
  }
  const selectedRow = recording
    ? allText.split('\n').findIndex((line) => line.includes(marker))
    : 0;
  const selectedColumn = recording ? allText.split('\n')[selectedRow].indexOf(marker) : 0;

  const point = (x, y) => {
    const pointer = alloc(24);
    const d = dataView();
    d.setInt32(pointer, 0, true);
    d.setUint16(pointer + 8, x, true);
    d.setUint32(pointer + 12, y, true);
    return pointer;
  };
  const gridRef = (x, y) => {
    const pointPointer = point(x, y);
    const refPointer = alloc(12);
    check(
      'Ghostty grid reference',
      e.ghostty_terminal_grid_ref(terminal, pointPointer, refPointer),
    );
    return refPointer;
  };

  const gesture = opaque((slot) => e.ghostty_selection_gesture_new(0, slot));
  const press = opaque((slot) => e.ghostty_selection_gesture_event_new(0, slot, 0));
  const pressRef = gridRef(selectedColumn, selectedRow);
  check('Ghostty press ref', e.ghostty_selection_gesture_event_set(press, 0, pressRef));
  if (e.ghostty_selection_gesture_event(gesture, terminal, press, 0) !== -4) {
    fail('Ghostty press unexpectedly produced a selection');
  }

  const drag = opaque((slot) => e.ghostty_selection_gesture_event_new(0, slot, 2));
  const dragRef = recording ? gridRef(selectedColumn + marker.length, selectedRow) : gridRef(12, 1);
  check('Ghostty drag ref', e.ghostty_selection_gesture_event_set(drag, 0, dragRef));
  const geometry = alloc(16);
  const gd = dataView();
  gd.setUint32(geometry, 80, true);
  gd.setUint32(geometry + 4, 10, true);
  gd.setUint32(geometry + 8, 0, true);
  gd.setUint32(geometry + 12, 160, true);
  check('Ghostty drag geometry', e.ghostty_selection_gesture_event_set(drag, 8, geometry));
  const dragSelection = alloc(32);
  check(
    'Ghostty drag gesture',
    e.ghostty_selection_gesture_event(gesture, terminal, drag, dragSelection),
  );
  const dragText = formatSelection(terminal, dragSelection);
  if (dragText !== expectedText) fail(`Ghostty drag mismatch: ${JSON.stringify(dragText)}`);

  e.ghostty_selection_gesture_event_free(press);
  e.ghostty_selection_gesture_event_free(drag);
  e.ghostty_selection_gesture_free(gesture, terminal);
  e.ghostty_terminal_free(terminal);
  console.log(
    JSON.stringify({
      engine: 'ghostty-vt',
      artifact: wasmPath,
      recording: recording ?? null,
      parser: 'passed',
      selectionGesture: 'passed',
      selectedText: dragText,
      nativeCmdC: 'host-surface action; not part of libghostty-vt',
    }),
  );
}

function runKitty(kittyPath) {
  const source = recording
    ? readFileSync(recording)
    : Buffer.from('KITTY COPY-ME-ASCII\r\nUNICODE λ漢字');
  const python = [
    'import json, sys',
    'from kitty.fast_data_types import Screen, encode_key_for_tty, GLFW_MOD_SUPER, GLFW_MOD_CONTROL',
    'screen = Screen(None, 32, 120, 100, 10, 20, 1)',
    'data = sys.stdin.buffer.read()',
    'while data:',
    '    buffer = screen.test_create_write_buffer()',
    '    used = screen.test_commit_write_buffer(data, buffer)',
    '    screen.test_parse_written_data()',
    '    data = data[used:]',
    'lines = []',
    'screen.as_text(lines.append, False, False)',
    'result = {"screen": "".join(lines), "hasSelection": screen.has_selection(), "cmdC": encode_key_for_tty(key=ord("c"), mods=GLFW_MOD_SUPER), "ctrlC": encode_key_for_tty(key=ord("c"), mods=GLFW_MOD_CONTROL)}',
    'print("KITTY_COMPAT_RESULT=" + json.dumps(result), flush=True)',
  ].join('\n');
  const configDirectory = resolve(
    '.test-artifacts/terminal-browser/terminal-compatibility/kitty-config',
  );
  mkdirSync(configDirectory, { recursive: true });
  const result = spawnSync(kittyPath, ['+runpy', python], {
    encoding: 'utf8',
    input: source,
    timeout: 10_000,
    env: { ...process.env, KITTY_CONFIG_DIRECTORY: configDirectory },
  });
  if (result.error) fail(`Kitty probe failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`Kitty probe exited ${result.status}: ${result.stderr.trim()}`);
  }
  const line = result.stdout.split('\n').find((value) => value.startsWith('KITTY_COMPAT_RESULT='));
  if (!line) fail(`Kitty probe returned no result: ${result.stdout}${result.stderr}`);
  const data = JSON.parse(line.slice('KITTY_COMPAT_RESULT='.length));
  const expected = recording
    ? [marker, 'COPY-ME-UNICODE-Zażółć 日本語']
    : ['KITTY COPY-ME-ASCII', 'UNICODE λ漢字'];
  if (!expected.every((value) => data.screen.includes(value))) {
    fail(`Kitty parser output mismatch: ${JSON.stringify(data.screen)}`);
  }
  if (data.hasSelection) fail('Kitty unexpectedly reported a native selection');
  if (data.ctrlC !== '\u0003')
    fail(`Kitty Ctrl+C encoding mismatch: ${JSON.stringify(data.ctrlC)}`);
  if (data.cmdC !== '\u001b[99;9u')
    fail(`Kitty Cmd+C encoding mismatch: ${JSON.stringify(data.cmdC)}`);
  console.log(
    JSON.stringify({
      engine: 'kitty',
      artifact: kittyPath,
      recording: recording ?? null,
      parser: 'passed',
      selectedText: null,
      nativeCmdC: 'host action when selection exists; protocol bytes when passed through',
      cmdCEncoding: data.cmdC,
      ctrlCEncoding: data.ctrlC,
    }),
  );
}
