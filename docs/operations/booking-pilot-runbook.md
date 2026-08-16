# Runbook пилота Online Booking — Фаза 7.5

## Назначение и границы

Этот runbook переводит Online Booking из технического release candidate в ограниченный пилот: `demo → design_partner → first_paid`. Он не объявляет Gate 7 пройденным — коммерческие и пользовательские критерии подтверждаются только реальными данными пилота.

Фаза 6 и её Gate 6 остаются обязательной основой. Общие правила enrolment, оплаты и учёта Severity описаны в [runbook закрытого пилота](./pilot-runbook.md). Инциденты, backup/restore и privacy ведутся по отдельным runbook, на которые даны ссылки ниже.

## Ответственные

До открытия первой публичной страницы зафиксировать вне репозитория:

| Роль | Ответственность |
|---|---|
| Release owner | Go/No-Go, изменение feature flags, rollback |
| On-call | Health, алерты, очередь, первичная реакция на инцидент |
| Pilot success owner | Подготовка студий, smoke test, UX-замеры и интервью |
| Privacy owner | Consent, тексты, retention и решение о раскрытии инцидента |
| Provider owner | Договор, credentials, delivery status и эскалация messaging provider |

Контакты, credentials и клиентские данные не хранить в Git, CLI-аргументах, логах или отчётах Gate 7.

## Жёсткие условия No-Go

Не переводить организацию в `booking_access=public`, если выполняется хотя бы одно условие:

- Gate 6 не пройден;
- нет трёх платящих организаций, письменно согласившихся принимать реальные записи;
- `NOTIFICATION_PROVIDER` не равен `resend`, отсутствуют Resend credentials или provider не прошёл contract/sandbox test;
- `PUBLIC_BOOKING_ENABLED` выключен в целевом окружении;
- scheduler maintenance/notifications не настроен либо `OPS_API_TOKEN` отсутствует;
- есть открытый Severity 1–2 дефект;
- не пройдены security, tenant isolation, concurrency, accessibility или backup restore checks;
- нет подтверждённого on-call и проверенного канала алертов.

Resend-адаптер реализован, но состояние инфраструктуры остаётся **No-Go для внешнего пилота**, пока не подтверждены DNS sending domain, production API key/from-address и реальная тестовая доставка. Внутренний `demo` можно проводить с `log`, явно не считая сообщения доставленными клиенту.

## Модель доступа и безопасные исходные значения

Доступ состоит из двух уровней:

1. `PUBLIC_BOOKING_ENABLED` гасит public booking во всём окружении;
2. `organization.booking_access` задаёт уровень конкретного tenant: `off`, `calendar`, `public`.

`calendar` оставляет внутренний календарь и закрывает public/manage routes. `off` закрывает публичную поверхность целиком, а внутреннюю — только на запись: список записей, карточка и графики продолжают отвечать, любая мутация отдаёт 404 `BOOKING_DISABLED`, календарь показывает те же дни без действий. Это осознанно — тумблер дёргают в рабочий день, и смена должна видеть, кого ещё ждут сегодня. Bookings, visits, audit и financial snapshots не трогаются. Повышать до `public` может только оператор; владелец может понижать уровень сам.

Минимальная production-конфигурация:

```text
PUBLIC_BOOKING_ENABLED=true
NOTIFICATIONS_ENABLED=true
NOTIFICATION_PROVIDER=resend
RESEND_API_KEY=<server-secret>
RESEND_FROM=Nail Profit OS <booking@verified-transactional-subdomain>   # либо RESEND_FROM_EMAIL — читаются оба
RESEND_WEBHOOK_SECRET=<whsec-signing-secret>
OPS_API_TOKEN=<at-least-32-random-characters>
NEXT_PUBLIC_APP_URL=https://<production-host>
PILOT_ACCESS_ENFORCEMENT=true
PILOT_DATABASE_URL=<privileged-operator-url>
```

App runtime использует tenant-scoped `DATABASE_URL`; миграции, глобальные jobs и operator CLI — отдельный privileged URL. Секреты находятся только в secret manager целевого окружения.

## Настройка Resend

1. Добавить отдельный transactional subdomain в Resend и подтвердить SPF/DKIM; root domain не использовать без необходимости.
2. Добавить DMARC согласно политике домена и назначить адрес, способный принимать ответы.
3. Создать production API key с минимально необходимым sending access и сохранить только в secret manager как `RESEND_API_KEY`.
4. Установить `RESEND_FROM` на адрес подтверждённого домена. Resend не требует отдельно регистрировать каждый from-address после проверки домена.
5. Создать webhook `https://<production-host>/api/v1/webhooks/resend` для `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed` и `email.suppressed`; signing secret сохранить как `RESEND_WEBHOOK_SECRET`.
6. Выполнить sandbox send на контролируемый адрес, проверить Resend message id, подписанный Dashboard event, обновление `provider_status` и отсутствие contact/body в application logs/таблице событий.
7. Повторно доставить тот же event из Resend Dashboard: endpoint отвечает `200`, но в `notification_provider_event` остаётся одна строка с этим `svix-id`.
8. Проверить password reset и все семь booking templates в RU/RO/EN.
9. Зафиксировать owner, дату ротации API key/webhook secret и escalation route Resend вне репозитория.

Официальные инструкции: [Send Email API](https://resend.com/docs/api-reference/emails/send-email), [Idempotency Keys](https://resend.com/docs/dashboard/emails/idempotency-keys), [Domain verification](https://resend.com/docs/dashboard/domains/introduction), [Webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests).

Resend — email provider, не SMS. В production public profile объявляет email-канал, форма требует email для записи, verification code доказывает владение email, а outbox не создаёт SMS. Телефон остаётся обязательным клиентским контактом. Не обещать SMS fallback в текстах пилота.

## Preflight релиза

### 1. Код и база

Зафиксировать deploy SHA и запустить на том же SHA:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:e2e
npm run build
```

Integration/E2E должны смотреть только на базы с суффиксом `_test` через `TEST_DATABASE_URL` и `TEST_MIGRATION_DATABASE_URL`. Никогда не направлять destructive test suites в development, staging или production.

После миграций проверить RLS приложенческой ролью:

```bash
DATABASE_URL='<app-role-url>' npm run db:verify-rls
```

Обязательные наборы в зелёном прогоне:

- 100 параллельных попыток одного слота дают ровно одну booking;
- workplace, reschedule race, expired hold и idempotent retry;
- cross-tenant IDs, token purpose/TTL/revocation, enumeration, rate limits и CSRF;
- public create/verify/manage, staff create/complete и booking → visit → profit parity;
- RU/RO/EN critical keys и автоматический accessibility audit;
- property-набор движка доступности: слот внутри открытого времени, lead time, буферы, локальная сетка и дни перевода часов;
- покрытие rollout-флага: каждый public и calendar route достижимо доходит до `organizations.booking_access`;
- совместимость миграций для отката приложения (см. раздел «Инцидент и rollback»).

### 2. Backup и восстановление

Выполнить drill на staging-кластере с migration-owner правами:

```bash
BACKUP_SOURCE_DATABASE_URL='<staging-owner-url>' \
ALLOW_BACKUP_RESTORE_DRILL=1 npm run ops:backup-drill
```

Записать UTC-время, deploy SHA, backup ID, RPO/RTO и результат без PII. Подробности: [Backup and restore runbook](./backup-restore-runbook.md).

### 3. Jobs и наблюдаемость

В scheduler должны выполняться не реже раза в минуту:

```bash
npm run ops:booking-maintenance
npm run ops:notifications
```

Обе команды ходят в базу под операторской ролью, поэтому запускаются с машины оператора, а не из деплоя. Для самого деплоя очередь уведомлений разбирает Netlify Scheduled Function `netlify/functions/notifications.mts` — каждые 5 минут она вызывает `POST /api/v1/ops/notifications` **без** `organization_id`, и эндпоинт обходит всех арендаторов сам, каждого в его tenant-транзакции. Функции нужны только `OPS_API_TOKEN` и `NEXT_PUBLIC_APP_URL`; строки подключения к базе у неё нет и быть не должно.

Без `OPS_API_TOKEN` эндпоинт отвечает 404, функция пишет `notifications.cron_not_configured` и ничего не делает — очередь при этом продолжает наполняться, а не теряется. Признак, что планировщика нет вообще: строки `notification_outbox` со статусом `pending`, чей `scheduled_at` старше нескольких минут.

Проверить `/api/health`, тестовый alert и наличие событий `booking.maintenance_completed`. У очереди не должно быть растущего backlog, `dead_letter` или job lag более 300 секунд. Пороговые значения: [Monitoring and alerts](./monitoring.md).

### 4. Evidence из логов

Экспортировать из централизованного collector только редактированные JSONL-строки приложения за окно проверки. Не копировать raw request, query string, телефон, email, имя или token. Один и тот же экспорт читают два отчёта; они отвечают на разные половины одного вопроса и оба нужны.

Latency:

```bash
npm run ops:booking-latency -- --file redacted-timings.jsonl --min-samples 30
```

Отчёт принимает только `http.timing` известных маршрутов и возвращает `PASS`, когда выборка достаточна и:

- p95 `public.availability` ≤500 ms;
- общий p95 public/staff booking mutations ≤800 ms.

События, которых нет в базе:

```bash
npm run ops:log-events -- redacted-timings.jsonl
```

Отказ не пишет строку: rate limit, который сработал, — это ровно тот запрос, которого не было, а challenge, который никто не решил, не виден нигде, кроме строки лога. Отчёт возвращает conflict rate (к числу попыток мутации, а не к общему трафику), попытки двойного бронирования, дошедшие до exclusion constraint, rate-limit blocks по бакетам, challenges по вердиктам, cross-site отказы, что диспетчер claimed/sent/retried/dead-lettered, и запросы по маршрутам, разделённые на отказы и ошибки. `NOT_READY` дают три критерия: exclusion violations, отказы самой job и любые 5xx.

Скрипт читает файлы или stdin и не ходит в базу, поэтому работает по вчерашнему ротированному файлу или по `docker logs`:

```bash
docker compose logs --no-color app | npm run ops:log-events --silent
```

Production collector остаётся источником истины: локальный быстрый прогон не заменяет fleet-level измерение пилотного объёма.

### 5. Ручная доступность и mobile UX

Автоматический audit — только нижняя граница. На ширине 360 px и в RU/RO/EN вручную проверить:

- полный flow только клавиатурой, видимый focus и логичный порядок;
- VoiceOver или NVDA: названия полей, ошибки, статусы и подтверждение;
- touch targets, zoom 200%, portrait/landscape;
- loading, empty, expired hold, conflict, offline и provider-failure states;
- цену, длительность и timezone до ввода контакта.

## Подготовка организации

Для каждой организации pilot success owner подтверждает:

- активный paid enrolment нужной волны;
- публичный slug и branding без внутреннего ID;
- IANA timezone каждой опубликованной локации;
- рабочие места, связи мастеров с location/service и актуальные графики;
- duration/price услуг, buffers, lead time, advance window и slot step;
- confirmation mode/TTL и reminder interval;
- consent text/version, privacy contact и язык RU/RO/EN;
- email клиента, согласие на transactional delivery и тестовую доставку Resend;
- обучение сотрудников: pending, confirm, reschedule, cancel, no-show, complete;
- ручной visit flow как рабочий fallback.

До public rollout организация остаётся на `calendar`:

```bash
ALLOW_PILOT_OPERATOR_WRITE=1 npm run pilot:ops -- booking-access \
  --organization <uuid> --level calendar --operator <ref>
```

## Demo smoke test

На внутренней demo-организации создать отдельные тестовые слоты и пройти:

1. открыть `/book/<slug>` без авторизации;
2. выбрать location, service, specialist/«любой» и доступный слот;
3. получить hold, подтвердить контакт и создать booking;
4. повторить confirm с тем же `Idempotency-Key` — второй booking не появляется;
5. открыть manage link, перенести и отменить запись;
6. создать staff booking, подтвердить и завершить её как visit;
7. сверить financial snapshot с ручным visit flow;
8. убедиться, что client/staff emails приняты Resend один раз с одним provider message id;
9. проверить audit trail и отсутствие PII/raw tokens в логах;
10. понизить до `calendar` и убедиться, что public/manage закрыты, данные остались;
11. понизить до `off` и убедиться, что смена всё ещё видит сегодняшний список и карточку, а любая попытка создать, перенести или отменить получает 404 `BOOKING_DISABLED`. Это единственный шаг, который проверяет сам откат, а не продукт; если он не пройден, публичную страницу открывать нельзя, потому что выключить её будет нечем;
12. вернуть `public` только после записи результатов smoke test.

Тестовые контакты не смешивать с реальными метриками Gate 7.

## Rollout по волнам

Порядок: одна `demo` → одна `design_partner` → ещё одна design partner → три `first_paid`. Между повышениями выдержать минимум один полный рабочий день без Severity 1–2, растущего backlog или нарушения overlap invariant.

Открытие tenant:

```bash
ALLOW_PILOT_OPERATOR_WRITE=1 npm run pilot:ops -- booking-access \
  --organization <uuid> --level public --operator <ref>
```

Сразу после открытия повторить public create/verification/manage smoke реальным доменом и проверить provider delivery. Не открывать следующую организацию, пока текущая не приняла хотя бы одну контролируемую запись и сотрудники не увидели её в календаре.

## Ежедневная эксплуатация

В начале и конце рабочего дня — два отчёта, потому что половина пилотных чисел не существует в виде строк базы:

```bash
MIGRATION_DATABASE_URL='<privileged-operator-url>' npm run ops:booking-metrics -- --days 30
npm run ops:log-events -- <вчерашний редактированный экспорт>
```

`ops:booking-metrics` читает всю базу и проверяет роль перед первым запросом: если подключение подпадает под tenant-политики, команда отказывается работать и называет переменную, а не отдаёт нули. То же у `ops:booking-maintenance`, `ops:notifications` и `pilot:ops`. `ops:log-events` в базу не ходит вообще.

Что откуда:

| Проверить | Источник |
|---|---|
| Активные overlaps, active/expired holds, booking → visit conversion | `ops:booking-metrics` |
| Queue depth, retries, dead letters, provider acceptance, mail-server delivery/bounce/complaint, job lag | `ops:booking-metrics` |
| Медиана времени записи и вся воронка «страница → поиск слотов → начало → подтверждение» | `ops:booking-metrics`, блок `funnel` и критерий `time_to_book` |
| Conflict rate, попытки, дошедшие до exclusion constraint | `ops:log-events` |
| Rate-limit blocks по бакетам, bot challenges по вердиктам, cross-site отказы | `ops:log-events` |
| 5xx по маршрутам, отдельно от отказов | `ops:log-events` |
| p95 по route | `ops:booking-latency` (еженедельно или при подозрении) |
| Health и алерты | `/api/health` и канал алертов |
| Новые Severity issues и обращения студий | pilot issue register |

Оба отчёта возвращают ненулевой exit code при `NOT_READY` и годятся как шаг проверки, который обязан краснеть.

Воронка считает уникальные сессии по заголовку `x-booking-session`, который публичная страница генерирует сама. Если прокси или CDN режет неизвестные заголовки, воронка схлопнется в нули при работающем продукте — это первое, что нужно проверить, когда `time_to_book` вдруг стал `null` при живом трафике.

Раз в неделю повторять latency report, RLS/security targeted tests и `profit_review`. Restore drill — после каждого schema release и не реже раза в месяц.

## Сбор Gate 7 evidence

Хранить датированные JSON-отчёты и ссылки на внешние доказательства в защищённой pilot-папке, не в Git. Минимальный пакет:

| Критерий | Источник |
|---|---|
| 3 организации и 100/30 bookings/visits | `ops:booking-metrics` + enrolment/payment evidence |
| Нет активных overlaps | `ops:booking-metrics` |
| Нет сработавших exclusion constraint, conflict rate | `ops:log-events` за то же окно |
| 100 попыток → 1 booking | concurrency test artifact текущего SHA |
| p95 500/800 ms | `ops:booking-latency` из production collector |
| Median mobile flow ≤2 минут | `ops:booking-metrics`, критерий `time_to_book` (медиана от `booking_service_selected` до `booking_confirmed` по сессии) |
| ≥95% provider acceptance ≤2 минут | metrics + Resend dashboard/export |
| Audit/no duplicates/profit parity | E2E artifacts + выборочная audit проверка |
| RU/RO/EN и accessibility | automated audit + manual screen-reader checklist |
| Security/RLS/rate/backup | CI artifacts, RLS result и restore record |
| Нет Severity 1–2 | pilot issue register |
| 2 готовы продолжать платить | датированное коммерческое подтверждение вне репозитория |

`ops:booking-metrics` и `ops:booking-latency` возвращают ненулевой exit code при `NOT_READY`; отсутствие данных никогда не считается успехом.

## Инцидент и rollback

Любой cross-tenant доступ, потеря/искажение booking или financial snapshot — SEV-1. Недоступность public create/manage, календаря или provider delivery без безопасного workaround — SEV-2. Следовать [Incident response runbook](./incident-runbook.md).

Откат одной организации до внутреннего календаря:

```bash
ALLOW_PILOT_OPERATOR_WRITE=1 npm run pilot:ops -- booking-access \
  --organization <uuid> --level calendar --operator <ref>
```

Полное отключение booking UI организации:

```bash
ALLOW_PILOT_OPERATOR_WRITE=1 npm run pilot:ops -- booking-access \
  --organization <uuid> --level off --operator <ref>
```

При массовом инциденте выключить `PUBLIC_BOOKING_ENABLED` в окружении. При сбое provider установить `NOTIFICATIONS_ENABLED=false`: outbox сохраняется и не удаляется. После изменения проверить public/manage access, staff list/read-only, ручной visit flow, health и audit event.

Не удалять bookings, holds, notifications или audit history.

Откат — это откат приложения, а не базы: миграция уже применена и обратно не поедет. Совместимость проверяется в CI (`tests/migration-compatibility.test.ts`): миграция либо оставляет предыдущую версию работающей, либо несёт строку `-- not-backward-compatible: <причина>`. Перед откатом на предыдущий SHA посмотреть миграции, применённые между ним и текущим: если ни одна не объявлена несовместимой — откат безопасен и занимает минуты. Если объявлена — откат приложения не поможет, и это уже сценарий из [Backup and restore runbook](./backup-restore-runbook.md), а не из этого раздела.

```bash
git diff --name-only <предыдущий-SHA> HEAD -- 'drizzle/*.sql'
git grep -l "not-backward-compatible" HEAD -- 'drizzle/*.sql'
```

Первая команда даёт миграции в диапазоне отката, вторая — все объявленные несовместимыми. Пустое пересечение означает, что предыдущая сборка поднимется на текущей схеме. На сегодня вторая команда не находит ничего.

Возвращать `public` только после устранения причины, зелёных regression tests, smoke test и решения release owner.

## Решение Gate 7

Gate 7 получает `PASS` только когда выполнен каждый критерий roadmap и нет No-Go. Код, demo/seed data, обещание provider или неполная выборка не заменяют реальные результаты. Решение датируют, подписывают release owner и pilot success owner; все отклонения получают владельца и срок.
