import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { filterCommands, SlashSuggestions } from '../src/ui/slash-suggestions.js';
import { getTheme } from '../src/theme.js';
import type { SlashCommandDef, Screen } from '../src/types.js';

const theme = getTheme();

const noop = () => {};

const commands: SlashCommandDef[] = [
  { name: '/help', label: 'Help', description: 'Show help', shortcut: 'Ctrl+/', validScreens: ['home', 'workflow', 'summary'], handler: noop },
  { name: '/status', label: 'Status', description: 'Show status', validScreens: ['home', 'workflow', 'summary'], handler: noop },
  { name: '/init', label: 'Configure', description: 'Select planner', validScreens: ['home'], handler: noop },
  { name: '/palette', label: 'Palette', description: 'Open palette', validScreens: ['home', 'workflow', 'summary'], handler: noop },
  { name: '/quit', label: 'Quit', description: 'Exit', shortcut: 'Ctrl+Q', validScreens: ['home', 'workflow', 'summary'], handler: noop },
];

function collectText(el: unknown): string {
  if (el == null || typeof el === 'boolean') return '';
  if (typeof el === 'string' || typeof el === 'number') return String(el);
  if (Array.isArray(el)) return el.map(collectText).join('');
  if (typeof el === 'object' && el !== null && 'props' in el) {
    const props = (el as { props: { children?: unknown } }).props;
    return collectText(props.children);
  }
  return '';
}

describe('filterCommands', () => {
  it('returns all screen-valid commands for bare "/"', () => {
    const result = filterCommands(commands, '/', 'home');
    assert.equal(result.length, 5);
  });

  it('returns all screen-valid commands for empty string', () => {
    const result = filterCommands(commands, '', 'home');
    assert.equal(result.length, 5);
  });

  it('filters by prefix case-insensitively', () => {
    const result = filterCommands(commands, '/he', 'home');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, '/help');
  });

  it('handles uppercase filter', () => {
    const result = filterCommands(commands, '/HE', 'home');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, '/help');
  });

  it('excludes commands not valid for current screen', () => {
    const result = filterCommands(commands, '/', 'workflow');
    const names = result.map(c => c.name);
    assert.ok(!names.includes('/init'));
    assert.equal(result.length, 4);
  });

  it('returns empty when no commands match', () => {
    const result = filterCommands(commands, '/xyz', 'home');
    assert.equal(result.length, 0);
  });

  it('exact match returns single result', () => {
    const result = filterCommands(commands, '/quit', 'home');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, '/quit');
  });
});

describe('SlashSuggestions', () => {
  it('returns null for empty filtered', () => {
    const el = SlashSuggestions({ filtered: [], selectedIndex: 0, theme });
    assert.equal(el, null);
  });

  it('renders all filtered commands', () => {
    const filtered = commands.slice(0, 3);
    const el = SlashSuggestions({ filtered, selectedIndex: 0, theme });
    const text = collectText(el);
    assert.ok(text.includes('/help'));
    assert.ok(text.includes('/status'));
    assert.ok(text.includes('/init'));
  });

  it('shows selection indicator on selected item', () => {
    const filtered = commands.slice(0, 2);
    const el = SlashSuggestions({ filtered, selectedIndex: 0, theme });
    const text = collectText(el);
    assert.ok(text.includes('▸'), 'should have ▸ indicator');
  });

  it('renders keyboard hint footer', () => {
    const filtered = commands.slice(0, 2);
    const el = SlashSuggestions({ filtered, selectedIndex: 0, theme });
    const text = collectText(el);
    assert.ok(text.includes('select'));
    assert.ok(text.includes('Enter'));
    assert.ok(text.includes('Tab'));
    assert.ok(text.includes('Esc'));
  });
});
