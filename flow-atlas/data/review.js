window.ATLAS = window.ATLAS || [];
window.ATLAS.push({
  id: 'review',
  order: 5,
  title: 'Review końcowy: checki, werdykt, fix loop',
  tagline:
    'Seat review wybiera komendy, SPLITBRIEF je uruchamia, reviewer wydaje typowany werdykt; fail daje fix tasks albo halt, pass daje ready-to-apply albo zamknięty run.',
  summary: `Review to ostatni etap runu i jedyny etap, który decyduje, czy zmiana jest gotowa. Seat review to runner z bloku **reviewer** w config.yaml, a gdy go nie ma, planner (resolveReviewerRunner). Każde wywołanie seat-a review jest jedną bezstanową, typowaną rozmową (requestTyped) z jedną naprawą odpowiedzi; nigdy nie wznawia sesji.

Kolejność jest zawsze taka sama. Najpierw **pre-review**: SPLITBRIEF uruchamia każdy check planu i briefów; required check, który nie może biec, zatrzymuje run halt-em required-checks-unrunnable, a required check czerwony staje się pending inputem (P1, P2...). Potem **plan call**: reviewer czyta projekt i wybiera do 6 komend (V1..V6), które weryfikują zmianę. SPLITBRIEF uruchamia je w run workspace pod polityką komend reviewera, czerwoną komendę uruchamia drugi raz na kopii run base (**base re-run**) i rozdziela jej failures na nowe i pre-existing. Pierwsza komenda z nowymi failures zatrzymuje listę; jej failures stają się inputami V1.1, V1.2... Potem **rendery** (validation.render): do 4 PNG na check trafiają do promptu, gdy seat przyjmuje obrazy. Na końcu **verdict call**: reviewer odpowiada jednym ReviewAnswer (werdykt plus fix work), a SPLITBRIEF weryfikuje jego claimy własnymi checkami i wylicza pass, pass-with-notes albo fail.

Nieudane wywołanie (transport, limit konta, błąd protokołu, zbyt duży input) **nigdy nie jest pass**: run staje na halt-cie w fazie final-review i czeka na użytkownika (→ zobacz recovery). Werdykt fail z fix tasks wydaje jeden z 2 cykli naprawczych (REVIEW_CYCLE_CAP), wstawia fix tasks do listy i wraca do pętli briefów; po nich checki reviewera i review biegną od nowa. Po wyczerpaniu cykli lub bez niczego do naprawy run staje na review-failed z akcjami **fix again** (+1 cykl), **Accept as is** (tylko final review bez blokującego czerwonego checku) i **End run**.

Pass w trybie worktree lub staged-copy daje ready-to-apply; Apply, Discard albo End run zamyka run (→ zobacz lifecycle). W trybie checkout (workflow.isolation: none) lub na starszym runie bez workspace pass zamyka run od razu jako closed complete, bo zmiany już są na dysku. Accept as is zachowuje nieudany werdykt: Apply nazywa się wtedy **Apply as is** i pyta raz.`,
  entry: [
    'src/engine/orchestrator/run/task-execution.ts:392',
    'src/engine/orchestrator/task/loop.ts:270',
    'src/engine/orchestrator/final-review.ts:298',
  ],
  links: [
    { to: 'build', label: 'pętla briefów kończy się status complete; fix tasks wracają do niej (START_FIX_CYCLE)' },
    { to: 'recovery', label: 'każdy halt review (review-failed, seat down, protokół, input too large, checki nieuruchamialne)' },
    { to: 'lifecycle', label: 'pass → ready-to-apply (worktree/staged-copy) albo closed complete (checkout); Apply re-review przez applyReview' },
    { to: 'runners', label: 'seat review: resolveReviewerRunner, requestTyped, klasyfikacja limitu konta, maxInputChars' },
    { to: 'planning', label: 'checki planu i kryteria (plan.json) są rejestrem checków pre-review' },
    { to: 'ui', label: 'karta Run all / Skip all, wiersze full_suite, review_checks, byline Review ·' },
    { to: 'subsystems', label: 'Checks Log, evidence ledger, drift report i review packet czytane do promptu' },
  ],
  diagrams: [
    {
      id: 'review-master',
      title: 'Przebieg review końcowego: od końca briefów do werdyktu',
      caption:
        'Czytaj z góry: pre-review (checki planu i briefów), plan call (wybór komend), checki reviewera, budowa promptu, verdict call, wyliczenie wyniku, pass albo fix loop. Każdy błąd wywołania schodzi do halt-u, nigdy do pass.',
      mermaid: `flowchart TD
  A["Pętla briefów zakończona ze statusem complete"] --> RV_CAN_RUN_FINAL{"phase = implementing lub final-review?"}
  RV_CAN_RUN_FINAL -->|"nie"| A2["Bez review: summary, run zatrzymany"]
  RV_CAN_RUN_FINAL -->|"tak"| B["Snapshot runu; capture kandydata (worktree / staged-copy)"]
  B --> C["answerPendingReviewQuestion: czeka na odpowiedź, gdy poprzedni review zadał pytanie"]
  C --> RV_REVIEW_AGAIN{"reviewsAgain: korekta lub odpowiedź na ten sam cykl?"}
  RV_REVIEW_AGAIN -->|"tak"| V["Verdict call na tym samym kandydacie, bez checków"]
  RV_REVIEW_AGAIN -->|"nie"| RV_APPLY_RECHECK{"state.applyReview: Apply zmienił kandydata?"}
  RV_APPLY_RECHECK -->|"tak"| D["recheckMergedCandidate: checki briefów i planu znów; inputy A1.."]
  RV_APPLY_RECHECK -->|"nie"| E["ALL_DONE: phase final-review"]
  D --> E
  E --> F["runPreReview: każdy check planu i briefów, wiersze full_suite moment plan"]
  F --> RV_REQUIRED_CLASSIFY{"Required check: pass / fail / inny status?"}
  RV_REQUIRED_CLASSIFY -->|"refused, not-runnable, unknown"| H1["Halt required-checks-unrunnable · Needs you"]
  RV_REQUIRED_CLASSIFY -->|"fail"| F2["QUEUE_TRIAGE: inputy P1.. (source check)"]
  RV_REQUIRED_CLASSIFY -->|"pass"| G
  F2 --> G["review_started; review_step choosing-checks"]
  G --> RV_END_CHECKS{"validation.end_checks?"}
  RV_END_CHECKS -->|"off"| G2["Sekcja: no reviewer check ran"]
  RV_END_CHECKS -->|"on (domyślnie)"| G3["Plan call: reviewer wybiera do 6 komend V1..V6"]
  G3 --> RV_PLAN_CALL_RESULT{"Plan call: poprawna typowana odpowiedź?"}
  RV_PLAN_CALL_RESULT -->|"błąd protokołu po 1 naprawie"| H2["Halt seat-protocol-error; nigdy pass"]
  RV_PLAN_CALL_RESULT -->|"tak"| G4["Checki reviewera + base re-run (diagram review-checks)"]
  G2 --> P
  G4 --> P["Prompt: diff runu, briefy, drift, Checks Log, rendery, pending inputy"]
  P --> RV_PROMPT_KIND{"Rodzaj runnera seat-a review?"}
  RV_PROMPT_KIND -->|"api"| P1["Pakiet API: cały albo insufficient-context"]
  RV_PROMPT_KIND -->|"cli / shell / agent"| P2["fitReviewPrompt: 3 przycięcia, potem too-large"]
  P1 --> V
  P2 --> V
  V --> RV_CALL_FAILURE_KIND{"Verdict call: wynik?"}
  RV_CALL_FAILURE_KIND -->|"błąd"| H3["Halt bez werdyktu (diagram review-override)"]
  RV_CALL_FAILURE_KIND -->|"ReviewAnswer"| W["Weryfikacja: verify, claimy unverified, rendery bez obrazu"]
  W --> RV_OUTCOME{"deriveReviewOutcome"}
  RV_OUTCOME --> R["RECORD_REVIEW: review.json, review.md, review_completed"]
  R --> RV_PASSED{"reviewPassed?"}
  RV_PASSED -->|"tak"| Z["REVIEW_DONE passed; workflow_complete"]
  RV_PASSED -->|"nie"| FL["followReviewAnswer (diagram review-fix-loop)"]
  Z --> RV_AFTER_PASS{"Workspace runu?"}
  RV_AFTER_PASS -->|"worktree / staged-copy"| Z1["ready-to-apply: Apply · Show diff · Discard"]
  RV_AFTER_PASS -->|"checkout / brak workspace"| Z2["closed complete, bez Apply"]`,
    },
    {
      id: 'review-checks',
      title: 'Checki reviewera: od planu komend do sekcji w promptcie',
      caption:
        'Jedna ścieżka na komendę. Odmowa polityki i brak programu to nie pass i nie fail. Czerwona komenda idzie na base re-run; dopiero nowe failures zatrzymują listę i tworzą pending inputy.',
      mermaid: `flowchart TD
  A["Plan call: reviewer odpowiada commands, declined, reason"] --> RV_PENDING_COMMANDS_FIRST{"Komendy z pendingReviewCommands wybrane jako pierwsze, tym samym tekstem?"}
  RV_PENDING_COMMANDS_FIRST -->|"nie"| A1["Schema odrzuca odpowiedź: seat dostaje jedną naprawę"]
  RV_PENDING_COMMANDS_FIRST -->|"tak"| B["RECORD_REVIEW_CHECKS; wiersz Reviewer checks · chose N"]
  B --> RV_APPROVE_CHECKS{"validation.approve_checks = ask i jest co najmniej 1 komenda?"}
  RV_APPROVE_CHECKS -->|"auto"| RUN
  RV_APPROVE_CHECKS -->|"ask, run bez ekranu (headless)"| S1["skipped: no screen to ask on"]
  RV_APPROVE_CHECKS -->|"ask: karta Reviewer checks"| RV_CARD_ANSWER{"Odpowiedź karty?"}
  RV_CARD_ANSWER -->|"Run all"| RUN["Każda komenda po kolei, w run workspace"]
  RV_CARD_ANSWER -->|"Skip all"| S2["skipped: Skip all was chosen on the card"]
  RV_CARD_ANSWER -->|"karta zamknięta bez odpowiedzi"| S3["skipped: closed without an answer"]
  S1 --> SK["Żadna komenda nie jest pass; sekcja każe oznaczyć kryteria unverified; stare V-inputy usunięte"]
  S2 --> SK
  S3 --> SK
  RUN --> RV_STOP_RULE{"Wcześniejsza komenda zatrzymała listę (stoppedBy)?"}
  RV_STOP_RULE -->|"tak"| N1["wiersz not run · Vk failed"]
  RV_STOP_RULE -->|"nie"| RV_COMMAND_POLICY{"reviewerCommandRefusal lub changedDefinitionRefusal?"}
  RV_COMMAND_POLICY -->|"odmowa"| N2["wiersz refused · powód; ani pass, ani fail"]
  RV_COMMAND_POLICY -->|"ok"| X["Proces w run workspace, limit timeout_ms, env bez sekretów"]
  X --> RV_CHECK_RUN_STATUS{"Wynik procesu?"}
  RV_CHECK_RUN_STATUS -->|"program nie istnieje"| N3["not-runnable · missingProgram"]
  RV_CHECK_RUN_STATUS -->|"exit 0"| N4["passed"]
  RV_CHECK_RUN_STATUS -->|"exit != 0 albo timeout"| F["fail: failure keys z pełnego capture"]
  F --> BR["Base re-run (diagram review-base-rerun)"]
  BR --> RV_NEW_FAILURES{"Nowe failures po podziale > 0?"}
  RV_NEW_FAILURES -->|"nie: wszystko pre-existing"| N5["preExistingChecks; brak findingu; lista biegnie dalej"]
  RV_NEW_FAILURES -->|"tak"| N6["stoppedBy = Vk; inputy Vk.1, Vk.2.. (source check); reszta nie biegnie"]
  N1 --> REC
  N2 --> REC
  N3 --> REC
  N4 --> REC
  N5 --> REC
  N6 --> REC["recordCheckRuns na ostatnim tasku; QUEUE_TRIAGE zastępuje poprzednie V-inputy"]
  SK --> OUT
  REC --> OUT["Sekcja ## Reviewer checks trafia do verdict call; discharged zdejmuje komendy z pendingReviewCommands"]`,
    },
    {
      id: 'review-command-policy',
      title: 'Polityka komend reviewera: kolejność odmów',
      caption:
        'Tak sprawdzana jest każda komenda, którą reviewer wybrał (tokensRefusal). Pierwsza pasująca reguła daje odmowę i jej powód w wierszu refused. Komenda przekazana przez forwarder wraca na początek łańcucha.',
      mermaid: `flowchart TD
  A["Tokeny komendy (parseShellCommand)"] --> RV_POLICY_SYNTAX{"Składnia: brak programu, znak sterujący, operator shella, KEY= przed programem, program ze ścieżką, URL, ścieżka poza workspace, cd?"}
  RV_POLICY_SYNTAX -->|"tak"| X["refused · powód reguły"]
  RV_POLICY_SYNTAX -->|"./gradlew lub ./mvnw"| W["Sprawdzany jak gradle / mvn"]
  W --> RV_POLICY_PROGRAM
  RV_POLICY_SYNTAX -->|"nie"| RV_POLICY_PROGRAM{"Program: shell, wrapper (env, sudo, xargs, timeout...), npm explore, NOT_VERIFICATION (git, rm, curl, docker, sed, tar...)?"}
  RV_POLICY_PROGRAM -->|"tak"| X
  RV_POLICY_PROGRAM -->|"nie"| RV_POLICY_PACKAGE{"npm / pnpm / yarn: config, pkg, version, audit fix; find -delete / -exec / -ok?"}
  RV_POLICY_PACKAGE -->|"tak"| X
  RV_POLICY_PACKAGE -->|"mix do a, b"| MX["Każdy task mix sprawdzany jako osobna komenda"]
  MX --> RV_POLICY_INTERPRETER
  RV_POLICY_PACKAGE -->|"nie"| RV_POLICY_INTERPRETER{"Interpreter: kod ze stdin (-), inline code (-e, -c, eval, php -r...), python -m?"}
  RV_POLICY_INTERPRETER -->|"inline / stdin"| X
  RV_POLICY_INTERPRETER -->|"python -m moduł"| PM["Moduł sprawdzany jako program"]
  PM --> RV_POLICY_SYNTAX
  RV_POLICY_INTERPRETER -->|"skrypt / nie interpreter"| RV_POLICY_RUNNERS{"Task runner z kodem lub inną definicją (make -f, just -c, rake -e), launcher (bunx, uvx, npx bez --no-install), setup verb (install, ci, tidy, generate)?"}
  RV_POLICY_RUNNERS -->|"tak"| X
  RV_POLICY_RUNNERS -->|"nie"| RV_POLICY_APP_SCRIPT{"Skrypt package.json start / stop / restart?"}
  RV_POLICY_APP_SCRIPT -->|"tak"| X
  RV_POLICY_APP_SCRIPT -->|"nie"| RV_POLICY_FORWARDED{"Forwarder: npx, npm exec, pnpm/yarn exec, uv run, bundle exec, mise exec, pnpm/yarn ze słowem nie-komendą?"}
  RV_POLICY_FORWARDED -->|"odmowa forwardera: bez --no-install, --yes, -p / -c, uv run --with, mise bez --"| X
  RV_POLICY_FORWARDED -->|"przekazana komenda"| RV_POLICY_SYNTAX
  RV_POLICY_FORWARDED -->|"brak forwardera"| RV_CHANGED_DEFINITION{"Definicja (skrypt package.json / composer.json, Makefile / justfile / Rakefile, wrapper, skrypt interpretera) zmieniona lub nowa wobec run base?"}
  RV_CHANGED_DEFINITION -->|"tak"| X
  RV_CHANGED_DEFINITION -->|"nie"| OK["Komenda biegnie w run workspace"]`,
    },
    {
      id: 'review-base-rerun',
      title: 'Base re-run: czerwona komenda reviewera na kopii run base',
      caption:
        'Tylko czerwony check reviewera pyta run base. Pre-existing jest tylko failure, która ma taki sam klucz po obu stronach. Placeholder (timeout, brak nazw testów) po dowolnej stronie daje not verified: reviewer decyduje.',
      mermaid: `flowchart TD
  A["Komenda reviewera Vk czerwona w run workspace"] --> RV_RUN_BASE_AVAILABLE{"runBaseOf: state.workspace zapisany?"}
  RV_RUN_BASE_AVAILABLE -->|"nie (starszy run bez workspace)"| U["not run · this run recorded no run base; każda failure nowa"]
  RV_RUN_BASE_AVAILABLE -->|"tak"| T["withRunBaseTree: worktree na commit bazowy + snapshot plików z startu runu"]
  T --> RV_BASE_TREE_PREP{"Przygotowanie i cleanup drzewa bez błędu?"}
  RV_BASE_TREE_PREP -->|"błąd"| NV["not verified at the run base · treść błędu; 0 pre-existing"]
  RV_BASE_TREE_PREP -->|"ok"| R["Ta sama komenda w kopii bazowej (bez base, bez checkoutDir)"]
  R --> RV_BASE_RESULT{"Wynik na run base?"}
  RV_BASE_RESULT -->|"refused / not run"| U2["base re-run unavailable; każda failure nowa"]
  RV_BASE_RESULT -->|"pass"| N["0 pre-existing: wszystkie failures nowe"]
  RV_BASE_RESULT -->|"fail z placeholderem po dowolnej stronie (timed out, without diagnostics, output over limit)"| NV
  RV_BASE_RESULT -->|"fail z kluczami po obu stronach"| K["Przecięcie kluczy: pre-existing = wspólne, nowe = reszta"]
  K --> RV_NEW_FAILURES{"Nowe > 0?"}
  RV_NEW_FAILURES -->|"nie"| P["wiersz Base re-run · pre-existing; brak findingu; lista biegnie dalej"]
  RV_NEW_FAILURES -->|"tak"| S["stop listy; inputy Vk.n z failureKeys nowych i redKeys wszystkich"]
  U --> S
  U2 --> S
  N --> S
  NV --> S2["stop listy; input Vk.n z notVerified; reviewer może odrzucić go z powodem i wtedy nie blokuje"]`,
    },
    {
      id: 'review-verdict-outcome',
      title: 'Od odpowiedzi reviewera do pass / pass-with-notes / fail',
      caption:
        'SPLITBRIEF nie wierzy reviewerowi na słowo: claim unverified weryfikuje własnymi checkami, render bez obrazu wymusza unverified, a każdy czerwony input blokuje poza jednym wyjątkiem.',
      mermaid: `flowchart TD
  A["ReviewAnswer: tasks, criteria, findings + fixTasks, rejected, verify, ask"] --> B["runTriageVerification: checki z verify zapisane w triage"]
  B --> RV_CLAIM_VERIFICATION{"Jest pending input source = check?"}
  RV_CLAIM_VERIFICATION -->|"tak"| C1["Bez weryfikacji claimów: unverified zostaje unverified"]
  RV_CLAIM_VERIFICATION -->|"nie"| C2["Każde unverified kryterium i finding: runChecks na jego checkIds"]
  C2 --> RV_CLAIM_STATUS{"Wynik checków claimu?"}
  RV_CLAIM_STATUS -->|"nowe failures"| C3["fail"]
  RV_CLAIM_STATUS -->|"pass albo tylko pre-existing"| C4["pass"]
  RV_CLAIM_STATUS -->|"refused / not-runnable / brak checków"| C5["unverified"]
  C1 --> RV_RENDER_FORCED
  C3 --> RV_RENDER_FORCED
  C4 --> RV_RENDER_FORCED
  C5 --> RV_RENDER_FORCED{"Kryterium ma render check, którego obraz nie dotarł do reviewera?"}
  RV_RENDER_FORCED -->|"tak"| D1["Kryterium wymuszone unverified, także w mapie weryfikacji"]
  RV_RENDER_FORCED -->|"nie"| D2
  D1 --> D2["deriveReviewOutcome"]
  D2 --> RV_FINDING_SCOPE{"Finding w zakresie review?"}
  RV_FINDING_SCOPE -->|"nie (task review)"| E1["outOfScope: notatka"]
  RV_FINDING_SCOPE -->|"blocking i niezweryfikowany"| E2["blocking"]
  RV_FINDING_SCOPE -->|"minor, albo unverified zweryfikowany pass"| E3["minor: notatka"]
  E1 --> RV_OUTCOME
  E2 --> RV_OUTCOME
  E3 --> RV_OUTCOME{"coverage errors, unverified kryterium, blocking, red input, task != met, kryterium != pass?"}
  RV_OUTCOME -->|"cokolwiek z tego"| F1["fail"]
  RV_OUTCOME -->|"nic, ale są notatki"| F2["pass-with-notes"]
  RV_OUTCOME -->|"nic i zero notatek"| F3["pass"]
  F1 --> RV_PASSED
  F2 --> RV_PASSED
  F3 --> RV_PASSED{"reviewPassed: outcome != fail, 0 fixTasks, 0 verify, ask = null, 0 blokujących red, 0 recheck failures?"}
  RV_PASSED -->|"tak"| G1["REVIEW_DONE passed"]
  RV_PASSED -->|"nie"| G2["followReviewAnswer"]`,
    },
    {
      id: 'review-fix-loop',
      title: 'Werdykt fail: pytanie, cap cykli, fix tasks, halt review-failed',
      caption:
        'followReviewAnswer czyta fix work w tej kolejności: pytanie do użytkownika, limit cykli, nic do naprawy, fix tasks. Fix tasks wracają do pętli briefów z tymi samymi komendami reviewera w bramce briefu.',
      mermaid: `flowchart TD
  A["followReviewAnswer"] --> RV_FOLLOW_ASK{"fixWork.ask != null?"}
  RV_FOLLOW_ASK -->|"tak"| Q["QUEUE_TRIAGE z pytaniem; waitForPlannerReply w composerze"]
  Q --> RV_ASK_REPLY{"Odpowiedź użytkownika?"}
  RV_ASK_REPLY -->|"brak (bez ekranu / stop)"| H1["haltFailedReview: the review asked a question this run has no way to answer"]
  RV_ASK_REPLY -->|"tekst"| Q2["Input A n kind answer; review ponownie na tym samym kandydacie, bez checków"]
  RV_FOLLOW_ASK -->|"nie"| RV_CAP{"fixCycles.used >= allowance (2, +1 za każdą korektę)?"}
  RV_CAP -->|"tak"| H2["haltFailedReview: Final review failed after N fix cycles"]
  RV_CAP -->|"nie"| RV_NOTHING_TO_FIX{"0 fixTasks i 0 verify?"}
  RV_NOTHING_TO_FIX -->|"tak"| H3["haltFailedReview: unverified criteria / recheck failures / blocking findings"]
  RV_NOTHING_TO_FIX -->|"nie"| T["applyTriage: INSERT_TASKS fix tasks (nowe T###, batch = max + cykl, task.fix z findingami)"]
  T --> S["START_FIX_CYCLE: used + 1, phase implementing, review_fix_started"]
  S --> B["Pętla briefów: fix tasks; bramka briefu dodaje fixReviewChecks (te same komendy V)"]
  B --> RV_FIX_CHECK_JUDGE{"judgeFixCheck: własne failure keys zniknęły i źródło failure udowodnione?"}
  RV_FIX_CHECK_JUDGE -->|"tak"| B2["Check briefu pass, także gdy inne failures zostały"]
  RV_FIX_CHECK_JUDGE -->|"nie"| B3["Brief fail: 1 retry, potem konsultacja seat-a review (→ build)"]
  B2 --> R["Następny review: checki reviewera znów; pendingReviewCommands muszą być pierwsze"]
  B3 --> R
  H1 --> RV_HALT_FAILED_REVIEW
  H2 --> RV_HALT_FAILED_REVIEW
  H3 --> RV_HALT_FAILED_REVIEW{"haltFailedReview: task review? czerwony input nadal blokuje?"}
  RV_HALT_FAILED_REVIEW -->|"task review"| K1["QUEUE_TRIAGE; run zostaje implementing; akcje: fix again, end run"]
  RV_HALT_FAILED_REVIEW -->|"final, red blokuje"| K2["Faza zostaje final-review; akcje: fix again, end run; bez Accept as is"]
  RV_HALT_FAILED_REVIEW -->|"final, bez red"| K3["REVIEW_DONE failed; workflow_complete failed; akcje: fix again, Accept as is, end run"]
  K1 --> RC["Halt review-failed · Needs you (→ recovery)"]
  K2 --> RC
  K3 --> RC
  RC --> RV_REVIEW_CORRECTION{"Użytkownik wybiera fix again z notatką?"}
  RV_REVIEW_CORRECTION -->|"tak"| C["REVIEW_CORRECTION: input U n (source user), phase final-review; +1 cykl, gdy cap wyczerpany"]
  C --> A2["Review ponownie na tym samym kandydacie, bez checków"]`,
    },
    {
      id: 'review-override',
      title: 'Halty bez werdyktu i ścieżka Accept as is',
      caption:
        'Lewa część: co SPLITBRIEF robi, gdy review nie wydał werdyktu. Prawa: co robi Accept as is (lub Skip review) i gdzie ląduje run.',
      mermaid: `flowchart TD
  A["Review bez werdyktu"] --> RV_VERDICTLESS_HALT{"Rodzaj failure?"}
  RV_VERDICTLESS_HALT -->|"input-too-large"| H1["Halt review-input-too-large: Skip review (tylko final lub task review) / End run; bez retry"]
  RV_VERDICTLESS_HALT -->|"seat-protocol-error"| H2["Halt protokołu seat-a: 2 odpowiedzi poza schematem (→ recovery)"]
  RV_VERDICTLESS_HALT -->|"seat-blocked: limit, konto, model"| H3["plannerCallHaltIssue: Seat down · retry / switch-seat / retry-later (→ recovery)"]
  RV_VERDICTLESS_HALT -->|"call-failed / insufficient-context"| H4["review-failed bez werdyktu: retry-same-worker / end-run"]
  F["Review failed z werdyktem (bez blokującego red)"] --> H5["review-failed: fix again / Accept as is / end run"]
  H1 --> RV_ACCEPT_AS_IS_KIND
  H5 --> RV_ACCEPT_AS_IS_KIND{"Accept as is albo Skip review: jaki halt, jaka faza?"}
  RV_ACCEPT_AS_IS_KIND -->|"input-too-large w implementing (task review)"| S1["CLEAR_SCHEDULED_REVIEW + ACCEPT_AS_IS; następny brief startuje; final review nadal osądzi całość"]
  RV_ACCEPT_AS_IS_KIND -->|"input-too-large w final-review"| S2["REVIEW_DONE failed + ACCEPT_AS_IS (findings = treść halt-u)"]
  RV_ACCEPT_AS_IS_KIND -->|"review-failed"| S3["ACCEPT_AS_IS: findings Critical z review.md, notatka użytkownika"]
  S2 --> RV_AFTER_PASS
  S3 --> RV_AFTER_PASS{"deriveRunStatus: workspace runu?"}
  RV_AFTER_PASS -->|"worktree / staged-copy"| Z1["ready-to-apply override = true: menu Apply as is · Show diff · Discard"]
  RV_AFTER_PASS -->|"checkout / brak workspace"| Z2["closed complete; blok Closed pokazuje needs attention"]
  Z1 --> AP["Apply wylicza findings i pyta raz: /run accept confirm (→ lifecycle)"]`,
    },
    {
      id: 'review-task-cadence',
      title: 'workflow.review: task — review po każdym briefie',
      caption:
        'Z cadence task każdy brief, który przeszedł walidację, dostaje własny, zawężony review. Pass nie wydaje cyklu naprawczego. Fail wstawia fix tasks zaraz po tym briefie.',
      mermaid: `flowchart TD
  A["Brief przeszedł walidację"] --> RV_CADENCE{"workflow.review?"}
  RV_CADENCE -->|"end (domyślnie)"| N["Następny brief; jeden review na końcu"]
  RV_CADENCE -->|"task"| S["START_SCHEDULED_REVIEW afterTaskId = ten brief"]
  S --> P["runPreReview scope task: tylko required checki ukończonych briefów i due criteria"]
  P --> R["Plan call zakres task: testy związane z plikami briefu, nie cała suita"]
  R --> V["Verdict: ukończone taski i due criteria; finding spoza zakresu = notatka Outside the task review scope"]
  V --> RV_SCHEDULED_PASS{"reviewPassed?"}
  RV_SCHEDULED_PASS -->|"tak"| C["CLEAR_SCHEDULED_REVIEW; cykl nie wydany; następny brief"]
  RV_SCHEDULED_PASS -->|"nie"| F["followReviewAnswer: fix tasks wstawione po tym briefie; START_FIX_CYCLE"]
  F --> N2["Pętla czyta listę od nowa i buduje fix tasks; halt task review nie oferuje Accept as is"]`,
    },
  ],
  decisions: [
    {
      id: 'RV_CADENCE',
      title: 'Kiedy review biegnie: na końcu czy po każdym briefie',
      question: 'Czy po tym briefie SPLITBRIEF uruchamia zawężony review?',
      where: 'src/engine/orchestrator/task/loop.ts:270',
      inputs: ['config.workflow.review (end | task)', 'brief, który właśnie przeszedł walidację'],
      branches: [
        { if: 'workflow.review = task', then: 'runScheduledReview z afterTaskId = ukończony brief; scope task', next: 'RV_SCHEDULED_PASS' },
        { if: 'workflow.review = end lub brak', then: 'pętla idzie do następnego briefu; review dopiero po ostatnim', next: 'RV_CAN_RUN_FINAL' },
      ],
      default: 'Brak klucza = end.',
      notes: 'Scheduled review, który zatrzymał run (halt), zwraca status stopped i pętla briefów kończy się jak przy stopie.',
    },
    {
      id: 'RV_CAN_RUN_FINAL',
      title: 'Czy review końcowy może wystartować',
      question: 'Pętla briefów skończyła się; w jakiej fazie jest run?',
      where: 'src/engine/orchestrator/run/task-execution.ts:392',
      inputs: ['taskResult.status', 'state.phase'],
      branches: [
        { if: 'status complete i phase = implementing', then: 'runFinalReviewPhase wysyła ALL_DONE (phase final-review) i rusza', next: 'RV_APPLY_RECHECK' },
        { if: 'status complete i phase = final-review (kontynuacja po nieudanym review)', then: 'review wchodzi od razu, bez ALL_DONE', next: 'RV_APPLY_RECHECK' },
        { if: 'status != complete lub inna faza', then: 'buildSummary, completed = false; run zostaje tam, gdzie stanął' },
      ],
      default: 'Bez review i bez werdyktu; nic nie udaje pass.',
    },
    {
      id: 'RV_REVIEW_AGAIN',
      title: 'Powtórka review bez checków',
      question: 'Czy ten review tylko odpowiada na korektę lub odpowiedź do już osądzonego cyklu?',
      where: 'src/core/review/verdict.ts:33',
      inputs: ['state.pendingTriage', 'state.review.scope / afterTaskId / cycle', 'fixCyclesOf(state).used'],
      branches: [
        { if: 'pendingTriage istnieje, review ma ten sam scope, afterTaskId i cycle = used', then: 'reviewsAgain = true: bez recheck, bez pre-review, bez plan call; verdict call na tym samym kandydacie z poprzednimi preExistingChecks', next: 'RV_PROMPT_KIND' },
        { if: 'inaczej', then: 'pełna sekwencja: recheck, pre-review, checki reviewera', next: 'RV_APPLY_RECHECK' },
      ],
      default: 'Pełna sekwencja.',
      notes: 'To dlatego po fix again z notatką lub po odpowiedzi na pytanie reviewera komendy nie biegną drugi raz.',
    },
    {
      id: 'RV_APPLY_RECHECK',
      title: 'Ponowne checki po Apply, który zmienił kandydata',
      question: 'Czy Apply scalił zmiany z checkoutu do kandydata (state.applyReview)?',
      where: 'src/engine/orchestrator/run/task-execution.ts:150',
      inputs: ['state.applyReview (APPLY_REVIEW_START, → lifecycle)'],
      branches: [
        { if: 'applyReview = undefined', then: 'recheck pusty; dalej pre-review', next: 'RV_REQUIRED_CLASSIFY' },
        { if: 'applyReview ustawiony', then: 'każdy check briefów i planu biegnie znów; fail → input A1.. (source check); refused/not-run → lista notRun; required nieuruchamialny → halt; sekcja Integration do promptu', next: 'RV_REQUIRED_CLASSIFY' },
      ],
      default: 'Brak recheck.',
      notes: 'Re-review po Apply liczy się jako cykl naprawczy (→ lifecycle).',
    },
    {
      id: 'RV_PRE_REVIEW_SCOPE',
      title: 'Które checki biegną w pre-review',
      question: 'Jaki jest zakres review: final czy task?',
      where: 'src/engine/orchestrator/run/pre-review-checks.ts:140',
      inputs: ['reviewScopeFor(state, scope)', 'rejestr checków: plan.checks + task.checks'],
      branches: [
        { if: 'scope final', then: 'każdy check rejestru biegnie (również optional)', next: 'RV_REQUIRED_CLASSIFY' },
        { if: 'scope task', then: 'tylko required checki ukończonych briefów i due criteria', next: 'RV_REQUIRED_CLASSIFY' },
      ],
      default: 'Brak scope = final.',
      notes: 'Wyniki zapisują się na deklarującym tasku; checki planu na ostatnim tasku zakresu (recordTaskCheckRuns).',
    },
    {
      id: 'RV_REQUIRED_CLASSIFY',
      title: 'Required check: defekt czy brak możliwości osądu',
      question: 'Jaki status ma required check po pre-review?',
      where: 'src/engine/orchestrator/run/pre-review-checks.ts:33',
      inputs: ['CheckRunResult.status', 'check.required'],
      branches: [
        { if: 'co najmniej jeden required check ma status refused, not-runnable lub unknown', then: 'haltRequiredChecksUnrunnable: halt required-checks-unrunnable · Needs you, akcje retry-same-worker / end-run; review nie startuje', next: 'RV_VERDICTLESS_HALT' },
        { if: 'required check fail', then: 'buildPreReviewInputs: input P n (source check) na każdy plik z failure keys, z ownerem pliku; QUEUE_TRIAGE', next: 'RV_END_CHECKS' },
        { if: 'wszystko pass', then: 'brak inputów', next: 'RV_END_CHECKS' },
      ],
      default: 'Optional checki nie dają inputów ani halt-u; ich wynik idzie tylko do Checks Log.',
    },
    {
      id: 'RV_END_CHECKS',
      title: 'Czy reviewer wybiera i uruchamia komendy',
      question: 'validation.end_checks?',
      where: 'src/engine/orchestrator/review-checks.ts:468',
      inputs: ['resolveEndChecks(config): endChecks ?? true', 'opts.reviewChecks (false przy reviewsAgain)'],
      branches: [
        { if: 'end_checks = false', then: 'review_checks status off; sekcja OFF_SECTION mówi reviewerowi, że żaden check reviewera nie biegł; preExistingChecks puste', next: 'RV_PROMPT_KIND' },
        { if: 'end_checks = true (domyślnie) i reviewChecks = true', then: 'plan call do seat-a review', next: 'RV_PENDING_COMMANDS_FIRST' },
      ],
      default: 'on.',
      notes: 'enabledReviewChecks zwraca [] gdy end_checks off lub plan był skipped: komenda skipped nigdy nie staje się zarejestrowanym checkiem fix tasku.',
    },
    {
      id: 'RV_PENDING_COMMANDS_FIRST',
      title: 'Komendy z fix checków muszą być wybrane pierwsze',
      question: 'Czy plan reviewera zaczyna się od komend z state.pendingReviewCommands?',
      where: 'src/engine/orchestrator/review-checks.ts:498',
      inputs: ['state.pendingReviewCommands (do 6 pierwszych)', 'plan.commands'],
      branches: [
        { if: 'każda pending komenda jest wśród pierwszych N komend z identycznym tekstem', then: 'odpowiedź przyjęta; RECORD_REVIEW_CHECKS', next: 'RV_APPROVE_CHECKS' },
        { if: 'brakuje którejś', then: 'schema (superRefine) odrzuca odpowiedź: seat dostaje jedną naprawę; druga zła odpowiedź = seat-protocol-error', next: 'RV_PLAN_CALL_RESULT' },
      ],
      default: 'Bez pending komend każdy wybór przechodzi.',
      notes: 'Komendy ponad limit 6 zostają pending z wierszem not run; po biegu komendy zdjęte z listy przez SET_PENDING_REVIEW_COMMANDS (discharged).',
    },
    {
      id: 'RV_PLAN_CALL_RESULT',
      title: 'Wynik plan call',
      question: 'Czy seat review oddał poprawny ReviewChecksPlan?',
      where: 'src/engine/orchestrator/review-checks.ts:522',
      inputs: ['runReviewerCall → requestTyped (1 próba + 1 naprawa)'],
      branches: [
        { if: 'odpowiedź pasuje do schematu (ids V1.., unikalne, reason gdy 0 komend)', then: 'plan zapisany; usage dopisane do kubełka reviewer', next: 'RV_APPROVE_CHECKS' },
        { if: 'dwie odpowiedzi poza schematem', then: 'kind protocol-error; final-review rzuca błąd; failure seat-protocol-error; halt (→ recovery)', next: 'RV_VERDICTLESS_HALT' },
        { if: 'transport / limit / odmowa konta (wyjątek)', then: 'catch w runFinalReviewPhase diagnozuje: seat-blocked albo call-failed', next: 'RV_CALL_FAILURE_KIND' },
      ],
      default: 'Nieudany plan call nigdy nie jest pass (CLAUDE.md, run contract).',
    },
    {
      id: 'RV_APPROVE_CHECKS',
      title: 'Karta Run all / Skip all',
      question: 'Czy komendy biegną od razu, czy czekają na użytkownika?',
      where: 'src/engine/orchestrator/review-checks.ts:402',
      inputs: ['resolveApproveChecks(config): approveChecks ?? auto', 'plan.commands.length', 'callbacks.onReviewChecksApproval (tylko TUI)'],
      branches: [
        { if: 'auto, albo ask z 0 komend', then: 'komendy biegną bez pytania', next: 'RV_STOP_RULE' },
        { if: 'ask i brak callbacku (headless --json / --plain)', then: 'skipped: validation.approve_checks is ask and this run has no screen to ask on', next: 'RV_CARD_ANSWER' },
        { if: 'ask i jest ekran', then: 'openReviewChecksPrompt: karta Reviewer checks · chose N · none has run yet', next: 'RV_CARD_ANSWER' },
      ],
      default: 'auto.',
    },
    {
      id: 'RV_CARD_ANSWER',
      title: 'Odpowiedź karty Reviewer checks',
      question: 'Co wybrał użytkownik na karcie?',
      where: 'src/engine/orchestrator/review-checks.ts:408',
      inputs: ['ReviewChecksApprovalAnswer: run | skip | undefined'],
      branches: [
        { if: 'Run all', then: 'komendy biegną jak przy auto', next: 'RV_STOP_RULE' },
        { if: 'Skip all', then: 'RECORD_REVIEW_CHECKS z skipped.reason; review_checks skipped; stare V-inputy usunięte; sekcja: żadna komenda nie jest pass, kryteria weryfikowane tylko nimi mają być unverified', next: 'RV_PROMPT_KIND' },
        { if: 'karta zamknięta bez odpowiedzi (superseded / stop)', then: 'skipped: the reviewer checks card closed without an answer; throwIfAborted przy stopie zatrzymuje review', next: 'RV_PROMPT_KIND' },
      ],
      default: 'Brak odpowiedzi nigdy nie czyta się jako Run.',
      notes: 'Wiersze karty: src/features/workflow/review-checks/options.ts:19; store: src/stores/review-checks-prompt/prompt.ts:46. Tylko ⏎ odpowiada; Tab przenosi fokus do composera.',
    },
    {
      id: 'RV_STOP_RULE',
      title: 'Reguła stopu listy komend',
      question: 'Czy wcześniejsza komenda miała nowe failures?',
      where: 'src/engine/orchestrator/review-checks.ts:579',
      inputs: ['stoppedBy (id pierwszej komendy z nowymi failures)'],
      branches: [
        { if: 'stoppedBy ustawione', then: 'komenda nie biegnie; wiersz not run · Vk failed', next: 'RV_NEW_FAILURES' },
        { if: 'nie', then: 'runReviewCheck moment pre-review', next: 'RV_COMMAND_POLICY' },
      ],
      default: 'Pierwsza komenda zawsze biegnie.',
      notes: 'Komenda pre-existing (0 nowych) nie zatrzymuje listy. Komenda refused lub not-runnable też nie.',
    },
    {
      id: 'RV_COMMAND_POLICY',
      title: 'Która polityka komend: reviewera czy planu',
      question: 'Czy to check reviewera (id V n), czy check planu / briefu?',
      where: 'src/engine/orchestrator/validation/run-checks.ts:212',
      inputs: ['reviewIds (z reviewChecks)', 'check.value', 'opts.base (run base)'],
      branches: [
        { if: 'check reviewera', then: 'reviewerCommandRefusal (brak allowlisty programów, tylko reguły zagrożeń), potem changedDefinitionRefusal wobec run base', next: 'RV_POLICY_SYNTAX' },
        { if: 'check planu / briefu', then: 'checkCommandRefusal: allowlista (package managery, make, just, narzędzia 5 stacków, test -e/-f/-x/-L); npm run <script> tylko z zatwierdzonym planem (workflow.approve plan) i skryptem z package.json', next: 'RV_CHECK_RUN_STATUS' },
        { if: 'odmowa', then: 'status refused, output = powód; ani pass, ani fail', next: 'RV_NEW_FAILURES' },
      ],
      default: 'Komenda biegnie.',
    },
    {
      id: 'RV_POLICY_SYNTAX',
      title: 'Polityka reviewera, reguła 1: składnia i miejsce',
      question: 'Czy tekst komendy sam w sobie łamie regułę?',
      where: 'src/engine/orchestrator/validation/reviewer-command-policy.ts:940',
      inputs: ['tokeny z parseShellCommand'],
      branches: [
        { if: 'brak programu', then: 'refused · names no program' },
        { if: 'znak sterujący (nowa linia, tab)', then: 'refused · contains a control character' },
        { if: 'operator shella | & ; ` $ ( ) { } < >', then: 'refused · contains a shell operator' },
        { if: 'pierwsze słowo zawiera = (KEY=val program)', then: 'refused · sets an environment variable before the program' },
        { if: 'pierwsze słowo to ./gradlew lub ./mvnw', then: 'sprawdzany ponownie jako gradle / mvn; pliki wrappera porównane z run base', next: 'RV_CHANGED_DEFINITION' },
        { if: 'program ze ścieżką (bin/test, sub/gradlew)', then: 'refused · runs a program by path' },
        { if: 'token z :// albo npm: / jsr:', then: 'refused · names a URL or a remote package' },
        { if: 'ścieżka absolutna lub segment .. (także po = i przyklejona do opcji -o/tmp)', then: 'refused · names a path outside the run workspace' },
        { if: 'program = cd', then: 'refused · changes the directory' },
        { if: 'żadna', then: 'dalej', next: 'RV_POLICY_PROGRAM' },
      ],
      default: 'Dalej do reguł programu.',
    },
    {
      id: 'RV_POLICY_PROGRAM',
      title: 'Polityka reviewera, reguła 2: program, który nie weryfikuje',
      question: 'Czy program jest shellem, wrapperem lub narzędziem, które nic nie weryfikuje?',
      where: 'src/engine/orchestrator/validation/reviewer-command-policy.ts:953',
      inputs: ['SHELLS', 'WRAPPERS', 'NOT_VERIFICATION', 'npm explore'],
      branches: [
        { if: 'sh, bash, zsh, dash, ksh, csh, tcsh, fish, pwsh, powershell, cmd', then: 'refused · runs the shell X' },
        { if: 'env, sudo, doas, su, xargs, nohup, timeout, nice, ionice, stdbuf, setsid, chroot, time, exec, eval, command, builtin, source, ., watch, busybox, toybox, nix-shell, nix', then: 'refused · runs another command line through X' },
        { if: 'npm explore', then: 'refused · runs another command line through npm explore' },
        { if: 'git, rm, rmdir, mv, cp, dd, chmod, chown, curl, wget, ssh, scp, nc, ncat, socat, telnet, ftp, sftp, rsync, kill, pkill, killall, shutdown, reboot, docker, podman, kubectl, apt, apt-get, yum, dnf, brew, apk, pacman, osascript, sed, tar', then: 'refused · runs X, which does not verify a change' },
        { if: 'żadne', then: 'dalej', next: 'RV_POLICY_PACKAGE' },
      ],
      default: 'Dalej.',
    },
    {
      id: 'RV_POLICY_PACKAGE',
      title: 'Polityka reviewera, reguła 3: stan pakietów i find',
      question: 'Czy komenda zmienia stan pakietów, pliki lub uruchamia komendy przez find?',
      where: 'src/engine/orchestrator/validation/reviewer-command-policy.ts:960',
      inputs: ['PACKAGE_MUTATIONS', 'FIND_ACTIONS', 'mix do'],
      branches: [
        { if: 'npm / pnpm / yarn z pierwszym operandem config, pkg lub version', then: 'refused · runs X config, which changes package state' },
        { if: 'npm / pnpm / yarn audit z fix lub --fix', then: 'refused · runs a setup command (X audit fix)' },
        { if: 'find z -delete, -exec, -execdir, -ok lub -okdir', then: 'refused · runs find -exec, which changes files or runs commands' },
        { if: 'mix do a, b (lub a + b)', then: 'każdy task sprawdzany jako osobna komenda mix; pierwsza odmowa wygrywa', next: 'RV_POLICY_INTERPRETER' },
        { if: 'żadne', then: 'dalej', next: 'RV_POLICY_INTERPRETER' },
      ],
      default: 'Dalej.',
    },
    {
      id: 'RV_POLICY_INTERPRETER',
      title: 'Polityka reviewera, reguła 4: interpreter nigdy nie uruchamia inline code',
      question: 'Co uruchamia interpreter (node, python, ruby, perl, php, lua, deno, bun, elixir, erl, groovy, scala, kotlin, tsx...)?',
      where: 'src/engine/orchestrator/validation/reviewer-command-policy.ts:594',
      inputs: ['interpreterCall(tokens)', 'INLINE_CODE_FLAGS', 'INTERPRETER_CODE_OPTIONS', 'VALUE_LETTERS'],
      branches: [
        { if: 'operand - (kod ze stdin)', then: 'refused · reads code from standard input' },
        { if: 'deno eval / repl, bun repl', then: 'refused · runs the code-execution command' },
        { if: 'opcja kodu: -e, -c, --eval, php -r/-B/-R/-F/-E, elixir --erl, erl -eval/-s/-run, groovy/scala/kotlin -e', then: 'refused · uses the code-loading option X' },
        { if: 'python -m moduł', then: 'moduł i reszta sprawdzane jako nowa komenda', next: 'RV_POLICY_SYNTAX' },
        { if: 'node --check / -c plik bez innych opcji', then: 'parse-only: nie definiuje checku, może sprawdzić także zmieniony plik' },
        { if: 'skrypt (python manage.py test)', then: 'kind script; definicja porównana z run base', next: 'RV_CHANGED_DEFINITION' },
        { if: 'wartości opcji (-Mstrict, -c php.ini, -dkey=val)', then: 'nie są kodem; komenda idzie dalej', next: 'RV_POLICY_RUNNERS' },
      ],
      default: 'Nie interpreter: dalej.',
      notes: 'Wersja w nazwie (python3.12, pypy3) jest zdejmowana przed porównaniem.',
    },
    {
      id: 'RV_POLICY_RUNNERS',
      title: 'Polityka reviewera, reguły 5-7: task runnery, launchery, setup',
      question: 'Czy komenda to build/task runner z kodem, launcher pobierający pakiet lub komenda setupu?',
      where: 'src/engine/orchestrator/validation/reviewer-command-policy.ts:976',
      inputs: ['TASK_RUNNERS', 'TASK_CODE_GOALS', 'MAKE_CONTROL_VARIABLES', 'LAUNCHERS', 'SETUP_VERBS', 'SCOPED_SETUP_VERBS', 'BARE_INSTALLERS'],
      branches: [
        { if: 'make z operandem NAME!=... lub SHELL/.SHELLFLAGS/MAKEFILES/MAKEFLAGS/GNUMAKEFLAGS=', then: 'refused · uses the make shell assignment operator / sets the make variable' },
        { if: 'mvn exec:* / antrun:*, rails runner / r, mix eval', then: 'refused · runs the code-execution goal' },
        { if: 'make -E/--eval, just -c/--command/--shell, rake -e/-E/-p/-r, gradle -I/--init-script, mix -e/--eval', then: 'refused · uses the code-loading option' },
        { if: 'make -C/-f/-I, just -d/-f/-g, rake -f/-C/-R/--rakelib/-g/--system', then: 'refused · uses the definition-changing option' },
        { if: 'bunx, uvx, pnpx, pipx run, pnpm dlx, yarn dlx, bun x, uv tool run, corepack, pnpm env, yarn set, go run pkg@ver', then: 'refused · downloads and runs a package' },
        { if: 'subcommand / goal setupu: install, i, ci, it, cit, install-test, install-ci-test, rebuild, wheel, add, get, generate, sync, download, restore, fetch, update, upgrade, self-update, publish, deploy, init, create, link, require, remove, uninstall, tidy, vendor, deps.get, deps.update (plus up, lock, dedupe, prune, shrinkwrap, generate-lockfile, wrapper tylko dla swoich narzędzi)', then: 'refused · runs a setup command (program verb)' },
        { if: 'gołe yarn, bundle, composer bez argumentu', then: 'refused · runs X with no argument, which installs' },
        { if: 'żadne', then: 'dalej', next: 'RV_POLICY_APP_SCRIPT' },
      ],
      default: 'Dalej.',
      notes: 'Operand po opcji może być jej wartością, więc też jest sprawdzany: cargo --locked test sync jest odrzucane, cargo test --locked sync przechodzi. make lock przechodzi (lock jest scoped do poetry/uv/bundle).',
    },
    {
      id: 'RV_POLICY_APP_SCRIPT',
      title: 'Polityka reviewera, reguła 8: skrypty aplikacji',
      question: 'Czy komenda uruchamia skrypt package.json start, stop lub restart?',
      where: 'src/engine/orchestrator/validation/reviewer-command-policy.ts:981',
      inputs: ['packageScript(tokens)', 'APPLICATION_SCRIPTS'],
      branches: [
        { if: 'npm start, pnpm --filter x start, yarn workspace x run start, npm run stop...', then: 'refused · runs the package script start, which starts or stops the application and does not verify a change' },
        { if: 'inny skrypt lub brak', then: 'dalej', next: 'RV_POLICY_FORWARDED' },
      ],
      default: 'Dalej.',
    },
    {
      id: 'RV_POLICY_FORWARDED',
      title: 'Polityka reviewera, reguła 9: forwardery sprawdzane po programie, który uruchamiają',
      question: 'Czy komenda przekazuje inną komendę dalej?',
      where: 'src/engine/orchestrator/validation/reviewer-command-policy.ts:722',
      inputs: ['FORWARDERS', 'EXEC_CODE_FLAGS', 'EXEC_DOWNLOAD_FLAGS', 'UV_RUN_DOWNLOAD_FLAGS', 'PACKAGE_MANAGER_COMMANDS'],
      branches: [
        { if: 'npx bez --no-install jako pierwszej opcji, albo npm exec bez --no-install', then: 'refused · runs npx without --no-install as its first option' },
        { if: 'npx / npm exec z --yes / -y', then: 'refused · ..., which downloads a missing package' },
        { if: 'npx / npm exec z --package / -p / --call / -c', then: 'refused · uses the code-loading option' },
        { if: 'npx bez programu', then: 'refused · runs npx without a program' },
        { if: 'mise exec bez -- przed programem', then: 'refused · runs mise exec without -- before its program' },
        { if: 'uv run z --with / --with-editable / --with-requirements / -w gdziekolwiek', then: 'refused · has --with after uv run, where it can download a package' },
        { if: 'pnpm exec, yarn exec, bundle exec, uv run, poetry run, pipenv run, pdm run, hatch run (env:cmd), conda run, pixi run, rye run, mise exec --, composer exec', then: 'program po subkomendzie (i każdy operand po opcji) sprawdzany jako nowa komenda', next: 'RV_POLICY_SYNTAX' },
        { if: 'pnpm / yarn z pierwszym słowem, które nie jest ich komendą (pnpm tsx, yarn node)', then: 'słowo i reszta sprawdzane jako nowa komenda', next: 'RV_POLICY_SYNTAX' },
        { if: 'brak forwardera', then: 'ostatnia reguła', next: 'RV_CHANGED_DEFINITION' },
      ],
      default: 'Komenda dopuszczona przez tekst; zostaje porównanie definicji.',
    },
    {
      id: 'RV_CHANGED_DEFINITION',
      title: 'Polityka reviewera, reguła 10: definicja zmieniona w tym runie',
      question: 'Czy to, co komenda uruchamia, zmienił lub stworzył ten run?',
      where: 'src/engine/orchestrator/validation/changed-script.ts:200',
      inputs: ['checkDefinition(command)', 'run base (createRunBaseReader)', 'pliki workspace'],
      branches: [
        { if: 'brak definicji (np. cargo test, go test, node --check)', then: 'komenda biegnie' },
        { if: 'brak run base (starszy run) i definicja = wrapper', then: 'refused · runs gradle, and this run has no run base to compare its wrapper files with' },
        { if: 'brak run base i inna definicja', then: 'komenda biegnie (brak porównania)' },
        { if: 'skrypt interpretera poza workspace lub skrypt package.json w katalogu poza workspace', then: 'refused · which is outside the run workspace' },
        { if: 'skrypt interpretera jest plikiem testowym stacku', then: 'komenda biegnie: test to nie definicja checku' },
        { if: 'skrypt interpretera changed / new wobec bazy', then: 'refused · runs x.py, which this run changed / which the run base does not hold' },
        { if: 'Makefile / justfile / Rakefile / rakelib / pliki wrappera changed lub new; katalog jest symlinkiem', then: 'refused · runs make on Makefile, which this run changed' },
        { if: 'skrypt package.json (z pre/post) lub composer.json (z @aliasami) zmieniony w którymkolwiek manifeście workspace (poza fixture testowymi, node_modules)', then: 'refused · runs the package script test, which this run changed in packages/x/package.json' },
      ],
      default: 'Definicja identyczna z run base: komenda biegnie.',
      notes: 'Nie porównuje: deno task, aliasów mix.exs, plików require/include w Makefile, manifestów zależności (pom.xml, Gemfile). Zasada chroni przed podmienioną definicją checku, nie daje sandboxa.',
    },
    {
      id: 'RV_CHECK_KIND',
      title: 'Rodzaj checku: render, cmd, test',
      question: 'Jak biegnie check zależnie od kind?',
      where: 'src/engine/orchestrator/validation/run-checks.ts:404',
      inputs: ['check.kind', 'config.validation.render', 'config.validation.test_command', 'stack'],
      branches: [
        { if: 'kind render i validation.render nie ustawione', then: 'not-runnable · validation.render is not set' },
        { if: 'kind render i id nie pasuje do ^[a-z0-9-]+$', then: 'refused · render id must match' },
        { if: 'kind render', then: 'szablon z {id} i {out}; PNG kopiowane do rendersDir sesji z sha256; exit 0 = pass, inny = fail; timeout = fail' },
        { if: 'kind cmd', then: 'runCommandCheck pod właściwą polityką', next: 'RV_COMMAND_POLICY' },
        { if: 'kind test i planTestCheck = skip (brak komendy testów dla stacku poza 5 rejestrowymi, brak pliku)', then: 'not-runnable · powód' },
        { if: 'kind test', then: 'drabinka test_command → manifest → discovered → stack default; cargo bez uruchomionego testu = not-runnable' },
      ],
      default: 'Patrz CONFIGURATION.md § How a test check resolves its command.',
    },
    {
      id: 'RV_CHECK_RUN_STATUS',
      title: 'Status po uruchomieniu komendy',
      question: 'Jak zakończył się proces checku?',
      where: 'src/engine/orchestrator/validation/run-checks.ts:233',
      inputs: ['exit code', 'timeout (validation.timeout_ms ?? STAGE_TIMEOUT_MS)', 'ENOENT programu'],
      branches: [
        { if: 'exit 0', then: 'pass; output = ogon capture' },
        { if: 'program nie istnieje (notRunnableReason)', then: 'not-runnable, missingProgram = true (halt mówi: install what is missing)' },
        { if: 'exit != 0', then: 'fail; failure = failureKeys z pełnego capture (nazwy testów + linie diagnostyczne, albo placeholder)' },
        { if: 'timeout', then: 'fail; failure.keys = [timed out], placeholder timed out; timedOut = true' },
        { if: 'inny wyjątek', then: 'rzucony dalej (błąd runu)' },
      ],
      default: 'Niekompletny capture daje placeholder output over the capture limit.',
    },
    {
      id: 'RV_RUN_BASE_AVAILABLE',
      title: 'Czy czerwony check reviewera może wrócić na run base',
      question: 'Czy run zapisał workspace z bazą (snapshotId, head)?',
      where: 'src/engine/orchestrator/review-checks.ts:299',
      inputs: ['runBaseOf(ref, state): state.workspace?.base'],
      branches: [
        { if: 'state.workspace = undefined (starszy run)', then: 'noRunBase: wiersz Base re-run · not run · this run recorded no run base; keys = [] → każda failure nowa', next: 'RV_NEW_FAILURES' },
        { if: 'workspace zapisany', then: 'preExistingKeys: withRunBaseTree', next: 'RV_BASE_TREE_PREP' },
      ],
      default: 'Także w trybie checkout run ma workspace kind checkout z bazą, więc base re-run działa.',
    },
    {
      id: 'RV_BASE_TREE_PREP',
      title: 'Przygotowanie kopii run base',
      question: 'Czy drzewo bazowe dało się zbudować i posprzątać?',
      where: 'src/engine/orchestrator/review-checks.ts:189',
      inputs: ['withRunBaseTree: worktree na commit bazowy + rekoncyliacja snapshotu; cleanupError'],
      branches: [
        { if: 'runBaseTreeError.isPreparationFailed', then: 'wiersz Base re-run done · passed false · detail = błąd · notVerified = liczba kluczy; keys = []', next: 'RV_NEW_FAILURES' },
        { if: 'komenda biegła, ale cleanup zawiódł', then: 'to samo: not verified z błędem cleanupu w detail' },
        { if: 'inny wyjątek', then: 'rzucony dalej' },
        { if: 'ok', then: 'wynik komendy na bazie', next: 'RV_BASE_RESULT' },
      ],
      default: 'Drzewo nie dodaje refa Git i jest usuwane po biegu.',
    },
    {
      id: 'RV_BASE_RESULT',
      title: 'Podział failures na nowe, pre-existing i not verified',
      question: 'Co pokazała ta sama komenda na run base?',
      where: 'src/engine/orchestrator/review-checks.ts:220',
      inputs: ['atBase.run.status', 'failure.placeholder po obu stronach', 'atBase.incomplete', 'klucze obu stron'],
      branches: [
        { if: 'status na bazie refused / not-runnable / unknown', then: 'wiersz refused / not-run; unavailable; keys = [] (wszystko nowe)', next: 'RV_NEW_FAILURES' },
        { if: 'pass na bazie', then: 'newFailures = wszystkie, preExisting = 0', next: 'RV_NEW_FAILURES' },
        { if: 'fail na bazie, ale snapshot niekompletny (incomplete) albo placeholder po którejś stronie', then: 'reason = both runs timed out / the workspace run ... / the run base re-run ...; keys = []; notVerified = wszystkie klucze', next: 'RV_NEW_FAILURES' },
        { if: 'fail na bazie z kluczami', then: 'preExisting = klucze wspólne; newKeys = reszta; wiersz Base re-run · N new, M pre-existing z nazwami do 3 na stronę', next: 'RV_NEW_FAILURES' },
      ],
      default: 'Tylko identyczny klucz po obu stronach jest pre-existing.',
    },
    {
      id: 'RV_NEW_FAILURES',
      title: 'Czy czerwona komenda zatrzymuje listę i tworzy inputy',
      question: 'Ile failures po podziale jest nowych (fresh = newFailureKeys)?',
      where: 'src/engine/orchestrator/review-checks.ts:605',
      inputs: ['fresh (klucze bez pre-existing)', 'notVerified', 'preExisting'],
      branches: [
        { if: 'fresh = 0 (wszystko pre-existing)', then: 'preExistingChecks += {id, command, keys}; wiersz failed, 0 new, N pre-existing; brak inputu; lista biegnie dalej', next: 'RV_STOP_RULE' },
        { if: 'fresh > 0 i notVerified = undefined', then: 'stoppedBy = Vk; input Vk.n na każdy plik z failingFilesFromKeys (albo jeden z file null): text "Reviewer check Vk failed with new failures", failureKeys, redKeys, command, output', next: 'RV_STOP_RULE' },
        { if: 'fresh > 0 i notVerified ustawione', then: 'stoppedBy = Vk; input z polem notVerified: SPLITBRIEF could not verify ...; the reviewer decides', next: 'RV_BLOCKING_RED' },
      ],
      default: 'Placeholder (timeout) to jeden klucz, więc timeout zawsze zatrzymuje listę.',
    },
    {
      id: 'RV_SEAT_IMAGES',
      title: 'Rendery w promptcie: obrazy czy manifest',
      question: 'Czy seat review przyjmuje obrazy i które PNG dołączyć?',
      where: 'src/engine/orchestrator/review-renders.ts:176',
      inputs: ['seatSupportsImages(runner): cli → CLI_TOOL_CATALOG imageInput != none; api → detected.supportsImages; shell/agent → false', 'ledger: ostatni wpis render checku z workspaceSnapshotId = currentCandidateId'],
      branches: [
        { if: 'rejestr nie ma render checku', then: 'brak sekcji renderów' },
        { if: 'seat przyjmuje obrazy', then: 'do 4 PNG na check (frame.png najpierw, potem reszta po ścieżce); pozostałe wymienione jako Rendered but not attached' },
        { if: 'seat nie przyjmuje obrazów, albo żaden PNG nie dał się odczytać, albo brak artefaktu z bieżącego kandydata', then: 'check w missing: manifest ścieżek + zdanie No vision review happened', next: 'RV_RENDER_FORCED' },
      ],
      default: 'Artefakt ze starszego kandydata nigdy nie trafia do reviewera.',
    },
    {
      id: 'RV_PROMPT_KIND',
      title: 'Jak budowany jest prompt werdyktu',
      question: 'Czy seat review czyta pliki sam (cli/shell/agent), czy dostaje wszystko w pakiecie (api)?',
      where: 'src/engine/orchestrator/final-review.ts:647',
      inputs: ['reviewRunner.kind', 'resolveRunUniverse (fullDiff, changedFiles, preRunFiles)', 'resolveRunReviewScope (diffy per plik z review-changes.json)', 'maxInputChars z CLI_TOOL_CATALOG'],
      branches: [
        { if: 'kind api', then: 'buildApiReviewContext: każda sekcja wymagana (spec lub feature request, tasks.md, cały diff, drift, Checks Log, pending inputs)', next: 'RV_API_PACKET' },
        { if: 'kind cli / shell / agent', then: 'fitReviewPrompt z capem narzędzia (Codex 1 048 576 znaków; Claude Code bez capu)', next: 'RV_PROMPT_FIT' },
      ],
      default: 'Prefix promptu: instrukcje workspace, sekcja Integration (po Apply), sekcja Reviewer checks, wiadomości z kolejki dla reviewera.',
    },
    {
      id: 'RV_API_PACKET',
      title: 'Pakiet API: cały albo odmowa',
      question: 'Czy pakiet dla seat-a api zawiera każde wymagane źródło i mieści się w budżecie?',
      where: 'src/engine/orchestrator/api-review-context.ts:237',
      inputs: ['sekcje wymagane', 'pliki binarne w diffie', 'apiPlanningInputBudget(contextLength)', 'estimateTokens'],
      branches: [
        { if: 'brak wymaganej sekcji (puste tasks.md, brak feature request, plik runu nieobecny w diffie)', then: 'insufficient-context cause missing-required; błąd apiContextError', next: 'RV_CALL_FAILURE_KIND' },
        { if: 'plik binarny wśród zmian', then: 'insufficient-context cause unsupported-required' },
        { if: 'tokeny > budżet', then: 'insufficient-context cause input-budget; missingSections = sekcje od pierwszej, która nie zmieściła się' },
        { if: 'wszystko', then: 'complete: prompt wysłany; nic nie jest przycinane', next: 'RV_CALL_FAILURE_KIND' },
      ],
      default: 'Seat api nie ma narzędzi: plik nieobecny w promptcie to plik nieprzeczytany.',
    },
    {
      id: 'RV_PROMPT_FIT',
      title: 'Przycinanie promptu do capu narzędzia',
      question: 'Czy prompt mieści się w maxInputChars?',
      where: 'src/engine/orchestrator/evidence/review-packet/fit.ts:42',
      inputs: ['text.length', 'maxInputChars', 'REVIEW_INPUT_TRIMS'],
      branches: [
        { if: 'brak capu albo mieści się', then: 'fits; bez przycięć' },
        { if: 'za duży: przycięcie 1 full-file-context', then: 'całe nowe pliki zastąpione jedną linią (reviewer czyta je w workspace)' },
        { if: 'nadal za duży: 2 undeclared-file-diffs', then: 'diffy plików, których żaden brief nie deklaruje, usunięte' },
        { if: 'nadal za duży: 3 task-evidence', then: 'Checks Log i drift report zastąpione ścieżkami do plików' },
        { if: 'nadal za duży', then: 'too-large: failure input-too-large z 5 największymi diffami; bez wywołania', next: 'RV_VERDICTLESS_HALT' },
        { if: 'po przycięciu mieści się', then: 'sekcja Trimmed for Size; warning Review input trimmed; review-packet.json reviewInput', next: 'RV_CALL_FAILURE_KIND' },
      ],
      default: 'Narzędzie może i tak odmówić (Codex input_too_large, Claude Code Prompt is too long): to też input-too-large.',
    },
    {
      id: 'RV_RUN_UNIVERSE',
      title: 'Co jest zmianą runu, a co pracą użytkownika',
      question: 'Który plik w workspace jest zmianą tego runu?',
      where: 'src/engine/orchestrator/evidence/review-packet/sections-io.ts:93',
      inputs: ['baseline.runStartChangedFiles (pliki zmienione w checkoutcie przy starcie)', 'git status i commity od bazy', 'run base reader', '.gitignore z liniami SPLITBRIEF'],
      branches: [
        { if: 'plik był zmieniony przed startem runu i run base pokazuje go unchanged', then: 'praca użytkownika: nie jest zmianą runu, żaden fix task nie może go wskazać (userFiles)', next: 'RV_FIX_TASK_TARGETS' },
        { if: 'plik był zmieniony przed startem i run zmienił go znów (changed / new wobec bazy)', then: 'zmiana runu; diff zaczyna się od wersji użytkownika' },
        { if: 'plik zmieniony przed startem, ale brak run base', then: 'błąd run-universe-missing-run-base: Start a new run' },
        { if: '.gitignore różni się tylko liniami .splitbrief/ i .trees/', then: 'setupFiles: ani użytkownika, ani runu' },
        { if: 'staged-copy bez własnego .git', then: 'preRunFiles puste (kopia zapisała wszystkie pliki, nie zmienione)' },
        { if: 'inny plik zmieniony od bazy', then: 'zmiana runu w changedFiles i fullDiff' },
      ],
      default: 'Brak runStartChangedFiles w stanie = błąd final-review-missing-run-baseline (final-review.ts:438).',
    },
    {
      id: 'RV_ANSWER_SCHEMA',
      title: 'Kontrakt odpowiedzi: co odrzuca schemat przed przyjęciem werdyktu',
      question: 'Czy ReviewAnswer jest kompletny i spójny?',
      where: 'src/engine/orchestrator/final-review.ts:553',
      inputs: ['verdictCoverageErrors', 'triageContractErrors', 'fixTaskTargetErrors', 'refusedCheckErrors'],
      branches: [
        { if: 'task zakresu brakuje, powtarza się lub nie istnieje; kryterium podobnie; finding powtarza id', then: 'odrzucenie: seat dostaje jedną naprawę' },
        { if: 'task partial/missed lub kryterium fail bez blokującego findingu, który je nazywa', then: 'odrzucenie' },
        { if: 'finding unverified bez checkIds i bez criterionId', then: 'odrzucenie' },
        { if: 'ask = null i blokujący finding (nie unverified) lub pending input nie ma dokładnie jednej odpowiedzi w fixTasks / rejected / verify', then: 'odrzucenie' },
        { if: 'rejected wskazuje coś, co nie jest pending inputem', then: 'odrzucenie: Rejected X is not a pending input' },
        { if: 'fix task przypisany do findingu minor, unverified lub spoza zakresu; nieznany check lub kryterium', then: 'odrzucenie' },
        { if: 'fix task wskazuje plik użytkownika (userFiles)', then: 'odrzucenie', next: 'RV_FIX_TASK_TARGETS' },
        { if: 'cmd check fix tasku odrzucony przez politykę planu, test check z więcej niż 1 słowem', then: 'odrzucenie' },
        { if: 'druga odpowiedź też zła', then: 'seat-protocol-error', next: 'RV_VERDICTLESS_HALT' },
      ],
      default: 'Odpowiedź przyjęta: werdykt + fix work.',
    },
    {
      id: 'RV_FIX_TASK_TARGETS',
      title: 'Fix task nie dotyka pracy użytkownika',
      question: 'Czy fix task wskazuje plik zmieniony przed startem runu, którego run nie zmienił?',
      where: 'src/engine/orchestrator/triage.ts:172',
      inputs: ['task.suggestedFiles', 'task.protectedOperations[].path', 'userFiles z resolveRunUniverse'],
      branches: [
        { if: 'tak', then: 'błąd: Fix task T### targets x: it was already changed when this run started, and this run did not change it; odpowiedź wraca do seat-a na jedną naprawę', next: 'RV_ANSWER_SCHEMA' },
        { if: 'nie', then: 'fix task dopuszczony: może edytować każdy zwykły plik projektu, także nieznany wcześniejszym briefom' },
      ],
      default: 'Pliki evidence, ledger, review i sesji zapisuje SPLITBRIEF, nie fix task (FIX_BRIEF_EVIDENCE_RULE).',
    },
    {
      id: 'RV_CALL_FAILURE_KIND',
      title: 'Klasyfikacja nieudanego wywołania review',
      question: 'Dlaczego verdict call (lub plan call) nie dał odpowiedzi?',
      where: 'src/engine/orchestrator/final-review.ts:970',
      inputs: ['wyjątek', 'opts.signal.aborted', 'typedRunnerCallErrorCode', 'readApiContextDiagnostic', 'diagnosePlannerCallFailure'],
      branches: [
        { if: 'abort (stop użytkownika)', then: 'review_completed verdict stopped; reviewStatus failed bez failure; brak halt-u' },
        { if: 'sessionError.isLocalSaveFailure', then: 'rzucony dalej (błąd zapisu sesji)' },
        { if: 'kod input-too-large (narzędzie odmówiło) lub fit too-large', then: 'failure input-too-large: chars, maxChars, largestFiles; error review_input_too_large', next: 'RV_VERDICTLESS_HALT' },
        { if: 'seat-protocol-error (2 odpowiedzi poza schematem)', then: 'failure seat-protocol-error', next: 'RV_VERDICTLESS_HALT' },
        { if: 'diagnostic insufficient-context (seat api)', then: 'failure insufficient-context', next: 'RV_VERDICTLESS_HALT' },
        { if: 'diagnosePlannerCallFailure → seat-blocked (limit, odmowa konta, model odrzucony)', then: 'failure seat-blocked z diagnosis i resetsAt; bez wiersza error (halt sam go publikuje)', next: 'RV_VERDICTLESS_HALT' },
        { if: 'inny błąd (transport)', then: 'failure call-failed, code = kind błędu lub review-unavailable', next: 'RV_VERDICTLESS_HALT' },
      ],
      default: 'writeStatus failed; ledger finalReview.status failed; review_completed verdict no-verdict.',
      notes: 'Przy wyjątku pakiet review (review-packet.json) wciąż jest pisany dla zakresu final z finalReviewStatus failed.',
    },
    {
      id: 'RV_VERDICTLESS_HALT',
      title: 'Halt po review bez werdyktu',
      question: 'Jaki halt podnosi SPLITBRIEF, gdy review nie wydał werdyktu?',
      where: 'src/engine/orchestrator/run/review.ts:149',
      inputs: ['review.failure', 'review.reviewStatus', 'scope (task gdy phase implementing)'],
      branches: [
        { if: 'reviewStatus written', then: 'brak halt-u; dalej reviewPassed', next: 'RV_PASSED' },
        { if: 'failure input-too-large', then: 'buildReviewInputTooLargeRecoveryIssue: akcje accept-as-is (etykieta skip review, gdy final-review lub task review) i end-run; recommended end-run; bez retry', next: 'RV_ACCEPT_AS_IS_KIND' },
        { if: 'failure seat-protocol-error', then: 'seatProtocolHaltIssue (→ recovery)' },
        { if: 'failure seat-blocked', then: 'plannerCallHaltIssue seat review ze swap na runner reviewera: Seat down · retry-same-worker / switch-seat / retry-later / end-run; seatSwitches raz na run (→ recovery)' },
        { if: 'failure call-failed lub insufficient-context (lub written bez werdyktu)', then: 'buildNoVerdictReviewIssue: review-failed na seacie review, akcje retry-same-worker / end-run; insufficient-context dodaje Missing: ... i radę /crew review' },
      ],
      default: 'Każdy z tych halt-ów to Needs you lub Seat down (haltOf, src/core/recovery/halt.ts:51); scheduled task review najpierw QUEUE_TRIAGE, żeby następny brief nie wystartował.',
    },
    {
      id: 'RV_CLAIM_VERIFICATION',
      title: 'Weryfikacja claimów unverified własnymi checkami',
      question: 'Czy SPLITBRIEF uruchamia checki za kryteria i findingi, które reviewer zostawił unverified?',
      where: 'src/engine/orchestrator/final-review.ts:260',
      inputs: ['state.pendingTriage.inputs (source check?)', 'verdict.criteria status unverified', 'findings kind unverified w zakresie', 'criterion.checkIds / finding.checkIds'],
      branches: [
        { if: 'jest pending input source = check (czerwony check pre-review lub reviewera)', then: 'żadna weryfikacja; mapa pusta; unverified zostaje unverified', next: 'RV_RENDER_FORCED' },
        { if: 'brak checkIds dla claimu', then: 'brak wpisu: status zostaje unverified' },
        { if: 'checki: ktoś ma nowe failures (poza preExistingChecks)', then: 'fail', next: 'RV_OUTCOME' },
        { if: 'każdy check pass albo fail tylko pre-existing', then: 'pass: kryterium / finding zweryfikowane', next: 'RV_OUTCOME' },
        { if: 'któryś refused / not-runnable / unknown', then: 'unverified', next: 'RV_OUTCOME' },
      ],
      default: 'Weryfikacja zapisuje wpisy verification w review.json i recordCheckRuns w ledgerze.',
      notes: 'Render check też biegnie tu przez runChecks i może dać pass, gdy komenda renderu wyjdzie z kodem 0; dopiero RV_RENDER_FORCED wymusza unverified, gdy obraz nie dotarł.',
    },
    {
      id: 'RV_CLAIM_STATUS',
      title: 'Status weryfikacji jednego claimu',
      question: 'Co dały checki uruchomione za kryterium lub finding unverified?',
      where: 'src/engine/orchestrator/triage.ts:42',
      inputs: ['CheckRunResult[] z runChecks', 'newFailureKeys (klucze poza pre-existing)', 'preExistingChecks tego review'],
      branches: [
        { if: 'któryś bieg ma nowe failure keys', then: 'fail: claim obalony; kryterium fail / finding blocking zostaje', next: 'RV_RENDER_FORCED' },
        { if: 'każdy bieg pass, albo fail tylko z kluczami, które preExistingChecks tego samego checku widział na run base', then: 'pass: kryterium pass, finding unverified staje się notatką', next: 'RV_RENDER_FORCED' },
        { if: 'któryś bieg refused / not-runnable / unknown, albo brak biegów', then: 'unverified: claim niepotwierdzony; kryterium unverified = fail review', next: 'RV_RENDER_FORCED' },
      ],
      default: 'Wynik i output idą do review.json verification[] i do Checks Log (recordCheckRuns).',
      notes: 'Ta sama funkcja ocenia wpisy verify reviewera (runTriageVerification), ale ich wynik ląduje tylko w triage[].verification, nie w mapie werdyktu.',
    },
    {
      id: 'RV_RENDER_FORCED',
      title: 'Render bez obrazu nigdy nie przechodzi',
      question: 'Czy kryterium ma render check, którego żaden obraz nie dotarł do reviewera?',
      where: 'src/engine/orchestrator/review-renders.ts:215',
      inputs: ['renders.missingCheckIds', 'criterion.checkIds'],
      branches: [
        { if: 'tak', then: 'kryterium status = unverified w werdykcie i w mapie weryfikacji (nic nie może podnieść go do pass); wpisy verification nadpisane na unverified', next: 'RV_OUTCOME' },
        { if: 'nie', then: 'status reviewera lub wynik weryfikacji zostaje', next: 'RV_OUTCOME' },
      ],
      default: 'Unverified kryterium = review fail.',
    },
    {
      id: 'RV_FINDING_SCOPE',
      title: 'Finding w zakresie review',
      question: 'Czy finding należy do osądzanego zakresu?',
      where: 'src/core/review/verdict.ts:48',
      inputs: ['scope.kind', 'finding.taskId', 'finding.criterionId', 'scope.taskIds / criterionIds'],
      branches: [
        { if: 'scope final', then: 'każdy finding w zakresie, także bez taskId i criterionId' },
        { if: 'scope task i finding nazywa osądzany task lub due criterion (i nic spoza)', then: 'w zakresie: blocking blokuje, może dostać fix task' },
        { if: 'scope task i finding bez obu id, albo nazywa task / kryterium spoza', then: 'outOfScope: notatka Outside the task review scope; nie blokuje; nigdy fix task' },
      ],
      default: 'Final review osądzi go później.',
    },
    {
      id: 'RV_BLOCKING_RED',
      title: 'Które czerwone inputy blokują niezależnie od reviewera',
      question: 'Czy czerwony input (check lub Apply) nadal blokuje po odpowiedzi reviewera?',
      where: 'src/core/review/verdict.ts:92',
      inputs: ['input.source (check | apply | user)', 'input.notVerified', 'fixWork.rejected'],
      branches: [
        { if: 'source check lub apply, bez notVerified', then: 'blokuje zawsze, także gdy reviewer go odrzucił; review record redInputs; review.md Critical' },
        { if: 'source check z notVerified i reviewer odrzucił go z powodem', then: 'nie blokuje: jedyny czerwony, o którym decyduje reviewer' },
        { if: 'source check z notVerified, nieodrzucony', then: 'blokuje' },
        { if: 'source user (korekta użytkownika)', then: 'nie jest czerwonym inputem; reviewer odpowiada na niego jak na finding' },
      ],
      default: 'blockingRedInputs > 0 → outcome fail i halt bez Accept as is.',
    },
    {
      id: 'RV_OUTCOME',
      title: 'Wyliczenie pass / pass-with-notes / fail',
      question: 'Co decyduje o wyniku review?',
      where: 'src/core/review/verdict.ts:202',
      inputs: ['coverageErrors', 'unverifiedCriteria', 'blocking findings', 'redInputs', 'verdict.tasks[].plan', 'criteria[].status'],
      branches: [
        { if: 'coverage error, kryterium unverified, finding blocking (niezweryfikowany), czerwony input, task partial/missed, kryterium fail', then: 'fail' },
        { if: 'nic z tego, ale minor lub outOfScope > 0', then: 'pass-with-notes' },
        { if: 'nic z tego i zero notatek', then: 'pass' },
      ],
      default: 'Finding blocking kind unverified, którego checki dały pass, przechodzi do minor (notatka).',
      notes: 'Record idzie do state.review (RECORD_REVIEW), review.json i review.md (renderReviewMarkdown: Verdict, Tasks, Criteria Results, Findings Critical / Note, Pre-existing failures).',
    },
    {
      id: 'RV_PASSED',
      title: 'reviewPassed: czy run przechodzi',
      question: 'Czy werdykt i fix work razem oznaczają pass?',
      where: 'src/engine/orchestrator/run/review.ts:209',
      inputs: ['outcome.kind', 'fixWork.fixTasks / verify / ask', 'blockingRedInputs', 'recheckFailures (po Apply)'],
      branches: [
        { if: 'outcome pass lub pass-with-notes, 0 fixTasks, 0 verify, ask = null, 0 blokujących czerwonych, 0 recheck failures', then: 'REVIEW_DONE passed (reviewedCandidate zapisany); workflow_complete passed; onComplete', next: 'RV_AFTER_PASS' },
        { if: 'cokolwiek innego (także sama lista verify)', then: 'followReviewAnswer', next: 'RV_FOLLOW_ASK' },
      ],
      default: 'Scheduled task review używa tej samej funkcji z pustymi recheckFailures.',
      notes: 'Odpowiedź z samym verify (bez fixTasks) nie jest pass: idzie do applyTriage bez tasków i START_FIX_CYCLE wydaje cykl, po czym review biegnie znów.',
    },
    {
      id: 'RV_AFTER_PASS',
      title: 'Po pass: ready-to-apply czy closed',
      question: 'Gdzie są zmiany runu po pass lub Accept as is?',
      where: 'src/core/sessions/run-status.ts:178',
      inputs: ['state.phase complete', 'reviewStatus passed lub acceptedAsIs', 'state.workspace.kind', 'pendingRecovery'],
      branches: [
        { if: 'workspace undefined (starszy run) lub kind checkout', then: 'closed complete: zmiany już w checkoutcie, bez Apply; override zachowuje failed werdykt, blok Closed pokazuje needs attention' },
        { if: 'workspace worktree lub staged-copy, żaden proces nie trzyma runu, brak halt-u', then: 'ready-to-apply { override: reviewStatus != passed }: menu Apply (Apply as is) · Show diff · Discard (→ lifecycle)' },
        { if: 'proces trzyma run', then: 'running (Apply może trwać)' },
      ],
      default: 'Apply, Discard albo End run zamyka run; End run na ready zachowuje run.patch i zamyka jako discarded.',
    },
    {
      id: 'RV_FOLLOW_ASK',
      title: 'Reviewer zadał pytanie użytkownikowi',
      question: 'Czy fixWork.ask jest ustawione?',
      where: 'src/engine/orchestrator/run/review.ts:248',
      inputs: ['fixWork.ask { question, whyOnlyUserCanAnswer }', 'callbacks.onPlannerReply'],
      branches: [
        { if: 'ask != null', then: 'QUEUE_TRIAGE z pytaniem; waitForPlannerReply (composer: Reply to the reviewer…)', next: 'RV_ASK_REPLY' },
        { if: 'ask = null', then: 'dalej do limitu cykli', next: 'RV_CAP' },
      ],
      default: 'Pytanie służy tylko zmianie tego, co jest budowane, gdy plan i decyzje nie odpowiadają.',
    },
    {
      id: 'RV_ASK_REPLY',
      title: 'Odpowiedź użytkownika na pytanie reviewera',
      question: 'Czy użytkownik odpowiedział?',
      where: 'src/engine/orchestrator/run/review.ts:266',
      inputs: ['reply z waitForPlannerReply (undefined bez ekranu lub po stopie)'],
      branches: [
        { if: 'reply = undefined', then: 'haltFailedReview z detail: The review asked a question this run has no way to answer', next: 'RV_HALT_FAILED_REVIEW' },
        { if: 'tekst', then: 'input A n kind answer source user dopisany; recordUserMessage; reviewAgain = true: ten sam kandydat, bez checków (RV_REVIEW_AGAIN)', next: 'RV_REVIEW_AGAIN' },
      ],
      default: 'Pytanie zapisane w pendingTriage.question przeżywa stop: answerPendingReviewQuestion zadaje je znów po kontynuacji.',
    },
    {
      id: 'RV_CAP',
      title: 'Limit cykli naprawczych',
      question: 'Czy run wydał już wszystkie cykle naprawcze?',
      where: 'src/engine/orchestrator/run/review.ts:300',
      inputs: ['fixCyclesOf(state): used, allowance (REVIEW_CYCLE_CAP = 2, +BOUNDS.extraFixCyclesPerRun = 1 za każdą korektę przy wyczerpanym capie)'],
      branches: [
        { if: 'used >= allowance', then: 'haltFailedReview z fixCycles: Final review failed after 2 fix cycles', next: 'RV_HALT_FAILED_REVIEW' },
        { if: 'used < allowance', then: 'dalej', next: 'RV_NOTHING_TO_FIX' },
      ],
      default: 'Re-review po Apply też liczy się jako cykl; scheduled task review, który przeszedł, nie wydaje cyklu.',
    },
    {
      id: 'RV_NOTHING_TO_FIX',
      title: 'Fail bez niczego do naprawy',
      question: 'Czy fix work ma fix tasks albo verify?',
      where: 'src/engine/orchestrator/run/review.ts:312',
      inputs: ['fixWork.fixTasks', 'fixWork.verify', 'outcome.unverifiedCriteria', 'recheckFailures'],
      branches: [
        { if: '0 fixTasks i 0 verify', then: 'haltFailedReview: detail = recheck failures, albo Unverified criteria: ..., albo blocking; message failed with N unverified criteria / N blocking findings', next: 'RV_HALT_FAILED_REVIEW' },
        { if: 'są fixTasks lub verify', then: 'applyTriage + startFixCycle', next: 'RV_FIX_CHECK_JUDGE' },
      ],
      default: 'Fix tasks: INSERT_TASKS parentId null (dopisane na końcu lub po afterTaskId), batch = najwyższy batch planu + cykl, task.fix.findings z checkIds, commands, failureKeys, redKeys, output; tasks.md przepisany.',
    },
    {
      id: 'RV_HALT_FAILED_REVIEW',
      title: 'Halt review-failed: trzy warianty',
      question: 'Jak SPLITBRIEF zapisuje nieudany review i co oferuje?',
      where: 'src/engine/orchestrator/run/review.ts:84',
      inputs: ['state.review.scope i phase implementing (scheduled)', 'blockingRedInputs (redPending)', 'blocking = findings + red'],
      branches: [
        { if: 'scheduled task review', then: 'queueScheduledTriage (QUEUE_TRIAGE z inputami); run zostaje implementing; acceptAsIs = false; akcje revise (fix again), end-run' },
        { if: 'final i czerwony input blokuje', then: 'faza zostaje final-review (bez REVIEW_DONE); acceptAsIs = false; akcje revise, end-run' },
        { if: 'final bez czerwonego', then: 'REVIEW_DONE failed (phase complete, reviewStatus failed); workflow_complete review failed; acceptAsIs = true; akcje revise, accept-as-is, end-run' },
      ],
      default: 'Zawsze: error row "<message>; see review.md" (code review_failed) i raisePendingRecovery → Needs you (→ recovery).',
    },
    {
      id: 'RV_REVIEW_CORRECTION',
      title: 'fix again z notatką (revise)',
      question: 'Co robi korekta użytkownika na halt-cie review-failed?',
      where: 'src/core/state/machine.ts:472',
      inputs: ['state.phase', 'state.review.scope', 'pendingRecovery.reason', 'fixCycles', 'tekst korekty'],
      branches: [
        { if: 'phase implementing i review scope task', then: 'input U n (source user) do pendingTriage; faza zostaje implementing; scheduled review biegnie znów' },
        { if: 'phase complete z reviewStatus failed, lub final-review z halt-em review-failed', then: 'faza final-review; reviewStatus i completedAt wyczyszczone; input U n dopisany' },
        { if: 'dodatkowo used >= allowance', then: 'allowance + 1 (BOUNDS.extraFixCyclesPerRun); notatka w fixCycles.notes' },
        { if: 'inna faza (np. po pass)', then: 'błąd invalidActionForPhase: korekta odrzucona' },
      ],
      default: 'Pusta korekta nie dodaje inputu, ale i tak wraca do review. Review biegnie na tym samym kandydacie bez checków (reviewsAgain).',
    },
    {
      id: 'RV_FIX_CHECK_JUDGE',
      title: 'Bramka fix tasku: czy czerwona komenda reviewera jest naprawiona',
      question: 'Jak SPLITBRIEF ocenia ponowny bieg komendy V w bramce fix briefu?',
      where: 'src/core/review/fix-task.ts:97',
      inputs: ['carried: failureKeys (własne klucze fix tasku) i redKeys (wszystkie klucze oryginalnego czerwonego)', 'wynik ponownego biegu'],
      branches: [
        { if: 'brak własnych kluczy albo placeholder w wyniku (timeout, niekompletny capture)', then: 'brak osądu: komenda musi po prostu przejść' },
        { if: 'komenda pass', then: 'proven = true: wszystkie własne failures zniknęły' },
        { if: 'któryś własny klucz nadal czerwony (dokładnie lub tą samą tożsamością diagnostyki)', then: 'brief fail: your N failures remain' },
        { if: 'własne zniknęły, ale ponowny bieg nie pokazuje żadnego klucza z oryginalnego czerwonego (źródło nie dowiedzione)', then: 'not proven fixed: brief fail' },
        { if: 'własne zniknęły i inny oryginalny klucz nadal widoczny', then: 'pass: your N failures gone, M others left; inne failures należą do innych fix tasków lub następnego review' },
      ],
      default: 'Fail briefu idzie w drabinkę: 1 retry, potem konsultacja seat-a review (fix task konsultuje reviewera, nie plannera) (→ build).',
      notes: 'fixReviewChecks buduje checki z finding.commands[id] dla id V n; fix check nigdy nie wraca na run base, ale run base dalej daje odmowę zmienionej definicji.',
    },
    {
      id: 'RV_SCHEDULED_PASS',
      title: 'Wynik scheduled task review',
      question: 'Czy zawężony review po briefie przeszedł?',
      where: 'src/engine/orchestrator/run/review.ts:431',
      inputs: ['reviewPassed(outcome, fixWork, pendingTriage.inputs, [])'],
      branches: [
        { if: 'pass', then: 'CLEAR_SCHEDULED_REVIEW; status continue; cykl nie wydany; następny brief' },
        { if: 'fail z fix tasks', then: 'followReviewAnswer: INSERT_TASKS po afterTaskId, START_FIX_CYCLE (wydaje cykl); pętla czyta listę od nowa' },
        { if: 'fail z pytaniem i odpowiedzią', then: 'review znów na tym samym kandydacie (pętla for w runScheduledReview)' },
        { if: 'halt (bez werdyktu, cap, nic do naprawy)', then: 'status stopped; pętla briefów kończy się stopped; halt bez Accept as is' },
      ],
      default: 'Final review i tak osądzi całość na końcu, także po Skip review.',
    },
    {
      id: 'RV_ACCEPT_AS_IS_KIND',
      title: 'Accept as is / Skip review: co zapisuje i gdzie ląduje run',
      question: 'Na jakim halt-cie i w jakiej fazie użytkownik wybrał accept-as-is?',
      where: 'src/engine/orchestrator/recovery/actions.ts:424',
      inputs: ['issue.reason (review-failed | review-input-too-large)', 'state.phase', 'opts.comment (notatka)', 'readCriticalFindings z review.md'],
      branches: [
        { if: 'review-input-too-large i phase implementing (task review)', then: 'CLEAR_SCHEDULED_REVIEW + ACCEPT_AS_IS findings = [treść halt-u]; następny brief startuje; final review później nadpisze (REVIEW_DONE czyści acceptedAsIs)' },
        { if: 'review-input-too-large w final-review', then: 'REVIEW_DONE failed + ACCEPT_AS_IS; Apply ostrzega: unreviewed, pyta raz' },
        { if: 'review-failed (final, bez czerwonego inputu)', then: 'ACCEPT_AS_IS findings = Critical z review.md, note; applyReview i pendingTriage wyczyszczone' },
        { if: 'review-failed z czerwonym inputem, scheduled task review z werdyktem', then: 'akcja niedostępna (nie ma jej na liście halt-u)' },
      ],
      default: 'Potem deriveRunStatus (RV_AFTER_PASS): worktree/staged-copy → ready-to-apply override; checkout → closed complete. Headless kończy z kodem 0.',
    },
  ],
  config: [
    { key: 'validation.end_checks', values: 'true | false', default: 'true', effect: 'Włącza plan call i checki reviewera przed każdym review (final i task). Off: wiersz End-of-run checks · off; biegną tylko checki planu i briefów.', where: 'src/core/config/runtime/resolve.ts:10' },
    { key: 'validation.approve_checks', values: 'auto | ask', default: 'auto', effect: 'ask: karta Reviewer checks z Run all / Skip all przed biegiem komend; headless bez ekranu = żadna nie biegnie; skip nigdy nie jest pass. Bez efektu gdy end_checks off.', where: 'src/core/config/runtime/resolve.ts:15' },
    { key: 'validation.render', values: 'komenda z {id} i {out}', default: 'brak', effect: 'Szablon render checków planu. Brak = każdy render check not-runnable (required → halt). PNG z {out} trafiają do rendersDir sesji i do promptu reviewera (do 4 na check).', where: 'src/engine/orchestrator/validation/run-checks.ts:293' },
    { key: 'validation.test_command', values: 'argv bez shella', default: 'brak', effect: 'Pierwszy szczebel drabinki komendy dla planner test check; biegnie as-is, bez dopisania pliku. Bez niego stack poza 5 rejestrowymi daje not-runnable.', where: 'src/engine/orchestrator/validation/run.ts (planTestCheck); docs/CONFIGURATION.md §How a test check resolves its command' },
    { key: 'validation.test_pattern', values: 'wzorzec z jednym *', default: 'wzorce stacku', effect: 'Jak SPLITBRIEF znajduje pliki testów obok zmienionego pliku dla test check.', where: 'src/engine/orchestrator/planning/sanitize-discovered-validation.ts:500' },
    { key: 'validation.timeout_ms', values: 'int >= 1000', default: 'STAGE_TIMEOUT_MS', effect: 'Limit czasu każdej komendy checku, także base re-run i renderów. Timeout = fail z placeholderem timed out (zawsze zatrzymuje listę, nigdy pre-existing).', where: 'src/engine/orchestrator/validation/run-checks.ts:140' },
    { key: 'validation.stack', values: 'typescript | javascript | python | go | rust', default: 'detekcja', effect: 'Przypina stack dla drabinki test check i wzorców testów.', where: 'src/core/schemas/config.ts:82' },
    { key: 'workflow.review', values: 'end | task', default: 'end', effect: 'task: zawężony review (pre-review required checków, plan call tylko testy związane, werdykt na ukończone taski i due criteria) po każdym briefie, który przeszedł walidację.', where: 'src/engine/orchestrator/task/loop.ts:270' },
    { key: 'workflow.isolation', values: 'worktree | staged-copy | none', default: '→ lifecycle', effect: 'Decyduje, co dzieje się po pass: worktree/staged-copy → ready-to-apply; none (checkout) → closed complete bez Apply. W checkout komendy biegną w Twoim checkoutcie.', where: 'src/core/sessions/run-status.ts:178' },
    { key: 'workflow.approve', values: 'plan | none', default: 'plan', effect: 'planApprovesNpmScripts: tylko zatwierdzony plan pozwala plan check uruchomić npm run <script>. Reviewer checks nie potrzebują tej zgody (porównanie z run base zamiast niej).', where: 'src/engine/orchestrator/validation/run-checks.ts:87' },
    { key: 'reviewer (blok)', values: 'runner kind cli | api | shell | agent', default: 'planner trzyma seat review', effect: 'Kto wykonuje plan call, verdict call i konsultacje fix tasków. api dostaje pakiet (bez narzędzi), reszta czyta workspace. imageInput narzędzia decyduje o renderach.', where: 'src/core/config/accessors/reviewer-runner.ts (resolveReviewerRunner); → runners' },
    { key: 'REVIEW_CYCLE_CAP (stała)', values: '2', default: '2', effect: 'Automatyczne cykle naprawcze na run. Każda korekta przy wyczerpanym capie dodaje BOUNDS.extraFixCyclesPerRun = 1.', where: 'src/core/pipeline-spec/review.ts:3; src/core/pipeline-spec/bounds.ts:8' },
    { key: 'MAX_REVIEW_CHECKS (stała)', values: '6', default: '6', effect: 'Najwięcej komend w jednym planie reviewera; komendy pending ponad limit czekają z wierszem not run.', where: 'src/core/schemas/review.ts:94' },
    { key: 'MAX_RENDER_IMAGES_PER_CHECK (stała)', values: '4', default: '4', effect: 'PNG na render check w promptcie; frame.png najpierw.', where: 'src/engine/orchestrator/review-renders.ts:10' },
    { key: 'MAX_FILE_CHARS / MAX_PROJECT_CHARS (stałe)', values: '8 000 / 40 000', default: 'jw.', effect: 'Ile tekstu plików projektu (manifesty, Makefile, CI, README) dostaje seat api w plan call.', where: 'src/engine/orchestrator/review-checks.ts:77' },
    { key: 'CLI_TOOL_CATALOG[tool].maxInputChars', values: 'Codex 1 048 576; inne brak', default: 'brak capu', effect: 'Cap promptu review dla narzędzia cli; uruchamia fitReviewPrompt i halt review-input-too-large.', where: 'src/core/runners/cli-tool-catalog.ts:414; src/engine/orchestrator/final-review.ts:380' },
  ],
  states: [
    { name: 'final-review (phase)', meaning: 'Run jest w review: po ALL_DONE, po REVIEW_CORRECTION, po APPLY_REVIEW_START, albo zatrzymany na halt-cie review bez werdyktu lub z czerwonym inputem.', where: 'src/core/state/machine.ts:415' },
    { name: 'complete (phase) + reviewStatus passed', meaning: 'Review przeszedł. Worktree/staged-copy: ready-to-apply. Checkout/brak workspace: closed complete.', where: 'src/core/state/machine.ts:418' },
    { name: 'complete (phase) + reviewStatus failed', meaning: 'Final review nie przeszedł bez czerwonego inputu; halt review-failed z fix again / Accept as is / End run.', where: 'src/engine/orchestrator/run/review.ts:90' },
    { name: 'acceptedAsIs', meaning: 'Override użytkownika: findings i notatka. Daje ready-to-apply override albo closed complete; REVIEW_DONE czyści go.', where: 'src/core/state/machine.ts:548' },
    { name: 'review.outcome: pass | pass-with-notes | fail', meaning: 'Wynik wyliczony przez deriveReviewOutcome, zapisany w state.review i review.json.', where: 'src/core/review/verdict.ts:202' },
    { name: 'CheckStatus: pass | fail | refused | not-runnable | unknown', meaning: 'Status jednego biegu checku. Tylko pass i fail są wynikami; reszta to brak możliwości osądu (required → halt).', where: 'src/engine/orchestrator/validation/run-checks.ts:45' },
    { name: 'full_suite moment: plan | pre-review | base | brief', meaning: 'Wiersz checku: plan = pre-review checków planu/briefów; pre-review = komenda reviewera; base = base re-run; brief = fix check w bramce briefu.', where: 'src/engine/orchestrator/events.ts:263' },
    { name: 'pending input ids: P n / V k.n / A n / U n', meaning: 'P = required check pre-review; V k.n = komenda reviewera V k; A n = recheck po Apply lub odpowiedź użytkownika (kind answer); U n = korekta użytkownika (revise).', where: 'src/engine/orchestrator/run/pre-review-checks.ts:81; src/engine/orchestrator/review-checks.ts:626; src/core/state/machine.ts:485' },
    { name: 'pendingReviewCommands', meaning: 'Komendy reviewera, które fix check uruchomił od ostatniego review; następny plan call musi wybrać je pierwsze; zdejmowane po biegu (discharged).', where: 'src/engine/orchestrator/final-review.ts:925' },
    { name: 'fixCycles { used, allowance, notes }', meaning: 'Wydane i dozwolone cykle naprawcze; notes = korekty, które dodały cykl.', where: 'src/core/schemas/workflow.ts:530' },
    { name: 'pendingScheduledReview', meaning: 'Marker scheduled task review (afterTaskId); blokuje start następnego briefu do odpowiedzi; CLEAR_SCHEDULED_REVIEW zdejmuje.', where: 'src/core/state/machine.ts:986' },
  ],
  scenarios: [
    {
      title: 'Ścieżka szczęśliwa: worktree, domyślna konfiguracja, wszystko zielone',
      steps: [
        '1. Ostatni brief przechodzi; runTasksAndReview widzi status complete i phase implementing.',
        '2. captureReviewedCandidate zapisuje fingerprinty kandydata; ALL_DONE → final-review.',
        '3. runPreReview uruchamia każdy check planu i briefów (wiersze Plan check K1 · npm run lint · passed).',
        '4. end_checks on: plan call; reviewer wybiera V1 npm test, V2 npm run typecheck.',
        '5. approve_checks auto: V1 pass, V2 pass; sekcja Reviewer checks: passed.',
        '6. fitReviewPrompt mieści się; verdict call; ReviewAnswer z tasks met, criteria pass, 0 findings, 0 fix work.',
        '7. Brak unverified: weryfikacja claimów nic nie robi. deriveReviewOutcome = pass.',
        '8. reviewPassed true → REVIEW_DONE passed, workflow_complete, review-packet.json i review.md zapisane.',
      ],
      outcome: 'deriveRunStatus = ready-to-apply (override false). Ekran pokazuje Apply · Show diff · Discard (→ lifecycle).',
    },
    {
      title: 'Komenda reviewera czerwona z nowymi failures → fix task → bramka → drugi review',
      steps: [
        '1. Plan call: V1 npm test, V2 npm run lint. V1 fail: klucze test/a.test.ts::parses, src/x.ts:12 error.',
        '2. Base re-run V1 na kopii run base: pass. Wiersz Base re-run · 2 new, 0 pre-existing.',
        '3. fresh = 2 → stoppedBy = V1; V2 dostaje wiersz not run · V1 failed. Inputy V1.1 (plik test/a.test.ts) i V1.2 (plik src/x.ts).',
        '4. Verdict call: reviewer odpowiada fixTasks [T007 z findingIds [V1.1, V1.2]], tasks met, criteria pass. Outcome fail (redInputs blokują).',
        '5. reviewPassed false; followReviewAnswer: ask null, used 0 < 2, fixTasks > 0 → applyTriage: T007 batch = max+1, task.fix z commands {V1: npm test}, failureKeys, redKeys.',
        '6. START_FIX_CYCLE used = 1, phase implementing, review_fix_started. Pętla buduje T007; bramka briefu uruchamia npm test (fixReviewChecks) i judgeFixCheck: własne klucze zniknęły, proven → pass.',
        '7. Komenda npm test ląduje w pendingReviewCommands. Następny review: plan call musi wybrać npm test jako V1; przechodzi; verdict pass.',
      ],
      outcome: 'REVIEW_DONE passed po 1 cyklu; ready-to-apply. Gdyby T007 nie naprawił własnych kluczy: retry, konsultacja seat-a review, ewentualnie halt (→ build).',
    },
    {
      title: 'Czerwona komenda także na run base: pre-existing, brak findingu',
      steps: [
        '1. V1 npm test fail z kluczem test/old.test.ts::legacy w workspace.',
        '2. Base re-run: fail z tym samym kluczem. preExisting = [legacy], newKeys = []. Wiersz Base re-run · 0 new, 1 pre-existing.',
        '3. fresh = 0: preExistingChecks += V1; brak inputu; lista biegnie dalej (V2 pass).',
        '4. Sekcja Reviewer checks: V1 failed, 0 new failure(s); 1 pre-existing (also red at the run base). Prompt każe nie podnosić findingu.',
        '5. Reviewer zostawia kryterium unverified z checkIds [V1]? Weryfikacja: run V1 fail tylko pre-existing → status pass.',
      ],
      outcome: 'Outcome pass; review.md ma sekcję Pre-existing failures z V1 i kluczem legacy; run ready-to-apply.',
    },
    {
      title: 'approve_checks: ask, użytkownik wybiera Skip all',
      steps: [
        '1. Plan call wybiera V1, V2. RECORD_REVIEW_CHECKS; wiersz Reviewer checks · chose 2.',
        '2. onReviewChecksApproval otwiera kartę Reviewer checks · chose 2 · none has run yet. Użytkownik: Skip all.',
        '3. skipReason = Skip all was chosen on the card; drugi RECORD_REVIEW_CHECKS ze skipped; review_checks skipped; stare V-inputy usunięte.',
        '4. Sekcja mówi: żadna komenda nie jest pass; oznacz kryterium, które weryfikują tylko one, jako unverified.',
        '5. Reviewer oznacza C2 unverified z checkIds [V1]. enabledReviewChecks = [] (plan skipped), więc V1 nie jest zarejestrowanym checkiem: weryfikacja claimu nic nie uruchamia → unverified.',
        '6. Outcome fail (unverifiedCriteria). followReviewAnswer: 0 fixTasks, 0 verify → haltFailedReview z unverified = 1.',
      ],
      outcome: 'REVIEW_DONE failed; halt Needs you · Final review failed with 1 unverified criterion; akcje fix again / Accept as is / End run.',
    },
    {
      title: 'Headless --json z approve_checks: ask',
      steps: [
        '1. Brak callbacku onReviewChecksApproval (run bez ekranu).',
        '2. skipReason = validation.approve_checks is ask and this run has no screen to ask on.',
        '3. Żadna komenda nie biegnie; wiersz Reviewer checks · not run V1, V2 · ...no screen to ask on.',
      ],
      outcome: 'Review biegnie bez checków reviewera; skip nigdy nie jest pass, więc kryteria zależne od nich są unverified.',
    },
    {
      title: 'Plan call: dwie odpowiedzi poza schematem (błąd protokołu)',
      steps: [
        '1. requestTyped: pierwsza odpowiedź nie ma reason przy 0 komend; freshRepairPrompt z błędami; druga odpowiedź też zła.',
        '2. runReviewChecks zwraca kind protocol-error; runFinalReviewPhase ustawia failure seat-protocol-error i rzuca.',
        '3. catch: message = error.message; publishError review_failed; writeStatus failed; review_completed no-verdict.',
        '4. haltVerdictlessReview → seatProtocolHaltIssue → raisePendingRecovery.',
      ],
      outcome: 'Run stoi w final-review na halt-cie protokołu seat-a (→ recovery). Nic nie jest pass.',
    },
    {
      title: 'Verdict call trafia na limit konta Codex (seat down)',
      steps: [
        '1. runReviewerCall rzuca wyjątek z tekstem limitu i resetem.',
        '2. catch: diagnosePlannerCallFailure → failure seat-blocked z diagnosis.resetsAt; bez wiersza error z final-review.',
        '3. haltVerdictlessReview: plannerCallHaltIssue seat review, swap na runner reviewera, seatSwitches; publishError z resetAt.',
        '4. Halt Seat down · <cause>: retry-same-worker, switch-seat (jeśli jest fallback lub wykryte narzędzie), retry-later, end-run.',
      ],
      outcome: 'Automatyczny switch na fallback raz na run i seat, gdy to odmowa konta lub reset dalej niż 10 minut (BOUNDS.rateLimitResetWaitMs) (→ recovery).',
    },
    {
      title: 'Codex jako reviewer, prompt za duży po trzech przycięciach',
      steps: [
        '1. maxInputChars = 1 048 576. fitReviewPrompt: text > cap.',
        '2. Przycięcie 1: całe nowe pliki → jedna linia. Nadal za duży. Przycięcie 2: diffy plików niezadeklarowanych usunięte. Przycięcie 3: Checks Log i drift → ścieżki.',
        '3. Nadal za duży → kind too-large; failure input-too-large z 5 największymi diffami; throw przed wywołaniem.',
        '4. catch: message Review input is N characters; Codex takes at most 1,048,576; error review_input_too_large.',
        '5. haltVerdictlessReview: buildReviewInputTooLargeRecoveryIssue acceptAsIs = true (final-review): akcje skip review, end run; recommended end-run.',
      ],
      outcome: 'Skip review: REVIEW_DONE failed + ACCEPT_AS_IS → ready-to-apply unreviewed, Apply pyta raz. End run: run.patch zapisany, workspace usunięty (→ lifecycle).',
    },
    {
      title: 'Dwa cykle naprawcze wyczerpane; użytkownik daje notatkę, potem Accept as is',
      steps: [
        '1. Review 3 (used = 2) nadal fail z 1 blocking finding i fix task. followReviewAnswer: ask null; used 2 >= allowance 2 → haltFailedReview fixCycles = 2.',
        '2. Brak czerwonego inputu: REVIEW_DONE failed; workflow_complete failed; halt Needs you · Final review failed after 2 fix cycles; akcje fix again, Accept as is, End run.',
        '3. Użytkownik: fix again z notatką. REVIEW_CORRECTION: input U1, phase final-review, allowance 3, notes [notatka].',
        '4. reviewsAgain true: verdict call bez checków, z inputem U1. Reviewer odpowiada fixTasks → cykl 3. Fix task przechodzi; review 4 nadal fail (blocking); used 3 >= 3 → halt znów.',
        '5. Użytkownik: Accept as is. readCriticalFindings z review.md; ACCEPT_AS_IS findings + note.',
      ],
      outcome: 'ready-to-apply override = true; menu Apply as is · Show diff · Discard; Apply wylicza findings i pyta raz (/run accept confirm). Werdykt failed zostaje w review.json.',
    },
    {
      title: 'Tryb checkout (workflow.isolation: none): pass zamyka run bez Apply',
      steps: [
        '1. Workspace kind checkout: komendy pre-review i reviewera biegną w Twoim checkoutcie; base re-run nadal na kopii poza nim.',
        '2. captureCandidate zwraca undefined (nie worktree/staged-copy): REVIEW_DONE bez reviewedCandidate.',
        '3. reviewPassed → REVIEW_DONE passed.',
      ],
      outcome: 'deriveRunStatus: phase complete, passed, workspace checkout → closed complete. Brak Apply, brak run.patch; zmiany już są na dysku.',
    },
    {
      title: 'workflow.review: task — review po briefie T002 z findingiem spoza zakresu',
      steps: [
        '1. T002 przechodzi walidację; loop.ts widzi review = task → runScheduledReview afterTaskId T002; START_SCHEDULED_REVIEW.',
        '2. runPreReview scope task: tylko required checki T001, T002 i due criteria (kryteria, których wszystkie taski są done).',
        '3. Plan call zakres task: reviewer wybiera testy związane z plikami T002 (nie całą suitę). Biegną, zielone.',
        '4. Verdict: finding blocking z taskId T005 (pending) → findingInReviewScope false → outOfScope: notatka; nie blokuje.',
        '5. Outcome pass-with-notes; reviewPassed true → CLEAR_SCHEDULED_REVIEW; status continue; cykl nie wydany.',
      ],
      outcome: 'Pętla idzie do T003. Final review na końcu osądzi także T005.',
    },
    {
      title: 'Reviewer zadaje pytanie (ask); użytkownik odpowiada',
      steps: [
        '1. ReviewAnswer z ask { question, whyOnlyUserCanAnswer } (schema pozwala wtedy nie odpowiadać na każdy finding).',
        '2. reviewPassed false (ask != null). followReviewAnswer: QUEUE_TRIAGE z question; waitForPlannerReply: composer Reply to the reviewer…',
        '3. Użytkownik pisze odpowiedź: input A1 kind answer source user; recordUserMessage; reviewAgain = true.',
        '4. Pętla w runTasksAndReview: answerPendingReviewQuestion nic (pytanie już odpowiedziane); reviewsAgain true → bez recheck, bez pre-review, bez plan call; verdict call z inputem A1.',
      ],
      outcome: 'Reviewer osądza ten sam kandydat z odpowiedzią. Bez ekranu (reply undefined) halt review-failed z detail: the review asked a question this run has no way to answer.',
    },
  ],
  files: [
    { path: 'src/engine/orchestrator/run/task-execution.ts', role: 'runTasksAndReview: pętla review końcowego (capture kandydata, recheck po Apply, pre-review, runFinalReviewPhase, reviewPassed, fix tasks)' },
    { path: 'src/engine/orchestrator/run/review.ts', role: 'haltVerdictlessReview, haltFailedReview, reviewPassed, followReviewAnswer, runScheduledReview (task cadence)' },
    { path: 'src/engine/orchestrator/run/pre-review-checks.ts', role: 'runPreReview: checki planu i briefów przed review, inputy P n, halt required-checks-unrunnable' },
    { path: 'src/engine/orchestrator/final-review.ts', role: 'runFinalReviewPhase: run universe, checki reviewera, prompt (api / fit), verdict call, weryfikacja claimów, outcome, RECORD_REVIEW, catch z klasyfikacją błędu, review packet' },
    { path: 'src/engine/orchestrator/review-checks.ts', role: 'runReviewChecks: plan call, karta ask, bieg komend, base re-run (preExistingKeys, splitAtRunBase), reguła stopu, sekcja Reviewer checks' },
    { path: 'src/engine/orchestrator/review-call.ts', role: 'runReviewerCall: typowane wywołanie seat-a review przez requestTyped; usage do kubełka reviewer' },
    { path: 'src/engine/orchestrator/review-plan.ts', role: 'reviewPlanData i reviewOperatorInstructions: plan i instrukcje operatora w promptach review' },
    { path: 'src/engine/orchestrator/review-renders.ts', role: 'reviewRenders (do 4 PNG na check, manifest, no-vision), forceUnverifiedRenderCriteria' },
    { path: 'src/engine/orchestrator/api-review-context.ts', role: 'buildApiReviewContext: pakiet dla seat-a api, insufficient-context' },
    { path: 'src/engine/orchestrator/triage.ts', role: 'triageContractErrors, fixTaskTargetErrors, verifyClaimChecks, runTriageVerification, applyTriage (INSERT_TASKS), startFixCycle' },
    { path: 'src/engine/orchestrator/validation/reviewer-command-policy.ts', role: 'reviewerCommandRefusal: wszystkie reguły odmowy; REVIEWER_COMMAND_RULES w promptcie; checkDefinition' },
    { path: 'src/engine/orchestrator/validation/changed-script.ts', role: 'changedDefinitionRefusal: definicja checku zmieniona wobec run base' },
    { path: 'src/engine/orchestrator/validation/run-checks.ts', role: 'createCheckRunner / runChecks: render, cmd, test; statusy; checkRegistry; enabledReviewChecks' },
    { path: 'src/engine/orchestrator/validation/failure-text.ts', role: 'checkFailureText, newFailureKeys, failureKeysForFile' },
    { path: 'src/engine/orchestrator/validation/extract-failure-keys.ts', role: 'failureKeys: klucze failures i placeholdery (timed out, output over the capture limit, without diagnostics)' },
    { path: 'src/core/review/verdict.ts', role: 'reviewScopeFor, reviewsAgain, findingInReviewScope, blockingRedInputs, verdictCoverageErrors, deriveReviewOutcome' },
    { path: 'src/core/review/fix-task.ts', role: 'fixReviewChecks, fixCheckKeys, judgeFixCheck, fixCheckVerdict, fixBriefDescription' },
    { path: 'src/core/review/base-split.ts', role: 'baseSplit i baseSplitNames: słowa wiersza Base re-run' },
    { path: 'src/core/review/render.ts', role: 'renderReviewMarkdown: review.md' },
    { path: 'src/core/review/store.ts', role: 'readReviewRecord / readFinalReviewRecord: review.json' },
    { path: 'src/core/schemas/review.ts', role: 'ReviewVerdictSchema, TriageResultSchema, TriageInputSchema, ReviewChecksPlanSchema, REVIEW_CHECK_ID, MAX_REVIEW_CHECKS' },
    { path: 'src/engine/orchestrator/evidence/review-packet/sections-io.ts', role: 'resolveRunUniverse: zmiany runu vs praca użytkownika; buildFinalReview pakietu' },
    { path: 'src/engine/orchestrator/evidence/review-packet/run-scope.ts', role: 'resolveRunReviewScope: diffy per plik z review-changes.json, provenance' },
    { path: 'src/engine/orchestrator/evidence/review-packet/fit.ts', role: 'fitReviewPrompt: trzy przycięcia i too-large' },
    { path: 'src/engine/orchestrator/evidence/review-packet/build.ts', role: 'buildReviewPacket: review-packet.json / .md (tylko final scope)' },
    { path: 'src/engine/orchestrator/evidence/review-capture.ts', role: 'captureTaskReviewChanges: before/after plików briefu do review-changes.json' },
    { path: 'src/engine/orchestrator/recovery/builders/task.ts', role: 'buildReviewFailedRecoveryIssue (revise / accept-as-is / end-run), buildNoVerdictReviewIssue' },
    { path: 'src/engine/orchestrator/recovery/builders/review-input.ts', role: 'buildReviewInputTooLargeRecoveryIssue' },
    { path: 'src/engine/orchestrator/recovery/builders/checks.ts', role: 'buildRequiredChecksUnrunnableRecoveryIssue' },
    { path: 'src/engine/orchestrator/recovery/actions.ts', role: 'applyAcceptAsIsRecoveryAction, applyReviewCorrectionAction' },
    { path: 'src/core/state/machine.ts', role: 'ALL_DONE, REVIEW_DONE, RECORD_REVIEW, START_FIX_CYCLE, REVIEW_CORRECTION, QUEUE_TRIAGE, ACCEPT_AS_IS, START/CLEAR_SCHEDULED_REVIEW' },
    { path: 'src/core/sessions/run-status.ts', role: 'deriveRunStatus: ready-to-apply vs closed complete po pass lub override' },
    { path: 'src/stores/review-checks-prompt/prompt.ts', role: 'kanał karty Reviewer checks (Run all / Skip all / undefined)' },
    { path: 'src/features/workflow/review-checks/options.ts', role: 'wiersze karty Run all i Skip all i ich konsekwencje' },
    { path: 'src/engine/spec/prompts/review.ts', role: 'prompt werdyktu: instrukcje, kontrakt fix work, Required Results' },
    { path: 'src/engine/spec/prompts/review-checks.ts', role: 'prompt plan call: reguły wyboru komend' },
    { path: 'src/engine/orchestrator/events.ts', role: 'publishReviewChecksPlan (review_checks), publishReviewCheck (full_suite), publishFixCycleStarted (review_fix_started)' },
  ],
  gotchas: [
    'Nieudane wywołanie (plan call lub verdict call) nigdy nie jest pass: run stoi na halt-cie i czeka. Jedyna droga naprzód bez werdyktu to Skip review / Accept as is (gdy oferowane) albo End run.',
    'Komenda refused lub not-runnable to nie fail i nie pass: optional nic nie zmienia, required zatrzymuje run halt-em required-checks-unrunnable zanim reviewer cokolwiek zobaczy.',
    'Reguła stopu: pierwsza komenda reviewera z NOWYMI failures zatrzymuje listę. Komenda pre-existing, refused ani not-runnable nie zatrzymuje. Timeout ma jeden klucz-placeholder, więc zawsze zatrzymuje i nigdy nie jest pre-existing.',
    'Pre-existing jest tylko identyczny klucz failure po obu stronach. Placeholder (timeout, brak diagnostyki, ucięty output) po dowolnej stronie daje not verified at the run base: input zostaje, reviewer decyduje, i to jedyny czerwony, który reviewer może odrzucić (blockingRedInputs). Każdy inny czerwony check i każdy input Apply blokuje niezależnie od odpowiedzi reviewera.',
    'Gdy w pendingTriage jest jakikolwiek input source check, SPLITBRIEF w ogóle nie weryfikuje claimów unverified (final-review.ts:260): każde unverified zostaje unverified i review fail.',
    'Odpowiedź z samym verify (bez fixTasks) nie jest pass: reviewPassed wymaga verify.length = 0, więc START_FIX_CYCLE wydaje cykl bez żadnego fix tasku i review biegnie od nowa.',
    'Accept as is jest tylko na final review bez blokującego czerwonego inputu; scheduled task review go nie oferuje. docs/APPROVAL-AND-RECOVERY.md §Accept as is mówi "for every run" bez tego wyjątku; kod (review.ts:115) i WORKFLOW.md linia 170 go mają.',
    'docs/WORKFLOW.md (linia 115) mówi, że w weryfikacji claimów "a render check stays unverified". Kod: verifyClaimChecks uruchamia render check przez runChecks jak każdy inny i może dać pass (exit 0); unverified wymusza osobno forceUnverifiedRenderCriteria, tylko gdy żaden obraz nie dotarł do reviewera.',
    'reviewsAgain (korekta, odpowiedź na pytanie) pomija recheck, pre-review i plan call: komendy nie biegną drugi raz, a preExistingChecks pochodzą z poprzedniego review.',
    'Plik zmieniony w checkoutcie przed startem runu to praca użytkownika: nie jest zmianą runu, fix task nie może go wskazać (schema odrzuca odpowiedź), a Apply go zachowuje. Jest zmianą runu tylko gdy run zmienił go znów; wtedy diff zaczyna się od wersji użytkownika.',
    'Starszy run bez zapisanego workspace nie ma run base: każda failure komendy reviewera jest nowa, a ./gradlew i ./mvnw są odrzucane (brak plików wrappera do porównania).',
    'approve_checks: ask bez ekranu (headless) uruchamia zero komend reviewera i mówi to w wierszu; nie jest to błąd konfiguracji, ale skip nigdy nie jest pass.',
    'Przy end_checks off lub planie skipped enabledReviewChecks = []: komenda reviewera nie jest zarejestrowanym checkiem, więc verify / unverified z checkIds V n nic nie uruchamia i fix task jej nie dostaje.',
    'Checki biegną z Twoimi uprawnieniami, bez sandboxa plików, sieci i procesów; SPLITBRIEF zdejmuje tylko sekrety z env, ogranicza czas (timeout_ms) i output oraz zabija grupę procesów. W trybie checkout biegną w Twoim checkoutcie.',
    'Base re-run i checki fix tasku nie są tym samym: fix check nigdy nie wraca na run base (judgeFixCheck porównuje klucze z oryginalnym czerwonym), ale run base dalej daje odmowę zmienionej definicji.',
    'Review packet (review-packet.json / .md) jest pisany tylko dla scope final i tylko gdy summaryBase jest podane; task review pisze tylko review.json i review.md. Sam pakiet jest artefaktem, nie bramką.',
  ],
});
