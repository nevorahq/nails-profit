"use client";

import Link from "next/link";
import Image from "next/image";
import { useMemo, useState } from "react";

import type { AppLocale } from "@/i18n/messages";

type Copy = {
  navHow: string;
  navFor: string;
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
  footer: string;
  privacy: string;
  terms: string;
};

const content: Record<AppLocale, Copy> = {
  ru: {
    navHow: "Как это работает",
    navFor: "Для студии",
    signIn: "Войти",
    start: "Начать расчёт",
    eyebrow: "Финансовая система для nail-бизнеса",
    titleFirst: "Не угадывайте,",
    titleAccent: "что приносит услуга.",
    intro: "Цена в прайсе — ещё не заработок. Nail Profit показывает, что останется после комиссии, налогов и времени мастера.",
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
    reasonEyebrow: "Деньги — раньше календаря",
    reasonTitle: "Нужен не ещё один отчёт. Нужна ясность перед следующим решением.",
    reasonBody: "Поднять цену, пересмотреть комиссию, убрать невыгодную услугу — на такие вопросы нельзя отвечать по ощущению.",
    pillars: [
      { number: "01", title: "Показывает расчёт", body: "Каждая сумма раскрывается до комиссии, налогов и времени." },
      { number: "02", title: "Считает по факту", body: "Закрытый визит считается по своим же данным и потом не переписывается." },
      { number: "03", title: "Оставляет CRM на месте", body: "Импортируйте данные из записи и добавьте экономику там, где её не видно." },
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
    footer: "Nail Profit OS · финансовая ясность для nail-бизнеса",
    privacy: "Конфиденциальность",
    terms: "Условия",
  },
  ro: {
    navHow: "Cum funcționează",
    navFor: "Pentru salon",
    signIn: "Autentificare",
    start: "Începe calculul",
    eyebrow: "Sistem financiar pentru nail business",
    titleFirst: "Nu ghiciți",
    titleAccent: "ce aduce profit.",
    intro: "Prețul din listă nu este încă profit. Nail Profit arată ce rămâne după comision, taxe și timpul specialistului.",
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
    reasonEyebrow: "Banii înaintea calendarului",
    reasonTitle: "Nu aveți nevoie de încă un raport. Aveți nevoie de claritate înaintea următoarei decizii.",
    reasonBody: "Majorarea prețului, revizuirea comisionului sau renunțarea la un serviciu nerentabil nu trebuie să fie decizii luate din senzație.",
    pillars: [
      { number: "01", title: "Arată calculul", body: "Fiecare sumă poate fi înțeleasă: comision, taxe și timp." },
      { number: "02", title: "Calculează după fapt", body: "O vizită închisă se calculează din propriile date și nu se rescrie ulterior." },
      { number: "03", title: "Păstrează CRM-ul actual", body: "Importați programările și adăugați economia care nu se vede." },
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
    footer: "Nail Profit OS · claritate financiară pentru nail business",
    privacy: "Confidențialitate",
    terms: "Termeni",
  },
  en: {
    navHow: "How it works",
    navFor: "For studios",
    signIn: "Sign in",
    start: "Start costing",
    eyebrow: "Financial clarity for nail businesses",
    titleFirst: "Stop guessing",
    titleAccent: "what a service earns.",
    intro: "A menu price is not yet profit. Nail Profit shows what remains after commission, taxes, and specialist time.",
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
    reasonEyebrow: "Money before calendar",
    reasonTitle: "You do not need another report. You need clarity before the next decision.",
    reasonBody: "Raise a price, review a commission, or retire an unprofitable service — these choices should not rely on a feeling.",
    pillars: [
      { number: "01", title: "Shows the calculation", body: "Every number opens into commission, taxes, and time." },
      { number: "02", title: "Calculates from reality", body: "A closed visit is costed from its own figures and never restated afterwards." },
      { number: "03", title: "Works beside your CRM", body: "Import bookings and add the economics your calendar cannot show." },
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
    footer: "Nail Profit OS · financial clarity for nail businesses",
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
          <Image src="/images/studio-ledger-hero.png" alt="Рабочее место nail-мастера и финансовая книга" width={1536} height={1024} priority />
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
