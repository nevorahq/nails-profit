"use client";

import Link from "next/link";
import Image from "next/image";
import { useMemo, useState } from "react";

import {
  addOnMonthlyPriceMinor,
  billingPeriods,
  effectiveMonthlyPriceMinor,
  founderOffer,
  periodPriceMinor,
  periodSavingPercent,
  planTiers,
  signupTrial,
  type BillingPeriod,
} from "@/domain/plans";
import type { AppLocale } from "@/i18n/messages";

type PricingPlanCopy = {
  name: string;
  audience: string;
  features: readonly string[];
};

type Copy = {
  navHow: string;
  navFor: string;
  navPricing: string;
  signIn: string;
  start: string;
  eyebrow: string;
  titleFirst: string;
  titleAccent: string;
  intro: string;
  seeExample: string;
  demoLabel: string;
  service: string;
  price: string;
  taxes: string;
  commission: string;
  youKeep: string;
  perHour: string;
  usesRealData: string;
  forSolo: string;
  forStudio: string;
  reasonEyebrow: string;
  reasonTitle: string;
  reasonBody: string;
  pillars: readonly { number: string; title: string; body: string }[];
  productEyebrow: string;
  productTitle: string;
  productBody: string;
  sampleService: string;
  sampleInsight: string;
  sampleAction: string;
  calculatorEyebrow: string;
  calculatorTitle: string;
  calculatorBody: string;
  priceInput: string;
  taxInput: string;
  commissionInput: string;
  hourNote: string;
  finalTitle: string;
  finalBody: string;
  pricingEyebrow: string;
  pricingTitle: string;
  pricingBody: string;
  pricingPeriodGroupLabel: string;
  pricingPeriodLabels: readonly [string, string, string];
  pricingPerMonth: string;
  pricingBilledMonthly: string;
  pricingFor: string;
  pricingSaveLabel: string;
  pricingCta: string;
  pricingTrial: string;
  pricingStartTerms: string;
  pricingStartCta: string;
  pricingStartNote: string;
  pricingFeaturedBadge: string;
  /** `{studioSpecialist}`, `{businessSpecialist}`, `{businessLocation}`, `{seats}`, `{percent}`, `{code}` and `{days}` are filled from `domain/plans.ts`. */
  pricingNote: string;
  pricingTiers: readonly [PricingPlanCopy, PricingPlanCopy, PricingPlanCopy, PricingPlanCopy];
  footer: string;
  privacy: string;
  terms: string;
};

/**
 * The subscription the studio pays for the tool, distinct from the MDL visit
 * economics above it: one price for every country, billed in EUR through
 * Paddle, on the October grid — a free «Старт» and Solo/Studio/Business with
 * 1/6/12-month prepay. Every amount comes from `domain/plans.ts`; only the
 * labels below are translated.
 */
const featuredTier = "studio";

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

/** Euro, symbol first, whole numbers bare and part-euros to the cent. */
function formatEuro(amount: number, locale: AppLocale): string {
  const fractionDigits = Number.isInteger(amount) ? 0 : 2;
  return `€${amount.toLocaleString(locale === "en" ? "en-GB" : "ru-RU", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: 2,
  })}`;
}

const content: Record<AppLocale, Copy> = {
  ru: {
    navHow: "Как это работает",
    navFor: "Для студии",
    navPricing: "Тарифы",
    signIn: "Войти",
    start: "Начать расчёт",
    eyebrow: "Запись клиентов и прибыль в одном месте",
    titleFirst: "Не угадывайте,",
    titleAccent: "что приносит услуга.",
    intro: "Клиенты записываются онлайн, вы закрываете визит — и видно, сколько остаётся с каждой услуги после комиссии, налогов и времени мастера.",
    seeExample: "Посмотреть расчёт",
    demoLabel: "Пример визита",
    service: "Маникюр с покрытием",
    price: "Цена услуги",
    taxes: "Налоги и эквайринг",
    commission: "Комиссия мастера",
    youKeep: "Останется студии",
    perHour: "Прибыль в час",
    usesRealData: "На основе времени, налогов и правил комиссии",
    forSolo: "Соло-мастер",
    forStudio: "Студия",
    reasonEyebrow: "Запись и деньги — вместе",
    reasonTitle: "Нужен не ещё один отчёт. Нужна ясность перед следующим решением.",
    reasonBody: "Поднять цену, пересмотреть комиссию, убрать невыгодную услугу — на такие вопросы нельзя отвечать по ощущению.",
    pillars: [
      { number: "01", title: "Показывает расчёт", body: "Каждая сумма раскрывается до комиссии, налогов и времени." },
      { number: "02", title: "Считает по факту", body: "Закрытый визит считается по своим же данным и потом не переписывается." },
      { number: "03", title: "Переезд за 5 минут", body: "Перенесите клиентов и услуги за 5 минут: из телефона или из таблицы прежней системы записи." },
    ],
    productEyebrow: "Не просто цифра",
    productTitle: "Смотрите услугу так, как её видит ваш бизнес.",
    productBody: "Понятная анатомия визита превращает цену и затраты в решение, которое можно принять сразу.",
    sampleService: "Маникюр · 1 ч 30 мин",
    sampleInsight: "Цена услуги покрывает комиссию и налоги. Маржа — 54%.",
    sampleAction: "Открыть отчёт",
    calculatorEyebrow: "Попробуйте на своём примере",
    calculatorTitle: "Цена — это начало расчёта.",
    calculatorBody: "Меняйте значения и смотрите, как складывается результат. Это демонстрация — точный расчёт в продукте учитывает налоги, эквайринг и длительность визита.",
    priceInput: "Цена услуги",
    taxInput: "Налоги и эквайринг",
    commissionInput: "Комиссия",
    hourNote: "Для примера используется визит длительностью 1 ч 30 мин.",
    finalTitle: "Узнайте, сколько на самом деле приносит каждая услуга.",
    finalBody: "Соберите первый расчёт и получите основу для понятных решений о цене и команде.",
    pricingEyebrow: "Тарифы",
    pricingTitle: "Начните бесплатно. Без процента с выручки.",
    pricingBody:
      "Запись, календарь и прибыль по каждому визиту — бесплатно для одного мастера. Платные тарифы открывают полные отчёты, расходы, команду и адреса.",
    pricingPeriodGroupLabel: "Период оплаты",
    pricingPeriodLabels: ["Помесячно", "6 месяцев", "12 месяцев"],
    pricingPerMonth: "в месяц",
    pricingBilledMonthly: "Оплата каждый месяц",
    pricingFor: "за",
    pricingSaveLabel: "экономия",
    pricingCta: "Попробовать бесплатно",
    pricingTrial: "{days} дней «Студии» бесплатно, карта не нужна",
    pricingStartTerms: "Бесплатно, без срока",
    pricingStartCta: "Начать бесплатно",
    pricingStartNote: "Без карты. Перейти на платный тариф можно в любой момент",
    pricingFeaturedBadge: "Популярный",
    pricingNote:
      "Цены в евро, одни для всех стран, оплата через Paddle. 6 месяцев стоят как 5, 12 — как 9. В «Студии» — +{studioSpecialist} в месяц за каждого мастера сверх трёх; в «Бизнесе» — +{businessSpecialist} за мастера и +{businessLocation} за дополнительный адрес. Первым {seats} студиям — −{percent}% на всё время подписки по коду {code}.",
    pricingTiers: [
      {
        name: "Старт",
        audience: "Один мастер, чтобы начать",
        features: [
          "Онлайн-запись, календарь и клиенты",
          "Прибыль по каждому визиту",
          "Отчёт за последние 30 дней",
          "Напоминания клиентам по email",
        ],
      },
      {
        name: "Соло",
        audience: "Один мастер, один адрес",
        features: [
          "Всё из «Старта»",
          "Отчёты за любой период: маржа и прибыль в час",
          "Материалы — по закупкам или суммой на услугу",
          "Учёт расходов и импорт клиентов",
        ],
      },
      {
        name: "Студия",
        audience: "Небольшая команда на одном адресе",
        features: [
          "Всё из «Соло»",
          "3 мастера, дальше +{studioSpecialist} в месяц за каждого",
          "Роли и управление командой",
          "Комиссии и аренда кресла по каждому мастеру",
        ],
      },
      {
        name: "Бизнес",
        audience: "Несколько адресов и большая команда",
        features: [
          "Всё из «Студии»",
          "До 8 мастеров и 3 адресов",
          "Отдельная онлайн-запись на каждый адрес",
          "Помощь с переездом из другой системы",
        ],
      },
    ],
    footer: "Nail Profit OS · запись и прибыль nail-бизнеса",
    privacy: "Конфиденциальность",
    terms: "Условия",
  },
  ro: {
    navHow: "Cum funcționează",
    navFor: "Pentru salon",
    navPricing: "Prețuri",
    signIn: "Autentificare",
    start: "Începe calculul",
    eyebrow: "Programări și profit într-un singur loc",
    titleFirst: "Nu ghiciți",
    titleAccent: "ce aduce profit.",
    intro: "Clienții se programează online, dvs. închideți vizita — și vedeți cât rămâne din fiecare serviciu după comision, taxe și timpul specialistului.",
    seeExample: "Vezi calculul",
    demoLabel: "Exemplu de vizită",
    service: "Manichiură cu acoperire",
    price: "Prețul serviciului",
    taxes: "Taxe și comision bancar",
    commission: "Comision specialist",
    youKeep: "Rămâne salonului",
    perHour: "Profit pe oră",
    usesRealData: "Pe baza timpului, taxelor și regulilor de comision",
    forSolo: "Specialist independent",
    forStudio: "Salon",
    reasonEyebrow: "Programările și banii — împreună",
    reasonTitle: "Nu aveți nevoie de încă un raport. Aveți nevoie de claritate înaintea următoarei decizii.",
    reasonBody: "Majorarea prețului, revizuirea comisionului sau renunțarea la un serviciu nerentabil nu trebuie să fie decizii luate din senzație.",
    pillars: [
      { number: "01", title: "Arată calculul", body: "Fiecare sumă poate fi înțeleasă: comision, taxe și timp." },
      { number: "02", title: "Calculează după fapt", body: "O vizită închisă se calculează din propriile date și nu se rescrie ulterior." },
      { number: "03", title: "Mutare în 5 minute", body: "Transferați clienții și serviciile în 5 minute: din telefon sau din tabelul vechiului sistem de programări." },
    ],
    productEyebrow: "Mai mult decât o cifră",
    productTitle: "Priviți serviciul așa cum îl vede afacerea dvs.",
    productBody: "Anatomia clară a unei vizite transformă prețul și cheltuielile într-o decizie imediată.",
    sampleService: "Manichiură · 1 h 30 min",
    sampleInsight: "Prețul acoperă comisionul și taxele. Marja este 54%.",
    sampleAction: "Deschide raportul",
    calculatorEyebrow: "Încercați pe propriul exemplu",
    calculatorTitle: "Prețul este începutul calculului.",
    calculatorBody: "Schimbați valorile și vedeți cum se formează rezultatul. Calculul exact din produs include taxele, comisionul bancar și durata reală.",
    priceInput: "Prețul serviciului",
    taxInput: "Taxe și comision bancar",
    commissionInput: "Comision",
    hourNote: "Exemplul folosește o vizită de 1 h 30 min.",
    finalTitle: "Aflați ce aduce cu adevărat fiecare serviciu.",
    finalBody: "Faceți primul calcul și luați decizii mai clare despre preț și echipă.",
    pricingEyebrow: "Prețuri",
    pricingTitle: "Începeți gratuit. Fără comision din încasări.",
    pricingBody:
      "Programări, calendar și profitul fiecărei vizite — gratuit pentru un specialist. Planurile plătite deschid rapoartele complete, cheltuielile, echipa și adresele.",
    pricingPeriodGroupLabel: "Perioada de plată",
    pricingPeriodLabels: ["Lunar", "6 luni", "12 luni"],
    pricingPerMonth: "pe lună",
    pricingBilledMonthly: "Plată în fiecare lună",
    pricingFor: "pentru",
    pricingSaveLabel: "economie",
    pricingCta: "Încearcă gratuit",
    pricingTrial: "{days} zile de «Studio» gratuit, fără card",
    pricingStartTerms: "Gratuit, fără termen",
    pricingStartCta: "Începe gratuit",
    pricingStartNote: "Fără card. Treceți la un plan plătit oricând",
    pricingFeaturedBadge: "Popular",
    pricingNote:
      "Prețuri în euro, aceleași pentru toate țările, plată prin Paddle. 6 luni costă cât 5, 12 — cât 9. La «Studio» — +{studioSpecialist} pe lună pentru fiecare specialist peste trei; la «Business» — +{businessSpecialist} pe specialist și +{businessLocation} pe adresă suplimentară. Primele {seats} saloane primesc −{percent}% pe toată durata abonamentului cu codul {code}.",
    pricingTiers: [
      {
        name: "Start",
        audience: "Un specialist, pentru început",
        features: [
          "Programări online, calendar și clienți",
          "Profitul fiecărei vizite",
          "Raport pentru ultimele 30 de zile",
          "Mementouri pentru clienți pe email",
        ],
      },
      {
        name: "Solo",
        audience: "Un specialist, o adresă",
        features: [
          "Tot din «Start»",
          "Rapoarte pentru orice perioadă: marjă și profit pe oră",
          "Materialele — din achiziții sau ca sumă pe serviciu",
          "Evidența cheltuielilor și importul clienților",
        ],
      },
      {
        name: "Studio",
        audience: "Echipă mică la o singură adresă",
        features: [
          "Tot din «Solo»",
          "3 specialiști, apoi +{studioSpecialist} pe lună pentru fiecare",
          "Roluri și gestionarea echipei",
          "Comisioane și chirie de scaun pentru fiecare specialist",
        ],
      },
      {
        name: "Business",
        audience: "Mai multe adrese și o echipă mare",
        features: [
          "Tot din «Studio»",
          "Până la 8 specialiști și 3 adrese",
          "Programări online separate pentru fiecare adresă",
          "Ajutor la mutarea din alt sistem",
        ],
      },
    ],
    footer: "Nail Profit OS · programări și profit pentru nail business",
    privacy: "Confidențialitate",
    terms: "Termeni",
  },
  en: {
    navHow: "How it works",
    navFor: "For studios",
    navPricing: "Pricing",
    signIn: "Sign in",
    start: "Start costing",
    eyebrow: "Bookings and profit in one place",
    titleFirst: "Stop guessing",
    titleAccent: "what a service earns.",
    intro: "Clients book online, you close the visit — and see what each service leaves you after commission, taxes and specialist time.",
    seeExample: "See the calculation",
    demoLabel: "Visit example",
    service: "Gel manicure",
    price: "Service price",
    taxes: "Taxes and card fees",
    commission: "Specialist commission",
    youKeep: "Studio keeps",
    perHour: "Profit per hour",
    usesRealData: "Based on time, taxes, and commission rules",
    forSolo: "Solo specialist",
    forStudio: "Studio",
    reasonEyebrow: "Bookings and money, together",
    reasonTitle: "You do not need another report. You need clarity before the next decision.",
    reasonBody: "Raise a price, review a commission, or retire an unprofitable service — these choices should not rely on a feeling.",
    pillars: [
      { number: "01", title: "Shows the calculation", body: "Every number opens into commission, taxes, and time." },
      { number: "02", title: "Calculates from reality", body: "A closed visit is costed from its own figures and never restated afterwards." },
      { number: "03", title: "Move in 5 minutes", body: "Bring your clients and services over in 5 minutes: from your phone or from your old booking system's spreadsheet." },
    ],
    productEyebrow: "More than a number",
    productTitle: "See a service the way your business sees it.",
    productBody: "A clear visit anatomy turns price and costs into a decision you can make immediately.",
    sampleService: "Gel manicure · 1 h 30 min",
    sampleInsight: "The price covers commission and taxes. Margin is 54%.",
    sampleAction: "Open the report",
    calculatorEyebrow: "Try your own example",
    calculatorTitle: "Price is where the calculation starts.",
    calculatorBody: "Change the values and see how the result moves. The product uses taxes, card fees, and visit duration for the final calculation.",
    priceInput: "Service price",
    taxInput: "Taxes and card fees",
    commissionInput: "Commission",
    hourNote: "This example uses a 1 h 30 min visit.",
    finalTitle: "Find out what every service really brings in.",
    finalBody: "Build your first calculation and make clearer decisions about price and your team.",
    pricingEyebrow: "Pricing",
    pricingTitle: "Start free. No cut of your revenue.",
    pricingBody:
      "Bookings, calendar and the profit of every visit — free for one specialist. Paid plans open full reports, expenses, the team and extra locations.",
    pricingPeriodGroupLabel: "Billing period",
    pricingPeriodLabels: ["Monthly", "6 months", "12 months"],
    pricingPerMonth: "per month",
    pricingBilledMonthly: "Billed every month",
    pricingFor: "for",
    pricingSaveLabel: "saved",
    pricingCta: "Start free trial",
    pricingTrial: "{days} days of Studio free, no card",
    pricingStartTerms: "Free, no time limit",
    pricingStartCta: "Start free",
    pricingStartNote: "No card. Move to a paid plan any time",
    pricingFeaturedBadge: "Most popular",
    pricingNote:
      "Prices in euro, the same in every country, billed through Paddle. Six months cost five, twelve cost nine. Studio adds {studioSpecialist}/month per specialist beyond three; Business adds {businessSpecialist} per specialist and {businessLocation} per extra location. The first {seats} studios keep −{percent}% for as long as they subscribe, with code {code}.",
    pricingTiers: [
      {
        name: "Start",
        audience: "One specialist, getting started",
        features: [
          "Online booking, calendar and clients",
          "Profit of every visit",
          "Report for the last 30 days",
          "Client reminders by email",
        ],
      },
      {
        name: "Solo",
        audience: "One specialist, one location",
        features: [
          "Everything in Start",
          "Reports for any period: margin and profit per hour",
          "Materials from purchases or as an amount per service",
          "Expense ledger and client import",
        ],
      },
      {
        name: "Studio",
        audience: "A small team at a single location",
        features: [
          "Everything in Solo",
          "3 specialists, then +{studioSpecialist}/month each",
          "Roles and team management",
          "Commissions and chair rent per specialist",
        ],
      },
      {
        name: "Business",
        audience: "Several locations and a larger team",
        features: [
          "Everything in Studio",
          "Up to 8 specialists and 3 locations",
          "Separate online booking for each location",
          "Help moving from another system",
        ],
      },
    ],
    footer: "Nail Profit OS · bookings and profit for nail businesses",
    privacy: "Privacy",
    terms: "Terms",
  },
};

function Money({ value }: { value: number }) {
  return <>{new Intl.NumberFormat("ru-RU").format(value)} MDL</>;
}

export function LandingExperience({ locale }: { locale: AppLocale }) {
  const copy = content[locale];
  const [mode, setMode] = useState<"solo" | "studio">("studio");
  const [price, setPrice] = useState(600);
  const [taxes, setTaxes] = useState(42);
  const [commission, setCommission] = useState(240);
  const [pricingPeriod, setPricingPeriod] = useState<BillingPeriod>(1);

  const demo = mode === "studio" ? { price: 600, taxes: 42, commission: 240 } : { price: 600, taxes: 42, commission: 0 };
  const takeHome = useMemo(() => Math.max(0, price - taxes - commission), [price, taxes, commission]);
  const hourly = Math.round((takeHome / 1.5) * 100) / 100;

  return (
    <main className="marketing-page">
      <div className="marketing-grain" aria-hidden="true" />
      <nav className="marketing-nav" aria-label="Main navigation">
        <Link className="marketing-brand" href="#top" aria-label="Nail Profit OS">
          <span className="marketing-mark">NP</span>
          <span>Nail Profit<sup>OS</sup></span>
        </Link>
        <div className="marketing-nav-links">
          <a href="#how">{copy.navHow}</a>
          <a href="#studio">{copy.navFor}</a>
          <a href="#pricing">{copy.navPricing}</a>
        </div>
        <div className="marketing-nav-actions">
          <Link className="marketing-login" href="/login">{copy.signIn}</Link>
          <Link className="marketing-cta marketing-cta-small" href="/login?mode=signup">{copy.start}</Link>
        </div>
      </nav>

      <section id="top" className="marketing-hero" aria-labelledby="hero-title">
        <div className="hero-copy marketing-reveal">
          <p className="marketing-kicker"><span />{copy.eyebrow}</p>
          <h1 id="hero-title">{copy.titleFirst}<br /><em>{copy.titleAccent}</em></h1>
          <p className="marketing-intro">{copy.intro}</p>
          <div className="hero-actions">
            <Link className="marketing-cta" href="/login?mode=signup">{copy.start}<span aria-hidden="true">↗</span></Link>
            <a className="marketing-text-action" href="#calculator">{copy.seeExample}<span aria-hidden="true">↓</span></a>
          </div>
          <p className="hero-fine-print">{copy.usesRealData}</p>
        </div>

        <div className="hero-visual marketing-reveal marketing-reveal-delayed">
          <Image src="/images/studio-ledger-hero.png" alt="Рабочее место nail-мастера и финансовая книга" width={1536} height={1024} loading="eager" />
          <div className="hero-sun" aria-hidden="true" />
          <div className="hero-calculation" aria-label={copy.demoLabel}>
            <div className="calculation-topline"><span>{copy.demoLabel}</span><i /></div>
            <strong>{copy.service}</strong>
            <div className="calculation-row"><span>{copy.price}</span><b><Money value={demo.price} /></b></div>
            <div className="calculation-row"><span>{copy.taxes}</span><b>− <Money value={demo.taxes} /></b></div>
            {demo.commission > 0 && <div className="calculation-row"><span>{copy.commission}</span><b>− <Money value={demo.commission} /></b></div>}
            <div className="calculation-total"><span>{copy.youKeep}</span><strong><Money value={demo.price - demo.taxes - demo.commission} /></strong></div>
            <div className="calculation-tabs" role="group" aria-label="Business type">
              <button className={mode === "solo" ? "active" : ""} type="button" onClick={() => setMode("solo")}>{copy.forSolo}</button>
              <button className={mode === "studio" ? "active" : ""} type="button" onClick={() => setMode("studio")}>{copy.forStudio}</button>
            </div>
          </div>
          <div className="hero-stamp"><span>01</span><span>Real<br />economics</span></div>
        </div>
      </section>

      <section id="how" className="marketing-reason section-wrap">
        <div className="section-lead marketing-reveal">
          <p className="marketing-kicker"><span />{copy.reasonEyebrow}</p>
          <h2>{copy.reasonTitle}</h2>
          <p>{copy.reasonBody}</p>
        </div>
        <div className="marketing-pillars">
          {copy.pillars.map((pillar, index) => (
            <article className="marketing-pillar marketing-reveal" style={{ animationDelay: `${80 + index * 90}ms` }} key={pillar.number}>
              <span>{pillar.number}</span>
              <h3>{pillar.title}</h3>
              <p>{pillar.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="studio" className="marketing-product section-wrap">
        <div className="product-photo marketing-reveal">
          <Image src="/images/studio-ledger-hero.png" alt="Материалы на рабочем столе nail-студии" width={1536} height={1024} />
          <p><span>◒</span>{copy.usesRealData}</p>
        </div>
        <div className="product-copy marketing-reveal marketing-reveal-delayed">
          <p className="marketing-kicker"><span />{copy.productEyebrow}</p>
          <h2>{copy.productTitle}</h2>
          <p>{copy.productBody}</p>
          <div className="product-report" aria-label={copy.service}>
            <div className="report-heading"><span>{copy.sampleService}</span><span className="report-status">54%</span></div>
            <div className="report-bar" aria-hidden="true"><i /><i /><i /></div>
            <div className="report-labels"><span>{copy.price}</span><span>{copy.taxes}</span><span>{copy.commission}</span></div>
            <p>{copy.sampleInsight}</p>
            <Link href="/login?mode=signup">{copy.sampleAction}<span aria-hidden="true">→</span></Link>
          </div>
        </div>
      </section>

      <section id="calculator" className="marketing-calculator section-wrap">
        <div className="calculator-copy marketing-reveal">
          <p className="marketing-kicker"><span />{copy.calculatorEyebrow}</p>
          <h2>{copy.calculatorTitle}</h2>
          <p>{copy.calculatorBody}</p>
        </div>
        <div className="calculator-card marketing-reveal marketing-reveal-delayed">
          <label>{copy.priceInput}<output><Money value={price} /></output><input type="range" min="300" max="1200" step="10" value={price} onChange={(event) => setPrice(Number(event.target.value))} /></label>
          <label>{copy.taxInput}<output><Money value={taxes} /></output><input type="range" min="0" max="250" step="1" value={taxes} onChange={(event) => setTaxes(Number(event.target.value))} /></label>
          <label>{copy.commissionInput}<output><Money value={commission} /></output><input type="range" min="0" max="500" step="10" value={commission} onChange={(event) => setCommission(Number(event.target.value))} /></label>
          <div className="calculator-result">
            <span>{copy.youKeep}</span><strong><Money value={takeHome} /></strong>
            <div><span>{copy.perHour}</span><b><Money value={hourly} /></b></div>
          </div>
          <small>{copy.hourNote}</small>
        </div>
      </section>

      <section id="pricing" className="marketing-pricing section-wrap">
        <div className="pricing-head marketing-reveal">
          <p className="marketing-kicker"><span />{copy.pricingEyebrow}</p>
          <h2>{copy.pricingTitle}</h2>
          <p>{copy.pricingBody}</p>
          <div className="pricing-period" role="group" aria-label={copy.pricingPeriodGroupLabel}>
            {billingPeriods.map((months, index) => (
              <button
                key={months}
                type="button"
                className={pricingPeriod === months ? "active" : ""}
                aria-pressed={pricingPeriod === months}
                onClick={() => setPricingPeriod(months)}
              >
                {copy.pricingPeriodLabels[index]}
              </button>
            ))}
          </div>
        </div>

        <div className="pricing-grid">
          {planTiers.map((tier, index) => {
            const plan = copy.pricingTiers[index];
            const free = tier === "start";
            const total = periodPriceMinor(tier, pricingPeriod) / 100;
            const perMonth = effectiveMonthlyPriceMinor(tier, pricingPeriod) / 100;
            const saved = periodSavingPercent(pricingPeriod);
            const featured = tier === featuredTier;
            return (
              <article key={tier} className={`pricing-card${featured ? " featured" : ""}`}>
                {featured && <span className="pricing-badge">{copy.pricingFeaturedBadge}</span>}
                <div className="pricing-tier">
                  <h3>{plan.name}</h3>
                  <p>{plan.audience}</p>
                </div>
                <div className="pricing-price">
                  <strong key={pricingPeriod}>{formatEuro(perMonth, locale)}</strong>
                  <span>{copy.pricingPerMonth}</span>
                </div>
                <p key={pricingPeriod} className="pricing-terms">
                  {free ? (
                    copy.pricingStartTerms
                  ) : pricingPeriod === 1 ? (
                    copy.pricingBilledMonthly
                  ) : (
                    <>
                      {formatEuro(total, locale)} {copy.pricingFor}{" "}
                      {copy.pricingPeriodLabels[billingPeriods.indexOf(pricingPeriod)]}
                      {saved > 0 && (
                        <b className="pricing-save" aria-label={`${saved}% ${copy.pricingSaveLabel}`}>
                          −{saved}%
                        </b>
                      )}
                    </>
                  )}
                </p>
                <ul className="pricing-features">
                  {plan.features.map((feature) => (
                    <li key={feature}>{fill(feature, { studioSpecialist: formatEuro(addOnMonthlyPriceMinor.studio.specialist / 100, locale) })}</li>
                  ))}
                </ul>
                <Link className="marketing-cta pricing-cta" href="/login?mode=signup">
                  {free ? copy.pricingStartCta : copy.pricingCta}<span aria-hidden="true">↗</span>
                </Link>
                <small>{fill(free ? copy.pricingStartNote : copy.pricingTrial, { days: signupTrial.days })}</small>
              </article>
            );
          })}
        </div>

        <p className="pricing-note">
          {fill(copy.pricingNote, {
            studioSpecialist: formatEuro(addOnMonthlyPriceMinor.studio.specialist / 100, locale),
            businessSpecialist: formatEuro(addOnMonthlyPriceMinor.business.specialist / 100, locale),
            businessLocation: formatEuro(addOnMonthlyPriceMinor.business.location / 100, locale),
            seats: founderOffer.seats,
            percent: founderOffer.percentOff,
            code: founderOffer.code,
            days: signupTrial.days,
          })}
        </p>
      </section>

      <section className="marketing-final section-wrap marketing-reveal">
        <span className="marketing-mark">NP</span>
        <h2>{copy.finalTitle}</h2>
        <p>{copy.finalBody}</p>
        <Link className="marketing-cta" href="/login?mode=signup">{copy.start}<span aria-hidden="true">↗</span></Link>
      </section>

      <footer className="marketing-footer">
        <span>{copy.footer}</span>
        <div><Link href="/privacy">{copy.privacy}</Link><Link href="/terms">{copy.terms}</Link></div>
      </footer>
    </main>
  );
}
