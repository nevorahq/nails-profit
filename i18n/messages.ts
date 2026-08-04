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
  },
  ro: {
    UNAUTHENTICATED: "Este necesară autentificarea",
    VALIDATION_ERROR: "Verificați câmpurile completate",
    MEMBERSHIP_EXISTS: "Faceți deja parte dintr-o organizație",
  },
  en: {
    UNAUTHENTICATED: "Authentication is required",
    VALIDATION_ERROR: "Check the fields you filled in",
    MEMBERSHIP_EXISTS: "You already belong to an organization",
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
