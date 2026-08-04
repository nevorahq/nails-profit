export const supportedLocales = ["ru", "ro", "en"] as const;
export type AppLocale = (typeof supportedLocales)[number];

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
