import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFunctionContext } from '../src/orchestrator/context-extractor.js';

describe('extractFunctionContext', () => {
  it('extracts export function by name', () => {
    const file = [
      'import { join } from "node:path";',
      '',
      'export function foo() {',
      '  return join("/tmp", "test");',
      '}',
      '',
      'export function other() {',
      '  return 1;',
      '}',
    ].join('\n');

    const result = extractFunctionContext(file, 'foo', 0);
    assert(result !== null);
    assert(result.targetFunction.includes('export function foo()'));
    assert(result.imports.includes('import { join }'));
    assert(result.otherExports.includes('other'));
  });

  it('extracts export const arrow function by name', () => {
    const file = [
      'import fs from "node:fs";',
      '',
      'export const bar = () => {',
      '  return fs.readFileSync("/tmp/x", "utf-8");',
      '};',
      '',
      'export function unrelated() {}',
    ].join('\n');

    const result = extractFunctionContext(file, 'bar', 0);
    assert(result !== null);
    assert(result.targetFunction.includes('export const bar'));
  });

  it('extracts export async function by name', () => {
    const file = [
      'import { readFile } from "node:fs/promises";',
      '',
      'export async function baz() {',
      '  return await readFile("/tmp/x", "utf-8");',
      '}',
    ].join('\n');

    const result = extractFunctionContext(file, 'baz', 0);
    assert(result !== null);
    assert(result.targetFunction.includes('export async function baz'));
  });

  it('extracts export interface by name', () => {
    const file = [
      'export interface Config {',
      '  name: string;',
      '  value: number;',
      '}',
      '',
      'export function create(): Config {',
      '  return { name: "a", value: 1 };',
      '}',
    ].join('\n');

    const result = extractFunctionContext(file, 'Config', 0);
    assert(result !== null);
    assert(result.targetFunction.includes('export interface Config'));
    assert(result.otherExports.includes('create'));
  });

  it('extracts export type by name', () => {
    const file = [
      'export type Status = "active" | "inactive";',
      '',
      'export function getStatus(): Status {',
      '  return "active";',
      '}',
    ].join('\n');

    const result = extractFunctionContext(file, 'Status', 0);
    assert(result !== null);
    assert(result.targetFunction.includes('export type Status'));
  });

  it('extracts export class by name', () => {
    const file = [
      'export class MyClass {',
      '  name: string;',
      '  constructor(name: string) {',
      '    this.name = name;',
      '  }',
      '}',
      '',
      'export function helper() {}',
    ].join('\n');

    const result = extractFunctionContext(file, 'MyClass', 0);
    assert(result !== null);
    assert(result.targetFunction.includes('export class MyClass'));
    assert(result.otherExports.includes('helper'));
  });

  it('returns import lines in imports field', () => {
    const file = [
      'import { join } from "node:path";',
      'import fs from "node:fs";',
      '',
      'export function doStuff() {',
      '  return join(fs.realpathSync("."), "out");',
      '}',
    ].join('\n');

    const result = extractFunctionContext(file, 'doStuff', 0);
    assert(result !== null);
    assert(result.imports.includes('import { join } from "node:path"'));
    assert(result.imports.includes('import fs from "node:fs"'));
  });

  it('returns null when function name is not found', () => {
    const file = [
      'export function existing() {',
      '  return 1;',
      '}',
    ].join('\n');

    const result = extractFunctionContext(file, 'nonExistent', 0);
    assert.equal(result, null);
  });

  it('includes surrounding lines before and after the target function', () => {
    const file = [
      'import { x } from "./x.js";',
      '',
      '// helper comment',
      'const internal = 42;',
      '',
      'export function first() {',
      '  return internal;',
      '}',
      '',
      '// some note',
      '',
      'export function second() {',
      '  return x;',
      '}',
    ].join('\n');

    const result = extractFunctionContext(file, 'second', 3);
    assert(result !== null);
    // Should include 3 lines before `export function second()` (line index 11)
    // That means lines 8,9,10 should be included (the empty line, "// some note", empty line)
    assert(result.targetFunction.includes('// some note'));
  });

  it('returns names of all other exports', () => {
    const file = [
      'export function alpha() {}',
      '',
      'export const beta = 1;',
      '',
      'export interface Gamma {}',
      '',
      'export type Delta = string;',
      '',
      'export class Epsilon {}',
    ].join('\n');

    const result = extractFunctionContext(file, 'beta', 0);
    assert(result !== null);
    assert.deepEqual(result.otherExports.sort(), ['Delta', 'Epsilon', 'Gamma', 'alpha'].sort());
  });

  it('does not treat re-export as a boundary', () => {
    const file = [
      'export function realExport() {',
      '  return 1;',
      '}',
      '',
      'export { name } from "./other.js";',
      '',
      'export function another() {',
      '  return 2;',
      '}',
    ].join('\n');

    // `export { name }` should NOT split realExport's block
    // The boundaries should be realExport (line 0) and another (line 6)
    const result = extractFunctionContext(file, 'realExport', 0);
    assert(result !== null);
    // realExport's block goes from line 0 to line 6 (next boundary)
    // So the re-export line should be included in realExport's block
    assert(result.targetFunction.includes('export { name }'));
  });

  it('uses word boundary matching and does not match partial names', () => {
    const file = [
      'export function fooBar() {',
      '  return 1;',
      '}',
      '',
      'export function foo() {',
      '  return 2;',
      '}',
    ].join('\n');

    const result = extractFunctionContext(file, 'foo', 0);
    assert(result !== null);
    assert(result.targetFunction.includes('export function foo()'));
    assert(!result.targetFunction.includes('export function fooBar()'));
    assert(result.otherExports.includes('fooBar'));
  });
});
