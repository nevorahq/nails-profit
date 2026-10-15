import { signupTrial } from "@/domain/plans";
import type { AppLocale } from "@/i18n/messages";
import { REFUND_DAYS } from "@/lib/legal";

export type LegalSection = Readonly<{
  heading: string;
  paragraphs: readonly string[];
  bullets?: readonly string[];
}>;

export type LegalDocument = Readonly<{
  intro: string;
  sections: readonly LegalSection[];
}>;

export const privacyContent: Record<AppLocale, LegalDocument> = {
  ru: {
    intro:
      "Nail Profit OS обрабатывает данные аккаунта и данные, которые студия вводит для расчёта прибыльности. Это уведомление объясняет, какие данные используются и как ими управлять.",
    sections: [
      {
        heading: "Кто отвечает за данные",
        paragraphs: [
          "Оператор Nail Profit OS, указанный на этой странице, отвечает за аккаунты, безопасность и работу сервиса. Студия отвечает за законность внесения данных своих клиентов и действует как их основной контакт.",
        ],
      },
      {
        heading: "Какие данные обрабатываются",
        paragraphs: ["Мы минимизируем объём данных и используем только то, что нужно для работы сервиса."],
        bullets: [
          "данные аккаунта: имя, email, роли, организация и настройки языка/валюты;",
          "рабочие данные: мастера, услуги, цены, визиты и финансовые snapshots;",
          "данные клиентов студии: имя и, если студия их указала, телефон или email;",
          "технические данные: идентификаторы запросов, события безопасности и ошибки без открытых PII в логах.",
        ],
      },
      {
        heading: "Зачем используются данные",
        paragraphs: [
          "Данные используются для входа, tenant-isolation, расчёта себестоимости и прибыли, импорта, поддержки, предотвращения злоупотреблений, диагностики ошибок и восстановления после инцидента.",
          "Данные клиентов не используются для рекламы Nail Profit OS и не продаются.",
        ],
      },
      {
        heading: "Кому данные могут передаваться",
        paragraphs: [
          "Доступ получают только сотрудники и поставщики инфраструктуры, которым он нужен для размещения базы данных, доставки сервиса, мониторинга или поддержки. Они должны работать по инструкциям оператора и с минимальными правами.",
          "Оплату подписки принимает Paddle, платёжный посредник и продавец платных тарифов. Данные банковской карты вводятся на стороне Paddle и до оператора не доходят; оператор получает статус подписки, тариф, email плательщика и идентификаторы платежа.",
        ],
      },
      {
        heading: "Хранение и безопасность",
        paragraphs: [
          "Данные хранятся пока действует аккаунт и дольше только там, где финансовая история или безопасность требуют сохранения. Сырой файл импорта удаляется после подтверждения. Резервные копии имеют ограниченный срок хранения.",
          "Используются шифрование соединений, изоляция организаций, роли, audit trail, PII masking и резервное копирование. Ни одна система не может гарантировать абсолютную безопасность.",
        ],
      },
      {
        heading: "Ваши действия и права",
        paragraphs: [
          "Owner может выгрузить данные организации и запросить удаление в настройках. Данные можно исправить через интерфейс или поддержку. Удаление анонимизирует PII, но может сохранить финансовые записи без идентифицирующих данных.",
          "По вопросам данных пишите оператору по адресу, указанному на этой странице. Клиент студии должен сначала обратиться в свою студию.",
        ],
      },
      {
        heading: "Изменения уведомления",
        paragraphs: [
          "Для новой существенной версии будет показано отдельное уведомление. Версия и время ознакомления сохраняются вместе с аккаунтом.",
        ],
      },
    ],
  },
  ro: {
    intro:
      "Nail Profit OS prelucrează datele contului și datele introduse de salon pentru calculul profitabilității. Această notificare explică datele folosite și modul în care pot fi gestionate.",
    sections: [
      {
        heading: "Cine răspunde de date",
        paragraphs: [
          "Operatorul Nail Profit OS indicat pe această pagină răspunde de conturi, securitate și funcționarea serviciului. Salonul răspunde de legalitatea datelor clienților săi și este contactul principal pentru aceștia.",
        ],
      },
      {
        heading: "Ce date sunt prelucrate",
        paragraphs: ["Colectăm doar datele necesare funcționării serviciului."],
        bullets: [
          "date de cont: nume, email, roluri, organizație, limbă și monedă;",
          "date operaționale: specialiști, servicii, prețuri, vizite și snapshots financiare;",
          "datele clienților salonului: nume și, dacă sunt furnizate, telefon sau email;",
          "date tehnice: identificatori de cerere, evenimente de securitate și erori fără PII deschise în loguri.",
        ],
      },
      {
        heading: "De ce sunt folosite datele",
        paragraphs: [
          "Datele sunt folosite pentru autentificare, izolarea organizațiilor, calcule de cost și profit, import, suport, prevenirea abuzurilor, diagnosticarea erorilor și recuperarea după incidente.",
          "Datele clienților nu sunt vândute și nu sunt folosite pentru publicitatea Nail Profit OS.",
        ],
      },
      {
        heading: "Cui pot fi transmise datele",
        paragraphs: [
          "Accesul este limitat la personalul și furnizorii de infrastructură care au nevoie de el pentru găzduire, monitorizare sau suport. Aceștia trebuie să urmeze instrucțiunile operatorului și principiul accesului minim.",
          "Plata abonamentului este primită de Paddle, intermediar de plată și vânzător al planurilor plătite. Datele cardului sunt introduse la Paddle și nu ajung la operator; operatorul primește starea abonamentului, planul, emailul plătitorului și identificatorii plății.",
        ],
      },
      {
        heading: "Păstrare și securitate",
        paragraphs: [
          "Datele sunt păstrate cât timp contul este activ și mai mult doar dacă istoricul financiar sau securitatea o cer. Fișierul brut de import este șters după confirmare. Backupurile au o perioadă limitată de păstrare.",
          "Folosim conexiuni criptate, izolare între organizații, roluri, audit trail, mascarea PII și backupuri. Niciun sistem nu poate garanta securitate absolută.",
        ],
      },
      {
        heading: "Acțiunile și drepturile dvs.",
        paragraphs: [
          "Owner poate exporta datele organizației și poate solicita ștergerea în setări. Datele pot fi corectate din interfață sau prin suport. Ștergerea anonimizează PII, dar poate păstra înregistrări financiare fără identificatori.",
          "Pentru întrebări scrieți operatorului la adresa indicată pe această pagină. Clientul unui salon trebuie să contacteze mai întâi salonul.",
        ],
      },
      {
        heading: "Modificarea notificării",
        paragraphs: [
          "Pentru o versiune nouă importantă va fi afișată o notificare separată. Versiunea și momentul confirmării sunt păstrate cu contul.",
        ],
      },
    ],
  },
  en: {
    intro:
      "Nail Profit OS processes account data and the data a studio enters to calculate profitability. This notice explains what is used and how it can be managed.",
    sections: [
      {
        heading: "Who is responsible for the data",
        paragraphs: [
          "The Nail Profit OS operator named on this page is responsible for accounts, security and service operation. The studio is responsible for lawfully entering its clients' data and is their primary contact.",
        ],
      },
      {
        heading: "Data we process",
        paragraphs: ["We minimize data and use only what the service needs."],
        bullets: [
          "account data: name, email, roles, organization, language and currency settings;",
          "operational data: specialists, services, prices, visits and financial snapshots;",
          "studio client data: name and, when supplied, phone number or email;",
          "technical data: request identifiers, security events and errors without exposed PII in logs.",
        ],
      },
      {
        heading: "Why we use the data",
        paragraphs: [
          "Data is used for sign-in, tenant isolation, cost and profit calculations, imports, support, abuse prevention, error diagnosis and incident recovery.",
          "Studio client data is not sold or used to advertise Nail Profit OS.",
        ],
      },
      {
        heading: "Who may receive the data",
        paragraphs: [
          "Access is limited to personnel and infrastructure providers that need it for database hosting, service delivery, monitoring or support. They must follow the operator's instructions and least-privilege access.",
          "Subscription payments are taken by Paddle, the payment intermediary and seller of the paid plans. Card details are entered with Paddle and never reach the operator; the operator receives the subscription status, the plan, the payer's email and payment identifiers.",
        ],
      },
      {
        heading: "Retention and security",
        paragraphs: [
          "Data is kept while the account is active and longer only where financial history or security requires it. Raw import files are removed after confirmation. Backups have a limited retention period.",
          "Controls include encrypted connections, tenant isolation, roles, audit trails, PII masking and backups. No system can promise absolute security.",
        ],
      },
      {
        heading: "Your actions and rights",
        paragraphs: [
          "An Owner can export organization data and request deletion in Settings. Data can be corrected through the interface or support. Deletion anonymizes PII but may retain financial records without identifying data.",
          "For data questions write to the operator at the address on this page. A studio client should contact the studio first.",
        ],
      },
      {
        heading: "Changes to this notice",
        paragraphs: [
          "A separate notice will be shown for a material new version. The accepted version and acknowledgment time are stored with the account.",
        ],
      },
    ],
  },
};


const trialDays = signupTrial.days;

export const termsContent: Record<AppLocale, LegalDocument> = {
  ru: {
    intro:
      "Эти условия регулируют использование Nail Profit OS между пользователем и оператором сервиса, указанным на этой странице. Регистрируясь, вы принимаете их.",
    sections: [
      {
        heading: "Назначение сервиса",
        paragraphs: [
          "Сервис рассчитывает себестоимость, прибыль визита и прибыль в час на основании данных пользователя и ведёт онлайн-запись. Это инструмент управленческого анализа, а не бухгалтерская, налоговая или юридическая консультация.",
        ],
      },
      {
        heading: "Аккаунт и доступ",
        paragraphs: [
          "Пользователь предоставляет достоверные данные, защищает учётную запись и выдаёт сотрудникам минимально необходимые роли. Действия из аккаунта считаются действиями его авторизованных пользователей.",
        ],
      },
      {
        heading: "Допустимое использование",
        paragraphs: [
          "Запрещены незаконные данные, попытки обойти изоляцию организаций, проверять чужие идентификаторы, перегружать сервис, распространять вредоносные файлы или нарушать права других лиц.",
        ],
      },
      {
        heading: "Данные и расчёты",
        paragraphs: [
          "Пользователь отвечает за точность цен, комиссий и импортов. Nail Profit OS показывает основание расчёта и не считает неизвестную стоимость нулевой, но решение по цене и бизнесу остаётся за пользователем.",
        ],
      },
      {
        heading: "Тарифы, пробный период и оплата",
        paragraphs: [
          "Тариф «Старт» бесплатный и не ограничен по времени. Платные тарифы «Соло», «Студия» и «Бизнес» оплачиваются за 1, 6 или 12 месяцев вперёд; цены в евро указаны в разделе тарифов на главной странице.",
          `Новая студия может пользоваться тарифом «Студия» без карты ${trialDays} дней. По окончании пробного периода студия переходит на «Старт», если не оформила платную подписку.`,
          "Платную подписку принимает и обрабатывает Paddle, который выступает продавцом (Merchant of Record) и выставляет чек; к покупке применяются также условия Paddle. Налоги добавляются или включаются в цену в зависимости от страны плательщика.",
          "Подписка продлевается автоматически на тот же срок, пока её не отменят. Цены для будущих периодов могут меняться; об изменении сообщается заранее, а уже оплаченный период не пересчитывается.",
        ],
      },
      {
        heading: "Отмена и возврат",
        paragraphs: [
          "Подписку можно отменить в любой момент: по ссылке управления подпиской в настройках или письмом в поддержку. Доступ к оплаченному тарифу сохраняется до конца оплаченного периода, дальше студия переходит на «Старт»; данные при этом не удаляются.",
          "Условия возврата денег описаны на отдельной странице «Возврат и отмена подписки».",
        ],
      },
      {
        heading: "Доступность и изменения",
        paragraphs: [
          "Сервис может меняться и временно останавливаться для исправлений, безопасности или обслуживания. Существенные изменения, влияющие на данные или оплату, сообщаются заранее.",
        ],
      },
      {
        heading: "Завершение использования",
        paragraphs: [
          "Owner может выгрузить данные до удаления организации. Оператор может ограничить доступ при угрозе безопасности или существенном нарушении условий и должен сохранить доступ к выгрузке, когда это безопасно и применимо.",
        ],
      },
      {
        heading: "Участники пилота",
        paragraphs: [
          "Студии, подключённые по договору пилота, пользуются сервисом на условиях этого договора. При расхождении договор пилота имеет приоритет над этой страницей.",
        ],
      },
      {
        heading: "Ответственность",
        paragraphs: [
          "Решения о ценах, комиссиях и бизнесе принимает пользователь. Условия не ограничивают права, которые нельзя ограничить по закону.",
        ],
      },
    ],
  },
  ro: {
    intro:
      "Aceste condiții reglementează folosirea Nail Profit OS între utilizator și operatorul serviciului indicat pe această pagină. Creând un cont, le acceptați.",
    sections: [
      {
        heading: "Scopul serviciului",
        paragraphs: [
          "Serviciul calculează costul, profitul unei vizite și profitul pe oră din datele utilizatorului și oferă programare online. Este un instrument de analiză managerială, nu consultanță contabilă, fiscală sau juridică.",
        ],
      },
      {
        heading: "Cont și acces",
        paragraphs: [
          "Utilizatorul oferă date corecte, protejează contul și acordă angajaților rolurile minime necesare. Acțiunile din cont sunt considerate acțiuni ale utilizatorilor autorizați.",
        ],
      },
      {
        heading: "Utilizare permisă",
        paragraphs: [
          "Sunt interzise datele ilegale, încercările de a ocoli izolarea organizațiilor, testarea identificatorilor altora, supraîncărcarea serviciului, fișierele malițioase și încălcarea drepturilor altor persoane.",
        ],
      },
      {
        heading: "Date și calcule",
        paragraphs: [
          "Utilizatorul răspunde de corectitudinea prețurilor, comisioanelor și importurilor. Nail Profit OS explică formula și nu tratează un cost necunoscut ca zero, dar deciziile comerciale aparțin utilizatorului.",
        ],
      },
      {
        heading: "Planuri, perioadă de probă și plată",
        paragraphs: [
          "Planul „Start” este gratuit și fără limită de timp. Planurile plătite „Solo”, „Studio” și „Business” se plătesc în avans pentru 1, 6 sau 12 luni; prețurile în euro sunt în secțiunea de tarife de pe pagina principală.",
          `Un salon nou poate folosi planul „Studio” fără card timp de ${trialDays} zile. La sfârșitul perioadei de probă salonul trece pe „Start”, dacă nu a ales un abonament plătit.`,
          "Abonamentul plătit este primit și procesat de Paddle, care este vânzătorul (Merchant of Record) și emite chitanța; se aplică și condițiile Paddle. Taxele se adaugă sau sunt incluse în preț în funcție de țara plătitorului.",
          "Abonamentul se reînnoiește automat pentru aceeași perioadă până este anulat. Prețurile pentru perioadele viitoare se pot schimba; schimbarea este anunțată din timp, iar perioada deja plătită nu se recalculează.",
        ],
      },
      {
        heading: "Anulare și rambursare",
        paragraphs: [
          "Abonamentul poate fi anulat oricând: prin linkul de gestionare din setări sau printr-un mesaj către suport. Accesul la planul plătit rămâne până la sfârșitul perioadei plătite, apoi salonul trece pe „Start”; datele nu se șterg.",
          "Condițiile de rambursare sunt descrise pe pagina separată „Rambursare și anulare”.",
        ],
      },
      {
        heading: "Disponibilitate și schimbări",
        paragraphs: [
          "Serviciul se poate schimba sau opri temporar pentru corecții, securitate ori mentenanță. Schimbările importante care afectează datele sau plata sunt anunțate din timp.",
        ],
      },
      {
        heading: "Încetarea folosirii",
        paragraphs: [
          "Owner poate exporta datele înainte de ștergerea organizației. Operatorul poate limita accesul în caz de risc de securitate sau încălcare importantă și păstrează accesul la export când este sigur și aplicabil.",
        ],
      },
      {
        heading: "Participanții la pilot",
        paragraphs: [
          "Saloanele conectate prin acordul pilot folosesc serviciul în condițiile acelui acord. În caz de conflict, acordul pilot are prioritate față de această pagină.",
        ],
      },
      {
        heading: "Răspundere",
        paragraphs: [
          "Deciziile privind prețurile, comisioanele și afacerea aparțin utilizatorului. Aceste condiții nu limitează drepturile care nu pot fi limitate prin lege.",
        ],
      },
    ],
  },
  en: {
    intro:
      "These terms govern use of Nail Profit OS between the user and the service operator named on this page. By creating an account you accept them.",
    sections: [
      {
        heading: "Purpose of the service",
        paragraphs: [
          "The service calculates cost, profit per visit and profit per hour from user-supplied data and provides online booking. It is a management analysis tool, not accounting, tax or legal advice.",
        ],
      },
      {
        heading: "Account and access",
        paragraphs: [
          "The user provides accurate data, protects the account and grants staff the minimum necessary roles. Actions from the account are treated as actions of its authorized users.",
        ],
      },
      {
        heading: "Acceptable use",
        paragraphs: [
          "Illegal data, attempts to bypass tenant isolation, probing another tenant's identifiers, overloading the service, malicious files and infringement of others' rights are prohibited.",
        ],
      },
      {
        heading: "Data and calculations",
        paragraphs: [
          "The user is responsible for prices, commissions and imports. Nail Profit OS explains its calculation and does not treat an unknown cost as zero, but pricing and business decisions remain the user's responsibility.",
        ],
      },
      {
        heading: "Plans, trial and payment",
        paragraphs: [
          "The Start plan is free with no time limit. The paid plans Solo, Studio and Business are paid in advance for 1, 6 or 12 months; the prices in euro are in the pricing section of the home page.",
          `A new studio can use the Studio plan without a card for ${trialDays} days. When the trial ends the studio moves to Start unless it has taken a paid subscription.`,
          "A paid subscription is taken and processed by Paddle, which is the seller (Merchant of Record) and issues the receipt; Paddle's terms also apply to the purchase. Taxes are added to or included in the price depending on the payer's country.",
          "The subscription renews automatically for the same period until it is cancelled. Prices for future periods may change; a change is announced in advance and a period already paid for is not recalculated.",
        ],
      },
      {
        heading: "Cancellation and refunds",
        paragraphs: [
          "A subscription can be cancelled at any time: through the manage link in settings, or by writing to support. Access to the paid plan lasts until the end of the paid period, after which the studio moves to Start; its data is not deleted.",
          "The conditions for a refund are on the separate page “Refunds and cancellation”.",
        ],
      },
      {
        heading: "Availability and changes",
        paragraphs: [
          "The service may change or pause for fixes, security or maintenance. Material changes affecting data or payment are announced in advance.",
        ],
      },
      {
        heading: "Ending use",
        paragraphs: [
          "An Owner can export data before organization deletion. The operator may restrict access for a security threat or material breach and should preserve export access where safe and applicable.",
        ],
      },
      {
        heading: "Pilot participants",
        paragraphs: [
          "Studios connected under a pilot agreement use the service on that agreement's terms. If the agreement conflicts with this page, the pilot agreement controls.",
        ],
      },
      {
        heading: "Liability",
        paragraphs: [
          "Decisions about prices, commissions and the business are the user's. These terms do not limit rights that cannot be limited by law.",
        ],
      },
    ],
  },
};

export const refundContent: Record<AppLocale, LegalDocument> = {
  ru: {
    intro: `Платная подписка Nail Profit OS возвращается полностью в течение ${REFUND_DAYS} дней после любого списания. Ниже — как отменить подписку и как запросить возврат.`,
    sections: [
      {
        heading: "Что не требует возврата",
        paragraphs: [
          `Тариф «Старт» бесплатный, с вас ничего не списывается. Пробный период «Студии» (${trialDays} дней) проходит без карты, поэтому возвращать нечего.`,
        ],
      },
      {
        heading: "Как отменить подписку",
        paragraphs: [
          "Откройте настройки, раздел подписки, и перейдите по ссылке управления подпиской, либо напишите на адрес поддержки ниже, и мы отменим подписку сами. Отмена вступает в силу в конце оплаченного периода: до этой даты тариф работает, потом студия переходит на «Старт». Данные не удаляются.",
        ],
      },
      {
        heading: "Возврат денег",
        paragraphs: [
          `Если подписка вам не подошла, напишите нам в течение ${REFUND_DAYS} дней после списания, и мы вернём всю сумму без объяснения причин. Это относится и к предоплате за 6 и 12 месяцев, и к продлению.`,
          "По истечении этого срока оплаченный период не возвращается частями, но доступ к тарифу сохраняется до его конца.",
        ],
      },
      {
        heading: "Как запросить возврат",
        paragraphs: [
          "Напишите на адрес поддержки, указанный ниже, с email, на который оформлена подписка, и названием студии. Платёж возвращает Paddle на ту же карту или способ оплаты, обычно в течение нескольких рабочих дней; точный срок зависит от банка.",
        ],
      },
      {
        heading: "Ваши права по закону",
        paragraphs: ["Эти условия не ограничивают права потребителя, которые вам даёт закон вашей страны."],
      },
    ],
  },
  ro: {
    intro: `Abonamentul plătit Nail Profit OS se rambursează integral în ${REFUND_DAYS} de zile de la orice plată. Mai jos: cum anulați abonamentul și cum cereți rambursarea.`,
    sections: [
      {
        heading: "Ce nu necesită rambursare",
        paragraphs: [
          `Planul „Start” este gratuit și nu se percepe nimic. Perioada de probă „Studio” (${trialDays} zile) este fără card, deci nu e nimic de rambursat.`,
        ],
      },
      {
        heading: "Cum anulați abonamentul",
        paragraphs: [
          "Deschideți setările, secțiunea abonamentului, și folosiți linkul de gestionare, sau scrieți la adresa de suport de mai jos și anulăm noi abonamentul. Anularea are efect la sfârșitul perioadei plătite: până atunci planul funcționează, apoi salonul trece pe „Start”. Datele nu se șterg.",
        ],
      },
      {
        heading: "Rambursarea banilor",
        paragraphs: [
          `Dacă abonamentul nu v-a convenit, scrieți-ne în ${REFUND_DAYS} de zile de la plată și vă rambursăm întreaga sumă, fără explicații. Se aplică și plății în avans pentru 6 și 12 luni, și reînnoirii.`,
          "După acest termen perioada plătită nu se rambursează parțial, dar accesul la plan rămâne până la sfârșitul ei.",
        ],
      },
      {
        heading: "Cum cereți rambursarea",
        paragraphs: [
          "Scrieți la adresa de suport de mai jos, cu emailul abonamentului și numele salonului. Plata este rambursată de Paddle pe același card sau metodă de plată, de obicei în câteva zile lucrătoare; termenul exact depinde de bancă.",
        ],
      },
      {
        heading: "Drepturile dumneavoastră legale",
        paragraphs: ["Aceste condiții nu limitează drepturile de consumator pe care vi le dă legea țării dumneavoastră."],
      },
    ],
  },
  en: {
    intro: `A paid Nail Profit OS subscription is refunded in full within ${REFUND_DAYS} days of any charge. Below: how to cancel and how to ask for a refund.`,
    sections: [
      {
        heading: "What needs no refund",
        paragraphs: [
          `The Start plan is free and nothing is charged. The Studio trial (${trialDays} days) runs without a card, so there is nothing to refund.`,
        ],
      },
      {
        heading: "How to cancel",
        paragraphs: [
          "Open settings, the subscription section, and follow the manage link, or write to the support address below and we cancel it for you. Cancellation takes effect at the end of the paid period: the plan works until then, after which the studio moves to Start. Data is not deleted.",
        ],
      },
      {
        heading: "Refunds",
        paragraphs: [
          `If the subscription did not suit you, write to us within ${REFUND_DAYS} days of the charge and we refund the full amount, no reason needed. This covers the 6 and 12-month prepay and renewals too.`,
          "After that window a paid period is not refunded in part, but access to the plan lasts to its end.",
        ],
      },
      {
        heading: "How to ask for a refund",
        paragraphs: [
          "Write to the support address below with the email the subscription is under and the studio's name. Paddle returns the payment to the same card or payment method, usually within a few business days; the exact time depends on your bank.",
        ],
      },
      {
        heading: "Your statutory rights",
        paragraphs: ["These terms do not limit the consumer rights your country's law gives you."],
      },
    ],
  },
};
