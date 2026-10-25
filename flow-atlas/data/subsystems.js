window.ATLAS = window.ATLAS || [];
window.ATLAS.push({
  id: 'subsystems',
  order: 9,
  title: 'Podsystemy: hooki, EventBus, snapshoty, repo-map, kompakcja, evidence',
  tagline: 'Wszystko, co działa obok głównej pętli: kto słucha zdarzeń, co trafia na dysk, co dostaje planner i co się dzieje, gdy któryś z tych elementów zawiedzie.',
  summary: `Ten obszar zbiera **podsystemy pomocnicze**. Żaden z nich nie decyduje o kolejności faz, ale każdy czyta lub zapisuje coś w trakcie runu. Zasada ogólna jest prosta: **prawie każdy podsystem jest best-effort**. Błąd zapisu kończy się ostrzeżeniem (\`warning\`) w transkrypcie, a run idzie dalej. Wyjątki są nieliczne i ważne: brak snapshotu bazowego zatrzymuje run (\`run-baseline-snapshot-missing\`), odmowa hooka \`pre_*\` blokuje akcję, a brak zaufania do hooków nie pozwala wystartować.

**EventBus** (\`src/engine/events/bus.ts\`) to jedno synchroniczne gniazdo. Silnik publikuje \`EngineEvent\`, a sinki (TUI, \`session.jsonl\`, logger, call-evidence, stdout przy \`--json\`/\`--plain\`, hooki) odbierają je po kolei. Wyjątek w jednym sinku nie zatrzymuje pozostałych. Decyzje wymagające odpowiedzi użytkownika idą osobnym kanałem: **callbacki** (\`onApprovalNeeded\`, \`onPlannerReply\` …). Zdarzenia tylko informują, callbacki czekają na odpowiedź.

**Hooki workflow** to polecenia użytkownika z \`hooks:\` w \`.splitbrief/config.yaml\`. Hooki \`pre_*\` (\`pre_planning\`, \`pre_task\`, \`pre_validation\`, \`pre_escalation\`) są wywoływane bezpośrednio w orkiestratorze i mogą zablokować akcję. Hooki \`post_task\`, \`post_validation\`, \`on_halt\`, \`on_complete\`, \`on_error\` uruchamia sink na EventBus, bez czekania (fire-and-forget). Przed każdym uruchomieniem SPLITBRIEF ponownie sprawdza skrót zaufania (\`~/.splitbrief/trust/hooks.json\`).

**Snapshoty** (\`.splitbrief/sessions/<id>/snapshots/\`) zapisują stan projektu: \`run-baseline\` raz na sesję, \`workspace-base\` przy otwarciu workspace, \`post-task-<n>\` po każdym briefie (tylko tryb checkout), \`pre-final-review\` przed review. Na nich opiera się \`/run reject\` w trybie checkout.

**Repo-map** (\`src/engine/codebase/\`) daje plannerowi mapę sygnatur w budżecie tokenów (domyślnie 4000). Pliki są parsowane tree-sitterem, łączone w graf importów i sortowane PageRankiem z personalizacją od plików wymienionych w prośbie. Cache leży w \`.splitbrief/repomap.sqlite\`. Każdy błąd daje pustą mapę i jedno ostrzeżenie; planowanie trwa dalej.

**Kompakcja transkryptu** działa tylko przy **wznowieniu** runu, gdy ustawiono \`workflow.compactionThreshold\`, planner umie się streszczać, a liczba wiadomości przekracza próg. Do \`session.jsonl\` dopisywany jest rekord \`summary\`; oryginalne wiadomości zostają.

**Evidence ledger** (\`evidence.json\`) zbiera dowody: wynik każdego briefu, każdy przebieg checku, zgody i odmowy, każde review, status finalnego review. Obok powstaje \`review-changes.json\` (bajty przed/po dla każdego briefu). Każdy zapis jest pod blokadą pliku; błąd zapisu daje ostrzeżenie, nigdy halt.

Pozostałe elementy: **skille** (blok \`## Active Project Skills\` dla każdego seatu), **logger** (\`.splitbrief/logs/debug.log\`, domyślnie wyłączony w buildzie), **wygaśnięcie sesji** planera (jedno ponowienie na świeżej sesji), **wykrywanie zmian** (implementer, który nic nie zapisał, przegrywa próbę), **załączniki @plik**, **budowa Summary** (tokeny i koszt), **pricing** (CLI nigdy nie ma ceny; API przez models.dev lub tabelę wbudowaną), **gitignore bookkeeping** i **scalanie katalogów modeli**.`,
  entry: [
    'src/engine/orchestrator/run/init-sinks.ts:27',
    'src/cli/hook-trust-prompt.ts:40',
    'src/engine/hooks/run-pre.ts:11',
    'src/engine/orchestrator/run/snapshots.ts:23',
    'src/engine/codebase/repomap.ts:29',
    'src/engine/orchestrator/resume-context.ts:34',
    'src/core/evidence/ledger-storage.ts:30',
    'src/engine/orchestrator/run/skills-context.ts:73'
  ],
  links: [
    { to: 'startup', label: 'bootstrap wywołuje zaufanie hooków (ensureHooksTrusted) i initLogger' },
    { to: 'planning', label: 'repo-map, skille i odmowy z ledgera trafiają do promptu planera; hook pre_planning bramkuje pierwsze wywołanie' },
    { to: 'build', label: 'hooki pre_task / pre_validation pomijają brief; snapshoty post-task; evidence każdego briefu; wykrywanie zmian implementera' },
    { to: 'review', label: 'ledger, review-changes.json i snapshot pre-final-review zasilają review; review packet czyta ledger' },
    { to: 'recovery', label: 'pre_escalation deny podnosi halt retry-exhausted; on_halt odpala się na recovery_prompted' },
    { to: 'lifecycle', label: 'session.jsonl i replay, kompakcja przy resume, /run reject na snapshotach, evidence przy zamknięciu runu' },
    { to: 'runners', label: 'publishRunnerCallEvent rzutuje zdarzenia wywołań; pricing i models.dev wyceniają tokeny; wygaśnięcie sesji planera' },
    { to: 'ui', label: 'TUI sink (addEvent) przenosi zdarzenia z EventBus do store-ów' }
  ],
  diagrams: [
    {
      id: 'ss-eventbus-fanout',
      title: 'EventBus: jedno publish, wiele sinków',
      caption: 'Silnik woła bus.publish. Każdy sink dostaje zdarzenie po kolei, w kolejności rejestracji. Błąd sinka jest połykany. Każdy zewnętrzny konsument najpierw przycina i redaguje zdarzenie (boundEngineEventForConsumer).',
      mermaid: `flowchart LR
  PUB["Silnik: bus.publish(EngineEvent)"] --> SS_BUS_SINK_SET{"Które sinki są podpięte?"}
  SS_BUS_SINK_SET -->|"opts.tuiSink"| TUI["TUI sink: addEvent"]
  SS_BUS_SINK_SET -->|"zawsze"| JSONL["JSONL sink"]
  SS_BUS_SINK_SET -->|"zawsze"| LOG["Logger sink"]
  SS_BUS_SINK_SET -->|"zawsze"| CE["Call-evidence sink"]
  SS_BUS_SINK_SET -->|"--json"| SJ["stdout NDJSON"]
  SS_BUS_SINK_SET -->|"--plain"| ST["stdout linie + stderr warning/info"]
  SS_BUS_SINK_SET -->|"config.hooks"| HK["Hook sink"]
  TUI --> STORES["Store-y: events, tasks, tokens, lifecycle, operations"]
  JSONL --> SS_JSONL_WRITE{"Typ wyłączony z logu?"}
  SS_JSONL_WRITE -->|"text delta, heartbeat, tool-use delta"| DROP["Pominięte"]
  SS_JSONL_WRITE -->|"inne"| SS_BOUND_EVENT{"Po przycięciu mieści się i parsuje?"}
  SS_BOUND_EVENT -->|"tak"| FILE["session.jsonl"]
  SS_BOUND_EVENT -->|"nie"| OMIT["warning payload_omitted"]
  FILE -->|"zapis nieudany"| DEG["Jedno warning session_log_degraded, run trwa"]
  LOG --> SS_LOGGER_ENABLED{"Logger włączony?"}
  SS_LOGGER_ENABLED -->|"tak"| DBG[".splitbrief/logs/debug.log"]
  SS_LOGGER_ENABLED -->|"nie"| NOP["Nic"]
  CE --> MEM["Pamięć: runner_call_* dla Summary"]
  HK --> SS_HOOK_EVENT_MAP{"Zdarzenie mapuje się na hook?"}
  SS_HOOK_EVENT_MAP -->|"task_completed"| PT["post_task"]
  SS_HOOK_EVENT_MAP -->|"checks_run"| PV["post_validation"]
  SS_HOOK_EVENT_MAP -->|"recovery_prompted"| OH["on_halt"]
  SS_HOOK_EVENT_MAP -->|"workflow_complete"| OC["on_complete"]
  SS_HOOK_EVENT_MAP -->|"error"| OE["on_error"]
  SS_HOOK_EVENT_MAP -->|"inne"| IGN["Ignorowane"]`
    },
    {
      id: 'ss-hooks-lifecycle',
      title: 'Hooki w cyklu runu: zaufanie, bramki pre_*, sink post/on',
      caption: 'Zaufanie sprawdza bootstrap przed startem. Hooki pre_* są wołane w czterech miejscach orkiestratora i mogą zablokować akcję. Hooki post/on odpala sink EventBus bez czekania.',
      mermaid: `flowchart TD
  START["splitbrief start / spec / TUI mount"] --> SS_HOOK_TRUST_START{"Hooki zaufane na tej maszynie?"}
  SS_HOOK_TRUST_START -->|"brak hooków lub receipt pasuje"| RUN["Run startuje"]
  SS_HOOK_TRUST_START -->|"--allow-hooks"| GRANT["Disclosure na stderr, zapis receipt"]
  SS_HOOK_TRUST_START -->|"TTY, odpowiedź y"| GRANT
  SS_HOOK_TRUST_START -->|"brak TTY bez flagi"| REF1["Błąd: Re-run with --allow-hooks, exit 1"]
  SS_HOOK_TRUST_START -->|"odpowiedź inna niż y"| REF2["Refusing to run with untrusted hooks, exit 1"]
  SS_HOOK_TRUST_START -->|"symlink do skryptu"| REF3["hook target is not trust-eligible, exit 1"]
  GRANT --> RUN
  RUN --> SS_HOOK_PRE_PLANNING_GATE{"pre_planning pozwala?"}
  SS_HOOK_PRE_PLANNING_GATE -->|"tak lub już był w tym procesie"| PLAN["Pierwsze wywołanie planera"]
  SS_HOOK_PRE_PLANNING_GATE -->|"nie"| CANC["warning pre_planning blocked, planowanie kończy się outcome cancelled"]
  PLAN --> TASK["Brief N"]
  TASK --> SS_HOOK_PRE_TASK_DENY{"pre_task pozwala?"}
  SS_HOOK_PRE_TASK_DENY -->|"nie"| SKIP["skipBrief: cofnij pliki, SKIP_TASK, task_skipped"]
  SS_HOOK_PRE_TASK_DENY -->|"tak"| IMPL["Implementer"]
  IMPL --> SS_HOOK_PRE_VALIDATION_DENY{"pre_validation pozwala?"}
  SS_HOOK_PRE_VALIDATION_DENY -->|"nie"| SKIP
  SS_HOOK_PRE_VALIDATION_DENY -->|"tak"| CHK["Checki briefu, potem checks_run"]
  CHK -->|"retry wyczerpane"| SS_HOOK_PRE_ESCALATION_DENY{"pre_escalation pozwala?"}
  SS_HOOK_PRE_ESCALATION_DENY -->|"nie"| HALT["Recovery retry-exhausted z escalationBlockedBy"]
  SS_HOOK_PRE_ESCALATION_DENY -->|"tak"| CONS["Konsultacja planera"]
  CHK -->|"zielone"| DONE["task_completed"]
  SKIP --> NEXT["Brief N+1"]
  DONE --> NEXT
  DONE -.->|"sink, bez czekania"| POST["post_task"]
  CHK -.->|"sink"| POSTV["post_validation"]
  HALT -.->|"recovery_prompted"| ONH["on_halt"]`
    },
    {
      id: 'ss-hook-exec',
      title: 'Jedno uruchomienie hooka: od trust recheck do outcome',
      caption: 'runTrustedHook sprawdza zaufanie, podstawia pola zdarzenia, uruchamia proces bez powłoki i tłumaczy wynik na allow / deny / warn / crash. Polityka on_failure obsługuje awarie, nie jawne deny.',
      mermaid: `flowchart TD
  A["Hook do uruchomienia"] --> SS_HOOK_TRUST_RECHECK{"Digest konfiguracji i skryptów nadal zaufany?"}
  SS_HOOK_TRUST_RECHECK -->|"nie"| DENYT["deny: hook configuration or hook files changed after trust"]
  SS_HOOK_TRUST_RECHECK -->|"tak"| SUB["Podstawienie event.pole w args, redakcja i limity"]
  SUB --> SS_HOOK_ARG_GUARD{"Arg zaczyna się od placeholdera, a wartość od minusa?"}
  SS_HOOK_ARG_GUARD -->|"tak, pierwszy raz"| DD["Wstaw -- przed tym argumentem"]
  SS_HOOK_ARG_GUARD -->|"nie"| SPAWN["spawn bez shell, cwd = projectDir, stdin = JSON"]
  DD --> SPAWN
  SPAWN --> SS_HOOK_SPAWN_ERROR{"Jak skończył się proces?"}
  SS_HOOK_SPAWN_ERROR -->|"timeout_ms minął"| FAIL["Awaria"]
  SS_HOOK_SPAWN_ERROR -->|"ENOENT"| WARNNF["warn: hook command not found"]
  SS_HOOK_SPAWN_ERROR -->|"inny wyjątek"| CRASH["crash"]
  SS_HOOK_SPAWN_ERROR -->|"zakończony, dowolny kod"| SS_HOOK_OUTCOME{"Co jest na stdout i jaki exit code?"}
  SS_HOOK_OUTCOME -->|"zniekształcony JSON"| FAIL
  SS_HOOK_OUTCOME -->|"decision deny"| DENY["deny"]
  SS_HOOK_OUTCOME -->|"decision warn"| WARN["warn"]
  SS_HOOK_OUTCOME -->|"brak lub allow, exit 0"| ALLOW["allow"]
  SS_HOOK_OUTCOME -->|"brak lub allow, exit nie 0"| FAIL
  FAIL --> SS_HOOK_FAILURE_POLICY{"on_failure?"}
  SS_HOOK_FAILURE_POLICY -->|"block"| DENY
  SS_HOOK_FAILURE_POLICY -->|"warn, domyślne"| WARN
  SS_HOOK_FAILURE_POLICY -->|"ignore"| ALLOW
  DENY --> KIND["Rodzaj hooka: pre czy post"]
  WARN --> KIND
  ALLOW --> KIND
  CRASH --> KIND
  WARNNF --> KIND
  DENYT --> KIND
  KIND -->|"pre_*"| SS_HOOK_PRE_LOOP{"runPreHooks: przerwać?"}
  KIND -->|"post_* / on_*"| SS_HOOK_POST_REPORT{"Co pokazać jako warning?"}
  SS_HOOK_PRE_LOOP -->|"deny lub crash z block"| BLOCK["allow false, reszta hooków pominięta"]
  SS_HOOK_PRE_LOOP -->|"allow / warn / crash bez block"| CONT["Następny hook, ostrzeżenia nie są publikowane"]
  SS_HOOK_POST_REPORT -->|"crash, warn z message, deny"| PW["warning na EventBus"]
  SS_HOOK_POST_REPORT -->|"allow"| SIL["Nic, stderr też nie"]`
    },
    {
      id: 'ss-repomap-build',
      title: 'Budowa repo-mapy dla promptu planera',
      caption: 'planTurnText woła buildRepoMap na każdą turę planowania. Pipeline: odkrycie plików, parsowanie z cache SQLite, graf importów, PageRank z personalizacją, przycięcie do budżetu. Każdy wyjątek daje pustą mapę i warning.',
      mermaid: `flowchart TD
  A["planTurnText: nowa tura planowania"] --> SS_REPOMAP_ENABLED{"codebase.enabled nie jest false?"}
  SS_REPOMAP_ENABLED -->|"false"| NOMAP["Brak sekcji Repository Map"]
  SS_REPOMAP_ENABLED -->|"tak"| INIT["initParser, mkdir .splitbrief"]
  INIT --> SS_REPOMAP_CACHE_OPEN{"Czy repomap.sqlite się otwiera?"}
  SS_REPOMAP_CACHE_OPEN -->|"tak"| DISC["discoverFiles: znane rozszerzenia, include, exclude"]
  SS_REPOMAP_CACHE_OPEN -->|"brak natywnego better-sqlite3"| NOC["Tryb bez cache + notice"]
  SS_REPOMAP_CACHE_OPEN -->|"SQLITE_CORRUPT / NOTADB"| RESET["Usuń db, -shm, -wal; otwórz ponownie; warning"]
  SS_REPOMAP_CACHE_OPEN -->|"inny błąd"| FAILALL["Wyjątek"]
  NOC --> DISC
  RESET --> DISC
  DISC -->|"0 plików"| EMPTY["Pusta mapa"]
  DISC --> SS_REPOMAP_FILE_FILTER{"Plik do parsowania?"}
  SS_REPOMAP_FILE_FILTER -->|"powyżej 100 KB lub błąd stat"| SKIPF["Pominięty"]
  SS_REPOMAP_FILE_FILTER -->|"tak"| SS_REPOMAP_CACHE_HIT{"Wiersz cache: mtime, size, parse_version zgodne?"}
  SS_REPOMAP_CACHE_HIT -->|"tak"| HIT["Symbole i importy z cache"]
  SS_REPOMAP_CACHE_HIT -->|"nie"| PARSE["tree-sitter, upsert wiersza"]
  PARSE -->|"gramatyka nie ładuje się"| NAMEONLY["Plik bez symboli, tylko nazwa"]
  HIT --> GRAPH["Graf: tylko importy względne"]
  PARSE --> GRAPH
  NAMEONLY --> GRAPH
  GRAPH --> SS_REPOMAP_FOCUS{"Prośba wymienia istniejące pliki?"}
  SS_REPOMAP_FOCUS -->|"tak"| PERS["Teleport tylko do tych plików"]
  SS_REPOMAP_FOCUS -->|"nie"| UNI["Teleport równomierny"]
  PERS --> PR["PageRank: d 0.85, max 100 iteracji"]
  UNI --> PR
  PR --> SS_REPOMAP_BUDGET{"Blok pliku mieści się w budżecie?"}
  SS_REPOMAP_BUDGET -->|"pierwszy plik zawsze"| OUT["Dołączony"]
  SS_REPOMAP_BUDGET -->|"tak"| OUT
  SS_REPOMAP_BUDGET -->|"nie"| NEXTF["Pominięty, mniejszy może wejść"]
  OUT --> PROMPT["Sekcja Repository Map w prompcie"]
  FAILALL --> SS_REPOMAP_FAIL{"Złapane w buildRepoMap"}
  SS_REPOMAP_FAIL --> WARN["warning: Repo-map unavailable, planowanie trwa"]`
    },
    {
      id: 'ss-compaction-trigger',
      title: 'Kompakcja i odbudowa kontekstu planera przy wznowieniu',
      caption: 'initializeWorkflow przy wznowionym runie bez otwartego recovery próbuje kompakcji. Potem, gdy seat nie może wznowić swojego wątku, planner dostaje odbudowany transkrypt.',
      mermaid: `flowchart TD
  A["initializeWorkflow, savedState istnieje"] --> REC["Sprawdź: otwarte recovery"]
  REC -->|"tak"| SKIPALL["Bez kompakcji i odbudowy"]
  REC -->|"nie"| SS_COMPACT_TRIGGER{"Próg ustawiony, planner się streszcza, wiadomości ponad próg?"}
  SS_COMPACT_TRIGGER -->|"nie"| SS_REBUILD_CONTEXT{"Seat zmieniony, brak resume lub brak plannerSessionId?"}
  SS_COMPACT_TRIGGER -->|"tak"| SS_COMPACT_FORMAT{"Format?"}
  SS_COMPACT_FORMAT -->|"auto i planner api / structured"| STR["structured"]
  SS_COMPACT_FORMAT -->|"auto i inny / freeform"| FREE["freeform"]
  STR --> SS_COMPACT_KEEP{"Coś do streszczenia po zostawieniu ostatnich?"}
  FREE --> SS_COMPACT_KEEP
  SS_COMPACT_KEEP -->|"nie"| SS_REBUILD_CONTEXT
  SS_COMPACT_KEEP -->|"tak"| CALL["planner.summarize / summarizeStructured"]
  CALL --> SS_COMPACT_STRUCT_FALLBACK{"Structured zwrócił poprawny JSON?"}
  SS_COMPACT_STRUCT_FALLBACK -->|"tak lub freeform"| APP["Dopisz rekord summary do session.jsonl, zaksięguj tokeny"]
  SS_COMPACT_STRUCT_FALLBACK -->|"nie"| FB["Zapisz tekst jako freeform + warning"]
  FB --> APP
  CALL -->|"wyjątek"| SS_COMPACT_FAIL{"Abort?"}
  SS_COMPACT_FAIL -->|"tak"| QUIET["Bez komunikatu"]
  SS_COMPACT_FAIL -->|"nie"| WF["warning: Transcript auto-compaction failed"]
  APP --> SS_REBUILD_CONTEXT
  QUIET --> SS_REBUILD_CONTEXT
  WF --> SS_REBUILD_CONTEXT
  SS_REBUILD_CONTEXT -->|"tak"| RB["buildResumeContext: summary + wiadomości po nim"]
  SS_REBUILD_CONTEXT -->|"nie"| NATIVE["Planner wznawia natywny wątek"]
  RB --> PRIOR["resumeHolder.messages = priorMessages"]
  NATIVE --> CALL2["Wywołanie planera"]
  PRIOR --> CALL2
  CALL2 --> SS_SESSION_REISSUE{"Wątek wygasł lub odrzucony jako za długi?"}
  SS_SESSION_REISSUE -->|"tak, wątek był wznawiany"| RE["warning + jedno ponowienie na świeżej sesji z transkryptem"]
  SS_SESSION_REISSUE -->|"nie"| OK["Wynik lub błąd do wywołującego"]`
    },
    {
      id: 'ss-snapshots-timeline',
      title: 'Snapshoty w trakcie runu',
      caption: 'Kiedy powstaje który snapshot i co się dzieje przy błędzie. Snapshoty zawsze opisują katalog projektu (checkout), nigdy worktree.',
      mermaid: `flowchart TD
  A["Plan zatwierdzony, ready-for-tasks"] --> SS_SNAP_BASELINE{"Sesja ma już baseline?"}
  SS_SNAP_BASELINE -->|"tak, resume"| WSQ["Sprawdź state.workspace"]
  SS_SNAP_BASELINE -->|"nie"| SS_SNAP_CREATE_BRANCH{"Pierwszy snapshot sesji?"}
  SS_SNAP_CREATE_BRANCH -->|"tak"| FULL["baseline: pełna kopia wszystkich plików"]
  SS_SNAP_CREATE_BRANCH -->|"nie"| DIFF["Tylko pliki z innym hashem lub trybem niż baseline"]
  FULL --> CHECKB["Sprawdź hasBaseline po próbie"]
  CHECKB -->|"nie"| STOP["throw run-baseline-snapshot-missing, run kończy się błędem"]
  CHECKB -->|"tak"| WSQ
  WSQ -->|"nie"| WB["Snapshot workspace-base, open isolation, RECORD_WORKSPACE"]
  WSQ -->|"tak"| REOPEN["Otwórz ten sam workspace albo throw run-workspace-moved"]
  WB --> LOOP["Pętla briefów"]
  REOPEN --> LOOP
  LOOP -->|"brief się rozstrzygnął"| SS_SNAP_CHECKOUT_ONLY{"workspace.kind = checkout?"}
  SS_SNAP_CHECKOUT_ONLY -->|"tak"| PT["post-task-n do run-ledger.json"]
  SS_SNAP_CHECKOUT_ONLY -->|"nie"| NOSNAP["Nic"]
  PT --> SS_SNAP_LOCK{"Blokada snapshotu wolna?"}
  SS_SNAP_LOCK -->|"zajęta przez żywy proces"| WARNL["warning snapshot failed, run trwa"]
  SS_SNAP_LOCK -->|"wolna lub stara ponad 60 s"| SS_SNAP_LEDGER_SEALED{"Ledger już accepted lub rejected?"}
  SS_SNAP_LEDGER_SEALED -->|"tak"| NOREC["Snapshot jest, ledger bez zmian"]
  SS_SNAP_LEDGER_SEALED -->|"nie"| REC["Ledger: nowy runSnapshotId"]
  LOOP -->|"pętla skończona"| SS_SNAP_PRE_REVIEW{"Status complete i faza implementing lub final-review?"}
  SS_SNAP_PRE_REVIEW -->|"tak"| PFR["pre-final-review, potem final review"]
  SS_SNAP_PRE_REVIEW -->|"nie"| SUMM["Summary, bez review"]
  PFR --> REST["finally: snapshot spoczynku post-task w trybie checkout"]
  SUMM --> REST`
    },
    {
      id: 'ss-evidence-run',
      title: 'Zapisy do evidence ledger w trakcie runu',
      caption: 'Kolejność zapisów do evidence.json i review-changes.json. Każda strzałka do Ledger przechodzi przez mutateEvidenceLedger pod blokadą pliku; błąd daje warning.',
      mermaid: `sequenceDiagram
  participant Plan as Planowanie
  participant Brief as Pętla briefów
  participant Rev as Review
  participant Close as Zamknięcie
  participant L as evidence.json
  participant RC as review-changes.json
  participant P as Planer prompt
  L->>P: odmowy z ledgera jako Previous rejections (feedRejectionsToPlanner)
  Plan->>L: approvals z plan card (tylko confirmApprovals)
  Brief->>L: approval / rejection zapisu do chronionej ścieżki
  Brief->>L: checks[] po checkach briefu (recordCheckRuns)
  Brief->>L: status, retries, durationMs, changedFiles (local lub retry)
  Brief->>RC: pary przed/po plików briefu po zaliczeniu
  Brief->>L: skipped z keptFiles po deny hooka lub skip
  Rev->>L: checks[] checków task i plan przed review (plan na ostatnim briefie)
  Rev->>L: checks[] checków reviewera i triage
  Rev->>L: reviews[] po każdym werdykcie
  Rev->>L: finalReview status written / failed
  Rev->>Rev: writeReviewPacket czyta ledger i review-changes
  Close->>L: persistStoppedBriefEvidence po CLOSE_RUN`
    },
    {
      id: 'ss-skills-context',
      title: 'Blok skilli dla seatów',
      caption: 'buildSkillsContext raz na proces buduje blok Active Project Skills dla planera, implementera i reviewera.',
      mermaid: `flowchart TD
  A["initializeWorkflow"] --> SS_SKILLS_SOURCE{"Skąd lista skilli?"}
  SS_SKILLS_SOURCE -->|"wybrane w tym procesie"| SEL["opts.selectedSkills"]
  SS_SKILLS_SOURCE -->|"wznowienie"| PERS["state.selectedSkills: odkryj i dopasuj id"]
  SS_SKILLS_SOURCE -->|"brak"| NONE["Brak bloku"]
  PERS -->|"id nie znalezione"| W1["warning skills_unresolved, pominięte"]
  PERS --> DISC["discoverSkills"]
  DISC --> SS_SKILLS_DEDUPE{"Ten sam id lub name już był, albo skill orkiestracji?"}
  SS_SKILLS_DEDUPE -->|"tak"| DROPS["Odrzucony"]
  SS_SKILLS_DEDUPE -->|"nie"| KEEP["Zachowany"]
  SEL --> SS_SKILLS_REACH{"Gdzie seat czyta skill?"}
  KEEP --> SS_SKILLS_REACH
  SS_SKILLS_REACH -->|"global w projekcie"| PROJ["Jak projektowy, ścieżka względna"]
  SS_SKILLS_REACH -->|"projektowy, git-ignored"| GLOB["Jak globalny: ścieżka absolutna + skillRoots"]
  SS_SKILLS_REACH -->|"bez zmian"| AS["Bez zmian"]
  PROJ --> SS_SKILLS_BUDGET{"Treść mieści się w 16000 znaków?"}
  GLOB --> SS_SKILLS_BUDGET
  AS --> SS_SKILLS_BUDGET
  SS_SKILLS_BUDGET -->|"tak"| INL["SKILL.md i references w całości"]
  SS_SKILLS_BUDGET -->|"nie"| NAMED["Nazwany ścieżką, warning skills_truncated"]
  INL --> BLOCK["Active Project Skills w promptach seatów"]
  NAMED --> BLOCK`
    }
  ],
  decisions: [
    {
      id: 'SS_HOOK_TRUST_START',
      title: 'Zaufanie do hooków przed startem',
      question: 'Czy ta maszyna ufa hookom z konfiguracji, a jeśli nie, jak ma zapaść zgoda?',
      where: 'src/cli/hook-trust-prompt.ts:40',
      inputs: ['config.hooks', 'flaga `--allow-hooks`', '`process.stdin.isTTY`', 'receipt w `~/.splitbrief/trust/hooks.json`', 'digest konfiguracji i skryptów'],
      branches: [
        { if: 'brak `hooks` w konfiguracji', then: 'nic do sprawdzenia, start' },
        { if: 'skrypt hooka jest symlinkiem (hookTrustIneligibility)', then: 'błąd `hook target is not trust-eligible…`, exit 1; nawet `--allow-hooks` nie pomaga' },
        { if: 'receipt dla tego checkoutu i digest się zgadzają', then: 'start bez pytania' },
        { if: '`--allow-hooks`', then: 'disclosure na stderr (log CI zapisuje, co zatwierdzono), zapis receipt, start' },
        { if: 'brak TTY i brak flagi', then: 'błąd `Hook config is not trusted and no TTY available…`, exit 1' },
        { if: 'TTY: pytanie `Trust these hooks for this project? [y/N]`, odpowiedź `y`/`yes`', then: 'zapis receipt, start' },
        { if: 'inna odpowiedź lub EOF', then: 'błąd `Refusing to run with untrusted hooks…`, exit 1' }
      ],
      default: 'Bez zgody run nie startuje.',
      notes: 'Woła to bootstrapStoresHooks (src/cli/bootstrap/init.ts:22) i `splitbrief spec` (src/cli/commands/spec.ts:123). Disclosure pokazuje komendę, rozwiązaną ścieżkę i argv, nigdy `name:`. Receipt jest kluczowany kanoniczną ścieżką checkoutu, więc klon lub kopia pytają ponownie.'
    },
    {
      id: 'SS_HOOK_TRUST_RECHECK',
      title: 'Ponowne sprawdzenie zaufania przed każdym hookiem',
      question: 'Czy konfiguracja i pliki hooków są nadal bajt w bajt tymi, którym zaufano?',
      where: 'src/engine/hooks/dispatch.ts:28',
      inputs: ['projectDir', 'config.hooks', 'hashHooksConfig (src/core/hooks/trust-digest.ts:44)', 'receipt'],
      branches: [
        { if: 'cel hooka niekwalifikowalny (symlink)', then: 'odmowa z nazwą celu' },
        { if: 'digest = receipt', then: 'null, hook może ruszyć' },
        { if: 'digest inny (zmieniony config, skrypt, skrypt package.json)', then: 'odmowa `hook configuration or hook files changed after trust; re-run with --allow-hooks or approve hooks again`', next: 'SS_HOOK_PRE_LOOP' }
      ],
      default: 'Odmowa jest traktowana jak `deny`.',
      notes: 'Sprawdzenie robi runPreHooks (raz na zdarzenie) i runTrustedHook (przed każdym wpisem), a sink robi je raz na zdarzenie. Edycja skryptu hooka w trakcie runu zamienia każdy kolejny pre_task w deny.'
    },
    {
      id: 'SS_HOOK_PRE_LOOP',
      title: 'Sekwencyjne hooki pre_* jednego zdarzenia',
      question: 'Czy któryś hook pre_* zablokował akcję?',
      where: 'src/engine/hooks/run-pre.ts:11',
      inputs: ['lista wpisów dla zdarzenia', 'HookOutcome każdego wpisu', 'on_failure wpisu'],
      branches: [
        { if: 'brak wpisów dla zdarzenia', then: '`allow: true`' },
        { if: 'odmowa zaufania (SS_HOOK_TRUST_RECHECK)', then: '`allow: false` z powodem odmowy' },
        { if: 'wpis zwrócił `deny`', then: '`allow: false`, reszta wpisów pominięta' },
        { if: 'wpis zwrócił `crash` i `on_failure: block`', then: '`allow: false`' },
        { if: 'allow / warn / crash bez block', then: 'następny wpis; stderr i komunikat trafiają do tablicy `warnings`' }
      ],
      default: 'Po wszystkich wpisach `allow: true`.',
      notes: 'Wpisy biegną po kolei w kolejności z YAML. Tablicy `warnings` żadne miejsce wywołania nie publikuje (pre-task.ts, pre-validation-gate.ts, phases.ts, handle.ts czytają tylko `allow` i `reason`), więc ostrzeżenia hooków pre_* są niewidoczne.'
    },
    {
      id: 'SS_HOOK_SPAWN_ERROR',
      title: 'Jak zakończył się proces hooka',
      question: 'Czy proces hooka w ogóle się wykonał i jak się skończył?',
      where: 'src/engine/hooks/dispatch.ts:62',
      inputs: ['wynik spawnWithTimeout', '`timeout_ms`', 'kod błędu Node'],
      branches: [
        { if: '`result.timedOut`', then: 'awaria `hook timed out after <ms>ms`', next: 'SS_HOOK_FAILURE_POLICY' },
        { if: 'ENOENT (brak komendy)', then: '`warn: hook command not found` niezależnie od on_failure' },
        { if: 'wyjątek z kodem wyjścia', then: 'interpretacja stdout i kodu', next: 'SS_HOOK_OUTCOME' },
        { if: 'inny wyjątek', then: '`crash` z komunikatem' },
        { if: 'proces skończył się normalnie', then: 'interpretacja', next: 'SS_HOOK_OUTCOME' }
      ],
      default: 'Interpretacja wyjścia.',
      notes: 'Hook startuje bez `shell: true`, w `cwd: projectDir` (checkout, nie worktree), z JSON-em `{ event, workspaceDir, context }` na stdin. Hooki nie trafiają do rejestru PID runnera (`ledger: false`).'
    },
    {
      id: 'SS_HOOK_OUTCOME',
      title: 'Interpretacja stdout i kodu wyjścia hooka',
      question: 'Co hook odpowiedział?',
      where: 'src/engine/hooks/dispatch.ts:97',
      inputs: ['stdout (cały lub ostatnia linia z obiektem JSON)', 'exit code', 'HookCommandResponseSchema'],
      branches: [
        { if: 'linia wygląda na obiekt JSON, ale nie parsuje się lub ma złe pola', then: 'awaria `malformed hook response…`', next: 'SS_HOOK_FAILURE_POLICY' },
        { if: 'brak obiektu JSON i exit 0', then: '`allow`' },
        { if: 'brak obiektu JSON i exit różny od 0', then: 'awaria `command exited with code N`', next: 'SS_HOOK_FAILURE_POLICY' },
        { if: '`decision: deny`', then: '`deny` (niezależnie od on_failure i kodu)' },
        { if: '`decision: warn`', then: '`warn`' },
        { if: '`decision: allow` lub brak decision, exit 0', then: '`allow`' },
        { if: '`decision: allow`, exit różny od 0', then: 'awaria', next: 'SS_HOOK_FAILURE_POLICY' }
      ],
      default: '`allow` przy pustym stdout i exit 0.',
      notes: 'Parser szuka od końca pierwszej linii zaczynającej się od `{`, więc hook może najpierw logować tekst.'
    },
    {
      id: 'SS_HOOK_FAILURE_POLICY',
      title: 'Polityka on_failure',
      question: 'Jak potraktować awarię hooka (timeout, zły kod, zły JSON)?',
      where: 'src/engine/hooks/dispatch.ts:174',
      inputs: ['`on_failure` wpisu (domyślnie `warn`)'],
      branches: [
        { if: '`block`', then: '`deny` z komunikatem awarii' },
        { if: '`ignore`', then: '`allow`' },
        { if: '`warn`', then: '`warn` z komunikatem awarii' }
      ],
      default: '`warn`.',
      notes: 'Polityka nie dotyczy jawnego `decision: deny` ani ENOENT. Na hooku post_* `block` daje tylko informacyjny warning.'
    },
    {
      id: 'SS_HOOK_ARG_GUARD',
      title: 'Ochrona przed wartością zaczynającą się od minusa',
      question: 'Czy podstawiona wartość mogłaby zostać odczytana jako opcja komendy?',
      where: 'src/engine/hooks/dispatch.ts:83',
      inputs: ['szablony `args`', 'wartości pól zdarzenia'],
      branches: [
        { if: 'szablon zaczyna się od `${event.…}` i wartość zaczyna się od `-`, pierwszy raz', then: 'przed tym argumentem wstawiany jest `--`' },
        { if: 'inaczej', then: 'argument bez zmian' }
      ],
      default: 'Argumenty bez `--`.',
      notes: 'Podstawienie (src/engine/hooks/substitute.ts:11): brak pola daje pusty string, obiekt i tablica dają JSON, wartość jest redagowana i przycięta limitem `hooks`. Brak eval.'
    },
    {
      id: 'SS_HOOK_SCHEMA',
      title: 'Walidacja wpisu hooka przy ładowaniu konfiguracji',
      question: 'Czy wpis hooka może w ogóle się załadować?',
      where: 'src/core/schemas/hooks.ts:311',
      inputs: ['command', 'args', 'timeout_ms', 'zdarzenie'],
      branches: [
        { if: '`command` to powłoka po basename (`bash`, `/usr/bin/sh`, `env`, `pwsh` …)', then: 'błąd ładowania `inline shell … is not allowed`' },
        { if: 'arg to `-c`, klaster z `c`, `/c`, `--command` albo powłoka', then: 'błąd ładowania' },
        { if: '`npx` / `npm exec` z `--call` w regionie opcji menedżera', then: 'błąd ładowania' },
        { if: '`timeout_ms` ponad 300000', then: 'błąd ładowania' },
        { if: 'niepusta lista `pre_commit` lub `post_commit` (src/core/schemas/hooks.ts:366)', then: 'błąd ładowania `… hooks were removed — SPLITBRIEF no longer commits`' },
        { if: 'pusta lista `pre_commit` / `post_commit`', then: 'ładuje się i jest usuwana' }
      ],
      default: 'Wpis ładuje się z `kind: command`, `timeout_ms: 30000`, `on_failure: warn`.'
    },
    {
      id: 'SS_HOOK_EVENT_MAP',
      title: 'Które zdarzenia odpalają hooki post/on',
      question: 'Czy to zdarzenie z EventBus ma przypisany hook?',
      where: 'src/engine/hooks/sink.ts:105',
      inputs: ['`event.type`'],
      branches: [
        { if: '`task_completed`', then: '`post_task`' },
        { if: '`checks_run`', then: '`post_validation`' },
        { if: '`recovery_prompted`', then: '`on_halt`' },
        { if: '`workflow_complete`', then: '`on_complete`' },
        { if: '`error`', then: '`on_error`' }
      ],
      default: 'Brak hooka; zdarzenie ignorowane.',
      notes: 'Sink woła `void runEntriesAndReport(...)` i nie czeka (src/engine/hooks/sink.ts:20). `task_completed` publikuje tylko zaliczony brief (src/engine/orchestrator/task/commit.ts:102), więc `post_task` nie odpala się dla pominiętego ani nieudanego briefu.'
    },
    {
      id: 'SS_HOOK_POST_REPORT',
      title: 'Co hook post/on pokazuje użytkownikowi',
      question: 'Jaki warning opublikować po hooku post_* / on_*?',
      where: 'src/engine/hooks/sink.ts:24',
      inputs: ['HookOutcome'],
      branches: [
        { if: '`crash`', then: 'warning `[hook <event> <label>] crashed: …`' },
        { if: '`warn` z komunikatem', then: 'warning z komunikatem' },
        { if: '`deny`', then: 'warning `denied (post-hook deny is informational only)`' },
        { if: '`allow`', then: 'nic' },
        { if: 'odmowa zaufania przed pętlą', then: 'jeden warning `[hook <event>] …`, żaden wpis nie rusza' }
      ],
      default: 'Brak komunikatu.',
      notes: 'Pole `stderr` z outcome nie jest nigdzie publikowane, także tu.'
    },
    {
      id: 'SS_HOOK_PRE_PLANNING_GATE',
      title: 'Bramka pre_planning',
      question: 'Czy pierwsze prawdziwe wywołanie planera w tym procesie może ruszyć?',
      where: 'src/engine/orchestrator/run/phases.ts:81',
      inputs: ['`hookRan` (raz na proces)', 'config.hooks', 'payload `workflow_started` z `feature`'],
      branches: [
        { if: 'hook już był w tym procesie lub brak hooków', then: 'true' },
        { if: 'runPreHooks zwraca allow', then: 'true, planowanie rusza' },
        { if: 'runPreHooks zwraca deny', then: 'warning `pre_planning blocked: …`; sesja planowania kończy się `outcome: cancelled` (src/engine/orchestrator/planning/session.ts:318), bez recordFailure' }
      ],
      default: 'true.',
      notes: 'Tura, która tylko odtwarza istniejące artefakty, nie odpala hooka.'
    },
    {
      id: 'SS_HOOK_PRE_TASK_DENY',
      title: 'Bramka pre_task',
      question: 'Czy implementer może zacząć ten brief?',
      where: 'src/engine/orchestrator/task/pre-task.ts:66',
      inputs: ['syntetyczne zdarzenie `task_started` (taskId, title, file, files, action, index, total)'],
      branches: [
        { if: 'allow', then: '`task_started` na EventBus, implementer rusza' },
        { if: 'deny', then: 'warning `pre_task blocked: …`; skipBrief (src/engine/orchestrator/task/skip-brief.ts:26) cofa pliki ze snapshotu startu, zapisuje evidence skipped, `SKIP_TASK`, `task_skipped`; pętla idzie do następnego briefu' }
      ],
      default: 'allow.'
    },
    {
      id: 'SS_HOOK_PRE_VALIDATION_DENY',
      title: 'Bramka pre_validation',
      question: 'Czy checki briefu mogą się uruchomić?',
      where: 'src/engine/orchestrator/task/pre-validation-gate.ts:47',
      inputs: ['payload `validate` z `status: running` i `taskId`'],
      branches: [
        { if: 'brak hooków', then: 'proceed' },
        { if: 'allow', then: 'proceed do checków' },
        { if: 'deny', then: 'warning `pre_validation blocked: …`, skipBrief jak przy pre_task' }
      ],
      default: 'proceed.',
      notes: 'Odpala się tylko, gdy bramka briefu ma checki do uruchomienia (w kadencji `review: end` zwykły brief nie ma checków).'
    },
    {
      id: 'SS_HOOK_PRE_ESCALATION_DENY',
      title: 'Bramka pre_escalation',
      question: 'Czy po wyczerpaniu retry wolno wołać konsultację planera?',
      where: 'src/engine/orchestrator/escalation/handle.ts:343',
      inputs: ['payload `task_escalating`'],
      branches: [
        { if: 'allow', then: '`task_escalating` na EventBus, konsultacja' },
        { if: 'deny', then: 'warning `pre_escalation blocked: …`; recovery `retry-exhausted` z `escalationBlockedBy` i `allowRetryOverride: true`; run czeka na decyzję' }
      ],
      default: 'allow.'
    },
    {
      id: 'SS_BUS_SINK_SET',
      title: 'Które sinki podpina run',
      question: 'Kto będzie słuchał zdarzeń tego runu?',
      where: 'src/engine/orchestrator/run/init-sinks.ts:27',
      inputs: ['opts.tuiSink', 'opts.headless', 'opts.plain', 'opts._eventSink', 'config.hooks'],
      branches: [
        { if: 'bus był użyty przez poprzedni run', then: 'najpierw odpięcie jego sinków' },
        { if: '`opts.tuiSink`', then: 'TUI sink jako pierwszy' },
        { if: 'zawsze', then: 'JSONL, logger, call-evidence' },
        { if: 'headless bez `--plain`', then: 'stdout NDJSON' },
        { if: 'headless z `--plain`', then: 'stdout tekst + sink stderr dla `warning`, `info` i `planner_attachments_dropped`' },
        { if: '`_eventSink` (tylko testy)', then: 'obserwator' },
        { if: '`config.hooks`', then: 'hook sink jako ostatni; `workspaceDir` brany z aktualnego state' }
      ],
      default: 'JSONL + logger + call-evidence.',
      notes: 'Kolejność rejestracji = kolejność fan-out. Wywołanie: src/engine/orchestrator/run/init.ts:221.'
    },
    {
      id: 'SS_BUS_SINK_ISOLATION',
      title: 'Izolacja błędów sinka',
      question: 'Co, jeśli sink rzuci wyjątek?',
      where: 'src/engine/events/bus.ts:10',
      inputs: ['wyjątek sinka'],
      branches: [
        { if: 'sink rzuca', then: 'wyjątek połknięty, kolejne sinki dostają zdarzenie' },
        { if: 'sink subskrybuje lub odpina się w trakcie publish', then: 'bieżące publish używa kopii listy sinków' }
      ],
      default: 'Wszystkie sinki dostają zdarzenie synchronicznie.'
    },
    {
      id: 'SS_BOUND_EVENT',
      title: 'Przycinanie zdarzenia dla konsumenta',
      question: 'Czy zdarzenie po redakcji i przycięciu jest nadal poprawne?',
      where: 'src/engine/events/bound.ts:7',
      inputs: ['zdarzenie', 'kontekst konsumenta (`tui`, `stdout-json`, `stdout-text`, `hooks`, `session-log`)'],
      branches: [
        { if: 'za duże dla kontekstu', then: 'zamiast niego warning `payload-bounds` / `payload_omitted` z tym samym `ts`' },
        { if: 'po normalizacji nie przechodzi EngineEventSchema', then: 'warning `omitted invalid … event`' },
        { if: 'poprawne', then: 'przycięte, zredagowane zdarzenie' }
      ],
      default: 'Przycięte zdarzenie.',
      notes: 'Logika ograniczeń: src/core/payload-bounds.ts. Te same limity dotyczą stdin hooka i podstawianych pól.'
    },
    {
      id: 'SS_JSONL_WRITE',
      title: 'Zapis zdarzenia do session.jsonl',
      question: 'Czy zdarzenie trafia do logu sesji i co, gdy zapis zawodzi?',
      where: 'src/engine/events/sinks/jsonl.ts:39',
      inputs: ['typ zdarzenia', 'wynik appendera (src/core/sessions/log-writer.ts:28)'],
      branches: [
        { if: '`runner_call_text_delta`, `planner_heartbeat`, `runner_call_heartbeat`, `runner_call_tool_use` ze `stage: delta`', then: 'pominięte (src/engine/events/sinks/jsonl.ts:19)' },
        { if: 'wpis za duży lub niepoprawny', then: 'nie zapisany, ostrzeżenie na stderr' },
        { if: 'zapis rzuca (dysk, symlink)', then: 'jeden raz warning `session_log_degraded`; run trwa' },
        { if: 'OK', then: 'linia `kind: event` w `session.jsonl`' }
      ],
      default: 'Zapis linii.',
      notes: 'session.jsonl jest źródłem replay i odbudowy kontekstu, więc zdegradowany log oznacza uboższy transkrypt po wznowieniu.'
    },
    {
      id: 'SS_TYPED_CALL_SILENT',
      title: 'Tekst wywołań typowanych nie trafia do transkryptu',
      question: 'Czy tekst odpowiedzi planera / reviewera pokazać jako transkrypt?',
      where: 'src/engine/orchestrator/run/call-publishing.ts:38',
      inputs: ['rodzaj wywołania (`typedCall` vs `review` / `summarize`)'],
      branches: [
        { if: '`typedCall` (plan, werdykt, wybór checków)', then: '`onOutput` = no-op; zdarzenia `runner_call_*` nadal idą na EventBus' },
        { if: 'inne wywołania', then: '`onCallEvent` publikuje przez publishRunnerCallEvent (src/engine/orchestrator/events.ts:58)' }
      ],
      default: 'Zdarzenia wywołania są publikowane.'
    },
    {
      id: 'SS_LOGGER_ENABLED',
      title: 'Czy logger diagnostyczny pisze',
      question: 'Czy zapisywać `debug.log` i log klawiszy?',
      where: 'src/core/logger.ts:9',
      inputs: ['`SPLITBRIEF_DEBUG`', 'rozszerzenie pliku modułu (`.ts` = dev przez tsx)', '`SPLITBRIEF_DEBUG_KEYS`'],
      branches: [
        { if: '`SPLITBRIEF_DEBUG` ustawione i niepuste', then: 'włączony, chyba że `0` lub `false`' },
        { if: 'brak zmiennej, uruchomienie ze źródeł `.ts`', then: 'włączony' },
        { if: 'brak zmiennej, zbudowany `dist/`', then: 'wyłączony' },
        { if: '`SPLITBRIEF_DEBUG_KEYS` niepuste i nie `0`/`false` (src/core/key-debug.ts:12)', then: 'log klawiszy w `.splitbrief/debug/keys*` albo w katalogu tymczasowym, gdy brak projektu' }
      ],
      default: 'Zbudowany CLI: logger wyłączony.',
      notes: 'Zapis jest redagowany i ignoruje każdy błąd (src/lib/logger.ts:56). Plik: `.splitbrief/logs/debug.log`.'
    },
    {
      id: 'SS_SNAP_BASELINE',
      title: 'Snapshot bazowy runu',
      question: 'Czy trzeba zrobić snapshot „przed” i co, gdy się nie uda?',
      where: 'src/engine/orchestrator/run/snapshots.ts:23',
      inputs: ['hasBaseline(sesja)'],
      branches: [
        { if: 'baseline już jest (resume)', then: 'nic' },
        { if: 'brak baseline', then: 'createSnapshot `run-baseline` (pełna kopia)' },
        { if: 'tworzenie rzuca', then: 'warning `snapshot (run-baseline) failed`' },
        { if: 'po próbie nadal brak baseline (src/engine/orchestrator/run/task-execution.ts:302)', then: 'throw `run-baseline-snapshot-missing`; run kończy się błędem przed workspace' }
      ],
      default: 'Baseline istnieje, run idzie dalej.',
      notes: 'To jedyny snapshot, którego brak zatrzymuje run.'
    },
    {
      id: 'SS_SNAP_CREATE_BRANCH',
      title: 'Pełny snapshot czy różnicowy',
      question: 'Które pliki zapisać jako bloby?',
      where: 'src/engine/snapshots/create.ts:122',
      inputs: ['walkProjectEntries (bez `.git`, `.splitbrief`, `node_modules`, `.trees` i bez plików git-ignored)', 'manifest baseline'],
      branches: [
        { if: 'sesja nie ma baseline', then: 'manifest `baseline`: blob każdego pliku' },
        { if: 'plik ma ten sam hash i tryb co w baseline (src/engine/snapshots/create.ts:61)', then: 'tylko hash w manifeście, bez bloba' },
        { if: 'plik nieczytelny', then: 'hash bez wpisu; restore zgłosi brak pliku snapshotu' },
        { if: 'zapis bloba rzuca', then: 'cały snapshot rzuca' }
      ],
      default: 'Snapshot różnicowy względem baseline.',
      notes: 'Symlinki trafiają do `symlinks` z targetem. Publikowane jest `snapshot_created`.'
    },
    {
      id: 'SS_SNAP_CHECKOUT_ONLY',
      title: 'Snapshoty post-task tylko w trybie checkout',
      question: 'Czy po tym briefie zapisać snapshot do run-ledger.json?',
      where: 'src/engine/orchestrator/run/snapshots.ts:55',
      inputs: ['`state.workspace.kind`'],
      branches: [
        { if: '`checkout` (`workflow.isolation: none`)', then: 'snapshot `post-task-<currentTaskIndex>` + wpis w ledgerze; po każdym briefie (src/engine/orchestrator/task/loop.ts:260) i raz w spoczynku (src/engine/orchestrator/run/workflow.ts:463)' },
        { if: 'worktree / staged-copy', then: 'nic; wynik żyje w workspace do Apply' }
      ],
      default: 'Brak snapshotu.'
    },
    {
      id: 'SS_SNAP_LOCK',
      title: 'Blokada snapshotów sesji',
      question: 'Czy inny proces właśnie robi snapshot tej sesji?',
      where: 'src/engine/snapshots/lock.ts:71',
      inputs: ['plik blokady', 'mtime', 'pid i czas startu właściciela'],
      branches: [
        { if: 'blokada wolna', then: 'zajęcie' },
        { if: 'blokada starsza niż 60 s, właściciel martwy', then: 'usunięcie i ponowna próba' },
        { if: 'w innym wypadku', then: 'błąd `snapshot-lock-busy`; dla snapshotów ledgera kończy się to warningiem `snapshot (<name>) failed` (src/engine/orchestrator/run/snapshots.ts:79)' }
      ],
      default: 'Zajęcie blokady.'
    },
    {
      id: 'SS_SNAP_LEDGER_SEALED',
      title: 'Zapieczętowany run-ledger',
      question: 'Czy dopisać snapshot do run-ledger.json?',
      where: 'src/engine/snapshots/run/ledger.ts:137',
      inputs: ['poprzedni ledger'],
      branches: [
        { if: 'ledger `accepted` lub `rejected`', then: 'nic nie dopisuje' },
        { if: 'inaczej', then: 'nowy ledger z `runSnapshotId`' }
      ],
      default: 'Dopisanie.'
    },
    {
      id: 'SS_SNAP_PRE_REVIEW',
      title: 'Snapshot pre-final-review',
      question: 'Czy pętla skończyła się tak, że wolno iść do review?',
      where: 'src/engine/orchestrator/run/task-execution.ts:393',
      inputs: ['taskResult.status', 'state.phase', 'abort'],
      branches: [
        { if: 'abort', then: 'Summary bez snapshotu' },
        { if: 'status nie `complete` lub faza inna niż `implementing` / `final-review`', then: 'Summary bez snapshotu i review' },
        { if: 'inaczej', then: 'snapshot `pre-final-review` + ledger, potem final review' }
      ],
      default: 'Brak snapshotu.'
    },
    {
      id: 'SS_SNAP_REJECT_PATH',
      title: 'Odrzucenie runu w checkout: decyzja na każdy plik',
      question: 'Co zrobić z tym plikiem przy `/run reject`?',
      where: 'src/engine/snapshots/run/rollback.ts:190',
      inputs: ['hash w baseline', 'hash w ostatnim snapshocie runu', 'hash teraz'],
      branches: [
        { if: 'baseline = snapshot runu', then: 'pomiń (run go nie zmienił)' },
        { if: 'nowy plik runu, teraz brak', then: 'pomiń' },
        { if: 'nowy plik runu, teraz inny niż snapshot', then: 'konflikt (późniejsza edycja)' },
        { if: 'nowy plik runu, teraz = snapshot', then: 'usuń' },
        { if: 'run usunął plik, teraz = baseline', then: 'pomiń' },
        { if: 'run usunął plik, teraz istnieje', then: 'konflikt' },
        { if: 'run usunął plik, teraz brak', then: 'przywróć z baseline' },
        { if: 'zmieniony, teraz = baseline', then: 'pomiń' },
        { if: 'zmieniony, teraz inny niż snapshot', then: 'konflikt' },
        { if: 'zmieniony, teraz = snapshot', then: 'przywróć z baseline' }
      ],
      default: 'Pomiń.',
      notes: 'Przed zapisem plik jest sprawdzany ponownie; zmiana w trakcie daje konflikt. Ledger dostaje `rejected: true` tylko bez konfliktów i bez brakujących blobów (src/engine/snapshots/run/rollback.ts:237). Brak ledgera lub snapshotu daje `status: empty`. Szczegóły zamykania → zobacz lifecycle.'
    },
    {
      id: 'SS_REPOMAP_ENABLED',
      title: 'Czy budować repo-mapę',
      question: 'Czy planer dostaje sekcję Repository Map?',
      where: 'src/engine/orchestrator/planning/session.ts:187',
      inputs: ['`codebase.enabled`', '`codebase.tokenBudget`', '`codebase.include` / `exclude`'],
      branches: [
        { if: '`codebase.enabled: false`', then: 'brak sekcji, buildRepoMap nie jest wołane' },
        { if: 'inaczej', then: 'buildRepoMap(projectDir, { featureText, tokenBudget, include, exclude })' }
      ],
      default: 'Budowana, budżet 4000.',
      notes: 'Repo-map widzi tylko planer (i pakiet kontekstu planera `api`). Implementer jej nie dostaje.'
    },
    {
      id: 'SS_REPOMAP_CACHE_OPEN',
      title: 'Otwarcie cache SQLite repo-mapy',
      question: 'Czy da się użyć `.splitbrief/repomap.sqlite`?',
      where: 'src/engine/codebase/cache.ts:115',
      inputs: ['better-sqlite3', 'stan pliku db'],
      branches: [
        { if: 'katalog cache jest symlinkiem lub db wychodzi poza katalog', then: 'throw `repomap-cache-escapes`', next: 'SS_REPOMAP_FAIL' },
        { if: 'brak lub niezgodny natywny binding (`ERR_DLOPEN_FAILED`, `MODULE_NOT_FOUND` …)', then: 'notice `Repo-map cache unavailable. Continuing without caching.`; każdy plik parsowany od nowa' },
        { if: '`SQLITE_CORRUPT` / `SQLITE_NOTADB`', then: 'usunięcie db, `-shm`, `-wal`, ponowne otwarcie, warning `repo-map cache was corrupt and has been reset`' },
        { if: 'inny błąd', then: 'throw', next: 'SS_REPOMAP_FAIL' }
      ],
      default: 'Cache otwarty w trybie WAL.'
    },
    {
      id: 'SS_REPOMAP_CACHE_HIT',
      title: 'Trafienie w cache parsowania',
      question: 'Czy wiersz cache jest aktualny dla tego pliku?',
      where: 'src/engine/codebase/cache.ts:163',
      inputs: ['mtime_ms', 'size_bytes', 'parse_version (stała `PARSE_VERSION = 2`)'],
      branches: [
        { if: 'wszystkie trzy zgodne', then: 'symbole i importy z JSON-u' },
        { if: 'cokolwiek się różni', then: 'parsowanie tree-sitter i upsert' }
      ],
      default: 'Parsowanie.',
      notes: 'Zmiana treści przy tym samym mtime i rozmiarze nie jest wykrywana.'
    },
    {
      id: 'SS_REPOMAP_FILE_FILTER',
      title: 'Który plik trafia do mapy',
      question: 'Czy ten plik zostanie sparsowany?',
      where: 'src/engine/codebase/repomap.ts:104',
      inputs: ['rozmiar', 'rozszerzenie', 'gramatyka'],
      branches: [
        { if: 'katalog `.git`, `.splitbrief`, `node_modules`, `.trees`, `dist` lub plik `*.test.ts(x)` lub dopasowanie `exclude`', then: 'nie odkryty (src/engine/codebase/discover-files.ts:7)' },
        { if: 'rozmiar ponad 100000 bajtów lub błąd stat', then: 'pominięty' },
        { if: 'nieznane rozszerzenie (src/engine/codebase/parse.ts:162)', then: 'pominięty' },
        { if: 'gramatyka się nie ładuje (src/engine/codebase/parse.ts:174)', then: 'plik w mapie bez symboli i importów' },
        { if: 'odczyt pliku rzuca', then: 'pominięty' }
      ],
      default: 'Sparsowany.',
      notes: 'Pięć języków: TypeScript, JavaScript, Python, Go, Rust. Parsowanie biegnie po 8 plików naraz.'
    },
    {
      id: 'SS_REPOMAP_FOCUS',
      title: 'Personalizacja PageRanku',
      question: 'Na które pliki skierować teleport PageRanku?',
      where: 'src/engine/codebase/pagerank.ts:26',
      inputs: ['pliki wymienione w prośbie (src/engine/codebase/extract-mentioned-filenames.ts:7)', 'focusFiles'],
      branches: [
        { if: 'ścieżka z prośby istnieje', then: 'plik w zbiorze focus' },
        { if: 'ścieżka nie istnieje, ale basename pasuje do odkrytego pliku', then: 'pierwszy taki plik w zbiorze focus' },
        { if: 'zbiór focus niepusty', then: 'teleport równo między pliki focus, reszta dostaje rangę z importów i z puli plików bez wyjść' },
        { if: 'zbiór pusty', then: 'teleport równomierny' }
      ],
      default: 'Równomierny.',
      notes: 'Graf ma tylko importy względne (zaczynające się od `.`) (src/engine/codebase/graph.ts:52). Aliasy ścieżek i pakiety są pomijane.'
    },
    {
      id: 'SS_REPOMAP_BUDGET',
      title: 'Przycięcie do budżetu tokenów',
      question: 'Czy blok tego pliku zmieści się w budżecie?',
      where: 'src/engine/codebase/budget.ts:24',
      inputs: ['ranking', 'tokenBudget', 'estimateTokens (znaki / 4)'],
      branches: [
        { if: 'budżet ≤ 0', then: 'pusta mapa' },
        { if: 'pierwszy (najwyższy) plik', then: 'zawsze dołączony' },
        { if: 'kolejny plik mieści się', then: 'dołączony' },
        { if: 'nie mieści się', then: 'pominięty; mniejszy plik dalej może wejść' }
      ],
      default: 'Dołączanie w kolejności rangi.'
    },
    {
      id: 'SS_REPOMAP_FAIL',
      title: 'Awaria repo-mapy',
      question: 'Co, gdy budowa mapy rzuci?',
      where: 'src/engine/codebase/repomap.ts:74',
      inputs: ['wyjątek'],
      branches: [
        { if: 'dowolny wyjątek', then: 'log `repo-map`, warning `Repo-map unavailable. Continuing without the code overview.` (szczegóły w `details`), pusty string' }
      ],
      default: 'Planowanie trwa bez sekcji Repository Map.'
    },
    {
      id: 'SS_COMPACT_TRIGGER',
      title: 'Wyzwalacz auto-kompakcji',
      question: 'Czy przy tym wznowieniu skompaktować transkrypt planera?',
      where: 'src/engine/orchestrator/resume-context.ts:34',
      inputs: ['savedState', 'otwarte recovery (src/engine/orchestrator/run/init.ts:364)', '`workflow.compactionThreshold`', '`supportsSelfSummarisation`', 'liczba odbudowanych wiadomości'],
      branches: [
        { if: 'nowy run (brak savedState) lub otwarte recovery', then: 'brak kompakcji' },
        { if: 'próg nieustawiony', then: 'brak kompakcji' },
        { if: 'planner nie umie się streszczać (planner `shell`/`agent` bez override)', then: 'brak kompakcji' },
        { if: 'wiadomości ≤ próg', then: 'brak kompakcji' },
        { if: 'wiadomości > próg', then: 'kompakcja', next: 'SS_COMPACT_FORMAT' }
      ],
      default: 'Brak kompakcji.',
      notes: 'Kompakcja nie działa w trakcie żywego runu, tylko przy jego wznowieniu. `claude-code` i planner `api` mają `supportsSelfSummarisation: true` (src/engine/planners/types.ts:39).'
    },
    {
      id: 'SS_COMPACT_FORMAT',
      title: 'Format streszczenia',
      question: 'Streszczenie tekstowe czy strukturalne?',
      where: 'src/core/schemas/compaction.ts:18',
      inputs: ['`workflow.compactionFormat`', '`planner.kind`'],
      branches: [
        { if: '`freeform`', then: 'freeform' },
        { if: '`structured`', then: 'structured (goal, stepsCompleted, currentStep, filesModified, constraintsDiscovered, remainingWork)' },
        { if: '`auto` i planner `api`', then: 'structured' },
        { if: '`auto` i inny planner', then: 'freeform' }
      ],
      default: '`auto`.'
    },
    {
      id: 'SS_COMPACT_KEEP',
      title: 'Ile wiadomości zostawić bez streszczenia',
      question: 'Czy jest co streszczać po odjęciu ostatnich wiadomości?',
      where: 'src/engine/orchestrator/transcript/compaction.ts:149',
      inputs: ['próg', 'pierwsza wiadomość z kolejki, która nie została jeszcze dostarczona'],
      branches: [
        { if: 'brak oczekującej wiadomości z kolejki', then: 'zostaw `max(1, próg - 1)` ostatnich' },
        { if: 'jest oczekująca wiadomość', then: 'zostaw wszystko od niej w górę' },
        { if: 'do streszczenia ≤ 0 (src/core/sessions/compaction.ts:45)', then: 'nic, `entriesRemoved: 0`' }
      ],
      default: 'Streszczenie starszej części.',
      notes: 'Streszczany jest odbudowany dialog planera (bez wyjścia implementera); poprzednie streszczenie idzie jako pierwsza wiadomość. Po kompakcji są przycinane `resumeUserMessages`.'
    },
    {
      id: 'SS_COMPACT_STRUCT_FALLBACK',
      title: 'Strukturalne streszczenie bez poprawnego JSON',
      question: 'Czy planer zwrócił poprawny StructuredSummary?',
      where: 'src/core/sessions/compaction.ts:119',
      inputs: ['wynik summarizeStructured'],
      branches: [
        { if: 'poprawny', then: 'zapis JSON jako `text` + pole `structured`' },
        { if: 'niepoprawny', then: 'zapis tekstu jako freeform, warning `Structured compaction returned invalid JSON; saved freeform summary instead.`' },
        { if: 'planer nie ma summarizeStructured', then: 'zwykłe `summarize`' }
      ],
      default: 'Rekord `summary` dopisany do `session.jsonl`.'
    },
    {
      id: 'SS_COMPACT_FAIL',
      title: 'Awaria kompakcji',
      question: 'Co, gdy wywołanie streszczające zawiedzie?',
      where: 'src/engine/orchestrator/resume-context.ts:76',
      inputs: ['wyjątek', 'signal'],
      branches: [
        { if: 'abort', then: 'cichy powrót do state' },
        { if: 'inny błąd', then: 'warning `Transcript auto-compaction failed: …`, wznowienie z pełnym transkryptem' }
      ],
      default: 'Run trwa.',
      notes: 'Udana kompakcja księguje tokeny na seat planera (addUsageAndSave).'
    },
    {
      id: 'SS_REBUILD_CONTEXT',
      title: 'Odbudowa kontekstu planera z transkryptu',
      question: 'Czy planer dostaje transkrypt jako priorMessages?',
      where: 'src/engine/orchestrator/run/init.ts:377',
      inputs: ['planSeatChanged', '`supportsSessionResume`', '`state.plannerSessionId`'],
      branches: [
        { if: 'seat planera zmieniony, planer bez resume albo brak plannerSessionId', then: 'applyRebuiltContext: ostatnie summary + wiadomości po nim (src/engine/orchestrator/transcript/rebuild.ts:123)' },
        { if: 'state.json nieczytelny', then: 'warning `Saved workflow state was unavailable…`, brak odbudowy' },
        { if: 'odczyt skompaktowany rzuca', then: 'odczyt surowego logu wiadomości' },
        { if: 'odbudowa pusta', then: 'nic nie ustawia' },
        { if: 'inaczej', then: 'planer wznawia swój natywny wątek' }
      ],
      default: 'Natywny wątek.'
    },
    {
      id: 'SS_SESSION_REISSUE',
      title: 'Wygasła lub za długa sesja planera',
      question: 'Czy powtórzyć wywołanie planera na świeżej sesji?',
      where: 'src/engine/orchestrator/resume-context.ts:128',
      inputs: ['błąd wywołania', 'czy wątek był wznawiany', 'SESSION_EXPIRED_PATTERNS (src/engine/session-expiry.ts:4)'],
      branches: [
        { if: 'wątek nie był wznawiany lub abort', then: 'błąd do wywołującego' },
        { if: 'komunikat pasuje do wzorca wygaśnięcia (`session not found`, `thread not loaded`, `no rollout found for thread id` …)', then: 'warning `planner_session_expired`, odbudowa transkryptu, jedno ponowienie' },
        { if: 'kod `input-too-large`', then: 'warning `planner_session_refused`, odbudowa, jedno ponowienie' },
        { if: 'drugi błąd', then: 'do wywołującego (halt → zobacz recovery)' }
      ],
      default: 'Błąd do wywołującego.',
      notes: 'Adaptery planera zerują zapamiętane id sesji przy wygaśnięciu (src/engine/planners/claude-code.ts:171, src/engine/planners/cli.ts:253). Claude Code z potwierdzonym wznowieniem rzuca `session-resume-failed` (src/engine/planners/claude-code.ts:162); ten komunikat nie pasuje do wzorców, więc nie ma ponowienia.'
    },
    {
      id: 'SS_EVIDENCE_WRITE_FAIL',
      title: 'Błąd zapisu evidence',
      question: 'Co, gdy zapis do evidence.json się nie uda?',
      where: 'src/engine/orchestrator/evidence/persistence.ts:38',
      inputs: ['wyjątek mutateEvidenceLedger', 'walidacja EvidenceLedgerSchema (src/core/evidence/ledger-storage.ts:47)'],
      branches: [
        { if: 'zapis wyniku briefu, skipu, review, approval, API apply', then: 'warning `Could not save the run evidence …`; krok trwa' },
        { if: 'zapis odmowy (persistRejectionEvidence, src/engine/orchestrator/evidence/persistence.ts:312)', then: 'cicho połknięte, bez warningu' },
        { if: 'zapis checków (src/engine/orchestrator/evidence/record-checks.ts:88)', then: 'ostrzeżenie `Could not save the check results to …` przez warnError' },
        { if: 'ledger na dysku nie przechodzi schematu', then: 'każdy odczyt rzuca `evidence ledger is invalid`, więc każdy kolejny zapis też zawodzi' },
        { if: 'blokada pliku nie zwolniona w czasie', then: 'błąd lockTimeout, traktowany jak błąd zapisu' }
      ],
      default: 'Zapis pod blokadą `withFileLock`.',
      notes: 'Ledger nigdy nie zatrzymuje runu. Odmowy z ledgera wracają do planera tylko przy `approval.feedRejectionsToPlanner: true` (src/engine/orchestrator/planning/call-loop.ts:14); błąd odczytu daje pusty kontekst.'
    },
    {
      id: 'SS_EVIDENCE_RECORD_KIND',
      title: 'Zapis wyniku briefu: local czy retry',
      question: 'Jak zapisać wynik tej próby briefu?',
      where: 'src/engine/orchestrator/evidence/persistence.ts:88',
      inputs: ['recordKind', 'status', 'method', 'retries', 'durationMs', 'changedFiles', 'initialChangedFiles'],
      branches: [
        { if: 'brak ledgera', then: 'utworzenie z wszystkich zadań state i `briefHash` (src/engine/orchestrator/evidence/persistence.ts:54)' },
        { if: '`local`', then: 'recordLocalTaskEvidence' },
        { if: '`retry`', then: 'recordRetryOrEscalationEvidence; zmienione pliki pierwszej próby są dołączane' },
        { if: 'zadanie nie było w ledgerze (brief fix)', then: 'dopisane na końcu (upsertEvidenceTask)' }
      ],
      default: '`validationSummary` przeliczane po każdej zmianie.'
    },
    {
      id: 'SS_EVIDENCE_STOPPED_CLOSE',
      title: 'Evidence przy zamknięciu runu w trakcie briefu',
      question: 'Które pliki zaksięgować briefowi, który był w locie przy zamknięciu?',
      where: 'src/engine/orchestrator/evidence/persistence.ts:160',
      inputs: ['state.workspace', 'status lockfile sesji', 'activeTaskSnapshot', 'lineages'],
      branches: [
        { if: 'brak workspace lub katalog zniknął', then: 'nic' },
        { if: 'checkout i proces runu już wyszedł', then: 'zmiany liczone do snapshotu spoczynku (changedSinceAtRest)' },
        { if: 'inaczej', then: 'zmiany liczone z workspace teraz' },
        { if: 'brief w locie ma snapshot startu', then: 'recordStoppedTaskEvidence' },
        { if: 'otwarty lineage', then: 'reszta plików lineage dla briefu w locie lub ostatniego rozstrzygniętego' }
      ],
      default: 'Wołane po zatwierdzonym `CLOSE_RUN` (src/engine/orchestrator/run/close.ts:136).',
      notes: 'Ta funkcja nie łapie wyjątków sama.'
    },
    {
      id: 'SS_REVIEW_CAPTURE',
      title: 'Zapis zmian briefu do review-changes.json',
      question: 'Co reviewer zobaczy jako zmianę tego briefu?',
      where: 'src/engine/orchestrator/evidence/review-capture.ts:42',
      inputs: ['pliki zaksięgowane briefowi', 'snapshot `since`', 'stan pliku teraz'],
      branches: [
        { if: 'przed = po', then: 'pominięty' },
        { if: 'odczyt się udał', then: '`captured` z bajtami base64, sha256, trybem lub targetem symlinku' },
        { if: 'odczyt rzuca', then: '`unknown` z `reason: capture-failed`' },
        { if: 'zapis pliku rzuca (src/engine/orchestrator/evidence/review-capture.ts:63)', then: 'ostrzeżenie `Could not record task completion changes for review`' }
      ],
      default: 'Wołane po zaliczeniu briefu (src/engine/orchestrator/task/commit.ts:131) i po skipie z resztą lineage.'
    },
    {
      id: 'SS_CHECK_EVIDENCE',
      title: 'Zapis przebiegów checków',
      question: 'Pod który wpis briefu zapisać wyniki checków?',
      where: 'src/engine/orchestrator/evidence/record-checks.ts:46',
      inputs: ['task (lub pierwszy task state)', 'runs', 'changedFilesBaseline'],
      branches: [
        { if: 'brak tasku lub brak przebiegów', then: 'nic' },
        { if: 'baseline jest', then: '`workspaceSnapshotId` = sha256 par ścieżka:hash zmienionych plików' },
        { if: 'liczenie identyfikatora rzuca', then: 'ostrzeżenie, wpis bez `workspaceSnapshotId` (reviewer nie zobaczy renderów)' },
        { if: 'checki planu przed review (src/engine/orchestrator/run/task-execution.ts:261)', then: 'zapisane na wpisie ostatniego briefu' }
      ],
      default: 'Dopisanie do `tasks[].checks`.'
    },
    {
      id: 'SS_SKILLS_SOURCE',
      title: 'Skąd lista skilli runu',
      question: 'Które skille nosi ten run?',
      where: 'src/engine/orchestrator/run/skills-context.ts:22',
      inputs: ['opts.selectedSkills', 'state.selectedSkills'],
      branches: [
        { if: 'skille wybrane w tym procesie', then: 'te' },
        { if: 'wznowienie z zapisanymi id', then: 'discoverSkills i dopasowanie po id' },
        { if: 'zapisany id nie znaleziony', then: 'warning `Saved skill(s) not found, left out: …` (`skills_unresolved`)' },
        { if: 'pusta lista', then: 'brak bloku skilli' }
      ],
      default: 'Brak bloku.',
      notes: 'Wołane raz w initializeWorkflow (src/engine/orchestrator/run/init.ts:345), przed utworzeniem seatów.'
    },
    {
      id: 'SS_SKILLS_DEDUPE',
      title: 'Kolejność i deduplikacja skilli',
      question: 'Który skill wygrywa, gdy dwa mają ten sam id lub nazwę?',
      where: 'src/engine/skill-discovery.ts:246',
      inputs: ['PROJECT_SKILL_SCAN_PATHS (src/core/skills/scan-paths.ts:4)', 'AGENTS.md', 'GLOBAL_SKILL_SCAN_PATHS'],
      branches: [
        { if: 'id lub name już widziany', then: 'odrzucony (wygrywa wcześniejszy: projekt, potem AGENTS.md, potem global)' },
        { if: 'id to `splitbrief`, `splitbrief-brief`, `splitbrief-run`, `splitbrief-review`, `splitbrief-babysit`', then: 'odrzucony (skill orkiestracji)' },
        { if: 'inaczej', then: 'zachowany' }
      ],
      default: 'Zachowany.',
      notes: 'Skan schodzi maksymalnie 4 poziomy w głąb.'
    },
    {
      id: 'SS_SKILLS_REACH',
      title: 'Jak seat sięga do skilla',
      question: 'Czy skill czytać ścieżką względną z kopii projektu, czy absolutną?',
      where: 'src/engine/orchestrator/run/skills-context.ts:39',
      inputs: ['scope', 'ścieżka', 'git check-ignore'],
      branches: [
        { if: 'skill globalny, ale jego pliki są w projekcie', then: 'traktowany jak projektowy' },
        { if: 'skill projektowy, który git ignoruje', then: 'traktowany jak globalny: ścieżka absolutna i wpis w `skillRoots` (strefa izolacji implementera)' },
        { if: 'pliki skilla zniknęły', then: 'zostaje, później jako nieczytelny' }
      ],
      default: 'Bez zmian.'
    },
    {
      id: 'SS_SKILLS_BUDGET',
      title: 'Budżet treści skilli',
      question: 'Czy treść skilla wejdzie do bloku w całości?',
      where: 'src/engine/skill-discovery.ts:348',
      inputs: ['`MAX_SKILL_CHARS = 16000`', 'treść SKILL.md', 'references/*.md'],
      branches: [
        { if: 'plik nieczytelny', then: 'skill w `unread`, warning `Skill(s) could not be read, left out`' },
        { if: 'treść mieści się', then: 'SKILL.md w całości, potem references w całości, póki się mieszczą' },
        { if: 'nie mieści się', then: 'skill nazwany ścieżką, warning `skills_truncated`' }
      ],
      default: 'Plik nigdy nie jest ucinany; albo w całości, albo tylko ścieżka.'
    },
    {
      id: 'SS_CHANGE_KIND',
      title: 'Metoda wykrywania zmian implementera',
      question: 'Jak porównać projekt przed i po wywołaniu implementera?',
      where: 'src/engine/change-detection.ts:95',
      inputs: ['istnienie `.git`', 'workspace.changeDetection'],
      branches: [
        { if: 'workspace próby wymusza `file-hashes` (src/engine/orchestrator/isolation/create.ts:457)', then: 'hashe wszystkich plików' },
        { if: 'jest `.git`', then: '`git-status`: pliki zmienione już na starcie z treścią i trybem' },
        { if: 'brak `.git`', then: '`file-hashes`' }
      ],
      default: 'Wybór według `.git`.',
      notes: 'Baseline jest zbierany tylko dla kontraktu wyjścia `direct` (src/engine/implementers/pipeline/run.ts:545).'
    },
    {
      id: 'SS_CHANGE_NO_WRITE',
      title: 'Implementer nic nie zapisał',
      question: 'Czy próba bez żadnej zmiany pliku jest porażką?',
      where: 'src/engine/implementers/pipeline/run.ts:765',
      inputs: ['wynik detectChanges', '`allowNoChange`'],
      branches: [
        { if: 'zmiany są', then: 'próba trwa dalej (walidacja)' },
        { if: 'brak zmian i `allowNoChange` nie true', then: 'warning `implementer_wrote_nothing`, wynik `no-staged-change`, próba nieudana (→ zobacz build)' },
        { if: 'brak zmian i `allowNoChange: true`', then: 'próba trwa' }
      ],
      default: 'Próba trwa.'
    },
    {
      id: 'SS_ATTACH_RESOLVE',
      title: 'Rozwiązanie pliku z @odwołania',
      question: 'Czy ten plik można dołączyć i jako co?',
      where: 'src/core/attachments/resolve.ts:130',
      inputs: ['ścieżka (z `~/`, cudzysłowami)', 'stat', 'rozszerzenie', 'bajty pliku'],
      branches: [
        { if: 'nie istnieje', then: '`not-found`' },
        { if: 'nie jest zwykłym plikiem', then: '`not-a-file`' },
        { if: 'ponad 10 MiB', then: '`too-large`' },
        { if: 'brak prawa odczytu', then: '`unreadable`' },
        { if: 'rozszerzenie obrazu (jpg, jpeg, png, gif, webp, bmp)', then: 'załącznik obrazu' },
        { if: 'UTF-8 bez znaków sterujących', then: 'tekst dołączony do kontekstu planera (src/core/attachments/resolve.ts:80)' },
        { if: 'binarny', then: '`not-text`' }
      ],
      default: 'Odmowa z powodem.'
    },
    {
      id: 'SS_ATTACH_COMPOSER',
      title: '@plik w composerze',
      question: 'Czy wiadomość z @odwołaniem można wysłać?',
      where: 'src/core/composer/submission.ts:42',
      inputs: ['typowana ścieżka', 'czy jawna (zawiera `/` lub cudzysłów)', 'supportsImages'],
      branches: [
        { if: 'gołe słowo, plik nie istnieje', then: 'tekst zostaje jak jest (np. `@user`)' },
        { if: 'jawna ścieżka z błędem', then: 'odmowa wysłania z powodem' },
        { if: 'obraz, seat bez obsługi obrazów', then: 'odmowa `no-vision`' },
        { if: 'tekst', then: 'blok pliku dopisany do wiadomości i kontekstu planera' }
      ],
      default: 'Wysłanie.'
    },
    {
      id: 'SS_ATTACH_CLI',
      title: '@plik w argumentach CLI',
      question: 'Czy run może wystartować z tymi @plikami?',
      where: 'src/cli/parse-at-files.ts:52',
      inputs: ['argumenty z `@`'],
      branches: [
        { if: 'każdy plik się rozwiązał', then: 'tekst do kontekstu, obrazy jako załączniki' },
        { if: 'choć jeden błąd', then: 'odmowa `Cannot start: SPLITBRIEF refused these @file inputs.`' }
      ],
      default: 'Start.'
    },
    {
      id: 'SS_ATTACH_PLANNER_DROP',
      title: 'Obrazy dla planera bez obsługi obrazów',
      question: 'Czy planer przyjmie załączone obrazy?',
      where: 'src/engine/orchestrator/planning/run.ts:20',
      inputs: ['oczekujące załączniki', '`planner.capabilities.supportsImages`'],
      branches: [
        { if: 'planer obsługuje obrazy', then: 'obrazy idą do sesji planowania' },
        { if: 'nie obsługuje', then: 'zdarzenie `planner_attachments_dropped` z liczbą; obrazy pominięte; pod `--plain` linia na stderr' }
      ],
      default: 'Bez obrazów.'
    },
    {
      id: 'SS_SUMMARY_USAGE',
      title: 'Tokeny i dowody wywołań w Summary',
      question: 'Skąd Summary bierze zużycie tokenów i koszt?',
      where: 'src/engine/orchestrator/summary/build.ts:149',
      inputs: ['state.tokenUsage (zaksięgowane)', 'session.jsonl (zaobserwowane)', 'call-evidence w pamięci'],
      branches: [
        { if: 'znane projectDir i sessionId', then: 'reconcileTokenUsage: implementer i escalation = max(zaksięgowane, zaobserwowane); planer i reviewer jako wspólna pula z podziałem niedoboru' },
        { if: 'ten proces prowadził run', then: 'dowody wywołań z sinka call-evidence (src/engine/orchestrator/summary/call-evidence.ts:54)' },
        { if: 'run z dysku', then: 'dowody z linii `runner_call_*` w `session.jsonl`' },
        { if: 'brak zdarzeń', then: '`callEvidence: undefined` (run sprzed atrybucji)' }
      ],
      default: 'Koszt liczony na seat, który tokeny zużył (`state.plannerTool`, nie bieżący seat).'
    },
    {
      id: 'SS_PRICING',
      title: 'Wycena seatu',
      question: 'Po jakiej stawce liczyć tokeny tego runnera?',
      where: 'src/engine/providers/pricing-resolver.ts:156',
      inputs: ['klucz tożsamości runnera (kind:id)', 'model', 'katalog models.dev', 'tabela wbudowana'],
      branches: [
        { if: 'kind `cli`', then: '`unpriced-cli` (abonament, bez kwoty)' },
        { if: 'kind `shell` / `agent`', then: '`unpriced-meta`' },
        { if: 'provider lokalny', then: '`unpriced-local`' },
        { if: 'model automatyczny lub pusty', then: 'bez ceny' },
        { if: 'models.dev ma stawki input i output', then: '`api-priced`, `source: models-dev`' },
        { if: 'tabela wbudowana ma stawki', then: '`api-priced`, `source: bundled-fallback`' },
        { if: 'nic', then: '`unpriced-unknown`' }
      ],
      default: 'Bez ceny.'
    },
    {
      id: 'SS_MODELSDEV_CACHE',
      title: 'Odświeżenie katalogu models.dev',
      question: 'Czy użyć kopii z cache, czy pobrać katalog?',
      where: 'src/engine/providers/models-dev-cache.ts:119',
      inputs: ['snapshot w `~/.splitbrief/<models-dev cache>`', 'tryb `automatic`/`manual`', 'TTL 1 h', 'timeout 10 s', 'ETag'],
      branches: [
        { if: 'automatic i snapshot młodszy niż 1 h', then: '`cached`' },
        { if: 'HTTP 304 i jest snapshot', then: '`not-modified`, odświeżony `validatedAt`' },
        { if: 'HTTP 304 bez snapshotu', then: '`failed: not-modified-without-cache`' },
        { if: 'błąd sieci, timeout, HTTP inny niż 200, za duży, zły JSON lub schemat, błąd zapisu', then: '`stale` (stary snapshot) albo `failed` bez snapshotu' },
        { if: '200 i poprawny katalog', then: '`fresh`, zapis z ETag' }
      ],
      default: '`fresh`.',
      notes: 'Pobiera warstwa detekcji (src/engine/detection/models-dev-lane.ts:136). Brak katalogu daje tylko brak metadanych i stawek; run trwa.'
    },
    {
      id: 'SS_GITIGNORE_BOOKKEEPING',
      title: 'Zmiana .gitignore tylko od SPLITBRIEF',
      question: 'Czy zmieniony `.gitignore` to praca użytkownika?',
      where: 'src/core/gitignore-bookkeeping.ts:16',
      inputs: ['`.gitignore` w drzewie', '`.gitignore` w HEAD'],
      branches: [
        { if: 'brak pliku', then: 'false' },
        { if: 'różnica to tylko linie `.splitbrief/` i `.trees/` (i końcowy newline)', then: 'true: plik nie liczy się jako zmiana użytkownika' },
        { if: 'inna różnica', then: 'false' }
      ],
      default: 'false.',
      notes: 'Czytają to: baseline zmienionych plików na starcie runu (src/engine/orchestrator/changed-files-baseline.ts:137), readiness (src/core/readiness/collect.ts:397), usuwanie worktree (src/engine/orchestrator/isolation/remove-worktree.ts:134). Regułę dopisuje zapis konfiguracji i tworzenie worktree (src/core/config/load/document.ts:46).'
    },
    {
      id: 'SS_GITIGNORE_ENSURE',
      title: 'Dopisanie reguły .splitbrief/ do .gitignore',
      question: 'Czy trzeba dopisać regułę ignorowania?',
      where: 'src/lib/fs.ts:276',
      inputs: ['git check-ignore dla `.splitbrief/` i pliku konfiguracji', 'treść `.gitignore`'],
      branches: [
        { if: 'git już ignoruje oba (dowolne źródło reguły)', then: 'nic' },
        { if: 'linia pokrywająca już jest', then: 'nic' },
        { if: 'jest wyjątek `!.splitbrief/…`', then: 'reguła wstawiona przed wyjątkiem' },
        { if: 'plik istnieje', then: 'dopisanie na końcu' },
        { if: 'pliku brak', then: 'utworzenie' }
      ],
      default: 'Komunikat `Added .splitbrief/ to .gitignore`.'
    },
    {
      id: 'SS_CATALOG_MERGE',
      title: 'Scalanie listy modeli narzędzia CLI',
      question: 'Które modele zostają po nowym odczycie katalogu?',
      where: 'src/core/discovery/catalog-read-merge.ts:7',
      inputs: ['modele z cache', 'missingOnce', 'nowy odczyt (maks. 1000 modeli)'],
      branches: [
        { if: 'model w nowym odczycie', then: 'zostaje z nowymi metadanymi' },
        { if: 'brak w odczycie pierwszy raz', then: 'zostaje z oznaczeniem `missingOnce`' },
        { if: 'brak drugi raz z rzędu', then: 'usunięty' },
        { if: 'odczyt pusty lub z missingOnce', then: '`complete: false` (katalog stale)' }
      ],
      default: 'Odczyt nieudany nie zmienia ani modeli, ani oznaczeń.',
      notes: 'Detekcja i pickery → zobacz startup i runners.'
    }
  ],
  config: [
    { key: 'hooks.<event>[]', values: 'pre_planning, pre_task, post_task, pre_validation, post_validation, pre_escalation, on_error, on_halt, on_complete', default: 'brak', effect: 'Lista hooków dla zdarzenia, uruchamiana po kolei.', where: 'src/core/schemas/hooks.ts:7' },
    { key: 'hooks.<event>[].command / args', values: 'program i argv; `${event.<pole>}` w args', default: 'args: []', effect: 'Proces bez powłoki; powłoki i `-c` odrzucane.', where: 'src/core/schemas/hooks.ts:311' },
    { key: 'hooks.<event>[].timeout_ms', values: '1–300000', default: '30000', effect: 'Po przekroczeniu proces jest zabijany; awaria według on_failure.', where: 'src/core/schemas/hooks.ts:317' },
    { key: 'hooks.<event>[].on_failure', values: 'block | warn | ignore', default: 'warn', effect: 'Jak traktować timeout, zły kod, zły JSON.', where: 'src/core/schemas/hooks.ts:318' },
    { key: 'hooks.pre_commit / post_commit', values: 'tylko pusta lista', default: 'brak', effect: 'Niepusta lista blokuje ładowanie konfiguracji.', where: 'src/core/schemas/hooks.ts:366' },
    { key: '--allow-hooks', values: 'flaga', default: 'false', effect: 'Zgoda na hooki bez pytania (CI); disclosure na stderr.', where: 'src/cli/options.ts:306' },
    { key: 'codebase.enabled', values: 'true | false', default: 'true', effect: 'Wyłącza repo-mapę w prompcie planera.', where: 'src/core/schemas/codebase.ts:4' },
    { key: 'codebase.tokenBudget', values: '1–50000', default: '4000', effect: 'Budżet repo-mapy (znaki / 4).', where: 'src/core/schemas/codebase.ts:5' },
    { key: 'codebase.include / exclude', values: 'globy / wyrażenia regularne', default: 'znane rozszerzenia / domyślne katalogi', effect: 'Filtr plików repo-mapy.', where: 'src/core/schemas/codebase.ts:6' },
    { key: 'workflow.compactionThreshold', values: 'liczba całkowita ≥ 10', default: 'brak (kompakcja wyłączona)', effect: 'Liczba wiadomości, powyżej której wznowienie kompaktuje transkrypt.', where: 'src/core/schemas/config.ts:102' },
    { key: 'workflow.compactionFormat', values: 'auto | freeform | structured', default: 'auto', effect: 'Format streszczenia; auto = structured dla planera api.', where: 'src/core/schemas/config.ts:103' },
    { key: 'approval.feedRejectionsToPlanner', values: 'true | false', default: 'true', effect: 'Odmowy z evidence ledger trafiają na początek promptu planera.', where: 'src/core/schemas/config.ts:51' },
    { key: 'SPLITBRIEF_DEBUG', values: 'pusty | 0 | false | inne', default: 'brak (dev: włączony, build: wyłączony)', effect: 'Włącza `.splitbrief/logs/debug.log`.', where: 'src/core/logger.ts:5' },
    { key: 'SPLITBRIEF_DEBUG_KEYS', values: 'pusty | 0 | false | inne', default: 'brak', effect: 'Log surowych i sparsowanych klawiszy.', where: 'src/core/key-debug.ts:10' },
    { key: '--json / --plain', values: 'flagi headless', default: 'false', effect: 'Dokłada sink stdout NDJSON albo tekstowy.', where: 'src/cli/options.ts:313' }
  ],
  states: [
    { name: 'HookOutcome: allow | deny | warn | crash', meaning: 'Wynik jednego hooka; pre_* blokuje na deny i na crash z block.', where: 'src/core/schemas/hooks.ts:31' },
    { name: 'models.dev: cached | fresh | not-modified | stale | failed', meaning: 'Wynik odświeżenia katalogu; stale = stary snapshot po błędzie.', where: 'src/engine/providers/models-dev-cache.ts:57' },
    { name: 'PricingMode', meaning: 'api-priced, unpriced-cli, unpriced-local, unpriced-meta, unpriced-unknown.', where: 'src/engine/providers/pricing-resolver.ts:19' },
    { name: 'EvidenceFinalReviewStatus: written | failed | skipped', meaning: 'Status finalnego review w ledgerze.', where: 'src/core/schemas/evidence.ts:123' },
    { name: 'ChangeDetectorBaseline: git-status | file-hashes', meaning: 'Metoda porównania przed/po wywołaniu implementera.', where: 'src/engine/change-detection.ts:16' }
  ],
  scenarios: [
    {
      title: 'Hook post_task z quick startu: prettier na ${event.file}',
      steps: [
        '1. Użytkownik dodaje `post_task: npx prettier --write ${event.file}` i startuje z `--allow-hooks`.',
        '2. Brief przechodzi; commit.ts publikuje `task_completed` (taskId, title, method, retries, duration).',
        '3. Hook sink mapuje to na `post_task` i uruchamia hook bez czekania.',
        '4. `task_completed` nie ma pola `file`, więc `${event.file}` daje pusty string.',
        '5. prettier dostaje pusty argument; wynik zależy od prettiera, a awaria daje warning z on_failure warn.'
      ],
      outcome: 'Hook nie formatuje pliku briefu. Pole `file` jest tylko w `task_started` (pre_task).'
    },
    {
      title: 'Skrypt hooka zmieniony w trakcie runu',
      steps: [
        '1. Run wystartował z zaufanymi hookami `pre_task`.',
        '2. Użytkownik edytuje `.splitbrief/hooks/check.sh`.',
        '3. Przy następnym briefie runPreHooks woła hookTrustRefusal; digest się różni.',
        '4. Wynik `allow: false` z powodem `hook configuration or hook files changed after trust…`.',
        '5. pre-task.ts publikuje warning i pomija brief (skipBrief).'
      ],
      outcome: 'Każdy kolejny brief jest pomijany, aż użytkownik ponownie zaufa hookom. Hooki post_* dają tylko warning.'
    },
    {
      title: 'CI bez --allow-hooks',
      steps: [
        '1. Pipeline CI woła `splitbrief start --json "…"` w repo z `hooks:`.',
        '2. ensureHooksTrusted nie znajduje receipt dla tego checkoutu.',
        '3. Brak flagi i brak TTY.'
      ],
      outcome: 'Start kończy się błędem `Hook config is not trusted and no TTY available. Re-run with --allow-hooks…`, exit 1.'
    },
    {
      title: 'Hook pre_escalation odmawia',
      steps: [
        '1. Brief T003 wyczerpuje lokalne retry.',
        '2. handle.ts woła hook `pre_escalation`; hook zwraca `{"decision":"deny","message":"no paid consult"}`.',
        '3. Warning `pre_escalation blocked: no paid consult`.',
        '4. Powstaje recovery `retry-exhausted` z `escalationBlockedBy` i `allowRetryOverride: true`.',
        '5. `recovery_prompted` odpala `on_halt` przez sink.'
      ],
      outcome: 'Run czeka na decyzję użytkownika w menu recovery; konsultacja się nie odbyła.'
    },
    {
      title: 'Wznowienie długiej sesji planowania z compactionThreshold: 20',
      steps: [
        '1. Run z planerem claude-code ma 40 wiadomości w session.jsonl i brak otwartego recovery.',
        '2. initializeWorkflow woła autoCompactResumeContext; 40 > 20.',
        '3. Format auto → freeform; zostaje 19 ostatnich wiadomości.',
        '4. planner.summarize streszcza 21 starszych; rekord `summary` trafia do session.jsonl; tokeny księgowane na planera.',
        '5. Gdy planer nie ma zapamiętanego wątku, applyRebuiltContext daje mu summary + 19 wiadomości.'
      ],
      outcome: 'Planer kontynuuje z mniejszym kontekstem; oryginalne wiadomości zostają w logu.'
    },
    {
      title: 'Po zmianie wersji Node binding better-sqlite3 nie działa',
      steps: [
        '1. Tura planowania woła buildRepoMap.',
        '2. createParseCache: import better-sqlite3 rzuca `ERR_DLOPEN_FAILED`.',
        '3. Notice `Repo-map cache unavailable. Continuing without caching.`; pełna diagnostyka w logu sesji.',
        '4. Każdy plik jest parsowany od nowa.'
      ],
      outcome: 'Repo-map trafia do promptu; planowanie jest tylko wolniejsze. `npm rebuild better-sqlite3` przywraca cache.'
    },
    {
      title: 'Dysk pełny w trakcie runu',
      steps: [
        '1. Zapis linii do session.jsonl rzuca.',
        '2. JSONL sink publikuje raz warning `session_log_degraded`.',
        '3. Zapis evidence.json rzuca; warning `Could not save the run evidence …`.',
        '4. Snapshot post-task rzuca; warning `snapshot (post-task-3) failed`.'
      ],
      outcome: 'Run trwa. Brakuje części historii, dowodów i punktów do /run reject. Jedynie brak snapshotu bazowego na starcie budowy zatrzymałby run.'
    },
    {
      title: 'Uszkodzony evidence.json',
      steps: [
        '1. Plik evidence.json nie przechodzi EvidenceLedgerSchema.',
        '2. Każdy readEvidenceLedger rzuca `evidence ledger is invalid`.',
        '3. Wynik każdego briefu daje warning; zapisy odmów giną bez komunikatu.',
        '4. plannerRejectionContext łapie błąd i daje pusty kontekst.',
        '5. Zapis statusu finalnego review daje ostrzeżenie `Failed to record final review evidence`.'
      ],
      outcome: 'Run kończy się normalnie, ale ledger i review packet nie mają nowych dowodów.'
    },
    {
      title: 'Wątek Codex wygasł przy kontynuacji planowania',
      steps: [
        '1. Run wznawia planowanie z zapisanym `plannerSessionId`.',
        '2. Narzędzie odpowiada `no rollout found for thread id`.',
        '3. Adapter cli zeruje id sesji; withFreshSessionReissue rozpoznaje wygaśnięcie.',
        '4. Warning `Planner session expired; the call runs again on a fresh session…`.',
        '5. Jedno ponowienie z odbudowanym transkryptem.'
      ],
      outcome: 'Planowanie trwa na nowej sesji. Drugi błąd idzie do recovery.'
    },
    {
      title: 'Implementer kończy bez zmian w plikach',
      steps: [
        '1. Implementer z kontraktem `direct` (np. CLI) kończy wywołanie.',
        '2. detectChanges porównuje git-status lub hashe z baseline sprzed wywołania.',
        '3. Brak zmian; warning `Implementer … wrote nothing for task T002`.'
      ],
      outcome: 'Próba kończy się `no-staged-change`; dalsze retry i eskalacja → zobacz build.'
    }
  ],
  files: [
    { path: 'src/engine/events/bus.ts', role: 'EventBus: synchroniczny fan-out z izolacją błędów' },
    { path: 'src/engine/orchestrator/run/init-sinks.ts', role: 'attachRunSinks: które sinki i w jakiej kolejności' },
    { path: 'src/engine/events/sinks/jsonl.ts', role: 'zapis session.jsonl, wykluczone typy, degraded warning' },
    { path: 'src/engine/events/bound.ts', role: 'przycinanie i redakcja zdarzenia dla konsumenta' },
    { path: 'src/engine/orchestrator/events.ts', role: 'publish* helpery, publishRunnerCallEvent' },
    { path: 'src/engine/orchestrator/run/call-publishing.ts', role: 'opakowanie planera/reviewera publikacją zdarzeń wywołań' },
    { path: 'src/engine/hooks/run-pre.ts', role: 'sekwencyjne hooki pre_*' },
    { path: 'src/engine/hooks/dispatch.ts', role: 'uruchomienie hooka, interpretacja wyniku, on_failure' },
    { path: 'src/engine/hooks/sink.ts', role: 'hook sink: post_task, post_validation, on_halt, on_complete, on_error' },
    { path: 'src/engine/hooks/substitute.ts', role: 'podstawianie ${event.pole}' },
    { path: 'src/core/schemas/hooks.ts', role: 'schemat hooków, zakaz powłok, retired pre_commit/post_commit' },
    { path: 'src/core/hooks/trust.ts', role: 'receipt zaufania w ~/.splitbrief/trust/hooks.json' },
    { path: 'src/core/hooks/trust-digest.ts', role: 'digest konfiguracji i skryptów hooków' },
    { path: 'src/cli/hook-trust-prompt.ts', role: 'ensureHooksTrusted: disclosure, pytanie, odmowa bez TTY' },
    { path: 'src/engine/orchestrator/run/snapshots.ts', role: 'run-baseline, pre-final-review, post-task' },
    { path: 'src/engine/snapshots/create.ts', role: 'tworzenie snapshotu pełnego lub różnicowego' },
    { path: 'src/engine/snapshots/run/rollback.ts', role: 'odrzucenie runu w checkout plik po pliku' },
    { path: 'src/engine/codebase/repomap.ts', role: 'buildRepoMap: wejście repo-mapy' },
    { path: 'src/engine/codebase/cache.ts', role: 'cache SQLite parsowania' },
    { path: 'src/engine/codebase/pagerank.ts', role: 'PageRank z personalizacją' },
    { path: 'src/engine/orchestrator/resume-context.ts', role: 'auto-kompakcja, odbudowa kontekstu, ponowienie na świeżej sesji' },
    { path: 'src/core/sessions/compaction.ts', role: 'compactTranscript: rekord summary w session.jsonl' },
    { path: 'src/core/evidence/ledger-storage.ts', role: 'odczyt i zapis evidence.json pod blokadą' },
    { path: 'src/engine/orchestrator/evidence/persistence.ts', role: 'zapisy evidence z kroków runu' },
    { path: 'src/engine/orchestrator/evidence/review-capture.ts', role: 'review-changes.json: bajty przed/po briefu' },
    { path: 'src/engine/orchestrator/run/skills-context.ts', role: 'blok Active Project Skills' },
    { path: 'src/engine/skill-discovery.ts', role: 'odkrywanie i ładowanie skilli' },
    { path: 'src/engine/change-detection.ts', role: 'czy implementer coś zapisał' },
    { path: 'src/core/attachments/resolve.ts', role: 'rozwiązywanie @plików i obrazów' },
    { path: 'src/engine/orchestrator/summary/build.ts', role: 'buildSummary: tokeny, koszt, rollupy' },
    { path: 'src/engine/providers/pricing-resolver.ts', role: 'stawki: models.dev, tabela wbudowana, bez ceny' },
    { path: 'src/engine/providers/models-dev-cache.ts', role: 'cache katalogu models.dev (TTL 1 h)' },
    { path: 'src/core/gitignore-bookkeeping.ts', role: 'czy .gitignore zmienił tylko SPLITBRIEF' },
    { path: 'src/core/logger.ts', role: 'włączenie debug.log' }
  ],
  gotchas: [
    'Dokumentacja (docs/HOOKS-CONFIG.md, quick start) pokazuje `post_task` z `${event.file}`, ale zdarzenie `task_completed` nie ma pola `file` (src/engine/events/schema.ts:517). Placeholder daje pusty string. Kod wygrywa.',
    'docs/HOOKS-CONFIG.md mówi, że `post_task` briefu N kończy się przed `pre_task` briefu N+1. Sink odpala hooki przez `void runEntriesAndReport(...)` bez czekania (src/engine/hooks/sink.ts:20), więc mogą się nakładać.',
    'docs/HOOKS-CONFIG.md mówi, że stderr hooka zawsze trafia jako warning. W kodzie pole `stderr` z outcome nie jest publikowane nigdzie; ostrzeżenia hooków pre_* (warn, ENOENT, crash bez block) zbiera runPreHooks, ale żadne wywołanie ich nie publikuje.',
    'docs/SUBSYSTEMS.md §1 wymienia `pre_commit` i `post_commit` jako aktywne. Schemat odrzuca niepustą listę (src/core/schemas/hooks.ts:366); pusta jest usuwana.',
    '`on_error` dokumentacja opisuje jako niemożliwy do naprawienia błąd silnika. Hook odpala się na każde zdarzenie `error`, np. częściowe zastosowanie odpowiedzi API, które kończy się recovery.',
    'Hooki startują w `cwd: projectDir` (checkout), nie w worktree. Pliki runu w trybie worktree hook znajdzie przez `workspaceDir` ze stdin.',
    'Brak zaufania do hooków w trakcie runu działa jak deny: każdy pre_task pomija brief, zamiast zatrzymać run.',
    'Kompakcja transkryptu działa tylko przy wznowieniu runu (src/engine/orchestrator/run/init.ts:364), nigdy w trakcie żywego runu, i tylko gdy `workflow.compactionThreshold` jest ustawione (domyślnie nie jest).',
    'docs/ENGINE.md odsyła do „SUBSYSTEMS.md section 11” po kompakcję; to sekcja 6.',
    'Snapshoty pomijają także pliki ignorowane przez git (checkIgnoredPaths w src/engine/snapshots/files.ts:52), nie tylko `.git`, `.splitbrief`, `node_modules`, `.trees`.',
    'Brak snapshotu bazowego to jedyny błąd snapshotu, który zatrzymuje run; reszta daje warning.',
    'Checki planu przed finalnym review są zapisywane w ledgerze na wpisie ostatniego briefu (src/engine/orchestrator/run/task-execution.ts:261).',
    'Uszkodzony `evidence.json` nie jest naprawiany: każdy kolejny zapis zawodzi z warningiem, a odmowy giną bez komunikatu.',
    'Repo-map przy uszkodzonym SQLite sama kasuje bazę i otwiera nową (src/engine/codebase/cache.ts:134); docs/REPOMAP.md tego nie opisuje.',
    'Dopasowanie basename w repo-mapie bierze pierwszy plik o tej nazwie (src/engine/codebase/extract-mentioned-filenames.ts:21); przy wielu `index.ts` personalizacja może trafić w zły plik.',
    'Seat CLI nigdy nie ma ceny w Summary (`unpriced-cli`), nawet gdy model ma stawkę w models.dev; kwoty liczą się tylko dla seatów `api`.',
    'docs/ARCHITECTURE.md mówi, że JSONL sink pisze przez `appendEngineEvent`; kod używa createSessionLogAppender + toEngineEventEntry (src/engine/events/sinks/jsonl.ts:39).'
  ]
});
