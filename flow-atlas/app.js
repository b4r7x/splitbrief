(function () {
  'use strict';

  var AREAS = [
    ['journey', 'Podróż użytkownika'],
    ['startup', 'Start i konfiguracja'],
    ['runners', 'Runnery i seaty'],
    ['planning', 'Sesja planowania'],
    ['build', 'Budowa: pętla briefów'],
    ['review', 'Review'],
    ['recovery', 'Recovery i fallback'],
    ['lifecycle', 'Cykl życia runu'],
    ['ui', 'Interfejs TUI'],
    ['subsystems', 'Podsystemy'],
    ['structure', 'Struktura kodu'],
    ['configuration', 'Konfiguracja: pełna lista']
  ];
  var DECISION_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
  var NODE_ID_RE = /^(?:flowchart|state)-(.+)-\d+$/;
  var REF_RE = /(?:[\w@.\-]+\/)+(?:[\w@.\-]+)?(?::\d+(?:-\d+)?)?|\.?[\w@\-]+(?:\.[\w@\-]+)*\.(?:jsonl|json|tsx|ts|mjs|cjs|js|md|yaml|yml|sh|toml|txt)(?![\w.\-])(?::\d+(?:-\d+)?)?/g;
  var VIEWS = [
    ['map', 'Mapa'],
    ['faq', 'Pytania (FAQ)'],
    ['decisions', 'Wszystkie decyzje'],
    ['config', 'Konfiguracja'],
    ['scenarios', 'Scenariusze'],
    ['structure', 'Struktura'],
    ['refactor', 'Propozycje struktury'],
    ['glossary', 'Słownik']
  ];

  var S = {
    areas: [],
    areaById: new Map(),
    decisions: new Map(),
    diagrams: new Map(),
    decisionDiagrams: new Map(),
    diagramDecisions: new Map(),
    duplicates: [],
    index: [],
    pageKey: '',
    scrollMemo: Object.create(null),
    sources: new WeakMap(),
    panzoom: new WeakMap(),
    mapNodes: new Map(),
    refactor: [],
    faq: [],
    faqById: new Map()
  };

  var MIN_FIT = 0.6;
  var FAQ_PAGE = { id: 'faq', title: 'Pytania (FAQ)', order: -1 };
  var REFACTOR_PAGE = { id: 'refactor', title: 'Propozycje struktury', order: 99 };
  var RF_KINDS = [['split', 'podział pliku'], ['folderize', 'prefiks → folder'], ['extract-shared', 'wspólny moduł'], ['move', 'przeniesienie'], ['merge', 'scalenie'], ['rename', 'zmiana nazwy'], ['delete-dead', 'martwy kod']];
  var TOP_FAQ = ['limit', 'fallback', 'needs-you-vs-seat-down', 'crash', 'apply-fails', 'ready-vs-closed'];
  var FAQ_TAGS = [
    ['limity', 'Limity'],
    ['fallback', 'Fallback'],
    ['recovery', 'Halty i recovery'],
    ['stop', 'Stop, crash, stan runu'],
    ['start', 'Start i tryby'],
    ['planowanie', 'Planowanie'],
    ['build', 'Build'],
    ['review', 'Review'],
    ['apply', 'Apply i zamknięcie'],
    ['pliki', 'Pliki']
  ];
  var FLOW_MAIN = [
    { area: 'startup', title: 'Start', sub: 'config, gotowość, dopuszczenie seatów', facts: [
      ['Node 22+, repo git, terminal albo --json', 'ST_GIT_REPO'],
      ['jeden zablokowany seat blokuje start', 'ST_SEATS_BLOCKED'],
      ['brak configu otwiera ekran Setup', 'ST_NEEDS_SETUP']
    ] },
    { area: 'planning', title: 'Planowanie', sub: 'pytania → plan.json → sprawdzenia → karta', facts: [
      ['do 3 pytań w 2 rundach', 'PL_ROUNDS_EXHAUSTED'],
      ['jedna naprawa planu, potem halt', 'PL_CHECK_ERRORS'],
      ['karta planu przy approve: plan', 'PL_APPROVE_LEVEL']
    ] },
    { area: 'build', title: 'Build', sub: 'brief → próba → bramka → retry → konsultacja', facts: [
      ['1 retry lokalny, potem konsultacja', 'BD_LOCAL_RUNG'],
      ['8 prób i 2 konsultacje na brief', 'BD_CONSULT_BOUND'],
      ['testy dopiero przed review (review: end)', 'BD_BRIEF_GATE_CHECKS']
    ] },
    { area: 'review', title: 'Review', sub: 'checki → komendy reviewera → werdykt → fix loop', facts: [
      ['czerwona komenda biegnie też na run base', 'RV_BASE_RESULT'],
      ['2 cykle naprawcze, potem halt', 'RV_CAP'],
      ['nieudane wywołanie nigdy nie jest pass', 'RV_PASSED']
    ] },
    { area: 'lifecycle', title: 'Apply / zamknięcie', sub: 'ready-to-apply → Apply · Discard · End run', facts: [
      ['checkout: pass od razu zamyka run', 'RV_AFTER_PASS'],
      ['merge 3-stronny, backup, osłona hashy', 'LC_BACKUP_CHANGED'],
      ['Discard i End run zapisują run.patch', 'LC_CLOSE_PATCH']
    ] }
  ];
  var FLOW_EXITS = [
    { area: 'lifecycle', href: '#diagram/lc-stop-resume', title: 'Stop i wznowienie', sub: 'esc, ctrl+c, Pause after this brief', facts: [
      ['Stop now: park w połowie kroku, pliki zostają', 'LC_STOP_KIND'],
      ['⏎ albo tekst w composerze kontynuuje', 'JR_CONTINUE_GUARD'],
      ['End run to jedyne zamknięcie z klawiatury', 'JR_STOP_KIND']
    ] },
    { area: 'recovery', title: 'Halt → recovery', sub: 'Needs you · Seat down · limit · fallback', facts: [
      ['Needs you albo Seat down: jeden tytuł na halt', 'RC_HALT_OF'],
      ['reset do 10 min na BUILD: ciche czekanie', 'RC_RESET_WAIT_ONCE'],
      ['fallback przełącza sam raz na run i seat', 'RC_AUTO_USED']
    ] },
    { area: 'lifecycle', href: '#diagram/lc-crash-detect', title: 'Crash', sub: 'kill -9, brak prądu, zamknięty terminal', facts: [
      ['nic nie zapisane: stopped · interrupted', 'LC_FAILED'],
      ['brief w toku wraca do snapshotu', 'LC_TASK_IN_FLIGHT'],
      ['ucięty Apply: halt apply-partial', 'LC_APPLY_CUT']
    ] }
  ];
  var FLOW_SUPPORT = ['journey', 'runners', 'ui', 'subsystems', 'structure'];

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) {
      return null;
    }
    return null;
  }

  function str(v) {
    return v == null ? '' : String(v);
  }

  function arr(v) {
    return Array.isArray(v) ? v : [];
  }

  function esc(s) {
    return str(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function plural(n, one, few, many) {
    if (n === 1) return one;
    var t = n % 10;
    var h = n % 100;
    if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return few;
    return many;
  }

  function nDiagrams(n) {
    return n + ' ' + plural(n, 'diagram', 'diagramy', 'diagramów');
  }
  function nDecisions(n) {
    return n + ' ' + plural(n, 'decyzja', 'decyzje', 'decyzji');
  }
  function nScenarios(n) {
    return n + ' ' + plural(n, 'scenariusz', 'scenariusze', 'scenariuszy');
  }

  function load() {
    var raw = arr(window.ATLAS);
    var given = new Map();
    raw.forEach(function (a) {
      if (!a || typeof a !== 'object' || !a.id) return;
      if (given.has(a.id)) {
        S.duplicates.push(a.id);
        return;
      }
      given.set(a.id, a);
    });
    var errors = arr(window.ATLAS_LOAD_ERRORS);
    function errorFor(id) {
      var e = errors.filter(function (x) {
        return x.src === 'data/' + id + '.js';
      });
      if (e.length) return e.map(function (x) { return x.message; }).join('; ');
      return 'Plik się załadował, ale nie dodał obszaru do window.ATLAS. Najczęściej to błąd składni; szczegóły pokaże: node flow-atlas/check.mjs';
    }
    var list = AREAS.map(function (pair, i) {
      var a = given.get(pair[0]);
      given.delete(pair[0]);
      if (!a) {
        var empty = normalize({ id: pair[0], title: pair[1], order: i }, i);
        empty.missing = true;
        empty.error = errorFor(pair[0]);
        empty.broken = empty.error.indexOf('Plik się załadował') === 0;
        return empty;
      }
      return normalize(a, i);
    });
    Array.from(given.values())
      .map(function (a) { return normalize(a, 100); })
      .sort(function (x, y) { return x.order - y.order; })
      .forEach(function (a) { list.push(a); });
    S.areas = list;
    list.forEach(function (a) {
      S.areaById.set(a.id, a);
      a.decisions.forEach(function (d) {
        if (!S.decisions.has(d.id)) S.decisions.set(d.id, { d: d, area: a });
      });
      a.diagrams.forEach(function (g) {
        if (!S.diagrams.has(g.id)) S.diagrams.set(g.id, { g: g, area: a });
      });
    });
    S.diagrams.forEach(function (entry, id) {
      var ids = decisionIdsIn(entry.g.mermaid);
      S.diagramDecisions.set(id, ids);
      ids.forEach(function (d) {
        if (!S.decisionDiagrams.has(d)) S.decisionDiagrams.set(d, []);
        S.decisionDiagrams.get(d).push(id);
      });
    });
    loadFaq();
    loadRefactor();
    buildIndex();
  }

  function loadFaq() {
    arr(window.ATLAS_FAQ).forEach(function (f) {
      if (!f || typeof f !== 'object' || !f.id || S.faqById.has(str(f.id))) return;
      var item = { id: str(f.id), q: str(f.q), a: str(f.a), refs: arr(f.refs).map(str).filter(Boolean), tags: arr(f.tags).map(str).filter(Boolean) };
      S.faq.push(item);
      S.faqById.set(item.id, item);
    });
  }

  function loadRefactor() {
    arr(window.ATLAS_REFACTOR).forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      S.refactor.push({
        part: str(r.part), title: str(r.title) || str(r.part), summary: str(r.summary), stats: r.stats || {},
        proposals: arr(r.proposals).filter(function (x) { return x && x.id; }),
        keep: arr(r.keep).filter(Boolean), conventions: arr(r.conventions).map(str).filter(Boolean)
      });
    });
  }

  function faqHref(id) {
    return '#view/faq/q-' + id;
  }

  function sentences(text) {
    return str(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?”])\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ`„0-9])/);
  }

  function normalize(a, fallbackOrder) {
    function list(v) {
      return arr(v).filter(function (x) { return x != null; });
    }
    return {
      id: str(a.id),
      order: typeof a.order === 'number' ? a.order : fallbackOrder,
      title: str(a.title) || str(a.id),
      tagline: str(a.tagline),
      summary: str(a.summary),
      entry: list(a.entry).map(str),
      links: list(a.links).filter(function (l) { return l && l.to; }),
      diagrams: list(a.diagrams).filter(function (g) { return g && g.id; }).map(function (g) {
        return { id: str(g.id), title: str(g.title) || str(g.id), caption: str(g.caption), mermaid: str(g.mermaid) };
      }),
      decisions: list(a.decisions).filter(function (d) { return d && d.id; }).map(function (d) {
        return {
          id: str(d.id), title: str(d.title), question: str(d.question), where: str(d.where),
          inputs: list(d.inputs).map(str), branches: list(d.branches), default: str(d.default), notes: str(d.notes)
        };
      }),
      config: list(a.config),
      states: list(a.states),
      scenarios: list(a.scenarios).map(function (s) {
        return { title: str(s.title), steps: list(s.steps).map(str), outcome: str(s.outcome) };
      }),
      files: list(a.files),
      gotchas: list(a.gotchas).map(str),
      glossary: list(a.glossary),
      tree: normalizeTree(a.tree),
      missing: false
    };
  }

  function normalizeTree(nodes) {
    return arr(nodes).filter(function (n) { return n && n.path; }).map(function (n) {
      return { path: str(n.path), role: str(n.role), layer: str(n.layer), key: n.key === true, children: normalizeTree(n.children) };
    });
  }

  function walkTree(nodes, fn, depth, parents) {
    depth = depth || 0;
    parents = parents || [];
    nodes.forEach(function (n) {
      fn(n, depth, parents);
      walkTree(n.children, fn, depth + 1, parents.concat([n]));
    });
  }

  function stripQuoted(src) {
    return str(src).replace(/%%.*$/gm, '').replace(/"[^"]*"/g, '""');
  }

  function decisionIdsIn(src) {
    var seen = [];
    var m = stripQuoted(src).match(DECISION_RE) || [];
    m.forEach(function (id) {
      if (S.decisions.has(id) && seen.indexOf(id) < 0) seen.push(id);
    });
    return seen;
  }

  function fold(s) {
    var out = '';
    s = str(s);
    for (var i = 0; i < s.length; i++) {
      var c = s[i].toLowerCase();
      if (c === 'ł') c = 'l';
      else {
        var n = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
        c = n.length === 1 ? n : c;
      }
      out += c;
    }
    return out;
  }

  function plain(s) {
    return str(s).replace(/\*\*/g, '').replace(/`/g, '');
  }

  function addIndex(kind, area, title, parts, href) {
    title = plain(title);
    var text = [title].concat(parts.map(plain)).filter(Boolean).join(' · ');
    S.index.push({ kind: kind, area: area, title: title, text: text, hay: fold(text), htitle: fold(title), href: href });
  }

  function buildIndex() {
    S.refactor.forEach(function (r) {
      r.proposals.forEach(function (x) {
        var paths = arr(x.before).concat(arr(x.after)).map(function (f) { return str(f && f.path); });
        addIndex('propozycja', REFACTOR_PAGE, str(x.id) + ' — ' + str(x.title), [str(x.why)].concat(paths, arr(x.moves).map(str)), '#view/refactor/rf-' + str(x.id));
      });
    });
    S.faq.forEach(function (f) {
      addIndex('pytanie', FAQ_PAGE, f.q, [f.a, f.tags.join(' ')], faqHref(f.id));
    });
    S.areas.forEach(function (a) {
      if (a.missing) return;
      var base = '#area/' + a.id;
      addIndex('obszar', a, a.title, [a.tagline, a.summary], base);
      a.diagrams.forEach(function (g) {
        var labels = (g.mermaid.match(/"[^"]*"/g) || []).join(' ').replace(/"/g, '');
        addIndex('diagram', a, g.title, [g.caption, labels], '#diagram/' + g.id);
      });
      a.decisions.forEach(function (d) {
        var br = d.branches.map(function (b) { return [b.if, b.then, b.next].map(str).join(' '); });
        addIndex('decyzja', a, d.id + ' — ' + d.title, [d.question].concat(br, [d.default, d.notes, d.where], d.inputs), '#decision/' + d.id);
      });
      a.config.forEach(function (c, i) {
        addIndex('konfiguracja', a, str(c.key), [c.values, c.default, c.effect, c.where].map(str), base + '/cfg-' + i);
      });
      a.states.forEach(function (s, i) {
        addIndex('stan', a, str(s.name), [s.meaning, s.where].map(str), base + '/st-' + i);
      });
      a.scenarios.forEach(function (s, i) {
        addIndex('scenariusz', a, s.title, s.steps.concat([s.outcome]), base + '/sc-' + i);
      });
      a.gotchas.forEach(function (g, i) {
        addIndex('pułapka', a, g.length > 90 ? g.slice(0, 88) + '…' : g, [g], base + '/gt-' + i);
      });
      a.files.forEach(function (f, i) {
        addIndex('plik', a, str(f.path), [str(f.role)], base + '/fl-' + i);
      });
      a.entry.forEach(function (e, i) {
        addIndex('plik', a, e, ['wejście do obszaru'], base + '/sec-top');
      });
      var ti = 0;
      walkTree(a.tree, function (n) {
        addIndex('folder', a, n.path, [n.role, n.layer], '#view/structure/tr-' + (ti++));
      });
      a.glossary.forEach(function (g, i) {
        addIndex('słownik', a, str(g.term), [str(g.meaning), str(g.where)], '#view/glossary/gl-' + a.id + '-' + i);
      });
    });
  }

  function inline(s) {
    var parts = str(s).split('`');
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (i % 2 === 1 && i < parts.length - 1) {
        if (S.decisions.has(p)) out += '<a class="dec-ref" href="#decision/' + esc(p) + '"><code>' + esc(p) + '</code></a>';
        else out += '<code>' + esc(p) + '</code>';
      } else {
        var t = esc(i % 2 === 1 ? '`' + p : p);
        t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        t = t.replace(DECISION_RE, function (id) {
          return S.decisions.has(id) ? '<a class="dec-ref" href="#decision/' + id + '">' + id + '</a>' : id;
        });
        out += t;
      }
    }
    return out;
  }

  function block(s) {
    var lines = str(s).replace(/\r/g, '').split('\n');
    var html = '';
    var para = [];
    var list = null;
    function flushPara() {
      if (para.length) html += '<p>' + inline(para.join(' ')) + '</p>';
      para = [];
    }
    function flushList() {
      if (list) html += '<' + list.tag + '>' + list.items.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</' + list.tag + '>';
      list = null;
    }
    lines.forEach(function (raw) {
      var line = raw.trim();
      var ul = /^[-*]\s+(.*)$/.exec(line);
      var ol = /^\d+[.)]\s+(.*)$/.exec(line);
      if (!line) {
        flushPara();
        flushList();
      } else if (ul || ol) {
        flushPara();
        var tag = ul ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag: tag, items: [] };
        list.items.push((ul || ol)[1]);
      } else if (list && /^\s{2,}/.test(raw)) {
        list.items[list.items.length - 1] += ' ' + line;
      } else {
        flushList();
        para.push(line);
      }
    });
    flushPara();
    flushList();
    return html;
  }

  function repoRoot() {
    if (location.protocol !== 'file:') return '';
    var p = decodeURIComponent(location.pathname);
    return p.replace(/\/[^/]*$/, '').replace(/\/[^/]*$/, '');
  }

  function editorHref(path, line) {
    var target = store('atlas.editor') || 'vscode';
    var root = repoRoot();
    if (target === 'none' || !root) return '';
    var abs = root + '/' + path.replace(/^\.?\//, '');
    return target + '://file' + encodeURI(abs) + (line ? ':' + line : '');
  }

  function chip(path, line, lineEnd) {
    var label = path + (line ? ':' + line + (lineEnd ? '-' + lineEnd : '') : '');
    var copy = path + (line ? ':' + line : '');
    var href = editorHref(path, line);
    return '<span class="chip"><button type="button" class="chip-copy" data-copy="' + esc(copy) + '" title="Kliknij, aby skopiować">' + esc(label).replace(/\//g, '/<wbr>') + '</button>' +
      (href ? '<a class="chip-open" href="' + esc(href) + '" title="Otwórz w edytorze">↗</a>' : '') + '</span>';
  }

  function refs(where) {
    var s = str(where);
    if (!s) return '';
    var out = '';
    var last = 0;
    s.replace(REF_RE, function (m, off) {
      out += inline(s.slice(last, off));
      var mm = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(m);
      out += chip(mm[1], mm[2], mm[3]);
      last = off + m.length;
      return m;
    });
    out += inline(s.slice(last));
    return out;
  }

  function areaPill(a) {
    return '<a class="pill pill-area" href="#area/' + esc(a.id) + '">' + esc(a.title) + '</a>';
  }

  function counts(a) {
    return { d: a.missing ? 0 : a.diagrams.length, dec: a.missing ? 0 : a.decisions.length, sc: a.missing ? 0 : a.scenarios.length };
  }

  function totals() {
    var t = { areas: 0, d: 0, dec: 0, sc: 0, cfg: 0, gl: 0, tree: 0 };
    S.areas.forEach(function (a) {
      if (a.missing) return;
      t.areas++;
      t.d += a.diagrams.length;
      t.dec += a.decisions.length;
      t.sc += a.scenarios.length;
      t.cfg += a.config.length;
      t.gl += a.glossary.length;
      walkTree(a.tree, function () { t.tree++; });
    });
    t.cfg = mergedConfig().length;
    return t;
  }

  function renderSidebar() {
    var t = totals();
    var viewCounts = { map: '', refactor: S.refactor.reduce(function (n, r) { return n + r.proposals.length; }, 0), faq: S.faq.length, decisions: t.dec, config: t.cfg, scenarios: t.sc, structure: t.tree, glossary: t.gl };
    document.getElementById('nav-views').innerHTML = VIEWS.map(function (v) {
      return '<a class="nav-item" data-key="view:' + v[0] + '" href="#view/' + v[0] + '"><span>' + v[1] + '</span>' +
        (viewCounts[v[0]] !== '' ? '<span class="nav-count">' + viewCounts[v[0]] + '</span>' : '') + '</a>';
    }).join('');
    document.getElementById('nav-areas').innerHTML = S.areas.map(function (a) {
      var c = counts(a);
      var meta = a.missing
        ? '<span class="nav-missing">' + (a.broken ? 'błąd w pliku' : 'brak danych') + '</span>'
        : '<span title="diagramy">' + c.d + ' diagr.</span><span title="decyzje">' + c.dec + ' dec.</span><span title="scenariusze">' + c.sc + ' scen.</span>';
      return '<a class="nav-area' + (a.missing ? ' is-missing' : '') + '" data-key="area:' + esc(a.id) + '" href="#area/' + esc(a.id) + '">' +
        '<span class="nav-order">' + esc(a.order) + '</span><span class="nav-body"><span class="nav-title">' + esc(a.title) + '</span>' +
        '<span class="nav-meta">' + meta + '</span></span></a>';
    }).join('');
  }

  function markActive() {
    document.querySelectorAll('[data-key]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-key') === S.pageKey);
    });
  }

  function parseHash() {
    var h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    var p = h.split('/');
    return { kind: p[0] || 'view', id: p[1] || 'map', extra: p.slice(2).join('/') };
  }

  function route() {
    var r = parseHash();
    var key = '';
    var target = '';
    var focusNode = '';
    if (r.kind === 'area' && S.areaById.has(r.id)) {
      key = 'area:' + r.id;
      target = r.extra ? 'a-' + r.extra : '';
    } else if (r.kind === 'decision') {
      var d = S.decisions.get(r.id);
      if (!d) {
        toast('Nie ma karty decyzji ' + r.id);
        key = 'view:decisions';
      } else {
        key = 'area:' + d.area.id;
        target = 'dec-' + r.id;
      }
    } else if (r.kind === 'diagram') {
      var g = S.diagrams.get(r.id);
      if (!g) {
        toast('Nie ma diagramu ' + r.id);
        key = 'view:map';
      } else {
        key = 'area:' + g.area.id;
        if (S.pageKey.indexOf('view:') === 0 && document.getElementById('dg-' + r.id)) key = S.pageKey;
        target = 'dg-' + r.id;
        focusNode = r.extra;
      }
    } else {
      var v = VIEWS.some(function (x) { return x[0] === r.id; }) ? r.id : 'map';
      key = 'view:' + v;
      target = r.extra ? 'a-' + r.extra : '';
    }
    var changed = key !== S.pageKey;
    if (changed) {
      S.pageKey = key;
      renderPage(key);
    }
    markActive();
    if (target) {
      var el = document.getElementById(target);
      if (el) {
        for (var dt = el.parentElement; dt; dt = dt.parentElement) if (dt.tagName === 'DETAILS') dt.open = true;
        if (el.tagName === 'DETAILS') el.open = true;
        el.scrollIntoView({ block: el.offsetHeight > window.innerHeight * 0.7 ? 'start' : 'center' });
        flash(el);
        if (focusNode) whenRendered(el, function () { flashNodes(el, focusNode); });
      }
    } else if (changed) {
      var memo = S.scrollMemo[location.hash];
      window.scrollTo(0, memo || 0);
    }
  }

  function flash(el) {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(function () { el.classList.remove('flash'); }, 1800);
  }

  function renderPage(key) {
    var main = document.getElementById('main');
    var parts = key.split(':');
    var html;
    if (parts[0] === 'area') html = areaPage(S.areaById.get(parts[1]));
    else if (parts[1] === 'faq') html = faqView();
    else if (parts[1] === 'decisions') html = decisionsView();
    else if (parts[1] === 'config') html = configView();
    else if (parts[1] === 'scenarios') html = scenariosView();
    else if (parts[1] === 'glossary') html = glossaryView();
    else if (parts[1] === 'structure') html = structureView();
    else if (parts[1] === 'refactor') html = refactorView();
    else html = mapView();
    main.innerHTML = html;
    var title = parts[0] === 'area' ? S.areaById.get(parts[1]).title : VIEWS.filter(function (v) { return v[0] === parts[1]; })[0][1];
    document.title = title + ' · Flow Atlas';
    setupPage(main);
  }

  function pageHead(kicker, title, sub) {
    return '<header class="page-head"><div class="kicker">' + kicker + '</div><h1>' + title + '</h1>' + (sub ? '<p class="lede">' + sub + '</p>' : '') + '</header>';
  }

  function loadProblems() {
    var missing = S.areas.filter(function (a) { return a.missing && !a.broken; });
    var broken = S.areas.filter(function (a) { return a.broken; });
    var errs = arr(window.ATLAS_LOAD_ERRORS).filter(function (e) { return e.kind === 'error'; });
    if (!missing.length && !broken.length && !errs.length && !S.duplicates.length) return '';
    var html = '<div class="notice">';
    if (missing.length) {
      html += '<div><strong>Brak danych:</strong> ' + missing.map(function (a) {
        return '<a href="#area/' + esc(a.id) + '">' + esc(a.id) + '</a>';
      }).join(', ') + '</div>';
    }
    if (broken.length) {
      html += '<div><strong>Błąd w pliku danych:</strong> ' + broken.map(function (a) {
        return '<a href="#area/' + esc(a.id) + '">data/' + esc(a.id) + '.js</a>';
      }).join(', ') + ' — plik się wczytał, ale nie dodał obszaru. Uruchom <code>node flow-atlas/check.mjs</code>.</div>';
    }
    errs.forEach(function (e) {
      html += '<div><strong>Błąd w ' + esc(e.src) + ':</strong> ' + esc(e.message) + '</div>';
    });
    if (S.duplicates.length) html += '<div><strong>Powtórzone obszary (pominięte):</strong> ' + esc(S.duplicates.join(', ')) + '</div>';
    return html + '</div>';
  }

  function mermaidText(t) {
    return str(t).replace(/[`*]/g, '').replace(/"/g, '#quot;').replace(/[|<>{}\[\]]/g, ' ');
  }

  function mapSource() {
    S.mapNodes = new Map();
    var lines = ['flowchart TD'];
    S.areas.forEach(function (a) {
      var nid = 'area_' + a.id.replace(/[^A-Za-z0-9]/g, '_');
      S.mapNodes.set(nid, '#area/' + a.id);
      var c = counts(a);
      var sub = a.missing ? 'brak danych' : nDiagrams(c.d) + ' · ' + nDecisions(c.dec);
      var label = mermaidText(a.order + ' · ' + a.title) + '<br/>' + sub;
      lines.push('  ' + nid + '["' + label + '"]' + (a.missing ? ':::missing' : ''));
    });
    var edges = new Map();
    S.areas.forEach(function (a) {
      if (a.missing) return;
      if (a.id === 'journey') return;
      a.links.forEach(function (l) {
        if (!S.areaById.has(l.to) || l.to === a.id) return;
        edges.set(a.id + '>' + l.to, true);
      });
    });
    var done = new Set();
    edges.forEach(function (v, k) {
      if (done.has(k)) return;
      var p = k.split('>');
      var back = p[1] + '>' + p[0];
      var both = edges.has(back);
      done.add(k);
      if (both) done.add(back);
      var from = 'area_' + p[0].replace(/[^A-Za-z0-9]/g, '_');
      var to = 'area_' + p[1].replace(/[^A-Za-z0-9]/g, '_');
      lines.push('  ' + from + (both ? ' <--> ' : ' --> ') + to);
    });
    var journey = S.areaById.get('journey');
    var first = S.areas.filter(function (a) { return a.id !== 'journey'; })[0];
    if (journey && first) lines.push('  area_journey ~~~ area_' + first.id.replace(/[^A-Za-z0-9]/g, '_'));
    lines.push('  linkStyle default stroke-width:1px');
    lines.push('  classDef missing stroke-dasharray: 5 4,opacity:0.55');
    return lines.join('\n');
  }

  function mapView() {
    var t = totals();
    var journey = S.areaById.get('journey');
    var html = pageHead('Flow Atlas · SPLITBRIEF', 'Mapa', 'Jak SPLITBRIEF prowadzi run od startu do zamknięcia i gdzie decyduje. Romb na diagramie to decyzja: kliknij go, aby zobaczyć jej kartę.');
    html += '<p class="map-stats">' + [
      '<a href="#view/faq">' + S.faq.length + ' ' + plural(S.faq.length, 'pytanie', 'pytania', 'pytań') + '</a>',
      '<a href="#view/decisions">' + nDecisions(t.dec) + '</a>',
      nDiagrams(t.d),
      '<a href="#view/scenarios">' + nScenarios(t.sc) + '</a>',
      '<a href="#view/config">' + t.cfg + ' ' + plural(t.cfg, 'klucz', 'klucze', 'kluczy') + ' konfiguracji</a>',
      t.areas + ' z ' + S.areas.length + ' obszarów z danymi'
    ].join('<span class="sep">·</span>') + '</p>';
    html += loadProblems();
    if (journey && !journey.missing && journey.diagrams.length) {
      html += diagramCard(journey.diagrams[0], { hero: true });
      if (journey.diagrams.length > 1) {
        html += '<p class="map-more"><span class="muted">Więcej o całym runie:</span> ' + journey.diagrams.slice(1).map(function (g) {
          return '<a class="pill" href="#diagram/' + esc(g.id) + '">' + esc(g.title) + '</a>';
        }).join(' ') + '</p>';
      }
    }
    html += faqTop();
    html += flowSection();
    html += linkMatrix();
    html += '<details class="card map-graph"><summary><strong>Graf wszystkich przejść</strong> <span class="muted">— gęsty: każdy obszar łączy się z prawie każdym; czytelniej w macierzy</span></summary>' +
      diagramCard({ id: '__map', title: 'Obszary i przejścia między nimi', caption: 'Strzałka to przejście sterowania między obszarami (pole links), dwie groty to przejście w obie strony. Obszar „Podróż” prowadzi do wszystkich, więc jego strzałek tu nie ma. Kliknij węzeł, aby otworzyć obszar.', mermaid: mapSource() }, { generated: true }) +
      '</details>';
    return html;
  }

  function faqTop() {
    var items = TOP_FAQ.map(function (id) { return S.faqById.get(id); }).filter(Boolean);
    if (!items.length) return '';
    return '<section class="faq-top"><div class="faq-top-head"><h2 class="section-title">Najważniejsze odpowiedzi</h2><a href="#view/faq">Wszystkie pytania (' + S.faq.length + ') →</a></div>' +
      '<div class="faq-top-grid">' + items.map(function (f) {
        var lead = sentences(f.a);
        var text = lead[0] || '';
        if (lead[1] && (text + ' ' + lead[1]).length <= 240) text += ' ' + lead[1];
        return '<a class="faq-tile" href="' + faqHref(f.id) + '"><span class="faq-tile-q">' + esc(f.q) + '</span>' +
          '<span class="faq-tile-a">' + inlineText(text) + '</span><span class="faq-tile-more">Pełna odpowiedź →</span></a>';
      }).join('') + '</div></section>';
  }

  function inlineText(s) {
    return str(s).split('`').map(function (p, i) { return i % 2 ? '<code>' + esc(p) + '</code>' : esc(p); }).join('');
  }

  function flowFacts(facts) {
    return '<ul class="flow-facts">' + facts.map(function (f) {
      var ok = S.decisions.has(f[1]);
      return '<li>' + (ok ? '<a href="#decision/' + esc(f[1]) + '" title="' + esc(f[1] + ' — ' + S.decisions.get(f[1]).d.title) + '">' + esc(f[0]) + '</a>' : esc(f[0])) + '</li>';
    }).join('') + '</ul>';
  }

  function flowCard(st, n, kind) {
    var a = S.areaById.get(st.area);
    var c = a ? counts(a) : { d: 0, dec: 0, sc: 0 };
    var href = st.href || '#area/' + st.area;
    return '<article class="flow-card flow-' + kind + '">' +
      '<h3>' + (n ? '<span class="flow-n">' + n + '</span>' : '<span class="flow-n flow-n-side" aria-hidden="true">↳</span>') + '<a href="' + esc(href) + '">' + esc(st.title) + '</a></h3>' +
      '<p class="flow-sub">' + esc(st.sub) + '</p>' +
      flowFacts(st.facts) +
      '<a class="flow-foot" href="#area/' + esc(st.area) + '" title="' + esc(a ? a.title : st.area) + '"><span class="flow-foot-area">' + esc(a ? a.title : st.area) + '</span>' +
      '<span>' + (a && !a.missing ? nDecisions(c.dec) + ' · ' + nDiagrams(c.d) : 'brak danych') + ' →</span></a>' +
      '</article>';
  }

  function flowSection() {
    var support = FLOW_SUPPORT.map(function (id) { return S.areaById.get(id); }).filter(Boolean);
    return '<section class="flow"><h2 class="section-title">Etapy runu</h2>' +
      '<p class="section-sub">Run idzie od lewej do prawej. Z każdego etapu może zejść w dół do wyjścia bocznego, a wraca z niego przez ⏎, <code>splitbrief continue</code> albo panel recovery.</p>' +
      '<div class="flow-main">' + FLOW_MAIN.map(function (st, i) { return flowCard(st, i + 1, 'main'); }).join('') + '</div>' +
      '<div class="flow-bridge"><span>↓ wyjście boczne z dowolnego etapu · ↑ powrót do tego samego kroku</span></div>' +
      '<div class="flow-exits">' + FLOW_EXITS.map(function (st) { return flowCard(st, 0, 'exit'); }).join('') + '</div>' +
      (support.length ? '<div class="flow-support"><span class="flow-support-label">Obszary wspierające</span>' + support.map(function (a) {
        var c = counts(a);
        return '<a class="flow-chip" href="#area/' + esc(a.id) + '"><strong>' + esc(a.title) + '</strong><small>' + (a.missing ? 'brak danych' : nDiagrams(c.d) + ' · ' + nDecisions(c.dec)) + '</small></a>';
      }).join('') + '</div>' : '') +
      '</section>';
  }

  function faqRefs(refsList) {
    var dec = [];
    var dg = [];
    var ar = [];
    refsList.forEach(function (r) {
      var m = /^(area|diagram):(.+)$/.exec(r);
      if (m && m[1] === 'area') {
        var a = S.areaById.get(m[2]);
        ar.push(a && !a.missing ? areaPill(a) : '<span class="pill pill-bad">' + esc(r) + '?</span>');
      } else if (m) {
        var g = S.diagrams.get(m[2]);
        dg.push(g ? '<a class="ref-dg" href="#diagram/' + esc(m[2]) + '"><span aria-hidden="true">◇</span> ' + esc(g.g.title) + ' <span class="muted">· ' + esc(g.area.title) + '</span></a>' : '<span class="pill pill-bad">' + esc(r) + '?</span>');
      } else {
        var d = S.decisions.get(r);
        dec.push(d ? '<a class="badge badge-link" href="#decision/' + esc(r) + '" title="' + esc(d.d.title + (d.d.question ? ' — ' + d.d.question : '')) + '">' + esc(r) + '</a>' : '<span class="pill pill-bad" title="Nie ma takiej karty decyzji">' + esc(r) + '?</span>');
      }
    });
    var rows = '';
    if (dec.length) rows += '<div class="meta-row"><span class="meta-label">Decyzje</span><span class="meta-val">' + dec.join(' ') + '</span></div>';
    if (dg.length) rows += '<div class="meta-row"><span class="meta-label">Diagramy</span><span class="meta-val faq-dg">' + dg.join('') + '</span></div>';
    if (ar.length) rows += '<div class="meta-row"><span class="meta-label">Obszary</span><span class="meta-val">' + ar.join(' ') + '</span></div>';
    return rows ? '<div class="faq-refs">' + rows + '</div>' : '';
  }

  function faqItem(f) {
    var tags = f.tags.slice(1).map(function (t) {
      var label = FAQ_TAGS.filter(function (x) { return x[0] === t; })[0];
      return '<span class="faq-tag">' + esc(label ? label[1] : t) + '</span>';
    }).join('');
    return '<details class="card faq-item filter-item" id="a-q-' + esc(f.id) + '" data-area="' + esc(f.tags.join(' ')) + '" data-text="' + esc(fold(f.q + ' ' + f.a + ' ' + f.tags.join(' ') + ' ' + f.refs.join(' '))) + '">' +
      '<summary><span class="faq-head"><span class="faq-q">' + esc(f.q) + '</span><span class="faq-lead">' + inlineText(sentences(f.a)[0]) + '</span></span>' + (tags ? '<span class="faq-tags">' + tags + '</span>' : '') + '</summary>' +
      '<div class="faq-body"><div class="faq-a">' + faqAnswer(f.a) + '</div>' + faqRefs(f.refs) +
      '<div class="faq-link"><a href="' + faqHref(f.id) + '">link do tej odpowiedzi</a></div></div></details>';
  }

  function faqAnswer(text) {
    var ss = sentences(text);
    return '<p class="faq-a-lead">' + inline(ss[0] || '') + '</p>' +
      (ss.length > 1 ? '<ul class="faq-points">' + ss.slice(1).map(function (x) { return '<li><span>' + inline(x) + '</span></li>'; }).join('') + '</ul>' : '');
  }

  function faqView() {
    var html = pageHead('Przekrój', 'Pytania (FAQ)', 'Krótkie odpowiedzi na pytania o to, jak SPLITBRIEF decyduje. Każda odpowiedź podaje karty decyzji i diagramy, na których się opiera. Kliknij pytanie, aby rozwinąć odpowiedź.');
    var faqErr = arr(window.ATLAS_LOAD_ERRORS).filter(function (e) { return e.src === 'data/faq.js'; });
    if (!S.faq.length) {
      return html + '<div class="empty"><strong>' + (faqErr.length ? 'błąd w pliku danych' : 'brak danych') + '</strong><p>Pytania pochodzą z pliku <code>flow-atlas/data/faq.js</code> (<code>window.ATLAS_FAQ</code>).</p>' +
        (faqErr.length ? '<pre class="err-text">' + esc(faqErr.map(function (e) { return e.message; }).join('\n')) + '</pre>' : '') + '</div>';
    }
    var used = FAQ_TAGS.filter(function (t) { return S.faq.some(function (f) { return f.tags[0] === t[0] || f.tags.indexOf(t[0]) >= 0; }); });
    var chips = '<div class="tag-filter" role="group" aria-label="Temat"><button type="button" class="chip-tag" data-tag="" aria-pressed="true">wszystkie</button>' + used.map(function (t) {
      return '<button type="button" class="chip-tag" data-tag="' + esc(t[0]) + '" aria-pressed="false">' + esc(t[1]) + '</button>';
    }).join('') + '</div>';
    html += filterBar('f-faq', 'Filtruj pytania: limit, fallback, crash, Apply…', '<button type="button" class="btn" data-faq="open">rozwiń wszystko</button><button type="button" class="btn" data-faq="close">zwiń wszystko</button>');
    html += chips;
    var groups = FAQ_TAGS.map(function (t) {
      return { tag: t, items: S.faq.filter(function (f) { return f.tags[0] === t[0]; }) };
    });
    var rest = S.faq.filter(function (f) { return !FAQ_TAGS.some(function (t) { return t[0] === f.tags[0]; }); });
    if (rest.length) groups.push({ tag: ['', 'Inne'], items: rest });
    groups.forEach(function (g) {
      if (!g.items.length) return;
      html += '<section class="faq-group filter-group"><h2 class="section-title">' + esc(g.tag[1]) + ' <span class="muted">' + g.items.length + '</span></h2>' +
        g.items.map(faqItem).join('') + '</section>';
    });
    return html;
  }

  function linkMatrix() {
    var list = S.areas;
    var any = false;
    var head = '<tr><th class="lm-corner">z ↓ / do →</th>' + list.map(function (a) {
      return '<th title="' + esc(a.title) + '"><a href="#area/' + esc(a.id) + '">' + esc(a.order) + '</a></th>';
    }).join('') + '</tr>';
    var body = list.map(function (from) {
      return '<tr><th class="lm-row"><a href="#area/' + esc(from.id) + '"><span class="lm-num">' + esc(from.order) + '</span>' + esc(from.title) + '</a></th>' + list.map(function (to) {
        if (from === to) return '<td class="lm-self"></td>';
        var labels = from.missing ? [] : from.links.filter(function (l) { return l.to === to.id; }).map(function (l) { return plain(l.label) || '(bez opisu)'; });
        if (!labels.length) return '<td></td>';
        any = true;
        return '<td class="lm-hit"><a href="#area/' + esc(from.id) + '/sec-top" title="' + esc(from.title + ' → ' + to.title + ':\n' + labels.join('\n')) + '">●</a></td>';
      }).join('') + '</tr>';
    }).join('');
    if (!any) return '';
    return '<h2 class="section-title">Macierz przejść</h2><p class="section-sub">Wiersz przekazuje sterowanie do kolumny. Najedź na kropkę, aby zobaczyć opis przejścia; kliknij, aby otworzyć obszar.</p>' +
      '<div class="card link-matrix"><div class="tbl-wrap"><table class="lm">' + head + body + '</table></div></div>';
  }

  function diagramCard(g, opts) {
    opts = opts || {};
    var decs = opts.generated ? [] : (S.diagramDecisions.get(g.id) || []);
    var foot = decs.length
      ? '<div class="dg-foot"><span class="muted">Decyzje na diagramie:</span> ' + decs.map(function (d) {
        return '<a class="badge badge-link" href="#decision/' + d + '" data-hl="' + d + '">' + d + '</a>';
      }).join(' ') + '</div>'
      : '';
    return '<section class="card dg' + (opts.hero ? ' dg-hero' : '') + '" id="dg-' + esc(g.id) + '" data-dg="' + esc(g.id) + '"' + (opts.generated ? ' data-generated="1"' : '') + '>' +
      '<header class="dg-head"><div class="dg-titles"><h3>' + esc(g.title) + '</h3>' + (g.caption ? '<p class="caption">' + inline(g.caption) + '</p>' : '') + '</div>' +
      '<div class="dg-tools">' +
      '<span class="dg-zoom" title="Skala diagramu"></span>' +
      '<button type="button" class="btn btn-icon" data-act="zoom-out" title="Pomniejsz">−</button>' +
      '<button type="button" class="btn btn-icon" data-act="zoom-in" title="Powiększ">+</button>' +
      '<button type="button" class="btn" data-act="fit" title="Dopasuj do szerokości karty">dopasuj</button>' +
      '<button type="button" class="btn" data-act="full">pełny ekran</button>' +
      '<button type="button" class="btn" data-act="src" aria-pressed="false">pokaż źródło</button>' +
      '</div></header>' +
      '<div class="dg-view" data-state="idle"><div class="dg-scroll"><div class="dg-stage"></div></div><div class="dg-status">Diagram wyrenderuje się po przewinięciu…</div>' +
      '<div class="dg-more" hidden><span>Diagram jest wyższy niż ramka: przewiń w niej albo</span><button type="button" class="btn btn-cta" data-act="full">otwórz na pełnym ekranie</button></div></div>' +
      '<div class="dg-hint">Ctrl + kółko: zoom · przeciągnij: przesuń' + (opts.generated ? ' · kliknij węzeł: obszar' : decs.length ? ' · kliknij romb: karta decyzji' : '') + '</div>' +
      foot +
      '<div class="dg-src" hidden>' + sourceBlock(g.mermaid) + '</div>' +
      '<script type="text/plain" class="dg-source">' + esc(g.mermaid).replace(/<\/script/gi, '<\\/script') + '</script>' +
      '</section>';
  }

  function sourceBlock(src) {
    return '<div class="src-tools"><button type="button" class="btn" data-copy-src="1">kopiuj źródło</button></div><pre class="src">' +
      str(src).split('\n').map(function (l) { return '<span class="src-line">' + (esc(l) || ' ') + '</span>'; }).join('') + '</pre>';
  }

  function areaPage(a) {
    var idx = S.areas.indexOf(a);
    var prev = S.areas[idx - 1];
    var next = S.areas[idx + 1];
    var html = '<div id="a-sec-top"></div>';
    var kicker = 'Obszar ' + esc(a.order) + ' · <code>' + esc(a.id) + '</code>';
    if (a.missing) {
      html += pageHead(kicker, esc(a.title), '');
      html += '<div class="empty"><strong>' + (a.broken ? 'błąd w pliku danych' : 'brak danych') + '</strong><p>Plik <code>flow-atlas/data/' + esc(a.id) + '.js</code> ' + (a.broken ? 'wczytał się, ale nie dodał obszaru.' : 'nie istnieje albo nie załadował się.') + '</p>' +
        (a.error && !a.broken ? '<pre class="err-text">' + esc(a.error) + '</pre>' : '') +
        (a.broken ? '<p>Najczęściej to błąd składni. Szczegóły z numerem linii pokaże <code>node flow-atlas/check.mjs</code>.</p>' : '') +
        '<p class="muted">Kontrakt pliku opisuje <code>flow-atlas/SCHEMA.md</code>.</p></div>';
      return html + pager(prev, next);
    }
    html += pageHead(kicker, esc(a.title), inline(a.tagline));
    var c = counts(a);
    var incoming = [];
    S.areas.forEach(function (o) {
      if (o.missing || o === a) return;
      o.links.forEach(function (l) { if (l.to === a.id) incoming.push({ from: o, label: l.label }); });
    });
    html += '<div class="area-meta">';
    if (a.entry.length) html += '<div class="meta-row"><span class="meta-label">Wejście</span><span class="meta-val">' + a.entry.map(refs).join(' ') + '</span></div>';
    if (a.links.length) {
      html += '<div class="meta-row"><span class="meta-label">Prowadzi do</span><span class="meta-val links-list">' + a.links.map(function (l) {
        var t = S.areaById.get(l.to);
        return '<span class="link-item">→ ' + (t ? areaPill(t) : '<span class="pill pill-bad">' + esc(l.to) + '?</span>') + (l.label ? ' <span class="muted">' + inline(l.label) + '</span>' : '') + '</span>';
      }).join('') + '</span></div>';
    }
    if (incoming.length) {
      html += '<div class="meta-row"><span class="meta-label">Wchodzi z</span><span class="meta-val links-list">' + incoming.map(function (x) {
        return '<span class="link-item">← ' + areaPill(x.from) + (x.label ? ' <span class="muted">' + inline(x.label) + '</span>' : '') + '</span>';
      }).join('') + '</span></div>';
    }
    html += '</div>';
    var secs = [
      ['summary', 'Podsumowanie', a.summary ? 1 : 0],
      ['diagrams', 'Diagramy', c.d],
      ['decisions', 'Decyzje', c.dec],
      ['states', 'Stany', a.states.length],
      ['config', 'Konfiguracja', a.config.length],
      ['scenarios', 'Scenariusze', c.sc],
      ['files', 'Pliki', a.files.length],
      ['tree', 'Foldery', a.tree.length],
      ['gotchas', 'Pułapki', a.gotchas.length]
    ].filter(function (s) { return s[2]; });
    html += '<nav class="toc">' + secs.map(function (s) {
      return '<a href="#area/' + esc(a.id) + '/sec-' + s[0] + '">' + s[1] + (s[0] !== 'summary' ? ' <span>' + s[2] + '</span>' : '') + '</a>';
    }).join('') + '</nav>';
    if (a.summary) html += section('summary', 'Podsumowanie', '<div class="prose">' + block(a.summary) + '</div>');
    if (c.d) html += section('diagrams', 'Diagramy', a.diagrams.map(function (g) { return diagramCard(g); }).join(''));
    if (c.dec) html += section('decisions', 'Decyzje', a.decisions.map(decisionCard).join(''));
    if (a.states.length) html += section('states', 'Stany', table(['Stan', 'Znaczenie', 'Gdzie'], a.states.map(function (s, i) {
      return { id: 'a-st-' + i, cells: ['<code class="strong">' + esc(s.name) + '</code>', inline(s.meaning), refs(s.where)] };
    }), 'tbl-states'));
    if (a.config.length) html += section('config', 'Konfiguracja', table(['Klucz', 'Wartości', 'Domyślnie', 'Efekt', 'Gdzie'], a.config.map(function (k, i) {
      return { id: 'a-cfg-' + i, cells: ['<code class="strong">' + esc(k.key) + '</code>', inline(k.values), inline(k.default), inline(k.effect), refs(k.where)] };
    }), 'tbl-config'));
    if (c.sc) html += section('scenarios', 'Scenariusze', '<div class="scenarios">' + a.scenarios.map(function (s, i) { return scenarioCard(s, 'a-sc-' + i); }).join('') + '</div>');
    if (a.files.length) html += section('files', 'Pliki', table(['Plik', 'Rola'], a.files.map(function (f, i) {
      return { id: 'a-fl-' + i, cells: [refs(f.path), inline(f.role)] };
    }), 'tbl-files'));
    if (a.tree.length) html += section('tree', 'Struktura folderów', treeBlock(a.tree));
    if (a.gotchas.length) html += section('gotchas', 'Pułapki', '<ul class="gotchas">' + a.gotchas.map(function (g, i) {
      return '<li id="a-gt-' + i + '"><span class="gotcha-mark" aria-hidden="true">!</span><div>' + inline(g) + '</div></li>';
    }).join('') + '</ul>');
    return html + pager(prev, next);
  }

  function pager(prev, next) {
    return '<nav class="pager">' +
      (prev ? '<a href="#area/' + esc(prev.id) + '"><small>← poprzedni</small>' + esc(prev.title) + '</a>' : '<span></span>') +
      (next ? '<a class="next" href="#area/' + esc(next.id) + '"><small>następny →</small>' + esc(next.title) + '</a>' : '<span></span>') +
      '</nav>';
  }

  function section(id, title, body) {
    return '<section class="section" id="a-sec-' + id + '"><h2 class="section-title">' + title + '</h2>' + body + '</section>';
  }

  function table(heads, rows, cls) {
    return '<div class="tbl-wrap"><table class="tbl ' + (cls || '') + '"><thead><tr>' + heads.map(function (h) { return '<th>' + h + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows.map(function (r) {
        return '<tr' + (r.id ? ' id="' + r.id + '"' : '') + (r.attrs || '') + '>' + r.cells.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function nextCell(next) {
    var n = str(next);
    if (!n) return '<span class="muted">—</span>';
    if (S.decisions.has(n)) return '<a class="badge badge-link" href="#decision/' + esc(n) + '">' + esc(n) + '</a>';
    if (S.areaById.has(n)) return areaPill(S.areaById.get(n));
    return inline(n);
  }

  function decisionCard(d) {
    var dgs = S.decisionDiagrams.get(d.id) || [];
    var html = '<article class="card decision" id="dec-' + esc(d.id) + '" data-dec-card="' + esc(d.id) + '">';
    html += '<header class="dec-head"><span class="badge">' + esc(d.id) + '</span><h3>' + inline(d.title) + '</h3></header>';
    if (d.question) html += '<p class="question">' + inline(d.question) + '</p>';
    var meta = '';
    if (d.inputs.length) meta += '<div class="meta-row"><span class="meta-label">Czyta</span><span class="meta-val">' + d.inputs.map(function (x) { return '<span class="pill">' + inline(x) + '</span>'; }).join(' ') + '</span></div>';
    if (d.where) meta += '<div class="meta-row"><span class="meta-label">Gdzie</span><span class="meta-val">' + refs(d.where) + '</span></div>';
    if (meta) html += '<div class="dec-meta">' + meta + '</div>';
    if (d.branches.length) {
      html += '<div class="tbl-wrap"><table class="tbl branches"><thead><tr><th>Jeśli</th><th>Wtedy</th><th>Dalej</th></tr></thead><tbody>' +
        d.branches.map(function (b) {
          return '<tr><td>' + inline(b && b.if) + '</td><td>' + inline(b && b.then) + '</td><td>' + nextCell(b && b.next) + '</td></tr>';
        }).join('') +
        (d.default ? '<tr class="row-default"><td><em>w przeciwnym razie</em></td><td colspan="2">' + inline(d.default) + '</td></tr>' : '') +
        '</tbody></table></div>';
    } else if (d.default) {
      html += '<p><span class="meta-label">Domyślnie</span> ' + inline(d.default) + '</p>';
    }
    if (d.notes) html += '<div class="notes">' + block(d.notes) + '</div>';
    html += '<footer class="dec-foot"><span class="muted">w diagramach:</span> ' + (dgs.length ? dgs.map(function (id) {
      var g = S.diagrams.get(id);
      return '<a href="#diagram/' + esc(id) + '/' + esc(d.id) + '">' + esc(g ? g.g.title : id) + '</a>';
    }).join('<span class="sep">·</span>') : '<span class="muted">żadnym</span>') + '</footer>';
    return html + '</article>';
  }

  function scenarioCard(s, id, area) {
    return '<article class="card scenario" id="' + id + '">' +
      (area ? '<div class="scenario-area">' + areaPill(area) + '</div>' : '') +
      '<h3>' + inline(s.title) + '</h3>' +
      '<ol class="steps">' + s.steps.map(function (st) { return '<li><span>' + inline(st.replace(/^\s*\d+[.)]\s*/, '')) + '</span></li>'; }).join('') + '</ol>' +
      (s.outcome ? '<div class="outcome"><span class="outcome-label">Wynik</span>' + inline(s.outcome) + '</div>' : '') +
      '</article>';
  }

  function filterBar(id, placeholder, extra) {
    return '<div class="filter-bar"><input type="search" class="filter" id="' + id + '" placeholder="' + placeholder + '" autocomplete="off">' + (extra || '') + '<span class="filter-count" id="' + id + '-count"></span></div>';
  }

  function areaSelect(id) {
    return '<select class="filter-select" id="' + id + '"><option value="">wszystkie obszary</option>' + S.areas.filter(function (a) { return !a.missing; }).map(function (a) {
      return '<option value="' + esc(a.id) + '">' + esc(a.order + '. ' + a.title) + '</option>';
    }).join('') + '</select>';
  }

  function branchSummary(d) {
    var items = d.branches.slice(0, 5).map(function (b) {
      return '<li><span class="b-if">' + inline(b && b.if) + '</span> <span class="arrow">→</span> ' + inline(b && b.then) +
        (b && b.next ? ' <span class="arrow">⇢</span> ' + nextCell(b.next) : '') + '</li>';
    });
    if (d.branches.length > 5) items.push('<li class="muted">+' + (d.branches.length - 5) + ' więcej</li>');
    if (d.default) items.push('<li class="b-default"><span class="b-if">inaczej</span> <span class="arrow">→</span> ' + inline(d.default) + '</li>');
    return '<ul class="b-list">' + items.join('') + '</ul>';
  }

  function decisionsView() {
    var rows = [];
    S.areas.forEach(function (a) {
      if (a.missing) return;
      a.decisions.forEach(function (d) {
        rows.push({
          attrs: ' data-area="' + esc(a.id) + '" data-text="' + esc(fold([d.id, d.title, d.question, d.where, d.default, d.notes].concat(d.branches.map(function (b) { return str(b && b.if) + ' ' + str(b && b.then) + ' ' + str(b && b.next); })).join(' '))) + '"',
          cells: [
            '<a class="badge badge-link" href="#decision/' + esc(d.id) + '">' + esc(d.id) + '</a><div class="cell-area"><a href="#area/' + esc(a.id) + '">' + esc(a.order + ' · ' + a.title) + '</a></div>',
            '<div class="q-title">' + inline(d.title) + '</div><div class="q-text">' + inline(d.question) + '</div>',
            branchSummary(d),
            refs(d.where)
          ]
        });
      });
    });
    var html = pageHead('Przekrój', 'Wszystkie decyzje', 'Każde rozgałęzienie, które zmienia to, co dzieje się dalej, ze wszystkich obszarów.');
    html += filterBar('f-dec', 'Filtruj: id, pytanie, gałąź, plik…', areaSelect('f-dec-area'));
    if (!rows.length) return html + '<div class="empty">Brak decyzji w danych.</div>';
    return html + table(['Decyzja', 'Pytanie', 'Gałęzie', 'Gdzie'], rows, 'tbl-decisions filterable');
  }

  function mergedConfig() {
    var map = new Map();
    S.areas.forEach(function (a) {
      if (a.missing) return;
      a.config.forEach(function (c, i) {
        var key = str(c.key).trim();
        if (!key) return;
        if (!map.has(key)) map.set(key, { key: key, items: [] });
        map.get(key).items.push({ area: a, c: c, i: i });
      });
    });
    return Array.from(map.values());
  }

  function uniq(list) {
    var out = [];
    list.forEach(function (x) { x = str(x).trim(); if (x && out.indexOf(x) < 0) out.push(x); });
    return out;
  }

  function configView() {
    var merged = mergedConfig();
    var html = pageHead('Przekrój', 'Konfiguracja', 'Klucze konfiguracji, zmienne środowiska i flagi ze wszystkich obszarów. Klucz opisany w kilku obszarach ma jeden wiersz na obszar.');
    html += filterBar('f-cfg', 'Filtruj: klucz, wartość, efekt…', areaSelect('f-cfg-area'));
    if (!merged.length) return html + '<div class="empty">Brak kluczy konfiguracji w danych.</div>';
    merged.sort(function (x, y) { return x.key.toLowerCase() < y.key.toLowerCase() ? -1 : 1; });
    var groups = merged.map(function (m) {
      var areas = uniq(m.items.map(function (x) { return x.area.id; }));
      var n = m.items.length;
      var text = fold(m.key + ' ' + m.items.map(function (x) { return [x.c.values, x.c.default, x.c.effect, x.c.where].map(str).join(' '); }).join(' '));
      var minOrder = Math.min.apply(null, m.items.map(function (x) { return x.area.order; }));
      return '<tbody class="grp filter-item" data-area="' + esc(areas.join(' ')) + '" data-sort-key="' + esc(m.key.toLowerCase()) + '" data-sort-area="' + esc(String(minOrder).padStart(3, '0') + m.key.toLowerCase()) + '" data-text="' + esc(text) + '">' +
        m.items.map(function (x, i) {
          return '<tr id="a-cfgv-' + esc(x.area.id) + '-' + x.i + '">' +
            (i === 0 ? '<td rowspan="' + n + '"><code class="strong">' + esc(m.key) + '</code>' + (n > 1 ? ' <span class="pill pill-tiny" title="opisany w kilku obszarach">×' + n + '</span>' : '') + '</td>' : '') +
            '<td>' + areaPill(x.area) + '</td><td>' + inline(x.c.values) + '</td><td>' + inline(x.c.default) + '</td><td>' + inline(x.c.effect) + '</td><td>' + refs(x.c.where) + '</td></tr>';
        }).join('') + '</tbody>';
    });
    var heads = ['<button type="button" class="sort" data-sort="key">Klucz <span>↕</span></button>', '<button type="button" class="sort" data-sort="area">Obszar <span>↕</span></button>', 'Wartości', 'Domyślnie', 'Efekt', 'Gdzie'];
    return html + '<div class="tbl-wrap"><table class="tbl tbl-config-all sortable"><thead><tr>' + heads.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead>' + groups.join('') + '</table></div>';
  }

  function scenariosView() {
    var html = pageHead('Przekrój', 'Scenariusze', 'Konkretne przejścia „co się dzieje, gdy…” ze wszystkich obszarów.');
    html += filterBar('f-sc', 'Filtruj scenariusze…', areaSelect('f-sc-area'));
    var any = false;
    S.areas.forEach(function (a) {
      if (a.missing || !a.scenarios.length) return;
      any = true;
      html += '<section class="sc-group" data-group-area="' + esc(a.id) + '"><h2 class="section-title">' + esc(a.order + '. ' + a.title) + ' <span class="muted">' + a.scenarios.length + '</span></h2><div class="scenarios">' +
        a.scenarios.map(function (s, i) {
          return scenarioCard(s, 'a-scv-' + a.id + '-' + i).replace('<article class="card scenario"', '<article class="card scenario filter-item" data-area="' + esc(a.id) + '" data-text="' + esc(fold(s.title + ' ' + s.steps.join(' ') + ' ' + s.outcome)) + '"');
        }).join('') + '</div></section>';
    });
    return any ? html : html + '<div class="empty">Brak scenariuszy w danych.</div>';
  }

  function glossaryView() {
    var items = [];
    S.areas.forEach(function (a) {
      if (a.missing) return;
      a.glossary.forEach(function (g, i) { items.push({ g: g, a: a, id: 'a-gl-' + a.id + '-' + i }); });
    });
    items.sort(function (x, y) { return str(x.g.term).localeCompare(str(y.g.term), 'pl', { sensitivity: 'base' }); });
    var html = pageHead('Przekrój', 'Słownik', 'Pojęcia używane w kodzie i w tym atlasie.');
    html += filterBar('f-gl', 'Filtruj pojęcia…', '');
    if (!items.length) return html + '<div class="empty">Brak słownika w danych. Słownik pochodzi z pola <code>glossary</code> obszaru <code>journey</code>.</div>';
    return html + table(['Pojęcie', 'Znaczenie', 'Gdzie'], items.map(function (x) {
      return {
        id: x.id,
        attrs: ' data-text="' + esc(fold(str(x.g.term) + ' ' + str(x.g.meaning) + ' ' + str(x.g.where))) + '"',
        cells: ['<strong>' + inline(x.g.term) + '</strong>', inline(x.g.meaning), refs(x.g.where)]
      };
    }), 'tbl-glossary filterable');
  }

  var LAYERS = ['utils', 'lib', 'core', 'engine', 'stores', 'features', 'components', 'hooks', 'app', 'cli', 'types', 'test', 'docs', 'scripts'];

  function layerClass(layer) {
    var l = str(layer).toLowerCase();
    var i = LAYERS.indexOf(l);
    if (i < 0) {
      i = 0;
      for (var k = 0; k < l.length; k++) i = (i * 31 + l.charCodeAt(k)) % 997;
      return 'layer-x' + (i % 6);
    }
    return 'layer-' + l;
  }

  function treeBlock(nodes) {
    var n = 0;
    function render(list, depth) {
      return '<ul class="tree-list">' + list.map(function (node) {
        var id = 'a-tr-' + (n++);
        var name = node.path.replace(/\/$/, '').split('/').pop() || node.path;
        var isDir = node.children.length > 0;
        var row = '<span class="tree-row' + (node.key ? ' is-key' : '') + '" style="--d:' + depth + '">' +
          '<span class="tree-name">' + (node.key ? '<span class="tree-star" title="kluczowy">★</span>' : '') + esc(name) + (isDir ? '/' : '') + '</span>' +
          (node.layer ? '<span class="layer ' + layerClass(node.layer) + '">' + esc(node.layer) + '</span>' : '') +
          '<span class="tree-role">' + inline(node.role) + '</span>' +
          '<span class="tree-path">' + chip(node.path) + '</span></span>';
        var text = esc(fold(node.path + ' ' + node.role + ' ' + node.layer));
        if (!isDir) return '<li class="tree-item tree-leaf" id="' + id + '" data-text="' + text + '">' + row + '</li>';
        return '<li class="tree-item" data-text="' + text + '"><details id="' + id + '"' + (depth < 2 ? ' open data-default-open="1"' : '') + '><summary>' + row + '</summary>' +
          render(node.children, depth + 1) + '</details></li>';
      }).join('') + '</ul>';
    }
    var layers = [];
    walkTree(nodes, function (x) { if (x.layer && layers.indexOf(x.layer) < 0) layers.push(x.layer); });
    return '<div class="tree" data-tree="1"><div class="filter-bar tree-bar"><input type="search" class="tree-filter" placeholder="Filtruj foldery: ścieżka, rola, warstwa…" autocomplete="off">' +
      '<button type="button" class="btn" data-tree="open">rozwiń wszystko</button><button type="button" class="btn" data-tree="close">zwiń wszystko</button>' +
      '<span class="filter-count tree-count"></span></div>' +
      (layers.length ? '<div class="tree-legend">' + layers.map(function (l) { return '<span class="layer ' + layerClass(l) + '">' + esc(l) + '</span>'; }).join('') + '<span class="muted"><span class="tree-star">★</span> kluczowy moduł</span></div>' : '') +
      render(nodes, 0) + '</div>';
  }

  function setupTree(root) {
    root.querySelectorAll('[data-tree="1"]').forEach(function (tree) {
      var input = tree.querySelector('.tree-filter');
      var count = tree.querySelector('.tree-count');
      var items = tree.querySelectorAll('.tree-item');
      function apply() {
        var tokens = fold(input.value).split(/\s+/).filter(Boolean);
        var shown = 0;
        if (!tokens.length) {
          items.forEach(function (li) { li.hidden = false; li.classList.remove('tree-hit'); });
          tree.querySelectorAll('details').forEach(function (d) { d.open = d.hasAttribute('data-default-open'); });
          count.textContent = items.length + ' ' + plural(items.length, 'węzeł', 'węzły', 'węzłów');
          return;
        }
        items.forEach(function (li) { li.hidden = true; li.classList.remove('tree-hit'); });
        items.forEach(function (li) {
          var text = li.getAttribute('data-text') || '';
          if (!tokens.every(function (t) { return text.indexOf(t) >= 0; })) return;
          shown++;
          li.hidden = false;
          li.classList.add('tree-hit');
          li.querySelectorAll('.tree-item').forEach(function (c) { c.hidden = false; });
          for (var p = li.parentElement; p && p !== tree; p = p.parentElement) {
            if (p.classList.contains('tree-item')) p.hidden = false;
            if (p.tagName === 'DETAILS') p.open = true;
          }
        });
        count.textContent = shown + ' z ' + items.length;
      }
      input.addEventListener('input', apply);
      apply();
    });
  }

  function structureView() {
    var a = S.areaById.get('structure');
    var html = pageHead('Przekrój', 'Struktura', 'Foldery i moduły projektu, ich warstwy i zależności między warstwami.');
    if (!a || a.missing) return html + '<div class="empty"><strong>brak danych</strong><p>Plik <code>flow-atlas/data/structure.js</code> nie istnieje albo nie załadował się.</p></div>';
    if (a.tagline) html += '<p class="section-sub">' + inline(a.tagline) + ' <a href="#area/structure">Cały obszar →</a></p>';
    html += a.tree.length ? treeBlock(a.tree) : '<div class="empty">Obszar nie ma pola <code>tree</code>.</div>';
    if (a.diagrams.length) {
      html += '<h2 class="section-title">Diagramy</h2>' + a.diagrams.map(function (g) { return diagramCard(g); }).join('');
    }
    return html;
  }

  function rfKind(k) {
    var x = RF_KINDS.filter(function (p) { return p[0] === k; })[0];
    return x ? x[1] : k;
  }

  function rfFiles(list) {
    list = arr(list);
    if (!list.length) return '<p class="muted">—</p>';
    return '<ul class="rf-files">' + list.map(function (f) {
      return '<li>' + chip(str(f && f.path)) + (f && f.lines != null ? ' <span class="rf-lines">' + esc(f.lines) + ' l.</span>' : '') + (f && f.note ? ' <span class="muted">' + inline(f.note) + '</span>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function rfSum(list) {
    return arr(list).reduce(function (n, f) { return n + (Number(f && f.lines) || 0); }, 0);
  }

  function rfProposal(x, part) {
    var before = arr(x.before), after = arr(x.after);
    var maxAfter = after.reduce(function (m, f) { return Math.max(m, Number(f && f.lines) || 0); }, 0);
    var tags = [str(x.kind), 'p' + str(x.priority), part].join(' ');
    var text = fold([x.id, x.title, x.why, x.kind, x.tests, x.risks].map(str).concat(before.concat(after).map(function (f) { return str(f && f.path); }), arr(x.moves).map(str)).join(' '));
    var head = '<span class="badge">' + esc(x.id) + '</span><span class="rf-title">' + inline(str(x.title)) + '</span>' +
      '<span class="rf-meta"><span class="pill pill-tiny rf-kind-' + esc(x.kind) + '">' + esc(rfKind(str(x.kind))) + '</span>' +
      '<span class="pill pill-tiny rf-prio-' + esc(x.priority) + '" title="priorytet">P' + esc(x.priority) + '</span>' +
      '<span class="pill pill-tiny" title="nakład pracy">' + esc(x.effort) + '</span>' +
      '<span class="pill pill-tiny rf-risk-' + esc(x.risk) + '" title="ryzyko">ryzyko: ' + esc(x.risk) + '</span>' +
      (before.length ? '<span class="rf-delta" title="linie przed → największy plik po">' + rfSum(before) + ' l. → maks. ' + maxAfter + ' l.</span>' : '') + '</span>';
    var body = '<div class="rf-body">' +
      '<p>' + inline(str(x.why)) + '</p>' +
      '<div class="rf-cols"><div><h4>Teraz</h4>' + rfFiles(before) + '</div><div><h4>Po zmianie</h4>' + rfFiles(after) + '</div></div>' +
      (arr(x.moves).length ? '<h4>Co gdzie idzie</h4><ul class="rf-moves">' + arr(x.moves).map(function (m) { return '<li>' + inline(str(m)) + '</li>'; }).join('') + '</ul>' : '') +
      (x.tests ? '<h4>Testy</h4><p>' + inline(str(x.tests)) + '</p>' : '') +
      '<div class="meta-row"><span class="meta-label">Importery</span><span class="meta-val">' + esc(x.importers != null ? x.importers : '—') + '</span></div>' +
      (arr(x.references).length ? '<div class="meta-row"><span class="meta-label">Do zmiany też</span><span class="meta-val">' + arr(x.references).map(function (r) { return refs(str(r)); }).join(' ') + '</span></div>' : '') +
      (arr(x.steps).length ? '<h4>Kroki</h4><ol class="rf-steps">' + arr(x.steps).map(function (st) { return '<li>' + inline(str(st).replace(/^\d+\.\s*/, '')) + '</li>'; }).join('') + '</ol>' : '') +
      (x.risks ? '<div class="rf-risks"><strong>Ryzyko:</strong> ' + inline(str(x.risks)) + '</div>' : '') +
      '</div>';
    return '<details class="card rf-item filter-item" id="a-rf-' + esc(x.id) + '" data-area="' + esc(tags) + '" data-text="' + esc(text) + '"><summary class="rf-head">' + head + '</summary>' + body + '</details>';
  }

  function refactorView() {
    var html = pageHead('Przekrój', 'Propozycje struktury', 'Pliki do podziału, prefiksy do zamiany na foldery i kod do wyniesienia do wspólnego modułu. Każda propozycja podaje stan przed i po, co gdzie idzie, testy, importerów, miejsca do aktualizacji i kroki.');
    if (!S.refactor.length) return html + '<div class="empty"><strong>brak danych</strong><p>Propozycje pochodzą z plików <code>flow-atlas/data/refactor-*.js</code> (<code>window.ATLAS_REFACTOR</code>).</p></div>';
    var all = [];
    S.refactor.forEach(function (r) { r.proposals.forEach(function (x) { all.push(x); }); });
    var sumStat = function (k) { return S.refactor.reduce(function (n, r) { return n + (Number(r.stats[k]) || 0); }, 0); };
    html += '<p class="section-sub">' + all.length + ' propozycji w ' + S.refactor.length + ' częściach · plików produkcyjnych: ' + sumStat('files') + ' · linii: ' + sumStat('prodLines') +
      ' · ponad 300 linii: ' + sumStat('over300') + ' · ponad 500 linii: ' + sumStat('over500') + ' · grup z prefiksem: ' + sumStat('prefixGroups') + ' · duplikatów: ' + sumStat('duplicates') + '</p>';
    var kinds = RF_KINDS.filter(function (k) { return all.some(function (x) { return x.kind === k[0]; }); });
    html += filterBar('f-rf', 'Filtruj: ścieżka, funkcja, słowo…', '<button type="button" class="btn" data-rf="open">rozwiń wszystko</button><button type="button" class="btn" data-rf="close">zwiń wszystko</button>');
    html += '<div class="tag-filter" role="group" aria-label="Rodzaj"><button type="button" class="chip-tag" data-tag="" aria-pressed="true">wszystkie</button>' +
      '<button type="button" class="chip-tag" data-tag="p1" aria-pressed="false">najpierw (P1)</button>' +
      kinds.map(function (k) { return '<button type="button" class="chip-tag" data-tag="' + esc(k[0]) + '" aria-pressed="false">' + esc(k[1]) + '</button>'; }).join('') +
      S.refactor.map(function (r) { return '<button type="button" class="chip-tag" data-tag="' + esc(r.part) + '" aria-pressed="false">' + esc(r.title) + '</button>'; }).join('') + '</div>';
    S.refactor.forEach(function (r) {
      var props = r.proposals.slice().sort(function (a, b) { return (a.priority || 9) - (b.priority || 9) || str(a.id).localeCompare(str(b.id)); });
      var st = r.stats;
      html += '<section class="rf-part filter-group" id="a-rfp-' + esc(r.part) + '"><h2 class="section-title">' + esc(r.title) + ' <span class="muted">' + props.length + '</span></h2>' +
        '<p class="section-sub">plików: ' + esc(st.files) + ' · linii: ' + esc(st.prodLines) + ' · >300: ' + esc(st.over300) + ' · >500: ' + esc(st.over500) + ' · grupy z prefiksem: ' + esc(st.prefixGroups) + ' · duplikaty: ' + esc(st.duplicates) + '</p>' +
        (r.summary ? '<div class="prose rf-summary">' + block(r.summary) + '</div>' : '') +
        props.map(function (x) { return rfProposal(x, r.part); }).join('') +
        (r.keep.length ? '<details class="card rf-keep filter-item" data-area="' + esc(r.part) + '" data-text="' + esc(fold(r.keep.map(function (k) { return str(k.path) + ' ' + str(k.reason); }).join(' '))) + '"><summary><strong>Zostają duże, bo są spójne</strong> <span class="muted">' + r.keep.length + '</span></summary>' +
          table(['Plik', 'Linie', 'Dlaczego zostaje'], r.keep.map(function (k) { return { cells: [chip(str(k.path)), esc(k.lines), inline(str(k.reason))] }; })) + '</details>' : '') +
        (r.conventions.length ? '<details class="card rf-conv filter-item" data-area="' + esc(r.part) + '" data-text="' + esc(fold(r.conventions.join(' '))) + '"><summary><strong>Konwencje i duplikaty z innymi częściami</strong> <span class="muted">' + r.conventions.length + '</span></summary><ul>' +
          r.conventions.map(function (c) { return '<li>' + refs(c) + '</li>'; }).join('') + '</ul></details>' : '') +
        '</section>';
    });
    return html;
  }

  function setupPage(root) {
    setupFilters(root);
    setupTree(root);
    root.querySelectorAll('.dg').forEach(function (el) { observeDiagram(el); });
  }

  function setupFilters(root) {
    var input = root.querySelector('.filter');
    if (!input) return;
    var select = root.querySelector('.filter-select');
    var countEl = root.querySelector('.filter-count');
    var tagBar = root.querySelector('.tag-filter');
    if (tagBar) {
      tagBar.addEventListener('click', function (e) {
        var b = e.target.closest('[data-tag]');
        if (!b) return;
        tagBar.querySelectorAll('[data-tag]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        apply();
      });
    }
    function apply() {
      var tokens = fold(input.value).split(/\s+/).filter(Boolean);
      var pressed = tagBar ? tagBar.querySelector('[aria-pressed="true"]') : null;
      var area = select ? select.value : pressed ? pressed.getAttribute('data-tag') : '';
      var items = root.querySelectorAll('.filterable tbody tr, .filter-item');
      var shown = 0;
      items.forEach(function (el) {
        var text = el.getAttribute('data-text') || '';
        var areas = (el.getAttribute('data-area') || '').split(' ');
        var ok = tokens.every(function (t) { return text.indexOf(t) >= 0; }) && (!area || areas.indexOf(area) >= 0);
        el.hidden = !ok;
        if (ok) shown++;
      });
      root.querySelectorAll('.sc-group, .filter-group').forEach(function (g) {
        g.hidden = !g.querySelector('.filter-item:not([hidden])');
      });
      if (countEl) countEl.textContent = shown + ' z ' + items.length;
    }
    input.addEventListener('input', apply);
    if (select) select.addEventListener('change', apply);
    apply();
  }

  function sortTable(btn) {
    var tableEl = btn.closest('table');
    var grouped = tableEl.querySelector('tbody.grp');
    var tbody = grouped ? tableEl : tableEl.querySelector('tbody');
    var by = btn.getAttribute('data-sort');
    var dir = btn.getAttribute('data-dir') === 'asc' ? 'desc' : 'asc';
    tableEl.querySelectorAll('.sort').forEach(function (b) { b.removeAttribute('data-dir'); b.querySelector('span').textContent = '↕'; });
    btn.setAttribute('data-dir', dir);
    btn.querySelector('span').textContent = dir === 'asc' ? '↑' : '↓';
    var rows = grouped ? Array.from(tableEl.tBodies) : Array.from(tbody.rows);
    rows.sort(function (x, y) {
      var a = x.getAttribute('data-sort-' + by) || '';
      var b = y.getAttribute('data-sort-' + by) || '';
      return (a < b ? -1 : a > b ? 1 : 0) * (dir === 'asc' ? 1 : -1);
    });
    rows.forEach(function (r) { tbody.appendChild(r); });
  }

  var observer = null;
  var queue = Promise.resolve();
  var renderSeq = 0;

  function observeDiagram(el) {
    if (!('IntersectionObserver' in window)) {
      enqueue(el);
      return;
    }
    if (!observer) {
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            observer.unobserve(e.target);
            enqueue(e.target);
          }
        });
      }, { rootMargin: '600px 0px' });
    }
    observer.observe(el);
  }

  function enqueue(el) {
    var view = el.querySelector('.dg-view');
    if (view.getAttribute('data-state') !== 'idle') return;
    view.setAttribute('data-state', 'queued');
    el.querySelector('.dg-status').textContent = 'Renderuję diagram…';
    queue = queue.then(function () { return renderDiagram(el); }).catch(function () {});
  }

  function whenRendered(el, fn) {
    var view = el.querySelector('.dg-view');
    if (!view) return;
    if (view.getAttribute('data-state') === 'done') {
      fn();
      return;
    }
    enqueue(el);
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var st = view.getAttribute('data-state');
      if (st === 'done' || st === 'error' || tries > 100) {
        clearInterval(timer);
        if (st === 'done') fn();
      }
    }, 100);
  }

  function sourceOf(el) {
    var node = el.querySelector('.dg-source');
    if (!node) return '';
    var t = document.createElement('textarea');
    t.innerHTML = node.textContent;
    return t.value.replace(/<\\\/script/gi, '</script');
  }

  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  var mermaidTheme = '';

  function initMermaid() {
    var theme = currentTheme();
    if (mermaidTheme === theme) return;
    mermaidTheme = theme;
    var css = getComputedStyle(document.documentElement);
    function v(name) { return css.getPropertyValue(name).trim(); }
    var font = v('--font-sans') || 'system-ui, sans-serif';
    var vars = {
      darkMode: theme === 'dark',
      fontFamily: font,
      fontSize: '14px',
      background: v('--surface'),
      primaryColor: v('--mm-node'),
      primaryBorderColor: v('--mm-node-border'),
      primaryTextColor: v('--text'),
      secondaryColor: v('--mm-alt'),
      secondaryBorderColor: v('--mm-node-border'),
      secondaryTextColor: v('--text'),
      tertiaryColor: v('--mm-cluster'),
      tertiaryBorderColor: v('--border'),
      tertiaryTextColor: v('--text'),
      lineColor: v('--mm-line'),
      textColor: v('--text'),
      mainBkg: v('--mm-node'),
      nodeBorder: v('--mm-node-border'),
      clusterBkg: v('--mm-cluster'),
      clusterBorder: v('--border'),
      titleColor: v('--text'),
      edgeLabelBackground: v('--surface'),
      noteBkgColor: v('--warn-bg'),
      noteBorderColor: v('--warn-border'),
      noteTextColor: v('--text'),
      actorBkg: v('--mm-node'),
      actorBorder: v('--mm-node-border'),
      actorTextColor: v('--text'),
      actorLineColor: v('--mm-line'),
      signalColor: v('--text'),
      signalTextColor: v('--text'),
      labelBoxBkgColor: v('--mm-node'),
      labelBoxBorderColor: v('--mm-node-border'),
      labelTextColor: v('--text'),
      loopTextColor: v('--text'),
      activationBkgColor: v('--mm-alt'),
      activationBorderColor: v('--mm-node-border'),
      sequenceNumberColor: v('--surface'),
      stateBkg: v('--mm-node'),
      stateLabelColor: v('--text'),
      compositeBackground: v('--mm-cluster'),
      compositeTitleBackground: v('--mm-alt'),
      altBackground: v('--mm-cluster'),
      transitionColor: v('--mm-line'),
      transitionLabelColor: v('--muted'),
      specialStateColor: v('--mm-line'),
      innerEndBackground: v('--mm-node-border')
    };
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: vars,
      fontFamily: font,
      suppressErrorRendering: true,
      flowchart: { useMaxWidth: false, htmlLabels: true, curve: 'basis', padding: 12, nodeSpacing: 40, rankSpacing: 48 },
      state: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      er: { useMaxWidth: false },
      class: { useMaxWidth: false }
    });
  }

  function renderDiagram(el) {
    var view = el.querySelector('.dg-view');
    var stage = el.querySelector('.dg-stage');
    var status = el.querySelector('.dg-status');
    var src = sourceOf(el);
    if (!el.isConnected) return Promise.resolve();
    if (!window.mermaid) {
      showError(el, 'Biblioteka Mermaid nie załadowała się (brak sieci albo zablokowany CDN jsdelivr). Diagram pokazuję jako źródło.');
      return Promise.resolve();
    }
    initMermaid();
    src = compactDiamonds(src);
    var id = 'mmd' + (++renderSeq);
    return Promise.resolve()
      .then(function () { return window.mermaid.parse(src); })
      .then(function () { return window.mermaid.render(id, src); })
      .then(function (out) {
        if (!el.isConnected) return;
        stage.innerHTML = out.svg;
        var svg = stage.querySelector('svg');
        if (!svg) throw new Error('Mermaid nie zwrócił SVG');
        decorateSvg(svg, el.getAttribute('data-generated') === '1');
        view.setAttribute('data-state', 'done');
        status.textContent = '';
        var pz = makeCardZoom(el);
        S.panzoom.set(el, pz);
        pz.fit();
      })
      .catch(function (err) {
        showError(el, (err && (err.message || err.str)) || String(err));
      })
      .then(function () {
        var tmp = document.getElementById('d' + id);
        if (tmp) tmp.remove();
      });
  }

  function compactDiamonds(src) {
    if (!/^\s*flowchart\b/.test(src)) return src;
    return src.replace(/(\b[A-Za-z_]\w*)\{"([^"]*)"\}(?!\})/g, function (m, id, label) {
      if (/<br\s*\/?>/i.test(label) || label.length <= 16) return m;
      var width = Math.max(11, Math.round(1.8 * Math.sqrt(label.length)));
      var lines = [];
      var cur = '';
      label.split(' ').forEach(function (word) {
        var parts = word.length > width && word.indexOf('/') > 0 ? word.split(/(?<=\/)(?=.)/) : [word];
        parts.forEach(function (w, i) {
          var sep = i ? '' : ' ';
          if (cur && (cur + sep + w).length > width) {
            lines.push(cur);
            cur = w;
          } else cur = cur ? cur + sep + w : w;
        });
      });
      if (cur) lines.push(cur);
      return id + '{"' + lines.join('<br/>') + '"}';
    });
  }

  function showError(el, message) {
    var view = el.querySelector('.dg-view');
    view.setAttribute('data-state', 'error');
    el.querySelector('.dg-stage').innerHTML = '';
    el.querySelector('.dg-status').innerHTML = '<div class="dg-error"><strong>Diagram się nie wyrenderował</strong><pre class="err-text">' + esc(message) + '</pre>' + sourceBlock(sourceOf(el)) + '</div>';
  }

  function decorateSvg(svg, generated) {
    svg.removeAttribute('style');
    svg.querySelectorAll('[id]').forEach(function (node) {
      var m = NODE_ID_RE.exec(node.id);
      if (!m) return;
      var nid = m[1];
      var href = '';
      var tip = '';
      if (generated && S.mapNodes.has(nid)) {
        href = S.mapNodes.get(nid);
        tip = 'Otwórz obszar';
      } else if (S.decisions.has(nid)) {
        var d = S.decisions.get(nid).d;
        href = '#decision/' + nid;
        tip = nid + ' — ' + d.title + (d.question ? '\n' + d.question : '');
        node.setAttribute('data-dec', nid);
      }
      if (!href) return;
      node.classList.add('atlas-node');
      node.setAttribute('data-href', href);
      node.setAttribute('tabindex', '0');
      node.setAttribute('role', 'link');
      var t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      t.textContent = tip;
      node.insertBefore(t, node.firstChild);
    });
  }

  function flashNodes(el, decId) {
    var pz = S.panzoom.get(el);
    var first = el.querySelector('.dg-stage [data-dec="' + decId + '"]');
    if (pz && pz.reveal && first) pz.reveal(first);
    el.querySelectorAll('[data-dec="' + decId + '"]').forEach(function (n) {
      n.classList.remove('node-flash');
      void n.getBoundingClientRect();
      n.classList.add('node-flash');
      setTimeout(function () { n.classList.remove('node-flash'); }, 2400);
    });
  }

  function naturalSize(svg) {
    var vb = svg.viewBox && svg.viewBox.baseVal;
    var w = (vb && vb.width) || parseFloat(svg.getAttribute('width')) || 400;
    var h = (vb && vb.height) || parseFloat(svg.getAttribute('height')) || 300;
    return { w: w, h: h };
  }

  function wheelFactor(e) {
    return Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 30 ? 0.02 : 0.0018));
  }

  function makeCardZoom(card) {
    var scroller = card.querySelector('.dg-scroll');
    var svg = card.querySelector('.dg-stage svg');
    var more = card.querySelector('.dg-more');
    var label = card.querySelector('.dg-zoom');
    var z = naturalSize(svg);
    var s = 1;
    var PAD = 16;
    var centred = /^(?:flowchart|graph)\s+(?:TD|TB|BT)\b|^stateDiagram/.test(sourceOf(card).trim());
    function update() {
      var tall = scroller.scrollHeight > scroller.clientHeight + 4;
      var wide = scroller.scrollWidth > scroller.clientWidth + 4;
      var atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 32;
      card.classList.toggle('is-tall', tall);
      card.classList.toggle('is-wide', wide);
      more.firstChild.textContent = 'Diagram jest ' + (wide ? 'większy' : 'wyższy') + ' niż ramka: przewiń w niej albo';
      more.hidden = !tall || atEnd;
    }
    function apply() {
      svg.setAttribute('width', String(Math.round(z.w * s)));
      svg.setAttribute('height', String(Math.round(z.h * s)));
      if (label) label.textContent = Math.round(s * 100) + '%';
      update();
    }
    function fit() {
      var avail = (scroller.clientWidth || 800) - PAD;
      s = z.w > avail ? Math.max(MIN_FIT, avail / z.w) : 1;
      apply();
      scroller.scrollLeft = centred ? Math.max(0, (scroller.scrollWidth - scroller.clientWidth) / 2) : 0;
      scroller.scrollTop = 0;
    }
    function zoomAt(factor, cx, cy) {
      var px = (scroller.scrollLeft + cx) / s;
      var py = (scroller.scrollTop + cy) / s;
      s = Math.min(3, Math.max(0.2, s * factor));
      apply();
      scroller.scrollLeft = px * s - cx;
      scroller.scrollTop = py * s - cy;
    }
    scroller.addEventListener('scroll', update, { passive: true });
    scroller.addEventListener('wheel', function (e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      var r = scroller.getBoundingClientRect();
      zoomAt(wheelFactor(e), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    var drag = null;
    scroller.addEventListener('pointerdown', function (e) {
      var r = scroller.getBoundingClientRect();
      if (e.button !== 0 || e.clientX - r.left > scroller.clientWidth || e.clientY - r.top > scroller.clientHeight) return;
      drag = { x: e.clientX, y: e.clientY, ox: scroller.scrollLeft, oy: scroller.scrollTop, moved: false, id: e.pointerId };
    });
    scroller.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
        drag.moved = true;
        try { scroller.setPointerCapture(drag.id); } catch (err) {}
        scroller.classList.add('dragging');
      }
      if (drag.moved) {
        scroller.scrollLeft = drag.ox - dx;
        scroller.scrollTop = drag.oy - dy;
      }
    });
    function end() {
      if (drag && drag.moved) {
        scroller.setAttribute('data-just-dragged', '1');
        setTimeout(function () { scroller.removeAttribute('data-just-dragged'); }, 0);
      }
      drag = null;
      scroller.classList.remove('dragging');
    }
    scroller.addEventListener('pointerup', end);
    scroller.addEventListener('pointercancel', end);
    return {
      fit: fit,
      zoom: function (f) { zoomAt(f, scroller.clientWidth / 2, Math.min(scroller.clientHeight, window.innerHeight) / 2); },
      reveal: function (node) {
        var r = node.getBoundingClientRect();
        var sr = scroller.getBoundingClientRect();
        scroller.scrollTop += r.top - sr.top - sr.height / 2 + r.height / 2;
        scroller.scrollLeft += r.left - sr.left - sr.width / 2 + r.width / 2;
      }
    };
  }

  function makePanZoom(viewport, content) {
    var st = { x: 0, y: 0, s: 1 };
    var svg = content.querySelector('svg');
    function apply() {
      content.style.transform = 'translate(' + st.x + 'px,' + st.y + 'px) scale(' + st.s + ')';
    }
    function zoomAt(factor, cx, cy) {
      var ns = Math.min(4, Math.max(0.15, st.s * factor));
      var f = ns / st.s;
      st.x = cx - (cx - st.x) * f;
      st.y = cy - (cy - st.y) * f;
      st.s = ns;
      apply();
    }
    function fit(whole) {
      var z = naturalSize(svg);
      var vw = viewport.clientWidth || 800;
      var vh = viewport.clientHeight || 600;
      var all = Math.min(1.5, vw / z.w, vh / z.h) * 0.96;
      st.s = whole ? all : Math.max(all, Math.min(1.5, (vw - 32) / z.w));
      st.x = (vw - z.w * st.s) / 2;
      st.y = z.h * st.s > vh ? 16 : (vh - z.h * st.s) / 2;
      apply();
    }
    viewport.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (!e.ctrlKey && !e.metaKey) {
        st.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        st.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        apply();
        return;
      }
      var r = viewport.getBoundingClientRect();
      zoomAt(wheelFactor(e), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    var drag = null;
    viewport.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, ox: st.x, oy: st.y, moved: false, id: e.pointerId };
    });
    viewport.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
        drag.moved = true;
        try { viewport.setPointerCapture(drag.id); } catch (err) {}
        viewport.classList.add('dragging');
      }
      if (drag.moved) {
        st.x = drag.ox + dx;
        st.y = drag.oy + dy;
        apply();
      }
    });
    function end() {
      if (drag && drag.moved) {
        viewport.setAttribute('data-just-dragged', '1');
        setTimeout(function () { viewport.removeAttribute('data-just-dragged'); }, 0);
      }
      drag = null;
      viewport.classList.remove('dragging');
    }
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
    return {
      fit: fit,
      zoom: function (f) { zoomAt(f, viewport.clientWidth / 2, viewport.clientHeight / 2); }
    };
  }

  var modalPz = null;

  function openFullscreen(el) {
    var svg = el.querySelector('.dg-stage svg');
    var modal = document.getElementById('modal');
    var body = document.getElementById('modal-body');
    document.getElementById('modal-title').textContent = el.querySelector('h3').textContent;
    body.innerHTML = '';
    if (!svg) {
      body.innerHTML = '<div class="modal-msg">' + (el.querySelector('.dg-error') ? el.querySelector('.dg-error').outerHTML : 'Diagram jeszcze się nie wyrenderował.') + '</div>';
    } else {
      var stage = document.createElement('div');
      stage.className = 'dg-stage';
      var clone = svg.cloneNode(true);
      var nat = naturalSize(svg);
      clone.setAttribute('width', String(nat.w));
      clone.setAttribute('height', String(nat.h));
      stage.appendChild(clone);
      body.appendChild(stage);
    }
    modal.hidden = false;
    document.body.classList.add('modal-open');
    modal.setAttribute('data-from', el.id);
    if (svg) {
      modalPz = makePanZoom(body, body.querySelector('.dg-stage'));
      requestAnimationFrame(function () { modalPz.fit(); });
    }
    document.getElementById('modal-close').focus();
  }

  function closeModal() {
    var modal = document.getElementById('modal');
    if (modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    document.getElementById('modal-body').innerHTML = '';
    modalPz = null;
  }

  function rerenderAll() {
    mermaidTheme = '';
    document.querySelectorAll('.dg').forEach(function (el) {
      var view = el.querySelector('.dg-view');
      if (view.getAttribute('data-state') === 'idle') return;
      view.setAttribute('data-state', 'idle');
      if (observer) {
        observer.unobserve(el);
        observeDiagram(el);
      } else enqueue(el);
    });
  }

  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }

  function copy(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      ta.remove();
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(fallback);
      else fallback();
    } catch (e) {
      fallback();
    }
    toast('Skopiowano: ' + (text.length > 60 ? text.slice(0, 58) + '…' : text));
  }

  var searchSel = -1;

  function search(q) {
    var box = document.getElementById('search-results');
    var tokens = fold(q).split(/\s+/).filter(Boolean);
    if (!tokens.length) {
      box.hidden = true;
      return;
    }
    var hits = [];
    S.index.forEach(function (it) {
      if (!tokens.every(function (t) { return it.hay.indexOf(t) >= 0; })) return;
      var score = 0;
      tokens.forEach(function (t) {
        if (it.htitle.indexOf(t) >= 0) score += 10;
        if (it.htitle.indexOf(t) === 0) score += 5;
      });
      if (it.kind === 'decyzja') score += 2;
      if (it.kind === 'obszar') score += 3;
      if (it.kind === 'pytanie') score += 8;
      hits.push({ it: it, score: score });
    });
    hits.sort(function (a, b) { return b.score - a.score || a.it.area.order - b.it.area.order; });
    var total = hits.length;
    hits = hits.slice(0, 60);
    searchSel = hits.length ? 0 : -1;
    box.innerHTML = '<div class="sr-head">' + (total ? total + ' ' + plural(total, 'wynik', 'wyniki', 'wyników') + (total > 60 ? ' (pokazuję 60)' : '') : 'Brak wyników') + '<span>↑↓ ⏎ · Esc</span></div>' +
      hits.map(function (h, i) {
        return '<a class="sr-item' + (i === 0 ? ' sel' : '') + '" href="' + esc(h.it.href) + '"><span class="sr-kind">' + esc(h.it.kind) + '</span>' +
          '<span class="sr-main"><span class="sr-title">' + mark(h.it.title, tokens) + '</span><span class="sr-snippet">' + snippet(h.it, tokens) + '</span></span>' +
          '<span class="sr-area">' + esc(h.it.area.title) + '</span></a>';
      }).join('');
    var r = document.getElementById('search').getBoundingClientRect();
    box.style.top = (r.bottom + 6) + 'px';
    box.style.left = r.left + 'px';
    box.hidden = false;
  }

  function mark(text, tokens) {
    text = str(text);
    var f = fold(text);
    var marks = new Array(text.length).fill(false);
    tokens.forEach(function (t) {
      var i = f.indexOf(t);
      while (i >= 0) {
        for (var k = i; k < i + t.length; k++) marks[k] = true;
        i = f.indexOf(t, i + t.length);
      }
    });
    var out = '';
    var open = false;
    for (var i = 0; i < text.length; i++) {
      if (marks[i] && !open) { out += '<mark>'; open = true; }
      if (!marks[i] && open) { out += '</mark>'; open = false; }
      out += esc(text[i]);
    }
    return out + (open ? '</mark>' : '');
  }

  function snippet(it, tokens) {
    var rest = it.text.slice(it.title.length).replace(/^ · /, '').replace(/\s+/g, ' ').replace(/`/g, '');
    var f = fold(rest);
    var pos = -1;
    tokens.forEach(function (t) {
      var i = f.indexOf(t);
      if (i >= 0 && (pos < 0 || i < pos)) pos = i;
    });
    if (pos < 0) return esc(rest.slice(0, 90));
    var start = Math.max(0, pos - 30);
    var cut = rest.slice(start, start + 110);
    return (start > 0 ? '…' : '') + mark(cut, tokens) + (start + 110 < rest.length ? '…' : '');
  }

  function moveSel(dir) {
    var items = document.querySelectorAll('.sr-item');
    if (!items.length) return;
    searchSel = (searchSel + dir + items.length) % items.length;
    items.forEach(function (el, i) { el.classList.toggle('sel', i === searchSel); });
    items[searchSel].scrollIntoView({ block: 'nearest' });
  }

  function applyThemeLabel() {
    document.getElementById('theme-label').textContent = currentTheme() === 'dark' ? 'Ciemny' : 'Jasny';
  }

  function bind() {
    document.addEventListener('click', function (e) {
      var t = e.target;
      var copyBtn = t.closest('[data-copy]');
      if (copyBtn) {
        copy(copyBtn.getAttribute('data-copy'));
        return;
      }
      var copySrc = t.closest('[data-copy-src]');
      if (copySrc) {
        var card = copySrc.closest('.dg');
        copy(card ? sourceOf(card) : copySrc.parentNode.nextElementSibling.textContent);
        return;
      }
      var node = t.closest('.atlas-node');
      if (node) {
        var vp = node.closest('.dg-scroll, .modal-body');
        if (vp && vp.getAttribute('data-just-dragged')) return;
        if (node.closest('.modal')) closeModal();
        S.scrollMemo[location.hash] = window.scrollY;
        location.hash = node.getAttribute('data-href');
        return;
      }
      var act = t.closest('[data-act]');
      if (act) {
        var dg = act.closest('.dg');
        var pz = S.panzoom.get(dg);
        var a = act.getAttribute('data-act');
        if (a === 'zoom-in' && pz) pz.zoom(1.25);
        if (a === 'zoom-out' && pz) pz.zoom(0.8);
        if (a === 'fit' && pz) pz.fit();
        if (a === 'full') openFullscreen(dg);
        if (a === 'src') {
          var srcEl = dg.querySelector('.dg-src');
          srcEl.hidden = !srcEl.hidden;
          act.setAttribute('aria-pressed', String(!srcEl.hidden));
          act.textContent = srcEl.hidden ? 'pokaż źródło' : 'ukryj źródło';
        }
        return;
      }
      var z = t.closest('[data-zoom]');
      if (z && modalPz) {
        var k = z.getAttribute('data-zoom');
        if (k === 'in') modalPz.zoom(1.25);
        if (k === 'out') modalPz.zoom(0.8);
        if (k === 'fit') modalPz.fit();
        if (k === 'all') modalPz.fit(true);
        return;
      }
      if (t.closest('#modal-close')) {
        closeModal();
        return;
      }
      var fq = t.closest('[data-faq]');
      if (fq) {
        var openAll = fq.getAttribute('data-faq') === 'open';
        document.querySelectorAll('.faq-item:not([hidden])').forEach(function (d) { d.open = openAll; });
        return;
      }
      var rf = t.closest('[data-rf]');
      if (rf) {
        var openRf = rf.getAttribute('data-rf') === 'open';
        document.querySelectorAll('.rf-item:not([hidden])').forEach(function (d) { d.open = openRf; });
        return;
      }
      var tb = t.closest('[data-tree="open"], [data-tree="close"]');
      if (tb) {
        var open = tb.getAttribute('data-tree') === 'open';
        tb.closest('.tree').querySelectorAll('details').forEach(function (d) { d.open = open; });
        return;
      }
      var sort = t.closest('.sort');
      if (sort) {
        sortTable(sort);
        return;
      }
      var link = t.closest('a[href^="#"]');
      if (link) {
        if (link.closest('.sidebar') && !link.closest('.search-results')) delete S.scrollMemo[link.getAttribute('href')];
        else S.scrollMemo[location.hash] = window.scrollY;
        if (link.closest('.search-results')) {
          document.getElementById('search-results').hidden = true;
        }
        if (link.getAttribute('href') === location.hash) route();
      }
      if (!t.closest('.search')) document.getElementById('search-results').hidden = true;
    });
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (e.key === 'Enter' && t.classList && t.classList.contains('atlas-node')) {
        location.hash = t.getAttribute('data-href');
      }
      if (e.key === 'Escape') {
        closeModal();
        document.getElementById('search-results').hidden = true;
      }
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) {
        e.preventDefault();
        document.getElementById('search').focus();
      }
    });
    var input = document.getElementById('search');
    input.addEventListener('input', function () { search(input.value); });
    input.addEventListener('focus', function () { if (input.value) search(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
      if (e.key === 'Enter') {
        var sel = document.querySelectorAll('.sr-item')[searchSel];
        if (sel) {
          S.scrollMemo[location.hash] = window.scrollY;
          document.getElementById('search-results').hidden = true;
          if (sel.getAttribute('href') === location.hash) route();
          else location.hash = sel.getAttribute('href');
        }
      }
      if (e.key === 'Escape') {
        input.value = '';
        input.blur();
      }
    });
    document.addEventListener('mouseover', function (e) {
      var card = e.target.closest('[data-dec-card], [data-hl]');
      var id = card ? card.getAttribute('data-dec-card') || card.getAttribute('data-hl') : '';
      if (id === bind.hovered) return;
      document.querySelectorAll('.node-hl').forEach(function (n) { n.classList.remove('node-hl'); });
      bind.hovered = id;
      if (id) document.querySelectorAll('.dg-stage [data-dec="' + id + '"]').forEach(function (n) { n.classList.add('node-hl'); });
    });
    var sel = document.getElementById('editor-target');
    sel.value = store('atlas.editor') || 'vscode';
    if (!repoRoot()) {
      sel.disabled = true;
      sel.title = 'Linki do edytora działają tylko po otwarciu z dysku (file://)';
    }
    sel.addEventListener('change', function () {
      store('atlas.editor', sel.value);
      var y = window.scrollY;
      S.pageKey = '';
      route();
      window.scrollTo(0, y);
    });
    document.getElementById('theme-toggle').addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      store('atlas.theme', next);
      applyThemeLabel();
      rerenderAll();
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () {
        if (document.documentElement.getAttribute('data-theme')) return;
        applyThemeLabel();
        rerenderAll();
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
    }
    window.addEventListener('hashchange', route);
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        document.querySelectorAll('.dg').forEach(function (el) {
          var pz = S.panzoom.get(el);
          if (pz) pz.fit();
        });
        if (modalPz) modalPz.fit();
      }, 150);
    });
  }

  load();
  renderSidebar();
  bind();
  applyThemeLabel();
  route();
})();
