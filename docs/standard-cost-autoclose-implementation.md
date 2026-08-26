> **Отменено.** Материальный движок удалён из продукта целиком —
> таблицы `material*`, `recipe*` и `consumption`, страница «Материалы»,
> её API и материальная часть себестоимости. Документ оставлен как запись
> о том, что было сделано и почему; ничего из описанного здесь в коде
> больше нет. См. миграцию `drizzle/0040_remove_material_engine.sql`.

# Standard Cost by Default — отчёт о реализации

Дата: 2026-08-14  
Классификация изменения: **MEDIUM**

## Architecture

Проект использует Next.js 16.3 App Router, React 19.2, TypeScript 6, REST route handlers, Drizzle ORM/PostgreSQL, Zod 4, Vitest, Better Auth, tenant-транзакции с PostgreSQL RLS и словари `ru` / `ro` / `en`.

До изменения финансовая архитектура уже имела подходящие примитивы:

- versioned recipes для услуг и add-ons;
- versioned material prices;
- строки нормативного и фактического расхода внутри визита;
- один costing engine в `domain/costing.ts`;
- append-only financial snapshots;
- versioned corrections завершённого визита;
- dashboard и месячный P&L, читающие последний snapshot, а не live-каталог;
- Commission Engine, Expense Registry, audit events и tenant RLS.

Главный конфликт был в completeness-логике: отсутствие actual usage делало визит incomplete. Кроме того, форма закрытия визуально превращала нормативные количества в обязательные «фактические» значения.

Новая сущность CostProfile не создавалась: существующая recipe model является authoritative standard profile.

## Changes

### Domain

Добавлен единый `resolveEffectiveMaterialUsage`:

- `actualQuantity !== null` — override конкретного материала;
- `actualQuantity === null` — используется standard quantity;
- `actualQuantity === 0` — явное удаление материала из effective usage;
- extra material — standard quantity `0` плюс actual quantity;
- хотя бы один override делает общий source равным `actual`;
- неизвестная цена остаётся `null` и блокирует margin, а не превращается в ноль.

Partial override выбран как основная семантика: материалы без override продолжают использовать свой standard usage.

Для service/add-on без сохранённой recipe version введено явное состояние `standardMaterialUsageKnown = false`. Даже частично настроенный профиль остаётся incomplete: наличие рецепта услуги не скрывает отсутствующий рецепт add-on.

### Simple material modes

Поддержаны три режима входных данных:

- `quantity` — цена упаковки / физический объём;
- `services_per_package` — цена упаковки / оценочное число услуг;
- `fixed_per_service` — фиксированная сумма на услугу.

Все режимы нормализуются в существующую exact package ratio model. Второй costing engine не создавался, rounding policy не менялась.

### Visit close и exception flow

Обычное закрытие отправляет пустой список actual consumption. Backend копирует рецепт, актуальные на момент завершения цены, комиссию, налоги и payment terms в строки визита и snapshot.

Форма показывает приблизительный standard material total и прячет overrides под действием «Изменить расход». В календаре подтверждённая запись показывает перед завершением:

- расчётную стоимость материалов;
- вознаграждение мастера;
- contribution margin.

Обычный сценарий — одна явная кнопка «Завершить в визит». Время само по себе никогда не создаёт visit или financial snapshot.

Calendar exception form отправляет только действительно заполненные overrides. Пустое поле сохраняет standard, `0` явно убирает материал. Дополнительный материал можно добавить как во время ручного завершения, так и при завершении booking.

После завершения можно:

- изменить quantity;
- вернуть material к standard значением `null`;
- убрать material значением `0`;
- добавить extra material;
- изменить duration и refunds.

Correction сохраняет новый snapshot version и audit event с before/after consumptions, refunds, actor и optional reason. Старый snapshot не изменяется.

Для double click/network retry добавлены `Idempotency-Key`, request fingerprint и уникальность `(organization_id, completion_key)`. Повтор идентичного запроса возвращает исходный visit/snapshot; повтор ключа с другим payload получает `409 IDEMPOTENCY_CONFLICT`.

Booking completion также replay-safe: повтор после потерянного HTTP-ответа возвращает уже созданные visit/snapshot с `200`, а не повторяет transition и не создаёт вторую финансовую версию.

### Generic catalog и presets

Starter catalog расширен до 35 generic consumable types. В него входят disposable, preparation, coating, removal, care, pedicure, hygiene и nail-art расходники; оборудование и reusable tools не добавляются. Цены намеренно не seed-ятся.

Добавлены opt-in system estimates:

- 8 service presets: basic/gel manicure, reinforcement, basic/gel pedicure, short/medium/long gel extensions;
- 7 add-on presets: soak-off, e-file removal, repair, French, simple art, chrome, rhinestones.

Preset только заполняет обычную форму recipe. Владелец проверяет значения и сохраняет их как новую organization-owned recipe version. Изменение recipe затем влияет только на новые визиты; system baseline и исторические snapshots не меняются.

### Reporting

Dashboard и месячный P&L продолжают читать effective `material_cost_minor` из последней версии snapshot. Purchase reconciliation сохранён отдельно и не меняет P&L.

Месячный отчёт показывает breakdown по пяти группам: nail materials, disposable consumables, pedicure, sanitation и add-ons/nail art. Breakdown считается из visit-owned consumption snapshots только для полностью рассчитанных визитов; его итог совпадает с effective material cost P&L и не использует закупки месяца.

Месячный отчёт дополнен breakdown по мастерам:

- visits;
- generated revenue;
- commission rule(s), сохранённые в визитах;
- calculated compensation.

Count-based data confidence уже выражается количеством incomplete visits, revenue с неполными данными и breakdown причин.

### Performance

Разрешение цен при закрытии переведено с запроса на каждый материал на один `DISTINCT ON` query для всех material IDs. Add-on recipes собираются один раз и одинаковые материалы суммируются до расчёта, поэтому стоимость округляется один раз.

## Preserved

Без переписывания сохранены:

- основной Costing Engine и deterministic integer rounding;
- Commission Engine, включая percentage, fixed, hybrid и after-materials rules;
- recipe и price versioning;
- append-only snapshot history;
- Expense Registry и purchase/consumption reconciliation;
- RLS tenant boundary и server-side organization context;
- существующий seed типовых consumables без выдуманных закупочных цен;
- actual usage как correction-by-exception;
- отсутствие automatic inventory deduction.

## Database

Добавлена additive migration `0033_gorgeous_orphan.sql`:

- enum `material_costing_mode`;
- `material_price_version.costing_mode NOT NULL DEFAULT 'quantity'`;
- nullable `financial_snapshot.material_usage_source` с check `standard | actual`;
- `visit.standard_material_usage_known NOT NULL DEFAULT true`;
- nullable `visit.completion_key` и `visit.completion_fingerprint`;
- unique index `(organization_id, completion_key)`.

Миграция ничего не удаляет, не пересчитывает и не backfill-ит в исторических финансовых строках. Она применена к development и test database.

Для финального слоя presets, preview, extra-material completion и material breakdown новая migration не потребовалась: stable generic keys используют существующий `material.sku`, presets — существующие versioned recipes, а breakdown — visit-owned consumption snapshots.

## Financial Logic

Для каждого material item:

```text
effective quantity = actual override, если он существует
                     иначе standard quantity

material cost = round(package price × effective quantity / package size)
```

На визите:

```text
effective material cost = Σ effective material item cost

contribution =
  revenue
  - effective material cost
  - master compensation
  - payment commission
  - applicable taxes
```

В месячном P&L используется существующая продуктовая формула с snapshot totals:

```text
operating profit =
  revenue
  - effective material cost
  - visit labour / master compensation
  - payment commissions and applicable taxes
  - salaried labour
  - other operating expenses
  + existing principal-labour add-back semantics
```

Покупки материалов показываются в reconciliation/cash flow и не подменяют стоимость потребления.

## Backward Compatibility

- Existing completed visits и financial snapshots не пересчитываются.
- Для старых snapshots `material_usage_source = null`; UI называет их историческими данными, не стандартными.
- Existing material price versions получают только декларативный default `quantity`.
- Existing visits получают `standard_material_usage_known = true`, чтобы коррекция старого визита сохраняла прежнюю интерпретацию и не создавала новый blocker.
- Старый сохранённый `material_cost_minor` остаётся authoritative historical cost.
- Новые цены, recipes и commission rules влияют только на будущие завершения.

## Tests

Добавлены unit/integration/E2E проверки:

- standard-only, actual, partial override и explicit zero;
- missing price и missing/partial recipe profile;
- three Simple Mode normalizations и rounding;
- add-on material cost exactly once;
- extra material during completion и cross-tenant negative case;
- стандартное закрытие без material form;
- source `standard` → correction source `actual`;
- correction append-only history;
- price history immutability;
- idempotent replay и conflicting fingerprint;
- dashboard/month report effective totals;
- tenant isolation и dashboard performance.
- booking completion network replay: один visit и один snapshot;
- 35 generic consumables и полный набор 8 + 7 P0 presets;
- monthly material breakdown equals snapshot total.

Финальные результаты текущего рабочего дерева:

- `npm run lint` — pass;
- `npm run typecheck` — pass;
- `npm test` — 60 files, 681 tests passed;
- `NOTIFICATION_PROVIDER=log npm run test:integration` — 20 files, 232 tests passed;
- critical visit/profit/idempotency E2E — 7 passed;
- `npm run build` — pass.

Полный RBAC matrix имеет 2 несвязанных с этой функцией нарушения: семь ранее добавленных endpoints отсутствуют в самом тестовом matrix, а permission expectation для `PUT /api/v1/availability/rules` расходится с текущим route/RBAC. Функциональные E2E новой модели проходят.

## Risks

- `services_per_package` и `fixed_per_service` используют логическую единицу «одна услуга» поверх существующей package ratio model. Recipe quantity для такого материала должна оставаться понятной пользователю (обычно `1`).
- System presets — стартовые оценки. Для полезного финансового результата владелец всё равно должен указать собственные package prices и проверить нормы.
- Legacy source намеренно остаётся `null`, поэтому невозможно постфактум надёжно определить, был старый snapshot нормативным или фактическим.
- Feature flag не добавлен: в проекте нет общего per-organization flag framework для финансового engine, а закрытый pilot access уже ограничивает rollout. Добавление отдельного флага создало бы два completion behavior и увеличило regression surface.

## Deferred

Осознанно не вошли в MVP:

- inventory/warehouse deductions;
- supplier/procurement flow;
- cost groups/shade grouping;
- estimated market prices (чтобы не выдавать предположение за цену организации);
- depreciation/equipment costing;
- отдельная сложная confidence score;
- новый analytics provider.

Существующий starter material seed сохранён как безопасный onboarding layer: он добавляет только consumable names/units/categories, но не выдумывает цены.
