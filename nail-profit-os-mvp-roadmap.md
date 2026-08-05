# Nail Profit OS — итоги и roadmap реализации MVP

**Версия:** 1.1\
**Дата:** 5 августа 2026\
**Рекомендуемый старт:** 10 августа 2026  
**Цель:** запустить платный Costing MVP, проверить повторную оплату и только затем расширять продукт до полной версии 1.1  
**География пилота:** Республика Молдова  
**Продуктовая позиция:** Nail Profit Layer поверх Fresha, DIKIDI, YCLIENTS, Stilio или таблиц

---

## 1. Итог проекта на текущий момент

### 1.1. Что уже сделано

- сформирована продуктовая концепция Nail Profit OS;
- подготовлено техническое ТЗ версии 1.1;
- из продукта исключены предоплата, депозиты, приём платежей и связанные процессы;
- подготовлена UX/UI-концепция `Studio Ledger`;
- создан интерактивный UI-preview;
- подготовлен бизнес-план версии 1.1;
- создана финансовая модель на 36 месяцев;
- определён первый оплачиваемый результат: реальная себестоимость услуги и прибыль в час.

### 1.2. Что подтверждено рынком

| Подтверждённый факт | Вывод |
|---|---|
| Три потенциальных клиента готовы платить | Есть ранний commercial signal |
| Подтверждённая цена — 300 MDL/месяц | Можно начинать с платного concierge-пилота |
| Клиенты готовы платить до готового приложения | Не нужно ждать полной разработки для получения выручки |
| Клиенты уже используют Fresha, DIKIDI, YCLIENTS или Stilio | Продукт должен дополнять существующую запись |
| Главная боль — реальная себестоимость услуги | Costing является первым продуктовым wedge |

### 1.3. Что пока не подтверждено

- фактическая оплата, а не обещание;
- продление подписки на второй и третий месяц;
- готовность регулярно обновлять цены материалов и нормы расхода;
- готовность студий платить 699–899 MDL и выше;
- способность клиента пройти onboarding без постоянной помощи основателя;
- необходимость retention и slot protection как платных функций;
- возможность получить данные из текущих CRM без дорогих интеграций.

### 1.4. Главный вывод

Полное техническое ТЗ версии 1.1 содержит Costing, Retention, Slot Protection, календарь, waitlist, кампании, уведомления, фотографии и расширенную аналитику. Это уже не минимальный коммерческий MVP.

Рекомендуемая последовательность:

```text
Платный concierge-пилот
        ↓
Costing MVP
        ↓
Visit Profit и стабильный импорт
        ↓
Закрытый MVP-пилот и Gate 6
        ↓
Online Booking
        ↓
Retention
        ↓
Slot Protection
        ↓
Полная версия 1.1
```

---

## 2. Цель MVP

### 2.1. Главный пользовательский результат

Владелец или мастер должен за один сеанс получить объяснимый ответ:

> Сколько реально стоит эта услуга, сколько остаётся после материалов и комиссии и сколько она приносит в час?

### 2.2. Главная бизнес-гипотеза

Nail-мастер или небольшая студия будет регулярно платить за достоверный расчёт прибыльности услуг, даже если запись и клиенты остаются в другой системе.

### 2.3. North Star Metric

**Количество завершённых визитов с рассчитанной и доверенной фактической прибылью за месяц.**

### 2.4. Финансовая цель MVP

- получить первые три фактические оплаты по 300 MDL;
- получить минимум два продления на второй месяц;
- довести пилот до 10 платящих design partners;
- проверить продуктовые цены 349 MDL для Solo и 699–899 MDL для Studio;
- доказать, что onboarding и поддержка могут стать масштабируемыми.

---

## 3. Окончательная граница коммерческого MVP

### 3.1. Входит в P0

#### Platform

- регистрация и вход;
- организация типа Solo или Studio;
- Owner и Master; Manager можно включить при низкой дополнительной стоимости;
- tenant isolation;
- базовый audit log финансовых изменений;
- dev, staging и production;
- резервное копирование;
- продуктовые события без PII.

#### Каталог

- специалисты;
- услуги и категории;
- add-ons;
- длительность и цена услуги;
- основные параметры дизайна;
- комиссия мастера;
- архивирование без удаления финансовой истории.

#### Материалы и рецептуры

- материалы;
- закупочная цена;
- размер упаковки;
- единицы `ml`, `g`, `piece`;
- пересчёт стоимости базовой единицы;
- норматив расхода;
- рецептура услуги и add-on;
- предупреждение о неполных данных;
- история закупочных цен без изменения прошлых расчётов.

#### Costing Engine

- стоимость материалов;
- комиссия мастера: процент, фиксированная сумма, процент после материалов;
- contribution margin;
- margin percentage;
- прибыль в час;
- объяснение каждой составляющей;
- snapshot формулы и исходных данных;
- безопасное исправление через новую версию, а не переписывание истории.

#### Visit Profit

- минимальная карточка клиента;
- создание завершённого визита вручную;
- услуга, add-ons, мастер, цена и длительность;
- нормативный и фактический расход;
- закрытие визита на mobile;
- фактическая себестоимость и прибыль;
- история завершённых визитов.

#### Dashboard

- выручка;
- contribution margin;
- margin percentage;
- прибыль в час;
- самые и наименее прибыльные услуги;
- услуги с неполными данными;
- сравнение плановой и фактической себестоимости;
- фильтр по периоду и мастеру;
- tooltip или breakdown с формулой показателя.

#### Import и локализация

- CSV/Excel-шаблон для услуг, материалов и завершённых визитов;
- mapping, preview, validation и результат импорта;
- защита от повторных строк;
- русский, румынский и английский интерфейс;
- MDL и EUR без автоматической валютной конвертации;
- локальные форматы телефона, даты и времени;
- timezone `Europe/Chisinau` по умолчанию.

### 3.2. P1 — допускается после закрытого пилота

- рабочие места;
- фотографии визитов;
- расширенные design parameters;
- массовое изменение цен с датой вступления;
- фактические остатки материалов;
- low-stock alerts;
- расширенный отчёт по мастерам;
- CSV-экспорт dashboard;
- английский контент помощи, если интерфейс уже локализован технически;
- один стандартизированный CRM import preset.

### 3.3. Не входит в MVP

- собственный полноценный календарь;
- consumer marketplace;
- публичная онлайн-запись общего назначения;
- автоматические напоминания;
- one-click rebooking;
- lost client list;
- reactivation campaigns;
- cancellation policy automation;
- waitlist;
- уведомления об освободившемся времени;
- recovered revenue;
- live-коннекторы ко всем CRM;
- сложный склад и закупки;
- POS, касса, фискализация и бухгалтерия;
- предоплата, депозиты и обработка платежей;
- нативные iOS/Android-приложения;
- AI-функции.

### 3.4. Почему Retention и Slot Protection отложены

Эти модули требуют календаря, уведомлений, consent, публичных ссылок, фоновых заданий, защиты от конфликтов и измерения атрибуции. Они увеличивают технический объём и юридическую поверхность, но готовность платить пока подтверждена только за Costing.

Их перенос не отменяет полную концепцию версии 1.1. Он защищает первые 12–14 недель от потери фокуса.

---

## 4. План реализации: 12–14 недель

Календарь рассчитан на команду из двух инженеров. При одном инженере реалистичный срок — 18–22 недели.

### Фаза 0. Платный concierge и данные

**Срок:** 10–23 августа 2026, недели 1–2  
**Цель:** получить деньги и реальные данные до масштабной разработки.

#### Работы

- получить три фактические оплаты по 300 MDL;
- согласовать объём трёхмесячного пилота;
- собрать по 10–15 ключевых услуг каждого клиента;
- собрать материалы, упаковки, закупочные цены и нормы;
- вручную рассчитать себестоимость и прибыль;
- записать спорные единицы, комиссии и исключения;
- провести три наблюдаемых UX-теста текущего прототипа;
- определить минимальный CSV-шаблон.

#### Результаты

- три набора реальных данных;
- три ручных profit reports;
- список повторяющихся операций для автоматизации;
- уточнённая формула contribution margin;
- подтверждённая терминология RU/RO.

#### Gate 0

Разработка продолжается, если:

- получены три оплаты;
- минимум два клиента подтвердили конкретное решение о цене, расходе или составе услуги;
- минимум два клиента согласны продлить пилот;
- данные можно привести к общей модели без отдельной логики для каждого клиента.

Если оплаты не получены, работа возвращается в customer discovery; инженерный scope не расширяется.

---

### Фаза 1. Product definition и foundation

**Срок:** 24 августа – 6 сентября, недели 3–4  
**Цель:** создать безопасный каркас SaaS и зафиксировать сквозной flow.

#### Product и UX

- финализировать flow `onboarding → услуга → материалы → результат`;
- проверить его на трёх design partners без подсказок;
- утвердить словарь: себестоимость, останется вам, маржа, прибыль в час;
- утвердить mobile flow закрытия визита;
- утвердить состояния incomplete data и ошибки импорта.

#### Engineering

- создать dev/staging/production;
- настроить auth;
- реализовать organization и tenant isolation;
- заложить роли Owner/Master;
- создать PostgreSQL schema и миграции;
- создать модульный монолит и REST API;
- заложить i18n, MDL/EUR и timezone;
- настроить structured logs, error tracking и request IDs;
- настроить daily backup;
- внедрить feature flags.

#### Gate 1

- design partners рассчитывают тестовую услугу не более чем за 10 минут;
- каждый может объяснить итоговую сумму;
- cross-tenant negative test проходит;
- staging автоматически разворачивается;
- восстановление тестовой БД задокументировано.

---

### Фаза 2. Каталог и Costing Core

**Срок:** 7–27 сентября, недели 5–7  
**Цель:** получить первый полный расчёт в продукте.

#### Backend

- специалисты и комиссии;
- услуги, add-ons и snapshots;
- материалы и единицы измерения;
- история закупочных цен;
- рецептуры;
- deterministic Costing Engine;
- completeness status;
- audit events финансовых изменений.

#### Frontend

- список услуг;
- карточка услуги;
- редактор рецептуры;
- каталог материалов;
- financial insight panel;
- cost breakdown;
- предупреждения о недостающих данных;
- responsive desktop/mobile states.

#### Автоматические тесты

- округление денежных сумм;
- упаковка → базовая единица;
- нулевой или неизвестный размер упаковки;
- три типа комиссии;
- изменение закупочной цены;
- изменение рецептуры без изменения истории;
- add-on с дополнительным временем и материалами.

#### Gate 2

Канонический сценарий рассчитывается точно:

```text
Цена услуги:          600 MDL
Комиссия 40%:         240 MDL
Материалы:             35 MDL
Contribution margin:  325 MDL
Margin:              54.17%
Длительность:          90 мин.
Прибыль в час:       216.67 MDL
```

Дополнительно:

- 100% критических финансовых unit tests проходят;
- расчёт содержит ссылку на исходные значения;
- отсутствующий материал не считается бесплатным;
- прошлые расчёты не меняются после обновления цены.

---

### Фаза 3. Visit Profit и Dashboard

**Срок:** 28 сентября – 11 октября, недели 8–9  
**Цель:** перейти от расчёта услуги к регулярной работе с визитами.

#### Работы

- минимальные клиенты;
- ручное создание завершённого визита;
- snapshots цены, комиссии, рецептуры и длительности;
- фактический расход материалов;
- отклонение от нормы;
- mobile visit close;
- история визитов;
- dashboard `Studio Ledger`;
- рейтинг услуг по прибыли и прибыли в час;
- список неполных cost data;
- фильтры периода и мастера.

#### Gate 3

- мастер закрывает визит на mobile менее чем за 60 секунд;
- Owner видит одинаковую прибыль в визите и dashboard;
- 80% тестовых визитов имеют рассчитанную маржу;
- финансовые агрегаты сходятся с суммой snapshots;
- корректировка завершённого визита оставляет audit trail.

---

### Фаза 4. Import, локализация и onboarding

**Срок:** 12–25 октября, недели 10–11  
**Цель:** убрать ручной ввод основателя как условие использования.

#### Работы

- CSV/Excel templates;
- upload, mapping, validation preview, confirm и result;
- стабильный fingerprint/external ID;
- защита от CSV formula injection;
- partial success для валидных строк;
- повторный импорт без дублей;
- onboarding progress;
- стартовые шаблоны материалов;
- RU/RO/EN;
- MDL/EUR;
- локальные даты, время и телефон.

#### Gate 4

- четыре реальных файла проходят mapping;
- не менее 99% валидных строк импортируются без ручного исправления;
- повторный импорт не создаёт дубли;
- первый расчёт на реальных данных занимает до 30 минут;
- нет missing translation keys в критических flow.

---

### Фаза 5. Hardening и release candidate

**Срок:** 26 октября – 8 ноября, недели 12–13  
**Цель:** подготовить безопасный закрытый пилот.

**Статус на 5 августа 2026:** технический scope завершён. Unit, integration и критические E2E/RBAC/tenant-isolation проверки проходят; локальный restore drill и проверка интерфейса на 360 CSS px выполнены; dashboard на 2 000 визитов укладывается в 2 секунды. Финальное прохождение Gate 5 требует инфраструктурных подтверждений на staging: restore из managed backup, получение тестового алерта и юридическое утверждение versioned privacy/terms с точными данными оператора.

#### Работы

- end-to-end tests критических flow;
- RBAC и tenant isolation matrix;
- rate limits для auth и imports;
- PII masking в логах;
- privacy/consent тексты;
- экспорт и удаление данных Owner;
- accessibility pass основных экранов;
- performance pass;
- мониторинг и алерты;
- backup restore drill;
- incident runbook;
- исправление Severity 1–2 defects.

#### Gate 5 — Release Candidate

- нет открытых Severity 1 и 2 дефектов;
- все финансовые проверки проходят;
- все критические E2E проходят;
- tenant isolation подтверждена negative tests;
- staging восстановлен из backup;
- dashboard загружается до 2 секунд на пилотном объёме;
- Owner может экспортировать данные;
- интерфейс работает от 360 px.

---

### Фаза 6. Закрытый MVP-пилот

**Срок:** 9–22 ноября, неделя 14 и первые две недели эксплуатации  
**Цель:** проверить продукт на реальной оплате и повторном использовании.

**Статус на 5 августа 2026:** технический контур пилота реализован: forced-RLS enrollment/events/interactions/issues, управляемые волны, закрытие доступа для pending/paused enrollment, PII-free product telemetry, operator CLI, измеримый Gate 6 report и pilot runbook. Сам Gate 6 не пройден до получения реальных оплат, activation/WAU, решений, продлений и support evidence; demo или seeded data в итог не засчитываются.

#### Rollout

1. внутренняя demo-организация;
2. один design partner;
3. три первых платящих клиента;
4. остальные участники до 10 аккаунтов;
5. открытие только после проверки данных предыдущей волны.

#### Поддержка пилота

- ежедневный просмотр ошибок первую неделю;
- 30-минутное интервью после первого расчёта;
- фиксация времени onboarding;
- фиксация количества ручных исправлений;
- еженедельный profit-review;
- feature requests не добавляются автоматически в P0.

#### Gate 6 — MVP подтверждён

- не менее 10 платящих клиентов;
- activation rate за семь дней ≥70%;
- минимум 7 из 10 рассчитали пять услуг;
- минимум 6 клиентов приняли решение о цене, составе или расходе;
- минимум 6 из 10 продлились после второго месяца;
- weekly active among paid ≥60%;
- onboarding менее 120 минут, целевой следующий уровень — 90 минут;
- нет критических расхождений финансового расчёта;
- support не превышает доступную capacity основателя.

---

### Фаза 7. Online Booking

**Статус:** Post-MVP, открывается только после Gate 6\
**Оценка:** 8–10 календарных недель для двух инженеров; 14–18 недель для одного инженера\
**Цель:** дать клиенту самостоятельную запись в конкретную студию, а сотруднику — безопасное управление расписанием без двойного бронирования.

Фаза 7 создаёт собственный operational booking-контур, но не превращает Nail Profit OS в marketplace. Публичная страница принадлежит одной организации, а завершённая запись продолжает существующий flow `booking → visit → profit`.

#### Entry Gate 7

Работы начинаются, если одновременно выполнены условия:

- Gate 6 пройден без критических финансовых и tenant-isolation дефектов;
- минимум три платящие организации готовы перевести реальные клиентские записи в пилот;
- минимум две организации согласны платить за booking как отдельную ценность или более высокий тариф;
- на реальных данных описаны рабочие часы, перерывы, отпуска, переносы, опоздания и отмены;
- выбран transactional messaging provider для email и/или SMS;
- утверждены privacy notice, transactional consent и правила хранения контактных данных.

Если commercial gate не пройден, booking остаётся discovery/backlog и не блокирует развитие Costing.

#### 7.1. Scope Фазы 7

Входит:

- отдельная публичная booking-страница организации по стабильному slug;
- выбор локации, услуги, add-ons, мастера или варианта «любой доступный»;
- поиск доступной даты и времени в timezone выбранной локации;
- временное удержание слота и атомарное подтверждение записи;
- создание или безопасное сопоставление клиента по нормализованному телефону/email;
- подтверждение, перенос и отмена записи клиентом по защищённой ссылке;
- ручное создание, изменение, подтверждение, отмена и завершение записи сотрудником;
- дневной, недельный и списочный вид внутреннего календаря;
- рабочие графики, повторяющиеся перерывы, выходные, отпуска и разовые исключения;
- ограничения по услугам, мастерам, локациям и рабочим местам;
- transactional-уведомления о создании, подтверждении, переносе, напоминании и отмене;
- связь подтверждённой записи с существующим завершённым визитом и profit snapshots;
- RU/RO/EN, MDL/EUR, mobile-first flow от 360 px;
- audit trail, booking analytics и feature-flag rollout.

Не входит:

- marketplace и поиск по нескольким независимым студиям;
- предоплата, депозиты, эквайринг и штрафы за no-show;
- групповые занятия, курсы, абонементы и recurring series;
- двусторонняя синхронизация с Fresha, DIKIDI, YCLIENTS или Stilio;
- waitlist, автоматическое заполнение отменённого слота и recovered revenue;
- retention campaigns и массовые marketing-рассылки;
- нативные iOS/Android-приложения;
- AI-подбор мастера или услуги.

#### 7.2. Пользовательские flow

##### Клиент: новая запись

1. Открывает `/book/{organization_slug}`.
2. Выбирает локацию, услугу и доступные add-ons.
3. Выбирает конкретного мастера или «любой доступный».
4. Выбирает дату и один из рассчитанных свободных слотов.
5. Получает hold слота на пять минут и вводит имя, телефон, email при наличии, язык и обязательные согласия.
6. Проверяет услугу, длительность, цену, адрес, timezone и cancellation policy.
7. Подтверждает контакт одноразовым кодом или подписанной ссылкой, если verification включён.
8. Получает подтверждение и защищённую ссылку управления записью.

Если слот занят между поиском и подтверждением, клиент получает `SLOT_UNAVAILABLE` и ближайшие альтернативы без потери заполненных контактных данных.

##### Клиент: управление записью

- открыть запись без создания аккаунта по одноразовому или ротируемому токену;
- перенести запись только на реально доступный слот;
- отменить запись с обязательным подтверждением действия;
- увидеть актуальные услугу, мастера, адрес, локальное время и policy;
- получить новое уведомление после каждого успешного изменения;
- увидеть понятное состояние для истёкшей, отозванной или уже использованной ссылки.

##### Сотрудник: календарь

- фильтровать записи по локации, мастеру, статусу и периоду;
- создать запись от имени клиента, включая нового клиента;
- открыть карточку записи с audit history;
- подтвердить pending-запись, перенести, отменить, отметить `no_show` или завершить;
- блокировать время мастера через availability exception;
- завершить booking в существующий visit flow без повторного ввода услуги, клиента и мастера;
- видеть конфликт до сохранения и получать альтернативные слоты.

#### 7.3. Правила доступности

Availability Engine рассчитывает слоты детерминированно из:

- timezone локации и локальной даты;
- недельных правил рабочего графика мастера;
- разовых исключений `available/unavailable`;
- допустимых связей `specialist ↔ location ↔ service`;
- длительности услуги и add-ons на момент поиска;
- buffer before/after, minimum lead time и maximum advance window;
- уже активных holds и bookings мастера;
- доступности рабочего места, если услуга его требует;
- шага сетки, по умолчанию 15 минут;
- выбранного мастера либо ранжирования доступных мастеров.

Для варианта «любой доступный» слот показывается, если подходит хотя бы один мастер. При создании hold выбирается мастер с наименьшим числом забронированных минут в выбранный локальный день; равенство разрешается стабильным `sort_order`, затем `specialist_id`. Рабочее место выбирается по `sort_order`, затем `workplace_id`.

Время хранится в UTC, правила графика — как local time + IANA timezone. Переходы DST, неоднозначное и несуществующее локальное время обрабатываются явно и покрываются parameterized tests.

#### 7.4. Модель данных

Новые или расширяемые сущности:

| Сущность | Ключевые поля | Ограничения |
|---|---|---|
| `Location` | `organization_id`, `slug`, `name`, `address`, `timezone`, `status` | Unique `organization_id + slug` |
| `Workplace` | `organization_id`, `location_id`, `name`, `status` | Используется только для услуг с ресурсным ограничением |
| `SpecialistLocation` | `specialist_id`, `location_id` | Unique pair внутри tenant |
| `SpecialistService` | `specialist_id`, `service_id`, optional duration override | Только активные услуги и специалисты |
| `BookingSettings` | public status, slot step, lead/advance limits, buffers, confirmation mode/TTL | Одна активная конфигурация на location |
| `ScheduleRule` | specialist, location, weekday, local start/end, effective range | Несколько интервалов в день разрешены |
| `AvailabilityException` | specialist, location, local/UTC interval, type, reason | `available` или `unavailable`, audit обязателен |
| `BookingHold` | slot, specialist, workplace?, token hash, status, expires_at | `active/converted/expired/released`; TTL пять минут |
| `Booking` | client, specialist, location, workplace?, starts/ends, status, source, version | Tenant-scoped, optimistic locking |
| `BookingLine` | service/add-on refs, localized name, price, duration snapshots | История не меняется после обновления каталога |
| `BookingAccessToken` | booking, purpose, token hash, expires_at, used_at | Raw token никогда не хранится |
| `Notification` | booking, channel, template, provider id, status, scheduled_at | Idempotency key на логическую отправку |

Статусы `Booking`: `pending_confirmation`, `confirmed`, `cancelled`, `completed`, `no_show`. Причина отмены, инициатор и timestamp хранятся отдельными полями. Источник: `public_booking`, `staff`, `rebooking`, `waitlist`, `import`, `api`.

При `confirmation_mode=instant` booking становится `confirmed` после verification. При `confirmation_mode=manual` он становится `pending_confirmation`, блокирует слот и автоматически отменяется после настраиваемого TTL, по умолчанию двух часов, но всегда до `starts_at`.

Существующая таблица `visit` получает nullable `booking_id`. Старые визиты не backfill-ятся и продолжают работать без booking.

#### 7.5. Защита от двойного бронирования

- активные статусы `pending_confirmation` и `confirmed` не могут пересекаться у одного мастера;
- при использовании рабочего места активные записи не могут пересекаться и по `workplace_id`;
- PostgreSQL exclusion constraint по `tstzrange(starts_at, ends_at, '[)')` является последней линией защиты;
- активные holds имеют собственный exclusion constraint; перед созданием request лениво помечает истёкшие holds соответствующего ресурса;
- создание hold и подтверждение booking берут transaction-level advisory lock для tenant/resource/date, затем повторно проверяют пересечения holds и bookings;
- проверка доступности и создание booking выполняются в одной транзакции;
- `Idempotency-Key` обязателен для public create, reschedule и staff create;
- повторный запрос возвращает исходный результат, а не создаёт вторую запись;
- истёкшие holds освобождаются запросом и периодическим repair job не реже одного раза в минуту;
- конфликт маппится в стабильную ошибку `SLOT_UNAVAILABLE` с альтернативными слотами;
- отдельный concurrency test запускает не менее 100 параллельных попыток занять один слот и допускает ровно одну подтверждённую запись.

#### 7.6. API

Public API:

| Метод и путь | Назначение |
|---|---|
| `GET /api/v1/public/booking/{slug}` | Публичные настройки, локации и branding |
| `GET /api/v1/public/booking/{slug}/catalog` | Доступные услуги, add-ons и мастера |
| `GET /api/v1/public/booking/{slug}/availability` | Свободные слоты по фильтрам и локальной дате |
| `POST /api/v1/public/booking/{slug}/holds` | Создать временный hold выбранного слота |
| `POST /api/v1/public/booking/{slug}/bookings` | Атомарно подтвердить запись |
| `POST /api/v1/public/booking/{slug}/verify` | Подтвердить одноразовый код/ссылку |
| `GET /api/v1/public/bookings/{token}` | Открыть безопасное представление записи |
| `POST /api/v1/public/bookings/{token}/reschedule` | Перенести на свободный слот |
| `POST /api/v1/public/bookings/{token}/cancel` | Отменить запись |

Internal API:

| Метод и путь | Назначение |
|---|---|
| `GET/POST /api/v1/bookings` | Список и создание сотрудником |
| `GET/PATCH /api/v1/bookings/{id}` | Карточка и optimistic update |
| `POST /api/v1/bookings/{id}/confirm` | Подтверждение pending-записи |
| `POST /api/v1/bookings/{id}/reschedule` | Транзакционный перенос |
| `POST /api/v1/bookings/{id}/cancel` | Отмена с причиной и audit event |
| `POST /api/v1/bookings/{id}/no-show` | Отметка неявки |
| `POST /api/v1/bookings/{id}/complete` | Создание/привязка завершённого визита |
| `GET/PUT /api/v1/availability/rules` | Рабочие графики |
| `GET/POST/DELETE /api/v1/availability/exceptions` | Отпуска, блокировки и исключения |

Все timestamps передаются в ISO 8601 UTC. Public mutations защищаются rate limit, CSRF применяется к cookie-authenticated internal mutations. Ошибки используют существующий envelope с `code`, `request_id`, `field_errors` и безопасными `details`.

#### 7.7. Уведомления

Transactional templates:

- запрос на подтверждение контакта;
- запись создана или ожидает подтверждения студии;
- запись подтверждена;
- дата, время, мастер или услуга изменены;
- напоминание за настраиваемый интервал, по умолчанию 24 часа;
- запись отменена клиентом или сотрудником;
- ссылка управления перевыпущена.

Notification outbox записывается в той же транзакции, что и booking event. Scheduler отправляет сообщения идемпотентно, повторяет временные ошибки с exponential backoff и переводит исчерпанные попытки в `dead_letter`. Ошибка provider не отменяет уже сохранённую запись.

#### 7.8. UI/UX

- public flow не требует регистрации аккаунта;
- цена, длительность и timezone видны до ввода контактов;
- выбранные данные сохраняются при возврате на предыдущий шаг и при конфликте слота;
- ближайшие доступные даты показываются раньше пустого календаря;
- все формы имеют label, inline error, error summary и видимый focus;
- статус нельзя передавать только цветом;
- основное действие доступно с клавиатуры и screen reader;
- touch targets не менее `44rem` при действующем соотношении `1px = 1rem`;
- мобильный flow проверяется на ширине 360 px;
- skeleton/loading, empty, expired, unavailable, offline и provider-failure states проектируются явно;
- drag-and-drop календаря может быть enhancement, но все операции обязаны иметь доступную dialog/form альтернативу.

#### 7.9. Безопасность и privacy

- public slug не раскрывает внутренний `organization_id`;
- public responses не возвращают расписание целиком, контакты клиента или внутренние заметки;
- access/verification tokens случайны, ограничены по purpose/TTL и хранятся только как hash;
- rate limits действуют отдельно для availability, holds, create, verification и token actions;
- после порога подозрительной активности включается bot challenge;
- ответы verification не позволяют определить, существует ли телефон/email;
- PII маскируется в логах, error tracking и product analytics;
- staff RBAC и tenant isolation проверяются для каждой internal route;
- public booking создаёт audit/security events без сохранения raw token;
- удаление клиента анонимизирует PII, но сохраняет booking/visit financial history согласно policy.

#### 7.10. Наблюдаемость и продуктовые события

Технические метрики:

- p50/p95 latency availability и booking mutations;
- conflict rate и число отклонённых double-booking попыток;
- active/expired holds;
- notification queue depth, delivery rate и dead letters;
- verification failures и rate-limit blocks;
- job lag и scheduler failures.

Product events без PII:

- `booking_page_viewed`;
- `booking_service_selected`;
- `booking_availability_searched`;
- `booking_slot_held`;
- `booking_started`;
- `booking_confirmed`;
- `booking_rescheduled`;
- `booking_cancelled`;
- `booking_no_show`;
- `booking_completed`.

Основная воронка: `page viewed → availability searched → booking started → booking confirmed → visit completed`.

#### 7.11. План реализации

| Подфаза | Срок для двух инженеров | Результат | Зависимость |
|---|---:|---|---|
| 7.0 Discovery и правила | 1 неделя | Реальные расписания, policies, prototype и signed decisions | Entry Gate 7 |
| 7.1 Locations и schedules | 1–2 недели | Schema, migrations, settings, rules/exceptions UI | 7.0 |
| 7.2 Availability и concurrency | 1–2 недели | Slot engine, holds, constraints, idempotency | 7.1 |
| 7.3 Calendar и public booking | 2 недели | Staff calendar и mobile public happy path | 7.2 |
| 7.4 Manage links и notifications | 1 неделя | Verify, reschedule, cancel, reminders, outbox | 7.3 |
| 7.5 Hardening и rollout | 1–2 недели | Security, accessibility, load/concurrency E2E, pilot | 7.4 |

Миграции выполняются через expand/migrate/contract. Все новые public и calendar routes закрыты feature flags до прохождения security и concurrency gates.

#### 7.12. Тестовая стратегия

| Уровень | Минимальный объём | Обязательное покрытие |
|---|---:|---|
| Unit/property | 35+ сценариев | Slot generation, buffers, lead/advance, DST, statuses, token expiry |
| Integration | 20+ сценариев | PostgreSQL constraints, holds, idempotency, outbox, booking → visit |
| Concurrency | 5 наборов | Один мастер, workplace, reschedule race, expired hold, retry |
| Contract | 8+ сценариев/provider | Send, retry, duplicate webhook, invalid signature, dead letter |
| E2E | 10 journeys | Public create, verify, conflict, manage, staff create, complete, RBAC |
| Security | Полная матрица | Cross-tenant IDs, token abuse, enumeration, rate limits, CSRF |
| Localization/accessibility | 3 locale × 3 viewport | Dates/timezone, missing keys, keyboard и screen reader smoke |

#### Gate 7 — Online Booking подтверждён

Фаза завершена, когда:

- минимум три пилотные организации принимают реальные записи через public booking;
- создано минимум 100 реальных bookings, из них минимум 30 завершены как visits;
- ни одна пара активных bookings не пересекается у одного мастера или рабочего места;
- из 100 параллельных попыток занять один слот подтверждается ровно одна;
- p95 availability ≤500 ms и p95 booking mutation ≤800 ms без времени messaging provider на пилотном объёме;
- клиент завершает mobile booking за медиану ≤2 минут после выбора услуги;
- минимум 95% transactional-уведомлений переданы provider в течение двух минут;
- перенос, отмена и завершение оставляют audit trail и не создают дубли;
- `booking → visit → profit` даёт те же финансовые snapshots, что и ручной visit flow;
- RU/RO/EN не имеют missing keys в критических booking flow;
- пройдены tenant isolation, token security, rate-limit, accessibility и backup restore checks;
- нет открытых Severity 1–2 дефектов;
- минимум две организации подтверждают готовность продолжать платить за booking после пилота.

#### Rollback Фазы 7

- публичная страница и внутренний календарь выключаются per-organization feature flag;
- уже подтверждённые записи остаются доступны сотрудникам в read-only/list mode;
- отправка новых уведомлений ставится на паузу без удаления outbox history;
- приложение откатывается только на schema-compatible версию;
- созданные bookings не удаляются и не преобразуются обратно в visits;
- существующий ручной flow завершённых визитов продолжает работать независимо от booking.

---

## 5. Календарный roadmap

| Период | Фаза | Основной результат | Решение |
|---|---|---|---|
| 10–23 августа | Concierge и данные | 3 оплаты, реальные рецептуры | Go/Stop разработки |
| 24 августа – 6 сентября | Foundation | Auth, tenant, schema, финальный flow | Готовность строить core |
| 7–27 сентября | Costing Core | Первый точный расчёт в продукте | Formula acceptance |
| 28 сентября – 11 октября | Visit Profit | Фактический визит и dashboard | Regular-use readiness |
| 12–25 октября | Import и i18n | Самостоятельный onboarding | Pilot onboarding readiness |
| 26 октября – 8 ноября | Hardening | Release Candidate | Production approval |
| 9–22 ноября | Закрытый rollout | 1 → 3 → 10 аккаунтов | MVP launch |
| Декабрь 2026 – январь 2027 | Проверка retention продукта | Продления и support economics | Go/No-Go следующего модуля |
| После Gate 6, ориентир февраль–апрель 2027 | Фаза 7: Online Booking | Public booking, availability, staff calendar | Gate 7 / Go-No-Go Retention |

Дата MVP-пилота: **9 ноября 2026**, если команда из двух инженеров начинает 24 августа и Gate 0 пройден.

---

## 6. Backlog по эпикам

| Epic | Результат | Приоритет | Оценка engineering | Зависимость |
|---|---|---:|---:|---|
| E0 — Concierge data | Реальные услуги, рецептуры и import templates | P0 | 3–5 дней | Оплата пилотов |
| E1 — Platform | Auth, tenant, роли, окружения, audit | P0 | 10–14 дней | E0 decisions |
| E2 — Catalog | Мастера, услуги, add-ons, комиссии | P0 | 8–12 дней | E1 |
| E3 — Costing | Материалы, units, recipes, snapshots, formulas | P0 | 15–20 дней | E2 |
| E4 — Visit Profit | Клиенты, завершённые визиты, actual usage | P0 | 10–14 дней | E2–E3 |
| E5 — Dashboard | Profit overview, ranking, incomplete data | P0 | 8–12 дней | E3–E4 |
| E6 — Import & i18n | CSV, deduplication, RU/RO/EN, MDL/EUR | P0 | 10–14 дней | E1–E4 |
| E7 — Hardening | Security, QA, backups, monitoring, privacy | P0 | 12–16 дней | Все P0 |
| E8 — Online Booking | Locations, schedules, availability, public flow, calendar | Post-MVP P0 | 45–65 engineering days | Gate 6 + commercial booking gate |
| E9 — Photos/inventory | Расширение операционного слоя | P1 | После пилота | MVP gate |
| E10 — Retention | Forecast, due/lost, rebooking | Post-MVP | Отдельная оценка | E8 + product retention gate |
| E11 — Slot Protection | Waitlist, offers, recovered revenue | Post-MVP | Отдельная оценка | E8 + E10 + messaging |

Оценки являются диапазонами effort, а не обещанными календарными сроками. UX, QA и DevOps выполняются параллельно.

---

## 7. Команда

### Рекомендуемая команда на 12–14 недель

| Роль | Загрузка | Ответственность |
|---|---:|---|
| Founder / Product Owner | 0.7–1.0 FTE | Клиенты, решения, приоритеты, acceptance |
| Full-stack / frontend engineer | 1.0 FTE | Web UI, onboarding, dashboard, integration с API |
| Backend / full-stack engineer | 1.0 FTE | Domain, Costing Engine, PostgreSQL, imports, security |
| UX/UI designer | 0.2–0.3 FTE | Flow, prototypes, design QA, user testing |
| QA | 0.25 FTE с недели 5; 0.5 с недели 10 | Test plan, regression, E2E, release gate |
| DevOps/security | 0.1–0.2 FTE | Environments, backups, monitoring, security review |

### Bootstrap-вариант

Один сильный full-stack engineer + founder + part-time UX/QA:

- срок 18–22 недели;
- один модуль в работе одновременно;
- CSV-import после Costing, а не параллельно;
- закрытый пилот сначала на 1–3 клиентах;
- более высокий bus-factor и риск задержки.

---

## 8. Техническая стратегия

### Архитектура

- responsive web application;
- TypeScript;
- React/Next.js;
- modular monolith backend;
- REST API `/api/v1`;
- PostgreSQL;
- PostgreSQL-backed jobs только для необходимых import-задач;
- S3-compatible storage только при включении файлов;
- managed EU region;
- отдельные dev/staging/production;
- Redis не добавляется без измеренной необходимости.

### Критические архитектурные решения

1. Каждая бизнес-сущность содержит `organization_id`.
2. Финансовые snapshots являются append-only.
3. Деньги хранятся целыми минимальными единицами валюты.
4. Изменение цены материала не переписывает завершённые визиты.
5. Formula version сохраняется вместе с результатом.
6. Import является идемпотентным.
7. Dashboard читает единые определения метрик из backend.
8. PII не попадает в продуктовую аналитику и логи.
9. Provider-specific integrations не входят в domain core.
10. Конфликт booking предотвращается PostgreSQL constraint, а не только UI-проверкой.
11. Расписание хранит local-time rules с IANA timezone, а конкретные слоты — UTC timestamps.
12. Booking snapshots не зависят от последующих изменений услуги, цены или длительности.
13. Public booking и ручной visit close остаются независимо отключаемыми flow.

### Важный запрет

Не строить микросервисы, Redis-кэш, event streaming, сложный warehouse или AI recommendation layer до появления реальной нагрузки и повторной выручки.

---

## 9. Definition of Done MVP

### Product

- пользователь понимает позиционирование как profit layer, а не новую CRM;
- первая услуга рассчитана до 10 минут на шаблоне и до 30 минут на реальных данных;
- клиент может объяснить формулу без помощи команды;
- mobile visit close занимает менее 60 секунд;
- incomplete data всегда явно отмечены.

### Engineering

- все P0 roadmap-требования реализованы;
- финансовые unit/property tests проходят;
- критические E2E проходят;
- нет Severity 1–2;
- tenant isolation и RBAC проверены;
- backup restore выполнен;
- мониторинг, алерты и runbook включены;
- нет missing locale keys в критических flow;
- изменения схемы backward compatible.

### Business

- 10 платящих клиентов;
- 70% activation;
- 60%+ продление после второго месяца;
- минимум шесть доказанных управленческих решений;
- получены оплаты выше 300 MDL хотя бы от двух клиентов или студий;
- измерено время onboarding и поддержки.

### Финансовая жизнеспособность

- поддержка движется к ≤20 минут на аккаунт в месяц;
- смешанный ARPA движется к 600 MDL и выше;
- CAC payback остаётся до трёх месяцев;
- founders не финансируют расширение scope без прохождения commercial gate.

---

## 10. Метрики реализации

### Delivery metrics

- lead time задачи;
- количество незавершённой работы;
- escaped defects;
- automated test pass rate;
- staging deployment frequency;
- время восстановления после ошибки;
- burn против бюджета.

### Product metrics

- `onboarding_started`;
- `service_cost_completed`;
- `visit_completed`;
- время до первого расчёта;
- процент услуг с полной рецептурой;
- процент визитов с margin;
- weekly active paid organizations;
- число объяснимых действий после расчёта.

### Commercial metrics

- фактический MRR;
- activation rate;
- продление на второй и третий месяц;
- churn;
- ARPA;
- onboarding minutes;
- support minutes/account;
- CAC по каналу;
- готовность купить Studio-тариф.

---

## 11. Управление scope

### Правило включения новой функции

Функция попадает в MVP только если выполняется хотя бы одно условие:

1. без неё невозможно рассчитать достоверную себестоимость;
2. без неё невозможно безопасно обработать данные пилота;
3. она устраняет подтверждённый blocker минимум у двух платящих клиентов;
4. она нужна для release gate безопасности или privacy.

### Правило исключения

Функция переносится, если:

- она относится к retention, messaging, waitlist или marketplace;
- существует ручной процесс на первые 10 клиентов;
- она нужна только одному клиенту;
- она не влияет на оплату, активацию или достоверность расчёта;
- её можно добавить без изменения доменной модели после MVP.

### Change control

- один product backlog;
- только Founder/Product Owner меняет P0;
- каждое добавление имеет удаляемый элемент сопоставимого effort;
- scope review проводится раз в неделю;
- feature requests пилота сначала записываются как evidence, а не как обещание.

---

## 12. Риски roadmap

| Риск | Вероятность / влияние | Ранний сигнал | Мера |
|---|---|---|---|
| Нет фактических оплат | Высокая / критическое | Клиенты откладывают старт | Gate 0 до разработки |
| Рецептуры слишком сложно вводить | Высокая / высокое | Onboarding >120 минут | Templates, bulk edit, concierge setup |
| Формуле не доверяют | Средняя / критическое | Пользователь не может объяснить сумму | Breakdown, source links, snapshots |
| Двойной ввод из CRM раздражает | Высокая / высокое | Пользователь не обновляет данные | CSV-first, измерить долю одной CRM |
| Scope возвращается к booking CRM | Высокая / критическое | Появляется универсальный календарь | Формальная P0-граница |
| Один инженер становится bottleneck | Средняя / высокое | Нет параллельного QA/import | Увеличить срок или добавить инженера |
| Локализация тормозит release | Средняя / среднее | Тексты захардкожены | i18n foundation с первой недели |
| Финансовая история переписывается | Низкая / критическое | Результаты меняются задним числом | Append-only snapshots и tests |
| Утечка данных между организациями | Низкая / критическое | Cross-tenant access | Tenant constraints и negative tests |
| Поддержка уничтожает SaaS-маржу | Высокая / высокое | >60 минут/account/month | Измерять время, поднять цену или перейти в service model |
| Double booking при гонке запросов | Средняя / критическое | Пересекающиеся активные записи | Exclusion constraints, transaction, idempotency, concurrency tests |
| Ошибка timezone/DST сдвигает запись | Средняя / критическое | Клиент и мастер видят разное время | IANA timezone, UTC storage, property tests |
| Спам через публичную форму | Высокая / высокое | Рост holds/verification и provider cost | Rate limits, verification, bot challenge, abuse metrics |
| Booking размывает profit positioning | Высокая / высокое | Roadmap копирует generic CRM | Entry Gate 7 и связь каждого booking с visit/profit |

---

## 13. Stop / pivot criteria

### Остановить расширение продукта, если

- первые три обещавших клиента не оплачивают пилот;
- менее пяти из десяти пилотов продлеваются после третьего месяца;
- пользователи не принимают решений после расчёта;
- onboarding остаётся более двух часов после появления templates;
- поддержка превышает 60 минут на аккаунт в месяц при цене ниже 500 MDL;
- ни одна студия не принимает цену 699–899 MDL после доказанного эффекта.

### Перейти к сервисной модели, если

- клиенты готовы платить за разовый profit audit;
- не хотят самостоятельно поддерживать данные;
- аудит можно продавать за 1 500–3 000 MDL;
- регулярное использование приложения остаётся низким.

### Перейти к integration-first, если

- ценность расчёта подтверждена;
- основной blocker — только двойной ввод;
- 60%+ клиентов используют одну CRM;
- доступен устойчивый API или экспорт.

---

## 14. Что происходит после MVP

### Release A — Online Booking

Открывается после Gate 6 и отдельного commercial booking gate.

Состав:

- locations, workplaces и графики мастеров;
- Availability Engine и защита от double booking;
- public booking организации;
- staff calendar;
- подтверждение, перенос, отмена и завершение;
- transactional notifications;
- связь `booking → visit → profit`.

Полный scope и Gate 7 определены в разделе «Фаза 7. Online Booking».

### Release B — Retention

Открывается только после:

- 25+ платящих аккаунтов;
- трёхмесячного удержания ≥80%;
- weekly active ≥60%;
- support менее 30 минут/account/month;
- Costing используется регулярно.

Состав:

- прогноз следующего визита;
- due/overdue/lost list;
- ручное напоминание;
- one-click rebooking;
- conversion tracking.

Retention открывается только после Gate 7, поскольку one-click rebooking должен создавать запись через единый Availability Engine.

### Release C — Slot Protection

Открывается после подтверждения Retention и выбора messaging provider.

Состав:

- cancellation policy без финансовых санкций;
- waitlist;
- slot recovery case;
- предложение освободившегося времени;
- атомарное подтверждение;
- potential/booked/realized recovered revenue.

### Release D — Integrations и scale

Открывается после 50+ платящих аккаунтов.

- первый live CRM connector;
- автоматическое обновление визитов;
- расширенные роли;
- бенчмарки услуг;
- выход в Румынию;
- партнёрская сеть.

---

## 15. Решение на сегодня

### Go

Запустить двухнедельный платный concierge-этап немедленно.

### Не Go

Не начинать разработку полного scope версии 1.1 до получения фактических оплат и продлений.

### Ближайшие пять действий

1. Получить оплату от трёх готовых клиентов.
2. Назначить 60–90-минутный data onboarding каждому.
3. Собрать по 10–15 ключевых услуг и рецептур.
4. Провести три UX-теста текущего прототипа.
5. После Gate 0 открыть двухнедельный Platform Foundation sprint.

---

## 16. Связанные материалы

- `docs/nail-profit-os-mvp-technical-spec.md` — полное техническое ТЗ версии 1.1;
- `docs/nail-profit-os-ux-ui-concept-v1.1.md` — UX/UI-концепция;
- `docs/nail-profit-os-ui-preview.html` — интерактивный UI-preview;
- `DESIGN.md` — дизайн-система;
- `docs/nail-profit-os-business-plan-v1.1.md` — бизнес-план;
- `outputs/nail-profit-financial-model-v1.1/nail-profit-os-financial-model-v1.1.xlsx` — финансовая модель.
