"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function WorkspaceSetup({ name }: { name: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: data.get("name"),
        type: data.get("type"),
        currency: data.get("currency"),
        locale: "ru",
      }),
    });

    if (!response.ok) {
      const payload = await response.json();
      setError(payload.error?.message ?? "Не удалось создать пространство");
      setPending(false);
      return;
    }
    router.refresh();
  }

  return (
    <main className="auth-shell">
      <section className="auth-card workspace-card">
        <span className="eyebrow">Добро пожаловать, {name}</span>
        <h1>Создайте рабочее пространство</h1>
        <form onSubmit={submit}>
          <label>
            Название
            <input name="name" required minLength={2} placeholder="Например, Studio Belle" />
          </label>
          <fieldset>
            <legend>Формат</legend>
            <label className="radio-row"><input type="radio" name="type" value="solo" defaultChecked /> Solo-мастер</label>
            <label className="radio-row"><input type="radio" name="type" value="studio" /> Студия</label>
          </fieldset>
          <label>
            Валюта
            <select name="currency" defaultValue="MDL"><option value="MDL">MDL — молдавский лей</option><option value="EUR">EUR — евро</option></select>
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button" disabled={pending}>{pending ? "Создаём…" : "Продолжить"}</button>
        </form>
      </section>
    </main>
  );
}
