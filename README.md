# Gra w statki (Node + TypeScript + Socket.IO)

## Co zostało zaimplementowane

- Silnik gry na planszy 10x10:
  - walidacja rozmieszczenia statków,
  - zakaz styków bokiem i rogami,
  - strzały z wynikami `miss`, `hit`, `sink`, `already_shot`, `invalid`,
  - wykrywanie zatopienia i końca gry.
- Tryb PvA (lokalny) z AI:
  - losowe rozmieszczenie + ręczne ustawianie statków,
  - AI pasywne (szukanie losowe + próba domknięcia trafionego statku).
- Dostępny ręczny strzał po współrzędnych (`A1`..`J10`) z walidacją wejścia.
- Backend:
  - Express + Socket.IO,
  - losowe parowanie 1v1 online,
  - timeout kolejki (60s) z fallbackem do bota,
  - endpoint `GET /health`.
  - serwer sanitizuje plansze zgłaszane przez klienta (zeruje `shots`, `hits`, `sunk`) i zawsze wyznacza stan gry od zera.

## Uruchomienie (lokalnie)

```bash
npm install
# required for DB/Redis scripts: cp .env.example .env
# optional: start dependencies for local development
# docker compose up -d redis postgres
# optional: initialize schema once
# npm run db:init
npm run build
npm start
```

Serwer nasłuchuje domyślnie na `http://localhost:3000`.
Frontend dostępny jest pod `http://localhost:3000/`.
Język interfejsu można przełączyć w panelu gry (`Język: PL/EN`).
Serwer automatycznie wczytuje plik `.env` (przez `dotenv/config`) podczas startu.

`npm start` uruchamia teraz automatyczne `npm run build`, więc po zmianach plików JS klienta nie uruchamia się już na starych assetach.

Sprawdzenie logiki:

```bash
npm test
```

Rozszerzone scenariusze:

```bash
npm run test:socketflow
npm run test:db-retention
npm run test:all
```

Lint:

```bash
npm run lint
```

`npm test` (alias `test:core`) buduje projekt i uruchamia szybki zestaw testów rdzenia gry, w tym:
- poprawność walidacji rozmieszczenia statków,
- trafienia, zatopienie i zakończenie gry,
- brak powtórzenia strzału przez AI.
- parowanie kolejki i timeout kolejki (`matchmaking`).

Pełne testy online/reconnect/flood/rate-limit są dostępne w `npm run test:socketflow`.
Test retencji bazy jest dostępny w `npm run test:db-retention`.

Szybki smoke test tylko dla handshake CORS/socket:

```bash
npm run test:socket-cors
```

## Aktualny status jakości (2026-02-14)

- Testy są podzielone na warstwy:
  - `test:core` (szybkie sanity pod codzienny development),
  - `test:socketflow` (pełne integracje online/reconnect/security flow),
  - `test:db-retention` (retencja telemetry/audytu).
- Najbardziej ryzykowne obszary (reconnect, rate-limit, flood payloadów, restart online po `game:over`) mają dedykowane testy integracyjne w `socketflow`.

Rekomendowany check przed release:

```bash
npm run build
npm run lint
npm run test:all
npm run security
```

Skrócony check one-shot:

```bash
npm run verify
```

Lokalny gate identyczny z CI (db init + lint + wszystkie testy + security):

```bash
npm run ci:local
```

Szybki gate developerski (bez `security` i bez testu retencji DB):

```bash
npm run ci:local:quick
```

## Docker / środowisko produkcyjne (stack)

Minimalny stack deweloperski:

```bash
docker compose up --build
```

Usługi:
- `app` (Node/Express/Socket.IO) na `:3000`
- `redis` na `:6379` (readiness pod queue/reconnect/rate-limit)
- `postgres` na `:5432` (readiness pod persist/audit)

Przykładowy schemat SQL znajduje się w `db/schema.sql`.
Możesz go zastosować ręcznie:

```bash
npm run db:init
```

Skróty lokalne (automatycznie ustawiają domyślne `REDIS_URL` i `DATABASE_URL`, jeśli ich nie ma):

```bash
npm run db:init:local
npm run test:socketflow:local
npm run test:all:local
```

`docker compose` montuje też `db/schema.sql` do `docker-entrypoint-initdb.d`, więc przy pierwszym starcie czystego wolumenu `pgdata` schemat wykona się automatycznie.

Retencja telemetry/audytu:

```bash
npm run db:retention
```

Tryb podglądu bez kasowania:

```bash
DB_RETENTION_DRY_RUN=true npm run db:retention
```

## CI

Workflow `CI` (`.github/workflows/ci.yml`) uruchamia:
1. `npm ci`
2. `npm run db:init` (na serwisie PostgreSQL w GitHub Actions)
3. `npm run lint`
4. `npm run build`
5. `npm run test:core`
6. `npm run test:socketflow`
7. `npm run test:db-retention`
8. `npm run security`

W CI ustawione są `DATABASE_REQUIRED=1` i `REDIS_REQUIRED=1`, więc readiness i testy przechodzą przez realny PostgreSQL oraz Redis.

Dodatkowo workflow `DB Retention` (`.github/workflows/db-retention.yml`) uruchamia:
- `dry-run` codziennie (cron) oraz ręcznie (`workflow_dispatch`, `mode=dry-run`),
- `delete` codziennie (cron) oraz ręcznie (`workflow_dispatch`, `mode=delete`).
Do działania wymaga sekretu `DATABASE_URL_RETENTION`.
Każdy run publikuje też podsumowanie i artifact log (`retention-*.log`) w GitHub Actions.

Serwer obsługuje graceful shutdown (`SIGINT`/`SIGTERM`) i domyka połączenia runtime (`Redis`, `PostgreSQL` telemetry).
Przy aktywnym Redis serwer może odtworzyć pokój z snapshotu przy reconnect po restarcie procesu (best-effort, bez zmiany API).
Przy aktywnym Redis timeout kolejki i dobieranie par są wykonywane na danych współdzielonych, co poprawia stabilność multi-instance.
Odzyskiwanie kolejki po tokenie działa z `queue:parked:*`; token przypięty do aktywnego wpisu kolejki jest traktowany jako zajęty.
Wyjątek: jeśli właściciel aktywnego wpisu kolejki jest offline (np. restart/odświeżenie), token może odzyskać wpis i kontynuować oczekiwanie.
Przy `search:cancel` i rozłączeniu (`disconnect`) serwer odczytuje wpis kolejki także z Redis po `playerId`, więc anulowanie/parkowanie działa nawet po restarcie procesu.

`GET /health` i `POST /health` zwracają rozszerzony status runtime (m.in. queue/rooms/dependencies).
Przykład:
```json
{
  "status": "ok",
  "uptimeSec": 123,
  "timestamp": 1739550000000,
  "rooms": { "active": 1, "playersBound": 2 },
  "matchmaking": { "queueSize": 0, "parkedSize": 0, "tokenLeaseSize": 4 },
  "runtime": { "redisQueue": true, "redisState": true, "redisLimiter": true, "telemetry": false }
}
```

`GET /ready` i `POST /ready` zwracają:
- `200 { "status": "ready", "dependencies": {...} }` gdy serwer spełnia wymagania readiness,
- `503 { "status": "not_ready", "missing": [...], "dependencies": {...} }` gdy brakuje wymaganych zależności.
Przykład `503`:
```json
{
  "status": "not_ready",
  "missing": ["redisQueue", "redisState", "redisLimiter"],
  "dependencies": {
    "redisQueue": { "enabled": true, "reachable": false },
    "redisState": { "enabled": true, "reachable": false },
    "redisLimiter": { "enabled": true, "reachable": false },
    "telemetry": { "enabled": false, "reachable": false }
  }
}
```

`GET /metrics` i `POST /metrics` zwracają tekstowe metryki operacyjne (format podobny do Prometheus), m.in.:
- `battleship_uptime_seconds`
- `battleship_rooms_active`
- `battleship_players_bound`
- `battleship_matchmaking_queue_size`
- `battleship_matchmaking_parked_size`
- `battleship_matchmaking_token_leases`
- `battleship_runtime_dependency_enabled{name="..."}`

### Readiness test matrix (automatycznie w `tests/health.test.js`)
- `/ready` GET i POST: `200 ready` gdy zależności są opcjonalne.
- `/ready` GET i POST: `200 ready` gdy `REDIS_REQUIRED=1` i Redis jest osiągalny.
- `/ready` GET i POST: `200 ready` gdy `DATABASE_REQUIRED=1` i PostgreSQL jest osiągalny.
- `/ready` GET i POST: `503 not_ready` gdy Redis jest wymagany i niedostępny.
- `/ready` GET i POST: `503 not_ready` gdy PostgreSQL jest wymagany i niedostępny.
- `/ready` GET i POST: `503 not_ready` gdy Redis i PostgreSQL są jednocześnie wymagane i niedostępne.

Konfiguracja:
- `CORS_ORIGINS` — lista dozwolonych originów rozdzielona przecinkami (np. `http://localhost:3000,http://127.0.0.1:3000`); w produkcji używaj tylko jawnej allowlisty.
- `REQUIRE_ORIGIN_HEADER` — jeśli ustawione na `1`/`true`/`yes`, handshake socketów bez nagłówka `Origin` jest odrzucany.
- `TRUST_PROXY` — ustaw `true`/`1` przy zaufanym reverse proxy, aby poprawnie czytać `x-forwarded-for`.
- `RATE_LIMIT_SHOT_PER_WINDOW`, `RATE_LIMIT_SHOT_WINDOW_MS` — limity burst dla `game:shot`.
- `RATE_LIMIT_PLACE_SHIPS_PER_WINDOW`, `RATE_LIMIT_PLACE_SHIPS_WINDOW_MS` — limity burst dla `game:place_ships`.
- `RATE_LIMIT_JOIN_PER_WINDOW`, `RATE_LIMIT_RECONNECT_JOIN_PER_WINDOW`, `RATE_LIMIT_JOIN_WINDOW_MS`, `RATE_LIMIT_GAME_CANCEL_PER_WINDOW`, `RATE_LIMIT_SEARCH_CANCEL_PER_WINDOW` — limity dla kolejki/anulowania/reconnect.
- `RATE_LIMIT_CHAT_PER_WINDOW`, `RATE_LIMIT_CHAT_WINDOW_MS` — bazowy limiter burst dla `chat:send`.
- `CHAT_MIN_INTERVAL_MS` — minimalny odstęp między kolejnymi wiadomościami tego samego gracza (cooldown anty-spam).
- `CHAT_DUPLICATE_WINDOW_MS`, `CHAT_MAX_SIMILAR_IN_WINDOW` — okno i próg blokady powtarzających się wiadomości.
- `CHAT_BLOCK_LINKS` — blokada linków (`http://`, `https://`, `www.`) w wiadomościach czatu.
- `MATCH_TIMEOUT_MS` — timeout oczekiwania w kolejce (domyślnie `60000`).
- `ROOM_INACTIVITY_TIMEOUT_MS` — timeout braku aktywności pokoju (domyślnie `600000`).
- `INVALID_INPUT_LIMIT_PER_WINDOW`, `INVALID_INPUT_WINDOW_MS`, `INVALID_INPUT_BAN_MS` — miękki ban dla floodu niepoprawnych payloadów.
- `REDIS_URL` — opcjonalny backend limitera rate-limit (distributed) oraz snapshotów pokoi/reconnect map (`room:snapshot:*`, `room:token:*`).
- `REDIS_KEY_PREFIX` — opcjonalny prefix kluczy Redis (przydatny do izolacji środowisk/testów współdzielących jeden Redis).
- `REDIS_REQUIRED` — jeśli `true`, endpoint `/ready` wymaga aktywnego Redis runtime (`redisQueue`, `redisState`, `redisLimiter`).
- `SOCKET_PRESENCE_TTL_MS` — TTL znacznika obecności socketu w Redis (`socket:presence:*`) używany do rozstrzygania konfliktów reconnect tokenów między instancjami.
- `SOCKET_PRESENCE_REFRESH_MS` — interwał odświeżania znacznika obecności dla aktywnych socketów.
- `DATABASE_URL` — opcjonalny backend telemetry (`match_events`, `security_events`).
- `DATABASE_REQUIRED` — jeśli `true`, endpoint `/ready` wymaga aktywnego telemetry runtime (PostgreSQL).
- `READY_PING_TIMEOUT_MS` — timeout (ms) aktywnego probe zależności używany przez `/ready` (Redis i PostgreSQL).
- `READY_CACHE_MS` — krótki cache odpowiedzi `/ready` (ms), aby ograniczyć koszt częstych probe’ów.
- `ROOM_SNAPSHOT_TTL_MS` — TTL snapshotu pokoju w Redis (`room:snapshot:*`).
- `QUEUE_ENTRY_TTL_MS` — TTL wpisu kolejki w Redis (`queue:entries`, `queue:token:*`).
- `QUEUE_PARKED_TTL_MS` — TTL „zaparkowanego” wpisu kolejki po rozłączeniu (`queue:parked:*`).
- `DB_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`, `DB_CONNECT_TIMEOUT_MS` — ustawienia puli PostgreSQL dla telemetry.
- `MATCH_EVENTS_RETENTION_DAYS`, `SECURITY_EVENTS_RETENTION_DAYS`, `MATCHES_RETENTION_DAYS` — retencja danych telemetry/audytu.
- `DB_RETENTION_DRY_RUN` — jeśli `true`, `npm run db:retention` tylko raportuje liczbę rekordów do usunięcia.
- Oba timeouty akceptują też zapis z separatorem `_` (np. `10_000`).

### Chat security defaults (core hardening)
- Czat PvP działa z walidacją payloadu, whitelistą `emoji/gif`, limiterem burst i soft-banem dla floodu błędnych danych.
- Wiadomości tekstowe przechodzą normalizację Unicode (`NFKC`) i czyszczenie znaków sterujących/formatujących po stronie serwera.
- Treści zawierające URL są domyślnie blokowane (`CHAT_BLOCK_LINKS=true`).
- Dodatkowo działa anty-spam „balanced”:
  - cooldown między wiadomościami (`CHAT_MIN_INTERVAL_MS=700`),
  - blokada zbyt podobnych wiadomości w krótkim oknie (`CHAT_DUPLICATE_WINDOW_MS=8000`, `CHAT_MAX_SIMILAR_IN_WINDOW=2`).

`game:over` zwraca teraz opcjonalnie:
- `reason: "normal" | "disconnect" | "manual_cancel" | "inactivity_timeout"`,
- `message` z krótkim opisem przyczyny.

## Główne eventy socketowe

- `search:join` -> wejście do kolejki (`nickname`)
- `search:cancel` -> anulowanie oczekiwania
- `game:cancelled` -> potwierdzenie anulowania przez serwer (`queue_cancelled`, `manual_cancel`, `search_cancelled`, `disconnect`)
- `game:place_ships` -> ustawienie własnej floty (`board`) i przejście do fazy gry po gotowości obu stron
- `game:shot` -> wykonanie strzału (`{ roomId, coord }`)
- `game:cancel` -> zakończenie gry
- `queue:queued`, `queue:matched`
- `game:state`, `game:turn`, `game:shot_result`, `game:over`, `game:cancelled`, `game:error`
- `game:error` może zwrócić m.in.: `Brak aktywnej gry.`, `Nie jest Twoja tura.`, `Nieprawidłowe id pokoju.`, `Nieprawidłowy pokój.`, komunikaty anulowania/rozłączenia oraz komunikat o próbie wejścia do kolejki podczas aktywnej gry.
- `game:error.code` może zawierać także `invalid_payload` (walidacja wejścia) i `soft_ban` (tymczasowa blokada po floodzie błędnych payloadów).

  - `game:over` oprócz wyniku zawiera `totalShots` (suma Twoje strzały + strzały przeciwnika).

## Scenariusz uruchamiania online

1. Kliknij `Szukaj online` (podaj nick).
2. Po otrzymaniu komunikatu matchu ustaw swoją flotę (manualnie lub losowo).
3. Kliknij `Start PvA`, aby wysłać ustawienie i potwierdzić gotowość.
4. Gdy obaj gracze są gotowi, gra przechodzi do trybu `playing`.
5. Zmiany ruchu i zakończenie gry można śledzić przez `game:turn` i `game:over`.
6. Po zakończeniu pojedynku kliknij `Nowa gra online`, aby od razu dołączyć do kolejki ponownie.

Status gotowości w online:
- serwer zwraca w `game:state` pola `youReady` i `opponentReady`,
- dopóki `opponentReady` jest `false`, gra czeka i nie przyjmuje jeszcze strzałów.

## Jak grać krok po kroku

### Tryb PvA (lokalny)

1. Uruchom grę i kliknij `Start PvA`.
2. Wybierz układ:
   - losowo: `Losowe rozstawienie` (gotowe od razu), albo ręcznie klikając pola na swojej planszy,
   - sprawdź listę pozostałych statków.
   - ręczne obracanie statku na desktopie: `PPM` na własnej planszy, `scroll` nad własną planszą albo klawisz `R` (przycisk `Obróć ręczny` działa jako fallback).
3. Po ustawieniu zatwierdź i zaczynamy grę.
4. Oddawaj strzały klikając planszę przeciwnika albo wpisując współrzędne (`A1`..`J10` + Enter).
5. Po trafieniu grasz dalej, po pudle tura przechodzi do przeciwnika.
6. Koniec gry pokazuje licznik ruchów i informację o zwycięstwie/porażce.

### Tryb online

1. Kliknij `Szukaj online` i podaj nick.
2. Po sparowaniu ustaw swoją flotę i kliknij `Start PvA` (to wysyła ustawienie i gotowość).
3. Czekaj aż pole `Gotowość` pokaże `Ty TAK / Przeciwnik TAK`.
4. Następnie klikaj planszę przeciwnika zgodnie z kolejnością tury.
5. Po końcu rundy kliknij `Nowa gra online`, by od razu wejść do kolejnej kolejki.

## Szybki check E2E

1. Włącz serwer (`npm run build && npm start`) i otwórz jedną kartę `http://localhost:3000/`.
2. PvA:
   - ustaw własną flotę ręcznie lub kliknij losowe rozstawienie,
   - podczas ręcznego ustawiania sprawdź obrót: `PPM`, `scroll` i `R` (w polu input `R` nie powinno obracać),
   - kliknij `Start PvA`,
   - możesz strzelać kliknięciem na planszy przeciwnika albo wpisując `A1`..`J10`.
   - oddawaj strzały do zakończenia gry,
   - sprawdź komunikat końcowy: powinien zawierać liczbę Twoich strzałów, strzały przeciwnika i łączną liczbę ruchów.
3. Online (lokalne dwie sesje):
   - otwórz drugą kartę/okno,
   - w obu kliknij `Szukaj online` i podaj różne nicki,
   - ustaw floty i kliknij `Start PvA` (to oznacza "gotowe"),
   - wykonaj pierwsze strzały i zweryfikuj zmianę tury po `pudło`.
4. Fallback do bota:
   - otwórz jedną sesję i kliknij `Szukaj online`,
   - poczekaj `60s` (lub ustaw niższy `MATCH_TIMEOUT_MS`),
   - powinieneś otrzymać mecz przeciwko Bot i (po rozpoznaniu trybu bot) rozstawienie jest ustawiane losowo automatycznie.
5. Online po zakończeniu meczu:
   - kliknij `Nowa gra online`,
   - sprawdź, czy oba okna otrzymują `queue:queued`,
   - zagraj kolejną rundę bez ręcznego przełączania trybu.

### Testy frontu (manualne): flow `game:over` → `Nowa gra online`

1. Uruchom lokalnie dwie sesje gry (dwie karty/przeglądarki).
2. Na obu sesjach kliknij `Szukaj online` i wybierz wspólny nick lub dwa różne (dowolnie).
3. Po sparowaniu ustaw floty i kliknij `Start PvA`.
4. Zagraj mecz do końca:
   - potwierdź, że pojawił się komunikat końcowy (`game:over`) z wynikiem i statystykami strzałów,
   - przyciski strzałów są zablokowane (brak możliwości nowego ruchu w zakończonym meczu),
   - przycisk `Nowa gra online` jest aktywny.
5. Kliknij `Nowa gra online` na obu stronach:
   - oba UI powinny wejść do stanu „szukania online” (`queue:queued`),
   - powinien być widoczny stan gotowości/odliczania,
   - dotychczasowy stan plansz jest resetowany (Twoje strzały/sygnalizacje nie powinny pozostać).
6. Po ponownym matchu sprawdź:
   - można ustawić floty od nowa (ręcznie/losowo),
   - kliknięcie `Start PvA` ponownie uruchamia fazę gry,
   - ruchy i tury działają normalnie bez przeładowania strony.
7. Dodatkowy przypadek regresji:
   - w momencie `game:over`, kliknij tylko jedną stronę „Nowa gra online”,
   - po chwili druga strona również może kliknąć,
   - obie sesje muszą ostatecznie wejść do tej samej kolejki (lub tego samego trybu ponownego matchu), bez zawieszenia UI.

### Testy frontu (manualne): chat `mute/unmute` + unread

1. Uruchom mecz online PvP na dwóch sesjach.
2. Na sesji A kliknij `Wycisz` / `Mute`.
3. Wyślij wiadomość z sesji B:
   - sesja A nie powinna odtworzyć sygnału audio,
   - wiadomość nadal musi być widoczna na liście.
4. Na sesji A kliknij `Włącz dźwięk` / `Unmute`.
5. Wyślij kolejną wiadomość z sesji B:
   - sesja A powinna odtworzyć krótki sygnał.
6. Sprawdź `unread`:
   - przejdź na inną kartę/przeglądarkę (sesja A w tle),
   - wyślij 2-3 wiadomości z sesji B,
   - po powrocie na sesję A licznik `Nowe/Unread` powinien się wyzerować.

### Skróty i zachowanie panelu czatu

1. `/` (slash) fokusuje pole wpisywania wiadomości, jeśli czat jest aktywny i fokus nie jest w innym polu tekstowym.
2. `Enter` w polu czatu wysyła wiadomość.
3. `Esc` zamyka panel GIF reakcji, jeśli jest otwarty.
4. Kliknięcie poza panelem GIF również go zamyka.
5. Przycisk `Wycisz/Mute` zapisuje preferencję lokalnie (`localStorage`) i utrzymuje ją po odświeżeniu strony.

### Testy frontu (manualne): rozłączenie i reconnect

1. Przygotuj jedną udaną mecz online z dwoma sesjami (`A` i `B`).
2. Rozłącz jedną stronę (`A`):
   - zamknij kartę lub odłącz internet na stronie `A`,
   - na stronie `B` sprawdź komunikat `gracz chwilowo niedostępny` / `Przeciwnik chwilowo niedostępny`,
   - status powinien pokazywać odliczanie czasu na ponowne dołączenie (domyślnie `ROOM_RECONNECT_GRACE_MS`).
3. W czasie okna grzecznego ponownego podłączenia (lub po odświeżeniu strony):
   - zaloguj `A` z tym samym nickiem i tokenem reconnect (jeśli UI pyta o `token`/przywraca automatycznie),
   - powinien nadejść komunikat `reconnect_restored` albo od razu odświeżony stan gry (`game:state`).
4. Po przywróceniu:
   - układ statków i historia strzałów powinna być identyczna jak przed rozłączeniem,
   - aktywny gracz powinien kontynuować turę zgodnie z ostatnim stanem (`game:turn`),
   - brak podwójnych/duplikatowych strzałów po wznowieniu.
5. Sprawdź scenariusz `grace timeout`:
   - rozłącz jeszcze raz jedną ze stron i nie wracaj przez cały `ROOM_RECONNECT_GRACE_MS`,
   - po upływie czasu gra powinna zakończyć się zgodnie z protokołem (`game:over`/`game:cancelled` z odpowiednim powodem, np. `disconnect`/`reconnect_token_expired`).
6. Sprawdź wejście po utracie rekonekta:
   - otwórz nową kartę jako nowa sesja i wejdź do `Szukaj online`,
   - gracz musi móc wejść do kolejki na nowej rundzie (fallback do bota lub dopasowanie),
   - stare tokeny nie powinny blokować nowego meczu.

### Smoke test po restarcie serwera (Redis)

1. Uruchom mecz online na 2 kartach (`A`, `B`) i przejdź do `phase=playing`.
2. Wykonaj przynajmniej 1 strzał; opcjonalnie zatop 1 jednomasztowiec.
3. Zrestartuj serwer bez czyszczenia danych Redis.
4. Przywróć obie sesje przez `reconnectToken`.
5. Potwierdź:
   - obie strony wracają do tego samego `roomId`,
   - liczniki `yourShots/opponentShots` są zgodne po obu stronach,
   - jeśli wcześniej był `sink`, `sunkCells` są nadal widoczne po reconnect.

### Szybki smoke test (2 min)

1. Uruchom aplikację (`npm run build && npm start`).
2. PvA: `Start PvA` → wygeneruj/planuj statki → wykonaj 2–3 strzały → sprawdź zmianę komunikatu i tury.
3. Online: otwórz drugą kartę, obie wejście do `Szukaj online`, ustaw gotowość (`Start PvA`) i wykonaj co najmniej 1 pełny ruch tury.
4. Po krótkim meczu kliknij `Nowa gra online` → potwierdź wejście do `queue:queued` i powrót do ustawiania nowej gry.
5. Rozłącz jedną stronę na 5–10 s i sprawdź komunikat reconnecta.
6. Przełącz język na `EN` i sprawdź, że etykiety UI i główne statusy zmieniają się bez odświeżenia strony.

## Release gate (checklista przed wdrożeniem)

1. `npm run build` przechodzi bez błędów.
2. `npm run lint` przechodzi bez błędów krytycznych.
3. `npm run test:all` przechodzi (core + socketflow + db-retention).
4. CI na `main/PR` jest zielone (`build + lint + test + security`).
5. Manual smoke:
   - online `game:over -> Nowa gra online`,
   - disconnect/reconnect w `ROOM_RECONNECT_GRACE_MS`,
   - restart serwera (Redis) + reconnect i spójność `shots/sunkCells`.

## Procedura release (krok po kroku)

1. Zaktualizuj branch lokalny i rozwiąż ewentualne konflikty.
2. Upewnij się, że środowisko lokalne ma aktywne Redis/PostgreSQL (`docker compose up -d redis postgres`).
3. Uruchom pełny gate:
   - `npm run ci:local`
4. Zweryfikuj manualny smoke online (`game:over -> nowa gra online`, reconnect, restart).
5. Zacommituj zmiany i wypchnij branch:
   - `git add .`
   - `git commit -m "..."` 
   - `git push`
6. Otwórz PR i poczekaj na zielone workflow `CI`.
7. Po merge wykonaj tag release (opcjonalnie) i aktualizuj changelog/release notes.

## Granica bezpieczeństwa tej wersji (ważne)

Ta wersja jest istotnie utwardzona względem payload abuse i cheatów protokołu gry, ale nie jest systemem klasy enterprise „nie do zhakowania”.

### Co jest już zabezpieczone

- Serwer jest `server-authoritative` dla stanu rozgrywki.
- Walidacja payloadów socket (`invalid_payload`) i soft-ban na flood błędnych żądań.
- Rate-limit na krytyczne eventy (`search:join`, `game:shot`, `game:place_ships`, `game:cancel`, `search:cancel`, `chat:send`).
- Ograniczony CORS + opcjonalne wymaganie `Origin` (`REQUIRE_ORIGIN_HEADER`).
- Reconnect tokeny z TTL i ochrona konfliktów aktywnej sesji.
- Czat PvP: brak dowolnych URL GIF, whitelist emoji/GIF, sender ustalany wyłącznie po stronie serwera.

### Czego ta wersja jeszcze nie daje

- Brak kont użytkowników i autoryzacji per user/session.
- Brak WAF i ochrony DDoS na warstwie edge.
- Brak anti-bot edge (np. challenge/rate shaping na CDN/LB).
- Brak centralnej polityki bezpieczeństwa typu SOC/IDS/SIEM.

## Production hardening checklist (kolejny etap)

1. Reverse proxy + TLS:
   - uruchomienie za Nginx/Traefik/Cloudflare,
   - wymuszenie HTTPS i HSTS.
2. Edge security:
   - WAF reguły na handshake i endpointy HTTP,
   - DDoS protection/rate shaping przed aplikacją.
3. Auth/session layer:
   - token sesji gracza (minimum),
   - docelowo pełne konto + rotacja tokenów.
4. Sekrety i runtime:
   - silne hasła Redis/PostgreSQL,
   - izolowane sieci i minimalne uprawnienia kont DB,
   - osobne env dla dev/stage/prod.
5. Monitoring/alerting:
   - alert na skoki `invalid_payload`, `soft_ban`, reconnect conflict,
   - alert na degradację `/ready` i wysokie opóźnienia socketflow.
