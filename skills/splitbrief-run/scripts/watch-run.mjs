#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const [sessionArg, cursorArg, secondsArg = '30'] = process.argv.slice(2);
const seconds = Number(secondsArg);
const attention =
  /error|warning|fail|retry|escalat|stall|recovery|paused|input_required|artifact_written|task_completed|task_skipped|workflow_complete|^validate$/u;
const maxLineBytes = 1024 * 1024;

async function watch() {
  if (!sessionArg || !cursorArg || !Number.isFinite(seconds) || seconds < 0 || seconds > 60) {
    throw new Error('Usage: node watch-run.mjs <session-dir> <cursor-file> [seconds: 0..60]');
  }
  const log = resolve(sessionArg, 'session.jsonl');
  const cursorPath = resolve(cursorArg);
  if (cursorPath === log || cursorPath === resolve(sessionArg, 'state.json')) {
    throw new Error('The cursor must not overwrite a run artifact');
  }
  const fd = openSync(log, 'r');
  try {
    const initial = fstatSync(fd);
    const cursor = existsSync(cursorPath)
      ? JSON.parse(readFileSync(cursorPath, 'utf8'))
      : { log, ino: initial.ino, dev: initial.dev, offset: 0 };
    if (
      cursor?.log !== log ||
      cursor.ino !== initial.ino ||
      cursor.dev !== initial.dev ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      cursor.offset > initial.size
    ) {
      throw new Error(
        'Log changed or cursor is invalid; inspect the run before resetting the cursor',
      );
    }
    const deadline = Date.now() + seconds * 1000;
    const buffer = Buffer.alloc(64 * 1024);
    let position = cursor.offset;
    let pending = Buffer.alloc(0);
    let event = null;
    let eventOffset = null;
    let state;

    do {
      const current = fstatSync(fd);
      if (current.size < position) throw new Error('Session log was truncated');
      const pathFd = openSync(log, 'r');
      try {
        const atPath = fstatSync(pathFd);
        if (atPath.ino !== initial.ino || atPath.dev !== initial.dev) {
          throw new Error('Session log was replaced');
        }
      } finally {
        closeSync(pathFd);
      }
      while (position < current.size) {
        const count = readSync(
          fd,
          buffer,
          0,
          Math.min(buffer.length, current.size - position),
          position,
        );
        if (count === 0) throw new Error('Session log changed during read');
        position += count;
        pending = Buffer.concat([pending, buffer.subarray(0, count)]);
        let newline = pending.indexOf(10);
        while (newline !== -1) {
          if (newline > maxLineBytes) throw new Error('Session log entry exceeds 1 MiB');
          const row = JSON.parse(pending.subarray(0, newline).toString('utf8'));
          const offset = cursor.offset;
          cursor.offset += newline + 1;
          pending = pending.subarray(newline + 1);
          const type = row?.type ?? row?.kind;
          if (typeof type !== 'string') throw new Error('Session log entry has no event kind');
          if (attention.test(type)) {
            event = row;
            eventOffset = offset;
            break;
          }
          newline = pending.indexOf(10);
        }
        if (event !== null) break;
        if (pending.length > maxLineBytes) throw new Error('Session log entry exceeds 1 MiB');
        if (Date.now() >= deadline) break;
      }
      state = JSON.parse(readFileSync(join(sessionArg, 'state.json'), 'utf8'));
      if (typeof state?.phase !== 'string' || !Array.isArray(state.tasks)) {
        throw new Error('Run state has no phase or task list');
      }
      if (event !== null || state.pendingRecovery || Date.now() >= deadline) break;
      await setTimeout(Math.min(1000, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);

    const summary = {
      status: event !== null ? 'event' : state.pendingRecovery ? 'recovery' : 'tick',
      eventOffset,
      event:
        event === null
          ? null
          : {
              type: event.type ?? event.kind,
              ts: event.ts,
              phase: event.phase,
              taskId: event.taskId,
              detail: JSON.stringify(event.data ?? event).slice(0, 2000),
            },
      phase: state.phase,
      recovery: state.pendingRecovery?.reason ?? null,
      tasks: state.tasks.map(({ id, status }) => ({ id, status })),
      incompleteLogLine: pending.length > 0 && event === null,
    };
    writeFileSync(cursorPath, JSON.stringify(cursor) + '\n');
    process.stdout.write(JSON.stringify(summary) + '\n');
  } finally {
    closeSync(fd);
  }
}

try {
  await watch();
} catch (error) {
  process.stderr.write(
    `watcher-error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
