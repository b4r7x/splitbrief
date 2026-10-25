# Flow Atlas

Lokalna strona, która pokazuje każdy przepływ i każdą decyzję SPLITBRIEF: diagramy Mermaid, karty decyzji, konfigurację, scenariusze, słownik i strukturę kodu.

## Jak otworzyć

Otwórz `flow-atlas/index.html` w przeglądarce prosto z dysku (`file://`). Nie ma kroku budowania.

- Diagramy rysuje Mermaid 11.4.1 z CDN jsdelivr. Bez sieci strona działa, a każdy diagram pokazuje swoje źródło.
- Adres w pasku jest zakładką: `#view/map`, `#view/decisions`, `#view/config`, `#view/scenarios`, `#view/structure`, `#view/glossary`, `#area/recovery`, `#decision/RC_ACCOUNT_CAUSE`, `#diagram/<id>`.
- `/` przenosi kursor do wyszukiwarki. Strzałki i Enter wybierają wynik.
- Kliknięcie romba na diagramie otwiera kartę decyzji. Najechanie na kartę podświetla jej romb.
- Kliknięcie chipa `plik:linia` kopiuje go do schowka. Strzałka `↗` obok otwiera plik w edytorze. Edytor (VS Code, Cursor albo brak linku) wybierasz na dole paska bocznego.
- Diagram: Ctrl + kółko to zoom, przeciągnięcie przesuwa, „pełny ekran” otwiera go na całe okno (Esc zamyka).

## Jak sprawdzić dane

```bash
node flow-atlas/check.mjs
```

Skrypt sprawdza:

1. schemat każdego pliku danych: wymagane pola, unikalne id w całym atlasie (obszary, diagramy, decyzje), linki do istniejących obszarów, węzły `tree`;
2. każde `where`, `entry`, `files.path` i `tree.path`: plik istnieje, a linia nie przekracza długości pliku;
3. render każdego diagramu w Chromium (Playwright) z treścią błędu Mermaid;
4. romby z id decyzji bez karty (błąd) i karty decyzji, których nie ma na żadnym diagramie (uwaga).

Kod wyjścia 1 oznacza błędy. Opcje:

- `--data <katalog>` — inny katalog z plikami danych,
- `--repo <katalog>` — inny korzeń repozytorium dla ścieżek,
- `--no-render` — bez Chromium,
- `--verbose` — także romby, które nie są decyzjami.

Gdy Chromium nie dosięga CDN, podaj lokalną kopię Mermaid:

```bash
MERMAID_JS=/ścieżka/do/mermaid.min.js node flow-atlas/check.mjs
```

Kopię pobierzesz poza repozytorium, na przykład `npm pack mermaid@11.4.1` w katalogu tymczasowym i `tar xzf mermaid-11.4.1.tgz`. Plik leży w `package/dist/mermaid.min.js`.

## Jak dodać albo rozszerzyć plik danych

Kontrakt opisuje [SCHEMA.md](./SCHEMA.md). W skrócie:

1. Plik to `flow-atlas/data/<id>.js`, zwykły skrypt, który robi `window.ATLAS.push({...})` z jednym obszarem. `id` równa się nazwie pliku.
2. Nowy obszar dopisz w trzech miejscach: znacznik `<script src="data/<id>.js">` w `index.html`, lista `AREAS` na początku `app.js`, lista `EXPECTED` w `check.mjs`.
3. Romb decyzji na diagramie ma id równe `id` karty decyzji (`RC_CAUSE{"Jaka przyczyna?"}`). Tylko wtedy strona łączy romb z kartą.
4. `next` w gałęzi może wskazać id decyzji albo id obszaru; strona zrobi z niego link.
5. Obszar `journey` może mieć `glossary` (widok Słownik). Obszar `structure` ma `tree` (widok Struktura).
6. Po każdej zmianie uruchom `node flow-atlas/check.mjs` i popraw błędy.
