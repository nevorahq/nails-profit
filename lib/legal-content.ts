import type { AppLocale } from "@/i18n/messages";

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
      "Nail Profit OS обрабатывает данные аккаунта и данные, которые студия вводит для расчёта прибыльности. Это уведомление объясняет, какие данные используются в закрытом пилоте и как ими управлять.",
    sections: [
      {
        heading: "Кто отвечает за данные",
        paragraphs: [
          "Оператор Nail Profit OS, указанный в договоре пилота, отвечает за аккаунты, безопасность и работу сервиса. Студия отвечает за законность внесения данных своих клиентов и действует как их основной контакт.",
        ],
      },
      {
        heading: "Какие данные обрабатываются",
        paragraphs: ["Мы минимизируем объём данных и используем только то, что нужно для работы пилота."],
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
          "По вопросам данных используйте контакт оператора, указанный в договоре пилота. Клиент студии должен сначала обратиться в свою студию.",
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
      "Nail Profit OS prelucrează datele contului și datele introduse de salon pentru calculul profitabilității. Această notificare explică datele folosite în pilotul închis și modul în care pot fi gestionate.",
    sections: [
      {
        heading: "Cine răspunde de date",
        paragraphs: [
          "Operatorul Nail Profit OS indicat în acordul pilot răspunde de conturi, securitate și funcționarea serviciului. Salonul răspunde de legalitatea datelor clienților săi și este contactul principal pentru aceștia.",
        ],
      },
      {
        heading: "Ce date sunt prelucrate",
        paragraphs: ["Colectăm doar datele necesare funcționării pilotului."],
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
          "Pentru întrebări folosiți contactul operatorului din acordul pilot. Clientul unui salon trebuie să contacteze mai întâi salonul.",
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
      "Nail Profit OS processes account data and the data a studio enters to calculate profitability. This notice explains what is used during the closed pilot and how it can be managed.",
    sections: [
      {
        heading: "Who is responsible for the data",
        paragraphs: [
          "The Nail Profit OS operator named in the pilot agreement is responsible for accounts, security and service operation. The studio is responsible for lawfully entering its clients' data and is their primary contact.",
        ],
      },
      {
        heading: "Data we process",
        paragraphs: ["We minimize data and use only what the pilot needs."],
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
          "For data questions use the operator contact in the pilot agreement. A studio client should contact the studio first.",
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

export const termsContent: Record<AppLocale, LegalDocument> = {
  ru: {
    intro:
      "Эти условия регулируют использование Nail Profit OS в закрытом пилоте между пользователем и оператором, указанным в договоре пилота.",
    sections: [
      {
        heading: "Назначение сервиса",
        paragraphs: [
          "Сервис рассчитывает себестоимость, contribution margin и прибыль в час на основании данных пользователя. Это инструмент управленческого анализа, а не бухгалтерская, налоговая или юридическая консультация.",
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
          "Пользователь отвечает за точность цен, норм расхода, комиссий и импортов. Nail Profit OS показывает основание расчёта и не считает неизвестную стоимость нулевой, но решение по цене и бизнесу остаётся за пользователем.",
        ],
      },
      {
        heading: "Доступность и изменения пилота",
        paragraphs: [
          "Пилот может меняться и временно останавливаться для исправлений, безопасности или обслуживания. Существенные изменения, влияющие на данные или оплату, сообщаются участникам пилота.",
        ],
      },
      {
        heading: "Завершение участия",
        paragraphs: [
          "Owner может выгрузить данные до удаления организации. Оператор может ограничить доступ при угрозе безопасности или существенном нарушении условий и должен сохранить доступ к выгрузке, когда это безопасно и применимо.",
        ],
      },
      {
        heading: "Ответственность",
        paragraphs: [
          "Условия ответственности, оплаты и прекращения пилота определяются подписанным договором. При расхождении договор пилота имеет приоритет над этой страницей.",
        ],
      },
    ],
  },
  ro: {
    intro:
      "Aceste condiții reglementează folosirea Nail Profit OS în pilotul închis între utilizator și operatorul indicat în acordul pilot.",
    sections: [
      {
        heading: "Scopul serviciului",
        paragraphs: [
          "Serviciul calculează costul, contribution margin și profitul pe oră din datele utilizatorului. Este un instrument de analiză managerială, nu consultanță contabilă, fiscală sau juridică.",
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
          "Utilizatorul răspunde de corectitudinea prețurilor, normelor, comisioanelor și importurilor. Nail Profit OS explică formula și nu tratează un cost necunoscut ca zero, dar deciziile comerciale aparțin utilizatorului.",
        ],
      },
      {
        heading: "Disponibilitate și schimbări",
        paragraphs: [
          "Pilotul se poate schimba sau opri temporar pentru corecții, securitate ori mentenanță. Schimbările importante care afectează datele sau plata sunt comunicate participanților.",
        ],
      },
      {
        heading: "Încetarea participării",
        paragraphs: [
          "Owner poate exporta datele înainte de ștergerea organizației. Operatorul poate limita accesul în caz de risc de securitate sau încălcare importantă și păstrează accesul la export când este sigur și aplicabil.",
        ],
      },
      {
        heading: "Răspundere",
        paragraphs: [
          "Răspunderea, plata și încetarea pilotului sunt stabilite în acordul semnat. În caz de conflict, acordul pilot are prioritate față de această pagină.",
        ],
      },
    ],
  },
  en: {
    intro:
      "These terms govern use of Nail Profit OS in the closed pilot between the user and the operator named in the pilot agreement.",
    sections: [
      {
        heading: "Purpose of the service",
        paragraphs: [
          "The service calculates cost, contribution margin and profit per hour from user-supplied data. It is a management analysis tool, not accounting, tax or legal advice.",
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
          "The user is responsible for prices, usage norms, commissions and imports. Nail Profit OS explains its calculation and does not treat an unknown cost as zero, but pricing and business decisions remain the user's responsibility.",
        ],
      },
      {
        heading: "Availability and pilot changes",
        paragraphs: [
          "The pilot may change or pause for fixes, security or maintenance. Material changes affecting data or payment are communicated to pilot participants.",
        ],
      },
      {
        heading: "Ending participation",
        paragraphs: [
          "An Owner can export data before organization deletion. The operator may restrict access for a security threat or material breach and should preserve export access where safe and applicable.",
        ],
      },
      {
        heading: "Liability",
        paragraphs: [
          "Liability, payment and pilot termination are governed by the signed agreement. If that agreement conflicts with this page, the pilot agreement controls.",
        ],
      },
    ],
  },
};

