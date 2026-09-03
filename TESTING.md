# Testing Nail Profit OS

Цель — максимально высокий полезный охват, а не тесты ради числа. Финансовые
правила проверяются быстрыми unit/property тестами, SQL/RLS — настоящей
PostgreSQL, HTTP-контракты — реальными route handlers, а пользовательские
сценарии и async Server Components — Playwright в браузере.

## Команды

```bash
npm test                    # 689+ быстрых unit/property тестов
npm run test:coverage       # unit + coverage gate для всего domain/
npm run test:integration    # SQL, RLS, конкурентность, сервисы
npm run test:e2e            # route handlers + Better Auth + PostgreSQL
npm run test:smoke          # критический smoke, desktop Chromium
npm run test:playwright     # полный desktop + mobile Chromium
npm run test:all            # всё выше, кроме отдельного дублирующего smoke
```

Перед первым Playwright-запуском:

```bash
npx playwright install chromium
```

Интерактивный runner: `npm run test:playwright:ui`.

## Слои

### Unit и property

- Файлы: `*.test.ts`, `*.test.mjs` рядом с кодом и в `tests/`.
- Среда: Node, без базы и внешней сети.
- Все ветки финансовых расчётов, округления, локали, даты/DST и security
  helpers должны иметь точные утверждения о результате.
- Coverage охватывает весь `domain/**/*.ts`. Порог: statements/functions/lines
  не ниже 90%, branches не ниже 85%. HTML-отчёт: `coverage/index.html`.

### Integration

- Файлы: `tests/integration/**/*.test.ts`.
- Настоящая PostgreSQL, настоящие constraints, RLS и транзакции.
- Запуск последовательный, потому что файлы очищают общую test-базу.

### Handler E2E

- Файлы: `tests/e2e/**/*.test.ts`.
- Реальные route handlers, Better Auth sessions и PostgreSQL через HTTP-границу.
- Это серверный E2E-слой; браузерный E2E находится в `tests/playwright/`.

### Smoke и browser E2E

- Smoke: `tests/playwright/smoke/`. Он должен оставаться быстрым и включать
  landing, private-route redirect, legal pages, health и anonymous API contract.
- Полные сценарии: `tests/playwright/*.spec.ts`. Они запускаются в desktop и
  mobile Chromium и автоматически падают на `console.error`/page errors.
- Используйте visibility-aware селекторы `getByRole`, `getByLabel` и
  `getByPlaceholder`. Это важно для Next.js UI, где скрытое содержимое может
  оставаться в DOM.
- Playwright использует `:3100` и `.next-playwright`, поэтому может работать
  рядом с обычным `next dev` на `:3000`.
- При `PLAYWRIGHT_BASE_URL=https://...` локальный сервер и локальная база не
  запускаются; используйте это только для read-only smoke внешнего окружения.

## Безопасность test-базы

DB-наборы и локальный Playwright требуют `DATABASE_URL`, `TEST_DATABASE_URL` и
`TEST_MIGRATION_DATABASE_URL` из `.env`. Test URL обязан отличаться от dev URL,
оба test URL должны указывать на одну базу, а её имя — оканчиваться на `_test`.
Проверка fail-fast выполняется до запуска тестов. Не обходите её.

## Правила добавления тестов

- Новая функция: happy path, ошибочный путь и граничные значения.
- Новый `if`/`switch`: тест каждой ветки.
- Исправление бага: regression test, который сначала воспроизводит исходное
  условие, затем утверждает пользовательский результат.
- Новый async Server Component или пользовательский flow: Playwright, а не
  попытка отрендерить его изолированно в Vitest.
- Не проверяйте только «существует» или «не падает». Проверяйте конкретный
  результат, состояние, HTTP-код и стабильный error code.

## Даты в тестах

Записанная в тест дата верна ровно до того дня, когда календарь её пройдёт, —
а дальше тест тихо проверяет что-то другое. 2 сентября 2026 это стоило четырёх
красных прогонов подряд, и ни один не был про код: очередь, отправляемая
моментом из прошлого, не забирала ничего; график, запрошенный «действующим
сегодня», оказывался пустым; забронированный день к середине дня заканчивался,
и ответом становилась следующая неделя.

Правило: фиксированная дата допустима **только** там, где её никто не сравнивает
с реальными часами — в чистой функции, которой передан свой `now`, или в строке,
у которой тест сам пишет обе стороны времени. Везде, где приложение спрашивают,
что свободно, что пора отправить и что уже прошло, дату нужно считать от
сегодняшнего дня: `tests/helpers/calendar.ts` для vitest-наборов,
`daysFromToday` из `tests/playwright/helpers/studio.ts` для браузерных.

И не бронируйте на сегодня: рабочий день, который начинается в девять, при
услуге в полтора часа заканчивается задолго до полуночи, и результат такого
теста зависит от часа запуска.
