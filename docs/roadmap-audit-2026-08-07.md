# Nail Profit OS — Аудит Roadmap

**Дата:** 7 августа 2026\
**Roadmap:** v1.1\
**Ветка:** main · clean · 23 миграции · 45 таблиц

---

## Ключевые показатели

| Метрика | Значение |
|---|---|
| Технических фаз MVP завершено | **6 / 6** (Ф1–Ф5 + инфра Ф6) |
| Gate 0 — оплат получено | **0** (старт 10 августа) |
| Опережение schedule | **~3 месяца** (Ф7 в коде до Gate 6) |

---

## Главная находка

### Критический риск — нарушение roadmap-последовательности

Фаза 7 (Online Booking) — запланированная на февраль–апрель 2027 и открываемая **только после Gate 6** — полностью реализована в кодовой базе. API публичного бронирования, Availability Engine, concurrency-защита, staff-календарь, уведомления, manage-токены, bot-challenge и E2E-тесты — всё это в `main` прямо сейчас.

Это именно тот риск, который roadmap называет «Высокая / критическое»: *«Scope возвращается к booking CRM»*. Ни Gate 0, ни Gate 6 ещё не пройдены.

### Gate 5 — три пункта не подтверждены на staging

Технический scope Ф5 закрыт, но Release Candidate требует:

1. restore из managed backup на staging,
2. получение тестового алерта,
3. юридическое утверждение versioned privacy/terms с реальными данными оператора.

До этого Gate 5 формально не пройден.

### Хорошая новость — техническая база исключительно сильна

45 таблиц, 23 миграции, ~417 unit-тестов в domain, полные integration- и E2E-наборы, tenant isolation с RLS, feature-flag система (`bookingAccess: off/calendar/public`), pilot-enrollment инфра, operator CLI, rate limits, CSRF, idempotency-ключи. MVP-ядро готово к пилоту.

---

## Статус по фазам

```
[ Ф0: стартует ] [ Ф1: done ] [ Ф2: done ] [ Ф3: done ] [ Ф4: done ] [ Ф5: 95% ] [ Ф7: ⚠ уже в коде ]
```

### Фаза 0 — Платный concierge и данные

**Roadmap:** 10–23 августа 2026 · Недели 1–2\
**Статус:** `СТАРТУЕТ`

3 фактические оплаты по 300 MDL, сбор рецептур у design partners, 3 UX-теста прототипа, минимальный CSV-шаблон.

> Старт через 3 дня. Весь технический scope уже готов — продукт ждёт только первых реальных клиентов и денег.

---

### Фаза 1 — Platform Foundation

**Roadmap:** 24 авг. – 6 сент.\
**Статус:** `ГОТОВО`

Auth, organization, tenant isolation, роли Owner/Master, PostgreSQL schema, REST API v1, i18n-основа, structured logs, daily backup, feature flags.

> Реализовано: `auth.ts`, `db/tenant.ts`, `db/schema.ts` (1 640 строк, 23 миграции), `rbac.ts`, `logger.ts`, `i18n/`.

---

### Фаза 2 — Каталог и Costing Core

**Roadmap:** 7–27 сентября\
**Статус:** `ГОТОВО`

Специалисты, услуги, add-ons, материалы, история цен, рецептуры, детерминированный Costing Engine, финансовые snapshots, completeness status.

> `domain/costing.ts`, `domain/recipe-cost.ts`, `domain/commission.ts` — 15+17+15 unit-сценариев. Канонический расчёт Gate 2 присутствует в тестах.

---

### Фаза 3 — Visit Profit и Dashboard

**Roadmap:** 28 сент. – 11 октября\
**Статус:** `ГОТОВО`

Карточка клиента, завершённый визит, snapshots, фактический расход, mobile visit close, Studio Ledger dashboard, фильтры периода/мастера.

> `domain/visit-profit.ts` (47 тестов), `lib/dashboard.ts`, `lib/visit-service.ts`, `app/app/visits/`, `app/app/page.tsx`.

---

### Фаза 4 — Import и локализация

**Roadmap:** 12–25 октября\
**Статус:** `ГОТОВО`

CSV/Excel upload, mapping/validation/preview, idempotent import, защита от formula injection, стартовые шаблоны материалов, RU/RO/EN, MDL/EUR.

> `domain/csv.ts`, `domain/csv-safety.ts`, `domain/import-*.ts` — 22+14+32+13 тестов. `lib/import-service.ts`, `api/v1/imports/`, `app/app/import/`.

---

### Фаза 5 — Hardening · Release Candidate

**Roadmap:** 26 окт. – 8 ноября\
**Статус:** `≈95%`

E2E критических flow, RBAC/tenant-isolation matrix, rate limits, PII masking, privacy/consent тексты, экспорт/удаление данных, accessibility, мониторинг, backup restore drill.

> Технический scope готов (подтверждено в roadmap 5 авг.). Открытые пункты Gate 5:
> - [ ] managed backup restore на staging
> - [ ] получение тестового алерта
> - [ ] финальное юридическое утверждение privacy/terms

---

### Фаза 6 — Закрытый MVP-пилот

**Roadmap:** 9–22 ноября 2026\
**Статус:** `ИНФРА ГОТОВА · Gate 6 не пройден`

1 → 3 → 10 платящих аккаунтов. Gate 6: ≥10 клиентов, activation ≥70%, WAU ≥60%, ≥6 из 10 продлились, ≥6 решений приняты.

> Техническая инфра реализована (`pilot-events.ts`, `pilot-core.mjs`, operator CLI, forced-RLS, enrollment waves). Коммерческий gate требует реальных оплат и поведения пользователей — не seeded data.

---

### Фаза 7 — Online Booking

**Roadmap:** февраль–апрель 2027 · открывается только после Gate 6\
**Статус:** `⚠ РЕАЛИЗОВАНА ПРЕЖДЕВРЕМЕННО`

Locations, Availability Engine, public booking, staff calendar, manage-links, уведомления, concurrency-защита, Bot Challenge, E2E-тесты.

> **Реализовано в коде прямо сейчас:**
> - `app/api/v1/bookings/**` — полный CRUD + confirm/cancel/reschedule/no-show/complete
> - `app/api/v1/availability/**` — rules, exceptions
> - `app/api/v1/public/booking/[slug]/**` — полный public booking flow
> - `app/api/v1/locations/**` — locations + booking settings
> - `lib/booking-service.ts`, `lib/availability-service.ts`, `lib/booking-notifications.ts`
> - `domain/availability.ts` (60 тестов), `domain/notification-schedule.ts`, `domain/booking-token.ts`
> - 6 E2E-файлов: `booking-create`, `booking-lifecycle`, `booking-rollout`, `booking-schedule`, `booking-security`, `public-booking`
> - 4 integration-файла: `booking-concurrency`, `booking-lifecycle`, `booking-maintenance`, `booking-metrics`
>
> Скрыт за `bookingAccess` enum, но **default = `"calendar"`**, не `"off"`. Entry Gate 7 и Gate 6 не пройдены.

---

## Статус Gate-критериев

### Gate 5 — Release Candidate

- [x] Нет Severity 1–2 дефектов
- [x] Все финансовые unit/property tests
- [x] Критические E2E проходят
- [x] Tenant isolation — negative tests
- [x] Dashboard ≤2 сек. на 2 000 визитов
- [x] Interface от 360 CSS px
- [x] Экспорт данных Owner
- [ ] Restore из managed backup на staging
- [ ] Получен тестовый алерт на staging
- [ ] Юридическое утверждение privacy/terms

### Gate 0 — Concierge

- [ ] 3 фактические оплаты по 300 MDL
- [ ] Минимум 2 подтверждённых решения по цене/расходу
- [ ] Минимум 2 согласны на продление
- [ ] Данные приводятся к общей модели
- → Старт: 10 августа 2026

### Gate 6 — MVP подтверждён

- [ ] ≥10 платящих клиентов
- [ ] Activation rate 7 дней ≥70%
- [ ] ≥7 из 10 рассчитали 5+ услуг
- [ ] ≥6 приняли управленческое решение
- [ ] ≥6 из 10 продлились после 2-го месяца
- [ ] WAU среди платящих ≥60%
- [ ] Onboarding <120 мин.

### Entry Gate 7 — Online Booking

- [ ] Gate 6 пройден (все критерии выше)
- [ ] ≥3 орг. готовы перевести реальные записи
- [ ] ≥2 орг. готовы платить за booking отдельно
- [ ] Собраны реальные данные расписаний и исключений
- [ ] Выбран transactional messaging provider
- [ ] Утверждены consent и privacy для public flow

---

## Актуальные риски

| Риск | Уровень | Текущий статус |
|---|---|---|
| Нет фактических оплат | **Критичный** | Gate 0 не пройден. Разработка P0 завершена до него — нарушен порядок roadmap. Старт 10 авг. критичен. |
| Scope возвращается к booking CRM | **Критичный** | Ф7 в main. Default `bookingAccess = "calendar"` — нужно сменить на `"off"`. |
| Формуле не доверяют | **Критичный** | Технически снижен: breakdown, source links, append-only snapshots. Проверяется только на реальных клиентах. |
| Рецептуры слишком сложно вводить | **Высокий** | CSV templates и starter materials готовы. Реальное время onboarding неизвестно до Ф0. |
| Поддержка уничтожает SaaS-маржу | **Высокий** | Не измерено. Pilot telemetry и operator CLI готовы с первого клиента. |
| Финансовая история переписывается | **Критичный** | Снижен: append-only snapshots, 47 тестов в `visit-profit.test.ts`, audit log. |
| Утечка данных между организациями | **Критичный** | Снижен: RLS enforcement, `tenant-isolation.test.ts`, `verify-rls.sql`. |
| Double booking при гонке запросов | **Критичный** | Снижен: exclusion constraints, advisory lock, `booking-concurrency.test.ts`. Локально проверен, не в production. |

---

## Рекомендации

### 1. Закрыть три открытых пункта Gate 5 · немедленно, до 10 августа

Staged backup restore, тестовый алерт и юридическое утверждение privacy/terms — это ≤1–2 дня работы. Единственное, что отделяет от формально пройденного Release Candidate. Без этого пилот технически нельзя открывать.

### 2. Запустить concierge-этап 10 августа без отклонений · критично

Gate 0 — единственный коммерческий checkpoint перед масштабным пилотом. Три реальные оплаты, два подтверждённых решения, два согласия на продление. Если деньги не получены к 23 августа — возврат в customer discovery, без расширения scope. Весь P0 уже реализован: больше не нужно строить, нужно продавать.

### 3. Изменить default `bookingAccess` с `"calendar"` на `"off"` · сейчас

Каждая новая организация получает доступ к calendar по умолчанию. Это размывает продуктовое позиционирование — клиент входит в инструмент для расчёта прибыли и сразу видит фичу, которую не покупал. Открывать `calendar` и `public` только через явный оператор-флаг для участников пилота Ф7.

### 4. Заморозить разработку Фазы 7 · на весь период до Gate 6

Booking-модуль технически реализован и защищён feature-флагом. Дальнейшая разработка до Gate 6 — чистый waste: ни один из 6 Entry Gate 7 критериев не проверяем без реальных клиентов Ф6. Перенаправить инженерную мощность на стабилизацию пилота, onboarding-опыт и устранение дефектов из реального использования.

### 5. Измерять время onboarding и поддержки с первого дня пилота

Pilot telemetry и operator CLI готовы. С первого клиента фиксировать: минуты до первого расчёта, время ручного ввода основателя, количество исправлений. Целевые уровни — ≤120 мин. onboarding, ≤20 мин/account/месяц поддержки. Эти метрики определяют, является ли продукт SaaS или service-бизнесом.

### 6. Открывать Фазу 7 только при выполнении всех 6 Entry Gate критериев

Entry Gate 7 — не формальность. Без ≥3 организаций, готовых перевести реальные записи, и ≥2, готовых платить за booking отдельно, запуск Availability Engine в production создаёт сложность без коммерческой отдачи. Booking-раздел roadmap написан как страховка, а не как предрешённый следующий шаг.

---

## Итоговый вывод

Команда построила исключительно глубокий MVP: весь P0 технического scope готов, плюс полная Фаза 7, которая по roadmap должна была стартовать через полгода. Это впечатляющий engineering-результат.

Одновременно — ни один из business gates не пройден: нет оплат, нет activation данных, нет retention.

Ближайшие 6 недель (10 авг. – 22 сент.) определяют, является ли Nail Profit OS бизнесом. Всё необходимое для проверки уже в production-ready состоянии. Задача сейчас — **продавать, а не строить**.

---

*Nail Profit OS · Аудит по roadmap v1.1 · 7 августа 2026*
