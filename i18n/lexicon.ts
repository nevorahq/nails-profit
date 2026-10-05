import type { MessageKey } from "@/i18n/dictionary";
import type { BusinessType } from "@/i18n/business-labels";
import type { AppLocale } from "@/i18n/messages";
import type { Message } from "@/i18n/translate";

/**
 * Who the interface is talking to, beyond the language: somebody working alone
 * or a studio, and whether the owner asked for the economist's terms.
 *
 * `i18n/business-labels.ts` already splits a handful of labels by format, and
 * it is capped on purpose — every entry there is chosen at the call site and
 * paid for twice in three languages. What this file does is different in kind:
 * it does not add choices to the code, it replaces words in the dictionary. A
 * screen asks for `services.commission.studio` as it always has, and a studio
 * in the plain view reads «Оплата мастеру» there instead of «Комиссия
 * мастера». So the screens stay written once, and the rule «соло-мастер не
 * встречает слово „комиссия“ нигде» is a property of a table that a test can
 * read whole (`i18n/lexicon.test.ts`) rather than of forty call sites.
 *
 * Two layers, applied in this order over the dictionary:
 *
 * - `plainWords`, whenever detailed analytics is off: «Осталось» for the
 *   contribution margin, «Осталось за месяц» for the operating profit, «оплата
 *   мастеру» for the commission. A studio's voice, since that is who reads it
 *   when the solo layer does not apply.
 * - `soloWords`, for somebody working alone, in both modes: her pay is not a
 *   commission paid to anybody, so the word does not appear — not in a label,
 *   not in a hint, not in MISSING_COMMISSION_RULE.
 *
 * Wording only. Nothing here reaches a figure, the same promise the format and
 * the switch make — see `domain/basic-pl.ts` for the one place the plain view
 * nets two lines, and why the bottom line cannot move.
 */
export type Register = Readonly<{ business: BusinessType; detailed: boolean }>;

/** The dictionary as written: a studio with the detailed view, i.e. no layer at all. */
export const writtenRegister: Register = { business: "studio", detailed: true };

export function registerOf(workspace: Readonly<{ businessType: BusinessType; detailedAnalytics: boolean }>): Register {
  return { business: workspace.businessType, detailed: workspace.detailedAnalytics };
}

/** One replacement, in every language at once — a missing one is a compile error. */
type Words = Readonly<Record<AppLocale, Message>>;
type Layer = Readonly<Partial<Record<MessageKey, Words>>>;

/*
 * What the bank takes for a card payment, named without the word both layers
 * avoid. Shared because the solo layer applies in the detailed view too, where
 * the plain one does not.
 */
const bankFee: Layer = {
  "pl.acquiring": { ru: "Плата банку за карты", ro: "Plata băncii pentru carduri", en: "Card processing" },
  "payment.hint": {
    ru: "Банк берёт часть каждого чека по карте — этот блок позволяет считать эту плату в себестоимости визита, а не узнавать о ней из выписки. Способ по умолчанию подставляется при закрытии визита: наличные — отдельный способ, без платы банку.",
    ro: "Banca ia o parte din fiecare plată cu cardul — aici această plată intră în costul vizitei, în loc să fie aflată din extras. Metoda implicită este propusă la închiderea vizitei: numerarul este o metodă separată, fără plată băncii.",
    en: "The acquirer takes a share of every card payment — here it becomes part of what a visit costs, rather than something learned from a statement. The default method is offered when a visit is closed; cash is a method of its own, with no fee.",
  },
  "payment.rate": { ru: "Плата банку, %", ro: "Plata băncii, %", en: "Acquirer's fee, %" },
  "payment.noFee": { ru: "без платы банку", ro: "fără plată băncii", en: "no fee" },
  "payment.none": {
    ru: "Способы оплаты не заданы — плата банку нигде не учитывается.",
    ro: "Nu sunt metode de plată — plata băncii nu se contabilizează nicăieri.",
    en: "No payment methods yet — the acquirer's fee is counted nowhere.",
  },
  "payment.cash": { ru: "Наличные (без платы банку)", ro: "Numerar (fără plată băncii)", en: "Cash (no fee)" },
  "cooperation.commission": { ru: "процент", ro: "procent", en: "percentage" },
};

export const plainWords: Layer = {
  ...bankFee,

  // The three words the plain view speaks in.
  "pl.contributionMargin": { ru: "Осталось", ro: "Rămâne", en: "Left" },
  "pl.operatingProfit": { ru: "Осталось за месяц", ro: "Rămâne pe lună", en: "Left for the month" },
  "pl.operatingMargin": {
    ru: "Это {rate} от выручки",
    ro: "Adică {rate} din încasări",
    en: "That is {rate} of revenue",
  },
  "services.youKeep.studio": { ru: "Осталось", ro: "Rămâne", en: "Left" },
  "services.youKeep.solo": { ru: "Осталось", ro: "Rămâne", en: "Left" },
  "headline.contribution.current": {
    ru: "Осталось после визитов за месяц",
    ro: "Rămâne după vizite luna aceasta",
    en: "Left after visits this month",
  },
  "headline.contribution.month": {
    ru: "Осталось после визитов за {month}",
    ro: "Rămâne după vizite în {month}",
    en: "Left after visits in {month}",
  },
  "capacity.breakEvenHint": {
    ru: "Выручка, при которой за месяц остаётся ноль, — при нынешних ценах и расходах.",
    ro: "Încasările la care pe lună rămâne zero — la prețurile și cheltuielile de acum.",
    en: "The revenue at which the month leaves nothing — at today's prices and costs.",
  },

  // Capacity and break-even, said as what they are for somebody running a table.
  "capacity.title": { ru: "Загрузка и выход в ноль", ro: "Ocupare și pragul de zero", en: "How full, and breaking even" },
  "capacity.contributionRatio": {
    ru: "Доля выручки, что остаётся после визитов",
    ro: "Partea din încasări care rămâne după vizite",
    en: "Share of revenue left after visits",
  },
  "capacity.breakEven": {
    ru: "Нужно заработать, чтобы выйти в ноль",
    ro: "De încasat ca să ieșiți pe zero",
    en: "Revenue to break even",
  },
  "firstNumbers.lead": {
    ru: "Столько приносит каждая услуга — цена, оплата мастеру и то, что остаётся.",
    ro: "Atât aduce fiecare serviciu — prețul, plata maestrului și ce rămâne.",
    en: "This is what each service brings in — the price, the master's pay and what is left.",
  },

  // The plain view has no practical capacity, so its «Подробнее» does not open on one.
  "capacity.utilizationHint": {
    ru: "Считается от расписания, а не от календаря: если мастер выходит три дня в неделю, остальные четыре — не простой, а просто не рабочее время.",
    ro: "Se calculează din program, nu din calendar: dacă maestrul lucrează trei zile pe săptămână, celelalte patru nu sunt timp nefolosit, ci pur și simplu nu sunt timp de lucru.",
    en: "It is measured against the rota, not the calendar — a master who works three days a week is not idle the other four, those are simply not working hours.",
  },

  // «Комиссия» is a studio's word for what a master is paid; the plain view says so.
  "services.commission.studio": { ru: "Оплата мастеру", ro: "Plata maestrului", en: "Paid to the master" },
  "services.commissionWord.studio": { ru: "оплата мастеру", ro: "plata maestrului", en: "the master's pay" },
  "services.lossWarning": {
    ru: "Услуга работает в минус: оплата мастеру и налоги стоят больше, чем цена.",
    ro: "Serviciul lucrează în pierdere: plata maestrului și taxele costă mai mult decât prețul.",
    en: "This service runs at a loss: the master's pay and taxes cost more than the price.",
  },
  "services.viewContribution": { ru: "Без постоянных расходов", ro: "Fără cheltuieli fixe", en: "Without fixed costs" },
  "specialists.title": { ru: "Мастера и оплата", ro: "Maeștri și plata lor", en: "Specialists and their pay" },
  "specialists.noAccess": {
    ru: "У вашей роли нет доступа к оплате мастеров.",
    ro: "Rolul dvs. nu are acces la plata maeștrilor.",
    en: "Your role has no access to what specialists are paid.",
  },
  "specialists.commission": { ru: "Оплата мастеру", ro: "Plata maestrului", en: "Pay" },
  "specialists.commissionType": { ru: "Как платим", ro: "Cum se plătește", en: "How they are paid" },
  "specialists.defaultRule": { ru: "Оплата по умолчанию", ro: "Plata implicită", en: "Default pay" },
  "specialists.valueRequired": { ru: "Укажите размер оплаты", ro: "Indicați plata", en: "Enter the pay" },
  "specialists.readOnlyNote": {
    ru: "Ваша роль видит только собственный результат и не может менять оплату мастеров.",
    ro: "Rolul dvs. vede doar rezultatul propriu și nu poate schimba plata maeștrilor.",
    en: "Your role sees only its own result and cannot change what specialists are paid.",
  },
  "specialists.isMeHint": {
    ru: "Отметит карточку вашей: визиты и уведомления пойдут на ваш аккаунт, а оплата за ваши визиты останется в прибыли месяца — из бизнеса она не уходит.",
    ro: "Marchează fișa ca fiind a dvs.: vizitele și notificările merg către contul dvs., iar plata pentru vizitele dvs. rămâne în profitul lunii — din afacere ea nu pleacă.",
    en: "Marks the card as yours: visits and notifications go to your account, and the pay for your own visits stays in the month's profit — it never leaves the business.",
  },
  "specialists.withoutRuleBanner": {
    ru: {
      one: "У {count} мастера не задана оплата. Услуги нельзя посчитать: оплата не считается нулевой, пока её не задали.",
      few: "У {count} мастеров не задана оплата. Услуги нельзя посчитать: оплата не считается нулевой, пока её не задали.",
      other: "У {count} мастеров не задана оплата. Услуги нельзя посчитать: оплата не считается нулевой, пока её не задали.",
    },
    ro: {
      one: "{count} maestru nu are plata stabilită. Serviciile nu pot fi calculate: plata nu se consideră zero până nu este stabilită.",
      few: "{count} maeștri nu au plata stabilită. Serviciile nu pot fi calculate: plata nu se consideră zero până nu este stabilită.",
      other: "{count} de maeștri nu au plata stabilită. Serviciile nu pot fi calculate: plata nu se consideră zero până nu este stabilită.",
    },
    en: {
      one: "{count} specialist has no pay set. Services cannot be costed: pay is not treated as zero until it is set.",
      other: "{count} specialists have no pay set. Services cannot be costed: pay is not treated as zero until it is set.",
    },
  },
  "specialists.waitingHint": {
    ru: "Эти люди уже в студии, но их ещё некуда записывать: у мастера должна быть карточка, связанная с аккаунтом. «Добавить как мастера» откроет форму с уже подставленным человеком — останется указать оплату.",
    ro: "Acești oameni sunt deja în studio, dar nu pot fi programați: un maestru are nevoie de o fișă legată de contul lui. «Adaugă ca maestru» deschide formularul cu persoana deja aleasă — rămâne de indicat plata.",
    en: "These people are already in the studio but cannot be booked yet: a master needs a card linked to their account. “Add as a master” opens the form with them already chosen — all that is left is their pay.",
  },
  "closeVisit.noRuleOption": { ru: "оплата не задана", ro: "plata nu este stabilită", en: "no pay set" },
  "closeVisit.noRule": {
    ru: "У выбранного мастера не задана оплата за эту услугу — визит не закроется. Задайте её:",
    ro: "Maestrul ales nu are plata stabilită pentru acest serviciu — vizita nu poate fi finalizată. Stabiliți-o:",
    en: "The chosen specialist has no pay set for this service — the visit will not close. Set it:",
  },
  "closeVisit.needsSetup": {
    ru: "Чтобы закрыть визит, нужны хотя бы одна {service} и один {specialist} с заданной оплатой.",
    ro: "Ca să finalizați o vizită, aveți nevoie de cel puțin un {service} și un {specialist} cu plata stabilită.",
    en: "To close a visit you need at least one {service} and one {specialist} whose pay is set.",
  },
  "onboarding.specialist.studio": { ru: "Мастер и его оплата", ro: "Maestrul și plata lui", en: "A specialist and their pay" },
  "onboarding.specialistHint.studio": {
    ru: "Оплата мастеру — то, из чего считается себестоимость визита. Без неё визит не закрыть.",
    ro: "Plata maestrului este baza costului unei vizite. Fără ea vizita nu poate fi închisă.",
    en: "A specialist's pay is what a visit's cost is worked out from. Without it the visit cannot be closed.",
  },
  "step.goal.specialist.studio": {
    ru: "Добавьте мастера и его оплату",
    ro: "Adăugați un maestru și plata lui",
    en: "Add a specialist and their pay",
  },
  "reason.missing_commission_rule": {
    ru: "у мастера не задана оплата",
    ro: "maestrul nu are plata stabilită",
    en: "the specialist has no pay set",
  },
  "dashboard.commission": { ru: "Оплата мастерам", ro: "Plata maeștrilor", en: "Paid to specialists" },
  "dashboard.marginFormula": {
    ru: "выручка − оплата мастерам, по {visits} посчитанным",
    ro: "încasări − plata maeștrilor, pe {visits} calculate",
    en: "revenue − specialists' pay, over {visits} costed",
  },
  "cash.hint": {
    ru: "Прибыль и деньги — разные вещи, и расходиться они должны. Прибыль считается по начислению: оплата мастеру входит в неё в момент визита, а не когда вы её выплатили. Здесь наоборот — событие это платёж.",
    ro: "Profitul și banii sunt lucruri diferite și este normal să nu coincidă. Profitul se contabilizează pe bază de angajamente: plata maestrului intră în el în momentul vizitei, nu când a fost achitată. Aici este invers — evenimentul este plata.",
    en: "Profit and cash are different things, and they are supposed to differ. Profit is counted as it is earned: the master's pay enters it at the visit, not when it was paid out. Here it is the other way round — the payment is the event.",
  },
  "tax.hint.payroll": {
    ru: "Начисляются на оплату мастеру по этому визиту. Взносы с окладов задаются отдельно, в блоке оплаты труда, — здесь только визитная часть.",
    ro: "Se calculează pe plata maestrului pentru această vizită. Contribuțiile la salarii se setează separat, în blocul plății muncii — aici este doar partea legată de vizite.",
    en: "Charged on the master's pay for this visit. Contributions on salaries are set separately, with the labour costs — this is the per-visit part alone.",
  },
};

export const soloWords: Layer = {
  ...bankFee,

  /*
   * Her rate. A number she may set — zero by default — for what her own hour
   * is worth, so that two services can be compared. Not paid to anybody, so
   * never called a commission.
   */
  "specialists.title": { ru: "Ваша карточка и ставка", ro: "Fișa și cota dvs.", en: "Your card and rate" },
  "specialists.noAccess": {
    ru: "У вашей роли нет доступа к ставкам.",
    ro: "Rolul dvs. nu are acces la cote.",
    en: "Your role has no access to rates.",
  },
  "specialists.commission": { ru: "Ставка за работу", ro: "Cota pentru muncă", en: "Rate for the work" },
  "specialists.commissionType": { ru: "Как считается ставка", ro: "Cum se calculează cota", en: "How the rate works" },
  "specialists.defaultRule": { ru: "Ставка по умолчанию", ro: "Cota implicită", en: "Default rate" },
  "specialists.valueRequired": { ru: "Укажите ставку", ro: "Indicați cota", en: "Enter the rate" },
  "specialists.readOnlyNote": {
    ru: "Ваша роль видит только собственный результат и не может менять ставки.",
    ro: "Rolul dvs. vede doar rezultatul propriu și nu poate schimba cotele.",
    en: "Your role sees only its own result and cannot change rates.",
  },
  "specialists.isMeHint": {
    ru: "Отметит карточку вашей: визиты и уведомления пойдут на ваш аккаунт, а ставка за ваши визиты останется в прибыли месяца — из бизнеса она не уходит.",
    ro: "Marchează fișa ca fiind a dvs.: vizitele și notificările merg către contul dvs., iar cota pentru vizitele dvs. rămâne în profitul lunii — din afacere ea nu pleacă.",
    en: "Marks the card as yours: visits and notifications go to your account, and the rate on your own visits stays in the month's profit — it never leaves the business.",
  },
  "specialists.soloNoPrincipal": {
    ru: "Формат — «Solo-мастер», но ни одна карточка не отмечена владельцем. Пока это так, каждый закрываемый визит считает ставку за вашу работу деньгами, ушедшими из бизнеса, — и отчёт месяца показывает прибыль ниже настоящей. Откройте свою карточку и нажмите «{action}».",
    ro: "Formatul este «Maestru solo», dar nicio fișă nu este marcată ca proprietar. Până atunci fiecare vizită închisă consideră cota pentru munca dvs. bani ieșiți din afacere, iar raportul lunar arată un profit mai mic decât cel real. Deschideți fișa dvs. și apăsați «{action}».",
    en: "The format is “Solo technician”, but no card is marked as the owner. Until one is, every visit you close counts the rate for your work as money that left the business, and the month report shows less profit than there was. Open your own card and press “{action}”.",
  },
  "specialists.withoutRuleBanner": {
    ru: {
      one: "У {count} карточки не задана ставка за работу. Услуги нельзя посчитать, пока её нет, — можно поставить 0 %.",
      few: "У {count} карточек не задана ставка за работу. Услуги нельзя посчитать, пока её нет, — можно поставить 0 %.",
      other: "У {count} карточек не задана ставка за работу. Услуги нельзя посчитать, пока её нет, — можно поставить 0 %.",
    },
    ro: {
      one: "{count} fișă nu are cotă pentru muncă. Serviciile nu pot fi calculate fără ea — se poate pune 0 %.",
      few: "{count} fișe nu au cotă pentru muncă. Serviciile nu pot fi calculate fără ea — se poate pune 0 %.",
      other: "{count} de fișe nu au cotă pentru muncă. Serviciile nu pot fi calculate fără ea — se poate pune 0 %.",
    },
    en: {
      one: "{count} card has no rate for the work. Services cannot be costed without one — 0% will do.",
      other: "{count} cards have no rate for the work. Services cannot be costed without one — 0% will do.",
    },
  },
  "specialists.waitingHint": {
    ru: "Эти люди уже в студии, но их ещё некуда записывать: у мастера должна быть карточка, связанная с аккаунтом. «Добавить как мастера» откроет форму с уже подставленным человеком — останется указать ставку.",
    ro: "Acești oameni sunt deja în studio, dar nu pot fi programați: un maestru are nevoie de o fișă legată de contul lui. «Adaugă ca maestru» deschide formularul cu persoana deja aleasă — rămâne de indicat cota.",
    en: "These people are already in the studio but cannot be booked yet: a master needs a card linked to their account. “Add as a master” opens the form with them already chosen — all that is left is the rate.",
  },
  "closeVisit.noRuleOption": { ru: "ставка не задана", ro: "cota nu este stabilită", en: "no rate set" },
  "closeVisit.noRule": {
    ru: "Для этой услуги не задана ставка за работу — визит не закроется. Задайте её (можно 0 %):",
    ro: "Pentru acest serviciu nu este stabilită cota pentru muncă — vizita nu poate fi finalizată. Stabiliți-o (se poate 0 %):",
    en: "There is no rate for the work on this service — the visit will not close. Set one (0% will do):",
  },
  "closeVisit.needsSetup": {
    ru: "Чтобы закрыть визит, нужны хотя бы одна {service} и ставка за работу у {specialist}.",
    ro: "Ca să finalizați o vizită, aveți nevoie de cel puțin un {service} și de o cotă pentru muncă la {specialist}.",
    en: "To close a visit you need at least one {service} and a rate for the work on the {specialist}.",
  },
  "reason.missing_commission_rule": {
    ru: "не задана ставка за работу",
    ro: "nu este stabilită cota pentru muncă",
    en: "no rate set for the work",
  },
  "firstNumbers.lead": {
    ru: "Столько приносит каждая услуга — цена, расходы на неё и то, что остаётся вам.",
    ro: "Atât aduce fiecare serviciu — prețul, cheltuielile lui și ce vă rămâne.",
    en: "This is what each service brings in — the price, what it costs and what is left to you.",
  },
  "services.lossWarning": {
    ru: "Услуга работает в минус: расходы на неё больше цены.",
    ro: "Serviciul lucrează în pierdere: cheltuielile pe el depășesc prețul.",
    en: "This service runs at a loss: what it costs is more than its price.",
  },
  "services.viewContribution": { ru: "Без постоянных расходов", ro: "Fără cheltuieli fixe", en: "Without fixed costs" },
  "dashboard.commission": { ru: "Ваша работа", ro: "Munca dvs.", en: "Your work" },
  "dashboard.marginFormula": {
    ru: "выручка − расходы визитов, по {visits} посчитанным",
    ro: "încasări − cheltuielile vizitelor, pe {visits} calculate",
    en: "revenue − what the visits cost, over {visits} costed",
  },
  "pl.principalHint.solo": {
    ru: "Ставка по вашим визитам — это стоимость вашего труда: столько вы платили бы мастеру за ту же работу, и без неё услуги не сравнить между собой. Но эти деньги из бизнеса не ушли, поэтому в месяце они возвращаются обратно.",
    ro: "Cota de pe vizitele dvs. este costul muncii dvs.: atât ați plăti unui maestru pentru aceeași muncă, iar fără ea serviciile nu pot fi comparate. Dar acești bani nu au ieșit din afacere, deci în lună se adaugă înapoi.",
    en: "The rate on your own visits is the cost of your work: it is what you would pay a master for the same job, and without it services cannot be compared. But the money never left the business, so the month adds it back.",
  },
  "cash.hint": {
    ru: "Прибыль и деньги — разные вещи, и расходиться они должны. Прибыль считается по начислению: расход визита входит в неё в момент визита, а не когда за него заплатили. Здесь наоборот — событие это платёж.",
    ro: "Profitul și banii sunt lucruri diferite și este normal să nu coincidă. Profitul se contabilizează pe bază de angajamente: costul unei vizite intră în el în momentul vizitei, nu când a fost achitat. Aici este invers — evenimentul este plata.",
    en: "Profit and cash are different things, and they are supposed to differ. Profit is counted as it is earned: what a visit costs enters it at the visit, not when it is paid. Here it is the other way round — the payment is the event.",
  },
  "capacity.rateHint": {
    ru: "Столько должен приносить каждый проданный час, только чтобы закрыть аренду и оклады. Оплата вашего труда сюда не входит: она уже учтена ставкой в каждом визите.",
    ro: "Atât trebuie să aducă fiecare oră vândută doar ca să acopere chiria și salariile. Plata muncii dvs. nu intră aici: este deja inclusă prin cota din fiecare vizită.",
    en: "What every sold hour has to bring in just to cover rent and salaries. Your own pay is not in it: the rate on each visit already accounts for that.",
  },
  "capacity.breakEvenHint": {
    ru: "Выручка, при которой за месяц остаётся ноль, — при нынешних ценах и расходах. Ставка за ваши визиты здесь не вычитается: эти деньги из бизнеса не уходят.",
    ro: "Încasările la care pe lună rămâne zero — la prețurile și cheltuielile de acum. Cota pentru vizitele dvs. nu se scade aici: banii aceia nu ies din afacere.",
    en: "The revenue at which the month leaves nothing — at today's prices and costs. The rate on your own visits is not taken off here: that money never leaves the business.",
  },
  "services.fullyLoadedHint": {
    ru: "Ставка за вашу работу сюда не входит — она уже вычтена выше, и второй раз вычитать её нельзя. Добавлена только доля аренды и окладов: {rate} за час практической мощности по данным за {month}",
    ro: "S-a adăugat partea de chirie și salarii: {rate} pe oră de capacitate practică, după datele din {month}. Cota pentru munca dvs. nu intră aici — a fost deja scăzută mai sus și nu poate fi scăzută a doua oară.",
    en: "A share of rent and salaries has been added: {rate} per hour of practical capacity, from {month}. Your own rate is not in it — it was already taken out above, and it cannot be taken twice.",
  },
  "tax.hint.payroll": {
    ru: "Начисляются на ставку за работу по этому визиту. Взносы с окладов задаются отдельно, в блоке оплаты труда, — здесь только визитная часть.",
    ro: "Se calculează pe cota pentru muncă din această vizită. Contribuțiile la salarii se setează separat, în blocul plății muncii — aici este doar partea legată de vizite.",
    en: "Charged on the rate for the work on this visit. Contributions on salaries are set separately, with the labour costs — this is the per-visit part alone.",
  },
};

/**
 * API error codes, translated on the client by `getErrorMessage`. Only the one
 * whose wording depends on who reads it; every other code means the same to
 * everybody.
 */
type ErrorWords = Readonly<Partial<Record<string, Readonly<Record<AppLocale, string>>>>>;

export const plainErrorWords: ErrorWords = {
  MISSING_COMMISSION_RULE: {
    ru: "У мастера не задана оплата",
    ro: "Maestrul nu are plata stabilită",
    en: "The specialist has no pay set",
  },
};

export const soloErrorWords: ErrorWords = {
  MISSING_COMMISSION_RULE: {
    ru: "Не задана ставка за вашу работу — можно поставить 0 %",
    ro: "Nu este stabilită cota pentru munca dvs. — se poate pune 0 %",
    en: "There is no rate for your work — 0% will do",
  },
};

function layersOf(register: Register) {
  return [!register.detailed && "plain", register.business === "solo" && "solo"].filter(
    (layer): layer is "plain" | "solo" => layer !== false,
  );
}

const tables = new Map<string, Readonly<Record<string, Message>>>();

/**
 * The replacements in force for one register and language, flattened to the
 * dictionary's own shape. Twelve combinations at most, each built once.
 */
export function wordsFor(register: Register, locale: AppLocale): Readonly<Record<string, Message>> {
  const id = `${register.business}:${register.detailed}:${locale}`;
  let table = tables.get(id);
  if (!table) {
    const merged: Record<string, Message> = {};
    for (const layer of layersOf(register)) {
      for (const [key, words] of Object.entries(layer === "plain" ? plainWords : soloWords)) {
        if (words) merged[key] = words[locale];
      }
    }
    table = merged;
    tables.set(id, table);
  }
  return table;
}

export function errorWordFor(code: string, register: Register, locale: AppLocale): string | undefined {
  let word: string | undefined;
  for (const layer of layersOf(register)) {
    word = (layer === "plain" ? plainErrorWords : soloErrorWords)[code]?.[locale] ?? word;
  }
  return word;
}
