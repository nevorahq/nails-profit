# Design System - Nail Profit OS

**Версия:** 1.0  
**Дата:** 2 августа 2026  
**Статус:** Proposed  
**Направление:** Studio Ledger

## Product Context

- **Что это:** profitability layer для nail-мастеров и студий, который считает реальную себестоимость услуги, contribution margin и прибыль в час.
- **Для кого:** соло-мастера и владельцы nail-студий на 2–10 специалистов, уже использующие Fresha, DIKIDI, YCLIENTS, Stilio или ручную запись.
- **Категория:** vertical B2B SaaS, beauty operations, financial intelligence.
- **Тип продукта:** responsive web app с приоритетом mobile для мастера и desktop для владельца.
- **Главная запоминаемая мысль:** «Наконец-то я вижу, сколько реально зарабатываю на каждой услуге».

## Design Principles

1. **Деньги раньше календаря.** Первый экран отвечает на финансовый вопрос, а не повторяет booking UI.
2. **Показывать расчёт.** Любая сумма раскрывается до материалов, комиссии и времени.
3. **Красота без beauty-клише.** Никаких розовых градиентов, блёсток, силуэтов ногтя и декоративных карточек ради карточек.
4. **Человеческий язык.** В интерфейсе «Останется вам», а термин contribution margin живёт в пояснении.
5. **Действие важнее отчёта.** Каждый insight заканчивается конкретным следующим шагом.
6. **Доверие через прозрачность.** Estimate, неполные данные и источник расчёта всегда видимы.

## Aesthetic Direction

- **Название:** Studio Ledger.
- **Эстетика:** refined editorial utility.
- **Декоративность:** intentional minimal.
- **Настроение:** тёплая студия встречается с точной финансовой книгой. Продукт должен ощущаться спокойным, компетентным и тактильным, но не бухгалтерским и не глянцево-салонным.
- **Материал:** тёплая бумага, фарфор, чернила, терракотовая отметка, зелёная прибыль.

## Brand

- Wordmark: `Nail Profit` с компактным индексом `OS`.
- Знак: необязателен в MVP; для favicon допустима монограмма `NP`.
- Не использовать ноготь, кисть, корону, звезду, sparkles или график-стрелку как логотип.
- Основная фраза продукта: **«Вы знаете цену. Теперь увидьте, что останется вам.»**

## Typography

- **Display и финансовые выводы:** Fraunces, 600. Даёт ремесленное тепло без косметического глянца.
- **UI, labels и body:** Instrument Sans, 400/500/600. Нейтральный, компактный и хорошо работает в трёх языках.
- **Данные и таблицы:** IBM Plex Mono, 500, `font-variant-numeric: tabular-nums`.
- **Fallback:** Georgia для display; `Segoe UI`, sans-serif для UI; monospace для данных.
- **Загрузка:** self-hosted WOFF2 в production; CDN допустим только в design preview.

### Type Scale

| Token | Desktop | Mobile | Weight | Использование |
|---|---:|---:|---:|---|
| `display-xl` | 48/52 | 36/40 | 600 | Marketing hero, onboarding result |
| `display-lg` | 36/42 | 30/36 | 600 | Главный финансовый вывод |
| `heading-xl` | 28/34 | 24/30 | 600 | Заголовок страницы |
| `heading-lg` | 22/28 | 20/26 | 600 | Секция, drawer |
| `heading-md` | 18/24 | 18/24 | 600 | Card title |
| `body-lg` | 17/26 | 16/24 | 400 | Lead text |
| `body` | 15/22 | 15/22 | 400 | Основной UI |
| `label` | 13/18 | 13/18 | 600 | Labels, buttons |
| `caption` | 12/16 | 12/16 | 500 | Metadata, helper text |
| `data-xl` | 32/38 | 28/34 | 500 | Главные суммы |
| `data` | 14/20 | 14/20 | 500 | Таблицы, формулы |

## Color System

### Core Palette

| Token | Hex | Использование |
|---|---|---|
| `canvas` | `#F7F3ED` | Основной фон |
| `surface` | `#FFFCF8` | Рабочие поверхности |
| `surface-strong` | `#EEE7DE` | Выделенные секции, hover |
| `ink` | `#241E26` | Основной текст |
| `ink-muted` | `#706872` | Вторичный текст |
| `border` | `#D9D0C6` | Границы и разделители |
| `accent` | `#D75B45` | Primary action, активная навигация |
| `accent-hover` | `#B84535` | Hover/pressed |
| `accent-soft` | `#F6DDD6` | Мягкое выделение action |
| `sage` | `#8E9D84` | Материалы, нейтральный secondary |
| `profit` | `#2F7552` | Положительная прибыль, success |
| `profit-soft` | `#DDEDE4` | Success background |
| `warning` | `#A66A18` | Неполные данные, низкая маржа |
| `warning-soft` | `#F6E9CF` | Warning background |
| `loss` | `#B93B45` | Убыток и критическая ошибка |
| `loss-soft` | `#F5DDE0` | Error background |
| `info` | `#3B6F8F` | Системная информация |

### Color Rules

- Accent обозначает действие, но не финансовый результат.
- Green используется только для подтверждённого положительного результата.
- Estimate и неполные данные всегда amber, даже если число положительное.
- Красный не используется для снижения относительно прошлого периода, если бизнес всё ещё прибыльный.
- На одном экране не более одного solid accent CTA.
- Charts используют ink, accent, sage, warning и profit; цвет всегда дублируется label или pattern.

### Dark Mode

- Dark mode вторичен для MVP, но токены должны поддерживать его.
- Canvas `#181519`, surface `#211D22`, ink `#F6F0E8`, muted `#B8AFB7`, border `#3A343B`.
- Accent и semantic colors уменьшают насыщенность на 10–15%.
- Не инвертировать тёплый характер в холодный blue-black.

## Spacing

- **Base unit:** 4 px.
- **Density:** comfortable на desktop, compact-actionable на mobile.
- **Scale:** `2xs 2`, `xs 4`, `sm 8`, `md 12`, `lg 16`, `xl 24`, `2xl 32`, `3xl 48`, `4xl 64`, `5xl 96`.
- Card padding: 20–24 px desktop, 16 px mobile.
- Form gap: 16 px; dense recipe rows: 12 px vertical.
- Между смысловыми секциями: 32–48 px, не одинаковые 24 px повсюду.

## Layout

- **Подход:** hybrid. Строгая сетка для данных, editorial composition для главного вывода.
- **Desktop:** sidebar 232 px + 12-column content grid, max-width 1440 px.
- **Tablet:** collapsible rail 72 px + 8 columns.
- **Mobile:** 4 columns, нижняя навигация, один главный столбец.
- **First viewport:** финансовый вывод занимает 7–8 колонок, action queue 4–5 колонок. Не использовать ряд из четырёх одинаковых KPI cards как первый экран.
- **Content widths:** forms 680 px; tables используют всю доступную ширину; narrative reports 880 px.

## Shape and Elevation

- Radius: `sm 4 px`, `md 8 px`, `lg 12 px`, `pill 999 px` только для status/filter chips.
- Buttons: 8 px.
- Cards: 8–12 px, без одинаковой «пузырчатости» для каждого контейнера.

### Soft UI (пересмотрено)

Прежняя редакция этого раздела гласила: «shadow применяется только к overlay»
и «основные поверхности разделяются border и spacing, а не тенями». **Отменено
решением владельца продукта.** Приложение переведено на soft UI
(неоморфизм): поверхность выдавлена из фона парой теней, границы сняты.

- Палитра **не менялась**. Светлая тень — белый, тёмная — `--forest-950` с
  низкой альфой. Новых оттенков не введено.
- Источник света один и всегда сверху-слева. Элемент, освещённый с другой
  стороны, читается не как «другой», а как ошибка отрисовки.
- Токены: `--neu-raised`, `--neu-raised-sm`, `--neu-inset`, `--neu-pressed`.
- Вложенная карточка поднимается слабее, чем панель, которая её держит: две
  одинаковые высоты рядом сливаются в один лист со швом.
- Поля ввода **вдавлены**, а не подняты. Это весь словарь стиля: поднято —
  «нажми», вдавлено — «заполни».

Что не подчиняется этому слою:

- `:focus-visible` сохраняет сплошное кольцо. Типовой отказ неоморфизма —
  фокус, который невозможно найти; это единственный элемент, которому
  разрешено быть контрастным.
- Цветная полоса статуса у записи остаётся. Мягкая экструзия не умеет нести
  *категорию*, а «отменена» и «подтверждена» должны различаться взглядом.
- Лендинг живёт на своей палитре и в этот слой не входит.

## Iconography

- Outline icons, 1.5 px stroke, 18/20/24 px.
- Icon всегда сопровождается текстом в основной навигации.
- Не использовать emoji как функциональные иконки.
- Для прибыли, материалов и времени применять разные формы, а не только разные цвета.

## Motion

- **Подход:** minimal-functional.
- Micro feedback: 100–140 ms.
- Tab/page transition: 180 ms.
- Drawer/modal: 220–260 ms.
- Easing: enter `cubic-bezier(.2,.8,.2,1)`, exit `ease-in`.
- Анимировать изменение breakdown-bar и суммы только после явного редактирования.
- Respect `prefers-reduced-motion`; не анимировать большие числа при каждом открытии dashboard.

## Component Priorities

1. Financial insight panel.
2. Cost breakdown bar и explainable calculation drawer.
3. Service profitability row.
4. Recipe/material row.
5. Data completeness badge.
6. Action queue item.
7. Visit close sheet.
8. Status chip.
9. Empty state with one next action.
10. Dense data table with mobile card equivalent.

## Data Visualization

- Главный паттерн: stacked horizontal cost breakdown, потому что он показывает, куда уходит цена услуги.
- Для динамики: line chart revenue vs contribution margin.
- Для сравнения услуг: ranked horizontal bars по profit/hour.
- Donut charts не использовать для более чем трёх частей.
- Каждая диаграмма содержит единицы, период, источник и состояние completeness.

## Content Style

- Outcome-first: «Останется вам 325 MDL», затем объяснение.
- Не писать «Contribution margin» без расшифровки.
- Не писать «Успешно выполнено». Писать, что изменилось: «Расход сохранён. Прибыль визита: 325 MDL».
- Warning сообщает действие: «У 3 услуг нет расхода материалов. Добавьте рецептуру».
- Decimal values показывать только там, где это влияет на решение; money по умолчанию до 2 знаков.

## Accessibility

- WCAG 2.1 AA для основных flow.
- Visible focus ring `2px #3B6F8F` с offset 2 px.
- Touch target минимум 44 × 44 px.
- Состояние не передаётся только цветом.
- Таблицы имеют корректные headers; на mobile строки превращаются в смысловые cards.
- Формулы и chart summaries доступны текстом.

## Decisions Log

| Дата | Решение | Причина |
|---|---|---|
| 2026-08-02 | Costing-first information hierarchy | Три design partners готовы платить 300 MDL за реальную себестоимость услуги |
| 2026-08-02 | Studio Ledger aesthetic | Отличает продукт от календарных CRM и сочетает beauty-контекст с финансовым доверием |
| 2026-08-02 | Warm restrained palette | Избегает pink beauty cliché и холодной fintech-эстетики |
| 2026-08-02 | Fraunces + Instrument Sans + IBM Plex Mono | Разделяет craft, интерфейс и точные данные |
