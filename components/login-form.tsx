"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { authClient } from "@/lib/auth-client";

export function LoginForm({ initialMode = "signin" }: { initialMode?: "signin" | "signup" }) {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">(initialMode);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email"));
    const password = String(data.get("password"));

    const result =
      mode === "signup"
        ? await authClient.signUp.email({
            email,
            password,
            name: String(data.get("name")),
            callbackURL: "/app",
          })
        : await authClient.signIn.email({ email, password, callbackURL: "/app" });

    if (result.error) {
      setError(result.error.message ?? "Не удалось выполнить вход");
      setPending(false);
      return;
    }
    router.push("/app");
    router.refresh();
  }

  return (
    <section className="auth-card">
      <Link className="brand" href="/">
        Nail Profit OS
      </Link>
      <h1>{mode === "signup" ? "Создать аккаунт" : "С возвращением"}</h1>
      <p>Ваш profit layer поверх существующей системы записи.</p>
      <form onSubmit={submit}>
        {mode === "signup" && (
          <label>
            Ваше имя
            <input name="name" autoComplete="name" required minLength={2} />
          </label>
        )}
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Пароль
          <input name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required minLength={10} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? "Подождите…" : mode === "signup" ? "Создать аккаунт" : "Войти"}
        </button>
      </form>
      <button className="switch-button" type="button" onClick={() => setMode(mode === "signup" ? "signin" : "signup")}>
        {mode === "signup" ? "Уже есть аккаунт? Войти" : "Нет аккаунта? Создать"}
      </button>
    </section>
  );
}
