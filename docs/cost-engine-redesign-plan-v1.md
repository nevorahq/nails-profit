# План реализации: система учёта и расчёта затрат

Редизайн финансового ядра Nail Profit OS: от «прибыль визита» к двухуровневой
модели «Contribution Margin визита → Operating / Economic Profit месяца».

Документ описывает **что добавлять, куда и в каком порядке**. Он опирается на
то, что уже построено: см. раздел «Что переиспользуется».

---

## 0. Что переиспользуется (не переписывать)

| Что | Где | Роль в новой модели |
|---|---|---|
| Целочисленная арифметика | `domain/money.ts`, `domain/units.ts` | Остаётся основанием: minor units, milli-units, `roundRatio` half-away-from-zero |
| Движок себестоимости | `domain/costing.ts` | Расширяется до `costing-v2`, структура сохраняется |
| Прибыль визита | `domain/visit-profit.ts` | Расширяется (refunds, налоги, эквайринг) |
| Рецептуры | `domain/recipe-cost.ts` | Без изменений |
| Комиссии мастера | `domain/commission.ts` | Расширяется на этапе 5 |
| Агрегация периода | `domain/dashboard-metrics.ts` | Становится входом для месячного P&L |
| Снапшоты | `financial_snapshot`, `lib/visit-service.ts` | Append-only версии — механизм для смены формулы без пересчёта истории |
| Часы работы | `schedule_rule`, `availability_exception` | Источник available hours для capacity |
| Тип бизнеса | `organization.type` (`solo`/`studio`) | Уже в схеме, но нигде не используется — включаем на этапе 3 |

### Инварианты, которые редизайн обязан сохранить

1. **Неизвестная себестоимость никогда не читается как ноль.** Визит остаётся
   `incomplete` с перечнем причин.
2. **Закрытый визит самодостаточен.** Правки каталога, цен, ставок и налогов не
   меняют историю.
3. **Коррекция = новая версия снапшота**, не UPDATE.
4. **Агрегат периода = сумма последних снапшотов визитов.** Проверяется
   интеграционным тестом.
5. **Каждая таблица с `organization_id` получает RLS-политику вручную** —
   Drizzle её не генерирует, `scripts/verify-rls.sql` валит сборку, если забыли.

---

## Этап 0. Фундамент

Пользователь новых цифр не видит. Без этого этапа налоги задним числом испортят
историю.

### 0.1. Политика типа бизнеса

**Создать `domain/business-model.ts`:**

```ts
export type BusinessType = "solo" | "studio";

export type BusinessPolicy = Readonly<{
  /** Считается ли расчётная зарплата владельца. */
  ownerWage: boolean;
  /** Показывать ли Economic Profit рядом с Cash Profit. */
  economicProfit: boolean;
  /** Какие схемы оплаты труда доступны в настройках. */
  payrollSchemes: readonly ("percentage" | "fixed_monthly" | "hybrid")[];
  /** Ключ префикса словаря: "solo" или "studio". */
  labels: BusinessType;
}>;

export function policyFor(type: BusinessType): BusinessPolicy;
```

Тесты — `domain/business-model.test.ts`.

### 0.2. Версионирование формулы

`domain/costing.ts`: вынести `formulaVersion` в константу
`export const CURRENT_FORMULA_VERSION = "costing-v2"` и перестать хардкодить
строку в `lib/visit-service.ts:465`.

Правило: старые снапшоты остаются `costing-v1` и **никогда не пересчитываются**.
Визит без снапшота налогов считается по v2 идентично v1 (все новые слагаемые = 0),
поэтому корректировка старого визита безопасна.

### 0.3. Валюта визита (дефект)

`lib/visit-service.ts:394` хардкодит `currency: "MDL"` — организация на EUR
получит снапшот в чужой валюте при корректировке.

- Добавить колонку `visit.currency` (`currency` enum, notNull, default `'MDL'`).
- Бэкфилл: `update "visit" set currency = o.currency from "organization" o where ...`.
- `recalculateVisitProfit` читает `visit.currency`.

### 0.4. RBAC

`domain/rbac.ts`: добавить capability `"finance"` в массив `capabilities` и в
матрицу ролей:

| Роль | finance |
|---|---|
| owner | read + write, scope `all` |
| manager | read, scope `all` (без зарплаты владельца) |
| master | нет |
| analyst | read, constraint `aggregates_only` |

Постоянные расходы, оклады и Economic Profit не должны быть видны мастеру.
Обновить `domain/rbac.test.ts`.

### 0.5. Миграция

`drizzle/0023_*.sql`: колонка `visit.currency` + бэкфилл. RLS не затрагивается.

---

## Этап 1. Visit v2 — полный Direct Cost

Соответствует шагу 1 вашего roadmap.

### 1.1. Схема

**Новая таблица `payment_method`** (`db/schema.ts`, рядом с `specialists`):

```
payment_method
├── id, organization_id
├── name text notNull
├── kind pgEnum payment_method_kind: cash | card | transfer | other
├── commission_basis_points integer notNull default 0
├── fixed_fee_minor bigint notNull default 0
├── is_default boolean notNull default false
├── archived_at
└── ...auditColumns
index: (organization_id), unique partial: один is_default на организацию
check: commission_basis_points >= 0 and fixed_fee_minor >= 0
```

Версионирование не нужно: ставка снапшотится в визит при закрытии.

**Новая таблица `tax_rule`** (по образцу `commission_rule` — версионируемая):

```
tax_rule
├── id, organization_id
├── kind pgEnum tax_kind: vat | turnover | payroll | fixed_contribution
├── basis_points integer            -- для vat/turnover/payroll
├── fixed_amount_minor bigint       -- для fixed_contribution (в месяц)
├── remittable boolean notNull default true   -- VAT перечисляемый?
├── active_from timestamptz notNull defaultNow
├── active_to timestamptz
└── ...auditColumns
check: shape по kind (ставка XOR фикс)
index: (organization_id, kind, active_from)
```

**Изменения в существующих таблицах:**

```
visit
+ payment_method_id uuid references payment_method on delete set null
+ payment_commission_basis_points_snapshot integer
+ payment_fixed_fee_minor_snapshot bigint
+ tax_snapshot jsonb  -- { vat_bp, turnover_bp, payroll_bp, remittable_vat }

visit_line
+ refund_minor bigint notNull default 0
check: refund_minor >= 0 and refund_minor <= price_minor - discount_minor

financial_snapshot   (все nullable — expand-миграция)
+ net_revenue_minor bigint
+ vat_minor bigint
+ turnover_tax_minor bigint
+ payment_commission_minor bigint
+ payroll_tax_minor bigint
```

`financial_snapshot.commission_minor` сохраняет смысл «стоимость мастера»
(master cost) — не переименовываем, чтобы не ломать чтение истории.

### 1.2. Домен

`domain/costing.ts` — расширить `CostingInput` и `CostingResult`:

```ts
export type CostingInput = Readonly<{
  grossPriceMinor: number;      // было priceMinor
  discountMinor: number;
  refundMinor: number;
  materialCostMinor: number | null;
  durationMinutes: number;
  currency: Currency;
  commission: Commission;
  payment: Readonly<{ basisPoints: number; fixedFeeMinor: number }>;
  taxes: Readonly<{ vatBp: number; remittableVat: boolean; turnoverBp: number; payrollBp: number }>;
}>;
```

Порядок расчёта (закрепить в комментарии и в тестах):

```
Net Revenue = gross + addons − discounts − refunds − VAT(если перечисляемый)
Master Cost = по правилу комиссии (база — см. этап 5)
Direct Costs = materials + master_cost + payroll_tax + payment_commission + turnover_tax
CM  = Net Revenue − Direct Costs
CM% = CM / Net Revenue
Profit per Hour = CM / (duration / 60)
```

Все промежуточные суммы округляются один раз через `roundRatio`.

`domain/visit-profit.ts` — прокинуть новые поля, добавить причины
`missing_payment_method` в `VisitIncompleteReason` (только если у организации
включён учёт эквайринга и метод не выбран).

### 1.3. Сервис и API

- `lib/visit-service.ts`: `buildVisitDraft` снапшотит метод оплаты и активные
  `tax_rule`; `writeFinancialSnapshot` пишет новые колонки.
- `app/api/v1/payment-methods/route.ts` и `[id]/route.ts` — CRUD.
- `app/api/v1/tax-rules/route.ts` и `[id]/route.ts` — CRUD (owner).
- `app/api/v1/visits/route.ts`: принять `payment_method_id`.
- `app/api/v1/visits/[id]/adjust/route.ts`: добавить возврат (`refund`).

### 1.4. UI и i18n

- `components/visit-close-form.tsx` — выбор способа оплаты.
- `components/visit-adjust-form.tsx` — поле возврата.
- Разложение визита: Net Revenue → материалы → мастер → эквайринг → налоги → CM.
- `app/app/settings/page.tsx` — секции «Способы оплаты» и «Налоги»
  (`components/payment-method-manager.tsx`, `components/tax-rule-manager.tsx`).
- `i18n/dictionary.ts` — ключи `payment.*`, `tax.*`, `visit.netRevenue`,
  `visit.acquiring`, `visit.refund` × 3 локали (ru — источник истины, ro/en
  типизированы как полные записи, иначе не компилируется).

### 1.5. Миграция и тесты

`drizzle/0024_*.sql`: таблицы + RLS-блок для `payment_method` и `tax_rule` по
образцу `drizzle/0012:173`.

Тесты:
- `domain/costing.test.ts` — новые кейсы: VAT перечисляемый и нет, оборотный
  налог, эквайринг фикс + процент, возврат больше остатка (отказ).
- `tests/integration/visit-snapshots.test.ts` — визит без налогов даёт те же
  цифры, что `costing-v1`.

---

## Этап 2. Fixed Costs и месячный P&L → Operating Profit

Соответствует шагу 2 вашего roadmap. Первый этап, который даёт видимую ценность.

### 2.1. Схема

```
fixed_cost_category pgEnum:
  rent | utilities | software | accounting | marketing | insurance
  | taxes_fixed | depreciation | other

fixed_cost
├── id, organization_id
├── category fixed_cost_category notNull
├── name text notNull
├── amount_minor bigint notNull
├── currency currency notNull
├── period_month date              -- первый день месяца; NULL для повторяющегося
├── is_recurring boolean notNull default false
├── recurring_from date            -- для is_recurring
├── recurring_to date              -- NULL = бессрочно
├── archived_at
└── ...auditColumns
check: (is_recurring and recurring_from is not null and period_month is null)
    or (not is_recurring and period_month is not null)
check: amount_minor >= 0
index: (organization_id, period_month), (organization_id, is_recurring)
```

Повторяющийся расход хранится **одной строкой** с интервалом, а не
материализуется помесячно: аренда, изменённая в марте, не должна переписывать
январь — вместо этого пишется новая строка с `recurring_from`, а у старой
проставляется `recurring_to`.

### 2.2. Домен

**Создать `domain/fixed-costs.ts`:**

```ts
export type FixedCostRow = Readonly<{ ... }>;
/** Разворачивает повторяющиеся расходы в конкретный месяц. */
export function fixedCostsForMonth(
  rows: readonly FixedCostRow[],
  month: string,           // "YYYY-MM"
): readonly ResolvedFixedCost[];
export function totalFixedCostMinor(resolved: readonly ResolvedFixedCost[]): number;
export function byCategory(resolved): Readonly<Record<FixedCostCategory, number>>;
```

**Создать `domain/period-pl.ts`:**

```ts
export type PeriodPL = Readonly<{
  month: string;
  revenueMinor: number;
  netRevenueMinor: number;
  materialCostMinor: number;
  masterCostMinor: number;
  variableCostMinor: number;        // эквайринг + оборотные налоги + payroll taxes
  contributionMarginMinor: number;
  fixedCostMinor: number;
  fixedByCategory: Readonly<Record<string, number>>;
  operatingProfitMinor: number;
  netMarginBasisPoints: number | null;
  /** Визиты без посчитанной маржи — сколько и почему. */
  incompleteVisits: number;
  incompleteRevenueMinor: number;
}>;

export function buildPeriodPL(input: PeriodPLInput): PeriodPL;
```

Вход — результат `aggregateVisitMetrics` плюс развёрнутые постоянные расходы.
Функция чистая, без БД: это то, что делает её тестируемой построчно.

### 2.3. Сервис, API, UI

- `lib/period.ts`: `loadPeriodPL(tx, { month, specialistId? }, locale)` — читает
  снапшоты через существующий `loadDashboard` и `fixed_cost`, вызывает
  `buildPeriodPL`.
- `app/api/v1/fixed-costs/route.ts` (GET/POST), `[id]/route.ts` (PATCH/DELETE).
- Страница `app/app/costs/page.tsx` + `components/fixed-cost-manager.tsx`
  (inline edit/delete и accordion добавления — как в `client-manager.tsx`).
- Страница `app/app/reports/month/page.tsx` — P&L помесячно, строка за строкой,
  с раскрытием по категориям.
- `components/nav-items.ts`: пункт `/app/costs` в группу `work` или `admin`,
  иконка в `components/icons.tsx`, ключ `nav.costs`. Добавить в `MASTER_HIDDEN`.
- i18n: `costs.*`, `pl.*` × 3 локали.

### 2.4. Миграция и тесты

`drizzle/0025_*.sql`: таблица + RLS.

Тесты:
- `domain/fixed-costs.test.ts` — разворот повторяющегося расхода, границы
  интервала, смена суммы посреди года.
- `domain/period-pl.test.ts` — Operating Profit, отрицательный результат, месяц
  без визитов, месяц без постоянных расходов.
- `tests/integration/period-pl.test.ts` — Σ снапшотов = выручка в P&L.

---

## Этап 3. Разделение Solo / Studio

Соответствует шагу 3.

- Прокинуть `organization.type` в `loadPeriodPL`, `loadDashboard` и страницы.
- `policyFor(type)` из этапа 0 решает: какие блоки рендерить, какие схемы оплаты
  предлагать в настройках, какой префикс словаря использовать.
- `components/organization-settings.tsx`: переключатель типа бизнеса (owner).
  Смена типа не пересчитывает историю — меняется только представление и набор
  доступных правил вперёд.
- i18n: параллельные ветки `solo.*` и `studio.*` для расходящихся подписей.

Тест: `domain/business-model.test.ts` + рендер-тест, что у соло нет блока
«Master Payroll», а у студии нет «Расчётной зарплаты владельца».

---

## Этап 4. Трудозатраты периода: оклад владельца и оклад мастера

Объединяет ваши шаги 4 и 5B. Обоснование: месячный оклад мастера и расчётная
зарплата владельца — это одна сущность (трудозатраты, не привязанные к визиту).
Разделять их в две таблицы значит писать один и тот же расчёт дважды.

### 4.1. Схема

```
labor_cost_recipient pgEnum: owner | specialist | admin
labor_cost_basis pgEnum: fixed_monthly | hourly | percent_revenue

labor_cost_rule
├── id, organization_id
├── recipient labor_cost_recipient notNull
├── specialist_id uuid references specialist   -- notNull когда recipient='specialist'
├── label text                                  -- «Администратор», «Уборка»
├── basis labor_cost_basis notNull
├── amount_minor bigint            -- fixed_monthly
├── hourly_rate_minor bigint       -- hourly
├── basis_points integer           -- percent_revenue
├── payroll_tax_basis_points integer notNull default 0
├── productive_hours_target integer -- для hourly и для «дохода за рабочий час»
├── active_from timestamptz notNull defaultNow
├── active_to timestamptz
└── ...auditColumns
check: shape по basis; check: (recipient = 'specialist') = (specialist_id is not null)
index: (organization_id, recipient, active_from)
```

### 4.2. Домен

**Создать `domain/labor-cost.ts`:**

```ts
/** Правило, действовавшее в этом месяце. Версионирование как в selectCommissionRule. */
export function selectLaborRules(rules, month): readonly LaborCostRule[];

export function monthlyLaborCostMinor(
  rule: LaborCostRule,
  context: { productiveHours: number; netRevenueMinor: number },
): number;   // включая payroll taxes
```

**Расширить `domain/period-pl.ts`:**

```ts
export type PeriodProfit = PeriodPL & Readonly<{
  /** Денежная прибыль: выручка − все фактические денежные расходы. */
  cashProfitMinor: number;
  /** Только solo: расчётная зарплата владельца. */
  ownerWageMinor: number | null;
  /** Только solo: Cash Profit − ownerWage. */
  economicProfitMinor: number | null;
  /** Только solo: max(0, economicProfit − резерв). */
  safeToWithdrawMinor: number | null;
  /** Net Revenue / productive hours. */
  revenuePerProductiveHourMinor: number | null;
}>;
```

**Правила, которые надо закодировать явно и покрыть тестами:**

1. Мастер на месячном окладе даёт `master_cost = 0` **на уровне визита**;
   зарплата вычитается один раз в месячном P&L. Иначе двойной счёт — это самая
   вероятная ошибка всего редизайна.
2. Административный персонал (`recipient = 'admin'`) — всегда overhead, никогда
   в Direct Costs визита.
3. Вывод денег владельцем не уменьшает Operating / Economic Profit. Он
   появляется только в Cash Flow (этап 7).
4. Часы владельца, работающего самостоятельно, идут в productive hours.

### 4.3. API, UI, миграция

- `app/api/v1/labor-costs/route.ts`, `[id]/route.ts` (owner).
- `components/labor-cost-manager.tsx` в настройках; для solo — форма «Расчётная
  зарплата владельца» (фикс / ставка × часы / % от выручки) + поле резерва.
- Блок в месячном отчёте ровно в вашем формате:

```
Выручка                              35 000
Материалы (потребление)              −5 000
Аренда + прочие fixed                −8 000
Комиссии и переменные налоги         −1 200
────────────────────────────────────────
Денежная прибыль                     20 800
Расчётная зарплата владельца        −15 000
────────────────────────────────────────
Экономическая прибыль                 5 800
```

- Резерв: колонка `organization.withdrawal_reserve_minor` (default 0).
- `drizzle/0026_*.sql`: таблица + RLS + колонка резерва.
- Тесты: `domain/labor-cost.test.ts`, кейс «мастер на окладе не удваивается»
  в `tests/integration/period-pl.test.ts`.

---

## Этап 5. Payroll v2 для студии

Соответствует шагам 5A и 5C.

### 5.1. Схема

```
commission_rule
+ base pgEnum commission_base: full_price | after_discount | after_materials | selected_services
      notNull default 'after_discount'      -- сегодняшнее поведение
+ bonus_minor bigint notNull default 0
+ payroll_tax_basis_points integer notNull default 0

commission_rule_service   -- для base = 'selected_services'
├── id, organization_id, commission_rule_id, service_id
unique: (commission_rule_id, service_id)

commission_type enum: + 'hybrid'
```

`visit` снапшотит `commission_base`, `commission_bonus_minor`,
`commission_payroll_tax_bp` — по тому же принципу, что уже действует для типа
и ставки.

### 5.2. Домен

- `domain/costing.ts`: `Commission` получает вариант
  `{ type: "hybrid"; fixedAmountMinor; basisPoints; bonusMinor }` и поле `base`.
  Функция выбора базы:

```ts
function commissionBase(input: CostingInput): number;
// full_price        → gross
// after_discount    → gross − discounts − refunds        (текущее поведение)
// after_materials   → база после скидок − материалы, не ниже нуля
// selected_services → сумма только по отмеченным строкам
```

- `domain/commission.ts`: `toCommission` учитывает новые поля; `selectCommissionRule`
  без изменений (приоритеты уже верные).
- Часовая ставка мастера на окладе для Fully Loaded:
  `(оклад + payroll taxes) / practical capacity hours` — считается в
  `domain/capacity.ts` (этап 6), **не** попадает в CM.

### 5.3. UI и миграция

- `components/specialist-manager.tsx`: конструктор правила — тип, база, ставка,
  фикс, бонус, налоги на ФОТ, выбор услуг для `selected_services`.
- `drizzle/0027_*.sql`: `ALTER TYPE commission_type ADD VALUE 'hybrid'` (отдельным
  стейтментом, до использования), новые колонки с дефолтами, новая таблица + RLS.
- Тесты: `domain/commission.test.ts` — все четыре базы; `domain/costing.test.ts` —
  гибрид; проверка, что дефолт `after_discount` воспроизводит старые числа.

---

## Этап 6. Practical Capacity, Break-even, Utilization

Соответствует шагу 5 исходной нумерации.

### 6.1. Настройки

```
organization
+ practical_capacity_basis_points integer notNull default 7500   -- 75%
```

### 6.2. Домен

**Создать `domain/capacity.ts`:**

```ts
/** Доступные часы месяца из schedule_rule и availability_exception. */
export function availableHours(rules, exceptions, month, timezone): number;

export function practicalCapacityHours(available: number, basisPoints: number): number;

export function capacityUtilizationBasisPoints(
  bookedMinutes: number, practicalHours: number,
): number | null;

/** Ставка распределения постоянных расходов — только для Fully Loaded. */
export function fixedCostRateMinorPerHour(
  fixedCostMinor: number, practicalHours: number,
): number | null;

export function breakEvenRevenueMinor(
  fixedCostMinor: number, contributionMarginBasisPoints: number,
): number | null;

export function fullyLoadedCostMinor(
  directCostMinor: number, durationMinutes: number, rateMinorPerHour: number,
): number;
```

**Ключевое правило:** знаменатель — practical capacity (70–80% доступных часов),
а **не** фактические часы слабого месяца. Низкая загрузка отражается отдельным
KPI `Capacity Utilization`, а не раздувает себестоимость услуг. Это надо
закрепить комментарием и тестом «месяц с двумя визитами не делает услугу
дороже».

### 6.3. UI

- Месячный отчёт: карточки Break-even Revenue, Capacity Utilization,
  Profit per Productive Hour.
- `app/app/services/[id]/page.tsx`: переключатель «Contribution Margin /
  Fully Loaded» с явной подписью, что во втором режиме добавлена доля
  постоянных расходов.
- `drizzle/0028_*.sql`: колонка настройки.
- Тесты: `domain/capacity.test.ts`, включая деление на ноль (пустой месяц →
  `null`, не ноль).

---

## Этап 7. Журнал материалов и Cash Flow

Соответствует шагам 6–7. Вынесен в конец сознательно: текущая модель уже
соблюдает «покупка ≠ расход», потому что расход приходит только из визита.

### 7.1. Схема

```
material_movement_type pgEnum: purchase | write_off | return | adjustment

material_movement
├── id, organization_id
├── material_id uuid notNull references material
├── type material_movement_type notNull
├── quantity_milli_units bigint notNull
├── amount_minor bigint            -- для purchase и return
├── currency currency
├── occurred_at timestamptz notNull
├── note text
├── linked_visit_id uuid references visit    -- для справки, не для расчёта
└── ...auditColumns
index: (organization_id, material_id, occurred_at)
```

**Связь с существующим:**

- `purchase` автоматически создаёт `material_price_version` (цена и объём
  упаковки), поэтому закупка обновляет себестоимость будущих визитов и не
  трогает прошлые.
- `consumption` (расход по визитам) **остаётся источником истины для P&L**.
  Движения типа `consumption` в журнал не дублируются — остаток на складе
  считается как `Σ purchase − Σ consumption по визитам − Σ write_off + Σ return`
  в `domain/stock.ts`.

### 7.2. Cash Flow

```
owner_draw
├── id, organization_id, amount_minor, currency, occurred_at, note
└── ...auditColumns
```

**Создать `domain/cash-flow.ts`:** приток (оплаченные визиты) минус отток
(закупки, оплаченные постоянные расходы, выплаты мастерам, выводы владельца).
Отдельный отчёт, **не смешанный с P&L**: вывод владельца не уменьшает прибыль.

### 7.3. Позже

- `period_close` — append-only снапшот закрытого месяца по образцу
  `financial_snapshot` (агрегаты + fixed + operating/economic profit +
  `formula_version`). Нужен, когда появится план/факт и rolling 90 дней.
- Rolling 90 days, план/факт.

---

## Сквозные требования на каждом этапе

| Требование | Как проверяется |
|---|---|
| RLS на каждой новой таблице с `organization_id` | `npm run db:verify-rls` (структурная проверка валит сборку) |
| Три локали без пропусков | `i18n/dictionary.ts` типизирован полными записями — не скомпилируется |
| Expand-миграции | Все новые колонки nullable или с дефолтом; `tests/migration-compatibility.test.ts` |
| Чистый домен без БД | Каждая формула — функция в `domain/`, тест в `domain/*.test.ts` |
| Агрегат = сумма снапшотов | `tests/integration/` |
| Права | `domain/rbac.test.ts` + проверка `can()` в каждом новом route |
| Формулы видны пользователю | DSH-009: у каждой цифры подпись-формула (уже реализовано через `title` в `MetricCard`) |

## Порядок и отличия от исходного roadmap

| Шаг | Ваш порядок | Предлагаемый | Почему |
|---|---|---|---|
| Фундамент | — | 0 | Без версии формулы и capability `finance` налоги задним числом ломают историю |
| Visit Profit | 1 | 1 | Без изменений |
| Fixed Costs → Operating Profit | 2 | 2 | Без изменений |
| Solo / Studio | 3 | 3 | Без изменений |
| Owner's Wage + Economic Profit | 4 | 4 (объединён с 5B) | Оклад мастера и зарплата владельца — один механизм |
| Payroll студии | 5 | 5 | Только visit-level часть (проценты, базы, гибрид) |
| Capacity + Break-even | 5 | 6 | Зависит от fixed costs из этапа 2 |
| MaterialMovement | базовые сущности | 7 | Текущая модель уже соблюдает «покупка ≠ расход»; склад — отдельный продукт |
| Cash Flow | 6 | 7 | Вместе со складом: оба про деньги, а не про прибыль |
| Rolling 90 / план-факт | 7 | после 7 | Требует `period_close` |

**Минимальный релиз, который уже полезен:** этапы 0 → 2 → 3 → 4. Это даёт
месячный P&L, Operating Profit и Economic Profit для соло — то есть главную
цифру, которой сейчас нет. Налоги и эквайринг (этап 1) можно доставить следом,
не ломая ни одного снапшота.
