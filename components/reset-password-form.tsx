"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { authClient } from "@/lib/auth-client";

export function ResetPasswordForm({ token, linkError }: { token?: string; linkError?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The callback redirects here with ?error=INVALID_TOKEN when the link is
  // expired or already used, so there is no point rendering the form at all.
  if (!token || linkError) {
    return (
      <section className="auth-card">
        <Link className="brand" href="/">
          Nail Profit OS
        </Link>
        <h1>Ссылка недействительна</h1>
        <p>Ссылка восстановления истекла или уже была использована. Запросите новую.</p>
        <Link className="primary-button" href="/forgot-password">
          Запросить новую ссылку
        </Link>
      </section>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password"));

    if (password !== String(data.get("passwordConfirmation"))) {
      setError("Пароли не совпадают");
      setPending(false);
      return;
    }

    const result = await authClient.resetPassword({ newPassword: password, token });
    if (result.error) {
      setError(result.error.message ?? "Не удалось изменить пароль");
      setPending(false);
      return;
    }

    router.push("/login");
    router.refresh();
  }

  return (
    <section className="auth-card">
      <Link className="brand" href="/">
        Nail Profit OS
      </Link>
      <h1>Новый пароль</h1>
      <p>Придумайте пароль не короче 10 символов.</p>
      <form onSubmit={submit}>
        <label>
          Новый пароль
          <input name="password" type="password" autoComplete="new-password" required minLength={10} />
        </label>
        <label>
          Повторите пароль
          <input
            name="passwordConfirmation"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? "Сохраняем…" : "Сохранить пароль"}
        </button>
      </form>
    </section>
  );
}
