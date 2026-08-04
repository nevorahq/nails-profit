import Link from "next/link";

import { getMessages } from "@/i18n/messages";

export default function HomePage() {
  const t = getMessages("ru");

  return (
    <main className="landing-shell">
      <nav className="topbar">
        <span className="brand">{t.productName}</span>
        <Link className="text-link" href="/login">
          {t.login}
        </Link>
      </nav>
      <section className="hero">
        <div className="eyebrow">Profit layer для вашей системы записи</div>
        <h1>{t.hero}</h1>
        <p>{t.tagline}. Fresha, DIKIDI, YCLIENTS и Stilio остаются там, где они уже работают.</p>
        <Link className="primary-button" href="/login?mode=signup">
          {t.start}
        </Link>
      </section>
      <section className="metric-preview" aria-label="Пример расчёта">
        <div>
          <span>Цена услуги</span>
          <strong>600 MDL</strong>
        </div>
        <div>
          <span>Останется вам</span>
          <strong>325 MDL</strong>
        </div>
        <div>
          <span>Прибыль в час</span>
          <strong>216,67 MDL</strong>
        </div>
      </section>
    </main>
  );
}
