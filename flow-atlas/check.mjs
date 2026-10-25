#!/usr/bin/env node
// Flow Atlas data check. Usage: node flow-atlas/check.mjs [--data <dir>] [--repo <dir>] [--no-render] [--verbose]
// MERMAID_JS=/path/mermaid.min.js injects a local Mermaid build when the CDN is not reachable.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
const EXPECTED = ['journey', 'startup', 'runners', 'planning', 'build', 'review', 'recovery', 'lifecycle', 'ui', 'subsystems', 'structure'];
const ARRAY_FIELDS = ['entry', 'links', 'diagrams', 'decisions', 'config', 'states', 'scenarios', 'files', 'gotchas', 'glossary', 'tree'];
const DECISION_ID = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const DECISION_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const REF_RE = /(?:[\w@.\-]+\/)+(?:[\w@.\-]+)?(?::\d+(?:-\d+)?)?|\.?[\w@\-]+(?:\.[\w@\-]+)*\.(?:jsonl|json|tsx|ts|mjs|cjs|js|md|yaml|yml|sh|toml|txt)(?![\w.\-])(?::\d+(?:-\d+)?)?/g;

function parseArgs(argv) {
  const out = { data: path.join(HERE, 'data'), repo: path.dirname(HERE), render: true, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') out.data = path.resolve(argv[++i]);
    else if (a === '--repo') out.repo = path.resolve(argv[++i]);
    else if (a === '--no-render') out.render = false;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--help' || a === '-h') {
      console.log('node flow-atlas/check.mjs [--data <dir>] [--repo <dir>] [--no-render] [--verbose]\nMERMAID_JS=/path/mermaid.min.js — lokalna kopia Mermaid dla renderu w Chromium.');
      process.exit(0);
    } else {
      console.error('Nieznany argument: ' + a);
      process.exit(2);
    }
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const errors = [];
const warnings = [];
const infos = [];
const err = (ctx, msg) => errors.push({ ctx, msg });
const warn = (ctx, msg) => warnings.push({ ctx, msg });
const info = (ctx, msg) => infos.push({ ctx, msg });

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

function loadAreas() {
  const areas = [];
  if (!fs.existsSync(opts.data)) {
    err('data', 'katalog danych nie istnieje: ' + opts.data);
    return areas;
  }
  const files = fs.readdirSync(opts.data).filter((f) => f.endsWith('.js')).sort();
  for (const id of EXPECTED) {
    if (!files.includes(id + '.js')) warn(id, 'brak pliku data/' + id + '.js (strona pokaże „brak danych”)');
  }
  for (const f of files) {
    const id = f.slice(0, -3);
    const ctx = id;
    if (!EXPECTED.includes(id)) warn(ctx, 'plik spoza listy obszarów; index.html go nie ładuje');
    const file = path.join(opts.data, f);
    const code = fs.readFileSync(file, 'utf8');
    const sandbox = { window: {}, console: { log() {}, warn() {}, error() {} } };
    vm.createContext(sandbox);
    try {
      new vm.Script(code, { filename: file }).runInContext(sandbox, { timeout: 2000 });
    } catch (e) {
      const where = String(e.stack || '').split('\n').slice(0, 3).join(' | ');
      err(ctx, 'plik nie wykonuje się: ' + (e && e.message) + (where ? ' [' + where + ']' : ''));
      continue;
    }
    const pushed = Array.isArray(sandbox.window.ATLAS) ? sandbox.window.ATLAS : [];
    if (pushed.length !== 1) {
      err(ctx, 'plik powinien dodać dokładnie 1 obszar do window.ATLAS, dodał ' + pushed.length);
      if (!pushed.length) continue;
    }
    const area = pushed[0];
    if (!area || typeof area !== 'object') {
      err(ctx, 'wpis w window.ATLAS nie jest obiektem');
      continue;
    }
    if (area.id !== id) err(ctx, 'id obszaru „' + area.id + '” różni się od nazwy pliku');
    area.__file = f;
    areas.push(area);
  }
  return areas;
}

function checkSchema(areas) {
  const ids = new Map();
  const claim = (id, ctx) => {
    if (!isStr(id)) return;
    if (ids.has(id)) err(ctx, 'id „' + id + '” powtarza się (już w ' + ids.get(id) + ')');
    else ids.set(id, ctx);
  };
  for (const a of areas) {
    const A = a.id || a.__file;
    claim(a.id, A);
    if (!/^[a-z][a-z0-9-]*$/.test(String(a.id))) err(A, 'id obszaru musi być kebab-case');
    if (typeof a.order !== 'number') err(A, 'order musi być liczbą');
    else if (EXPECTED.includes(a.id) && a.order !== EXPECTED.indexOf(a.id)) warn(A, 'order = ' + a.order + ', oczekiwano ' + EXPECTED.indexOf(a.id));
    for (const f of ['title', 'tagline', 'summary']) if (!isStr(a[f])) err(A, 'brak pola ' + f);
    for (const f of ARRAY_FIELDS) if (a[f] !== undefined && !Array.isArray(a[f])) err(A, f + ' musi być tablicą');
    for (const f of ['diagrams', 'decisions']) if (!Array.isArray(a[f])) err(A, 'brak tablicy ' + f);
    (a.diagrams || []).forEach((g, i) => {
      const c = A + ' diagrams[' + i + ']' + (g && g.id ? ' ' + g.id : '');
      if (!g || typeof g !== 'object') return err(c, 'diagram nie jest obiektem');
      if (!isStr(g.id)) err(c, 'brak id');
      else if (!/^[a-z0-9][a-z0-9-]*$/.test(g.id)) warn(c, 'id diagramu powinno być kebab-case');
      claim(g.id, c);
      if (!isStr(g.title)) err(c, 'brak title');
      if (!isStr(g.caption)) warn(c, 'brak caption');
      if (!isStr(g.mermaid)) err(c, 'brak mermaid');
      else {
        const head = g.mermaid.trim().split('\n')[0].trim();
        if (!/^(flowchart\s+(TD|TB|BT|LR|RL)|stateDiagram-v2|sequenceDiagram)\b/.test(head)) warn(c, 'typ diagramu „' + head + '” spoza SCHEMA (flowchart TD/LR, stateDiagram-v2, sequenceDiagram)');
        const nodes = new Set((stripQuoted(g.mermaid).match(/\b[A-Za-z_][\w]*(?=\s*(?:\[|\{|\(|>|@\{))/g) || []));
        if (nodes.size > 45) warn(c, 'diagram ma ok. ' + nodes.size + ' węzłów (limit ~45); podziel go');
      }
    });
    (a.decisions || []).forEach((d, i) => {
      const c = A + ' decisions[' + i + ']' + (d && d.id ? ' ' + d.id : '');
      if (!d || typeof d !== 'object') return err(c, 'decyzja nie jest obiektem');
      if (!isStr(d.id)) err(c, 'brak id');
      else if (!DECISION_ID.test(d.id)) err(c, 'id decyzji musi być UPPER_SNAKE z prefiksem obszaru');
      claim(d.id, c);
      for (const f of ['title', 'question', 'where']) if (!isStr(d[f])) err(c, 'brak pola ' + f);
      if (!Array.isArray(d.branches) || !d.branches.length) err(c, 'brak gałęzi (branches)');
      else d.branches.forEach((b, j) => {
        if (!b || !isStr(b.if) || !isStr(b.then)) err(c, 'branches[' + j + '] wymaga pól if i then');
      });
      if (d.inputs !== undefined && !Array.isArray(d.inputs)) err(c, 'inputs musi być tablicą');
    });
    const prefixes = new Map();
    (a.decisions || []).forEach((d) => {
      if (d && isStr(d.id) && DECISION_ID.test(d.id)) {
        const p = d.id.split('_')[0];
        prefixes.set(p, (prefixes.get(p) || 0) + 1);
      }
    });
    if (prefixes.size > 1) warn(A, 'decyzje mają różne prefiksy: ' + Array.from(prefixes.keys()).join(', '));
    (a.links || []).forEach((l, i) => {
      const c = A + ' links[' + i + ']';
      if (!l || !isStr(l.to)) return err(c, 'brak pola to');
      if (!areas.some((x) => x.id === l.to)) {
        if (EXPECTED.includes(l.to)) warn(c, 'link do „' + l.to + '”: obszar bez danych');
        else err(c, 'link do nieistniejącego obszaru „' + l.to + '”');
      }
      if (!isStr(l.label)) warn(c, 'brak label');
    });
    (a.config || []).forEach((k, i) => {
      const c = A + ' config[' + i + ']' + (k && k.key ? ' ' + k.key : '');
      if (!k || !isStr(k.key)) err(c, 'brak key');
      if (!k || !isStr(k.effect)) err(c, 'brak effect');
    });
    (a.states || []).forEach((s, i) => {
      if (!s || !isStr(s.name) || !isStr(s.meaning)) err(A + ' states[' + i + ']', 'stan wymaga name i meaning');
    });
    (a.scenarios || []).forEach((s, i) => {
      const c = A + ' scenarios[' + i + ']';
      if (!s || !isStr(s.title)) err(c, 'brak title');
      if (!s || !Array.isArray(s.steps) || !s.steps.length) err(c, 'brak steps');
      if (!s || !isStr(s.outcome)) err(c, 'brak outcome');
    });
    (a.files || []).forEach((f, i) => {
      if (!f || !isStr(f.path) || !isStr(f.role)) err(A + ' files[' + i + ']', 'plik wymaga path i role');
    });
    (a.gotchas || []).forEach((g, i) => {
      if (!isStr(g)) err(A + ' gotchas[' + i + ']', 'pułapka musi być niepustym tekstem');
    });
    (a.glossary || []).forEach((g, i) => {
      if (!g || !isStr(g.term) || !isStr(g.meaning)) err(A + ' glossary[' + i + ']', 'pojęcie wymaga term i meaning');
    });
    const seenTree = new Set();
    walkTree(a.tree, (n, trail) => {
      const c = A + ' tree ' + trail;
      if (!n || typeof n !== 'object') return err(c, 'węzeł drzewa nie jest obiektem');
      if (!isStr(n.path)) return err(c, 'węzeł drzewa bez path');
      if (seenTree.has(n.path)) warn(c, 'ścieżka „' + n.path + '” powtarza się w drzewie');
      seenTree.add(n.path);
      if (!isStr(n.role)) err(c + ' ' + n.path, 'pusta role');
      if (!isStr(n.layer)) warn(c + ' ' + n.path, 'brak layer');
      if (n.children !== undefined && !Array.isArray(n.children)) err(c + ' ' + n.path, 'children musi być tablicą');
    });
  }
}

function walkTree(nodes, fn, trail = 'tree') {
  if (!Array.isArray(nodes)) return;
  nodes.forEach((n, i) => {
    const t = trail + '[' + i + ']';
    fn(n, t);
    if (n && Array.isArray(n.children)) walkTree(n.children, fn, t + '.children');
  });
}

const lineCache = new Map();
function fileInfo(rel) {
  if (lineCache.has(rel)) return lineCache.get(rel);
  const abs = path.resolve(opts.repo, rel);
  let res;
  if (!abs.startsWith(path.resolve(opts.repo) + path.sep) && abs !== path.resolve(opts.repo)) res = { kind: 'outside' };
  else if (!fs.existsSync(abs)) res = { kind: 'missing' };
  else if (fs.statSync(abs).isDirectory()) res = { kind: 'dir' };
  else {
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    res = { kind: 'file', lines };
  }
  lineCache.set(rel, res);
  return res;
}

function parseRefs(s) {
  const out = [];
  String(s || '').replace(REF_RE, (m) => {
    const mm = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(m);
    out.push({ raw: m, path: mm[1], line: mm[2] ? Number(mm[2]) : 0, end: mm[3] ? Number(mm[3]) : 0 });
    return m;
  });
  return out;
}

function checkRef(ctx, value, { needLine, pathOnly }) {
  if (!isStr(value)) return;
  const whole = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(value.trim());
  const refs = pathOnly
    ? [{ raw: value.trim(), path: whole[1], line: whole[2] ? Number(whole[2]) : 0, end: whole[3] ? Number(whole[3]) : 0 }]
    : parseRefs(value);
  if (!refs.length) {
    warn(ctx, '„' + value + '” nie wygląda na ścieżkę plik:linia');
    return;
  }
  for (const r of refs) {
    const p = r.path.replace(/^\.\//, '');
    const fi = fileInfo(p);
    if (fi.kind === 'outside') err(ctx, r.raw + ' — ścieżka poza repozytorium');
    else if (fi.kind === 'missing') err(ctx, r.raw + ' — plik nie istnieje');
    else if (fi.kind === 'dir') {
      if (r.line) err(ctx, r.raw + ' — to katalog, a podano linię');
    } else {
      if (r.line && r.line > fi.lines) err(ctx, r.raw + ' — linia ' + r.line + ' > ' + fi.lines + ' linii pliku');
      if (r.end && (r.end < r.line || r.end > fi.lines)) err(ctx, r.raw + ' — zły zakres linii (plik ma ' + fi.lines + ')');
      if (r.line === 0 && needLine) warn(ctx, r.raw + ' — brak numeru linii');
    }
  }
}

function checkRefs(areas) {
  for (const a of areas) {
    const A = a.id;
    (a.entry || []).forEach((e, i) => checkRef(A + ' entry[' + i + ']', e, { needLine: true }));
    (a.decisions || []).forEach((d, i) => d && checkRef(A + ' decisions[' + i + '] ' + d.id + ' where', d.where, { needLine: true }));
    (a.config || []).forEach((k, i) => k && k.where && checkRef(A + ' config[' + i + '] ' + k.key + ' where', k.where, { needLine: true }));
    (a.states || []).forEach((s, i) => s && s.where && checkRef(A + ' states[' + i + '] ' + s.name + ' where', s.where, { needLine: true }));
    (a.glossary || []).forEach((g, i) => g && g.where && checkRef(A + ' glossary[' + i + '] ' + g.term + ' where', g.where, { needLine: false }));
    (a.files || []).forEach((f, i) => f && checkRef(A + ' files[' + i + '] path', f.path, { needLine: false, pathOnly: true }));
    walkTree(a.tree, (n, trail) => n && isStr(n.path) && checkRef(A + ' ' + trail + ' path', n.path, { needLine: false, pathOnly: true }));
  }
}

function stripQuoted(src) {
  return String(src || '').replace(/%%.*$/gm, '').replace(/"[^"]*"/g, '""');
}

function diamondsIn(src) {
  const s = stripQuoted(src);
  const head = s.trim().split('\n')[0];
  const out = new Set();
  if (/^stateDiagram/.test(head)) {
    for (const m of s.matchAll(/\bstate\s+(\w+)\s*<<choice>>/g)) out.add(m[1]);
  } else if (/^flowchart|^graph/.test(head)) {
    for (const m of s.matchAll(/\b([A-Za-z_]\w*)\s*\{/g)) out.add(m[1]);
    for (const m of s.matchAll(/\b([A-Za-z_]\w*)@\{[^}]*shape:\s*(?:diam|diamond|decision|question)\b/g)) out.add(m[1]);
  }
  return out;
}

function checkLinks(areas) {
  const cards = new Map();
  for (const a of areas) for (const d of a.decisions || []) if (d && isStr(d.id)) cards.set(d.id, a.id);
  const prefixes = new Set(Array.from(cards.keys()).map((id) => id.split('_')[0]));
  const shown = new Set();
  for (const a of areas) {
    for (const g of a.diagrams || []) {
      if (!g || !isStr(g.mermaid)) continue;
      const c = a.id + ' diagram ' + g.id;
      for (const t of stripQuoted(g.mermaid).match(DECISION_TOKEN) || []) if (cards.has(t)) shown.add(t);
      for (const id of diamondsIn(g.mermaid)) {
        if (cards.has(id)) continue;
        if (DECISION_ID.test(id) && prefixes.has(id.split('_')[0])) err(c, 'romb ' + id + ' wygląda na decyzję, ale nie ma karty decyzji');
        else if (DECISION_ID.test(id)) warn(c, 'romb ' + id + ' ma id decyzji o nieznanym prefiksie i nie ma karty');
        else info(c, 'romb ' + id + ' nie jest decyzją z kartą (nie da się go kliknąć)');
      }
    }
    for (const d of a.decisions || []) {
      if (!d || !isStr(d.id)) continue;
      (d.branches || []).forEach((b, j) => {
        const n = b && typeof b.next === 'string' ? b.next.trim() : '';
        if (!n) return;
        if (DECISION_ID.test(n) && !cards.has(n)) warn(a.id + ' ' + d.id + ' branches[' + j + ']', 'next „' + n + '” nie ma karty decyzji');
        else if (/^[a-z][a-z0-9-]*$/.test(n) && !EXPECTED.includes(n) && !areas.some((x) => x.id === n)) warn(a.id + ' ' + d.id + ' branches[' + j + ']', 'next „' + n + '” nie jest ani decyzją, ani obszarem');
      });
    }
  }
  for (const [id, area] of cards) if (!shown.has(id)) warn(area + ' ' + id, 'karta decyzji nie występuje w żadnym diagramie');
}

async function loadPlaywright() {
  const tries = [() => createRequire(import.meta.url)('playwright')];
  tries.push(() => {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return createRequire(path.join(root, 'noop.js'))('playwright');
  });
  for (const t of tries) {
    try {
      return t();
    } catch {}
  }
  return null;
}

async function checkRender(areas) {
  const list = [];
  for (const a of areas) for (const g of a.diagrams || []) if (g && isStr(g.id) && isStr(g.mermaid)) list.push({ area: a.id, id: g.id, src: g.mermaid });
  if (!list.length) return { rendered: 0 };
  const pw = await loadPlaywright();
  if (!pw) {
    err('render', 'brak Playwright (require("playwright") nie działa); uruchom z --no-render albo zainstaluj Playwright globalnie');
    return { rendered: 0 };
  }
  const browser = await pw.chromium.launch();
  let rendered = 0;
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    const local = process.env.MERMAID_JS;
    try {
      if (local) await page.addScriptTag({ path: path.resolve(local) });
      else await page.addScriptTag({ url: MERMAID_CDN });
      await page.waitForFunction(() => !!window.mermaid, null, { timeout: 15000 });
    } catch (e) {
      err('render', 'nie można załadować Mermaid ' + (local ? 'z ' + local : 'z CDN') + ': ' + String(e.message).split('\n')[0] + '. Ustaw MERMAID_JS=/ścieżka/mermaid.min.js albo użyj --no-render.');
      return { rendered: 0 };
    }
    await page.evaluate(() => {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        suppressErrorRendering: true,
        flowchart: { useMaxWidth: false, htmlLabels: true, curve: 'basis' },
        state: { useMaxWidth: false },
        sequence: { useMaxWidth: false }
      });
    });
    let n = 0;
    for (const d of list) {
      const res = await page.evaluate(async ({ src, rid }) => {
        try {
          await window.mermaid.parse(src);
          const out = await window.mermaid.render(rid, src);
          if (!out || !/<svg/.test(out.svg)) return { ok: false, msg: 'Mermaid nie zwrócił SVG' };
          return { ok: true };
        } catch (e) {
          return { ok: false, msg: String((e && (e.message || e.str)) || e) };
        } finally {
          const tmp = document.getElementById('d' + rid);
          if (tmp) tmp.remove();
        }
      }, { src: d.src, rid: 'chk' + n++ });
      if (res.ok) rendered++;
      else err(d.area + ' diagram ' + d.id, 'Mermaid: ' + res.msg.replace(/\n+/g, '\n      '));
    }
  } finally {
    await browser.close();
  }
  return { rendered, total: list.length };
}

function print(title, list) {
  if (!list.length) return;
  console.log('\n' + title + ' (' + list.length + '):');
  for (const x of list) console.log('  [' + x.ctx + '] ' + x.msg);
}

const areas = loadAreas();
checkSchema(areas);
checkRefs(areas);
checkLinks(areas);
let renderInfo = null;
if (opts.render) renderInfo = await checkRender(areas);

const count = (k) => areas.reduce((s, a) => s + (Array.isArray(a[k]) ? a[k].length : 0), 0);
console.log('Flow Atlas check');
console.log('  dane:   ' + opts.data);
console.log('  repo:   ' + opts.repo);
console.log('  obszary: ' + areas.length + '/' + EXPECTED.length + ' (' + areas.map((a) => a.id).join(', ') + ')');
console.log('  diagramy: ' + count('diagrams') + ', decyzje: ' + count('decisions') + ', scenariusze: ' + count('scenarios') + ', klucze: ' + count('config'));
if (renderInfo) console.log('  render Mermaid: ' + (renderInfo.total ? renderInfo.rendered + '/' + renderInfo.total + ' OK' : 'pominięty'));
else console.log('  render Mermaid: pominięty (--no-render)');
print('BŁĘDY', errors);
print('UWAGI', warnings);
if (opts.verbose) print('INFO', infos);
else if (infos.length) console.log('\nINFO: ' + infos.length + ' rombów bez karty decyzji (pokaż: --verbose)');
console.log('\nWynik: ' + errors.length + ' błędów, ' + warnings.length + ' uwag.');
process.exit(errors.length ? 1 : 0);
