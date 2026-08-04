"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

import { authClient } from "@/lib/auth-client";

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const data = new FormData(event.currentTarget);

    await authClient.requestPasswordReset({
      email: String(data.get("email")),
      redirectTo: "/reset-password",
    });

    // Always the same outcome, error or not. Telling the user "no such account"
    // would turn this form into a way of checking who has one.
    setSent(true);
    setPending(false);
  }

  if (sent) {
    return (
      <section className="auth-card">
        <Link className="brand" href="/">
          Nail Profit OS
        </Link>
        <h1>Проверьте почту</h1>
        <p>
          Если такой адрес зарегистрирован, мы отправили на него ссылку для восстановления доступа. Ссылка
          действует один час.
        </p>
        <Link className="switch-button" href="/login">
          Вернуться ко входу
        </Link>
      </section>
    );
  }

  return (
    <section className="auth-card">
      <Link className="brand" href="/">
        Nail Profit OS
      </Link>
      <h1>Восстановление доступа</h1>
      <p>Укажите email, которым вы входите. Мы пришлём ссылку для установки нового пароля.</p>
      <form onSubmit={submit}>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? "Отправляем…" : "Прислать ссылку"}
        </button>
      </form>
      <Link className="switch-button" href="/login">
        Вспомнили пароль? Войти
      </Link>
    </section>
  );
}
