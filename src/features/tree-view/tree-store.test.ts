import { describe, it, expect } from 'vitest';
import {
  createTreeViewState,
  toggleExpanded,
  setFilter,
  selectNode,
  expandAll,
  collapseAll,
} from './tree-store.js';
import { entryId } from '../../core/sessions/tree/schemas.js';

describe('createTreeViewState', () => {
  it('returns default state', () => {
    const state = createTreeViewState();
    expect(state.expandedNodes.size).toBe(0);
    expect(state.filter).toBe('displayable');
    expect(state.selectedNodeId).toBeNull();
    expect(state.scrollOffset).toBe(0);
  });
});

describe('toggleExpanded', () => {
  it('adds node to expanded set when not present', () => {
    const state = createTreeViewState();
    const next = toggleExpanded(state, entryId('E0001'));
    expect(next.expandedNodes.has(entryId('E0001'))).toBe(true);
  });

  it('removes node from expanded set when present', () => {
    let state = createTreeViewState();
    state = toggleExpanded(state, entryId('E0001'));
    const next = toggleExpanded(state, entryId('E0001'));
    expect(next.expandedNodes.has(entryId('E0001'))).toBe(false);
  });

  it('does not mutate original state', () => {
    const state = createTreeViewState();
    const next = toggleExpanded(state, entryId('E0001'));
    expect(state.expandedNodes.has(entryId('E0001'))).toBe(false);
    expect(next.expandedNodes.has(entryId('E0001'))).toBe(true);
  });
});

describe('setFilter', () => {
  it('updates filter value', () => {
    const state = createTreeViewState();
    const next = setFilter(state, 'all');
    expect(next.filter).toBe('all');
  });

  it('preserves other state fields', () => {
    let state = createTreeViewState();
    state = toggleExpanded(state, entryId('E0001'));
    const next = setFilter(state, 'file-state');
    expect(next.expandedNodes.has(entryId('E0001'))).toBe(true);
    expect(next.filter).toBe('file-state');
  });
});

describe('selectNode', () => {
  it('sets selected node id', () => {
    const state = createTreeViewState();
    const next = selectNode(state, entryId('E0002'));
    expect(next.selectedNodeId).toBe(entryId('E0002'));
  });

  it('clears selection when null', () => {
    let state = createTreeViewState();
    state = selectNode(state, entryId('E0002'));
    const next = selectNode(state, null);
    expect(next.selectedNodeId).toBeNull();
  });
});

describe('expandAll', () => {
  it('expands all provided branch node ids', () => {
    const state = createTreeViewState();
    const next = expandAll(state, [entryId('E0001'), entryId('E0002')]);
    expect(next.expandedNodes.has(entryId('E0001'))).toBe(true);
    expect(next.expandedNodes.has(entryId('E0002'))).toBe(true);
  });

  it('replaces existing expanded set', () => {
    let state = createTreeViewState();
    state = toggleExpanded(state, entryId('E0003'));
    const next = expandAll(state, [entryId('E0001')]);
    expect(next.expandedNodes.has(entryId('E0003'))).toBe(false);
    expect(next.expandedNodes.has(entryId('E0001'))).toBe(true);
  });
});

describe('collapseAll', () => {
  it('clears all expanded nodes', () => {
    let state = createTreeViewState();
    state = toggleExpanded(state, entryId('E0001'));
    state = toggleExpanded(state, entryId('E0002'));
    const next = collapseAll(state);
    expect(next.expandedNodes.size).toBe(0);
  });
});
