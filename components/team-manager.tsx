"use client";

import { useState, useRef, type FormEvent } from "react";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";

export type TeamMember = {
  user_id: string;
  email: string;
  role: string;
};

type Step = "idle" | "link-ready" | "sent";

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
  const formRef = useRef<HTMLFormElement>(null);

  const [step, setStep] = useState<Step>("idle");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [invitedEmail, setInvitedEmail] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setStep("idle");
    setError(null);
    setInviteToken(null);
    setInviteLink(null);
    setInvitedEmail(null);
    setCopied(false);
    formRef.current?.reset();
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = event.currentTarget;
    const data = new FormData(form);
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

    const body = (await response.json()) as { data: { token: string; email: string } };
    const link = `${window.location.origin}/join?token=${encodeURIComponent(body.data.token)}`;
    setInviteToken(body.data.token);
    setInviteLink(link);
    setInvitedEmail(body.data.email);
    setStep("link-ready");
  }

  async function send() {
    if (!inviteToken) return;
    setPending(true);
    setError(null);

    const response = await fetch("/api/v1/invitations/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: inviteToken }),
    });

    setPending(false);

    if (!response.ok) {
      setError(t("team.sendFailed"));
      return;
    }

    setStep("sent");
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

          <form className="inline-form" ref={formRef} onSubmit={generate}>
            <label>
              {t("team.inviteEmail")}
              <input
                name="email"
                type="email"
                required
                placeholder="master@example.com"
                readOnly={step === "link-ready"}
              />
            </label>
            <label>
              {t("team.inviteRole")}
              <select name="role" defaultValue="master" disabled={step === "link-ready"}>
                <option value="master">{t("roles.master")}</option>
                <option value="manager">{t("roles.manager")}</option>
                <option value="analyst">{t("roles.analyst")}</option>
              </select>
            </label>

            {step !== "link-ready" ? (
              <button className="primary-button" type="submit" disabled={pending}>
                {pending ? t("common.saving") : t("team.generateLink")}
              </button>
            ) : (
              <div style={{ display: "flex", gap: "8rem" }}>
                <button
                  className="primary-button"
                  type="button"
                  onClick={send}
                  disabled={pending}
                >
                  {pending ? t("common.saving") : t("team.inviteButton")}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={reset}
                  disabled={pending}
                >
                  ✕
                </button>
              </div>
            )}
          </form>

          {step === "link-ready" && inviteLink && (
            <div style={{ marginTop: "16rem" }}>
              <p className="muted" style={{ fontSize: "13rem", marginBottom: "8rem" }}>
                {t("team.linkHint")}
              </p>
              <div
                style={{
                  display: "flex",
                  gap: "8rem",
                  alignItems: "center",
                }}
              >
                <code
                  style={{
                    flex: 1,
                    padding: "8rem 12rem",
                    background: "var(--surface-strong)",
                    borderRadius: "8rem",
                    fontSize: "12rem",
                    wordBreak: "break-all",
                    lineHeight: 1.5,
                  }}
                >
                  {inviteLink}
                </code>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={copy}
                  title={t("team.copyLink")}
                  style={{ flexShrink: 0, padding: "8rem 10rem" }}
                >
                  {copied ? (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M2 8l4 4 8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-7A1.5 1.5 0 001 3.5v7A1.5 1.5 0 002.5 12H4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          )}

          {step === "sent" && invitedEmail && (
            <div className="panel" style={{ marginTop: "16rem" }}>
              <p style={{ fontWeight: 700, marginBottom: "8rem" }}>
                ✓ {t("team.inviteSent", { email: invitedEmail })}
              </p>
              <p className="muted" style={{ fontSize: "13rem", marginBottom: "12rem" }}>
                {t("team.inviteHint")}
              </p>
              <button
                className="secondary-button"
                type="button"
                onClick={reset}
                style={{ fontSize: "13rem" }}
              >
                {t("team.generateLink")}
              </button>
            </div>
          )}

          {error && (
            <div className="form-error" role="alert" style={{ marginTop: "12rem" }}>
              {error}
            </div>
          )}
        </>
      )}
    </section>
  );
}
