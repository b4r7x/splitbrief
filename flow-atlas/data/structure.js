window.ATLAS = window.ATLAS || [];
(function () {
  // Tree nodes are written as [name, layer, role, key, children]; paths are built from the parent.
  function build(prefix, items) {
    return items.map(function (it) {
      var path = prefix ? prefix + '/' + it[0] : it[0];
      var node = { path: path, role: it[2], layer: it[1], key: it[3] === true };
      if (it[4] && it[4].length) node.children = build(path, it[4]);
      return node;
    });
  }

  var tree = build('', [
    ['src', 'other', "Cały kod produkcyjny: 1250 plików .ts/.tsx (~198 tys. linii) i 1149 plików testów obok kodu.", true, [
      ['cli.ts', 'cli', "Binarka `splitbrief` (commander): rejestruje 8 podkomend — start, doctor, spec, init, status, resume, review, continue.", true],
      ['node-env.ts', 'cli', "Pierwszy import `cli.ts`: ustawia `NODE_ENV=production`, żeby React nie zapychał pamięci pomiarami renderów."],
      ['app', 'app', "Powłoka Ink: korzeń kompozycji, router, layout, globalne klawisze i mysz, płaskie strony ekranów i overlayów.", true, [
        ['root.tsx', 'app', "Komponent `App`: czyta routerStore/overlayStore, podpina useRuntimeCommands, useAppKeys, useAppMouse, renderuje <AppProvider><Router/>.", true],
        ['router.tsx', 'app', "`renderScreen` (3 ekrany) i `renderOverlay` (13 id overlayów → 8 stron); wynik trafia do <Layout>.", true],
        ['provider.tsx', 'app', "`AppProvider`: dziś tylko ThemeProvider."],
        ['layout.tsx', 'app', "Szkielet ekranu: nagłówek + ciało + overlay + stopka."],
        ['keys.ts', 'app', "`useAppKeys`: globalne klawisze (esc, ctrl+c, ctrl+s, paleta)."],
        ['mouse.ts', 'app', "`useAppMouse`: globalne strefy myszy."],
        ['command-context.ts', 'app', "`useRuntimeCommands`: buduje RuntimeCommandContext (porty do stores i engine: Apply, Discard, recovery bus) i rejestr 23 komend.", true],
        ['refresh-skills.ts', 'app', "Ponowne `discoverSkills` → skillsStore przy otwieraniu overlayu skills (nie jest modułem powłoki)."],
        ['prepare-resume.ts', 'app', "`prepareSessionResume`: kontrola gotowości przed kontynuacją runu; importują ją strony home, setup, workflow, palette, sessions."],
        ['session-preparation.tsx', 'app', "Strona gotowości kontynuacji; router pokazuje ją zamiast ekranu."],
        ['screens', 'app', "Płaskie strony pełnoekranowe (dokładnie 3 segmenty ścieżki — warunek reguły izolacji stron).", false, [
          ['home.tsx', 'app', "Ekran startowy: składa features/home (7 importów) i features/start-preparation."],
          ['workflow.tsx', 'app', "Ekran runu, live i at-rest: składa features/workflow (28 importów).", true],
          ['setup.tsx', 'app', "Pierwsze uruchomienie i `splitbrief init`: crew przez features/crew i features/runners."]
        ]],
        ['overlays', 'app', "Płaskie strony overlayów; id overlayu to nie nazwa pliku (`command-palette` → palette.tsx).", false, [
          ['help.tsx', 'app', "/help: lista komend z rejestru."],
          ['palette.tsx', 'app', "Paleta komend (id `command-palette`); źródła i ranking z features/palette."],
          ['skills.tsx', 'app', "Lista skilli; strona bez folderu features."],
          ['sessions.tsx', 'app', "/sessions: wybór runu do otwarcia; strona bez folderu features."],
          ['settings.tsx', 'app', "Settings: Crew, Fallback, Tuning, Workflow, Validation."],
          ['runners.tsx', 'app', "`ToolModelPicker`: jedna strona dla 6 id overlayów (3 role × slot seat/fallback)."],
          ['usage.tsx', 'app', "/usage: tokeny i koszty runu (id `usage-details`)."],
          ['editor.tsx', 'app', "Pełnoekranowy edytor plan.json (wnętrze w features/editor)."]
        ]]
      ]],
      ['cli', 'cli', "Handlery podkomend, przygotowanie przed startem, seed stores przed renderem, montaż Ink, tryb headless.", true, [
        ['setup.ts', 'cli', "`canonicalizeProjectDir`, `ensureHeadlessConfig`, `setupWorkflow`."],
        ['options.ts', 'cli', "`addWorkflowOptions`: wspólne flagi (seat-y, --json, --plain …)."],
        ['headless.ts', 'cli', "`runHeadless`: przebieg bez TUI dla --json / --plain; sam woła runWorkflow.", false],
        ['hook-trust-prompt.ts', 'cli', "Pytanie TTY o zaufanie do hooków workflow (bez TTY odmowa, chyba że --allow-hooks)."],
        ['node-guard.ts', 'cli', "Sprawdza minimalną wersję Node (22) przed startem."],
        ['errors.ts', 'cli', "`cliError()` + `isCliError`."],
        ['bootstrap', 'cli', "Synchroniczny seed stores przed renderem; discovery po montażu.", false, [
          ['init.ts', 'cli', "`initStoresForTuiMount`, `initStores`, `teardownStores`.", true],
          ['project.ts', 'cli', "`loadProjectState`: config, sesje, instalacja persystencji historii."],
          ['discovery.ts', 'cli', "Asynchroniczne wykrywanie narzędzi i skilli."]
        ]],
        ['commands', 'cli', "Jeden plik (lub folder) na podkomendę: spec, review, doctor, resume, status, init.", false, [
          ['start', 'cli', "`splitbrief start`: register → interactive (TUI) albo streaming (headless), readiness.", false, [
            ['register.ts', 'cli', "`registerStartCommand`: rozdziela --json/--plain od trybu TUI."],
            ['interactive.ts', 'cli', "`runInteractiveStart`: seed stores, routerStore.init, renderApp(App)."]
          ]],
          ['continue', 'cli', "`splitbrief continue`: rejestracja, rozliczenie odpowiedzi recovery, wznowienie (importuje features/workflow/run-history)."]
        ]],
        ['render', 'cli', "Montaż Ink / fullscreen-ink, przekazanie terminala, cykl procesu.", false, [
          ['app.ts', 'cli', "`renderApp`: produkcyjne wejście renderu."]
        ]],
        ['sessions', 'cli', "Rozwiązywanie id sesji i aliasów numerycznych dla podkomend."]
      ]],
      ['core', 'core', "Domena SPLITBRIEF bez React i bez orkiestracji: schematy, config, maszyna stanów, sesje, crew, recovery, komendy runtime.", true, [
        ['phases.ts', 'core', "Taksonomia faz: `LIVE_PHASES`, `isLivePhase`, role faz."],
        ['paths.ts', 'core', "Wszystkie ścieżki `.splitbrief/` i `INTERNAL_SKIP_DIRS` (.git, .splitbrief, node_modules, .trees).", true],
        ['paths-io.ts', 'core', "I/O ścieżek projektu z walidacją identyfikatorów."],
        ['formatting.ts', 'core', "`formatCost`, `formatContextLength`."],
        ['rail-stages.ts', 'core', "Etapy szyny nagłówka (Plan, Build, Review, Apply)."],
        ['logger.ts', 'core', "Logger procesu."],
        ['approval', 'core', "Typy bramek zatwierdzania: `ApprovalTier` auto/confirm, fraza `I confirm`."],
        ['attachments', 'core', "Rozwiązywanie załączników (pliki, obraz ze schowka) i ich błędy."],
        ['composer', 'core', "Model dokumentu szkicu i klasyfikacja wysłania (komenda `/` czy wiadomość)."],
        ['config', 'core', "config.yaml v3: ładowanie, walidacja, akcesory, nadpisania z flag.", false, [
          ['load', 'core', "Odczyt YAML, transformacja, wartości domyślne, zapis seat-u.", false, [
            ['io.ts', 'core', "`loadConfig(projectDir)`: jedno wejście ładowania konfiguracji.", true],
            ['validation', 'core', "Walidacja configu: błędy, ostrzeżenia, poświadczenia."]
          ]],
          ['accessors', 'core', "Odczyty z configu: aktywny runner, profile implementerów, seat reviewera.", false, [
            ['reviewer-runner.ts', 'core', "`resolveReviewerRunner`: jedyny moduł, który rozgałęzia się na `config.reviewer`.", true]
          ]],
          ['runtime', 'core', "Efektywny config runu i budowa runnera.", false, [
            ['overrides', 'core', "Mapowanie flag CLI na config (`from-options`, `applyCLIOverrides`)."]
          ]]
        ]],
        ['crew', 'core', "Seat-y, wiersze crew, presety, fallback, tożsamość `<tool> · <model>`.", false, [
          ['identity.ts', 'core', "`CREW_SEAT_IDS` (plan, build, review) i jeden formatter tożsamości seat-u."],
          ['rows.ts', 'core', "`deriveCrewRows`: jeden wiersz na seat, lustro tylko do odczytu."],
          ['fallback.ts', 'core', "`deriveFallbackRows`: wiersze sekcji Fallback w Settings."]
        ]],
        ['discovery', 'core', "Schematy wykrytych modeli i cen, katalog modeli, klonowanie wykrycia."],
        ['editor', 'core', "Czysty stan edytora i ruchy po grafemach."],
        ['evidence', 'core', "Księga dowodów: stan, zapis, hash briefu, zmiany przeglądu."],
        ['hooks', 'core', "Zaufanie do hooków: grant (`trust.ts`) i digest configu (`trust-digest.ts`)."],
        ['keybindings', 'core', "Rejestr i resolver skrótów, normalizacja tokenów klawiszy."],
        ['navigation', 'core', "Typy ekranów i overlayów oraz `overlayRect` (jedyne miejsce szerokości paneli).", false, [
          ['types.ts', 'core', "`ALL_SCREENS`, `ACTIVE_OVERLAYS`, `SEAT_PICKER_OVERLAYS`.", true],
          ['overlay-rect.ts', 'core', "`overlayRect`: gęstości compact/roomy/wide."]
        ]],
        ['pipeline-spec', 'core', "Kontrakt pipeline jako dane: drabina retry, limity, halty, kolejność briefu, timeouty; czyta go engine i skrypt skills."],
        ['plan-review', 'core', "Typy ryzyka i estymat przeglądu planu."],
        ['providers', 'core', "Katalog providerów API, znane modele, wybór modelu, polityka endpointu.", false, [
          ['api-provider-catalog.ts', 'core', "`API_PROVIDER_CATALOG`; z jego kluczy wynika typ `ApiProviderId`.", true]
        ]],
        ['readiness', 'core', "Raport gotowości (doctor, start): sekcje i checki; niczego nie uruchamia.", false, [
          ['checks', 'core', "Buildery checków: config, repo, workflow, runners, context, validation (`build.ts`)."]
        ]],
        ['recovery', 'core', "Jak czyta się halt: `halt.ts` (Needs you / Seat down), nagłówek, etykiety akcji, zegar resetu.", false, [
          ['halt.ts', 'core', "`REASON_HALT`: przyczyna → halt → dozwolone akcje.", true]
        ]],
        ['review', 'core', "Werdykt, zadania naprawcze, base split, odczyt rekordu przeglądu."],
        ['runners', 'core', "Katalog narzędzi CLI, role seat-ów, capability, kanał effort, wybór auth.", false, [
          ['cli-tool-catalog.ts', 'core', "`CLI_TOOL_CATALOG`: deskryptory 8 narzędzi CLI (role, auth, model, postawa).", true],
          ['seat-roles.ts', 'core', "`SeatPickerRole`, `PickerSlot`, `ActiveRunnerRole`."],
          ['capabilities.ts', 'core', "Co runnerowi wolno kazać uruchomić (nie w engine — gate 47)."]
        ]],
        ['runtime', 'core', "Kontener bez plików: zawiera tylko commands/.", false, [
          ['commands', 'core', "Komendy runtime `/name`: rejestr, dispatch, lookup (fzf), fabryka kontekstu.", false, [
            ['registry.ts', 'core', "`createRuntimeCommands`: skleja 5 modułów defs/ w kolejności `COMMAND_CATEGORIES`.", true],
            ['dispatch.ts', 'core', "`executeRuntimeCommand`: parsuje `/name args`, sprawdza ekran i guard, wykonuje."],
            ['types.ts', 'core', "`RuntimeCommandDef`, `RuntimeCommandContext`, `COMMAND_CATEGORIES`, `REMOVED_COMMANDS`."],
            ['context-factory.ts', 'core', "`createCommandContext`: składa porty kontekstu komend."],
            ['defs', 'core', "23 komendy: navigate (7), crew (2), workflow (6), view (6), io (2)."]
          ]]
        ]],
        ['schemas', 'core', "Schematy Zod i ich typy `z.infer`: config, stan workflow, task, plan, log sesji, review packet.", true, [
          ['config.ts', 'core', "`ConfigSchema` (version 3).", true],
          ['enums.ts', 'core', "`PHASES`, `RECOVERY_REASONS`, `RUNNER_KINDS`, statusy zadań.", false],
          ['recovery', 'core', "Schematy i fakty recovery."]
        ]],
        ['scope', 'core', "`declared-set.ts`: jedyny matcher ścieżki do zakresu briefu."],
        ['sections', 'core', "Sekcje transkryptu z eventów (stabilna tożsamość diffów); 1 plik, 671 linii."],
        ['sessions', 'core', "Sesje na dysku: active pointer, lockfile, liveness, log JSONL, run record, run status, drafty.", true, [
          ['run-status.ts', 'core', "`deriveRunStatus`: running / open / ready-to-apply / closed; `resumeStep`.", true],
          ['run-record.ts', 'core', "`RunRecord` + `loadRunRecord`: wszystko, czego ekran lub guard potrzebuje o runie.", false],
          ['log-writer.ts', 'core', "`appendEngineEvent`: dopisywanie do session.jsonl."]
        ]],
        ['settings', 'core', "Katalog ustawień: sekcje Crew, Fallback, Tuning, Workflow, Validation."],
        ['skills', 'core', "Ścieżki skanowania skilli i typ SkillMeta."],
        ['state', 'core', "Maszyna stanów workflow, persystencja state.json, selektory, sortowanie topologiczne.", false, [
          ['machine.ts', 'core', "`transition()`: reduktor stanu; `phaseActions` mówi, co wolno w danej fazie.", true],
          ['migration', 'core', "Migracja starych stanów (legacy, v3)."]
        ]],
        ['theme', 'core', "Palety, tony, rozwiązywanie kolorów (chalk) i malowanie zwykłego wyjścia."],
        ['tokens', 'core', "Estymator tokenów i domyślne okno kontekstu."],
        ['trust', 'core', "Magazyn zgód (receipts) i klasyfikacja komend oraz interpreterów do decyzji zaufania."],
        ['types', 'core', "Typy TS bez schematu (config-options, session-ref, user-input); `z.infer` zakazane (gate 2)."],
        ['validation', 'core', "Wykrywanie komend walidacji (lint, testy, manifest) bez uruchamiania.", false, [
          ['stacks', 'core', "5 stosów (TS, JS, Python, Go, Rust) i `STACKS`; jedyne miejsce literałów komend (gate 48)."]
        ]]
      ]],
      ['engine', 'engine', "Orkiestrator bez React/Ink: pętla runu, seat-y, runnery, providery, eventy, snapshoty.", true, [
        ['availability.ts', 'engine', "Sondowanie dostępności komend."],
        ['skill-discovery.ts', 'engine', "`discoverSkills` po rootach z core/skills/scan-paths."],
        ['error-hints.ts', 'engine', "Diagnoza błędów i podpowiedzi (np. dla providera)."],
        ['routing-preview.ts', 'engine', "Podgląd routingu zadań do profili implementerów."],
        ['calls', 'engine', "Znormalizowane wywołania runnera: eventy `runner_call_*`, recorder, collector, usage, steering."],
        ['codebase', 'engine', "Repo-map: tree-sitter, graf importów, PageRank, budżet tokenów, cache SQLite.", false, [
          ['repomap.ts', 'engine', "`buildRepoMap`: wejście pipeline'u repo-map."]
        ]],
        ['detection', 'engine', "Wykrywanie narzędzi i modeli: service, coordinator, cache, publikacja do stores.", false, [
          ['service.ts', 'engine', "`getDefaultDetectionService`."]
        ]],
        ['events', 'engine', "EventBus: schemat EngineEvent, bus, replay logu, bounding, publiczny rekord --json.", false, [
          ['schema.ts', 'engine', "`EngineEventSchema` (dyskryminacja po `type`) + `parseEngineEvent`.", true],
          ['bus.ts', 'engine', "`createEventBus`: synchroniczny pub/sub; wyjątek sinka nie przerywa publikacji.", true],
          ['types.ts', 'engine', "`EngineEvent = z.infer<…>` oraz porty `EventBus` / `EventSink`."],
          ['replay.ts', 'engine', "`readRunEvents`: odczyt session.jsonl z powrotem (odwrotność zapisu)."],
          ['sinks', 'engine', "Sinki headless i persystencji: jsonl, logger, stdout-json, stdout-text."]
        ]],
        ['hooks', 'engine', "Runtime hooków workflow: `pre_*` blokujące, `post_*` / `on_*` przez sink na busie."],
        ['implementers', 'engine', "Backendy implementera (cli, api, shell, agent, command-invoke) i port `Implementer`.", false, [
          ['types.ts', 'engine', "Port `Implementer`."],
          ['isolation', 'engine', "Granice zapisu implementera: lexer shella, audyt checkoutu, ścieżki narzędzi."],
          ['pipeline', 'engine', "`createImplementerBase`: wspólny przebieg wywołania i mapowanie wyniku."]
        ]],
        ['orchestrator', 'engine', "Główna pętla runu: 205 plików, ~39 tys. linii; planowanie, briefy, review, recovery, Apply.", true, [
          ['final-review.ts', 'engine', "Końcowy przegląd runu (→ obszar review).", false],
          ['events.ts', 'engine', "36 typowanych helperów `publish*` dla EventBus."],
          ['apply', 'engine', "Apply / Discard: zapis łatki do checkoutu, backup, restore, merge, wariant at-rest."],
          ['approval', 'engine', "Bramki zatwierdzania: klasyfikacja akcji, tiered approval, staged project.", false, [
            ['file-snapshots', 'engine', "Przechwyt i przywracanie plików przed zatwierdzeniem."]
          ]],
          ['consult', 'engine', "Konsultacja plannera przy eskalacji: prośba, potwierdzenie decyzji, zastosowanie."],
          ['context-routing', 'engine', "Routing briefu do profilu implementera po oknie kontekstu."],
          ['drift', 'engine', "Analiza dryfu briefów: raz na run, przed final review."],
          ['escalation', 'engine', "Lokalne retry, czekanie na seat, walidacja i commit po retry, wskazówki konsultacji."],
          ['evidence', 'engine', "Zapis dowodów runu: zadania, checki, approval.", false, [
            ['review-packet', 'engine', "Budowa, dopasowanie i zapis pakietu przeglądu dla reviewera."]
          ]],
          ['isolation', 'engine', "Izolacja runu: worktree lub staged copy, retencja, base tree."],
          ['planning', 'engine', "Sesja planowania: pytania, typed plan, plan checks, plan card (→ obszar planning).", false, [
            ['plan-session.ts', 'engine', "`runPlanSession`.", false],
            ['session.ts', 'engine', "Napędza sesję planowania i plan card."]
          ]],
          ['queue', 'engine', "Kolejka korekt i steer: submit, drain, wstrzyknięcie w trakcie wywołania."],
          ['recovery', 'engine', "Halty, akcje recovery, switch seat, recovery bus między turami (→ obszar recovery).", false, [
            ['builders', 'engine', "Buildery issue recovery per przyczyna (task, planner, apply, checks …)."],
            ['bus.ts', 'engine', "`createRecoveryBus`: bus z sinkiem hosta i logiem sesji dla odpowiedzi między turami (gate 52)."]
          ]],
          ['run', 'engine', "Cykl runu: runWorkflow, init, fazy, sinki, seat-y, heartbeat, close, continue.", false, [
            ['workflow.ts', 'engine', "`runWorkflow`: jedno wywołanie na turę; wołają go use-run-loop (TUI) i headless.", true],
            ['init-sinks.ts', 'engine', "`attachRunSinks`: jedyne miejsce subskrypcji sinków runu.", true],
            ['init-seats.ts', 'engine', "`createPlannerSeat` / `createImplementerSeat`."]
          ]],
          ['session-lifecycle', 'engine', "Finalizacja, kolejka, shutdown i rejestr Apply tego procesu (`activeApply`).", false, [
            ['shutdown.ts', 'engine', "`shutdownWorkflow`, `activeApply` — importowane nawet przez components/composer."]
          ]],
          ['summary', 'engine', "summary.json: metryki zadań, czas aktywny, uzgodnienie usage, sink call-evidence."],
          ['task', 'engine', "Pętla briefów: routing, bramka zależności, wywołanie implementera, checki, rollback, commit (→ obszar build).", false, [
            ['loop.ts', 'engine', "`runTaskLoop`.", false],
            ['step.ts', 'engine', "Jeden brief: wejście `runSingleTask`."]
          ]],
          ['transcript', 'engine', "Odbudowa i kompakcja transkryptu do wznowienia."],
          ['validation', 'engine', "Checki: uruchamianie komend, polityka komend reviewera, testy, akceptacja.", false, [
            ['reviewer-command-policy.ts', 'engine', "Polityka komend reviewera (bez allowlisty, z regułami odmowy)."]
          ]]
        ]],
        ['parsers', 'engine', "Ekstrakcja kodu, zakresu i werdyktu final review z odpowiedzi."],
        ['planners', 'engine', "Backendy plannera (claude-code, cli, api, shell, agent, command-invoke) i port `Planner`.", false, [
          ['types.ts', 'engine', "Port `Planner` i `PlannerCapabilities`."],
          ['base.ts', 'engine', "`createPlannerBase`: wspólne rusztowanie."]
        ]],
        ['providers', 'engine', "Klienci HTTP OpenAI-compatible, ceny, katalog models.dev, `KNOWN_PROVIDERS`.", false, [
          ['registry.ts', 'engine', "`KNOWN_PROVIDERS: Record<ApiProviderId, …>` i `getProvider`.", true],
          ['client', 'engine', "Połączenie, klucz API, dostępność, metadane."],
          ['cost', 'engine', "Rozbicie kosztów runu i estymaty zapytań."],
          ['model', 'engine', "Katalog, rozwiązywanie, nazwy wyświetlane modeli, okno kontekstu."],
          ['models-dev-cache', 'engine', "Pobranie i parsowanie katalogu models.dev (worker)."],
          ['openai-stream', 'engine', "Jedyny transport streamu OpenAI-compatible (gate 32)."]
        ]],
        ['reviewers', 'engine', "Port `Reviewer` (1 plik, 23 linie); reviewer to Planner w seat-cie review."],
        ['runners', 'engine', "Fabryka runnerów, adaptery CLI, sandbox env, auth, usage-limit, prepared execution.", false, [
          ['factory.ts', 'engine', "`createPlanner` / `createReviewer` / `createImplementer`: switch po `kind` z leniwymi loaderami.", true],
          ['claude', 'engine', "Argv i env dziecka Claude Code."],
          ['cli-tools', 'engine', "8 adapterów narzędzi CLI, kontrakt, rejestr, harness zgodności.", false, [
            ['registry.ts', 'engine', "`CLI_PLANNER_ADAPTERS` / `CLI_IMPLEMENTER_ADAPTERS`.", true],
            ['contract.ts', 'engine', "Typy `CliPlannerAdapter` / `CliImplementerAdapter`."]
          ]],
          ['prepare-execution', 'engine', "`prepareExecution`: dopuszczenie seat-ów przed runem."],
          ['sandbox-env.ts', 'engine', "Allowlista env dziecka i prywatny HOME seat-u."],
          ['usage-limit.ts', 'engine', "Rozpoznanie limitu konta (→ obszar runners)."]
        ]],
        ['snapshots', 'engine', "Snapshoty adresowane treścią: manifest, bloby, lock, kodowanie ścieżek.", false, [
          ['run', 'engine', "Snapshot runu: cykl życia, rollback, zmiany at-rest, ledger."]
        ]],
        ['spec', 'engine', "Plan checks, render plan.md / tasks.md, budżet tokenów promptów.", false, [
          ['plan-checks.ts', 'engine', "`checkPlan` (importuje go też features/editor)."],
          ['prompts', 'engine', "Buildery promptów: plan-session, tasks, review, consult, system."]
        ]],
        ['streaming', 'engine', "Parsery wyjścia narzędzi (stream-json, jsonl, opencode, copilot, antigravity) i spawn-collect."]
      ]],
      ['features', 'features', "Pionowe plastry UI. Nie importują się nawzajem (0 krawędzi); wejściem jest strona w app/.", true, [
        ['crew', 'features', "Wiersze crew i fallback (lustra seat-ów), presety; bez własnej strony.", false, [
          ['rows.ts', 'features', "`crewActivate` / `fallbackActivate`: ⏎ otwiera picker seat-u przez overlayStore."]
        ]],
        ['editor', 'features', "Wnętrze edytora plan.json: bufor, viewport, klawisze, `plan-save` (woła checkPlan)."],
        ['home', 'features', "Ekran startowy: logo, layout, sprawdzenie narzędzi.", false, [
          ['components', 'features', "Blok seat-ów i lista ostatnich sesji."]
        ]],
        ['palette', 'features', "`sources.ts` (źródła), `results.ts` (ranking), fuzzy-match."],
        ['runners', 'features', "Picker narzędzie/model dla 3 ról i 2 slotów, formularz lokalnego połączenia, karta kontraktu.", false, [
          ['model-catalog', 'features', "Wiersze modeli, osie opcji (effort, fast, thinking), łączenie providerów."],
          ['two-column-picker', 'features', "Dwukolumnowy picker: stan nawigacji, wirtualne pozycje, klawiatura."]
        ]],
        ['settings', 'features', "Pozycje, prezentacja, fokus i pomoc Settings.", false, [
          ['hooks', 'features', "Edytor i bufor wartości ustawienia."]
        ]],
        ['start-preparation', 'features', "Panel gotowości startu i jego cykl (`useStartPreparation`)."],
        ['workflow', 'features', "Ekran runu: transkrypt, chrome, byline, prompty, stop, wynik, run zamknięty (143 pliki).", false, [
          ['tui-sink.ts', 'features', "`addTuiEvent`: sink TUI; bounduje event i woła `addEvent`.", true],
          ['run-history.ts', 'features', "`hydrateRun`: replay session.jsonl do stores (run at-rest)."],
          ['at-rest.ts', 'features', "Szyna at-rest: znak etapu, na którym run stanął."],
          ['closed', 'features', "Blok `Closed ─` zamkniętego runu: view model, copy, byline.", false, [
            ['rows', 'features', "Wiersze Briefs / Files / Run / lead bloku zamkniętego."]
          ]],
          ['components', 'features', "Nagłówek, sidebar, szyna, build progress, menu recovery, prompty.", false, [
            ['approval-prompt', 'features', "Prompt potwierdzenia i jego dokument."],
            ['conversation-flow', 'features', "Viewport rozmowy oparty o wiersze."]
          ]],
          ['conversation-rows', 'features', "Budowa wierszy transkryptu z eventów (cache, okna, batchowanie aktywności).", false, [
            ['event-rows', 'features', "Wiersze per typ eventu.", false, [
              ['dispatch.ts', 'features', "`eventRowBlock`: switch po `event.type` zakończony `assertNever`.", true]
            ]],
            ['markdown-rows', 'features', "Wiersze markdownu plannera i review liczone w wierszach terminala."],
            ['row-format', 'features', "Formatowanie wierszy, kart i etykiet."]
          ]],
          ['copy', 'features', "Rozwiązywanie tekstów UI workflow."],
          ['display', 'features', "Byline i aktywność: `deriveBuildProgress`, live activity, tożsamość seat-u z zapisu."],
          ['hooks', 'features', "Klawisze, mysz, kontynuacja runu, pętla runu.", false, [
            ['use-run-loop.ts', 'features', "Pętla TUI: woła runWorkflow z `tuiSink: addTuiEvent`, recovery między turami."],
            ['workflow-screen', 'features', "`useWorkflowScreen`: model ekranu i edycja inline."]
          ]],
          ['layout', 'features', "Wiersze chrome, hit-test, prostokąty, okno przewijania."],
          ['prompt-rows', 'features', "Pomiar i wiersze promptów: pytanie, approval, recovery."],
          ['result', 'features', "Menu Apply · Show diff · Discard."],
          ['review-checks', 'features', "Karta Run all / Skip all dla reviewer checks."],
          ['stop', 'features', "Stop sheet: opcje, menu, byline."]
        ]]
      ]],
      ['components', 'components', "Wspólne komponenty UI (≥2 feature'y): theme, markdown, listy, composer, pickery.", false, [
        ['theme.tsx', 'components', "Jedyny import Ink `Text`; reszta używa ThemeText (gate 57)."],
        ['markdown.tsx', 'components', "Render markdownu Ink nad czystym rdzeniem utils/markdown."],
        ['composer', 'components', "Composer na każdym ekranie: historia, wklejanie, szkice, podpowiedzi.", false, [
          ['composer.tsx', 'components', "Komponent composera (importuje engine/providers/model/display-names)."],
          ['completion', 'components', "Panel podpowiedzi i nawigacja.", false, [
            ['command', 'components', "Menu podpowiedzi komend `/`."],
            ['reference', 'components', "Menu referencji plików `@`."]
          ]]
        ]],
        ['input', 'components', "Wielowierszowe pole tekstowe (segmenty, edycja, przewijanie)."],
        ['overlays', 'components', "`OverlayPanel`: rozmiar wyłącznie z overlayRect."],
        ['pickers', 'components', "Lista filtrowalna, viewport, okno przewijania, wiersze opcji."]
      ]],
      ['hooks', 'hooks', "5 wspólnych hooków: spinner, static selector, filterable list, nazwy crew, wspólny zegar."],
      ['lib', 'lib', "Wrappery infrastruktury bez wiedzy o SPLITBRIEF: fs, git, procesy, terminal, schowek, HTTP.", false, [
        ['fs.ts', 'lib', "`ensureSecureDir`, `writeSecureFile`, `ensureGitignore`."],
        ['confined-fs-atomic.ts', 'lib', "Atomowe zapisy zamknięte w katalogu; największy plik produkcyjny (1533 linie)."],
        ['file-lock.ts', 'lib', "Blokada pliku dla zapisów całego payloadu."],
        ['clipboard', 'lib', "Schowek: OSC 52, natywny, obraz (osascript z AppKit na macOS)."],
        ['git', 'lib', "Granica simple-git i helpery diff, refs, merge.", false, [
          ['client.ts', 'lib', "Jedyny produkcyjny import `simple-git` (gate 6); `runGit`, `gitError`.", false]
        ]],
        ['http', 'lib', "`policy-fetch`: fetch z ręcznymi przekierowaniami."],
        ['process', 'lib', "Cykl podprocesów: rejestr, liveness, ograniczone wyjście, ścieżka komendy.", false, [
          ['spawn', 'lib', "Spawn dziecka: env, strumień linii, postęp, lifecycle."]
        ]],
        ['terminal', 'lib', "Terminal I/O: kitty keyboard, mysz, OSC 8, tło, wejście tekstu (importuje ink).", false, [
          ['filtered-stdin', 'lib', "Most stdin dla Ink: wklejanie, mysz, escape."]
        ]]
      ]],
      ['stores', 'stores', "Zewnętrzne stores (useSyncExternalStore): jedyny kanał engine ↔ UI; do engine tylko `import type`.", true, [
        ['create-store.ts', 'stores', "`createStore` (get/set/subscribe/use/reset) i `storeBase`; 71 linii.", true],
        ['use-stores.ts', 'stores', "`useStores`: odczyt wielu stores śledzony Proxy."],
        ['approval-prompt', 'stores', "`approvalPromptStore`: chronione zapisy, admission custom runnera."],
        ['channels', 'stores', "`createPromptChannel` i kanał feedbacku między stores."],
        ['discovery', 'stores', "Adapter detekcji.", false, [
          ['model-cache', 'stores', "`modelCacheStore`: katalogi modeli, lane'y, reconcile."]
        ]],
        ['navigation', 'stores', "Routing ekranów, gotowość, wybór sesji.", false, [
          ['router.ts', 'stores', "`routerStore`: trasa (screen + RunRecord + execution) i guardy przejść.", true],
          ['session-select.ts', 'stores', "`continueRunInPlace`: kontynuacja runu bez nawigacji."]
        ]],
        ['project', 'stores', "Stan z dysku: config, sesje, skille, detekcja, zapis configu."],
        ['question-prompt', 'stores', "Pytania plannera czekające na odpowiedź."],
        ['review-checks-prompt', 'stores', "Karta reviewer checks (approve_checks: ask)."],
        ['ui', 'stores', "Chrome UI: overlay, rozmiar terminala, composer, drafty sesji, historia, edytor."],
        ['workflow', 'stores', "Stan runu: events, tasks, tokens, lifecycle, stop, departure, recovery notice …", false, [
          ['actions', 'stores', "Zapisy złożone przez sub-stores: event, load, hydrate, reset, pause, resume …", false, [
            ['event.ts', 'stores', "`addEvent`: rozkłada EngineEvent na events → tasks → tokens → lifecycle → operations.", true]
          ]],
          ['operations', 'stores', "Aktywna operacja runnera z eventów `runner_call_*`."],
          ['tokens.ts', 'stores', "`updateTokens`: drugi wyczerpujący switch po EngineEvent (assertNever)."]
        ]]
      ]],
      ['utils', 'utils', "Czyste prymitywy, liść grafu (0 importów wychodzących do innych warstw).", false, [
        ['error.ts', 'utils', "Fabryka `error(kind, msg, …)` i predykat `matches` (ERRORS.md).", false],
        ['type-guards.ts', 'utils', "`assertNever`, `isRecord`, `typedEntries`."],
        ['markdown', 'utils', "Parser i layout markdownu bez UI (GFM, tabele, highlight lowlight)."]
      ]]
    ]],
    ['scripts', 'tooling', "Skrypty bram i narzędzi: invariants, import-boundaries, skills, tui-shots, conformance, release smoke.", false, [
      ['check-invariants.ts', 'tooling', "Runner 53 bram; zły wynik komendy = FAIL (fail closed)."],
      ['invariants', 'tooling', "Definicje bram.", false, [
        ['gates.ts', 'tooling', "Lista bram id 1–59 (z lukami) z komendą i oczekiwaną liczbą.", true]
      ]],
      ['import-boundaries.ts', 'tooling', "Gate 9 / 12c: `classify()` każdej relatywnej krawędzi importu w src/.", true],
      ['testing-helper-imports.ts', 'tooling', "Gate 20: testy importują helpery przez alias `#testing/*`."],
      ['recovery-producers.ts', 'tooling', "Gate 53: każda żywa przyczyna recovery ma producenta w src/engine."],
      ['user-facing-text.ts', 'tooling', "Gate 59: tekst dla użytkownika bez wewnętrznych znaczników."],
      ['skill-blocks.ts', 'tooling', "Renderuje bloki `<!-- generated -->` skilli z core/pipeline-spec."],
      ['sync-skills.ts', 'tooling', "`skills:sync` / `skills:check`: lustra skilli."],
      ['tui-shots.ts', 'tooling', "Rendery PNG scenariuszy galerii TUI."],
      ['tui-shots', 'tooling', "Wybór scenariuszy i katalog wyjścia tui-shots."],
      ['cli-conformance.ts', 'tooling', "Transakcja raw → production dla nowego narzędzia CLI."],
      ['provider-conformance.ts', 'tooling', "Transakcja raw → production dla nowego providera API."],
      ['dangling-imports.mjs', 'tooling', "Audyt relatywnych importów, które do niczego nie prowadzą."],
      ['pack-install-smoke.mjs', 'tooling', "`release:smoke`: npm pack, instalacja, uruchomienie --version i --help."]
    ]],
    ['testing', 'test', "Testy spoza src: integracja, e2e (kasety, live), wizualne, zgodność docs, helpery, fixtures.", false, [
      ['architecture', 'test', "Test kontraktu kandydatów."],
      ['ci', 'test', "Testy workflow CI i skryptu release-check."],
      ['compat', 'test', "Zgodność configu v3 ze starszym zapisem."],
      ['docs', 'test', "Testy zgodności docs z kodem (CONFIGURATION, EXTENDING, TROUBLESHOOTING …)."],
      ['e2e', 'test', "E2E: replay kaset i tier live z prawdziwymi CLI.", false, [
        ['cassettes', 'test', "Nagrane przebiegi do replay."],
        ['helpers', 'test', "Harness e2e i shimy narzędzi."],
        ['live', 'test', "Macierz i wiersze fixture tieru live."],
        ['scenarios', 'test', "Scenariusze e2e (stop/continue, Apply, recovery, checkout …)."]
      ]],
      ['fixtures', 'test', "Nagrane wyjścia narzędzi, configi, stare runy, palety terminala."],
      ['helpers', 'test', "Wspólne helpery testów (alias `#testing/*`)."],
      ['integration', 'test', "Testy integracyjne: cli, orchestrator, performance, skills, ui.", false, [
        ['cli', 'test', "Podkomendy, PTY, headless, kody wyjścia."],
        ['orchestrator', 'test', "Pełne pętle z fałszywymi CLI, kontrakt adapterów CLI."]
      ]],
      ['rebrand', 'test', "Kontrakt marki w utrzymywanym drzewie."],
      ['visual', 'test', "Galeria TUI: katalog scenariuszy, kontrakty, rendery PNG.", false, [
        ['catalog.ts', 'test', "Scenariusze galerii dla `npm run tui-shots`."]
      ]]
    ]],
    ['evals', 'test', "Ewaluacje jakości implementerów: scenariusze, kasety, wyniki.", false, [
      ['cli.ts', 'test', "`npm run eval`: record / replay."],
      ['scenarios', 'test', "Scenariusze ewaluacji."],
      ['cassettes', 'test', "Nagrania wywołań."],
      ['fixtures', 'test', "Projekty wejściowe."],
      ['results', 'test', "Wyniki ewaluacji."]
    ]],
    ['skills', 'other', "Pipeline jako skille agentów (skills.sh): 4 publiczne + babysit (metadata.internal).", false, [
      ['splitbrief', 'other', "Skill kanoniczny i biblioteka references/ z blokami generowanymi."],
      ['splitbrief-brief', 'other', "Lustro: pisanie Task Brief."],
      ['splitbrief-run', 'other', "Lustro: uruchomienie; źródło skryptów wait-attempt / gate."],
      ['splitbrief-review', 'other', "Lustro: przegląd."],
      ['splitbrief-babysit', 'other', "Skill contributora do nadzorowanego dogfoodingu (ukryty)."]
    ]],
    ['website', 'other', "Strona projektu (Vite) z własnym package.json, biome, knip i dependency-cruiser.", false, [
      ['src', 'other', "Kod strony."],
      ['build', 'other', "Generator katalogu i dokumentacji strony."],
      ['docs', 'other', "Strona docs."],
      ['public', 'other', "Statyczne zasoby."],
      ['tests', 'other', "Testy Playwright strony."]
    ]],
    ['deploy', 'other', "Dockerfile i konfiguracja nginx strony."],
    ['docs', 'docs', "Dokumentacja: część dla użytkownika (w package.json files) i część contributora.", false, [
      ['STRUCTURE.md', 'docs', "Drzewo plików i drzewo decyzji „gdzie to położyć”."],
      ['LAYERS.md', 'docs', "Co wolno w każdej warstwie, reguła 2 konsumentów, porty i adaptery."],
      ['ARCHITECTURE.md', 'docs', "Diagram warstw, przepływ danych, inwentarz eventów i komend."],
      ['INVARIANTS.md', 'docs', "Tabela bram pre-merge."],
      ['EXTENDING.md', 'docs', "Przepisy: komenda, event, store, backend, seat, provider, stos, halt."],
      ['design', 'docs', "Materiały projektowe."]
    ]],
    ['flow-atlas', 'docs', "Ten atlas: index.html + data/<obszar>.js."],
    ['.github', 'tooling', "CI GitHub.", false, [
      ['workflows', 'tooling', "ci.yml, release.yml, website.yml, deploy-website.yml, nightly-coverage.yml."]
    ]],
    ['.claude', 'tooling', "Ustawienia Claude Code: hook blokujący commity, skille contributorów, komenda dev.", false, [
      ['hooks', 'tooling', "`block-git-commits.sh`: PreToolUse, exit 2 na git add/stage/commit."]
    ]],
    ['.claude-plugin', 'other', "`marketplace.json`: 4 skille jako jeden plugin."],
    ['.specify', 'docs', "Konstytucja (`memory/constitution.md`) i szablony."],
    ['package.json', 'tooling', "bin `splitbrief` → dist/cli.js, `type: module`, alias `#testing/*`, skrypty bram.", false],
    ['tsconfig.json', 'tooling', "NodeNext, strict, rootDir src; wyklucza testy i testing/."],
    ['tsconfig.test.json', 'tooling', "Typecheck testów (`typecheck:test`)."],
    ['biome.json', 'tooling', "Lint i format; noNonNullAssertion i noExplicitAny wyłączone — pilnują ich gate 17 / 17b."],
    ['knip.json', 'tooling', "Gate 18: martwe pliki i eksporty w src, scripts, evals, testing."],
    ['vitest.config.ts', 'tooling', "Projekty testów: unit, integration, workflow-screen."],
    ['.dependency-cruiser.cjs', 'tooling', "Gate 19: brak cykli runtime i zakazane krawędzie warstw.", true],
    ['CLAUDE.md', 'docs', "Reguły projektu dla agentów."],
    ['AGENTS.md', 'docs', "Instrukcje dla innych agentów kodujących."]
  ]);

  window.ATLAS.push({
    id: 'structure',
    order: 10,
    title: 'Struktura projektu i warstwy',
    tagline: 'Co leży gdzie w kodzie, kto może importować kogo i jak części łączą się statycznie.',
    summary: `SPLITBRIEF to jeden proces Node (ESM, TypeScript, React 19 + Ink 6). Kod produkcyjny leży w \`src/\` i dzieli się na **10 warstw** ułożonych od liścia do wejścia: \`utils\` → \`lib\` → \`core\` → \`engine\` i \`stores\` → \`features\`, \`components\`, \`hooks\` → \`app\` i \`cli\`. Import idzie **tylko w dół**. Wyjątek: \`stores\` może sięgnąć do \`engine\`, ale wyłącznie przez \`import type\`.

- \`core/\` opisuje domenę (schematy Zod, config, maszyna stanów, sesje, crew, recovery, komendy runtime). Nie uruchamia procesów i nie zna React.
- \`engine/\` uruchamia workflow (planner, implementer, review, Apply) i **publikuje EngineEvent na EventBus**. Nie importuje React, Ink, stores ani UI.
- \`stores/\` to moduły-singletony na \`useSyncExternalStore\`. Sink TUI (\`addTuiEvent\`) wpisuje do nich eventy, a UI czyta je selektorami.
- \`features/\` to pionowe plastry UI. **Nie importują się nawzajem** (dziś 0 takich krawędzi). Wejściem każdego jest **płaska strona** w \`app/screens\` lub \`app/overlays\`, którą wybiera \`app/router.tsx\`.
- \`cli/\` parsuje flagi, seeduje stores przed renderem i montuje \`<App/>\` albo uruchamia tryb headless.

Liczby na diagramach są **policzone** skryptem z relatywnych importów w \`src/**/*.ts(x)\` bez testów (5067 importów między warstwami). Najgrubsza krawędź to \`engine → core\` (1574, z czego 791 to \`import type\`).

Reguły pilnują **trzy niezależne mechanizmy**: \`scripts/import-boundaries.ts\` (gate 9 i 12c, regexy), \`.dependency-cruiser.cjs\` (gate 19, prawdziwy graf modułów i cykle) oraz grepy w \`scripts/invariants/gates.ts\` (barrels, klasy, memoizacja, \`simple-git\`, rozszerzenie \`.js\`, asercje). Uruchamia je \`npm run check:invariants\`. Dziś \`import-boundaries\` zwraca 0 naruszeń.

Ten obszar opisuje tylko statyczną architekturę. Przepływy w czasie działania opisują inne obszary: start (→ startup), runnery (→ runners), planowanie (→ planning), briefy (→ build), przegląd (→ review), halty (→ recovery), cykl runu (→ lifecycle), TUI (→ ui), podsystemy (→ subsystems).`,
    entry: ['src/cli.ts:36', 'src/app/root.tsx:60', 'src/engine/orchestrator/run/workflow.ts:98', 'scripts/import-boundaries.ts:161'],
    links: [
      { to: 'startup', label: 'cli.ts rejestruje podkomendy; bootstrap stores przed renderem' },
      { to: 'ui', label: 'app/ powłoka, router, strony i features to warstwa UI' },
      { to: 'runners', label: 'engine/runners/factory.ts i cli-tools/registry.ts' },
      { to: 'planning', label: 'engine/orchestrator/planning' },
      { to: 'build', label: 'engine/orchestrator/task i escalation' },
      { to: 'review', label: 'engine/orchestrator/final-review.ts i validation' },
      { to: 'recovery', label: 'core/recovery i engine/orchestrator/recovery' },
      { to: 'lifecycle', label: 'core/sessions (deriveRunStatus, run record) i orchestrator/apply' },
      { to: 'subsystems', label: 'engine/events, hooks, codebase, snapshots' }
    ],
    diagrams: [
      {
        id: 'sr-layers',
        title: 'Warstwy src/ i policzone importy między nimi',
        caption: 'Strzałka = „importuje”. Liczba = ile relatywnych importów (bez testów) prowadzi z warstwy do warstwy; „type” = ile z nich to import type. Rank z scripts/import-boundaries.ts: import do warstwy o wyższym ranku jest zakazany. Linie przerywane to krawędzie, które docs (LAYERS.md) pomijają, ale bramy dopuszczają: components i hooks importują wartości z engine. stores → engine to wyłącznie import type.',
        mermaid: `flowchart TD
  ROOT["src/cli.ts + node-env.ts<br/>binarka"]
  subgraph TOP["rank 5 — wejścia"]
    CLI["cli/ · 36 plików"]
    APP["app/ · 21 plików"]
  end
  subgraph UIL["rank 4 — UI React/Ink"]
    FEAT["features/ · 206 plików"]
    COMP["components/ · 47 plików"]
    HOOKS["hooks/ · 5 plików"]
  end
  subgraph MID["rank 3"]
    STORES["stores/ · 72 pliki"]
    ENGINE["engine/ · 488 plików"]
  end
  CORE["core/ · 278 plików · rank 2"]
  LIB["lib/ · 55 plików · rank 1"]
  UTILS["utils/ · 40 plików · rank 0"]
  ROOT -->|"13"| CLI
  ROOT -->|"4"| CORE
  ROOT -->|"1"| LIB
  ROOT -->|"1"| UTILS
  CLI -->|"3"| APP
  CLI -.->|"1 run-history"| FEAT
  CLI -->|"30"| STORES
  CLI -->|"98 · 16 type"| ENGINE
  CLI -->|"161 · 48 type"| CORE
  CLI -->|"29"| LIB
  CLI -->|"18"| UTILS
  APP -->|"100"| FEAT
  APP -->|"48"| COMP
  APP -->|"7"| HOOKS
  APP -->|"147"| STORES
  APP -->|"22"| ENGINE
  APP -->|"90 · 26 type"| CORE
  APP -->|"14"| LIB
  APP -->|"21"| UTILS
  FEAT -->|"137"| COMP
  FEAT -->|"19"| HOOKS
  FEAT -->|"350"| STORES
  FEAT -->|"96 · 37 type"| ENGINE
  FEAT -->|"601 · 196 type"| CORE
  FEAT -->|"53"| LIB
  FEAT -->|"174"| UTILS
  COMP -->|"3"| HOOKS
  COMP -->|"39"| STORES
  COMP -.->|"3 display-names, activeApply"| ENGINE
  COMP -->|"69 · 27 type"| CORE
  COMP -->|"20"| LIB
  COMP -->|"29"| UTILS
  HOOKS -->|"1"| STORES
  HOOKS -.->|"1 display-names"| ENGINE
  HOOKS -->|"2 type"| CORE
  HOOKS -->|"3"| LIB
  HOOKS -->|"3"| UTILS
  STORES -.->|"43 · wszystkie import type"| ENGINE
  STORES -->|"117 · 64 type"| CORE
  STORES -->|"6"| LIB
  STORES -->|"25"| UTILS
  ENGINE -->|"1574 · 791 type"| CORE
  ENGINE -->|"227"| LIB
  ENGINE -->|"407"| UTILS
  CORE -->|"92"| LIB
  CORE -->|"148"| UTILS
  LIB -->|"17"| UTILS`
      },
      {
        id: 'sr-classify',
        title: 'Jak gate 9 / 12c ocenia jeden import (classify)',
        caption: 'scripts/import-boundaries.ts czyta każdy plik src bez testów, wyciąga specyfikatory z from i import bez nazw, i dla każdego relatywnego importu w src/ wykonuje classify(). Pierwsza pasująca reguła daje naruszenie. Wynik gate to liczba naruszeń; oczekiwane 0.',
        mermaid: `flowchart TD
  A["Plik src/X.ts(x), nie test"] --> SR_GATE_RELATIVE{"Specyfikator zaczyna się od kropki<br/>i wskazuje do src/?"}
  SR_GATE_RELATIVE -->|"nie: pakiet npm, alias, dynamiczny import()"| SKIP["Pominięty — tę krawędź widzi tylko depcruise"]
  SR_GATE_RELATIVE -->|"tak"| SR_GATE_COMPONENTS_FEATURES{"Źródło w components/,<br/>cel w features/?"}
  SR_GATE_COMPONENTS_FEATURES -->|"tak"| V["Naruszenie, licznik +1"]
  SR_GATE_COMPONENTS_FEATURES -->|"nie"| SR_GATE_SHARED_EDITOR{"Cel to features/editor?"}
  SR_GATE_SHARED_EDITOR -->|"tak"| SHELLCHK
  SR_GATE_SHARED_EDITOR -->|"nie"| SR_GATE_CROSS_FEATURE{"Feature A importuje feature B?"}
  SR_GATE_CROSS_FEATURE -->|"tak"| V
  SR_GATE_CROSS_FEATURE -->|"nie"| SR_GATE_PAGES{"Strona importuje inną stronę?<br/>screens / overlays, depth 3"}
  SR_GATE_PAGES -->|"tak"| V
  SR_GATE_PAGES -->|"nie"| SHELLCHK["Sprawdzenie powłoki"]
  SHELLCHK --> SR_GATE_SHELL{"Strona importuje app/root,<br/>router, provider lub layout?"}
  SR_GATE_SHELL -->|"tak"| V
  SR_GATE_SHELL -->|"nie"| SR_GATE_ENGINE_UI{"Źródło w engine/, cel w stores,<br/>hooks, components lub cli?"}
  SR_GATE_ENGINE_UI -->|"tak"| V
  SR_GATE_ENGINE_UI -->|"nie"| SAME{"Ta sama warstwa najwyższego poziomu<br/>albo plik w korzeniu src?"}
  SAME -->|"tak"| OK["Dozwolone"]
  SAME -->|"nie"| SR_GATE_STORES_ENGINE{"stores importuje engine?"}
  SR_GATE_STORES_ENGINE -->|"tak, import type"| OK
  SR_GATE_STORES_ENGINE -->|"tak, wartość"| V
  SR_GATE_STORES_ENGINE -->|"nie"| SR_GATE_RANK{"rank celu większy niż rank źródła?"}
  SR_GATE_RANK -->|"tak"| V
  SR_GATE_RANK -->|"nie"| OK
  V --> G["Gate 9: wynik musi być 0; gate 12c liczy tylko komunikaty o engine"]`
      },
      {
        id: 'sr-engine',
        title: 'Mapa podfolderów engine/ (policzone importy)',
        caption: 'Liczba = importy między podfolderami engine/. orchestrator jest hubem: woła runners, spec, providers, events, snapshots. runners i planners/implementers zależą od siebie w obie strony na poziomie folderów, ale bez cykli runtime na poziomie modułów (gate 19). Z zewnątrz najczęściej importowane: orchestrator (64), runners (63), detection (46), events (43, prawie wszystko import type ze stores), providers (31).',
        mermaid: `flowchart LR
  E_ORCH["orchestrator · 205 plików<br/>pętla runu"]
  E_RUN["runners · 69<br/>fabryka, adaptery CLI"]
  E_PLAN["planners · 14"]
  E_IMPL["implementers · 19"]
  E_REV["reviewers · 1<br/>port Reviewer"]
  E_CALLS["calls · 19<br/>runner_call_*"]
  E_EVT["events · 12<br/>EventBus"]
  E_PROV["providers · 56<br/>HTTP, ceny, models.dev"]
  E_STREAM["streaming · 18<br/>parsery wyjścia"]
  E_DET["detection · 16"]
  E_SPEC["spec · 18<br/>plan checks, prompty"]
  E_SNAP["snapshots · 11"]
  E_HOOKS["hooks · 5"]
  E_CODE["codebase · 12<br/>repo-map"]
  E_PARS["parsers · 5"]
  E_ROOT["pliki w engine/ · 8<br/>availability, skill-discovery, error-hints"]
  E_ORCH -->|"66"| E_EVT
  E_ORCH -->|"56"| E_RUN
  E_ORCH -->|"43"| E_SPEC
  E_ORCH -->|"35"| E_PROV
  E_ORCH -->|"27"| E_CALLS
  E_ORCH -->|"24"| E_SNAP
  E_ORCH -->|"23"| E_IMPL
  E_ORCH -->|"20"| E_PLAN
  E_ORCH -->|"8"| E_REV
  E_ORCH -->|"8"| E_ROOT
  E_ORCH -->|"7"| E_HOOKS
  E_ORCH -->|"5"| E_DET
  E_ORCH -->|"1"| E_CODE
  E_ORCH -->|"1"| E_PARS
  E_PLAN -->|"33"| E_RUN
  E_PLAN -->|"21"| E_CALLS
  E_PLAN -->|"13"| E_PROV
  E_PLAN -->|"11"| E_ROOT
  E_IMPL -->|"24"| E_RUN
  E_IMPL -->|"14"| E_ROOT
  E_IMPL -->|"10"| E_PROV
  E_IMPL -->|"10"| E_CALLS
  E_IMPL -->|"6"| E_SPEC
  E_RUN -->|"32"| E_CALLS
  E_RUN -->|"25"| E_PROV
  E_RUN -->|"13"| E_STREAM
  E_RUN -->|"9"| E_DET
  E_RUN -->|"8"| E_PLAN
  E_RUN -->|"7"| E_IMPL
  E_RUN -->|"3"| E_ORCH
  E_REV -->|"1"| E_PLAN
  E_REV -->|"1"| E_RUN
  E_STREAM -->|"16"| E_CALLS
  E_STREAM -->|"12"| E_RUN
  E_PROV -->|"14"| E_CALLS
  E_PROV -->|"5"| E_DET
  E_PROV -->|"5"| E_ROOT
  E_DET -->|"18"| E_RUN
  E_DET -->|"9"| E_PROV
  E_SNAP -->|"6"| E_ORCH
  E_SPEC -->|"5"| E_ORCH
  E_SPEC -->|"2"| E_PARS
  E_CALLS -->|"3"| E_EVT
  E_HOOKS -->|"2"| E_EVT`
      },
      {
        id: 'sr-orchestrator',
        title: 'Wnętrze engine/orchestrator/ (policzone importy)',
        caption: 'KORZEŃ to 21 plików leżących bezpośrednio w orchestrator/ (final-review.ts, events.ts, review-call.ts, state-ops.ts, cancellable-call.ts …); prawie każdy podfolder z nich korzysta. run/ składa cykl runu, task/ robi briefy, a approval/ jest wspólnym dołem dla isolation, apply, task i evidence.',
        mermaid: `flowchart LR
  O_ROOT["KORZEŃ orchestrator/ · 21 plików<br/>final-review, events, review-*"]
  O_RUN["run · 19"]
  O_PLAN["planning · 12"]
  O_TASK["task · 26"]
  O_ESC["escalation · 9"]
  O_CONS["consult · 3"]
  O_REC["recovery · 17"]
  O_VAL["validation · 12"]
  O_ISO["isolation · 12"]
  O_APPR["approval · 15"]
  O_APPLY["apply · 9"]
  O_EVID["evidence · 18"]
  O_QUEUE["queue · 8"]
  O_LIFE["session-lifecycle · 3"]
  O_SUM["summary · 7"]
  O_CR["context-routing · 8"]
  O_DRIFT["drift · 3"]
  O_TR["transcript · 3"]
  O_TASK -->|"53"| O_ROOT
  O_RUN -->|"35"| O_ROOT
  O_ESC -->|"16"| O_ROOT
  O_PLAN -->|"14"| O_ROOT
  O_QUEUE -->|"12"| O_ROOT
  O_CONS -->|"9"| O_ROOT
  O_APPLY -->|"7"| O_ROOT
  O_RUN -->|"9"| O_REC
  O_RUN -->|"6"| O_TASK
  O_RUN -->|"6"| O_VAL
  O_RUN -->|"6"| O_PLAN
  O_RUN -->|"5"| O_ISO
  O_RUN -->|"4"| O_APPLY
  O_RUN -->|"4"| O_LIFE
  O_RUN -->|"4"| O_SUM
  O_TASK -->|"13"| O_REC
  O_TASK -->|"12"| O_ISO
  O_TASK -->|"10"| O_EVID
  O_TASK -->|"8"| O_APPR
  O_TASK -->|"7"| O_VAL
  O_TASK -->|"6"| O_ESC
  O_TASK -->|"5"| O_CR
  O_TASK -->|"4"| O_CONS
  O_ESC -->|"6"| O_REC
  O_ESC -->|"6"| O_TASK
  O_ESC -->|"5"| O_EVID
  O_ESC -->|"4"| O_ISO
  O_CONS -->|"4"| O_TASK
  O_PLAN -->|"4"| O_REC
  O_PLAN -->|"4"| O_QUEUE
  O_ISO -->|"11"| O_APPR
  O_APPLY -->|"10"| O_APPR
  O_APPLY -->|"4"| O_LIFE
  O_APPLY -->|"3"| O_RUN
  O_EVID -->|"6"| O_APPR
  O_EVID -->|"5"| O_ISO
  O_ROOT -->|"15"| O_EVID
  O_ROOT -->|"8"| O_VAL
  O_ROOT -->|"5"| O_QUEUE
  O_ROOT -->|"5"| O_ISO
  O_ROOT -->|"3"| O_DRIFT
  O_ROOT -->|"3"| O_TR
  O_REC -->|"5"| O_ROOT
  O_LIFE -->|"4"| O_ROOT`
      },
      {
        id: 'sr-core',
        title: 'Mapa podfolderów core/ (policzone importy)',
        caption: 'schemas/ to hub domeny: 841 importów spoza core (engine, stores, features) i najwięcej wewnątrz core. config ↔ schemas oraz state ↔ sessions mają krawędzie w obie strony na poziomie folderów. INNE = foldery bez znaczących krawędzi wewnątrz core: theme, tokens, scope, sections, settings, skills, editor, attachments, approval, plan-review — czyta je engine albo UI.',
        mermaid: `flowchart LR
  C_SCH["schemas · 36 plików<br/>Zod + z.infer"]
  C_CFG["config · 30"]
  C_STATE["state · 15<br/>maszyna stanów"]
  C_SESS["sessions · 27<br/>run-status, run-record"]
  C_READY["readiness · 18"]
  C_CREW["crew · 7"]
  C_RUNNERS["runners · 9<br/>katalog CLI"]
  C_PROV["providers · 15"]
  C_REC["recovery · 7"]
  C_EVID["evidence · 6"]
  C_REV["review · 5"]
  C_ROOT["pliki w core/ · 21<br/>paths, phases, formatting"]
  C_TYPES["types · 3"]
  C_RT["runtime/commands · 11"]
  C_NAV["navigation · 2"]
  C_KEYS["keybindings · 6"]
  C_COMP["composer · 2"]
  C_DISC["discovery · 7"]
  C_TRUST["trust · 7"]
  C_HOOKS["hooks · 2"]
  C_VAL["validation · 12"]
  C_PS["pipeline-spec · 11"]
  C_OTHER["INNE · theme, tokens, scope,<br/>sections, settings, skills …"]
  C_CFG -->|"63"| C_SCH
  C_STATE -->|"41"| C_SCH
  C_SESS -->|"31"| C_SCH
  C_READY -->|"21"| C_SCH
  C_CREW -->|"10"| C_SCH
  C_ROOT -->|"10"| C_SCH
  C_REC -->|"9"| C_SCH
  C_EVID -->|"8"| C_SCH
  C_REV -->|"8"| C_SCH
  C_PROV -->|"6"| C_SCH
  C_COMP -->|"4"| C_SCH
  C_RT -->|"4"| C_SCH
  C_VAL -->|"3"| C_SCH
  C_PS -->|"2"| C_SCH
  C_SCH -->|"6"| C_PROV
  C_SCH -->|"6"| C_RUNNERS
  C_SCH -->|"2"| C_STATE
  C_SCH -->|"2"| C_PS
  C_SCH -->|"1"| C_CFG
  C_READY -->|"25"| C_CFG
  C_READY -->|"12"| C_RUNNERS
  C_READY -->|"10"| C_CREW
  C_READY -->|"6"| C_ROOT
  C_SESS -->|"23"| C_ROOT
  C_SESS -->|"13"| C_TYPES
  C_SESS -->|"2"| C_STATE
  C_STATE -->|"6"| C_SESS
  C_STATE -->|"6"| C_ROOT
  C_STATE -->|"5"| C_TYPES
  C_STATE -->|"4"| C_CREW
  C_CFG -->|"15"| C_PROV
  C_CFG -->|"13"| C_RUNNERS
  C_CFG -->|"2"| C_TRUST
  C_CREW -->|"14"| C_CFG
  C_CREW -->|"13"| C_RUNNERS
  C_CREW -->|"4"| C_DISC
  C_CREW -->|"4"| C_PROV
  C_REC -->|"3"| C_CREW
  C_RT -->|"5"| C_NAV
  C_RT -->|"2"| C_CREW
  C_KEYS -->|"3"| C_NAV
  C_HOOKS -->|"2"| C_TRUST
  C_RUNNERS -->|"3"| C_DISC
  C_DISC -->|"3"| C_RUNNERS
  C_OTHER -->|"czyta głównie schemas i pliki core/"| C_SCH`
      },
      {
        id: 'sr-shell',
        title: 'Od podkomendy CLI przez powłokę app/ do stron i features',
        caption: 'Statyczne złożenie TUI. cli montuje App; root.tsx podpina klawisze, mysz i komendy; router.tsx wybiera jeden ekran i co najwyżej jeden overlay. Strony importują features (liczby = importy), features piszą i czytają stores. Strony nie importują się nawzajem ani modułów powłoki (gate 9). command-context.ts woła engine bezpośrednio (Apply, Discard, recovery bus).',
        mermaid: `flowchart LR
  S_CLI["cli/commands<br/>start/interactive.ts · init.ts · continue/resume.ts"]
  S_BOOT["cli/bootstrap/init.ts<br/>initStoresForTuiMount"]
  S_RENDER["cli/render/app.ts<br/>renderApp"]
  S_ROOT["app/root.tsx · App"]
  S_KEYS["app/keys.ts · useAppKeys"]
  S_MOUSE["app/mouse.ts"]
  S_CMD["app/command-context.ts<br/>useRuntimeCommands"]
  S_PROVIDER["app/provider.tsx"]
  S_ROUTER["app/router.tsx · Router"]
  S_LAYOUT["app/layout.tsx · Layout"]
  S_PREP["app/session-preparation.tsx"]
  SR_ROUTER_SCREEN{"routerStore.screen?"}
  SR_ROUTER_OVERLAY{"overlayStore: aktywny overlay?"}
  P_HOME["screens/home.tsx"]
  P_WF["screens/workflow.tsx"]
  P_SETUP["screens/setup.tsx"]
  P_HELP["overlays/help.tsx"]
  P_PAL["overlays/palette.tsx"]
  P_SET["overlays/settings.tsx"]
  P_RUN["overlays/runners.tsx"]
  P_USAGE["overlays/usage.tsx"]
  P_EDIT["overlays/editor.tsx"]
  P_PURE["overlays/skills.tsx · sessions.tsx<br/>strony bez features"]
  F_WF["features/workflow · 143"]
  F_HOME["features/home"]
  F_SP["features/start-preparation"]
  F_CREW["features/crew"]
  F_RUN["features/runners · 32"]
  F_SETS["features/settings"]
  F_PAL["features/palette"]
  F_ED["features/editor"]
  STORES["stores/ — 350 importów z features, 147 z app"]
  ENGINE["engine/"]
  S_BOOT -->|"seed przed renderem"| STORES
  S_CLI --> S_BOOT
  S_CLI -->|"createElement(App)"| S_RENDER
  S_RENDER --> S_ROOT
  S_ROOT --> S_PROVIDER
  S_ROOT --> S_KEYS
  S_ROOT --> S_MOUSE
  S_ROOT --> S_CMD
  S_ROOT --> S_ROUTER
  S_ROUTER --> S_LAYOUT
  S_ROUTER --> S_PREP
  S_ROUTER --> SR_ROUTER_SCREEN
  S_ROUTER --> SR_ROUTER_OVERLAY
  SR_ROUTER_SCREEN -->|"home"| P_HOME
  SR_ROUTER_SCREEN -->|"workflow"| P_WF
  SR_ROUTER_SCREEN -->|"setup"| P_SETUP
  SR_ROUTER_OVERLAY -->|"help"| P_HELP
  SR_ROUTER_OVERLAY -->|"command-palette"| P_PAL
  SR_ROUTER_OVERLAY -->|"settings"| P_SET
  SR_ROUTER_OVERLAY -->|"6 id pickerów"| P_RUN
  SR_ROUTER_OVERLAY -->|"usage-details"| P_USAGE
  SR_ROUTER_OVERLAY -->|"editor"| P_EDIT
  SR_ROUTER_OVERLAY -->|"skills, sessions"| P_PURE
  P_WF -->|"28"| F_WF
  P_HOME -->|"7"| F_HOME
  P_HOME -->|"3"| F_SP
  P_SETUP -->|"5"| F_CREW
  P_SETUP -->|"3"| F_RUN
  P_SETUP -->|"3"| F_SP
  P_SET -->|"5"| F_SETS
  P_SET -->|"4"| F_CREW
  P_RUN -->|"10"| F_RUN
  P_PAL -->|"3"| F_PAL
  P_HELP -->|"1"| F_PAL
  P_EDIT -->|"3"| F_ED
  P_USAGE -->|"3"| F_WF
  S_CMD -->|"8"| F_WF
  S_CMD -->|"Apply, Discard, recovery bus"| ENGINE
  F_WF -->|"270"| STORES
  F_RUN -->|"46"| STORES
  F_WF -->|"runWorkflow, replay"| ENGINE`
      },
      {
        id: 'sr-events',
        title: 'Od publish w engine do wiersza na ekranie (EventBus → sinki → stores → UI)',
        caption: 'Jedyna droga danych z engine do UI. Engine nie zna stores: publikuje EngineEvent na busie, a sinki podpięte w attachRunSinks robią resztę. Między turami (odpowiedź na recovery) bus daje createRecoveryBus. Run otwarty z dysku nie idzie przez bus: hydrateRun czyta session.jsonl i ładuje stores akcją load.',
        mermaid: `flowchart TD
  EV_LOOP["features/workflow/hooks/use-run-loop.ts<br/>pętla TUI"]
  EV_HEAD["cli/headless.ts · runHeadless"]
  EV_RUN["engine/orchestrator/run/workflow.ts<br/>runWorkflow"]
  EV_INIT["run/init.ts → run/init-sinks.ts<br/>attachRunSinks"]
  EV_PUB["moduły orchestratora<br/>36 helperów publish* w orchestrator/events.ts"]
  EV_BUS["engine/events/bus.ts<br/>createEventBus · publish"]
  SR_SINKS{"Które sinki podpiąć?"}
  SR_BUS_ISOLATION{"Sink rzucił wyjątek?"}
  EV_SWALLOW["catch bez akcji<br/>kolejne sinki dostają event"]
  EV_JSONL["events/sinks/jsonl.ts<br/>sessions/ID/session.jsonl"]
  EV_LOGGER["events/sinks/logger.ts"]
  EV_CALLEV["orchestrator/summary/call-evidence.ts<br/>usage per wywołanie"]
  EV_JSON["events/sinks/stdout-json.ts · --json"]
  EV_TEXT["events/sinks/stdout-text.ts · --plain"]
  EV_HOOK["engine/hooks/sink.ts<br/>post_* / on_*"]
  EV_TUI["features/workflow/tui-sink.ts<br/>addTuiEvent"]
  EV_ADD["stores/workflow/actions/event.ts<br/>addEvent"]
  SR_ADD_EVENT{"Typ eventu i stan cancel?"}
  EV_DROP["Event pominięty"]
  ST_EVTS["eventsStore"]
  ST_TASKS["tasksStore"]
  ST_TOK["tokensStore"]
  ST_LIFE["lifecycleStore"]
  ST_OPS["operationsStore"]
  EV_ROWS["features/workflow/conversation-rows/<br/>event-rows/dispatch.ts · eventRowBlock"]
  EV_SCREEN["app/screens/workflow.tsx"]
  EV_REC["engine/orchestrator/recovery/bus.ts<br/>createRecoveryBus"]
  EV_HYD["features/workflow/run-history.ts · hydrateRun"]
  EV_REPLAY["engine/events/replay.ts · readRunEvents"]
  EV_LOOP -->|"runWorkflow z tuiSink"| EV_RUN
  EV_HEAD -->|"runWorkflow z headless"| EV_RUN
  EV_RUN --> EV_INIT
  EV_INIT --> SR_SINKS
  SR_SINKS -->|"zawsze"| EV_JSONL
  SR_SINKS -->|"zawsze"| EV_LOGGER
  SR_SINKS -->|"zawsze"| EV_CALLEV
  SR_SINKS -->|"opts.tuiSink"| EV_TUI
  SR_SINKS -->|"headless, bez plain"| EV_JSON
  SR_SINKS -->|"headless + plain"| EV_TEXT
  SR_SINKS -->|"config.hooks"| EV_HOOK
  EV_PUB -->|"bus.publish(event)"| EV_BUS
  EV_BUS -->|"każdy sink po kolei"| SR_BUS_ISOLATION
  SR_BUS_ISOLATION -->|"tak"| EV_SWALLOW
  SR_BUS_ISOLATION -->|"nie"| EV_TUI
  EV_TUI -->|"boundEngineEventForConsumer tui"| EV_ADD
  EV_ADD --> SR_ADD_EVENT
  SR_ADD_EVENT -->|"cost_update"| ST_TOK
  SR_ADD_EVENT -->|"run anulowany, event nieakceptowany"| EV_DROP
  SR_ADD_EVENT -->|"inny event"| ST_EVTS
  ST_EVTS --> ST_TASKS
  ST_TASKS --> ST_TOK
  ST_TOK --> ST_LIFE
  ST_LIFE --> ST_OPS
  ST_EVTS -->|"store.use(selector)"| EV_ROWS
  EV_ROWS --> EV_SCREEN
  EV_REC -->|"sink hosta + jsonl"| EV_TUI
  EV_HYD --> EV_REPLAY
  EV_HYD -->|"actions/load.ts · loadEvents"| ST_EVTS`
      },
      {
        id: 'sr-placement',
        title: 'Gdzie położyć nowy plik — drzewo decyzji',
        caption: 'Kolejność pytań z docs/STRUCTURE.md: pierwsze TAK kończy szukanie. Każdy romb to karta SR_ z regułą i miejscem, które jej pilnuje. Domyślna zasada: zacznij wąsko, awansuj przy drugim konsumencie.',
        mermaid: `flowchart TD
  START["Nowy moduł"] --> SR_BARREL{"Plik tylko re-eksportuje?"}
  SR_BARREL -->|"tak"| STOP["STOP — barrel zakazany<br/>importuj z producenta"]
  SR_BARREL -->|"nie"| SR_ZOD{"Czy to schemat Zod?"}
  SR_ZOD -->|"tak"| Z1["core/schemas/domena.ts<br/>+ z.infer w tym samym pliku"]
  SR_ZOD -->|"nie"| SR_TYPE{"Czy to sam typ TS?"}
  SR_TYPE -->|"1 plik używa"| T1["Inline w tym pliku"]
  SR_TYPE -->|"kilka plików w folderze"| T2["folder/types.ts"]
  SR_TYPE -->|"różne foldery"| T3["Obok producenta,<br/>konsumenci import type"]
  SR_TYPE -->|"fan-in ponad 30, 3+ warstwy"| T4["core/types/"]
  SR_TYPE -->|"nie, to kod"| SR_REACT{"Czy kod importuje React / Ink?"}
  SR_REACT -->|"tak"| SR_PAGE{"Czy to wejście ekranu lub overlayu?"}
  SR_PAGE -->|"tak"| PG["app/screens/x.tsx lub app/overlays/x.tsx<br/>+ case w router.tsx"]
  SR_PAGE -->|"nie"| SR_UI_SHARED{"Ilu feature'ów używa?"}
  SR_UI_SHARED -->|"1"| U1["features/x/ · components/ i hooks/<br/>od 2 plików"]
  SR_UI_SHARED -->|"2 lub więcej, komponent"| U2["src/components/kategoria/"]
  SR_UI_SHARED -->|"2 lub więcej, hook"| U3["src/hooks/"]
  SR_REACT -->|"nie"| SR_STATE{"Globalny stan z subskrybentami?"}
  SR_STATE -->|"tak"| ST1["stores/grupa/nazwa.ts<br/>createStore + nazwane akcje"]
  SR_STATE -->|"nie"| SR_PURE{"Czysty prymityw bez domeny?"}
  SR_PURE -->|"tak"| UT["src/utils/"]
  SR_PURE -->|"nie"| SR_INFRA{"Wrapper zewnętrznego systemu?<br/>git, fs, proces, terminal, HTTP"}
  SR_INFRA -->|"tak"| LB["src/lib/domena/"]
  SR_INFRA -->|"nie"| SR_DOMAIN{"Zna pojęcia SPLITBRIEF?"}
  SR_DOMAIN -->|"tak"| SR_ORCH{"Uruchamia workflow lub proces?<br/>planner, implementer, retry, spawn"}
  SR_ORCH -->|"tak"| EN["src/engine/domena/"]
  SR_ORCH -->|"nie: typy, reguły, formatowanie, zapis domeny"| CO["src/core/domena/"]
  SR_DOMAIN -->|"nie"| SR_CLI_ONLY{"Tylko przygotowanie CLI,<br/>1 konsument?"}
  SR_CLI_ONLY -->|"tak"| CL["src/cli/ — awans do core przy 2. konsumencie"]
  SR_CLI_ONLY -->|"nie"| SR_SIZE{"Ponad 300 linii i ponad 1 temat?"}
  SR_SIZE -->|"tak"| FD["Folder z helperami obok modułu"]
  SR_SIZE -->|"nie"| DONE["Zostaw obok jedynego konsumenta"]`
      },
      {
        id: 'sr-gates',
        title: 'Bramy strukturalne w npm run check:invariants',
        caption: 'Runner wykonuje 53 bramy po kolei w porządku z scripts/invariants/gates.ts i liczy każdą osobno; tu widać tylko bramy, które pilnują struktury. Każda brama kończy się liczbą; inna liczba niż oczekiwana albo zepsuta komenda to FAIL, a jedno FAIL kończy release-check kodem 1. Gate 9 i 12c rozpisuje diagram sr-classify.',
        mermaid: `flowchart TD
  RC["npm run release-check<br/>format, typecheck, lint, testy, build, e2e"] --> CI["npm run check:invariants<br/>scripts/check-invariants.ts"]
  CI --> SR_GATE_RUNNER{"Komenda bramy zwróciła liczbę,<br/>kod 0, pusty stderr?"}
  SR_GATE_RUNNER -->|"nie"| FAIL["FAIL — licznik bram nieudanych +1"]
  SR_GATE_RUNNER -->|"tak"| SR_GATE_BARRELS{"Gate 1, 1b, 35: jest index.ts lub index.tsx?"}
  SR_GATE_BARRELS -->|"tak"| FAIL
  SR_GATE_BARRELS -->|"0"| SR_GATE_MEMO{"Gate 3: useMemo, useCallback,<br/>React.memo, forwardRef?"}
  SR_GATE_MEMO -->|"tak"| FAIL
  SR_GATE_MEMO -->|"0"| SR_GATE_ERRORS{"Gate 4: new Error w engine, lib, cli, core?"}
  SR_GATE_ERRORS -->|"tak"| FAIL
  SR_GATE_ERRORS -->|"0"| SR_GATE_SIMPLE_GIT{"Gate 6: simple-git poza lib/git/client.ts?"}
  SR_GATE_SIMPLE_GIT -->|"tak"| FAIL
  SR_GATE_SIMPLE_GIT -->|"0"| SR_GATE_CLASSES{"Gate 8: class w produkcji?"}
  SR_GATE_CLASSES -->|"tak"| FAIL
  SR_GATE_CLASSES -->|"0"| G9["Gate 9 i 12c: import-boundaries classify()<br/>patrz sr-classify"]
  G9 -->|"naruszenia"| FAIL
  G9 -->|"0"| SR_GATE_ENGINE_REACT{"Gate 12, 12b, 30: engine importuje<br/>features, react lub ink?"}
  SR_GATE_ENGINE_REACT -->|"tak"| FAIL
  SR_GATE_ENGINE_REACT -->|"0"| SR_GATE_ESM_EXT{"Gate 16: relatywny import bez .js?"}
  SR_GATE_ESM_EXT -->|"tak"| FAIL
  SR_GATE_ESM_EXT -->|"0"| SR_GATE_ASSERTIONS{"Gate 17, 17b, 17c: !, any, szeroki as?"}
  SR_GATE_ASSERTIONS -->|"tak"| FAIL
  SR_GATE_ASSERTIONS -->|"0"| SR_GATE_KNIP{"Gate 18: knip widzi martwy plik lub eksport?"}
  SR_GATE_KNIP -->|"tak"| FAIL
  SR_GATE_KNIP -->|"0"| SR_GATE_DEPCRUISE{"Gate 19: zakazana krawędź warstw?"}
  SR_GATE_DEPCRUISE -->|"tak"| FAIL
  SR_GATE_DEPCRUISE -->|"0"| SR_GATE_CYCLES{"Gate 19: cykl runtime?"}
  SR_GATE_CYCLES -->|"tak"| FAIL
  SR_GATE_CYCLES -->|"0"| SR_GATE_REGISTRY_PARITY{"Gate 29: rejestry runnerów ≠ katalogi?"}
  SR_GATE_REGISTRY_PARITY -->|"tak"| FAIL
  SR_GATE_REGISTRY_PARITY -->|"0"| SR_GATE_CAPABILITY{"Gate 47: UI lub core importuje<br/>engine/providers/capability-inference?"}
  SR_GATE_CAPABILITY -->|"tak"| FAIL
  SR_GATE_CAPABILITY -->|"0"| SR_GATE_STACKS{"Gate 48: literał komendy poza<br/>core/validation/stacks?"}
  SR_GATE_STACKS -->|"tak"| FAIL
  SR_GATE_STACKS -->|"0"| SR_GATE_BUS_OWNER{"Gate 52: features tworzy EventBus?"}
  SR_GATE_BUS_OWNER -->|"tak"| FAIL
  SR_GATE_BUS_OWNER -->|"0"| SR_GATE_INK_TEXT{"Gate 57: Ink Text poza components/theme.tsx?"}
  SR_GATE_INK_TEXT -->|"tak"| FAIL
  SR_GATE_INK_TEXT -->|"0"| PASS["Struktura OK — pozostałe bramy dotyczą treści i procesu"]`
      }
    ],
    decisions: [
      {
        id: 'SR_BARREL',
        title: 'Zakaz barrel files',
        question: 'Czy nowy plik tylko re-eksportuje symbole z sąsiednich modułów?',
        where: 'docs/STRUCTURE.md:393',
        inputs: ['treść pliku', 'nazwa pliku (index.ts / index.tsx)'],
        branches: [
          { if: 'plik nazywa się index.ts lub index.tsx', then: 'gate 1 / 1b / 35 liczy go i build pada', next: 'SR_GATE_BARRELS' },
          { if: 'plik ma inną nazwę, ale treść to głównie export … from', then: 'to „ukryty barrel”; żadna brama go nie łapie, blokuje go tylko przegląd', next: 'SR_ZOD' },
          { if: 'plik ma własny kod', then: 'dalej w drzewie decyzji', next: 'SR_ZOD' }
        ],
        default: 'Konsumenci importują bezpośrednio z pliku producenta, zawsze z rozszerzeniem .js.',
        notes: 'Jedyny wyjątek w NO-BARRELS.md (publiczne API paczki) dziś nie dotyczy niczego. Porty `types.ts` w planners/ i implementers/ deklarują typy, więc nie są barrelami. find src -name index.ts zwraca 0.'
      },
      {
        id: 'SR_ZOD',
        title: 'Schemat Zod idzie do core/schemas',
        question: 'Czy to kształt danych sprawdzany w czasie działania (dysk, HTTP, wyjście LLM, podproces)?',
        where: 'docs/STRUCTURE.md:354',
        inputs: ['czy dane przekraczają granicę runtime'],
        branches: [
          { if: 'tak', then: 'src/core/schemas/<domena>.ts; typ z z.infer w tym samym pliku', next: 'SR_GATE_KNIP' },
          { if: 'nie', then: 'to typ TS albo kod', next: 'SR_TYPE' }
        ],
        default: 'Schemat i jego typ to jeden koncept, więc jeden plik.',
        notes: 'Reguła nie ma bramy. W drzewie 44 pliki produkcyjne poza core/schemas definiują schematy Zod (engine/providers 10, engine/streaming 4, engine/runners 4, engine/orchestrator 3, core/state 3 …). TYPES.md uznaje jawnie tylko EngineEventSchema i schematy calls. Patrz gotchas.'
      },
      {
        id: 'SR_TYPE',
        title: 'Reguła trzech przypadków dla typów TS',
        question: 'Kto używa tego typu?',
        where: 'docs/TYPES.md:40',
        inputs: ['liczba plików-konsumentów', 'liczba folderów', 'fan-in'],
        branches: [
          { if: 'jeden plik', then: 'inline w tym pliku (przypadek A)' },
          { if: 'kilka plików jednego folderu', then: '<folder>/types.ts, nigdy *-types.ts (przypadek B)' },
          { if: 'konsumenci w różnych folderach', then: 'obok producenta; konsumenci import type (przypadek C)' },
          { if: 'fan-in ponad 30 i co najmniej 3 foldery najwyższego poziomu', then: 'src/core/types/ — bez z.infer (gate 2)' },
          { if: 'to nie typ, tylko kod', then: 'dalej', next: 'SR_REACT' }
        ],
        default: 'Typ zostaje przy producencie.',
        notes: 'core/types ma dziś tylko 3 pliki (config-options, session-ref, user-input). Gate 2 (scripts/invariants/gates.ts:22) liczy z.infer w src/core/types/.'
      },
      {
        id: 'SR_REACT',
        title: 'Czy kod zależy od React / Ink?',
        question: 'Czy moduł importuje react lub ink?',
        where: 'docs/STRUCTURE.md:364',
        inputs: ['importy react, ink'],
        branches: [
          { if: 'tak', then: 'to UI: strona, features, components albo hooks', next: 'SR_PAGE' },
          { if: 'nie', then: 'warstwy bez UI', next: 'SR_STATE' }
        ],
        default: 'Kod bez React nie może leżeć w components/ ani hooks/.',
        notes: 'Engine nigdy nie importuje React ani Ink (SR_GATE_ENGINE_REACT). stores/create-store.ts i use-stores.ts importują react (useSyncExternalStore), choć ARCHITECTURE.md pisze, że stores nie importują React. lib/terminal/text-entry.ts importuje ink.'
      },
      {
        id: 'SR_PAGE',
        title: 'Wejście ekranu lub overlayu to płaska strona w app/',
        question: 'Czy to punkt wejścia całej powierzchni (ekran, overlay)?',
        where: 'scripts/import-boundaries.ts:96',
        inputs: ['ścieżka pliku', 'liczba segmentów ścieżki'],
        branches: [
          { if: 'ekran', then: 'src/app/screens/<x>.tsx + nazwa w ALL_SCREENS + case w renderScreen' },
          { if: 'overlay', then: 'src/app/overlays/<x>.tsx + id w ACTIVE_OVERLAYS + case w renderOverlay' },
          { if: 'nie', then: 'komponent albo hook', next: 'SR_UI_SHARED' }
        ],
        default: 'Strona składa features; sama zawiera tylko kompozycję.',
        notes: 'sliceRoot rozpoznaje stronę tylko przy dokładnie 3 segmentach (app/screens/x.tsx). Plik głębiej, np. app/screens/x/y.tsx, wypada z reguł izolacji stron, więc strony muszą zostać płaskie. help, sessions, setup i skills nie mają folderu features — strona to cała powierzchnia.'
      },
      {
        id: 'SR_UI_SHARED',
        title: 'Reguła dwóch konsumentów dla komponentów i hooków',
        question: 'Ilu feature’ów używa tego komponentu lub hooka?',
        where: 'docs/LAYERS.md:207',
        inputs: ['liczba feature’ów-konsumentów'],
        branches: [
          { if: 'jeden', then: 'src/features/<x>/ (components/ i hooks/ dopiero od 2 plików)' },
          { if: 'drugi feature zaczyna importować komponent', then: 'awans do src/components/<kategoria>/ (przykład: session-row.tsx)' },
          { if: 'drugi feature zaczyna importować hook', then: 'awans do src/hooks/' },
          { if: 'w components/ został tylko jeden konsument', then: 'degradacja z powrotem do feature (przykład: feedback-row.tsx)' }
        ],
        default: 'Zacznij wąsko, awansuj przy drugim konsumencie.',
        notes: 'Bez bramy: liczbę konsumentów sprawdza przegląd. Brama pilnuje tylko kierunku: components/ i hooks/ nie importują features/ (SR_GATE_COMPONENTS_FEATURES, depcruise hooks-no-features).'
      },
      {
        id: 'SR_STATE',
        title: 'Stan globalny idzie do stores',
        question: 'Czy to stan współdzielony z subskrybentami?',
        where: 'docs/STRUCTURE.md:372',
        inputs: ['czy stan czyta więcej niż jeden komponent / moduł'],
        branches: [
          { if: 'tak', then: 'src/stores/<grupa>/<nazwa>.ts z createStore; surowy set nie jest eksportowany (gate 5)' },
          { if: 'nie', then: 'dalej', next: 'SR_PURE' }
        ],
        default: 'Bez React Context i bez flag loaded: stores ładują się przed renderem (cli/bootstrap).',
        notes: 'Store z dostępem do dysku ma I/O obok siebie (np. stores/ui/persistence.ts), a cli/bootstrap/project.ts tylko je wywołuje.'
      },
      {
        id: 'SR_PURE',
        title: 'Czysty prymityw idzie do utils',
        question: 'Czy to bezstanowy prymityw bez domeny, który można opublikować na npm?',
        where: 'docs/STRUCTURE.md:375',
        inputs: ['importy', 'literały SPLITBRIEF', 'API Node'],
        branches: [
          { if: 'tak', then: 'src/utils/ — liść grafu', next: 'SR_GATE_DEPCRUISE' },
          { if: 'nie', then: 'dalej', next: 'SR_INFRA' }
        ],
        default: 'Walidator czysty idzie do utils, a fabryka błędu domeny do lib/core.',
        notes: 'Policzone: utils/ ma 0 importów do innych warstw. Brama: depcruise utils-is-a-leaf (.dependency-cruiser.cjs:13) i rank 0 w import-boundaries.'
      },
      {
        id: 'SR_INFRA',
        title: 'Wrapper zewnętrznego systemu idzie do lib',
        question: 'Czy moduł owija jeden zewnętrzny system (git, fs, child_process, terminal, HTTP, sqlite)?',
        where: 'docs/STRUCTURE.md:379',
        inputs: ['zależność od pakietu npm lub API Node', 'wiedza o domenie'],
        branches: [
          { if: 'tak i nie zna SPLITBRIEF', then: 'src/lib/<domena>/ (podfolder od 3 plików)' },
          { if: 'owija simple-git', then: 'tylko src/lib/git/client.ts', next: 'SR_GATE_SIMPLE_GIT' },
          { if: 'nie', then: 'dalej', next: 'SR_DOMAIN' }
        ],
        default: 'Wrapper jest generyczny, kontekst daje wołający.',
        notes: 'lib/ importuje tylko utils (17 krawędzi). Wyjątki w duchu reguły: lib/clipboard/image.ts woła osascript z AppKit (macOS), lib/terminal/text-entry.ts importuje ink.'
      },
      {
        id: 'SR_DOMAIN',
        title: 'Czy kod zna pojęcia SPLITBRIEF?',
        question: 'Czy moduł mówi o configu, sesjach, kosztach, tokenach, .splitbrief/, maszynie stanów?',
        where: 'docs/STRUCTURE.md:383',
        inputs: ['słownik domeny w kodzie'],
        branches: [
          { if: 'tak', then: 'engine albo core', next: 'SR_ORCH' },
          { if: 'nie', then: 'może przygotowanie CLI', next: 'SR_CLI_ONLY' }
        ],
        default: 'Domena nigdy nie trafia do utils ani lib.'
      },
      {
        id: 'SR_ORCH',
        title: 'engine czy core',
        question: 'Czy moduł uruchamia workflow albo podproces (planner, implementer, walidacja, retry, commit, spawn)?',
        where: 'docs/LAYERS.md:119',
        inputs: ['spawn procesów', 'wywołania runnerów', 'publikacja eventów'],
        branches: [
          { if: 'tak', then: 'src/engine/<domena>/ — publikuje EngineEvent, bez React i stores' },
          { if: 'nie: typy, przejścia, formatowanie, zapis własnego stanu domeny', then: 'src/core/<domena>/ — nic nie spawnuje' }
        ],
        default: 'core opisuje, engine wykonuje. Można by przepisać engine w innym runtime, a core zostałby bez zmian.',
        notes: 'Każda komenda walidacji biegnie w engine (orchestrator/validation/run-checks.ts, review-checks.ts); core/readiness tylko rozwiązuje i raportuje komendy. core może pisać na dysk (sesje, state, ledger).'
      },
      {
        id: 'SR_CLI_ONLY',
        title: 'Przygotowanie CLI zostaje w cli/ do drugiego konsumenta',
        question: 'Czy to tylko przygotowanie dla jednej podkomendy (flagi commandera, TTY, kody wyjścia)?',
        where: 'docs/LAYERS.md:251',
        inputs: ['liczba konsumentów', 'czy to pojęcie domeny'],
        branches: [
          { if: 'tylko CLI i jeden konsument', then: 'src/cli/' },
          { if: 'pojawia się drugi konsument', then: 'awans do src/core/, cli/ zostaje cienkim adapterem' },
          { if: 'to pojęcie domeny (sesje, migracja, config)', then: 'od razu core/, nawet z jednym konsumentem' },
          { if: 'nie', then: 'sprawdź rozmiar', next: 'SR_SIZE' }
        ],
        default: 'W razie wątpliwości start w cli/, awans przy drugim konsumencie.'
      },
      {
        id: 'SR_SIZE',
        title: 'Duży plik z wieloma tematami dostaje folder',
        question: 'Czy plik przekroczy 300 linii i ma więcej niż jeden temat?',
        where: 'docs/STRUCTURE.md:673',
        inputs: ['liczba linii', 'liczba odpowiedzialności'],
        branches: [
          { if: 'ponad 300 linii i ponad 1 temat', then: 'folder z helperami obok modułu' },
          { if: 'ponad 500 linii', then: '„przemyśl” — plik pewnie ukrywa drugi koncept' },
          { if: 'nie', then: 'zostaw obok jedynego konsumenta' }
        ],
        default: 'Wskazówka, nie twarda reguła.',
        notes: 'W drzewie jest 65 plików produkcyjnych ponad 500 linii, np. lib/confined-fs-atomic.ts (1533), recovery/builders/task.ts (1186), core/state/machine.ts (1159).'
      },
      {
        id: 'SR_GATE_RELATIVE',
        title: 'Które importy widzi gate 9',
        question: 'Czy specyfikator jest relatywny i wskazuje do src/?',
        where: 'scripts/import-boundaries.ts:228',
        inputs: ['specyfikator po from', 'import bez nazw'],
        branches: [
          { if: 'zaczyna się od kropki i rozwiązuje się do src/', then: 'klasyfikacja', next: 'SR_GATE_COMPONENTS_FEATURES' },
          { if: 'pakiet npm, alias #testing, ścieżka spoza src', then: 'pominięty' },
          { if: 'dynamiczny import(...)', then: 'niewidoczny dla regexów (IMPORT_RE łapie tylko from)' }
        ],
        default: 'Pominięte krawędzie sprawdza dependency-cruiser (gate 19), który rozwiązuje prawdziwy graf.',
        notes: 'Leniwe loadery w engine/runners/factory.ts:35 to dynamiczne import(); gate 9 ich nie widzi, ale wszystkie zostają w engine.'
      },
      {
        id: 'SR_GATE_COMPONENTS_FEATURES',
        title: 'components/ nie importuje features/',
        question: 'Czy plik z components/ importuje coś z features/?',
        where: 'scripts/import-boundaries.ts:170',
        inputs: ['ścieżka źródła', 'plaster celu'],
        branches: [
          { if: 'tak', then: 'naruszenie gate 9; ta sama reguła w depcruise components-no-features (.dependency-cruiser.cjs:61)' },
          { if: 'nie', then: 'dalej', next: 'SR_GATE_SHARED_EDITOR' }
        ],
        default: 'Wspólne UI nie zależy od pionowego plastra.'
      },
      {
        id: 'SR_GATE_SHARED_EDITOR',
        title: 'Wyjątek: features/editor jako wspólny plaster',
        question: 'Czy celem importu jest features/editor?',
        where: 'scripts/import-boundaries.ts:118',
        inputs: ['SHARED_FEATURES = {editor}'],
        branches: [
          { if: 'tak', then: 'izolacja plastrów pominięta; dalej tylko sprawdzenie powłoki i ranków', next: 'SR_GATE_SHELL' },
          { if: 'nie', then: 'zwykła izolacja', next: 'SR_GATE_CROSS_FEATURE' }
        ],
        default: 'Każdy feature mógłby importować edytor.',
        notes: 'Martwy wyjątek: dziś żaden feature nie importuje features/editor; importuje go tylko app/overlays/editor.tsx.'
      },
      {
        id: 'SR_GATE_CROSS_FEATURE',
        title: 'Feature nie importuje innego feature',
        question: 'Czy src/features/<a>/** importuje src/features/<b>/**?',
        where: 'scripts/import-boundaries.ts:122',
        inputs: ['nazwa plastra źródła', 'nazwa plastra celu'],
        branches: [
          { if: 'tak', then: 'naruszenie gate 9' },
          { if: 'nie', then: 'dalej', next: 'SR_GATE_PAGES' }
        ],
        default: 'Wspólny kod idzie do components, hooks, utils, core albo stores; kompozycja dzieje się na stronie w app/.',
        notes: 'Policzone: 0 krawędzi feature → feature. Tej reguły pilnuje tylko import-boundaries; .dependency-cruiser.cjs nie ma reguły feature → feature.'
      },
      {
        id: 'SR_GATE_PAGES',
        title: 'Strony nie importują się nawzajem',
        question: 'Czy strona z app/screens lub app/overlays importuje inną stronę?',
        where: 'scripts/import-boundaries.ts:127',
        inputs: ['rodzaj plastra (screen / overlay)', 'nazwa'],
        branches: [
          { if: 'screen → screen', then: 'naruszenie' },
          { if: 'overlay → overlay', then: 'naruszenie' },
          { if: 'screen ↔ overlay', then: 'naruszenie' },
          { if: 'strona → feature', then: 'dozwolone (kompozycja)', next: 'SR_GATE_SHELL' }
        ],
        default: 'Strony koordynują się przez stores.',
        notes: 'Powłoka może importować strony: router.tsx importuje wszystkie 11, a root.tsx importuje typy z home.tsx i setup.tsx.'
      },
      {
        id: 'SR_GATE_SHELL',
        title: 'Strona nie importuje modułów powłoki',
        question: 'Czy strona importuje app/root, app/router, app/provider albo app/layout?',
        where: 'scripts/import-boundaries.ts:182',
        inputs: ['APP_SHELL_MODULES = root, router, provider, layout'],
        branches: [
          { if: 'tak', then: 'naruszenie gate 9' },
          { if: 'strona importuje keys.ts, command-context.ts, prepare-resume.ts, refresh-skills.ts', then: 'dozwolone — to nie są chronione moduły', next: 'SR_GATE_ENGINE_UI' },
          { if: 'nie', then: 'dalej', next: 'SR_GATE_ENGINE_UI' }
        ],
        default: 'Strona dostaje wszystko przez props i stores.'
      },
      {
        id: 'SR_GATE_ENGINE_UI',
        title: 'engine nie importuje stores, hooks, components, cli',
        question: 'Czy plik z src/engine/ importuje src/stores, hooks, components albo cli?',
        where: 'scripts/import-boundaries.ts:189',
        inputs: ['ENGINE_FORBIDDEN_TOPLEVEL (linia 154)'],
        branches: [
          { if: 'tak', then: 'naruszenie; gate 12c liczy dokładnie te komunikaty' },
          { if: 'cel w features/ lub app/', then: 'łapie to reguła ranków (engine 3 < features 4, app 5) i gate 12', next: 'SR_GATE_RANK' },
          { if: 'nie', then: 'dalej', next: 'SR_GATE_STORES_ENGINE' }
        ],
        default: 'Engine publikuje eventy; nie zna UI ani stores.',
        notes: 'INVARIANTS.md opisuje 12c jako components/hooks/cli, a kod zabrania także stores. depcruise engine-below-ui (.dependency-cruiser.cjs:37) obejmuje stores, features, components, hooks, app, cli.'
      },
      {
        id: 'SR_GATE_STORES_ENGINE',
        title: 'stores → engine tylko przez import type',
        question: 'Czy stores importuje engine i czy to import wartości?',
        where: 'scripts/import-boundaries.ts:207',
        inputs: ['czy import zaczyna się od import type / export type'],
        branches: [
          { if: 'import type', then: 'dozwolone (dziś 43 krawędzie, wszystkie typowe: EngineEvent, typy detekcji, prepared execution)' },
          { if: 'import wartości', then: 'naruszenie; to samo w depcruise stores-engine-type-only (.dependency-cruiser.cjs:45)' },
          { if: 'to nie stores → engine', then: 'reguła ranków', next: 'SR_GATE_RANK' }
        ],
        default: 'Stores i engine mają ten sam rank 3; typ to jedyny kanał.',
        notes: 'Regex rozpoznaje tylko import type na początku; import { type X } liczy się jako wartość.'
      },
      {
        id: 'SR_GATE_RANK',
        title: 'Kierunek warstw według ranku',
        question: 'Czy rank warstwy celu jest większy niż rank warstwy źródła?',
        where: 'scripts/import-boundaries.ts:212',
        inputs: ['LAYER_RANK (linia 19): utils 0, lib 1, core 2, engine 3, stores 3, features 4, components 4, hooks 4, app 5, cli 5'],
        branches: [
          { if: 'tak', then: 'naruszenie (np. core → engine, lib → core, features → app)' },
          { if: 'nie (ten sam lub niższy rank)', then: 'dozwolone — także cli → features, components → engine, hooks → engine' },
          { if: 'ta sama warstwa albo plik w korzeniu src', then: 'zawsze dozwolone' }
        ],
        default: 'Import w dół jest wolny.',
        notes: 'Ten sam rank: features ↔ components ↔ hooks i app ↔ cli. import-boundaries nie zabrania hooks → features; robi to tylko depcruise hooks-no-features (.dependency-cruiser.cjs:69). cli → app (3 krawędzie, import App) jest dozwolone.'
      },
      {
        id: 'SR_GATE_DEPCRUISE',
        title: 'Gate 19: zakazane krawędzie warstw w dependency-cruiser',
        question: 'Czy rozwiązany import łamie którąś regułę forbidden?',
        where: '.dependency-cruiser.cjs:3',
        inputs: ['graf modułów z tsconfig.json', 'typ zależności (type-only)'],
        branches: [
          { if: 'utils → lib/core/engine/stores/features/components/hooks/app/cli', then: 'błąd utils-is-a-leaf' },
          { if: 'lib → core lub wyżej', then: 'błąd lib-below-domain' },
          { if: 'core → engine/stores/features/components/hooks/app/cli', then: 'błąd core-below-engine-and-ui' },
          { if: 'engine → stores/features/components/hooks/app/cli', then: 'błąd engine-below-ui' },
          { if: 'stores → engine, nie type-only', then: 'błąd stores-engine-type-only' },
          { if: 'stores → features/components/hooks/app/cli', then: 'błąd stores-below-ui' },
          { if: 'components → features lub hooks → features', then: 'błąd components-no-features / hooks-no-features' },
          { if: 'features → app/cli', then: 'błąd features-below-app-cli' },
          { if: 'cykl runtime', then: 'błąd no-circular', next: 'SR_GATE_CYCLES' }
        ],
        default: 'Gate 19 liczy linie z „error”; oczekiwane 0.',
        notes: 'Testy są wykluczone (options.exclude, linia 86), a graf obejmuje tylko ^src/ (linia 94). Gate 9 i 19 pilnują tego samego dwoma silnikami.'
      },
      {
        id: 'SR_GATE_CYCLES',
        title: 'Brak cykli runtime',
        question: 'Czy moduł wraca do siebie przez łańcuch importów wartości?',
        where: '.dependency-cruiser.cjs:5',
        inputs: ['viaOnly.dependencyTypesNot: type-only'],
        branches: [
          { if: 'cykl przez importy wartości', then: 'błąd gate 19' },
          { if: 'cykl tylko przez import type', then: 'dozwolony (znika po kompilacji)' }
        ],
        default: 'Graf runtime jest acykliczny.',
        notes: 'Przykład dozwolonego cyklu typów: app/router.tsx importuje type AppInteractionDeps z app/root.tsx, a root.tsx importuje router.tsx. Na poziomie folderów są krawędzie w obie strony (orchestrator ↔ snapshots 24/6, planners ↔ runners 33/8, core config ↔ schemas 63/1), ale bez cykli modułów.'
      },
      {
        id: 'SR_GATE_BARRELS',
        title: 'Gate 1 / 1b / 35: brak index.ts i index.tsx',
        question: 'Czy w src/ istnieje plik index.ts albo index.tsx?',
        where: 'scripts/invariants/gates.ts:10',
        inputs: ['find src -name index.ts | wc -l'],
        branches: [
          { if: 'liczba ponad 0', then: 'FAIL' },
          { if: '0', then: 'PASS' }
        ],
        default: 'Dziś 0.',
        notes: 'Gate 35 (linia 267) to duplikat gate 1 jako osobna brama licząca. Treściowe „ukryte barrele” nie mają bramy.'
      },
      {
        id: 'SR_GATE_CLASSES',
        title: 'Gate 8: zero klas runtime w produkcji',
        question: 'Czy plik produkcyjny zawiera słowo class i nazwę?',
        where: 'scripts/invariants/gates.ts:55',
        inputs: ['rg "\\bclass\\s+\\w+" src bez testów'],
        branches: [
          { if: 'jest trafienie', then: 'FAIL' },
          { if: 'brak', then: 'PASS — tylko funkcje i stan modułu' }
        ],
        default: 'Testy mogą mieć klasy, gdy to zachowanie jest testowane.',
        notes: 'Regex nie odróżnia kodu od komentarza: słowa class + nazwa w komentarzu też psują bramę.'
      },
      {
        id: 'SR_GATE_MEMO',
        title: 'Gate 3: zero memoizacji i imperative handles',
        question: 'Czy src/ zawiera useMemo, useCallback, React.memo, forwardRef albo useImperativeHandle?',
        where: 'scripts/invariants/gates.ts:28',
        inputs: ['rg po src/ (także testy)'],
        branches: [
          { if: 'trafienie', then: 'FAIL' },
          { if: 'brak', then: 'PASS — selektory stores zastępują memoizację' }
        ],
        default: 'Stan do współdzielenia idzie do store, nie do ref.'
      },
      {
        id: 'SR_GATE_ENGINE_REACT',
        title: 'Gate 12 / 12b / 30: engine bez features i bez React/Ink',
        question: 'Czy plik z src/engine importuje features albo pakiety react, react-dom, ink?',
        where: 'scripts/invariants/gates.ts:81',
        inputs: ['grep "from.*features" w src/engine', 'rg "from react|from ink"'],
        branches: [
          { if: 'import features', then: 'FAIL gate 12' },
          { if: 'import react lub ink', then: 'FAIL gate 12b' },
          { if: 'import react, react-dom lub ink', then: 'FAIL gate 30 (linia 232)' },
          { if: 'brak', then: 'PASS — engine działa headless pod Vitest' }
        ],
        default: 'Engine pozostaje uruchamialny bez Ink.'
      },
      {
        id: 'SR_GATE_SIMPLE_GIT',
        title: 'Gate 6: simple-git tylko w lib/git/client.ts',
        question: 'Czy plik produkcyjny inny niż src/lib/git/client.ts importuje simple-git?',
        where: 'scripts/invariants/gates.ts:48',
        inputs: ['rg "from simple-git"'],
        branches: [
          { if: 'tak', then: 'FAIL' },
          { if: 'nie', then: 'PASS — reszta kodu woła nazwane helpery lib/git/' }
        ],
        default: 'Testy mogą importować simple-git dla prawdziwej granicy git.'
      },
      {
        id: 'SR_GATE_ESM_EXT',
        title: 'Gate 16: relatywny import z rozszerzeniem .js',
        question: 'Czy relatywny import w produkcji nie kończy się na .js albo .json?',
        where: 'scripts/invariants/gates.ts:121',
        inputs: ['rg "from \'./" bez testów'],
        branches: [
          { if: 'brak rozszerzenia .js', then: 'FAIL — Node 22 ESM nie rozwiąże ścieżki' },
          { if: '.js lub .json', then: 'PASS' }
        ],
        default: 'Import zawsze ./plik.js, nawet gdy źródło to .ts lub .tsx.'
      },
      {
        id: 'SR_GATE_ASSERTIONS',
        title: 'Gate 17 / 17b / 17c: bez !, any i szerokiego as',
        question: 'Czy kod produkcyjny używa niepewnej asercji poza listą sankcjonowanych plików?',
        where: 'scripts/invariants/gates.ts:128',
        inputs: ['regexy per brama', 'allow-listy plików'],
        branches: [
          { if: 'non-null ! poza stores/use-stores, engine/codebase/graph, engine/codebase/pagerank', then: 'FAIL gate 17' },
          { if: 'any w pozycji typu', then: 'FAIL gate 17b (linia 134)' },
          { if: 'as Typ poza use-stores, engine/hooks/substitute, utils/error, utils/type-guards (bez as const, as unknown, as Extract)', then: 'FAIL gate 17c (linia 140)' },
          { if: 'brak', then: 'PASS' }
        ],
        default: 'Biome ma noNonNullAssertion i noExplicitAny wyłączone; tylko te bramy pilnują reguły.',
        notes: 'CLAUDE.md wymienia też create-store.ts i lib/terminal/filtered-stdin/create.ts jako sankcjonowane, ale nie ma ich na allow-listach bram — dziś nie potrzebują wyjątku.'
      },
      {
        id: 'SR_GATE_ERRORS',
        title: 'Gate 4: bez new Error w engine, lib, cli, core',
        question: 'Czy produkcja w engine/lib/cli/core tworzy błąd przez new Error(?',
        where: 'scripts/invariants/gates.ts:35',
        inputs: ['rg "new Error\\("'],
        branches: [
          { if: 'tak (poza recordException(new Error)', then: 'FAIL' },
          { if: 'nie', then: 'PASS — błędy przez fabrykę error() z utils/error.ts i worki domen' }
        ],
        default: 'Funkcje wewnętrzne propagują, decyduje granica (ERRORS.md).'
      },
      {
        id: 'SR_GATE_BUS_OWNER',
        title: 'Gate 52: features nie tworzą EventBus',
        question: 'Czy plik w src/features woła createEventBus albo new EventBus?',
        where: 'scripts/invariants/gates.ts:315',
        inputs: ['rg w src/features bez testów'],
        branches: [
          { if: 'tak', then: 'FAIL' },
          { if: 'nie', then: 'PASS — bus między turami daje engine/orchestrator/recovery/bus.ts' }
        ],
        default: 'Engine jest właścicielem każdego busa.',
        notes: 'app/command-context.ts i features/workflow/hooks/use-run-loop.ts wołają createRecoveryBus z sinkiem addTuiEvent.'
      },
      {
        id: 'SR_GATE_CAPABILITY',
        title: 'Gate 47: inferencja capability tylko z core',
        question: 'Czy features, app, components albo core importują engine/providers/capability-inference?',
        where: 'scripts/invariants/gates.ts:280',
        inputs: ['rg po ścieżkach UI i core'],
        branches: [
          { if: 'tak', then: 'FAIL' },
          { if: 'nie', then: 'PASS — UI czyta src/core/runners/capabilities.ts' }
        ],
        default: 'To, co UI potrzebuje o capability, leży w core.'
      },
      {
        id: 'SR_GATE_STACKS',
        title: 'Gate 48: literały komend tylko w core/validation/stacks',
        question: 'Czy produkcja poza stacks/ zawiera npx tsc, npm test albo literał .test.ts?',
        where: 'scripts/invariants/gates.ts:287',
        inputs: ['rg w src bez testów, bez src/core/validation/stacks'],
        branches: [
          { if: 'tak', then: 'FAIL' },
          { if: 'nie', then: 'PASS — komendy stosu żyją w rejestrze STACKS' }
        ],
        default: 'Nowy stos = nowy wiersz w core/validation/stacks/registry.ts.'
      },
      {
        id: 'SR_GATE_KNIP',
        title: 'Gate 18: brak martwych plików i eksportów',
        question: 'Czy knip znajduje nieużywany plik, eksport albo typ?',
        where: 'scripts/invariants/gates.ts:147',
        inputs: ['knip.json: entry, project (src, scripts, evals, testing)'],
        branches: [
          { if: 'tak', then: 'FAIL — usuń albo użyj' },
          { if: 'nie', then: 'PASS' }
        ],
        default: 'Eksport używany tylko w pliku nie jest błędem (ignoreExportsUsedInFile).',
        notes: 'Dlatego nowy moduł bez konsumenta nie przejdzie bramy: najpierw konsument, potem eksport.'
      },
      {
        id: 'SR_GATE_INK_TEXT',
        title: 'Gate 57: Ink Text tylko w components/theme.tsx',
        question: 'Czy plik inny niż components/theme.tsx importuje Text z ink?',
        where: 'scripts/invariants/gates.ts:353',
        inputs: ['rg wielowierszowy po importach ink'],
        branches: [
          { if: 'tak', then: 'FAIL' },
          { if: 'nie', then: 'PASS — komponenty używają ThemeText' }
        ],
        default: 'Jeden punkt dostępu do koloru tekstu.'
      },
      {
        id: 'SR_GATE_REGISTRY_PARITY',
        title: 'Gate 29: rejestry runnerów zgodne z katalogami',
        question: 'Czy klucze CLI_PLANNER_ADAPTERS, CLI_IMPLEMENTER_ADAPTERS i KNOWN_PROVIDERS pasują do krotek katalogów?',
        where: 'scripts/invariants/gates.ts:225',
        inputs: ['engine/runners/cli-tools/registry.ts', 'core/runners/cli-tool-catalog.ts', 'core/providers/api-provider-catalog.ts', 'engine/providers/registry.ts'],
        branches: [
          { if: 'brakuje adaptera albo jest nadmiarowy', then: 'FAIL' },
          { if: 'zgodne', then: 'PASS' }
        ],
        default: 'Katalog w core i rejestr w engine muszą zmieniać się razem.',
        notes: 'KNOWN_PROVIDERS jest typowany Record<ApiProviderId, …>, więc dla API kompilator łapie brak fabryki wcześniej. Gate 34 (linia 260) pilnuje, żeby wykluczone id nie trafiły do rejestrów.'
      },
      {
        id: 'SR_GATE_RUNNER',
        title: 'Runner bram działa fail closed',
        question: 'Czy komenda bramy zwróciła poprawną liczbę?',
        where: 'scripts/check-invariants.ts:33',
        inputs: ['stdout komendy', 'kod wyjścia', 'stderr'],
        branches: [
          { if: 'wyjście nie jest liczbą', then: 'FAIL „invalid output”' },
          { if: 'kod wyjścia ≠ 0, sygnał albo niepusty stderr', then: 'FAIL „command failed” (linia 41)' },
          { if: 'liczba ≠ expected', then: 'FAIL' },
          { if: 'liczba = expected', then: 'PASS' }
        ],
        default: 'Zepsuta brama to brama nieprzechodząca, nie zero.',
        notes: 'Runner ma 53 bramy o id do 59 (luki: brak 7 i 36–45). Uruchamia go npm run check:invariants w release-check i test-ci.'
      },
      {
        id: 'SR_FACTORY_KIND',
        title: 'Fabryka runnera wybiera backend po kind',
        question: 'Który moduł backendu załadować dla seat-u?',
        where: 'src/engine/runners/factory.ts:54',
        inputs: ['config.planner.kind / config.implementer.kind', 'tool', 'skonfigurowany custom runner'],
        branches: [
          { if: 'seat ma skonfigurowany custom runner', then: 'planners/command-invoke.ts lub implementers/command-invoke.ts (linie 99, 142, 182)' },
          { if: 'planner kind cli i tool claude-code', then: 'planners/claude-code.ts (linia 56)' },
          { if: 'planner kind cli, inne narzędzie', then: 'planners/cli.ts przez rejestr adapterów CLI' },
          { if: 'kind api', then: 'planners/api.ts / implementers/api.ts' },
          { if: 'kind shell', then: 'planners/shell.ts / implementers/shell.ts' },
          { if: 'kind agent', then: 'planners/agent.ts / implementers/agent.ts' }
        ],
        default: 'assertNever(kind): piąty kind nie skompiluje się.',
        notes: 'Reviewer to Planner: createReviewer (linia 133) podstawia runner reviewera w slot config.planner i woła ten sam loadPlanner. Implementer kind cli ma jeden moduł implementers/cli.ts dla wszystkich 8 narzędzi (switch w linii 221). Szczegóły wywołania → obszar runners.'
      },
      {
        id: 'SR_ROUTER_SCREEN',
        title: 'Router wybiera ekran',
        question: 'Jaki ekran pokazać dla routerStore.screen?',
        where: 'src/app/router.tsx:75',
        inputs: ['screen: home | workflow | setup'],
        branches: [
          { if: 'home', then: 'HomeScreen (app/screens/home.tsx)' },
          { if: 'workflow', then: 'WorkflowScreen (app/screens/workflow.tsx) z workflowDeps' },
          { if: 'setup', then: 'SetupScreen (app/screens/setup.tsx)' }
        ],
        default: 'assertNever(screen): nowy ekran wymaga case.',
        notes: 'Gdy przygotowanie sesji zajmuje stronę, Layout pokazuje SessionPreparation (app/session-preparation.tsx) zamiast ekranu.'
      },
      {
        id: 'SR_ROUTER_OVERLAY',
        title: 'Router wybiera overlay',
        question: 'Który overlay jest aktywny?',
        where: 'src/app/router.tsx:116',
        inputs: ['OverlayType z ACTIVE_OVERLAYS (core/navigation/types.ts:61)'],
        branches: [
          { if: 'none', then: 'brak overlayu' },
          { if: 'help / command-palette / skills / settings / sessions / usage-details / editor', then: 'odpowiednia strona z app/overlays' },
          { if: 'planner-, implementer-, reviewer-picker', then: 'ToolModelPicker slot seat' },
          { if: 'planner-, implementer-, reviewer-fallback-picker', then: 'ToolModelPicker slot fallback' },
          { if: 'stop-sheet', then: 'null — menu rysuje się nad composerem workflow (linia 139)' }
        ],
        default: 'assertNever(active).',
        notes: '13 id overlayów (plus none) prowadzi do 8 plików stron. Szczegóły UI → obszar ui.'
      },
      {
        id: 'SR_SINKS',
        title: 'Które sinki dostaje bus runu',
        question: 'Jakie subskrypcje podpiąć do busa tego runu?',
        where: 'src/engine/orchestrator/run/init-sinks.ts:35',
        inputs: ['opts.tuiSink', 'opts.headless', 'opts.plain', 'opts._eventSink', 'config.hooks'],
        branches: [
          { if: 'opts.tuiSink (TUI)', then: 'subskrypcja addTuiEvent → stores' },
          { if: 'zawsze', then: 'jsonl (session.jsonl), logger, call-evidence (linie 37, 45, 48)' },
          { if: 'headless i plain', then: 'stdout-text + echo warning/info na stderr (linia 51)' },
          { if: 'headless bez plain', then: 'stdout-json (NDJSON)' },
          { if: 'opts._eventSink', then: 'sink testowy (linia 70)' },
          { if: 'config.hooks', then: 'hook sink post_* / on_* (linia 71)' }
        ],
        default: 'Sinki poprzedniego runu na tym samym busie są najpierw odpinane.',
        notes: 'To jedyne miejsce subskrypcji sinków runu. Dokładnie jeden z dwóch sinków stdout jest podpięty. Sink call-evidence leży w orchestrator/summary, a hook sink w engine/hooks — nie w events/sinks.'
      },
      {
        id: 'SR_BUS_ISOLATION',
        title: 'Izolacja awarii sinka',
        question: 'Co się dzieje, gdy sink rzuci wyjątek?',
        where: 'src/engine/events/bus.ts:10',
        inputs: ['wyjątek z sink(event)'],
        branches: [
          { if: 'sink rzuca', then: 'catch bez akcji; kolejne sinki dostają ten sam event' },
          { if: 'sink przechodzi', then: 'następny sink w kolejności subskrypcji' }
        ],
        default: 'Projekcja (dysk, stdout, render, hook) nie jest autorytatywna i nie może zatrzymać runu.',
        notes: 'Bus iteruje po kopii zbioru sinków, więc subskrypcja w trakcie publikacji nie zmienia bieżącej publikacji.'
      },
      {
        id: 'SR_ADD_EVENT',
        title: 'addEvent rozkłada event na sub-stores',
        question: 'Do których stores trafi EngineEvent?',
        where: 'src/stores/workflow/actions/event.ts:17',
        inputs: ['event.type', 'lifecycleStore.cancelled'],
        branches: [
          { if: 'cost_update', then: 'tylko tokensStore i koniec (linia 17)' },
          { if: 'run anulowany i event nieakceptowany po cancel', then: 'event pominięty (linia 22)' },
          { if: 'inny event', then: 'eventsStore (gdy projekcja nie jest null), potem tasks, tokens, lifecycle, operations — synchronicznie' }
        ],
        default: 'Sub-stores workflow zapisuje tylko workflow/actions przez _xInternal.set.',
        notes: 'EXTENDING.md opisuje kolejność events → tasks → tokens → lifecycle → operations i nie wspomina skrótu dla cost_update.'
      }
    ],
    config: [
      { key: 'LAYER_RANK', values: 'utils 0, lib 1, core 2, engine 3, stores 3, features 4, components 4, hooks 4, app 5, cli 5', default: 'jak obok', effect: 'Import do warstwy o wyższym ranku to naruszenie gate 9.', where: 'scripts/import-boundaries.ts:19' },
      { key: 'SHARED_FEATURES', values: 'zbiór nazw feature', default: "{'editor'}", effect: 'Feature z tego zbioru może importować każdy inny feature (dziś nieużywane).', where: 'scripts/import-boundaries.ts:113' },
      { key: 'APP_SHELL_MODULES', values: 'root, router, provider, layout', default: 'jak obok', effect: 'Moduły powłoki, których strony nie mogą importować.', where: 'scripts/import-boundaries.ts:144' },
      { key: 'BOUNDARY_VERBOSE', values: '1 | brak', default: 'brak', effect: 'Wypisuje każde naruszenie na stderr; gate 12c filtruje z tego komunikaty o engine.', where: 'scripts/import-boundaries.ts:249' },
      { key: '.dependency-cruiser.cjs options.exclude', values: 'regex', default: '\\.test\\.(ts|tsx)$', effect: 'Testy nie wchodzą do grafu gate 19.', where: '.dependency-cruiser.cjs:86' },
      { key: '.dependency-cruiser.cjs options.includeOnly', values: 'regex', default: '^src/', effect: 'Gate 19 sprawdza tylko src/; scripts, testing, evals są poza grafem.', where: '.dependency-cruiser.cjs:94' },
      { key: 'package.json imports #testing/*', values: 'alias ścieżki', default: './testing/*', effect: 'Testy importują helpery przez alias; gate 20 zabrania ścieżek relatywnych.', where: 'package.json:103' },
      { key: 'package.json bin.splitbrief', values: 'ścieżka', default: './dist/cli.js', effect: 'Binarka to skompilowany src/cli.ts (tsc, rootDir src).', where: 'package.json:54' },
      { key: 'tsconfig.json exclude', values: 'lista', default: 'node_modules, dist, testing, **/*.test.ts(x)', effect: 'Build produkcyjny nie widzi testów ani testing/.', where: 'tsconfig.json:25' },
      { key: 'knip.json project / entry', values: 'globy', default: 'src, scripts, evals, testing bez testów i fixtures', effect: 'Zakres gate 18 (martwy kod).', where: 'knip.json:3' },
      { key: 'vitest.config.ts projects', values: 'unit | integration | workflow-screen', default: 'jak obok', effect: 'Testy kolokowane *.test.ts to unit; *.integration.test.ts i testing/integration to integration.', where: 'vitest.config.ts:54' },
      { key: 'NODE_ENV', values: 'production', default: 'ustawiane zawsze przez node-env.ts', effect: 'React w wersji produkcyjnej; bez tego pomiary renderów zapychały stertę.', where: 'src/node-env.ts:4' },
      { key: 'SPLITBRIEF_OWNER_COMMIT=1 (prefiks komendy)', values: 'prefiks', default: 'brak', effect: 'Jedyny sposób, by hook block-git-commits.sh przepuścił commit sesji orkiestrującej.', where: '.claude/hooks/block-git-commits.sh:26' }
    ],
    states: [
      { name: 'utils (rank 0)', meaning: 'Liść: importuje tylko Node i npm. Wolno go importować wszystkim.', where: '.dependency-cruiser.cjs:13' },
      { name: 'lib (rank 1)', meaning: 'Importuje utils i inne lib. Nie zna domeny.', where: '.dependency-cruiser.cjs:21' },
      { name: 'core (rank 2)', meaning: 'Importuje utils, lib, core. Zero engine, stores, UI, app, cli.', where: '.dependency-cruiser.cjs:29' },
      { name: 'engine (rank 3)', meaning: 'Importuje utils, lib, core, engine. Zero stores, features, components, hooks, app, cli, react, ink.', where: '.dependency-cruiser.cjs:37' },
      { name: 'stores (rank 3)', meaning: 'Importuje utils, lib, core i engine tylko przez import type. Zero UI, app, cli.', where: '.dependency-cruiser.cjs:45' },
      { name: 'features (rank 4)', meaning: 'Importuje wszystko poniżej oraz components i hooks. Nie importuje innego feature, app ani cli.', where: '.dependency-cruiser.cjs:76' },
      { name: 'components (rank 4)', meaning: 'Wspólne UI. Nie importuje features. Dziś importuje 3 wartości z engine.', where: '.dependency-cruiser.cjs:61' },
      { name: 'hooks (rank 4)', meaning: 'Wspólne hooki. Nie importuje features (tylko depcruise). Dziś importuje engine (display-names).', where: '.dependency-cruiser.cjs:69' },
      { name: 'app (rank 5)', meaning: 'Powłoka i strony. Strony nie importują stron ani modułów powłoki.', where: 'scripts/import-boundaries.ts:127' },
      { name: 'cli (rank 5)', meaning: 'Podkomendy. Może importować wszystko, w tym app (App) i features (hydrateRun).', where: 'scripts/import-boundaries.ts:29' }
    ],
    scenarios: [
      {
        title: 'Dodaję komendę runtime /foo',
        steps: [
          '1. Wybieram kategorię z COMMAND_CATEGORIES (src/core/runtime/commands/types.ts:153): navigate, crew, workflow, view, io.',
          '2. Dopisuję wpis do tablicy zwracanej przez <kategoria>Commands(ctx) w src/core/runtime/commands/defs/<kategoria>.ts: kind, name, description, category, validScreens, handler; dla arg też args.',
          '3. Gdy komenda działa tylko w części faz, dodaję guard(ctx) zwracający powód; powód blokuje komendę i ukrywa wiersz.',
          '4. Gdy handler potrzebuje nowego portu (np. akcji engine), dopisuję go do RuntimeCommandContext (types.ts:258), do createCommandContext (context-factory.ts:58) i podpinam w app/command-context.ts — to jedyne miejsce, gdzie UI łączy porty z engine i stores.',
          '5. registry.ts sam skleja moduły; palette i /help czytają ten sam rejestr, więc nie dodaję nic w UI.',
          '6. Usunięta na stałe nazwa idzie do REMOVED_COMMANDS z jednym zdaniem dla użytkownika.',
          '7. Opisuję komendę w docs/SLASH-COMMANDS-REFERENCE.md.'
        ],
        outcome: 'Komenda pojawia się w composerze /, w palecie i w /help. core/ nie importuje engine (gate 19), więc cała praca z engine dzieje się w porcie z app/.'
      },
      {
        title: 'Dodaję nowy typ EngineEvent',
        steps: [
          '1. W src/engine/events/schema.ts dodaję członka przez phaseEvent(\'my_event\').extend({…}) albo noPhaseEvent dla eventu globalnego, do unii EngineEventSchema (linia 873).',
          '2. Typ EngineEvent w engine/events/types.ts:11 to z.infer, więc nie edytuję typu ręcznie.',
          '3. Dodaję helper publishMyEvent(bus, phase, payload) w src/engine/orchestrator/events.ts i wołam go z modułu orchestratora.',
          '4. Kompilator wymusza case w dwóch wyczerpujących switchach: updateTokens w src/stores/workflow/tokens.ts:135 i eventRowBlock w src/features/workflow/conversation-rows/event-rows/dispatch.ts:86 (zwracam [] dla eventu cichego).',
          '5. Gdy event ma zmieniać stan UI, obsługuję go w reduktorach wołanych z addEvent (stores/workflow/actions/event.ts).',
          '6. Gdy hook ma reagować na event, dopisuję mapowanie w eventToHookKey (engine/hooks/sink.ts:105).'
        ],
        outcome: 'Event płynie engine → bus → jsonl + addTuiEvent → stores → wiersz transkryptu. EXTENDING.md wymienia tylko dispatch.ts; tsc zgłosi też tokens.ts.'
      },
      {
        title: 'Dodaję nowy store',
        steps: [
          '1. Tworzę src/stores/<grupa>/<nazwa>.ts; grupa według tematu (ui, workflow, project, navigation …).',
          '2. const store = createStore<State>(initial); export const myStore = { ...storeBase(store), nazwaneAkcje } (create-store.ts:14 i 66).',
          '3. Nie eksportuję surowego set: gate 5 liczy „set: store.set” w stores/. Zapis dla jednego dispatchera idzie przez _myInternal = { set }.',
          '4. Gdy store czyta dysk przy starcie, I/O kładę obok store, a wywołanie dodaję w src/cli/bootstrap/project.ts (loadProjectState).',
          '5. Store może importować engine tylko przez import type (gate 9 i 19).',
          '6. W testach woła się myStore.reset() w beforeEach.'
        ],
        outcome: 'Komponenty czytają store.use(selector), kod poza React store.get(); engine nadal nie wie o store.'
      },
      {
        title: 'Dodaję backend plannera / implementera istniejącego kind',
        steps: [
          '1. Wybieram jeden z RUNNER_KINDS (core/schemas/enums.ts:250): cli, api, shell, agent. Piątego kind nie dodaję.',
          '2. Tworzę src/engine/planners/<nazwa>.ts implementujący Planner (planners/types.ts:120), najlepiej przez createPlannerBase (base.ts:93).',
          '3. Tworzę src/engine/implementers/<nazwa>.ts implementujący Implementer (implementers/types.ts:179), przez createImplementerBase (pipeline/run.ts:179).',
          '4. Dopisuję warianty configu w core/schemas/planner-config.ts i implementer-config.ts.',
          '5. W src/engine/runners/factory.ts dodaję leniwy loader (lazy(() => import(…))) i case w loadPlanner oraz createImplementer.',
          '6. Deklaruję capabilities; orchestrator czyta flagi, nie tożsamość backendu. Wynik normalizuję przez engine/calls/*.'
        ],
        outcome: 'Fabryka dalej kończy się assertNever(kind); seat reviewera dostaje nowy backend automatycznie, bo createReviewer używa loadPlanner.'
      },
      {
        title: 'Dodaję adapter nowego narzędzia CLI',
        steps: [
          '1. Deskryptor CliToolDescriptor w src/core/runners/cli-tool-catalog.ts: id, nazwa, role, polityka modelu i auth, postawa sandboxa, asOf.',
          '2. Adapter w src/engine/runners/cli-tools/<narzędzie>.ts spełniający CliPlannerAdapter / CliImplementerAdapter (cli-tools/contract.ts:368, 380): argv, transport promptu, probe.',
          '3. Gdy narzędzie ma własny format wyjścia, parser w src/engine/streaming/parse-<narzędzie>.ts.',
          '4. Stan narzędzia w prywatnym HOME: allowlista w src/engine/runners/sandbox-state-paths.ts i kanał auth w sandbox-env.ts.',
          '5. Transakcja zgodności: npx tsx scripts/cli-conformance.ts raw, potem production (i cwd dla implementera).',
          '6. Dopiero na końcu rejestracja w assemblePlannerAdapters / assembleImplementerAdapters (cli-tools/registry.ts:571, 585) i opis w docs/PLANNERS-AND-IMPLEMENTERS.md.',
          '7. Gate 29 sprawdza zgodność rejestrów z katalogiem; gate 31 zabrania gałęzi JSX po id dostawcy w UI wyboru seat-u.'
        ],
        outcome: 'Fabryka nie zmienia się: planner kind cli idzie przez planners/cli.ts, implementer przez implementers/cli.ts; UI pickera czyta katalog.'
      },
      {
        title: 'Dodaję providera API (kind api)',
        steps: [
          '1. Wpis ApiProviderDescriptor w API_PROVIDER_CATALOG (src/core/providers/api-provider-catalog.ts:122); ApiProviderId wynika z kluczy.',
          '2. Fabryka createMyProvider w src/engine/providers/<nazwa>.ts nad jedynym transportem openai-stream/.',
          '3. Rejestracja w KNOWN_PROVIDERS (src/engine/providers/registry.ts:21). Typ Record<ApiProviderId, …> sprawia, że brak fabryki to błąd tsc.',
          '4. Ceny zapasowe w core/providers/known-models.ts; reszta przez models-dev i pricing-resolver.'
        ],
        outcome: 'getProvider rozwiązuje politykę endpointu i woła fabrykę; gate 32 pilnuje jednego transportu streamu.'
      },
      {
        title: 'Dodaję nowy ekran albo overlay',
        steps: [
          '1. Wnętrze w src/features/<x>/ (components/, hooks/ dopiero od 2 plików); powierzchnia czysta (jak sessions) nie dostaje folderu.',
          '2. Płaska strona src/app/screens/<x>.tsx albo src/app/overlays/<x>.tsx; importuje features przez ../../features/<x>/….',
          '3. Nazwa w ALL_SCREENS albo id w ACTIVE_OVERLAYS (src/core/navigation/types.ts:4, 61).',
          '4. Case w renderScreen albo renderOverlay (app/router.tsx:75, 116); assertNever wymusza go przy kompilacji.',
          '5. Panel bierze szerokość z overlayRect (core/navigation/overlay-rect.ts:39); maxWidth= jest zakazane (gate 46).',
          '6. Render i krytyka przez npm run tui-shots; scenariusz w testing/visual/catalog.ts.'
        ],
        outcome: 'Router pokazuje nową stronę; strona nie importuje innych stron ani root/router/provider/layout (gate 9).'
      },
      {
        title: 'Dodaję podkomendę CLI',
        steps: [
          '1. src/cli/commands/<nazwa>.ts z registerNazwaCommand(program).',
          '2. Handler: flagi, canonicalizeProjectDir (cli/setup.ts), config, opcjonalnie initStores i renderApp albo tryb headless.',
          '3. Import i wywołanie w src/cli.ts obok ośmiu istniejących (linie 36–43).',
          '4. Opis w docs/CLI-REFERENCE.md.'
        ],
        outcome: 'cli/ może importować wszystko poniżej, także app/root.tsx dla TUI.'
      },
      {
        title: 'Błąd: features/workflow importuje komponent z features/runners',
        steps: [
          '1. Programista pisze w features/workflow/x.tsx import z ../runners/tool-row.js.',
          '2. npm run check:invariants: classify() widzi feature → feature (import-boundaries.ts:122) i gate 9 zwraca 1.',
          '3. Runner bram drukuje ✗ [9] … 1 (expected 0) FAIL i kończy z kodem 1; release-check pada.',
          '4. Naprawa: gdy komponent ma 2 konsumentów, awans do src/components/; gdy chodzi o stan, kanał przez store; gdy o kompozycję, strona w app/ składa oba feature’y.'
        ],
        outcome: 'Brak krawędzi feature → feature. depcruise tej reguły nie ma, więc tylko gate 9 ją łapie.'
      },
      {
        title: 'Błąd: moduł engine chce przeczytać store',
        steps: [
          '1. Moduł w engine/orchestrator importuje stores/workflow/lifecycle.js, żeby sprawdzić cancel.',
          '2. Gate 9 / 12c: ENGINE_FORBIDDEN_TOPLEVEL zawiera stores (import-boundaries.ts:154); gate 19: engine-below-ui.',
          '3. Naprawa: engine dostaje AbortSignal od wołającego, a dane do UI publikuje eventem na busie; rejestracje handlerów idą przez powierzchnię sinks kontekstu workflow.'
        ],
        outcome: 'Engine zostaje uruchamialny headless i pod Vitest bez Ink.'
      }
    ],
    files: [
      { path: 'src/cli.ts', role: 'Binarka: rejestracja 8 podkomend.' },
      { path: 'src/cli/commands/start/register.ts', role: 'Wejście `splitbrief start`: TUI albo headless.' },
      { path: 'src/cli/bootstrap/init.ts', role: 'Seed stores przed renderem.' },
      { path: 'src/cli/render/app.ts', role: 'renderApp: montaż Ink.' },
      { path: 'src/app/root.tsx', role: 'Korzeń kompozycji App.' },
      { path: 'src/app/router.tsx', role: 'renderScreen / renderOverlay.' },
      { path: 'src/app/command-context.ts', role: 'Porty komend runtime do engine i stores.' },
      { path: 'src/core/runtime/commands/registry.ts', role: 'Rejestr 23 komend.' },
      { path: 'src/core/navigation/types.ts', role: 'ALL_SCREENS, ACTIVE_OVERLAYS.' },
      { path: 'src/engine/orchestrator/run/workflow.ts', role: 'runWorkflow: wejście do engine.' },
      { path: 'src/engine/orchestrator/run/init-sinks.ts', role: 'attachRunSinks: jedyne miejsce subskrypcji sinków.' },
      { path: 'src/engine/events/schema.ts', role: 'Słownik EngineEvent.' },
      { path: 'src/engine/events/bus.ts', role: 'createEventBus.' },
      { path: 'src/features/workflow/tui-sink.ts', role: 'addTuiEvent: most bus → stores.' },
      { path: 'src/stores/workflow/actions/event.ts', role: 'addEvent: rozkład eventu na sub-stores.' },
      { path: 'src/stores/create-store.ts', role: 'Fabryka stores.' },
      { path: 'src/engine/runners/factory.ts', role: 'createPlanner / createReviewer / createImplementer.' },
      { path: 'src/engine/runners/cli-tools/registry.ts', role: 'Rejestr adapterów CLI.' },
      { path: 'src/core/runners/cli-tool-catalog.ts', role: 'Katalog narzędzi CLI.' },
      { path: 'src/core/providers/api-provider-catalog.ts', role: 'Katalog providerów API.' },
      { path: 'src/engine/providers/registry.ts', role: 'KNOWN_PROVIDERS.' },
      { path: 'src/core/schemas/config.ts', role: 'ConfigSchema v3.' },
      { path: 'src/core/state/machine.ts', role: 'Maszyna stanów workflow.' },
      { path: 'src/core/sessions/run-status.ts', role: 'deriveRunStatus.' },
      { path: 'scripts/import-boundaries.ts', role: 'Gate 9 / 12c: classify().' },
      { path: '.dependency-cruiser.cjs', role: 'Gate 19: reguły warstw i cykle.' },
      { path: 'scripts/invariants/gates.ts', role: 'Wszystkie 53 bramy.' },
      { path: 'scripts/check-invariants.ts', role: 'Runner bram (fail closed).' }
    ],
    gotchas: [
      'LAYERS.md i STRUCTURE.md piszą, że engine importują tylko cli, app, features/workflow i features/runners. W kodzie wartości z engine importują też components/composer (composer.tsx, home-hint.ts, completion/command/hook.ts), hooks/use-crew-display-names.ts, features/editor/plan-save.ts (checkPlan), features/palette/sources.ts i features/start-preparation. Bramy na to pozwalają (rank 4 → 3).',
      'STRUCTURE.md pisze, że features importuje tylko powłoka app/. src/cli/commands/continue/resume.ts:8 importuje features/workflow/run-history.js (hydrateRun); rank cli 5 → features 4 jest dozwolony.',
      'ARCHITECTURE.md pisze, że stores nie importują React. src/stores/create-store.ts i src/stores/use-stores.ts importują react (useSyncExternalStore). STORES.md i ARCHITECTURE.md podają ~45 linii fabryki; create-store.ts ma 71.',
      'Wyjątek SHARED_FEATURES = editor (import-boundaries.ts:113) jest martwy: żaden feature nie importuje features/editor.',
      'Regułę feature → feature pilnuje tylko import-boundaries (gate 9); dependency-cruiser jej nie ma. Regułę hooks → features pilnuje tylko dependency-cruiser; w import-boundaries hooks i features mają ten sam rank 4.',
      'import-boundaries czyta importy regexem: widzi from i import bez nazw, ale nie dynamiczny import(). Leniwe loadery w runners/factory.ts widzi tylko gate 19.',
      'Drzewo decyzji mówi „schemat Zod → core/schemas”. 44 pliki produkcyjne poza core/schemas definiują schematy Zod (np. core/discovery/detection.ts, 10 w engine/providers). Żadna brama tego nie sprawdza.',
      'EXTENDING.md §3 każe dodać case w dispatch.ts dla nowego eventu. stores/workflow/tokens.ts:142 (updateTokens) to drugi wyczerpujący switch z assertNever, więc tsc wymusi też tam case.',
      'addEvent wysyła cost_update tylko do tokensStore i kończy (event.ts:17), a po cancel odrzuca eventy, które nie są akceptowane po anulowaniu (linia 22).',
      'Id overlayu to nie nazwa pliku: 13 id (command-palette, 6 pickerów, usage-details, stop-sheet …) prowadzi do 8 stron. stop-sheet nie ma strony — router zwraca null, a menu rysuje się nad composerem.',
      'Diagram w ARCHITECTURE.md mówi o tuiSink; funkcja nazywa się addTuiEvent (features/workflow/tui-sink.ts:5), a tuiSink to tylko nazwa opcji runWorkflow.',
      'Nie wszystkie sinki leżą w engine/events/sinks: call-evidence jest w orchestrator/summary/call-evidence.ts, a hook sink w engine/hooks/sink.ts.',
      'Na poziomie folderów są krawędzie w obie strony (orchestrator ↔ snapshots 24/6, orchestrator ↔ spec 43/5, planners ↔ runners 33/8, core config ↔ schemas 63/1, state ↔ sessions 6/2). Gate 19 dopuszcza to, bo sprawdza cykle modułów, a nie folderów.',
      'router.tsx importuje type AppInteractionDeps z root.tsx, a root.tsx importuje router.tsx: cykl tylko typów, dozwolony przez viaOnly type-only.',
      'Planner claude-code omija rejestr adapterów CLI w fabryce: factory.ts:56 ładuje planners/claude-code.ts, a inne narzędzia idą przez planners/cli.ts. Rejestr i tak zawiera claudeCodePlannerAdapter (registry.ts:587).',
      'core/runtime/ nie ma żadnego pliku, tylko commands/. src/features/ też nie ma plików w korzeniu.',
      'engine ma więcej plików testów (498) niż produkcyjnych (488); orchestrator to 205 plików i ~39 tys. linii, prawie połowa engine.',
      'STRUCTURE.md każe przemyśleć plik ponad 500 linii; w src jest 65 takich plików, a największy (1533 linie) leży w lib: lib/confined-fs-atomic.ts.',
      'Biome wyłącza noNonNullAssertion i noExplicitAny; zakaz !, any i szerokiego as trzymają tylko bramy 17, 17b, 17c.',
      'Numeracja bram ma luki: runner ma 53 bramy o id do 59 (brak 7 i 36–45). Gate 12c w INVARIANTS.md opisuje components/hooks/cli, a kod zabrania też stores.',
      'core importuje pakiety, które nie są czysto domenowe: chalk (core/theme/paint.ts, resolve.ts) i fzf (core/runtime/commands/lookup.ts). lib/clipboard/image.ts wywołuje AppKit przez osascript.'
    ],
    tree: tree
  });
})();
