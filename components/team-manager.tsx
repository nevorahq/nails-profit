"use client";

import { useState, type FormEvent } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";

export type TeamMember = {
  user_id: string;
  email: string;
  role: string;
};

export function TeamManager({
  members,
  canManage,
  locale,
}: {
  members: TeamMember[];
  canManage: boolean;
  locale: AppLocale;
}) {
  const t = getTranslator(locale);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setInviteLink(null);

    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: data.get("email"),
        role: data.get("role"),
      }),
    });

    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error?.message ?? t("team.inviteFailed"));
      return;
    }

    const body = (await response.json()) as { data: { token: string } };
    const link = `${window.location.origin}/join?token=${encodeURIComponent(body.data.token)}`;
    setInviteLink(link);
  }

  async function copy() {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="panel">
      <h2>{t("team.membersTitle")}</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>{t("team.inviteRole")}</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.user_id}>
              <td>{m.email}</td>
              <td>{t(`roles.${m.role}` as MessageKey)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {!canManage && (
        <p className="muted" style={{ marginTop: "16rem" }}>
          {t("team.noAccess")}
        </p>
      )}

      {canManage && (
        <>
          <h2 style={{ marginTop: "28rem" }}>{t("team.inviteTitle")}</h2>
          <form className="inline-form" onSubmit={invite}>
            <label>
              {t("team.inviteEmail")}
              <input name="email" type="email" required placeholder="master@example.com" />
            </label>
            <label>
              {t("team.inviteRole")}
              <select name="role" defaultValue="master">
                <option value="master">{t("roles.master")}</option>
                <option value="manager">{t("roles.manager")}</option>
                <option value="analyst">{t("roles.analyst")}</option>
              </select>
            </label>
            <button className="primary-button" type="submit" disabled={pending}>
              {pending ? t("common.saving") : t("team.inviteButton")}
            </button>
          </form>

          {error && (
            <div className="form-error" role="alert" style={{ marginTop: "12rem" }}>
              {error}
            </div>
          )}

          {inviteLink && (
            <div className="panel" style={{ marginTop: "16rem" }}>
              <p style={{ fontWeight: 700, marginBottom: "8rem" }}>{t("team.inviteLink")}</p>
              <p className="muted" style={{ marginBottom: "12rem", fontSize: "13rem" }}>
                {t("team.inviteHint")}
              </p>
              <div style={{ display: "flex", gap: "10rem", alignItems: "center", flexWrap: "wrap" }}>
                <code
                  style={{
                    flex: 1,
                    padding: "8rem 12rem",
                    background: "var(--surface-strong)",
                    borderRadius: "8rem",
                    fontSize: "13rem",
                    wordBreak: "break-all",
                  }}
                >
                  {inviteLink}
                </code>
                <button className="secondary-button" type="button" onClick={copy}>
                  {copied ? t("team.copied") : t("team.copyLink")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
