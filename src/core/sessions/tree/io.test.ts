import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import {
  treeJsonlPath,
  treeMetaPath,
  appendTreeEntry,
  writeTreeMeta,
  readTreeMeta,
  readTreeEntries,
  reconstructTree,
  persistAppend,
} from './io.js';
import { entryId } from './schemas.js';
import { createEmptyTree, appendEntry, branchFrom } from './store.js';

describe('treeJsonlPath', () => {
  it('returns the correct jsonl file path', () => {
    expect(treeJsonlPath('/tmp/session')).toBe(join('/tmp/session', 'session-tree.jsonl'));
  });
});

describe('treeMetaPath', () => {
  it('returns the correct meta file path', () => {
    expect(treeMetaPath('/tmp/session')).toBe(join('/tmp/session', 'tree-meta.json'));
  });
});

describe('appendTreeEntry', () => {
  it('creates the file and writes an entry', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      const entry = {
        id: entryId('E0001'),
        parentId: null,
        type: 'session-start',
        timestamp: 1000,
        payload: null,
        display: true,
      };
      appendTreeEntry(dir, entry);

      const path = treeJsonlPath(dir);
      expect(existsSync(path)).toBe(true);
      const lines = readFileSync(path, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({
        id: 'E0001',
        parentId: null,
        type: 'session-start',
        timestamp: 1000,
        payload: null,
        display: true,
      });
    });
  });

  it('appends multiple entries', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      const entry1 = {
        id: entryId('E0001'),
        parentId: null,
        type: 'session-start',
        timestamp: 1000,
        payload: null,
      };
      const entry2 = {
        id: entryId('E0002'),
        parentId: entryId('E0001'),
        type: 'message',
        timestamp: 2000,
        payload: { text: 'hi' },
      };
      appendTreeEntry(dir, entry1);
      appendTreeEntry(dir, entry2);

      const lines = readFileSync(treeJsonlPath(dir), 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
    });
  });
});

describe('writeTreeMeta', () => {
  it('writes meta to the meta file', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      const meta = {
        leafId: entryId('E0002'),
        entryCount: 2,
        branchCount: 0,
        createdAt: 1000,
        updatedAt: 2000,
      };
      writeTreeMeta(dir, meta);

      const path = treeMetaPath(dir);
      expect(existsSync(path)).toBe(true);
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      expect(raw.leafId).toBe('E0002');
      expect(raw.entryCount).toBe(2);
    });
  });
});

describe('readTreeMeta', () => {
  it('returns null when meta file does not exist', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      expect(readTreeMeta(dir)).toBeNull();
    });
  });

  it('reads and parses valid meta', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      const meta = {
        leafId: entryId('E0002'),
        entryCount: 2,
        branchCount: 0,
        createdAt: 1000,
        updatedAt: 2000,
      };
      writeTreeMeta(dir, meta);

      const result = readTreeMeta(dir);
      expect(result).not.toBeNull();
      expect(result!.leafId).toBe(entryId('E0002'));
      expect(result!.entryCount).toBe(2);
    });
  });

  it('returns null for invalid JSON', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      const path = treeMetaPath(dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, 'not json');
      expect(readTreeMeta(dir)).toBeNull();
    });
  });

  it('returns null for JSON that fails schema validation', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      const path = treeMetaPath(dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify({ leafId: 'E0001', entryCount: -1, branchCount: 0, createdAt: 1, updatedAt: 1 }));
      expect(readTreeMeta(dir)).toBeNull();
    });
  });
});

describe('readTreeEntries', () => {
  it('returns empty array when jsonl does not exist', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      expect(readTreeEntries(dir)).toEqual([]);
    });
  });

  it('reads and parses valid entries', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      const entry = {
        id: entryId('E0001'),
        parentId: null,
        type: 'session-start',
        timestamp: 1000,
        payload: null,
      };
      appendTreeEntry(dir, entry);

      const entries = readTreeEntries(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe(entryId('E0001'));
    });
  });

  it('skips malformed lines', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        treeJsonlPath(dir),
        '{"id":"E0001","parentId":null,"type":"start","timestamp":1000,"payload":null}\nnot valid json\n{"id":"E0002","parentId":"E0001","type":"msg","timestamp":2000,"payload":null}\n',
      );

      const entries = readTreeEntries(dir);
      expect(entries).toHaveLength(2);
      expect(entries[0]!.id).toBe(entryId('E0001'));
      expect(entries[1]!.id).toBe(entryId('E0002'));
    });
  });

  it('skips lines that fail schema validation', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        treeJsonlPath(dir),
        '{"id":"E0001","parentId":null,"type":"start","timestamp":1000,"payload":null}\n{"id":"E0002","timestamp":2000}\n',
      );

      const entries = readTreeEntries(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe(entryId('E0001'));
    });
  });
});

describe('reconstructTree', () => {
  it('returns null when no entries exist', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      expect(reconstructTree(dir)).toBeNull();
    });
  });

  it('reconstructs a linear tree from jsonl only', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      const tree = createEmptyTree(1000);
      const r1 = appendEntry(tree, { type: 'a', payload: {}, timestamp: 2000 });

      appendTreeEntry(dir, tree.entries.get(entryId('E0001'))!);
      appendTreeEntry(dir, r1.entry);

      const reconstructed = reconstructTree(dir);
      expect(reconstructed).not.toBeNull();
      expect(reconstructed!.entries.size).toBe(2);
      expect(reconstructed!.meta.entryCount).toBe(2);
      expect(reconstructed!.meta.leafId).toBe(entryId('E0002'));
    });
  });

  it('reconstructs with meta file when present', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      const tree = createEmptyTree(1000);
      const r1 = appendEntry(tree, { type: 'a', payload: {}, timestamp: 2000 });

      appendTreeEntry(dir, tree.entries.get(entryId('E0001'))!);
      appendTreeEntry(dir, r1.entry);
      writeTreeMeta(dir, r1.tree.meta);

      const reconstructed = reconstructTree(dir);
      expect(reconstructed).not.toBeNull();
      expect(reconstructed!.meta.leafId).toBe(r1.tree.meta.leafId);
      expect(reconstructed!.meta.entryCount).toBe(r1.tree.meta.entryCount);
    });
  });

  it('counts branches correctly', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      const tree = createEmptyTree(1000);
      const r1 = branchFrom(tree, { fromId: entryId('E0001'), type: 'fork1', payload: {}, timestamp: 2000 });
      const r2 = branchFrom(r1.tree, { fromId: entryId('E0001'), type: 'fork2', payload: {}, timestamp: 3000 });

      for (const [, entry] of r2.tree.entries) {
        appendTreeEntry(dir, entry);
      }

      const reconstructed = reconstructTree(dir);
      expect(reconstructed).not.toBeNull();
      expect(reconstructed!.meta.branchCount).toBe(1);
    });
  });

  it('falls back to last entry when meta leafId is missing from jsonl', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        treeJsonlPath(dir),
        '{"id":"E0001","parentId":null,"type":"start","timestamp":1000,"payload":null}\n{"id":"E0002","parentId":"E0001","type":"msg","timestamp":2000,"payload":null}\n',
      );
      writeTreeMeta(dir, {
        leafId: entryId('E9999'),
        entryCount: 2,
        branchCount: 0,
        createdAt: 1000,
        updatedAt: 2000,
      });

      const reconstructed = reconstructTree(dir);
      expect(reconstructed).not.toBeNull();
      expect(reconstructed!.meta.leafId).toBe(entryId('E0002'));
      expect(reconstructed!.meta.entryCount).toBe(2);
    });
  });

  it('derives entryCount from max ID when meta is missing and lines were skipped', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        treeJsonlPath(dir),
        '{"id":"E0001","parentId":null,"type":"start","timestamp":1000,"payload":null}\nmalformed line\n{"id":"E0003","parentId":"E0001","type":"msg","timestamp":2000,"payload":null}\n',
      );

      const reconstructed = reconstructTree(dir);
      expect(reconstructed).not.toBeNull();
      expect(reconstructed!.meta.entryCount).toBe(3);
      expect(reconstructed!.meta.leafId).toBe(entryId('E0003'));
    });
  });
});

describe('persistAppend', () => {
  it('writes entry and meta atomically', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      const tree = createEmptyTree(1000);
      const r1 = appendEntry(tree, { type: 'a', payload: {}, timestamp: 2000 });

      persistAppend(dir, r1.entry, r1.tree.meta);

      expect(readTreeEntries(dir)).toHaveLength(1);
      const meta = readTreeMeta(dir);
      expect(meta).not.toBeNull();
      expect(meta!.leafId).toBe(entryId('E0002'));
    });
  });
});

describe('persistAppend (branch)', () => {
  it('writes entry and meta atomically for branches', async () => {
    await withTempDir('tree-io-test', async (dir) => {
      const tree = createEmptyTree(1000);
      const r1 = branchFrom(tree, { fromId: entryId('E0001'), type: 'fork', payload: {}, timestamp: 2000 });

      persistAppend(dir, r1.entry, r1.tree.meta);

      expect(readTreeEntries(dir)).toHaveLength(1);
      const meta = readTreeMeta(dir);
      expect(meta).not.toBeNull();
      expect(meta!.branchCount).toBe(1);
    });
  });
});
