export const supportedLocales = ["ru", "ro", "en"] as const;
export type AppLocale = (typeof supportedLocales)[number];

/**
 * Spec section 12.1: API errors carry a stable `code` plus a localizable UI
 * message. The client translates on the code and only falls back to the
 * server's English `message` for codes it does not know.
 */
export const errorMessages = {
  ru: {
    UNAUTHENTICATED: "Требуется вход в систему",
    VALIDATION_ERROR: "Проверьте заполненные поля",
    MEMBERSHIP_EXISTS: "Вы уже состоите в организации",
    MEMBERSHIP_NOT_FOUND: "Вы пока не состоите ни в одной организации",
    FORBIDDEN: "Недостаточно прав для этого действия",
    ALREADY_MEMBER: "Этот адрес уже состоит в организации",
    INVITATION_PENDING: "Для этого адреса уже есть активное приглашение",
    INVITATION_INVALID: "Приглашение недействительно",
    INVITATION_EXPIRED: "Срок приглашения истёк",
    INVITATION_NOT_PENDING: "Приглашение уже использовано или отозвано",
    INVITATION_EMAIL_MISMATCH: "Приглашение выписано на другой адрес",
    INVITATION_NOT_FOUND: "Активное приглашение не найдено",
    ROLE_NOT_ASSIGNABLE: "Вы не можете выдать эту роль",
  },
  ro: {
    UNAUTHENTICATED: "Este necesară autentificarea",
    VALIDATION_ERROR: "Verificați câmpurile completate",
    MEMBERSHIP_EXISTS: "Faceți deja parte dintr-o organizație",
    MEMBERSHIP_NOT_FOUND: "Încă nu faceți parte din nicio organizație",
    FORBIDDEN: "Drepturi insuficiente pentru această acțiune",
    ALREADY_MEMBER: "Această adresă face deja parte din organizație",
    INVITATION_PENDING: "Există deja o invitație activă pentru această adresă",
    INVITATION_INVALID: "Invitația nu este validă",
    INVITATION_EXPIRED: "Invitația a expirat",
    INVITATION_NOT_PENDING: "Invitația a fost deja folosită sau retrasă",
    INVITATION_EMAIL_MISMATCH: "Invitația a fost emisă pentru altă adresă",
    INVITATION_NOT_FOUND: "Nu a fost găsită nicio invitație activă",
    ROLE_NOT_ASSIGNABLE: "Nu puteți acorda acest rol",
  },
  en: {
    UNAUTHENTICATED: "Authentication is required",
    VALIDATION_ERROR: "Check the fields you filled in",
    MEMBERSHIP_EXISTS: "You already belong to an organization",
    MEMBERSHIP_NOT_FOUND: "You do not belong to an organization yet",
    FORBIDDEN: "You do not have permission for this action",
    ALREADY_MEMBER: "This address already belongs to the organization",
    INVITATION_PENDING: "This address already has a pending invitation",
    INVITATION_INVALID: "The invitation is not valid",
    INVITATION_EXPIRED: "The invitation has expired",
    INVITATION_NOT_PENDING: "The invitation was already used or revoked",
    INVITATION_EMAIL_MISMATCH: "The invitation was issued for a different address",
    INVITATION_NOT_FOUND: "No pending invitation found",
    ROLE_NOT_ASSIGNABLE: "You cannot grant this role",
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

export type ErrorCode = keyof (typeof errorMessages)["en"];

/** Translates a server error code, falling back to the server's own message. */
export function getErrorMessage(code: string, fallback: string, locale: AppLocale = "ru") {
  const table: Record<string, string> = errorMessages[locale] ?? errorMessages.ru;
  return table[code] ?? fallback;
}

export const messages = {
  ru: {
    productName: "Nail Profit OS",
    tagline: "Понимайте прибыль каждой услуги",
    hero: "Реальная себестоимость. Понятная маржа. Прибыль в час.",
    start: "Начать расчёт",
    login: "Войти",
    email: "Email",
    password: "Пароль",
    name: "Ваше имя",
    signUp: "Создать аккаунт",
    workspace: "Создайте рабочее пространство",
  },
  ro: {
    productName: "Nail Profit OS",
    tagline: "Înțelege profitul fiecărui serviciu",
    hero: "Cost real. Marjă clară. Profit pe oră.",
    start: "Începe calculul",
    login: "Autentificare",
    email: "Email",
    password: "Parolă",
    name: "Numele dvs.",
    signUp: "Creează cont",
    workspace: "Creați spațiul de lucru",
  },
  en: {
    productName: "Nail Profit OS",
    tagline: "Understand the profit of every service",
    hero: "Real cost. Clear margin. Profit per hour.",
    start: "Start costing",
    login: "Sign in",
    email: "Email",
    password: "Password",
    name: "Your name",
    signUp: "Create account",
    workspace: "Create your workspace",
  },
} as const;

export function getMessages(locale: string = "ru") {
  return messages[locale as AppLocale] ?? messages.ru;
}
