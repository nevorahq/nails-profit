"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

function JoinForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token") ?? "";

  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setPending(true);
    setError(null);
    const response = await fetch("/api/v1/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    setPending(false);
    if (response.ok) {
      setDone(true);
    } else {
      const body = await response.json().catch(() => null);
      const code = body?.error?.code;
      if (code === "UNAUTHENTICATED") {
        router.push(`/login?mode=signup&next=${encodeURIComponent(`/join?token=${token}`)}`);
        return;
      }
      setError(body?.error?.message ?? "Недействительная или истёкшая ссылка");
    }
  }

  if (done) {
    return (
      <div className="auth-card">
        <p style={{ fontWeight: 700, marginBottom: "16rem" }}>
          Вы успешно присоединились к организации
        </p>
        <a className="primary-button" href="/app">
          Перейти в приложение
        </a>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <h1 style={{ fontSize: "22rem", fontWeight: 750, marginBottom: "8rem" }}>
        Принять приглашение
      </h1>
      <p className="muted" style={{ marginBottom: "20rem" }}>
        Вы приглашены присоединиться к организации.
      </p>
      {error && (
        <div className="form-error" role="alert" style={{ marginBottom: "16rem" }}>
          {error}
        </div>
      )}
      {!token ? (
        <p className="muted">Ссылка недействительна — токен отсутствует.</p>
      ) : (
        <button className="primary-button" onClick={accept} disabled={pending} style={{ width: "100%" }}>
          {pending ? "Присоединяемся…" : "Принять и войти"}
        </button>
      )}
      <p className="muted" style={{ marginTop: "16rem", fontSize: "13rem" }}>
        Войдите с тем email, на который было отправлено приглашение.{" "}
        <a href="/login">Войти</a>
      </p>
    </div>
  );
}

export default function JoinPage() {
  return (
    <main className="auth-shell">
      <Suspense>
        <JoinForm />
      </Suspense>
    </main>
  );
}
