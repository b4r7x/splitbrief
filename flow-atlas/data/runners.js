window.ATLAS = window.ATLAS || [];
window.ATLAS.push({
  id: 'runners',
  order: 2,
  title: 'Runnery, seaty i wywołania narzędzi',
  tagline: 'Jak SPLITBRIEF buduje trzy seaty, uruchamia jedno wywołanie narzędzia, czyta jego wynik i klasyfikuje awarię (limit, wylogowanie, sieć).',
  summary: `Runner to backend jednego seatu. Są cztery rodzaje ('kind'): 'cli' (znane narzędzie jako proces), 'api' (endpoint zgodny z OpenAI), 'shell' (dowolne polecenie stdin → stdout) i 'agent' (polecenie, które samo pisze pliki). Fabryka w 'src/engine/runners/factory.ts' buduje trzy seaty: PLAN (createPlanner), BUILD (createImplementer) i REVIEW (createReviewer). Seat REVIEW bez bloku 'reviewer' w konfiguracji to ten sam runner co PLAN.

Jedno wywołanie CLI przechodzi zawsze tą samą drogą: środowisko sandbox dla dziecka, bramka startowa (receipt binarki), budowa argv przez adapter narzędzia, 'invokeCliAdapter' → 'invokeProcessCli', spawn, parsowanie linii, zdarzenie terminalne, 'RunnerCallResult'. Każda awaria dostaje kod ('code') i status ('failed', 'timeout', 'aborted', ...).

Wykrycie limitu lub wylogowania to czysta analiza tekstu. Trzy warstwy czytają słowa narzędzia: frazy haltu ('HALT_SIGNATURES') w ogonie stderr i w ostatniej linii stdout, klasyfikator 'classifySeatFailure' (konto → rate-limited → transient → other) i parser zegara resetu 'parseUsageLimitReset'. Wynik tej klasyfikacji trafia do obszaru recovery jako halt 'Seat down' albo do pętli oczekiwania na reset.

Tokeny i koszt: każde wywołanie zapisuje 'runner_call_usage' do 'session.jsonl'; księga runu ('state.tokenUsage') ma cztery kategorie (planner, implementer, escalation, reviewer); 'reconcileTokenUsage' uzgadnia księgę z logiem; '/usage' czyta księgę na żywo lub podsumowanie zamkniętego runu. Narzędzie CLI jest zawsze 'unpriced': dolary liczy się tylko dla runnera 'api'.`,
  entry: [
    'src/engine/runners/factory.ts:91',
    'src/engine/runners/factory.ts:133',
    'src/engine/runners/factory.ts:175',
    'src/engine/runners/invoke-cli-adapter.ts:134',
    'src/engine/runners/seat-failure.ts:175',
  ],
  links: [
    { to: 'startup', label: 'prepareExecution dostarcza preparedConfig i gates, które fabryka wymaga' },
    { to: 'planning', label: 'planner.typedCall → requestTyped prowadzi sesję planowania' },
    { to: 'build', label: 'implementer.implement/retry wykonuje brief; runSeatCall otacza każde wywołanie BUILD' },
    { to: 'review', label: 'createReviewer buduje seat REVIEW; runReviewerCall wysyła przez typedCall' },
    { to: 'recovery', label: 'SeatFailureClassification + RunnerOutcome → buildSeatDownIssue / planner-call-failed (Seat down)' },
    { to: 'lifecycle', label: 'state.seatWait, seatSwitches i runner_call_* w session.jsonl' },
    { to: 'ui', label: '/usage, Settings › Crew/Fallback i picker czytają deriveCrewSeats, deriveFallbackRows, seatAxisWords' },
    { to: 'subsystems', label: 'EventBus przenosi runner_call_* i cost_update; rejestr procesów w lib/process' },
  ],
  diagrams: [
    {
      id: 'rn-kind-dispatch',
      title: 'Fabryka: od bloku konfiguracji do backendu',
      caption: 'Każdy seat przechodzi przez requireFactoryAuthority (ta sama zamrożona konfiguracja co w prepareExecution), potem przez sprawdzenie, czy to skonfigurowany runner własny (shell/agent z trust), a dopiero potem przez switch po kind. Claude Code jako planner ma własny backend; inne CLI idą przez wspólny createCliPlanner.',
      mermaid: `flowchart TD
  A["createPlanner / createReviewer / createImplementer"] --> RN_FACTORY_AUTHORITY{"options.preparedConfig === config<br/>i slot pasuje do roli?"}
  RN_FACTORY_AUTHORITY -->|"nie"| A1["throw runner-gate-mismatch"]
  RN_FACTORY_AUTHORITY -->|"tak"| B["createReviewer: runner = resolveReviewerRunner(config).runner"]
  B --> RN_CONFIGURED_CUSTOM{"resolveConfiguredCustomRunner<br/>zwraca definicję?"}
  RN_CONFIGURED_CUSTOM -->|"tak"| C["resolveConfiguredCustomGate<br/>(bramka shell/agent + customRuntime)"]
  C --> C1["createConfiguredCustomPlanner /<br/>createConfiguredCustomImplementer"]
  RN_CONFIGURED_CUSTOM -->|"nie"| D["admitPlannerBackend (PLAN/REVIEW)<br/>lub assertCliImplementerTool (BUILD)"]
  D --> RN_ARG_PREFLIGHT{"configured args zawierają<br/>flagę z kategorii authority?"}
  RN_ARG_PREFLIGHT -->|"tak"| D1["throw planner-configured-args-rejected"]
  RN_ARG_PREFLIGHT -->|"nie"| E["runnerGateFor(gates, expectation)<br/>→ trustedCli dla kind cli"]
  E --> RN_PLANNER_KIND{"kind?"}
  RN_PLANNER_KIND -->|"BUILD"| RN_IMPLEMENTER_KIND{"implementer.kind?<br/>cli/agent piszą pliki,<br/>api/shell zwracają tekst"}
  RN_IMPLEMENTER_KIND -->|"cli"| F2
  RN_IMPLEMENTER_KIND -->|"api / shell / agent"| F3
  RN_PLANNER_KIND -->|"cli"| RN_CLAUDE_SPECIAL{"tool === claude-code<br/>(tylko PLAN/REVIEW)?"}
  RN_CLAUDE_SPECIAL -->|"tak"| F1["createClaudeCodePlanner<br/>CONVERSATIONAL_CAPS"]
  RN_CLAUDE_SPECIAL -->|"nie"| F2["createCliPlanner / createCliImplementer<br/>adapter z registry"]
  RN_PLANNER_KIND -->|"api"| F3["createApiPlanner / createApiImplementer<br/>ONE_SHOT_API_CAPS"]
  RN_PLANNER_KIND -->|"shell"| F4["createShellPlanner / createShellImplementer"]
  RN_PLANNER_KIND -->|"agent"| F5["createAgentPlanner / createAgentImplementer"]
  F1 --> RN_DROPPED_FIELDS{"effort / variant / temperature<br/>dostarczalne przez backend?"}
  F2 --> RN_DROPPED_FIELDS
  F3 --> RN_DROPPED_FIELDS
  F4 --> RN_DROPPED_FIELDS
  F5 --> RN_DROPPED_FIELDS
  RN_DROPPED_FIELDS -->|"nie"| G1["warnStderr: setting is not used"]
  RN_DROPPED_FIELDS -->|"tak"| G2["Planner / Reviewer / Implementer gotowy"]`,
    },
    {
      id: 'rn-seat-resolution',
      title: 'Trzy seaty: kto trzyma PLAN, BUILD, REVIEW i ich fallback',
      caption: 'REVIEW bez bloku reviewer to runner PLAN (source: planner). BUILD to profil domyślny z implementerProfiles albo blok implementer. Fallback seatu czyta się z aktywnego runnera tej roli, więc REVIEW odziedziczony bierze planner.fallback.',
      mermaid: `flowchart TD
  Z["Brak config.yaml"] --> RN_DEFAULT_CREW{"selectDefaultCrew:<br/>ready claude-code/codex na PLAN?<br/>Ollama lub ready opencode/codex/claude na BUILD?"}
  RN_DEFAULT_CREW -->|"tak"| A["Config (version 3)"]
  RN_DEFAULT_CREW -->|"nie"| Z1["null → Setup (startup)"]
  A --> P["PLAN = config.planner"]
  A --> RN_IMPL_PROFILE{"implementerProfiles<br/>zdefiniowane?"}
  RN_IMPL_PROFILE -->|"nie"| B1["BUILD = config.implementer"]
  RN_IMPL_PROFILE -->|"tak"| B2["BUILD = profiles[default]<br/>(default lub pierwszy po sortowaniu)"]
  A --> RN_REVIEWER_SOURCE{"config.reviewer<br/>istnieje?"}
  RN_REVIEWER_SOURCE -->|"tak"| R1["REVIEW = config.reviewer<br/>source: configured, własna linia kosztu"]
  RN_REVIEWER_SOURCE -->|"nie"| R2["REVIEW = config.planner<br/>source: planner, ten sam obiekt Planner"]
  P --> RN_FALLBACK_SOURCE{"readActiveRunner(role).fallback<br/>zadeklarowany?"}
  B1 --> RN_FALLBACK_SOURCE
  B2 --> RN_FALLBACK_SOURCE
  R1 --> RN_FALLBACK_SOURCE
  R2 --> RN_FALLBACK_SOURCE
  RN_FALLBACK_SOURCE -->|"nie"| F0["none · pause and ask"]
  RN_FALLBACK_SOURCE -->|"tak"| RN_FALLBACK_BLOCKED{"fallbackBlockedReason:<br/>same as the seat / not installed /<br/>needs sign-in / stan readiness?"}
  RN_FALLBACK_BLOCKED -->|"powód"| F1["wiersz Fallback z notą;<br/>halt nie zaoferuje przełączenia"]
  RN_FALLBACK_BLOCKED -->|"brak powodu"| F2["fallback gotowy do switch-seat"]
  A --> RN_CANDIDATES{"purpose przygotowania?"}
  RN_CANDIDATES -->|"review"| C1["kandydat: tylko seat REVIEW"]
  RN_CANDIDATES -->|"spec"| C2["kandydat: tylko PLAN"]
  RN_CANDIDATES -->|"new-workflow / resume"| C3["PLAN + każdy profil BUILD<br/>+ REVIEW tylko gdy configured"]
  C3 --> D["evaluateCandidate → gate per slot<br/>(cli / api / shell / agent)"]
  D --> RN_MODEL_AUTO{"cli: model omitted lub auto?"}
  RN_MODEL_AUTO -->|"tak, plik narzędzia czytelny"| E1["gate.effectiveModel = wybór hosta;<br/>prepared config dostaje --model"]
  RN_MODEL_AUTO -->|"tak, brak pliku"| E2["warning host_model_selection_unreadable;<br/>bez --model, narzędzie wybiera"]
  RN_MODEL_AUTO -->|"nie"| E3["--model z konfiguracji"]`,
    },
    {
      id: 'rn-cli-call',
      title: 'Jedno wywołanie CLI od promptu do RunnerCallResult',
      caption: 'Kolejność jest stała: środowisko sandbox, bramka binarki, argv adaptera, walidacja argumentów, transport promptu, ponowna walidacja binarki tuż przed spawn, parsowanie linii, zdarzenie terminalne. Rejestrator (recorder) emituje runner_call_* na EventBus.',
      mermaid: `sequenceDiagram
  participant S as Seat (createCliPlanner / createCliImplementer)
  participant E as createRunnerSandboxEnv
  participant G as assertCliStartGate
  participant AD as adapter (claude-code / codex / ...)
  participant I as invokeCliAdapter
  participant P as invokeProcessCli
  participant SP as spawnPipe + registry
  participant R as RunnerCallRecorder
  S->>E: env dla (projectDir, runner, role)
  E-->>S: HOME/TMP/XDG sandbox, klucze kanału auth
  S->>G: resolveCliExecutableAliases(trust: gate)
  G-->>S: executable receipt (lub cli-executable-identity-drift)
  S->>AD: baseArgs({model, effort, variant, sessionId, schema, skillRoots})
  AD-->>S: argv adaptera, args = baseArgs + configuredArgs
  S->>I: invocation {executable, args, env, cwd, timeoutMs, signal}
  I->>P: adapter + context (idle warn/kill, toolUseGuard)
  P->>P: validateArgs (argument-conflict?)
  P->>P: steering.open gdy wersja wspiera (claude >= 2.1.296, opencode >= 2.0.0)
  P->>P: preparePrompt: stdin | argv | file 0600
  P->>P: revalidateCliExecutableIdentity
  P->>SP: spawn(executable, args, env, detached, stdin)
  SP-->>P: onStdout → lineBuffer → adapter.parse(line)
  P->>R: text / usage / session / tool-use / warning
  R-->>S: onCallEvent(runner_call_*), onSessionId (w trakcie strumienia)
  SP-->>P: onClose(exitCode, signal, stderr)
  P->>AD: terminal({events, stderr, exitCode, signal})
  AD-->>P: result completed | failed(code, message)
  P->>R: finishCompleted(usage, nativeSessionId) lub finishFailed(status, error)
  R-->>I: RunnerCallResult
  I-->>S: result z redakcją ścieżki binarki i sekretów`,
    },
    {
      id: 'rn-cli-prelaunch',
      title: 'Przed spawn: model, effort, sesja, argv, prompt, binarka; po spawn: efekt',
      caption: 'To decyzje, które budują argv jednego wywołania CLI i sprawdzają je przed uruchomieniem. Każda odmowa tutaj kończy wywołanie bez procesu. Po zakończeniu implementer CLI sprawdza jeszcze, czy coś zmienił.',
      mermaid: `flowchart TD
  A["seat CLI: runOnce / invoke"] --> RN_SESSION_RESUME{"adapter.supportsSessionResume<br/>i accessMode planning<br/>i zapisane id?"}
  RN_SESSION_RESUME -->|"tak"| S1["--resume <id> (claude) / exec resume <id> (codex)"]
  RN_SESSION_RESUME -->|"nie"| S2["świeże wywołanie; codex one-shot --ephemeral"]
  S1 --> M["model = resolveCliModel(config.model, tool)<br/>auto → brak --model, chyba że prepared config ma wybór hosta"]
  S2 --> M
  M --> RN_EFFORT_CHANNEL{"effortChannel narzędzia?"}
  RN_EFFORT_CHANNEL -->|"effort-flag"| E1["--effort <level> lub -c model_reasoning_effort=<level>"]
  RN_EFFORT_CHANNEL -->|"variant"| RN_OPENCODE_VARIANT{"opencode >= 2.0.0?"}
  RN_OPENCODE_VARIANT -->|"tak"| E2["--model provider/model#variant"]
  RN_OPENCODE_VARIANT -->|"nie / kilo"| E3["--variant <name>"]
  RN_EFFORT_CHANNEL -->|"model-id"| E4["tylko --model <id-z-effortem>"]
  RN_EFFORT_CHANNEL -->|"none"| E5["nic"]
  E1 --> B["args = [...adapter.baseArgs, ...config.args]"]
  E2 --> B
  E3 --> B
  E4 --> B
  E5 --> B
  B --> RN_ARG_CONFLICT{"validateArgs: końcówka użytkownika<br/>koliduje z authority adaptera?"}
  RN_ARG_CONFLICT -->|"tak"| C1["failed: argument-conflict"]
  RN_ARG_CONFLICT -->|"nie"| RN_STEERING{"steering port i wersja<br/>wspiera transport?"}
  RN_STEERING -->|"claude >= 2.1.296"| T1["--input-format stream-json, prompt jako JSON line"]
  RN_STEERING -->|"opencode >= 2.0.0"| T2["sidecar serve + run --server"]
  RN_STEERING -->|"nie"| T3["argv i prompt bez zmian"]
  T1 --> RN_PROMPT_TRANSPORT{"promptTransport.kind?"}
  T2 --> RN_PROMPT_TRANSPORT
  T3 --> RN_PROMPT_TRANSPORT
  RN_PROMPT_TRANSPORT -->|"stdin"| P1["prompt na stdin"]
  RN_PROMPT_TRANSPORT -->|"argv, za duży lub zaczyna się od -"| P2["prompt-transport-error"]
  RN_PROMPT_TRANSPORT -->|"argv OK"| P3["sentinel <PROMPT> zastąpiony"]
  RN_PROMPT_TRANSPORT -->|"file"| P4["prompt.txt 0600"]
  P1 --> RN_EXE_REVALIDATE{"receipt binarki nadal pasuje?"}
  P3 --> RN_EXE_REVALIDATE
  P4 --> RN_EXE_REVALIDATE
  RN_EXE_REVALIDATE -->|"missing"| X1["spawn-not-found"]
  RN_EXE_REVALIDATE -->|"changed"| X2["cli-executable-identity-drift"]
  RN_EXE_REVALIDATE -->|"match"| X3["spawnPipe → rn-cli-outcome"]
  X3 --> RN_DECLARED_EFFECT{"implementer completed:<br/>pliki zmienione?"}
  RN_DECLARED_EFFECT -->|"nie, stderr ma limit"| D1["failed usage-limit"]
  RN_DECLARED_EFFECT -->|"nie, allowNoChange"| D2["completed"]
  RN_DECLARED_EFFECT -->|"nie"| D3["failed no-staged-change"]
  RN_DECLARED_EFFECT -->|"tak, poza deklarowanym zbiorem (reject)"| D4["failed implementer-effect-invalid"]
  RN_DECLARED_EFFECT -->|"tak"| D5["completed → walidacja (build)"]`,
    },
    {
      id: 'rn-cli-outcome',
      title: 'Po zamknięciu procesu: który kod awarii i dlaczego',
      caption: 'Frazy haltu w stderr i w ostatniej linii stdout wygrywają nad gołym kodem wyjścia. Narzędzie z kontraktem structured-terminal bez wyniku terminalnego kończy jako protocol-failure (status incomplete). Kontrakt text-exit zachowuje odpowiedź przy niezerowym wyjściu, gdy ostatnie zdarzenie to tekst asystenta.',
      mermaid: `flowchart TD
  A["spawnPipe zwraca {exitCode, signal, stderr}"] --> G0{"toolUseGuard zgłosił<br/>naruszenie izolacji?"}
  G0 -->|"tak"| G1["failed: kod z guardu<br/>(implementer-left-isolation)"]
  G0 -->|"nie"| RN_CLOSE_SIGNAL{"closed.signal !== null?"}
  RN_CLOSE_SIGNAL -->|"tak"| S1["haltFailure(haltLines) ??<br/>signal-exit"]
  RN_CLOSE_SIGNAL -->|"nie"| RN_NO_TERMINAL{"structured-terminal<br/>i brak result?"}
  RN_NO_TERMINAL -->|"exit != 0"| N1["haltFailure(haltLines) ??<br/>non-zero-exit"]
  RN_NO_TERMINAL -->|"exit 0, stderr ma halt"| N2["kod haltu ze stderr"]
  RN_NO_TERMINAL -->|"exit 0, bez haltu"| N3["incomplete: protocol-failure<br/>CLI ended without its required terminal result"]
  RN_NO_TERMINAL -->|"jest result / text-exit"| T["adapter.terminal(...)"]
  T -->|"throw"| T0["failed: protocol-failure<br/>terminal result was invalid"]
  T --> RN_FAILURE_EXIT{"isFailureExit(exit)<br/>i terminal.completed?"}
  RN_FAILURE_EXIT -->|"tak, halt w ogonie"| F1["kod haltu"]
  RN_FAILURE_EXIT -->|"tak, text-exit, ostatni event = tekst"| F2["warning non_zero_exit_after_answer;<br/>odpowiedź zachowana"]
  RN_FAILURE_EXIT -->|"tak, inaczej"| F3["failed: non-zero-exit"]
  RN_FAILURE_EXIT -->|"nie"| C{"terminal.status === completed?"}
  C -->|"tak"| C1["finishCompleted(usage, nativeSessionId, structured)"]
  C -->|"nie"| RN_TERMINAL_FAILED_HALT{"terminal.error sam nazywa halt<br/>(namesHalt)?"}
  RN_TERMINAL_FAILED_HALT -->|"nie, stderr ma halt"| H1["kod haltu ze stderr, status failed"]
  RN_TERMINAL_FAILED_HALT -->|"tak lub stderr czysty"| RN_HALT_SIGNATURE{"classifyHaltSignature(message)<br/>= input-too-large / missing-model?"}
  RN_HALT_SIGNATURE -->|"tak"| H2["error.code := input-too-large / missing-model"]
  RN_HALT_SIGNATURE -->|"nie"| H3["finishFailed(terminal.status, terminal.error)<br/>np. runner_result_error, codex-turn-failed"]
  A -.->|"wyjątek w trakcie"| RN_CATCH_ARM{"ramię catch"}
  RN_CATCH_ARM -->|"signal.aborted, TimeoutError"| X1["status timeout, code timeout"]
  RN_CATCH_ARM -->|"signal.aborted, inne"| X2["status aborted, runner_interrupted"]
  RN_CATCH_ARM -->|"idle kill"| X3["no-progress-cut"]
  RN_CATCH_ARM -->|"stdin incomplete"| X4["haltFailure(haltLines) ??<br/>prompt-transport-error"]
  RN_CATCH_ARM -->|"ENOENT"| X5["spawn-not-found"]
  RN_CATCH_ARM -->|"output > 64 MB"| X6["truncated: output-budget-breach"]`,
    },
    {
      id: 'rn-failure-classification',
      title: 'Klasyfikacja awarii seatu i przekazanie do recovery',
      caption: 'Jeden klasyfikator dla każdego kind. Kolejność: authoritative → account → rate-limited → transient → other. Konto wygrywa nad 429 w tym samym tekście. Limit z parsowalnym resetem to rate-limited: krótki reset czeka w miejscu, długi przechodzi do haltu Seat down.',
      mermaid: `flowchart TD
  A["Awaria wywołania: message, code, status, providerType, outcome, source"] --> RN_CLASSIFY_AUTHORITATIVE{"outcome lub code w<br/>AUTHORITATIVE_OUTCOMES?"}
  RN_CLASSIFY_AUTHORITATIVE -->|"tak"| A1["class: authoritative<br/>(user-abort, input-too-large, missing-model,<br/>no-progress-cut, left-isolation, ...)"]
  RN_CLASSIFY_AUTHORITATIVE -->|"nie"| RN_ACCOUNT_CAUSE{"accountCause:<br/>402? 401/403? fraza auth?<br/>ACCOUNT_PHRASES? exhaustion bez resetu?<br/>status 429 / provider.quota?"}
  RN_ACCOUNT_CAUSE -->|"balance / billing / quota / auth"| A2["class: account, cause"]
  RN_ACCOUNT_CAUSE -->|"nie"| RN_RATE_LIMITED_RESET{"sygnał 429 lub exhaustion<br/>i parseUsageLimitReset != null?"}
  RN_RATE_LIMITED_RESET -->|"tak"| RN_RESET_PARSE{"parseUsageLimitReset:<br/>epoch | try again at | retry-after |<br/>Resets in 2h6m | resets Mon 3pm (zone)"}
  RN_RESET_PARSE --> A3["class: rate-limited, resetAt"]
  RN_RATE_LIMITED_RESET -->|"nie"| RN_TRANSIENT{"isTransient: offline / ECONNRESET /<br/>5xx / 408 / 429 bez resetu<br/>i outcome w {non-zero-exit, protocol-failure, usage-limit}?"}
  RN_TRANSIENT -->|"tak"| A4["class: transient"]
  RN_TRANSIENT -->|"nie"| A5["class: other"]
  A2 --> RN_CALL_OUTCOME{"runnerCallOutcome:<br/>account auth → unauthenticated<br/>account inne / rate-limited → usage-limit"}
  A3 --> RN_CALL_OUTCOME
  A4 --> RN_SEAT_RETRY{"withSeatRetry: attempt <= 3?"}
  RN_SEAT_RETRY -->|"tak"| R1["backoff 2s / 4s / 8s,<br/>publishSeatRetry, powtórz to samo wywołanie"]
  RN_SEAT_RETRY -->|"nie"| R2["zwróć ostatnią awarię jak jest"]
  A3 --> RN_SEAT_WAIT{"BUILD: reset w przyszłości<br/>i <= 10 min (rateLimitResetWaitMs)?"}
  RN_SEAT_WAIT -->|"tak"| W1["SET_SEAT_WAIT, publishSeatWaitStarted,<br/>czekaj, CLEAR_SEAT_WAIT, powtórz wywołanie"]
  RN_SEAT_WAIT -->|"nie"| RN_SEAT_DOWN_HALT["buildSeatDownIssue:<br/>reason runner-usage-limit lub runner-unauthenticated,<br/>resetAt, switch-seat gdy fallback, retry-later gdy resetAt<br/>→ zobacz recovery"]
  A2 --> RN_SEAT_DOWN_HALT
  A1 --> O1["BUILD: brak retry; defekt runnera → recoveryBuilderForRunnerOutcome<br/>PLAN/REVIEW: planner-call-failed z diagnozą"]
  A5 --> O2["BUILD: zwykła drabina retry/konsult (build)<br/>PLAN: planner-call-failed call-failed<br/>REVIEW: review-failed (Needs you)"]
  RN_SEAT_DOWN_HALT --> RN_PLANNER_CALL_DIAGNOSIS{"PLAN/REVIEW: diagnosePlannerCallFailure<br/>kod missing-model? input-too-large?<br/>klasa limit? klasa auth?"}
  RN_PLANNER_CALL_DIAGNOSIS -->|"usage-limit / unauthenticated"| D1["seatDown: classification → halt Seat down<br/>z usageLimitAdvice lub runnerLoginInstruction"]
  RN_PLANNER_CALL_DIAGNOSIS -->|"missing-model"| D2["runnerDefectRow: pick a listed model"]
  RN_PLANNER_CALL_DIAGNOSIS -->|"input-too-large"| D3["the prompt is too large; sesja natywna porzucona"]
  RN_PLANNER_CALL_DIAGNOSIS -->|"inne"| D4["call-failed"]`,
    },
    {
      id: 'rn-sandbox-env',
      title: 'Środowisko dziecka: co widzi proces narzędzia',
      caption: 'Każdy runner kind cli/shell/agent dostaje prywatny HOME, TMPDIR i XDG pod sandboxRoot(projectDir, role, tool). Kanał auth decyduje, czy dziecko dostaje kopię plików logowania, czy prawdziwy HOME/USER (keychain na macOS), czy nic. Narzędzia provider-dependent (opencode, kilo) dostają każdy *_API_KEY rodzica.',
      mermaid: `flowchart TD
  A["createRunnerSandboxEnv(projectDir, runner, role)"] --> K{"runner.kind?"}
  K -->|"api"| K0["brak procesu: HTTP w procesie SPLITBRIEF"]
  K -->|"shell / agent"| K1["hostState none; preserveEnvKeys = runner.env"]
  K -->|"cli"| RN_AUTH_CHANNEL_ADMISSION{"runner.authChannel?"}
  RN_AUTH_CHANNEL_ADMISSION -->|"omitted lub provider-dependent"| C1["host-configured: kanał domyślny narzędzia"]
  RN_AUTH_CHANNEL_ADMISSION -->|"session / api-key jawnie"| C2["admitCliAuthChannel: macierz pusta<br/>→ refused → readiness blocker<br/>(Remove auth_channel ...)"]
  C1 --> RN_ENV_KEYS{"channel.billing === provider-dependent?"}
  RN_ENV_KEYS -->|"tak"| E1["preserve: channel.env + każdy *_API_KEY z process.env"]
  RN_ENV_KEYS -->|"nie"| E2["preserve: tylko channel.env<br/>(ANTHROPIC_API_KEY, OPENAI_API_KEY, CURSOR_API_KEY,<br/>COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN)"]
  E1 --> RN_HOST_STATE{"cliAuthChannelHostStateAccess:<br/>stateBridge host-cli-state?<br/>platform w hostKeychainPlatforms?"}
  E2 --> RN_HOST_STATE
  RN_HOST_STATE -->|"none (api-key)"| H0["prywatny HOME, nic nie skopiowane"]
  RN_HOST_STATE -->|"bridged-files (Linux session)"| H1["bridgeCliState: kopia / link plików logowania<br/>do sandbox HOME"]
  RN_HOST_STATE -->|"host-account (macOS: claude-code, cursor,<br/>copilot, antigravity)"| H2["HOME i USER hosta; reszta XDG/TMP izolowana;<br/>copilot zachowuje COPILOT_HOME"]
  K1 --> S["createSanitizedChildEnv(process.env, preserveEnvKeys)<br/>+ PATH bez katalogów projektu + TMPDIR sb-hash<br/>+ npm/pip/cargo cache w sandbox"]
  H0 --> S
  H1 --> S
  H2 --> S
  S --> T["toCliEnvironment: wartości sekretów<br/>zapisane niejawnie do redakcji logów"]`,
    },
    {
      id: 'rn-api-call',
      title: 'Runner api: admisja, deadline, finish_reason i błędy HTTP',
      caption: 'Przed każdym wywołaniem admitApiCall sprawdza tożsamość endpointu i modelu oraz budżet kontekstu; odmowa nic nie wysyła. Potem jedna próba HTTP strumieniowa z trzema zegarami. Nie ma własnego retry w transporcie: 5xx, 408 i 429 bez resetu klasyfikują się jako transient i wracają przez withSeatRetry.',
      mermaid: `flowchart TD
  A["invoke (createApiPlanner / createApiImplementer)"] --> RN_API_MODEL{"resolveAutoModel(model, provider)<br/>zwraca id?"}
  RN_API_MODEL -->|"nie"| M0["throw provider-missing-model"]
  RN_API_MODEL -->|"tak"| B["resolveApiDeadlinePolicy: total = timeout ??<br/>BUILD 20 min / PLAN+REVIEW 10 min"]
  B --> RN_API_ADMISSION{"admitApiCall: tożsamość seatu zgodna?<br/>model widoczny na endpoincie?<br/>input + 15% + output reserve <= kontekst?"}
  RN_API_ADMISSION -->|"identity"| R1["refused: api-selection-identity-mismatch"]
  RN_API_ADMISSION -->|"model"| R2["refused: api-selected-model-unavailable"]
  RN_API_ADMISSION -->|"budżet, PLAN/REVIEW"| R3["refused: insufficient-context<br/>(halt planner-call-failed, zobacz planning)"]
  RN_API_ADMISSION -->|"budżet, BUILD"| R4["refused: api-context-budget-insufficient"]
  RN_API_ADMISSION -->|"admitted"| C["dispatchStreamCompletion<br/>max_tokens z pomiaru, bez temperature"]
  C --> RN_API_RESPONSE_FORMAT{"typed call i endpoint odrzuca<br/>response_format HTTP 400<br/>z detail zawierającym response_format?"}
  RN_API_RESPONSE_FORMAT -->|"tak"| F1["drugie wysłanie: prompt + fallbackInstruction,<br/>nowy callId"]
  RN_API_RESPONSE_FORMAT -->|"nie"| RN_API_DEADLINES{"runWithApiDeadlines:<br/>pierwszy chunk w 120 s?<br/>przerwa między chunkami < 60 s?<br/>całość < total?"}
  RN_API_DEADLINES -->|"nie"| D1["api_first_response_timeout /<br/>api_stream_idle_timeout / api_total_timeout"]
  RN_API_DEADLINES -->|"tak"| RN_API_FINISH{"finish_reason?"}
  RN_API_FINISH -->|"stop"| G1["completed + usage"]
  RN_API_FINISH -->|"length"| G2["truncated: openai_finish_reason_length"]
  RN_API_FINISH -->|"content_filter"| G3["refused: openai_finish_reason_content_filter"]
  RN_API_FINISH -->|"tool_calls / function_call"| G4["unsupported_tool"]
  RN_API_FINISH -->|"inny"| G5["failed: openai_unknown_finish_reason"]
  C -.->|"wyjątek"| RN_API_HTTP_ERROR{"throwMappedError:<br/>connection refused w łańcuchu?<br/>status >= 400?"}
  RN_API_HTTP_ERROR -->|"refused"| H1["stream-connection-refused → transient"]
  RN_API_HTTP_ERROR -->|"429"| H2["stream-http-status 429, detail + (retry-after: Ns)<br/>→ rate-limited gdy reset parsowalny, inaczej transient"]
  RN_API_HTTP_ERROR -->|"401/403/402"| H3["account auth / balance"]
  RN_API_HTTP_ERROR -->|"5xx / 408"| H4["transient → withSeatRetry"]
  RN_API_HTTP_ERROR -->|"inne 4xx"| H5["other"]`,
    },
    {
      id: 'rn-token-flow',
      title: 'Tokeny: od rekordu narzędzia do /usage i ceny',
      caption: 'Narzędzie raportuje usage w swoim protokole; normalizacja rozdziela cache i reasoning (Codex liczy cached_input_tokens w input, więc jest odejmowany). Rola wywołania wybiera kategorię księgi. Log sesji ma każde wywołanie, księga tylko ścieżkę sukcesu, dlatego podsumowanie i /usage uzgadniają obie.',
      mermaid: `flowchart TD
  A["Rekord usage narzędzia<br/>(claude result, codex turn.completed, OpenAI usage)"] --> RN_USAGE_NORMALIZE{"normalizeParsedUsage:<br/>input_tokens + cached_input_tokens (Codex)?<br/>prompt_tokens + details (OpenAI)?<br/>camelCase własny kontrakt?"}
  RN_USAGE_NORMALIZE --> B["RunnerCallUsage: 5 liczników disjoint<br/>+ counterCoverage + providerTotals"]
  B --> RN_USAGE_SEMANTICS{"semantics?"}
  RN_USAGE_SEMANTICS -->|"delta"| S1["dodaj do bieżącego"]
  RN_USAGE_SEMANTICS -->|"cumulative / final"| S2["zastąp bieżące"]
  S1 --> C["runner_call_usage / runner_call_completed<br/>w session.jsonl"]
  S2 --> C
  C --> RN_USAGE_CATEGORY{"usageCategoryForRunnerCallRole(role)"}
  RN_USAGE_CATEGORY -->|"planner, summary, compaction"| K1["planner*"]
  RN_USAGE_CATEGORY -->|"implementer"| K2["implementer*"]
  RN_USAGE_CATEGORY -->|"review"| K3["reviewer*"]
  RN_USAGE_CATEGORY -->|"escalation (legacy)"| K4["escalation*"]
  K1 --> D["addUsage(state, category, delta)<br/>→ state.tokenUsage, cost_update"]
  K2 --> D
  K3 --> D
  K4 --> D
  D --> RN_USAGE_NOT_REPORTED{"recordTaskUsage: delta implementer<br/>i escalation == 0 dla briefu?"}
  RN_USAGE_NOT_REPORTED -->|"tak"| W1["warning implementer_usage_not_reported;<br/>zero tokenów, nic nie wymyślone"]
  RN_USAGE_NOT_REPORTED -->|"nie"| W2["TaskTokenUsage z deltą before/after"]
  D --> RN_RECONCILE{"reconcileTokenUsage(booked, observed z logu)"}
  RN_RECONCILE -->|"implementer / escalation"| E1["max(booked, observed)"]
  RN_RECONCILE -->|"planner + reviewer"| E2["jedna pula: tylko niedobór, najpierw reviewer"]
  E1 --> RN_USAGE_VIEW_SOURCE{"/usage: route.execution?"}
  E2 --> RN_USAGE_VIEW_SOURCE
  RN_USAGE_VIEW_SOURCE -->|"at-rest"| V1["run.summary.tokenUsage i costBreakdown"]
  RN_USAGE_VIEW_SOURCE -->|"local (live)"| V2["token store + resolveCallUsageEvidence(ref)<br/>uzgodnione reconcileTokenUsage"]
  V1 --> RN_PRICING{"resolvePricing(kind, provider, model)"}
  V2 --> RN_PRICING
  RN_PRICING -->|"cli"| P1["unpriced-cli (subskrypcja)"]
  RN_PRICING -->|"shell / agent"| P2["unpriced-meta"]
  RN_PRICING -->|"api local"| P3["unpriced-local"]
  RN_PRICING -->|"api płatne"| P4["models.dev → bundled KNOWN_MODELS → unpriced-unknown"]`,
    },
    {
      id: 'rn-typed-output',
      title: 'Typowana odpowiedź seatu: transport schematu i jedna naprawa',
      caption: 'requestTyped wybiera, czy schemat JSON idzie natywną flagą narzędzia, czy zdaniem na końcu promptu. Planner i reviewer dostają jedną naprawę; implementer żadnej. Druga zła odpowiedź to seat-protocol-error (Seat down).',
      mermaid: `flowchart TD
  A["requestTyped(call, schema)"] --> RN_TYPED_TRANSPORT{"typedOutputCapability(tool, installedVersion)?"}
  RN_TYPED_TRANSPORT -->|"native (claude-code >= 2.1.287,<br/>antigravity >= 1.2.14, api)"| T1["--json-schema inline /<br/>response_format json_schema"]
  RN_TYPED_TRANSPORT -->|"strict-native (codex >= 0.157.1)"| T2{"isStrictJsonSchema(schema)?"}
  T2 -->|"tak"| T3["--output-schema plik 0600 (withSchemaFile)"]
  T2 -->|"nie"| T4["fallback: zdanie Reply with exactly one JSON object"]
  RN_TYPED_TRANSPORT -->|"fallback (opencode, copilot, kilo,<br/>cursor, command-code, shell, agent,<br/>starsza wersja)"| T4
  T1 --> L{"prompt.length > maxInputChars<br/>(codex 1 048 576)?"}
  T3 --> L
  T4 --> L
  L -->|"tak"| L1["throw input-too-large przed wysłaniem"]
  L -->|"nie"| C["call.invoke → requireCompletedCall"]
  C --> V{"checkAnswer: ostatni obiekt JSON<br/>pasuje do Zod?"}
  V -->|"tak"| V1["value + usage"]
  V -->|"nie"| RN_TYPED_REPAIR{"seat?"}
  RN_TYPED_REPAIR -->|"implementer"| R0["seat-protocol-error po 1 próbie"]
  RN_TYPED_REPAIR -->|"planner, canResume, nativeSessionId"| R1["resumeRepairPrompt na tym samym wątku"]
  RN_TYPED_REPAIR -->|"planner bez wątku / reviewer"| R2["freshRepairPrompt: pełny prompt + zła odpowiedź + błędy"]
  R1 --> V2{"druga odpowiedź pasuje?"}
  R2 --> V2
  V2 -->|"tak"| V3["value, usage = suma obu wywołań"]
  V2 -->|"nie"| V4["seat-protocol-error po 2 próbach → recovery Seat down"]`,
    },
  ],
  decisions: [
    {
      id: 'RN_FACTORY_AUTHORITY',
      title: 'Fabryka przyjmuje tylko przygotowaną konfigurację',
      question: 'Czy wywołujący ma prawo zbudować ten seat z tej konfiguracji?',
      where: 'src/engine/runners/factory-gates.ts:46',
      inputs: ['options.preparedConfig (z prepareExecution)', 'options.slot.role i profile', 'config przekazany do create*'],
      branches: [
        { if: 'options === undefined', then: 'throw runner-gate-mismatch: Runner gate does not match the prepared <role> context.', next: '' },
        { if: 'slot nie obsługuje roli (planner ≠ reviewer; implementer tylko slot implementer)', then: 'throw runner-gate-mismatch', next: '' },
        { if: 'config !== options.preparedConfig (inny obiekt, nawet o tej samej treści)', then: 'throw runner-gate-mismatch: ... exact prepared <role> configuration.', next: '' },
      ],
      default: 'Zwraca authority; fabryka idzie do resolveConfiguredCustomRunner.',
      notes: 'Porównanie jest po tożsamości obiektu (===). Konfiguracja jest zamrożona rekurencyjnie w parsePreparedConfig (src/engine/runners/prepared-execution.ts:120). Zobacz startup.',
    },
    {
      id: 'RN_CONFIGURED_CUSTOM',
      title: 'Runner własny (shell/agent z trust) czy backend wbudowany',
      question: 'Czy blok seatu wskazuje skonfigurowane polecenie własne?',
      where: 'src/engine/runners/factory.ts:96',
      inputs: ['resolveConfiguredCustomRunner(config, role)', 'options.customRuntime', 'gates'],
      branches: [
        { if: 'configured !== null i gate shell/agent z command.kind configured-custom pasuje', then: 'createConfiguredCustomPlanner / Implementer z runtime i admitted invocation', next: '' },
        { if: 'configured !== null, ale customRuntime === undefined', then: 'throw custom-runner-runtime-unavailable', next: '' },
        { if: 'configured === null', then: 'admitPlannerBackend (PLAN/REVIEW) lub assertCliImplementerTool (BUILD), potem switch po kind', next: 'RN_PLANNER_KIND' },
      ],
      default: 'Ścieżka wbudowana.',
      notes: 'Kontrakt output → kind shell, inny kontrakt → kind agent (factory-gates.ts:158).',
    },
    {
      id: 'RN_ARG_PREFLIGHT',
      title: 'Konfigurowane args nie mogą nadpisać authority adaptera',
      question: 'Czy planner.args / reviewer.args zawiera flagę z kategorii, którą SPLITBRIEF posiada?',
      where: 'src/engine/runners/factory-gates.ts:197',
      inputs: ['runner.args', 'AUTHORITY_STEMS_BY_CATEGORY (role, permission, sandbox, cwd-root, config, tools, hooks-mcp, session, prompt, output, update, approval)'],
      branches: [
        { if: 'semanticConfiguredArgViolations(args).length > 0', then: 'throw planner-configured-args-rejected z listą flag', next: '' },
        { if: 'tool nie jest w PLANNER_CLI_TOOL_IDS', then: 'throw runner-missing-tool-config', next: '' },
      ],
      default: 'runnerGateFor wybiera gate; dla cli zwraca trustedCli {tool, executable, installedVersion}.',
      notes: 'Ta sama lista stems działa w invokeProcessCli jako adapter.validateArgs (argument-conflict) na końcówce argv skonfigurowanej przez użytkownika (src/engine/runners/cli-tools/validate-args.ts:42). Implementer nie ma tego preflightu w fabryce; dostaje go przy spawn.',
    },
    {
      id: 'RN_PLANNER_KIND',
      title: 'Switch po kind dla PLAN/REVIEW',
      question: 'Jaki backend ładuje loadPlanner?',
      where: 'src/engine/runners/factory.ts:53',
      inputs: ['config.planner.kind (dla REVIEW: config z planner := reviewer runner, factory.ts:159)', 'config.planner.tool'],
      branches: [
        { if: 'kind cli i tool claude-code', then: 'createClaudeCodePlanner (planners/claude-code.ts) z CONVERSATIONAL_CAPS i injectUserTurn', next: 'RN_CLAUDE_SPECIAL' },
        { if: 'kind cli, inny tool', then: 'createCliPlanner (planners/cli.ts): adapter z lookupCliPlannerAdapter, ONE_SHOT_API_CAPS + supportsSessionResume/supportsEffort adaptera', next: '' },
        { if: 'kind api', then: 'createApiPlanner(config, seat) — ONE_SHOT_API_CAPS, consumesPriorMessages, resolvePlanningContext (pakiet dowodowy)', next: 'RN_API_MODEL' },
        { if: 'kind shell', then: 'createShellPlanner', next: '' },
        { if: 'kind agent', then: 'createAgentPlanner', next: '' },
      ],
      default: 'assertNever — każdy kind jest obsłużony.',
      notes: 'Moduły ładują się leniwie (lazy()), więc kind api nigdy nie importuje adapterów CLI.',
    },
    {
      id: 'RN_CLAUDE_SPECIAL',
      title: 'Claude Code jako planner: własny backend z sesją',
      question: 'Jak Claude Code prowadzi wątek planowania i co robi, gdy sesja wygasła?',
      where: 'src/engine/planners/claude-code.ts:97',
      inputs: ['session.getResumeId()', 'zdarzenie call_session_id w strumieniu', 'komunikat błędu vs SESSION_EXPIRED_PATTERNS'],
      branches: [
        { if: 'resumeId istnieje i strumień zgłasza inne id', then: 'sessionResumeMismatchError (callbacki buforowane do potwierdzenia)', next: '' },
        { if: 'resume potwierdzony i potem błąd wygaśnięcia', then: 'throw session-resume-failed: continue this step to retry', next: '' },
        { if: 'błąd pasuje do SESSION_EXPIRED_PATTERNS (session not found, no conversation found with session id, ...)', then: 'session.capture(null), onSessionExpired, rethrow; następne wywołanie startuje świeży wątek', next: '' },
        { if: 'typedRunnerCallErrorCode === input-too-large', then: 'session.capture(null): wątek za długi nie jest wznawiany', next: '' },
        { if: 'invokeOneShot (review, summary)', then: 'sessionId: null — jedno wywołanie bez sesji', next: '' },
      ],
      default: 'Wynik wraca; id sesji zapisane w trakcie strumienia (onSessionId), nie po końcu wywołania.',
      notes: 'Pozostałe CLI (planners/cli.ts:225) są threaded tylko gdy adapter.supportsSessionResume i accessMode === planning — dziś codex (exec resume) i claude-code; reszta ma supportsSessionResume: false. Codex wznawia wyłącznie id, które sam zgłosił; SPLITBRIEF nigdy nie podaje własnego id sesji.',
    },
    {
      id: 'RN_DROPPED_FIELDS',
      title: 'Pola generacji, których backend nie przeniesie',
      question: 'Czy effort / variant / temperature z bloku seatu dotrą do narzędzia?',
      where: 'src/engine/runners/factory-gates.ts:240',
      inputs: ['runner.effort', 'runner.variant', 'runner.temperature', 'planner.capabilities.supportsEffort', 'CLI_TOOL_CATALOG[tool].effortChannel'],
      branches: [
        { if: 'effort ustawiony i supportsEffort === false (api, shell, agent, opencode, kilo, cursor, antigravity)', then: 'warnStderr: The <seat> effort setting is not used: <tool> has no effort channel; flaga nie idzie', next: '' },
        { if: 'variant ustawiony i effortChannel !== variant', then: 'warnStderr: ... has no variant channel', next: '' },
        { if: 'temperature ustawiona i kind !== api', then: 'warnStderr: ... takes no temperature', next: '' },
      ],
      default: 'Brak ostrzeżenia. Implementer nie przekazuje supportsEffort, więc o effort nie ostrzega nigdy.',
      notes: 'Nawet kind api nie wysyła temperature na druty (resolveOpenAICompatPolicy pomija ją) — docs/CONFIGURATION.md to potwierdza.',
    },
    {
      id: 'RN_REVIEWER_SOURCE',
      title: 'Kto trzyma seat REVIEW',
      question: 'Czy w konfiguracji jest blok reviewer?',
      where: 'src/core/config/accessors/reviewer-runner.ts:9',
      inputs: ['config.reviewer'],
      branches: [
        { if: 'config.reviewer !== undefined', then: '{ runner: config.reviewer, source: configured }; prepareExecution dodaje kandydata slot reviewer; osobna linia kosztu; własny fallback (także brak)', next: 'RN_CANDIDATES' },
        { if: 'config.reviewer === undefined', then: '{ runner: config.planner, source: planner }; ten sam obiekt Planner, bez dodatkowej admisji; koszt złożony do linii plannera; fallback = planner.fallback', next: 'RN_FALLBACK_SOURCE' },
      ],
      default: 'To jedyny moduł, który rozgałęzia się na config.reviewer.',
      notes: 'createReviewer (factory.ts:159) buduje seat na backendach plannera: podaje loadPlanner konfigurację z planner := runner reviewera. Przełączenie REVIEW przez recovery zapisuje własny blok reviewer i nie rusza planner (zobacz recovery).',
    },
    {
      id: 'RN_IMPL_PROFILE',
      title: 'Który profil BUILD staje się implementerem',
      question: 'Czy konfiguracja ma implementerProfiles i który profil nazywa slot?',
      where: 'src/engine/runners/factory-gates.ts:66',
      inputs: ['authority.slot.profile', 'resolveImplementerProfiles(config).profiles', 'config.implementerProfiles.default'],
      branches: [
        { if: 'profil o nazwie slot.profile nie istnieje', then: 'throw runner-gate-mismatch: Prepared implementer profile "<name>" is unavailable.', next: '' },
        { if: 'config.implementerProfiles === undefined', then: 'config bez zmian (blok implementer jest profilem default)', next: '' },
        { if: 'profil istnieje', then: 'config z implementer := profile.config i implementerProfiles.default := profile.name', next: 'RN_IMPLEMENTER_KIND' },
      ],
      default: 'Routing między profilami należy do build (compareProfileRouteRank).',
      notes: 'Bez pola default profilem domyślnym jest pierwszy po sortowaniu nazw (docs/CONFIGURATION.md §3).',
    },
    {
      id: 'RN_IMPLEMENTER_KIND',
      title: 'Switch po kind dla BUILD',
      question: 'Jaki backend buduje implementer i kto trzyma pióro?',
      where: 'src/engine/runners/factory.ts:198',
      inputs: ['effectiveConfig.implementer.kind', 'implementer.tool', 'gate z runnerGateFor'],
      branches: [
        { if: 'kind cli', then: 'assertCliImplementerTool, createCliImplementer(config, {trustedCli}) — writesFiles direct, zmiany mierzone detektorem', next: 'RN_DECLARED_EFFECT' },
        { if: 'kind api', then: 'createApiImplementer — extracted-code, kontrakt file-bundle-v1, retryTemperatureStep 0.1', next: 'RN_API_MODEL' },
        { if: 'kind shell', then: 'createShellImplementer — extracted-code, jeden plik', next: '' },
        { if: 'kind agent', then: 'createAgentImplementer — direct', next: '' },
      ],
      default: 'assertNever.',
    },
    {
      id: 'RN_FALLBACK_SOURCE',
      title: 'Skąd seat bierze fallback',
      question: 'Który blok dostarcza fallback dla roli?',
      where: 'src/core/crew/fallback.ts:44',
      inputs: ['readActiveRunner({config, role}).fallback', 'resolveReviewerRunner().source'],
      branches: [
        { if: 'role planner', then: 'planner.fallback', next: '' },
        { if: 'role reviewer i blok reviewer istnieje', then: 'reviewer.fallback (także undefined, gdy blok go nie ma)', next: '' },
        { if: 'role reviewer bez bloku', then: 'planner.fallback (wiersz Fallback: inherited = true, = PLAN)', next: '' },
        { if: 'role implementer', then: 'fallback profilu domyślnego', next: '' },
      ],
      default: 'undefined → none · pause and ask.',
      notes: 'Fallback to zawsze runner cli: {tool, model?, effort?, variant?} (runner-fields.ts:392). Loader waliduje go schematem cli danego seatu (validateFallback, runner-fields.ts:327) i odrzuca fallback.effort dla narzędzia kanału variant.',
    },
    {
      id: 'RN_FALLBACK_BLOCKED',
      title: 'Dlaczego halt nie zaoferuje zadeklarowanego fallbacku',
      question: 'Czy fallback jest tożsamy z seatem, zainstalowany i podpisany na swoją trasę?',
      where: 'src/core/crew/fallback.ts:71',
      inputs: ['detection.diagnostic.state narzędzia fallbacku', 'routeAuthState(tool, seatRouteModel(...), providerAuth, catalog)', 'isSeatIdentity(seat, fallback)'],
      branches: [
        { if: 'ten sam tool i (brak modelu lub ten sam rozwiązany model)', then: 'nota same as the seat', next: '' },
        { if: 'brak detekcji lub state unavailable', then: 'nota not installed', next: '' },
        { if: 'state ready/unverified i route needs-sign-in', then: 'nota needs sign-in', next: '' },
        { if: 'state unauthenticated i route configured (klucz providera w konfiguracji narzędzia)', then: 'brak noty — fallback dostępny', next: '' },
        { if: 'inny state (np. incompatible)', then: 'nota = słowo stanu', next: '' },
      ],
      default: 'Brak noty: deriveFallbackRows pokazuje identity; recovery może go użyć (loadSeatSwapContext, src/engine/orchestrator/recovery/seat-swap-context.ts:197).',
    },
    {
      id: 'RN_DEFAULT_CREW',
      title: 'Domyślna załoga przy pierwszym uruchomieniu',
      question: 'Które wykryte narzędzia stają się PLAN i BUILD, gdy nie ma konfiguracji?',
      where: 'src/core/crew/default.ts:81',
      inputs: ['detection.cliTools ze stanem ready', 'detection.providers (ollama available, modele)'],
      branches: [
        { if: 'żadne ready narzędzie nie obsługuje roli planner', then: 'null → Setup prowadzi użytkownika (startup)', next: '' },
        { if: 'PLAN', then: 'pierwszy ready z kolejności [claude-code, codex, ...CLI_TOOL_IDS]', next: '' },
        { if: 'lokalna Ollama dostępna i domyślny implementer api', then: 'BUILD = api ollama z modelem domyślnym lub pierwszym z listy', next: '' },
        { if: 'brak Ollamy', then: 'BUILD = pierwszy ready z [opencode, codex, claude-code, ...CLI_TOOL_IDS]', next: '' },
        { if: 'brak kandydata BUILD', then: 'null', next: '' },
      ],
      default: 'Config z planner cli + implementer; reviewer brak (REVIEW = PLAN).',
      notes: 'Presety załogi (presets.ts:35): Claude crew/Codex review, Codex crew/Claude review, Claude plan/OpenCode build.',
    },
    {
      id: 'RN_CANDIDATES',
      title: 'Które seaty prepareExecution admituje',
      question: 'Jaki jest cel przygotowania?',
      where: 'src/engine/runners/prepare-execution/runner-candidates.ts:74',
      inputs: ['purpose: new-workflow | resume | spec | review', 'config'],
      branches: [
        { if: 'review', then: 'tylko seat REVIEW (ten z resolveReviewerRunner)', next: '' },
        { if: 'spec', then: 'tylko PLAN', next: '' },
        { if: 'new-workflow / resume', then: 'PLAN, każdy profil BUILD, REVIEW tylko gdy source configured', next: '' },
      ],
      default: 'Każdy kandydat przechodzi evaluateCandidate (evaluate-candidate.ts:606): cli → evaluateCli, api → evaluateApi, shell/agent → evaluateCommand. Jeden blocked blokuje start. Szczegóły readiness: startup.',
      notes: 'evaluateCli odrzuca jawny authChannel session/api-key (evaluate-candidate.ts:366): macierz CLI_AUTH_ENFORCEMENT_EVIDENCE jest pusta. Przy session kanale pierwsze zaprzeczenie auth jest sprawdzane drugi raz po READINESS_RETRY_DELAY_MS (evaluate-candidate.ts:296).',
    },
    {
      id: 'RN_MODEL_AUTO',
      title: 'Co znaczy model: auto (lub brak modelu) na seacie CLI',
      question: 'Czy narzędzie ma na tym hoście czytelny plik wyboru modelu?',
      where: 'src/engine/runners/host-model-selection.ts:183',
      inputs: ['tool', 'HOME, XDG_CONFIG_HOME, XDG_STATE_HOME', 'pliki narzędzia'],
      branches: [
        { if: 'opencode / kilo-code', then: 'opencode.json(c) model, inaczej state model.json recent[0] jako provider/model', next: '' },
        { if: 'codex', then: '~/.codex/config.toml top-level model', next: '' },
        { if: 'claude-code', then: '~/.claude/settings.json model', next: '' },
        { if: 'antigravity', then: 'settings.json display name dopasowany do katalogu', next: '' },
        { if: 'cursor / copilot / command-code', then: 'null — brak pliku; warning host_model_selection_unreadable, bez --model', next: '' },
        { if: 'plik istnieje', then: 'gate.effectiveModel; prepared config dostaje model, YAML zostaje auto', next: '' },
      ],
      default: 'resolveCliModel (automatic-model.ts:51) zamienia auto na undefined, więc adapter pomija --model; claude-code traktuje też literał default jak auto.',
    },
    {
      id: 'RN_EFFORT_CHANNEL',
      title: 'Jak effort seatu dociera do narzędzia',
      question: 'Jaki jest effortChannel narzędzia?',
      where: 'src/core/runners/effort-channel.ts:97',
      inputs: ['CLI_TOOL_CATALOG[tool].effortChannel', 'runner.effort', 'runner.variant', 'runner.model'],
      branches: [
        { if: 'effort-flag: claude-code, copilot, command-code', then: '--effort <level> (claude-code.ts:94, copilot.ts:163, command-code.ts:79)', next: '' },
        { if: 'effort-flag: codex', then: '-c model_reasoning_effort=<level> (codex.ts:95); preflight długich flag go nie sprawdza', next: '' },
        { if: 'variant: kilo-code', then: '--variant <name> po --model (kilo-code.ts:105)', next: 'RN_OPENCODE_VARIANT' },
        { if: 'variant: opencode', then: 'zależy od wersji', next: 'RN_OPENCODE_VARIANT' },
        { if: 'model-id: cursor, antigravity', then: 'effort siedzi w id modelu (gemini-3.8-flash-high); tylko --model; seatAxisWords czyta końcówkę id', next: '' },
        { if: 'none: api, shell, agent', then: 'nic nie idzie; warnDroppedRunnerFields ostrzega', next: 'RN_DROPPED_FIELDS' },
      ],
      default: 'seatAxisWords (effort-channel.ts:111) daje słowa osi do identity seatu: effort → thinking → fast.',
    },
    {
      id: 'RN_OPENCODE_VARIANT',
      title: 'OpenCode: forma argv zależy od admitowanej wersji',
      question: 'Czy start gate admitował opencode >= 2.0.0?',
      where: 'src/engine/runners/cli-tools/opencode.ts:138',
      inputs: ['installedVersion z gate', 'model', 'variant'],
      branches: [
        { if: 'installedVersion >= 2.0.0', then: 'run --standalone --model <provider/model>#<variant>', next: '' },
        { if: 'installedVersion < 2.0.0 lub nieznana', then: 'run --model <provider/model> --variant <variant>', next: '' },
      ],
      default: 'Potem --format json i --agent plan (planner) lub tryb implementera; prompt jako argv.',
      notes: 'Nieznana wersja (brak gate, harness) wybiera formę starą — standalone wymaga dowodu wersji.',
    },
    {
      id: 'RN_SESSION_RESUME',
      title: 'Czy to wywołanie wznawia wątek narzędzia',
      question: 'Czy adapter wspiera resume i czy to tura planowania?',
      where: 'src/engine/planners/cli.ts:225',
      inputs: ['adapter.supportsSessionResume', 'accessMode planning | read-only', 'nativeSession.getResumeId()'],
      branches: [
        { if: 'supportsSessionResume i accessMode planning i id zapisane', then: 'threaded: codex → exec resume <id>; claude-code → --resume <id>', next: '' },
        { if: 'accessMode read-only (review, summary)', then: 'oneShot: codex dodaje --ephemeral; brak sesji', next: '' },
        { if: 'wynik zgłasza inne id niż resumeId', then: 'throw sessionResumeMismatchError', next: '' },
        { if: 'wynik failed i tekst pasuje do SESSION_EXPIRED_PATTERNS', then: 'sessionResumeExpiredError → capture(null), onSessionExpired', next: '' },
        { if: 'wynik error.code input-too-large', then: 'capture(null): następna tura na świeżym wątku', next: '' },
      ],
      default: 'Wynik wraca do createPlannerBase.',
    },
    {
      id: 'RN_ARG_CONFLICT',
      title: 'Walidacja argv przed spawn',
      question: 'Czy końcówka argv skonfigurowana przez użytkownika koliduje z kontraktem adaptera?',
      where: 'src/engine/runners/cli-tools/process-invoke.ts:223',
      inputs: ['invocation.args', 'invocation.baseArgs (prefiks adaptera)', 'adapter.validateArgs'],
      branches: [
        { if: 'validateArgs rzuca lub zwraca niepoprawny kształt', then: 'failed: callback-failure (CLI argument validation failed / returned an invalid result)', next: '' },
        { if: 'valid: false', then: 'failed: argument-conflict z listą flag; wartości niebędące flagami są [redacted argument]', next: '' },
      ],
      default: 'Dalej: steering, preparePrompt.',
    },
    {
      id: 'RN_STEERING',
      title: 'Czy wywołanie przyjmuje sterowanie w trakcie',
      question: 'Czy seat ma port sterowania i narzędzie w admitowanej wersji wspiera transport?',
      where: 'src/engine/runners/cli-tools/process-invoke.ts:329',
      inputs: ['context.steering', 'adapter.steering?.supportsVersion(installedVersion)'],
      branches: [
        { if: 'claude-code >= 2.1.296', then: 'argv + --input-format stream-json --replay-user-messages; prompt jako linia JSON; stdin otwarty do pierwszego result', next: '' },
        { if: 'opencode >= 2.0.0', then: 'sidecar opencode serve 127.0.0.1:0; POST /api/session/<id>/prompt delivery steer', next: '' },
        { if: 'codex, cursor, copilot, kilo, antigravity, command-code, api, shell, agent', then: 'brak transportu; wiadomość czeka na pas korekt po wywołaniu (build)', next: '' },
        { if: 'steeringSession.failureSignal przerwany', then: 'failed: steering-transport-error', next: '' },
      ],
      default: 'Bez portu argv i bajty promptu są identyczne jak bez sterowania.',
    },
    {
      id: 'RN_PROMPT_TRANSPORT',
      title: 'Jak prompt trafia do procesu',
      question: 'Jaki transport deklaruje adapter?',
      where: 'src/engine/runners/cli-tools/prompt-transport.ts:17',
      inputs: ['adapter.promptTransport.kind', 'argv z sentinelem <PROMPT>', 'rozmiar promptu'],
      branches: [
        { if: 'stdin (claude-code, codex)', then: 'prompt na stdin; sentinel w argv jest błędem', next: '' },
        { if: 'argv (opencode, copilot, kilo, cursor, command-code, antigravity) i bytes > maxBytes', then: 'throw prompt-transport-error: exceeds the N-byte argv limit', next: '' },
        { if: 'argv positional i prompt zaczyna się od -', then: 'throw prompt-transport-error (parser narzędzia wziąłby prompt za opcję)', next: '' },
        { if: 'file', then: 'plik prompt.txt 0600 w mkdtemp, usunięty po wywołaniu', next: '' },
        { if: 'liczba sentineli != 1', then: 'throw prompt-transport-error', next: '' },
      ],
      default: 'Błąd przed spawn ma kod prompt-transport-error (process-invoke.ts:388).',
    },
    {
      id: 'RN_EXE_REVALIDATE',
      title: 'Binarka tuż przed spawn musi być tą samą, którą admitowało readiness',
      question: 'Czy receipt (dev, ino, size, mtime) nadal pasuje do pliku na dysku?',
      where: 'src/engine/runners/cli-tools/process-invoke.ts:442',
      inputs: ['invocation.executable (receipt z gate)', 'statSync realPath'],
      branches: [
        { if: 'missing', then: 'failed: spawn-not-found', next: '' },
        { if: 'zmieniona', then: 'failed: cli-executable-identity-drift (executableChangedMessage)', next: '' },
        { if: 'match', then: 'spawnPipe', next: 'RN_CLOSE_SIGNAL' },
      ],
      default: 'Ta sama kontrola działa wcześniej w assertCliStartGate (start-gate.ts:202) przy rozwiązywaniu binarki, i w prepareExecution przy resume.',
    },
    {
      id: 'RN_CLOSE_SIGNAL',
      title: 'Proces zakończył się sygnałem',
      question: 'Czy closed.signal !== null?',
      where: 'src/engine/runners/cli-tools/process-invoke.ts:542',
      inputs: ['closed.signal', 'haltLines(): stderr + ostatnia linia stdout'],
      branches: [
        { if: 'ogon zawiera frazę haltu', then: 'kod haltu (unauthenticated / usage-limit / input-too-large / missing-model / implementer-recipe-invalid)', next: 'RN_HALT_SIGNATURE' },
        { if: 'bez frazy', then: 'failed: signal-exit, CLI exited from signal <sig>', next: '' },
      ],
      default: 'Idzie dalej do kontroli terminalu.',
      notes: 'Przerwanie przez użytkownika nie trafia tu: abort rzuca wyjątek i ląduje w ramieniu catch jako aborted/runner_interrupted.',
    },
    {
      id: 'RN_NO_TERMINAL',
      title: 'Kontrakt structured-terminal bez wyniku terminalnego',
      question: 'Narzędzie z wymaganym result nie wypisało go — co zdecyduje?',
      where: 'src/engine/runners/cli-tools/process-invoke.ts:553',
      inputs: ['adapter.outputContract.kind', 'terminalSeen', 'closed.exitCode', 'closed.stderr'],
      branches: [
        { if: 'exitCode !== 0', then: 'haltFailure(haltLines) ?? non-zero-exit', next: '' },
        { if: 'exitCode 0 i stderr ma frazę haltu', then: 'kod haltu (tylko stderr; stdout może powtarzać prozę modelu)', next: '' },
        { if: 'exitCode 0 bez frazy', then: 'status incomplete, code protocol-failure: CLI ended without its required terminal result', next: '' },
      ],
      default: 'Kontrakty: structured-terminal — claude-code, codex, cursor, command-code, antigravity; text-exit successfulExitCodes [0] — opencode, copilot, kilo-code.',
    },
    {
      id: 'RN_FAILURE_EXIT',
      title: 'Terminal mówi completed, a kod wyjścia mówi błąd',
      question: 'Czy zachować odpowiedź przy niezerowym wyjściu?',
      where: 'src/engine/runners/cli-tools/process-invoke.ts:601',
      inputs: ['isFailureExit(contract, exitCode)', 'terminal.status', 'ostatnie zdarzenie protokołu'],
      branches: [
        { if: 'ogon ma frazę haltu', then: 'kod haltu', next: '' },
        { if: 'text-exit, terminal.text niepusty, ostatni event to tekst assistant/result', then: 'warning non_zero_exit_after_answer; odpowiedź zachowana jako completed', next: '' },
        { if: 'inaczej (structured-terminal zawsze)', then: 'failed: non-zero-exit', next: '' },
      ],
      default: 'Sukces strukturalny przy błędnym wyjściu zamyka się na failed (fail closed).',
    },
    {
      id: 'RN_TERMINAL_FAILED_HALT',
      title: 'Terminal failed: czyje słowa zostają diagnozą',
      question: 'Czy terminal.error sam nazywa halt, czy stderr ma go za niego?',
      where: 'src/engine/runners/cli-tools/process-invoke.ts:651',
      inputs: ['terminal.error {code, message, status, providerType}', 'closed.stderr', 'namesHalt: HALT_CODES, haltFailure, classifySeatFailure != other'],
      branches: [
        { if: 'namesHalt(error) false i stderr ma frazę haltu', then: 'error := kod haltu ze stderr, status failed', next: '' },
        { if: 'classifyHaltSignature(error.message) = input-too-large lub missing-model', then: 'error.code := input-too-large / missing-model (Claude: Prompt is too long; OpenCode: provider.no-route)', next: '' },
        { if: 'inaczej', then: 'finishFailed(terminal.status, terminal.error) — np. runner_result_error (claude is_error), codex-turn-failed z providerType', next: 'RN_CALL_OUTCOME' },
      ],
      default: 'Słowa narzędzia idą dalej nietknięte; dopiero classifySeatFailure odczyta w nich limit lub wylogowanie.',
    },
    {
      id: 'RN_HALT_SIGNATURE',
      title: 'Frazy haltu: słowa narzędzia, które kończą drabinę',
      question: 'Czy ogon (60 ostatnich linii) zawiera frazę z HALT_SIGNATURES?',
      where: 'src/core/pipeline-spec/halts.ts:85',
      inputs: ['stderr.split(newline) + stdoutLastLine + stdoutTailCarry', 'HALT_SIGNATURES (halts.ts:15)'],
      branches: [
        { if: 'inputTooLarge: input_too_large, input exceeds the maximum length, prompt is too long', then: 'code input-too-large', next: '' },
        { if: 'auth: please run /login, log out and sign in again, 401 unauthorized, invalid api key, oauth token has expired, not logged in, authentication_error, ...', then: 'code unauthenticated', next: '' },
        { if: 'usage: usage limit, rate limit exceeded, quota exceeded, too many requests, insufficient_quota, credit balance is too low, http 429, resource_exhausted, ...', then: 'code usage-limit', next: '' },
        { if: 'missingModel: unknown model, model not found, invalid model, provider.no-route', then: 'code missing-model', next: '' },
        { if: 'spawnFailure: requires permissions, use --yolo, unknown option, unknown flag, sandbox required but unavailable, ...', then: 'code implementer-recipe-invalid', next: '' },
      ],
      default: 'null → kod wyjścia lub protokół decyduje. Kolejność grup: input-too-large, auth, usage, missing-model, spawn.',
      notes: 'Komunikat haltu to dopasowana linia narzędzia (haltFailure, process-invoke.ts:821). Frazy są celowo pełnymi zdaniami narzędzi: gołe billing lub rate limit w promptcie briefu nie mogą zrobić haltu. Transkrypt powyżej ostatniej linii stdout nie jest sprawdzany.',
    },
    {
      id: 'RN_CATCH_ARM',
      title: 'Wyjątek podczas wywołania: które ramię',
      question: 'Co przerwało invokeProcessCli?',
      where: 'src/engine/runners/cli-tools/process-invoke.ts:683',
      inputs: ['signal.reason', 'guardFailure', 'steeringSession.failureSignal', 'processError.isIdleTimeout', 'spawnPipeError.isStdinIncomplete', 'ENOENT'],
      branches: [
        { if: 'cleanupFailed lub platform-limitation', then: 'failed: steering-transport-error / kod przyczyny', next: '' },
        { if: 'callback konsumenta rzucił', then: 'failed: callback-failure', next: '' },
        { if: 'guard izolacji zgłosił naruszenie', then: 'failed: kod guardu (implementer-left-isolation)', next: '' },
        { if: 'signal.aborted i reason TimeoutError (timeout seatu)', then: 'status timeout, code timeout, <tool> timed out after <ms>', next: '' },
        { if: 'signal.aborted inny (Esc, abort runu)', then: 'status aborted, runner_interrupted: stopped by you', next: '' },
        { if: 'idle kill (idleKillMs bez bajtów)', then: 'failed: no-progress-cut, <tool> sent no output for m:ss; SPLITBRIEF stopped it', next: '' },
        { if: 'stdin pękł pod promptem', then: 'haltFailure(haltLines) ?? prompt-transport-error (narzędzie zdążyło wypisać limit lub wylogowanie)', next: '' },
        { if: 'fatal state output-budget-breach (> 64 MB)', then: 'status truncated', next: '' },
        { if: 'ENOENT', then: 'spawn-not-found', next: '' },
      ],
      default: 'runnerCallErrorFromUnknown(cause, protocol-failure).',
      notes: 'Timeout seatu CLI istnieje tylko gdy config timeout jest ustawiony (process-invoke.ts:285); domyślnie wywołanie nie ma deadline. Implementer CLI komponuje też AbortSignal.timeout(deadlineMs) i rzuca processError.timeout (implementers/cli.ts:222). Anulowanie z UI: withPerCallAbort (orchestrator/cancellable-call.ts:6) przerywa tylko bieżące wywołanie, nie workflow.',
    },
    {
      id: 'RN_DECLARED_EFFECT',
      title: 'Implementer CLI zakończył się: czy coś zmienił',
      question: 'Czy completed znaczy, że brief został wykonany?',
      where: 'src/engine/implementers/cli.ts:63',
      inputs: ['summarizeChanges(projectDir, baseline).files', 'result.warnings ze źródłem stderr', 'allowNoChange', 'undeclaredWrites reject|gate'],
      branches: [
        { if: 'brak zmian i stderr ma diagnozę limitu (stderrUsageLimit)', then: 'failed: usage-limit z tą linią (antigravity: exit 0 + Individual quota reached)', next: 'RN_CALL_OUTCOME' },
        { if: 'brak zmian i allowNoChange (fix task, kontynuacja)', then: 'completed bez zmian', next: '' },
        { if: 'brak zmian', then: 'failed: no-staged-change, <tool> exited without changing any files', next: '' },
        { if: 'zmiany poza deklarowanym zbiorem i undeclaredWrites reject', then: 'failed: implementer-effect-invalid', next: '' },
      ],
      default: 'completed; zmiany poza zbiorem przy gate idą do bramki zatwierdzeń (build).',
    },
    {
      id: 'RN_CLASSIFY_AUTHORITATIVE',
      title: 'Awaria, której żadne słowa nie zmienią',
      question: 'Czy outcome lub code jest już własnym werdyktem?',
      where: 'src/engine/runners/seat-failure.ts:177',
      inputs: ['input.outcome', 'input.code', 'AUTHORITATIVE_OUTCOMES (seat-failure.ts:36)'],
      branches: [
        { if: 'user-abort, implementer-left-isolation, checkout-changed, implementer-recipe-invalid, input-too-large, missing-model, no-progress-cut', then: 'class authoritative: brak retry, brak oczekiwania', next: '' },
      ],
      default: 'Dalej do accountCause.',
    },
    {
      id: 'RN_ACCOUNT_CAUSE',
      title: 'Odmowa konta: balance, billing, quota czy auth',
      question: 'Czy słowa narzędzia mówią, że konto nie obsłuży wywołania?',
      where: 'src/engine/runners/seat-failure.ts:135',
      inputs: ['status HTTP', 'message lowercase', 'source (result-error | thrown | stderr-tail | stdout-tail)', 'providerType'],
      branches: [
        { if: 'status 402', then: 'balance', next: '' },
        { if: 'status 401 lub 403', then: 'auth', next: '' },
        { if: 'fraza auth (HALT_SIGNATURES.auth; dla result-error/thrown także 403, unauthenticated, sign in)', then: 'auth', next: '' },
        { if: 'source nie jest ogonem i ACCOUNT_PHRASES: insufficient balance/credits, credit balance is too low, out of credits → balance; payment required, billing_hard_limit, billing_not_active, account suspended → billing', then: 'balance / billing', next: '' },
        { if: 'rateLimitedReset != null', then: 'null — limit z resetem nie jest śmiercią konta', next: 'RN_RATE_LIMITED_RESET' },
        { if: 'isExhaustion (fraza usage; w ogonie tylko HALT_SIGNATURES.usage; 429 tylko z rzeczownikiem limit/quota/too many requests/retry-after)', then: 'quota', next: '' },
        { if: 'status 429 bez znanej frazy', then: 'quota', next: '' },
        { if: 'providerType provider.quota (OpenCode 2)', then: 'quota', next: '' },
      ],
      default: 'null → dalej rate-limited / transient.',
      notes: 'Źródła ogonowe (stderr-tail, stdout-tail) dopasowują wyłącznie frazy HALT_SIGNATURES, bo stdout niesie logi testów. Claude Code Request rejected (429) bez rzeczownika to pojemność, nie wyczerpanie → retry.',
    },
    {
      id: 'RN_RATE_LIMITED_RESET',
      title: 'Limit z zegarem resetu',
      question: 'Czy tekst niesie sygnał 429/wyczerpania i parsowalny moment resetu?',
      where: 'src/engine/runners/seat-failure.ts:129',
      inputs: ['status === 429 lub 429 w tekście lub isExhaustion', 'parseUsageLimitReset(message)'],
      branches: [
        { if: 'sygnał i reset != null', then: 'class rate-limited, resetAt', next: 'RN_RESET_PARSE' },
        { if: 'sygnał bez resetu', then: 'wraca do accountCause (quota) lub transient (429 pojemności)', next: '' },
      ],
      default: 'null.',
    },
    {
      id: 'RN_RESET_PARSE',
      title: 'Jak czyta się moment resetu ze słów narzędzia',
      question: 'Który wzór pasuje do komunikatu?',
      where: 'src/engine/runners/usage-limit.ts:315',
      inputs: ['message', 'now = Date.now()'],
      branches: [
        { if: 'limit reached|<epoch 10-13 cyfr> (stary Claude)', then: 'Date z epoch', next: '' },
        { if: 'try again at <Mon DDth, YYYY h:mm AM> (Codex)', then: 'Date z daty, ordinal zdjęty', next: '' },
        { if: 'try again at h:mm AM/PM (Codex goły zegar)', then: 'dziś o tej godzinie, jutro gdy już minęła', next: '' },
        { if: 'retry-after: <HTTP date> lub retry-after: N / try again in N s (Groq, API 429)', then: 'now + N s', next: '' },
        { if: 'Resets in 2h6m30s (Antigravity)', then: 'now + h/m/s', next: '' },
        { if: 'try again in N days N hours N minutes (Codex Plus/Pro)', then: 'now + części', next: '' },
        { if: 'resets [Mon] 3:45pm [(Europe/Warsaw)] (Claude)', then: 'najbliższy taki zegar; strefa IANA liczona w tej strefie, dzień tygodnia → do 7 dni', next: '' },
      ],
      default: 'null — klasyfikacja nigdy nie zależy od tego; brak resetu to quota (account) lub transient.',
      notes: 'Wynik resetAt jest zapisywany w halcie; każda powierzchnia formatuje go przy odczycie (formatResetAt), a usageLimitAdvice (usage-limit.ts:335) celowo nie wymienia godziny.',
    },
    {
      id: 'RN_TRANSIENT',
      title: 'Awaria przejściowa sieci lub serwera',
      question: 'Czy to samo wywołanie może przetrwać powtórkę?',
      where: 'src/engine/runners/seat-failure.ts:154',
      inputs: ['outcome', 'looksOfflineDiagnostic (offline, network, connection refused, dns)', 'TRANSIENT_NETWORK_MARKERS (econnreset, econnrefused, socket hang up, fetch failed, eai_again, enotfound, etimedout, ...)', 'httpStatusOf(message)'],
      branches: [
        { if: 'outcome ustawiony i nie w {non-zero-exit, protocol-failure, usage-limit}', then: 'false — outcome jest finalny', next: '' },
        { if: 'marker offline/sieciowy', then: 'true', next: '' },
        { if: 'status 429 i (fraza limitu lub rzeczownik)', then: 'true — 429 pojemności bez resetu', next: '' },
        { if: 'status 408 lub 500-599', then: 'true', next: '' },
      ],
      default: 'false → class other.',
    },
    {
      id: 'RN_CALL_OUTCOME',
      title: 'RunnerCallResult → RunnerOutcome (stan maszynowy dla drabiny)',
      question: 'Jaki outcome dostaje orkiestrator BUILD z nieudanego wywołania?',
      where: 'src/engine/implementers/pipeline/call-result.ts:123',
      inputs: ['result.status', 'result.error.code', 'classifySeatFailure(source result-error)'],
      branches: [
        { if: 'code jest stanem stabilnym (spawn-not-found, unauthenticated, usage-limit, input-too-large, timeout, no-progress-cut, implementer-left-isolation, missing-model, ...; runner_call_tool_use_count_limit → tool-use-limit)', then: 'ten stan', next: '' },
        { if: 'class account cause auth', then: 'unauthenticated', next: 'RN_SEAT_DOWN_HALT' },
        { if: 'class account inne lub rate-limited', then: 'usage-limit', next: 'RN_SEAT_DOWN_HALT' },
        { if: 'status failed / refused / incomplete', then: 'protocol-failure', next: '' },
        { if: 'status truncated', then: 'output-budget-breach', next: '' },
        { if: 'status aborted', then: 'user-abort', next: '' },
        { if: 'status timeout', then: 'timeout', next: '' },
        { if: 'status unsupported_tool', then: 'platform-limitation', next: '' },
      ],
      default: 'Każdy stan ma remediation (runners/errors.ts:45). Lista stanów: RUNNER_OUTCOME_STATES (errors.ts:5).',
    },
    {
      id: 'RN_SEAT_RETRY',
      title: 'Powtórka awarii przejściowej',
      question: 'Czy withSeatRetry powtórzy to samo wywołanie?',
      where: 'src/engine/runners/transient.ts:91',
      inputs: ['isTransientSeatFailure(failure) (źródło thrown)', 'attempt', 'BOUNDS.transientRetries = 3'],
      branches: [
        { if: 'ok lub nie-transient lub attempt > 3', then: 'zwróć wynik jak jest', next: '' },
        { if: 'transient i attempt <= 3', then: 'onDiscarded(wartość), delay 2s·2^(attempt-1) (2, 4, 8 s), publishSeatRetry, powtórz', next: '' },
        { if: 'signal przerwany w czasie backoff', then: 'abortError', next: '' },
      ],
      default: 'Powtórki nie są próbami lineage: żaden stan nie liczy ich jako attempt.',
      notes: 'Opakowanie jest używane tylko na BUILD przez runSeatCall (run-implementation.ts:286, make-implementer-retry-invoker.ts:125). PLAN i REVIEW nie mają tej pętli; ich transient idzie do planner-call-failed / review-failed.',
    },
    {
      id: 'RN_SEAT_WAIT',
      title: 'Czekanie na reset limitu w miejscu',
      question: 'Czy BUILD może doczekać resetu zamiast halt?',
      where: 'src/engine/orchestrator/escalation/seat-wait.ts:76',
      inputs: ['classifySeatFailure(failure, thrown).class', 'parseUsageLimitReset(message, now)', 'BOUNDS.rateLimitResetWaitMs = 600 000'],
      branches: [
        { if: 'class !== rate-limited lub reset null', then: 'undefined → caller zachowuje halt runner-usage-limit', next: 'RN_SEAT_DOWN_HALT' },
        { if: 'waitMs <= 0 lub > 10 min', then: 'undefined → halt', next: 'RN_SEAT_DOWN_HALT' },
        { if: '0 < waitMs <= 10 min', then: 'SET_SEAT_WAIT{seat, resetAt}, publishSeatWaitStarted, abortableDelay, CLEAR_SEAT_WAIT, powtórz withSeatRetry raz (runSeatCall, seat-wait.ts:150)', next: '' },
        { if: 'resume runu ze state.seatWait w przyszłości', then: 'resumeSeatWait (seat-wait.ts:120) czeka dalej przed kontynuacją (orchestrator/run/init.ts:330)', next: '' },
      ],
      default: 'Abort w trakcie czekania zostawia state.seatWait; resume czyta deadline.',
    },
    {
      id: 'RN_SEAT_DOWN_HALT',
      title: 'Przekazanie do recovery: kształt wyjścia klasyfikacji',
      question: 'Co dostaje builder haltu Seat down?',
      where: 'src/engine/orchestrator/recovery/builders/task.ts:338',
      inputs: ['classification: SeatFailureClassification', 'words (słowa narzędzia)', 'runner', 'seat plan|build|review', 'seatSwap (loadSeatSwapContext)', 'seatSwitches'],
      branches: [
        { if: 'class account cause auth', then: 'reason runner-unauthenticated, holder = runnerAccountDisplayName; advice runnerLoginInstruction (codex logout/login, claude /login, lub Re-authenticate ...)', next: '' },
        { if: 'class account balance/billing/quota', then: 'reason runner-usage-limit, cause = balance/billing/quota, advice accountCauseAdvice', next: '' },
        { if: 'class rate-limited', then: 'reason runner-usage-limit, cause rate-limit, resetAt; akcja retry-later', next: '' },
        { if: 'seatSwap.fallback dostępny i configRevision znany i brak wcześniejszego auto switch tego seatu w seatSwitches i (account lub reset > 10 min)', then: 'switch-seat z auto → automatyczne przełączenie (recovery)', next: '' },
        { if: 'BUILD: outcome unauthenticated / usage-limit na pierwszej próbie', then: 'implementation-failure.ts:67 / :108 buduje ten halt bez retry i bez konsultu; krok INTERRUPT_STEP source seat', next: '' },
        { if: 'BUILD: po drabinie retry', then: 'escalation/handle.ts:82 seatDownHalt z tą samą klasyfikacją', next: '' },
      ],
      default: 'haltOf(reason) → seat-down (core/recovery/halt.ts:80). Dalszy przebieg: recovery.',
      notes: 'Opis wyjścia: SeatFailureClassification = {class: authoritative} | {class: account, cause: balance|billing|quota|auth} | {class: rate-limited, resetAt: Date} | {class: transient} | {class: other} (seat-failure.ts:15). Dla narzędzi provider-dependent holder brzmi deepseek (OpenCode CLI) (auth-failure.ts:52).',
    },
    {
      id: 'RN_PLANNER_CALL_DIAGNOSIS',
      title: 'Awaria wywołania PLAN/REVIEW: diagnoza przed haltem',
      question: 'Co nieudane wywołanie planner-tier mówi o seacie?',
      where: 'src/engine/orchestrator/recovery/planner-call-failure.ts:72',
      inputs: ['typedRunnerCallErrorCode(err)', 'thrownSeatFailure(err) (słowa + klasyfikacja; dla shell/agent także ostatnia linia stdout)', 'runner'],
      branches: [
        { if: 'code missing-model', then: 'failure missing-model: runnerDefectRow, pick a listed model; route credential decyduje czy to sign-in', next: '' },
        { if: 'code input-too-large', then: 'failure input-too-large: the prompt is too large, rozmiar i limit gdy znane', next: '' },
        { if: 'class rate-limited lub account != auth', then: 'failure usage-limit, resetsAt, seatDown.classification; zdanie usageLimitAdvice', next: 'RN_SEAT_DOWN_HALT' },
        { if: 'class account auth', then: 'failure unauthenticated + runnerLoginInstruction, seatDown', next: 'RN_SEAT_DOWN_HALT' },
      ],
      default: 'failure call-failed → halt planner-call-failed (Seat down) bez seatDown; na REVIEW review-failed (Needs you). Zobacz planning i review.',
      notes: 'thrownSeatFailure (call-result.ts:232) czyta ostatnią linię stdout tylko przy wyjściu z kodem (processError.isExitCode), nigdy przy timeout.',
    },
    {
      id: 'RN_AUTH_CHANNEL_ADMISSION',
      title: 'Jawny authChannel jest odrzucany, pusty używa logowania hosta',
      question: 'Czy seat może twierdzić, jaką metodą płaci?',
      where: 'src/core/runners/cli-auth-selection.ts:70',
      inputs: ['runner.authChannel', 'CLI_AUTH_ENFORCEMENT_EVIDENCE (pusta, cli-tool-catalog.ts:103)', 'platform, installedVersion'],
      branches: [
        { if: 'authChannel undefined lub provider-dependent', then: 'host-configured: defaultCliAuthChannel(tool); logowanie narzędzia decyduje', next: 'RN_HOST_STATE' },
        { if: 'session lub api-key jawnie i brak wiersza macierzy', then: 'refused → readiness blocker (evaluate-candidate.ts:366) i, przy dispatch, throw runner-auth-channel-unenforced (cli-auth-enforcement.ts:60 przez invocation-identity.ts:107)', next: '' },
        { if: 'authChannel nieznany dla narzędzia', then: 'load konfiguracji pada (validateCliAuthChannel, runner-fields.ts:297); resolveCliRunnerAuth rzuca runner-auth-channel-invalid', next: '' },
      ],
      default: 'Posture billingowe seatu: unknown dla każdego CLI (runner-billing.ts:45), bo nic nie jest enforced; api z katalogu providera; shell/agent unknown.',
      notes: 'docs/AUTH-METHOD-MATRIX.md: każde narzędzie jest host-configured. Picker nie oferuje wyboru metody.',
    },
    {
      id: 'RN_HOST_STATE',
      title: 'Jak logowanie hosta dociera do dziecka',
      question: 'Czy kanał ma stan hosta i czy platforma trzyma go w keychain?',
      where: 'src/core/runners/cli-tool-catalog.ts:67',
      inputs: ['channel.stateBridge host-cli-state | none', 'channel.hostKeychainPlatforms', 'process.platform'],
      branches: [
        { if: 'stateBridge none (api-key: ANTHROPIC_API_KEY, OPENAI_API_KEY, CURSOR_API_KEY)', then: 'none: prywatny HOME, nic nie skopiowane', next: '' },
        { if: 'host-cli-state i platforma w hostKeychainPlatforms (darwin: claude-code, copilot, cursor, antigravity)', then: 'host-account: HOME, USERPROFILE, USER hosta; copilot także COPILOT_HOME (sandbox-env.ts:201)', next: '' },
        { if: 'host-cli-state na innej platformie (Linux)', then: 'bridged-files: bridgeCliState kopiuje/linkuje pliki logowania do sandbox HOME (codex ~/.codex/auth.json live, claude .credentials.json sealed, opencode/kilo config+data live)', next: '' },
      ],
      default: 'createSandboxEnv (sandbox-env.ts:282) zawsze izoluje TMPDIR, XDG_*, npm/pip/cargo cache; czyści snapshot tylko wybranego narzędzia w swoim roocie roli.',
      notes: 'Antigravity na Linuxie nie ma mostu plików (docs/AUTH-METHOD-MATRIX.md). Copilot zawsze dostaje COPILOT_CACHE_HOME hosta, bo inaczej launcher rozpakowuje starszą wbudowaną wersję (sandbox-env.ts:241).',
    },
    {
      id: 'RN_ENV_KEYS',
      title: 'Które zmienne środowiskowe rodzica przeżywają',
      question: 'Ile kluczy przenosi kanał auth?',
      where: 'src/engine/runners/sandbox-env.ts:113',
      inputs: ['channel.env', 'channel.billing', 'process.env'],
      branches: [
        { if: 'billing provider-dependent (opencode, kilo-code)', then: 'channel.env + każda zmienna *_API_KEY rodzica', next: '' },
        { if: 'inny kanał CLI', then: 'dokładnie channel.env', next: '' },
        { if: 'shell/agent', then: 'nazwy z runner.env', next: '' },
        { if: 'api', then: 'referencja apiKey env:VAR lub credentialEnv providera (dla HTTP w procesie)', next: '' },
      ],
      default: 'createSanitizedChildEnv zachowuje klucze runtime (LANG, LC_*, TZ, TERM, COLORTERM, NO_COLOR, FORCE_COLOR, COLUMNS, LINES) i PATH bez katalogów projektu. Dziecko nigdy nie dostaje CLAUDECODE, CLAUDE_CODE_*, SSH_AUTH_SOCK.',
      notes: 'Wartości sekretów są dołączane niejawnie (SANDBOX_CREDENTIAL_VALUES) i redagowane w komunikatach i logach wywołania (calls/status.ts:355).',
    },
    {
      id: 'RN_API_MODEL',
      title: 'Model runnera api',
      question: 'Czy model (lub auto) rozwiązuje się dla providera?',
      where: 'src/engine/planners/api.ts:158',
      inputs: ['runner.model', 'resolveAutoModel(model, provider)', 'hasAutomaticModelDefault(provider)'],
      branches: [
        { if: 'auto/brak i provider z domyślnym modelem w katalogu (ollama → qwen3-coder:30b)', then: 'ten model', next: '' },
        { if: 'auto/brak i provider bez domyślnego', then: 'load konfiguracji odrzuca (runner-fields.ts:179); w runtime providerError.missingModel', next: '' },
        { if: 'model jawny', then: 'selectionId seatu, zamrożony przy budowie (PreparedApiSeat)', next: 'RN_API_ADMISSION' },
      ],
      default: 'Implementer api: to samo w createApiImplementer (implementers/api.ts:113).',
    },
    {
      id: 'RN_API_ADMISSION',
      title: 'Admisja każdego wywołania api przed wysłaniem',
      question: 'Czy endpoint, model i budżet kontekstu zgadzają się z przygotowanym seatem?',
      where: 'src/engine/providers/api-budget.ts:254',
      inputs: ['prepared {provider, apiBase, selectionId, configuredContextLength}', 'dispatch {provider, apiBase, model}', 'messages', 'buildTargets (BUILD)', 'obserwacja modelu na endpoincie'],
      branches: [
        { if: 'provider/apiBase/model różne od prepared', then: 'refused api-selection-identity-mismatch', next: '' },
        { if: 'model nieobserwowalny na połączeniu', then: 'refused api-selected-model-unavailable', next: '' },
        { if: 'input + ceil(15%) + output reserve > kontekst aplikacji (configured → observed active → 8192) na PLAN/REVIEW', then: 'refused insufficient-context (ApiContextDiagnostic) → planner-call-failed Seat down', next: '' },
        { if: 'to samo na BUILD', then: 'refused api-context-budget-insufficient; BUILD rezerwuje output na cały bundle plików', next: '' },
        { if: 'BUILD: currentCode w promptcie został ucięty', then: 'throw api-current-code-truncated przed admisją (implementers/api.ts:119)', next: '' },
      ],
      default: 'admitted: measurement.maxTokens idzie jako max_tokens; temperature i effort nie są wysyłane.',
    },
    {
      id: 'RN_API_DEADLINES',
      title: 'Trzy zegary wywołania api',
      question: 'Co kończy strumień HTTP?',
      where: 'src/engine/providers/api-deadlines.ts:41',
      inputs: ['runner.timeout', 'role (implementer | inne)', 'TIMEOUTS.implementerMs 1 200 000, reviewerMs 600 000', 'API_FIRST_RESPONSE_TIMEOUT_MS 120 000', 'STREAM_IDLE_TIMEOUT_MS 60 000'],
      branches: [
        { if: 'brak pierwszego chunka w min(120 s, total)', then: 'api_first_response_timeout', next: '' },
        { if: 'przerwa między chunkami > min(60 s, total)', then: 'api_stream_idle_timeout', next: '' },
        { if: 'całość > total (timeout ?? BUILD 20 min / PLAN+REVIEW 10 min)', then: 'api_total_timeout', next: '' },
        { if: 'signal wywołującego', then: 'abortError', next: '' },
      ],
      default: 'Klient SDK dostaje ten sam total jako timeout i nie ma własnych retry (client/connection.ts:56).',
    },
    {
      id: 'RN_API_FINISH',
      title: 'finish_reason strumienia OpenAI',
      question: 'Jak kończy się udane połączenie?',
      where: 'src/engine/providers/openai-stream/completion.ts:150',
      inputs: ['finish_reason ostatniego chunka', 'policy.finishReasons', 'usage z chunka'],
      branches: [
        { if: 'stop', then: 'completed + usage', next: '' },
        { if: 'length', then: 'truncated: openai_finish_reason_length', next: '' },
        { if: 'content_filter', then: 'refused: openai_finish_reason_content_filter', next: '' },
        { if: 'tool_calls / function_call', then: 'unsupported_tool: openai_finish_reason_<reason>', next: '' },
        { if: 'nieznany dla polityki', then: 'failed: openai_unknown_finish_reason', next: '' },
      ],
      default: 'null → strumień trwa.',
    },
    {
      id: 'RN_API_HTTP_ERROR',
      title: 'Błąd HTTP lub sieci runnera api',
      question: 'Jak błąd SDK staje się słowami dla klasyfikatora?',
      where: 'src/engine/streaming/stream-errors.ts:85',
      inputs: ['err.status', 'łańcuch przyczyn (ECONNREFUSED)', 'nagłówek retry-after przy 429'],
      branches: [
        { if: 'connection refused w łańcuchu', then: 'stream-connection-refused → transient (marker connection refused)', next: 'RN_TRANSIENT' },
        { if: 'status >= 400', then: 'stream-http-status {status, detail}; dla 429 detail kończy się (retry-after: Ns)', next: 'RN_ACCOUNT_CAUSE' },
        { if: 'inny', then: 'rethrow jak jest', next: '' },
      ],
      default: 'finishOpenAiFailure (completion.ts:302) zapisuje call_error z kodem openai_stream_error i rzuca dalej; thrownSeatFailure czyta data.status i data.detail (call-result.ts:232).',
      notes: 'Nie ma retry w transporcie api. 5xx/408 i 429 bez resetu wracają przez withSeatRetry tylko na BUILD; 429 z retry-after staje się rate-limited i czeka lub haltuje.',
    },
    {
      id: 'RN_API_RESPONSE_FORMAT',
      title: 'Endpoint odrzuca response_format',
      question: 'Czy typowane wywołanie api powtórzyć bez schematu natywnego?',
      where: 'src/engine/planners/api.ts:43',
      inputs: ['stream-http-status', 'data.status === 400', 'data.detail zawiera response_format'],
      branches: [
        { if: 'tak', then: 'drugie wysłanie: prompt + fallbackInstruction(schema), bez response_format, nowy callContext (osobny callId; to nie jest naprawa requestTyped)', next: '' },
        { if: 'inny status lub 400 bez nazwy pola', then: 'błąd propaguje jako planner call failure', next: '' },
      ],
      default: 'Odrzucenie nie jest zapamiętywane: każde typowane wywołanie wysyła najpierw wariant natywny.',
    },
    {
      id: 'RN_TYPED_TRANSPORT',
      title: 'Transport schematu JSON do seatu',
      question: 'Czy narzędzie bierze schemat natywnie w tej wersji?',
      where: 'src/core/runners/cli-tool-catalog.ts:880',
      inputs: ['CLI_TOOL_CATALOG[tool].typedOutput {kind, since}', 'installedVersion z gate', 'isStrictJsonSchema(schema)'],
      branches: [
        { if: 'kind fallback (opencode, copilot, kilo-code, cursor, command-code)', then: 'fallback: zdanie na końcu promptu', next: '' },
        { if: 'installedVersion < since', then: 'fallback', next: '' },
        { if: 'native (claude-code od 2.1.287 → --json-schema; antigravity od 1.2.14 → --json-schema)', then: 'native', next: '' },
        { if: 'strict-native (codex od 0.157.1) i schemat strict (bez oneOf/allOf/not, każdy klucz required, additionalProperties false)', then: 'native: --output-schema <plik 0600> (schema-file.ts:7)', next: '' },
        { if: 'strict-native i schemat niestrict', then: 'fallback', next: '' },
        { if: 'installedVersion nieznany', then: 'kind z katalogu (flaga zostaje)', next: '' },
      ],
      default: 'api: response_format json_schema bez strict (RN_API_RESPONSE_FORMAT). shell/agent: fallback.',
    },
    {
      id: 'RN_TYPED_REPAIR',
      title: 'Zła odpowiedź typowana: naprawa czy błąd',
      question: 'Czy seat dostaje drugie wywołanie?',
      where: 'src/engine/runners/typed-output.ts:374',
      inputs: ['seat (planner | reviewer | implementer)', 'call.canResume', 'first.nativeSessionId', 'maxInputChars'],
      branches: [
        { if: 'prompt > maxInputChars (codex 1 048 576 znaków)', then: 'throw input-too-large przed wysłaniem', next: '' },
        { if: 'seat implementer', then: 'seat-protocol-error po 1 próbie', next: '' },
        { if: 'planner, canResume i id sesji', then: 'resumeRepairPrompt na tym samym wątku', next: '' },
        { if: 'planner bez wątku lub reviewer', then: 'freshRepairPrompt: pełny prompt + poprzednia odpowiedź + błędy', next: '' },
        { if: 'druga odpowiedź nadal zła', then: 'seat-protocol-error attempts 2 → recovery (haltOf → seat-down)', next: '' },
      ],
      default: 'usage obu wywołań jest sumowane (totalUsage).',
    },
    {
      id: 'RN_USAGE_NORMALIZE',
      title: 'Normalizacja liczników tokenów',
      question: 'Jak surowe pola narzędzia stają się pięcioma rozłącznymi licznikami?',
      where: 'src/engine/calls/usage.ts:145',
      inputs: ['input_tokens, cached_input_tokens (Codex)', 'prompt_tokens, prompt_tokens_details.cached_tokens (OpenAI)', 'cache_read_input_tokens, cache_creation_input_tokens (Claude)', 'completion_tokens_details.reasoning_tokens', 'pola camelCase własnego kontraktu'],
      branches: [
        { if: 'input_tokens obecne', then: 'input = input_tokens - cached_input_tokens; cacheRead = cached_input_tokens', next: '' },
        { if: 'prompt_tokens obecne', then: 'input = prompt_tokens - cacheRead - cacheCreate', next: '' },
        { if: 'output_tokens / completion_tokens', then: 'output = total - reasoning', next: '' },
        { if: 'wynik ujemny', then: 'null — nie opisuje wywołania', next: '' },
        { if: 'żaden licznik', then: 'null → usage: null (nie zero)', next: '' },
      ],
      default: 'counterCoverage per licznik: reported | partial | missing; providerTotals trzyma sumy inclusive jako metadane.',
      notes: 'Brak licznika nigdy nie staje się zerem: pola opcjonalne pozostają absent (docs/PLANNERS-AND-IMPLEMENTERS.md Unknown is not zero).',
    },
    {
      id: 'RN_USAGE_SEMANTICS',
      title: 'Jak próbki usage się składają',
      question: 'Czy próbka dodaje, czy zastępuje?',
      where: 'src/engine/calls/usage.ts:112',
      inputs: ['semantics delta | cumulative | final'],
      branches: [
        { if: 'delta (Claude mid-stream)', then: 'dodaj do bieżącego', next: '' },
        { if: 'cumulative / final (codex turn.completed, claude result, terminal call_completed)', then: 'zastąp bieżące', next: '' },
        { if: 'próbka po rekordzie terminalnym', then: 'ignorowana (collectCallUsageEvidence, summary/call-usage.ts:24)', next: '' },
        { if: 'runner_call_started powtórzone dla tego samego callId (proces wznowiony)', then: 'nowe wywołanie, nie więcej usage dla starego', next: '' },
      ],
      default: 'Claude: terminalna linia result ma pierwszeństwo nad deltami; steering sumuje tury.',
    },
    {
      id: 'RN_USAGE_CATEGORY',
      title: 'Rola wywołania → kategoria księgi',
      question: 'Do którego wiadra trafia usage?',
      where: 'src/engine/orchestrator/tokens.ts:78',
      inputs: ['callContext.role: planner | implementer | review | summary | compaction | escalation', 'phase (dla review w uzgadnianiu)'],
      branches: [
        { if: 'planner, summary, compaction', then: 'planner*', next: '' },
        { if: 'implementer', then: 'implementer*', next: '' },
        { if: 'review', then: 'reviewer*; przy odczycie z logu review w fazie planowania liczy się jako planner (isReviewSeatCall, calls/review-seat.ts:15)', next: '' },
        { if: 'escalation (tylko stare rekordy)', then: 'escalation*; cennik składa je z powrotem na seat plannera (seat-totals.ts:37)', next: '' },
      ],
      default: 'applyCategoryDelta ustawia coverage seatu przy pierwszym dowodzie; rozbieżny późniejszy dowód degraduje do partial.',
    },
    {
      id: 'RN_USAGE_NOT_REPORTED',
      title: 'Brief wykonany bez raportu tokenów',
      question: 'Czy delta implementer i escalation dla briefu jest zerowa?',
      where: 'src/engine/orchestrator/tokens.ts:293',
      inputs: ['tokensBefore vs currentUsage', 'reasoning i cache delty'],
      branches: [
        { if: 'wszystko zero', then: 'publishWarning implementer_usage_not_reported: <tool> completed task <id> without reporting token usage; zero tokenów zapisane', next: '' },
        { if: 'coś niezerowe', then: 'TaskTokenUsage z deltami kierunkowymi; reasoning tylko gdy księga ma wiadro', next: '' },
      ],
      default: 'SPLITBRIEF nigdy nie wymyśla liczby tokenów ani ceny; CLI bez raportu zostaje strukturalnie unpriced.',
    },
    {
      id: 'RN_RECONCILE',
      title: 'Uzgodnienie księgi z session.jsonl',
      question: 'Czy księga straciła wywołanie, które log widział?',
      where: 'src/engine/orchestrator/summary/usage-reconcile.ts:58',
      inputs: ['booked = state.tokenUsage', 'observed = runner_call_* z logu'],
      branches: [
        { if: 'implementer / escalation', then: 'max(booked, observed) — nigdy suma', next: '' },
        { if: 'planner + reviewer', then: 'jedna pula: tylko niedobór log − księga, najpierw przypisany reviewerowi (splitShortfall, usage-reconcile.ts:110)', next: '' },
        { if: 'coverage', then: 'słowo logu wygrywa, gdy je ma', next: '' },
        { if: 'log pusty', then: 'booked bez zmian', next: '' },
      ],
      default: 'Ponowne uzgodnienie nic nie zmienia (idempotentne).',
    },
    {
      id: 'RN_USAGE_VIEW_SOURCE',
      title: 'Skąd /usage bierze liczby',
      question: 'Czy run jest na żywo czy w spoczynku?',
      where: 'src/features/workflow/spend-text.ts:19',
      inputs: ['route.execution.kind', 'route.run.summary', 'token store', 'resolveCallUsageEvidence(ref)'],
      branches: [
        { if: 'route.screen !== workflow', then: 'tokenUsage null, costBreakdown null', next: '' },
        { if: 'at-rest', then: 'run.summary.tokenUsage ?? token store; costBreakdown z summary', next: '' },
        { if: 'local (live)', then: 'reconcileTokenUsage(token store, observed z dowodów wywołań); costBreakdown liczony z identity seatów (pricingContext lub runSeatIdentity(config))', next: 'RN_PRICING' },
      ],
      default: 'Zobacz ui dla samego overlayu.',
    },
    {
      id: 'RN_PRICING',
      title: 'Drabina cennika',
      question: 'Czy runner ma cenę w dolarach?',
      where: 'src/engine/providers/pricing-resolver.ts:150',
      inputs: ['kind', 'provider', 'model', 'cache models.dev', 'KNOWN_MODELS'],
      branches: [
        { if: 'kind cli', then: 'unpriced-cli (subskrypcja; koszt nieznany, nie 0.00)', next: '' },
        { if: 'kind shell / agent', then: 'unpriced-meta', next: '' },
        { if: 'api lokalny (ollama, lm-studio, llama-cpp)', then: 'unpriced-local', next: '' },
        { if: 'api płatny z models.dev', then: 'source models-dev (progi kontekstu zachowane; brak stawek cache dopełniony z bundled)', next: '' },
        { if: 'api płatny tylko w KNOWN_MODELS', then: 'source bundled-fallback', next: '' },
      ],
      default: 'unpriced-unknown. Z blokiem reviewer tokeny REVIEW są wyceniane po stawkach reviewera jako osobna linia; bez bloku składane do linii plannera.',
    },
  ],
  config: [
    { key: 'planner.kind / implementer.kind / reviewer.kind', values: 'cli | api | shell | agent', default: 'wymagane', effect: 'Dyskryminator bloku; wybiera backend w fabryce i schemat pól.', where: 'src/core/schemas/runner-fields.ts:405' },
    { key: '<seat>.tool', values: 'claude-code | codex | opencode | copilot | kilo-code | cursor | command-code | antigravity', default: 'wymagane dla cli', effect: 'Adapter z registry, katalog CLI_TOOL_CATALOG (kanał effort, auth, typed output, wersje).', where: 'src/core/runners/cli-tool-catalog.ts:368' },
    { key: '<seat>.model', values: 'id modelu | auto | brak', default: 'cli: brak (= auto); api/shell/agent implementer: wymagane', effect: 'cli: --model; auto czytane z pliku narzędzia przy przygotowaniu, YAML nie jest przepisywany. api: resolveAutoModel; provider bez domyślnego odrzuca auto.', where: 'src/core/schemas/runner-fields.ts:179' },
    { key: '<seat>.authChannel', values: 'api-key | session | provider-dependent', default: 'brak (host-configured)', effect: 'Jawne session/api-key jest odrzucane (macierz enforcement pusta). Pominięte: logowanie narzędzia decyduje. Nieznany dla narzędzia: błąd ładowania.', where: 'src/core/runners/cli-auth-selection.ts:70' },
    { key: '<seat>.args', values: 'string[]', default: '[]', effect: 'Doklejane po argv adaptera. Flaga z kategorii authority (role, permission, sandbox, cwd, config, tools, hooks/mcp, session, prompt, output, update, approval) odrzucana przed spawn.', where: 'src/engine/runners/arg-vector-preflight.ts:225' },
    { key: '<seat>.outputFormat', values: 'stream-json | jsonl | text | opencode', default: 'parser adaptera', effect: 'Parser dla shell/agent i ścieżki legacy; nie zastępuje kontraktu structured-terminal admitowanego CLI.', where: 'src/engine/runners/cli-tools/output-format.ts:1' },
    { key: '<seat>.effort', values: 'none | minimal | low | medium | high | xhigh | max', default: 'brak', effect: 'Kanał effort-flag: --effort lub -c model_reasoning_effort. Inne kanały: pole ignorowane z ostrzeżeniem stderr (PLAN/REVIEW) lub cicho (BUILD).', where: 'src/core/runners/effort-channel.ts:97' },
    { key: '<seat>.variant', values: 'string', default: 'brak', effect: 'Kanał variant: kilo --variant; opencode >= 2.0 model#variant, < 2.0 --variant. Poza kanałem: ostrzeżenie.', where: 'src/engine/runners/cli-tools/opencode.ts:138' },
    { key: '<seat>.temperature', values: '0..2', default: 'brak', effect: 'Akceptowane, ale nie wysyłane przez żaden kind; cli/shell/agent ostrzegają na stderr.', where: 'src/engine/runners/factory-gates.ts:255' },
    { key: '<seat>.timeout', values: 'ms', default: 'cli/shell/agent: brak; api BUILD 1 200 000, api PLAN/REVIEW 600 000', effect: 'Całkowity budżet wywołania. CLI bez timeout nie ma deadline. Status timeout; na BUILD dwa pod rząd → runner-timeout-repeated.', where: 'src/engine/runners/cli-tools/process-invoke.ts:286' },
    { key: '<seat>.idleWarnMs', values: 'ms', default: '300 000', effect: 'Po tylu ms ciszy bajtowej recorder.stalled → byline ostrzega; nie kończy wywołania.', where: 'src/core/schemas/runner-fields.ts:87' },
    { key: '<seat>.idleKillMs', values: 'ms >= idleWarnMs', default: 'brak', effect: 'Po tylu ms ciszy SIGTERM, po 2 s SIGKILL grupy procesu; kod no-progress-cut; liczy się jak timeout w drabinie.', where: 'src/lib/process/spawn/lifecycle.ts:302' },
    { key: '<seat>.contextLength', values: 'int > 0', default: 'kind-zależny (api: configured → observed → 8192; legacy 32768)', effect: 'Budżet aplikacji do pomiaru promptu i routingu; nie zmienia serwera.', where: 'src/engine/providers/api-budget.ts:61' },
    { key: '<seat>.customModels', values: 'string[]', default: '[]', effect: 'Dodatkowe id w pickerze; cennik nieznany bez models.dev/bundled.', where: 'src/core/schemas/runner-fields.ts:379' },
    { key: '<seat>.fallback', values: '{ tool, model?, effort?, variant? }', default: 'brak (none · pause and ask)', effect: 'Runner cli, na który seat przechodzi przy Seat down (odmowa konta lub reset > 10 min), raz na run i seat. Walidowany schematem cli tego seatu; fallback.effort dla narzędzia variant odrzucany.', where: 'src/core/schemas/runner-fields.ts:327' },
    { key: 'reviewer (cały blok)', values: 'PlannerConfig', default: 'brak → REVIEW = PLAN', effect: 'Osobny runner REVIEW, osobna admisja, osobna linia kosztu, własny fallback.', where: 'src/core/config/accessors/reviewer-runner.ts:9' },
    { key: 'implementerProfiles.default / profiles.<name>', values: 'nazwa profilu / RunnerConfig + label + capabilities.writesFiles', default: 'pierwszy profil po sortowaniu', effect: 'Każdy profil to kandydat BUILD z własną bramką; fabryka buduje implementer profilu ze slotu.', where: 'src/engine/runners/factory-gates.ts:66' },
    { key: 'api: provider / service / offering / apiBase / apiKey', values: 'ollama | lm-studio | llama-cpp | własna nazwa; payg | free-quota | coding-subscription | local; URL; inline lub env:VAR', default: 'wymagane poza apiKey', effect: 'Tożsamość endpointu zamrożona w PreparedApiSeat; ollama akceptuje tylko env:OLLAMA_LOCAL_API_KEY; provider spoza katalogu wymaga inline apiKey.', where: 'src/core/schemas/runner-fields.ts:132' },
    { key: 'shell/agent: command / args / env / capabilities', values: 'ścieżka; string[]; nazwy ENV; flagi planner', default: 'env []', effect: 'Prompt na stdin (shell) lub pliki na dysku (agent). env to jedyne zmienne rodzica; supportsSessionResume/Effort/Images: true odrzucane. Wymaga trust grant (startup).', where: 'src/core/schemas/runner-fields.ts:359' },
    { key: 'ANTHROPIC_API_KEY / OPENAI_API_KEY / CURSOR_API_KEY / COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN', values: 'sekret', default: 'brak', effect: 'Zmienne kanałów CLI przenoszone do dziecka; nie dowodzą metody billingu.', where: 'src/core/runners/cli-tool-catalog.ts:381' },
    { key: '*_API_KEY (dowolne)', values: 'sekret', default: 'brak', effect: 'Każdy klucz providera przechodzi do opencode i kilo-code (kanał provider-dependent).', where: 'src/engine/runners/sandbox-env.ts:118' },
    { key: 'SPLITBRIEF_CONTEXT_LENGTH', values: 'int', default: 'brak', effect: 'Nadpisuje wykryty kontekst domyślnego profilu implementera (tylko budżet promptu).', where: 'src/engine/providers/capabilities.ts:1' },
    { key: '--on-seat-down', values: 'switch | halt', default: 'switch', effect: 'Headless: czy halt Seat down stosuje zadeklarowany fallback automatycznie (szczegóły: recovery).', where: 'src/cli/options.ts:1' },
  ],
  states: [
    { name: 'RunnerCallResult.status', meaning: 'completed | failed | refused | incomplete | truncated | aborted | timeout | unsupported_tool — status jednego wywołania; nie-completed niesie error {code, message, status?, providerType?}.', where: 'src/engine/calls/schema.ts:96' },
    { name: 'RunnerOutcomeState', meaning: 'spawn-not-found, incompatible-version, unauthenticated, usage-limit, input-too-large, timeout, no-progress-cut, user-abort, signal-exit, non-zero-exit, protocol-failure, output-budget-breach, callback-failure, no-staged-change, platform-limitation, implementer-effect-invalid, implementer-recipe-invalid, implementer-left-isolation, checkout-changed, runner-timeout-repeated, missing-model, tool-use-limit, success — stan maszynowy z remediation dla drabiny BUILD.', where: 'src/engine/runners/errors.ts:5' },
    { name: 'SeatFailureClassification.class', meaning: 'authoritative | account{balance,billing,quota,auth} | rate-limited{resetAt} | transient | other — wynik jednego klasyfikatora dla każdego kind.', where: 'src/engine/runners/seat-failure.ts:18' },
    { name: 'CliAuthAdmission.kind', meaning: 'host-configured | enforced | refused — czy seat może deklarować metodę auth; dziś tylko host-configured lub refused.', where: 'src/core/runners/cli-auth-selection.ts:70' },
    { name: 'CliHostStateAccess', meaning: 'none | bridged-files | host-account — jak logowanie hosta dociera do dziecka.', where: 'src/core/runners/cli-tool-catalog.ts:65' },
    { name: 'RunnerBillingPosture', meaning: 'local | subscription-included | api-metered | provider-dependent | unknown — wyświetlane słowo billingu; każdy CLI dziś unknown w runnerBillingPosture.', where: 'src/core/runners/runner-billing.ts:13' },
    { name: 'CliEffortChannel', meaning: 'effort-flag | variant | model-id | none — jak effort dociera do narzędzia.', where: 'src/core/runners/effort-channel.ts:7' },
    { name: 'TypedOutputCapability', meaning: 'native | strict-native | fallback — jak seat przyjmuje schemat JSON.', where: 'src/core/runners/cli-tool-catalog.ts:178' },
    { name: 'state.seatWait', meaning: '{seat, resetAt} — BUILD czeka na reset limitu; resume honoruje deadline.', where: 'src/engine/orchestrator/escalation/seat-wait.ts:103' },
    { name: 'PlannerCapabilities', meaning: 'supportsConversationalPlanning, supportsSessionResume, supportsEffort, supportsImages, supportsSelfSummarisation; CONVERSATIONAL_CAPS tylko Claude Code, ONE_SHOT_API_CAPS reszta z nadpisaniami adaptera.', where: 'src/engine/planners/types.ts:34' },
  ],
  scenarios: [
    {
      title: 'Szczęśliwa ścieżka: Codex jako implementer wykonuje brief',
      steps: [
        '1. createImplementer: requireFactoryAuthority OK, brak runnera własnego, kind cli, assertCliImplementerTool(codex), gate cli → trustedCli.',
        '2. invoke: createRunnerSandboxEnv(projectDir, codex, implementer) — kanał session, Linux: ~/.codex/auth.json podlinkowany live do sandbox HOME.',
        '3. assertCliStartGate sprawdza receipt binarki; baseArgs: [--model gpt-5.x, -c model_reasoning_effort=high, --sandbox workspace-write, --ask-for-approval never, exec, --ignore-user-config, --json, --skip-git-repo-check, --cd <workspace>]; prompt na stdin.',
        '4. invokeProcessCli: validateArgs OK, brak steering (codex), preparePrompt stdin, revalidate binarki, spawnPipe detached (grupa procesu w rejestrze).',
        '5. Linie JSONL → codexProtocolEvents: tekst, tool-use, turn.completed z usage (semantics final; cached_input_tokens odjęte od input).',
        '6. onClose exit 0, terminal completed → finishCompleted. assertDeclaredEffect: pliki zmienione → completed.',
        '7. addUsage(implementer) → state.tokenUsage; recordTaskUsage zapisuje TaskTokenUsage; cennik unpriced-cli.',
      ],
      outcome: 'Brief przechodzi do walidacji (build). /usage pokazuje tokeny implementera bez dolarów.',
    },
    {
      title: 'Claude Code (PLAN) trafia na limit tygodniowy z zegarem',
      steps: [
        '1. Claude wypisuje result is_error: You have hit your weekly limit · resets Mon 12:00am → adapter: status failed, code runner_result_error.',
        '2. process-invoke: terminal failed; namesHalt → classifySeatFailure(result-error) != other, więc stderr nie nadpisuje; classifyHaltSignature nie daje input-too-large/missing-model → finishFailed z tym error.',
        '3. Planning (planning) łapie błąd; diagnosePlannerCallFailure: thrownSeatFailure → isExhaustion (usage limit) i parseResetsAt(Mon 12:00am) → class rate-limited, resetAt = najbliższy poniedziałek 00:00.',
        '4. failure usage-limit, seatDown.classification, zdanie usageLimitAdvice (bez godziny; resetAt w halcie).',
        '5. buildSeatDownIssue: reason runner-usage-limit, cause rate-limit, akcje retry-later + switch-seat (gdy fallback) + end-run; reset > 10 min i fallback zadeklarowany → auto switch (recovery).',
      ],
      outcome: 'Halt Seat down · Quota ... lub automatyczne przełączenie PLAN na fallback; seatSwitches dostaje wpis.',
    },
    {
      title: 'Implementer: limit z resetem za 3 minuty',
      steps: [
        '1. Codex: You have hit your usage limit ... or try again at 3:27 PM (teraz 15:24).',
        '2. runnerCallOutcome: class rate-limited → outcome usage-limit; implementerSeatAttempt → ok: false.',
        '3. runSeatCall: withSeatRetry nie powtarza (nie transient). seatResetWaitDeadline: rate-limited, reset 3 min <= 600 000 ms → deadline.',
        '4. SET_SEAT_WAIT{build, resetAt}; publishSeatWaitStarted; abortableDelay; CLEAR_SEAT_WAIT; to samo wywołanie powtórzone raz.',
      ],
      outcome: 'Brief kontynuuje bez haltu; w byline widać oczekiwanie na reset. Esc w trakcie zostawia state.seatWait, resume doczeka reszty.',
    },
    {
      title: 'Zerwane połączenie w trakcie wywołania BUILD',
      steps: [
        '1. Codex kończy exit 1 ze stderr ... ECONNRESET ...; brak terminalu → haltFailure null → non-zero-exit z doklejonym stderr (invoke-cli-adapter.ts:148).',
        '2. classifySeatFailure(thrown): outcome non-zero-exit w MESSAGE_CLASSIFIED_OUTCOMES; marker econnreset → transient.',
        '3. withSeatRetry: onDiscarded (usage zachowane), delay 2 s, publishSeatRetry, powtórka; potem 4 s, 8 s.',
        '4. Po 3 powtórkach ostatnia awaria wraca jak jest → drabina retry BUILD (build).',
      ],
      outcome: 'Najwyżej 4 wywołania tej samej próby; żadna powtórka nie zużywa attempt lineage.',
    },
    {
      title: 'Wylogowany Claude Code na BUILD',
      steps: [
        '1. Claude wypisuje Please run /login na stderr i kończy exit 1 bez result.',
        '2. process-invoke: structured-terminal bez terminalu, exit != 0 → haltFailure: fraza please run /login → code unauthenticated, message = ta linia.',
        '3. runnerCallOutcome: kod stabilny → unauthenticated. implementation-failure.ts:67: halt bez retry, INTERRUPT_STEP source seat.',
        '4. buildSeatDownIssue({class account, cause auth}) → reason runner-unauthenticated; advice: Run claude /login in a separate terminal, then retry.',
      ],
      outcome: 'Seat down · Signed out of Claude Code CLI; switch-seat gdy fallback; auto switch dozwolony (odmowa konta).',
    },
    {
      title: 'Antigravity kończy exit 0 bez zmian, limit tylko na stderr',
      steps: [
        '1. agy -p wypisuje error: Individual quota reached ... Resets in 2h6m30s na stderr, result OK, exit 0, pliki niezmienione.',
        '2. process-invoke: terminal completed → finishCompleted; stderr zapisany jako warning source stderr.',
        '3. assertDeclaredEffect: changed.length 0 → stderrUsageLimit(warnings) znajduje linię (quota reached w HALT_SIGNATURES.usage) → failed usage-limit z tą linią.',
        '4. classifySeatFailure: exhaustion + parseRelative(Resets in 2h6m30s) → rate-limited, reset 2 h > 10 min → halt Seat down z retry-later.',
      ],
      outcome: 'Brief nie liczy się jako no-staged-change; halt z zegarem resetu zamiast pustej powtórki.',
    },
    {
      title: 'Prompt za duży dla Claude Code (planner)',
      steps: [
        '1. Claude odpowiada result is_error Prompt is too long → runner_result_error.',
        '2. process-invoke: classifyHaltSignature(message) = input-too-large → error.code := input-too-large.',
        '3. createClaudeCodePlanner: typedRunnerCallErrorCode === input-too-large → session.capture(null).',
        '4. classifySeatFailure: code w AUTHORITATIVE_OUTCOMES → authoritative, brak retry; diagnosePlannerCallFailure → failure input-too-large.',
      ],
      outcome: 'Halt planner-call-failed (Seat down) the prompt is too large; następna tura startuje świeży wątek.',
    },
    {
      title: 'Runner api (Ollama): budżet kontekstu nie wystarcza',
      steps: [
        '1. createApiPlanner: model auto → qwen3-coder:30b (domyślny katalogu); PreparedApiSeat zamrożony.',
        '2. resolvePlanningContext buduje pakiet dowodowy; invoke → admitApiCall mierzy input + 15% + 2048 output vs kontekst (configured → observed → 8192).',
        '3. Pomiar insufficient → refused insufficient-context; nic nie wysłane.',
      ],
      outcome: 'Halt planner-call-failed z diagnozą insufficient-context (planning); poprawka: contextLength lub mniejszy pakiet.',
    },
    {
      title: 'Runner api zwraca HTTP 429 z Retry-After',
      steps: [
        '1. SDK rzuca błąd status 429; throwMappedError dokleja (retry-after: 120s) do detail.',
        '2. finishOpenAiFailure zapisuje call_error openai_stream_error i rzuca dalej.',
        '3. thrownSeatFailure: status 429, parseRelative(retry-after: 120) → rate-limited reset za 2 min.',
        '4. BUILD: seatResetWaitDeadline → 2 min <= 10 min → czekanie i powtórka. PLAN: planner-call-failed usage-limit z resetAt (Seat down).',
      ],
      outcome: 'BUILD czeka w miejscu; PLAN haltuje z retry-later.',
    },
    {
      title: 'Jawny authChannel: session w YAML',
      steps: [
        '1. Load konfiguracji: validateCliAuthChannel — session jest kanałem claude-code, więc OK.',
        '2. prepareExecution → evaluateCli: admitCliAuthChannel → refused (CLI_AUTH_ENFORCEMENT_EVIDENCE puste).',
        '3. blockedCheck: PLAN could not start. ... Remove auth_channel from this runner in .splitbrief/config.yaml, then retry.',
      ],
      outcome: 'Run nie startuje; readiness blocker. Pominięcie pola → host-configured i start.',
    },
    {
      title: 'Narzędzie zakończyło brief bez raportu tokenów',
      steps: [
        '1. opencode (text-exit) kończy exit 0, odpowiedź tekstowa, brak rekordu usage → terminal.usage null.',
        '2. finishCompleted(usage: null); addUsage pomija null.',
        '3. recordTaskUsage: delta implementer 0 i escalation 0 → warning implementer_usage_not_reported.',
      ],
      outcome: 'TaskTokenUsage zapisuje 0 tokenów; ostrzeżenie w session.jsonl i w pakiecie review; brak wymyślonej ceny.',
    },
  ],
  files: [
    { path: 'src/engine/runners/factory.ts', role: 'createPlanner / createReviewer / createImplementer: dispatch po kind, lazy import backendów' },
    { path: 'src/engine/runners/factory-gates.ts', role: 'requireFactoryAuthority, admitPlannerBackend, implementerConfigForAuthority, warnDroppedRunnerFields' },
    { path: 'src/core/config/accessors/reviewer-runner.ts', role: 'resolveReviewerRunner: REVIEW = reviewer albo planner' },
    { path: 'src/core/config/accessors/active-runner.ts', role: 'readActiveRunner(role, profile): aktywny blok seatu' },
    { path: 'src/core/runners/seat-roles.ts', role: 'role runnera, seaty pickera, mapowanie roli wywołania na seat' },
    { path: 'src/core/crew/seats.ts', role: 'deriveCrewSeats: trzy seaty z identity i posture' },
    { path: 'src/core/crew/fallback.ts', role: 'seatFallback, fallbackRunner, fallbackBlockedReason, deriveFallbackRows' },
    { path: 'src/core/crew/default.ts', role: 'selectDefaultCrew, detectedSeatReady, resolveInitialCrew' },
    { path: 'src/core/crew/presets.ts', role: 'trzy presety załogi' },
    { path: 'src/core/crew/identity.ts', role: 'formatSeatIdentity: <tool> · <model> · <osie>' },
    { path: 'src/core/runners/cli-tool-catalog.ts', role: 'CLI_TOOL_CATALOG: kanały auth, effortChannel, typedOutput, wersje, trust' },
    { path: 'src/core/runners/effort-channel.ts', role: 'runnerEffortChannel, seatAxisWords, peel osi z id modelu' },
    { path: 'src/core/runners/cli-auth-selection.ts', role: 'admitCliAuthChannel: host-configured | enforced | refused' },
    { path: 'src/engine/runners/cli-tools/registry.ts', role: 'lookupCliPlannerAdapter / lookupCliImplementerAdapter, looksOfflineDiagnostic' },
    { path: 'src/engine/runners/cli-tools/contract.ts', role: 'typy adaptera: promptTransport, outputContract, parse, terminal, steering' },
    { path: 'src/engine/runners/cli-tools/claude-code.ts', role: 'adapter Claude: --permission-mode plan/acceptEdits, --resume, --json-schema, --settings sandbox' },
    { path: 'src/engine/runners/cli-tools/codex.ts', role: 'adapter Codex: exec / exec resume, -c model_reasoning_effort, --output-schema, turn.failed' },
    { path: 'src/engine/runners/cli-tools/opencode.ts', role: 'adapter OpenCode: run --standalone, model#variant od 2.0.0' },
    { path: 'src/engine/runners/cli-tools/copilot.ts', role: 'adapter Copilot: --effort, --allow-all, text-exit' },
    { path: 'src/engine/runners/cli-tools/kilo-code.ts', role: 'adapter Kilo: --variant, --auto' },
    { path: 'src/engine/runners/cli-tools/cursor.ts', role: 'adapter Cursor: effort w id modelu, --force' },
    { path: 'src/engine/runners/cli-tools/command-code.ts', role: 'adapter Command Code: --effort, --yolo, --no-auto-update' },
    { path: 'src/engine/runners/cli-tools/antigravity.ts', role: 'adapter Antigravity: --model <id z effortem>, --json-schema' },
    { path: 'src/engine/runners/cli-tools/process-invoke.ts', role: 'invokeProcessCli: spawn, parsowanie, terminal, kody awarii, frazy haltu' },
    { path: 'src/engine/runners/cli-tools/prompt-transport.ts', role: 'preparePrompt: stdin | argv | file' },
    { path: 'src/engine/runners/invoke-cli-adapter.ts', role: 'invokeCliAdapter: redakcja, onSessionId w strumieniu, idle warn domyślny' },
    { path: 'src/engine/planners/cli.ts', role: 'createCliPlanner: wspólny planner CLI, resume, mutation guard' },
    { path: 'src/engine/planners/claude-code.ts', role: 'createClaudeCodePlanner: sesja, injectUserTurn' },
    { path: 'src/engine/planners/base.ts', role: 'createPlannerBase: typedCall, review, summarize' },
    { path: 'src/engine/implementers/cli.ts', role: 'createCliImplementer: deadline, izolacja (toolUseGuard), assertDeclaredEffect' },
    { path: 'src/engine/implementers/pipeline/call-result.ts', role: 'runnerCallOutcome, thrownSeatFailure, isSeatDown' },
    { path: 'src/engine/planners/api.ts', role: 'createApiPlanner, withResponseFormatFallback, invokeApiTransport' },
    { path: 'src/engine/implementers/api.ts', role: 'createApiImplementer: file-bundle-v1, admitApiCall' },
    { path: 'src/engine/providers/api-budget.ts', role: 'measureApiBudget, admitApiCall, apiBudgetError' },
    { path: 'src/engine/providers/api-deadlines.ts', role: 'resolveApiDeadlinePolicy, runWithApiDeadlines' },
    { path: 'src/engine/providers/openai-stream/completion.ts', role: 'strumień OpenAI: finish_reason → status, błąd → call_error' },
    { path: 'src/engine/streaming/stream-errors.ts', role: 'throwMappedError: connection refused, http status + retry-after' },
    { path: 'src/engine/runners/sandbox-env.ts', role: 'createRunnerSandboxEnv, cliChannelStaging, cliAuthChannelEnvKeys' },
    { path: 'src/engine/runners/cli-auth-enforcement.ts', role: 'enforceCliAuthInvocation przy dispatch' },
    { path: 'src/engine/runners/auth-failure.ts', role: 'isAuthFailureDiagnostic, runnerAccountDisplayName, runnerLoginInstruction, modelRefusalMessage' },
    { path: 'src/engine/runners/usage-limit.ts', role: 'isUsageLimitDiagnostic, stderrUsageLimit, parseUsageLimitReset, usageLimitAdvice' },
    { path: 'src/engine/runners/seat-failure.ts', role: 'classifySeatFailure — jeden klasyfikator' },
    { path: 'src/engine/runners/transient.ts', role: 'withSeatRetry, seatRetryDelayMs' },
    { path: 'src/core/pipeline-spec/halts.ts', role: 'HALT_SIGNATURES, classifyHaltSignature' },
    { path: 'src/core/pipeline-spec/bounds.ts', role: 'transientRetries 3, rateLimitResetWaitMs 600 000' },
    { path: 'src/core/pipeline-spec/timeouts.ts', role: 'implementerMs, reviewerMs, consecutiveTimeoutsHalt 2' },
    { path: 'src/engine/orchestrator/escalation/seat-wait.ts', role: 'runSeatCall, seatResetWaitDeadline, waitForSeatReset, resumeSeatWait' },
    { path: 'src/engine/orchestrator/cancellable-call.ts', role: 'withPerCallAbort: anulowanie z UI przerywa tylko wywołanie' },
    { path: 'src/engine/orchestrator/recovery/planner-call-failure.ts', role: 'diagnosePlannerCallFailure: hand-off PLAN/REVIEW do recovery' },
    { path: 'src/engine/orchestrator/recovery/builders/task.ts', role: 'buildSeatDownIssue, autoSwitchIntent (recovery)' },
    { path: 'src/engine/runners/typed-output.ts', role: 'requestTyped: transport, jedna naprawa, seat-protocol-error' },
    { path: 'src/engine/runners/host-model-selection.ts', role: 'readHostModelSelection: model auto z plików narzędzia' },
    { path: 'src/core/providers/automatic-model.ts', role: 'resolveCliModel, takesHostModel, seatRouteModel' },
    { path: 'src/engine/runners/start-gate.ts', role: 'runnerGateFor, admitFreshCliStart, assertCliStartGate' },
    { path: 'src/engine/runners/prepare-execution/runner-candidates.ts', role: 'które seaty są kandydatami per purpose' },
    { path: 'src/engine/runners/prepare-execution/evaluate-candidate.ts', role: 'evaluateCli / evaluateApi / evaluateCommand → gate lub blocker' },
    { path: 'src/lib/process/registry.ts', role: 'rejestr procesów: grupy, SIGTERM → 2 s → SIGKILL, watchdog rodzica, killAllProcesses' },
    { path: 'src/lib/process/spawn/lifecycle.ts', role: 'spawnPipe: idle warn/kill, budżet wyjścia 64 MB, stdin incomplete' },
    { path: 'src/engine/calls/usage.ts', role: 'normalizacja usage, semantics delta/cumulative/final' },
    { path: 'src/engine/orchestrator/tokens.ts', role: 'usageCategoryForRunnerCallRole, addUsage, recordTaskUsage' },
    { path: 'src/engine/orchestrator/summary/usage-reconcile.ts', role: 'reconcileTokenUsageWithSessionLog' },
    { path: 'src/engine/orchestrator/summary/call-usage.ts', role: 'collectCallUsageEvidence: jeden wiersz na wywołanie' },
    { path: 'src/core/providers/seat-totals.ts', role: 'splitSeatTokenTotals: reasoning dodany raz, escalation złożone na planner' },
    { path: 'src/engine/providers/pricing-resolver.ts', role: 'resolvePricing: unpriced-cli / models.dev / bundled' },
    { path: 'src/features/workflow/spend-text.ts', role: 'usageDetailsForRun: źródło danych /usage (live vs at-rest)' },
    { path: 'docs/PLANNERS-AND-IMPLEMENTERS.md', role: 'kanoniczny opis seatów, adapterów, tokenów' },
    { path: 'docs/CONFIGURATION.md', role: 'schematy bloków planner / reviewer / implementer, fallback, zmienne środowiskowe' },
    { path: 'docs/AUTH-METHOD-MATRIX.md', role: 'każde narzędzie host-configured; środowisko dziecka' },
    { path: 'docs/API-KEYS.md', role: 'klucze i keychain per narzędzie' },
  ],
  gotchas: [
    'Wywołanie CLI nie ma domyślnego timeoutu: tylko <seat>.timeout uzbraja deadline (process-invoke.ts:285). Domyślny idleWarnMs 300 000 tylko ostrzega; idleKillMs trzeba ustawić, by cisza coś zakończyła.',
    'Jedno słowo decyduje o retry: klasyfikator czyta tekst narzędzia. Ogon stdout/stderr dopasowuje wyłącznie frazy HALT_SIGNATURES, więc gołe billing czy rate limit w promptcie briefu nie robi haltu; ale result-error narzędzia dopasowuje szersze wzory (np. 403, sign in).',
    'Odmowa konta wygrywa nad 429 w tym samym tekście, a 429 z parsowalnym resetem wygrywa nad quota. Claude Request rejected (429) bez rzeczownika limit/quota to pojemność → transient → retry.',
    'Powtórki transient (2/4/8 s) i czekanie na reset (<= 10 min) działają tylko na BUILD (runSeatCall). PLAN i REVIEW przy tym samym błędzie haltują od razu (planner-call-failed / review-failed).',
    'Codex liczy cached_input_tokens wewnątrz input_tokens; normalizacja odejmuje je, żeby input i cacheRead były rozłączne. Brak licznika zostaje absent, nigdy 0.',
    'Każdy CLI jest unpriced i ma billing posture unknown w runnerBillingPosture, bo macierz enforcement jest pusta; katalogowe billing: subscription-included to deklaracja narzędzia, nie dowód metody.',
    'Jawny authChannel: session lub api-key blokuje start (readiness blocker), chociaż schemat go przyjmuje. docs/CONFIGURATION.md to opisuje; mylące jest to, że walidacja YAML przechodzi.',
    'temperature jest akceptowana przez każdy kind i nie wysyłana przez żaden; kind api też ją pomija (resolveOpenAICompatPolicy).',
    'OpenCode zmienia argv po wersji: >= 2.0.0 run --standalone --model provider/model#variant; nieznana wersja (brak gate) dostaje starą formę z --variant.',
    'Antigravity i Cursor nie mają flagi effort: effort to końcówka id modelu; seatAxisWords czyta ją z id. Dla auto bez pliku wyboru (cursor, copilot, command-code) SPLITBRIEF nie podaje --model i ostrzega.',
    'model: auto jest rozwiązywany przy przygotowaniu do konkretnego id (gate.effectiveModel) i prepared config dostaje go, ale YAML nie jest przepisywany; rekord runu nazywa model, config dalej mówi auto.',
    'createReviewer buduje seat na backendach plannera, przekazując config z planner := reviewer; stąd reviewer dziedziczy całą macierz kanałów effort plannera, a REVIEW bez bloku to dosłownie ten sam obiekt Planner (bez dodatkowej admisji).',
    'Fabryka porównuje config z preparedConfig po tożsamości obiektu (===). Kopia o tej samej treści daje runner-gate-mismatch.',
    'Runner api nie ma retry w transporcie; SDK client też nie (celowo, by nie mnożyć deadline). 5xx wraca przez withSeatRetry tylko na BUILD.',
    'docs/PLANNERS-AND-IMPLEMENTERS.md mówi, że Claude Code używa wspólnego invokeCliAdapter — zgodne z kodem (claude-invoke.ts:72), ale planner Claude ma osobny moduł (planners/claude-code.ts) z CONVERSATIONAL_CAPS i injectUserTurn, którego inne CLI nie mają.',
    'Słowo escalation w kategoriach tokenów to relikt: żadne bieżące wywołanie nie ma roli escalation (konsult księguje się jako planner); pola zostają dla starych rekordów i są składane na planner przy wycenie.',
  ],
});
