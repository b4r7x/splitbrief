import { describe, it, expect } from 'vitest';
import { extractFunctionContext } from './scope-extractor.js';

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
    if (!result) throw new Error('expected extractFunctionContext to return a value');
    expect(result.targetFunction).toContain('export function foo()');
    expect(result.imports).toContain('import { join }');
    expect(result.otherExports).toContain('other');
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
    if (!result) throw new Error('expected extractFunctionContext to return a value');
    expect(result.targetFunction).toContain('export const bar');
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
    if (!result) throw new Error('expected extractFunctionContext to return a value');
    expect(result.targetFunction).toContain('export async function baz');
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
    if (!result) throw new Error('expected extractFunctionContext to return a value');
    expect(result.targetFunction).toContain('export interface Config');
    expect(result.otherExports).toContain('create');
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
    if (!result) throw new Error('expected extractFunctionContext to return a value');
    expect(result.targetFunction).toContain('export type Status');
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
    if (!result) throw new Error('expected extractFunctionContext to return a value');
    expect(result.targetFunction).toContain('export class MyClass');
    expect(result.otherExports).toContain('helper');
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
    if (!result) throw new Error('expected extractFunctionContext to return a value');
    expect(result.imports).toContain('import { join } from "node:path"');
    expect(result.imports).toContain('import fs from "node:fs"');
  });

  it('returns null when function name is not found', () => {
    const file = ['export function existing() {', '  return 1;', '}'].join('\n');

    const result = extractFunctionContext(file, 'nonExistent', 0);
    expect(result).toBe(null);
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
    if (!result) throw new Error('expected extractFunctionContext to return a value');
    expect(result.targetFunction).toContain('// some note');
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
    if (!result) throw new Error('expected extractFunctionContext to return a value');
    expect(result.otherExports.sort()).toEqual(['Delta', 'Epsilon', 'Gamma', 'alpha'].sort());
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

    const result = extractFunctionContext(file, 'realExport', 0);
    if (!result) throw new Error('expected extractFunctionContext to return a value');
    expect(result.targetFunction).toContain('export { name }');
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
    if (!result) throw new Error('expected extractFunctionContext to return a value');
    expect(result.targetFunction).toContain('export function foo()');
    expect(result.targetFunction).not.toContain('export function fooBar()');
    expect(result.otherExports).toContain('fooBar');
  });
});
