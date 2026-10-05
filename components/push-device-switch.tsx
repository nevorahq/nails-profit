"use client";

import { useCallback, useEffect, useState } from "react";

import { useTranslator } from "@/components/lexicon-provider";
import type { AppLocale } from "@/i18n/messages";
import type { MessageKey } from "@/i18n/t";
import {
  currentSubscription,
  enablePush,
  forgetThisDevice,
  pushSupport,
  syncPush,
  testPush,
} from "@/lib/push-device";

/**
 * «Уведомления на этом устройстве: вкл/выкл» and «Проверить», phase 7.
 *
 * The same switch in «Настройки» and at the foot of the bell, because the two
 * are the same question about the same device and must not disagree about the
 * answer. Every state the device can be in is said in words, never as a button
 * that silently does nothing: a browser that refused, an iPhone that has to
 * install the site first, a deployment without push at all.
 *
 * Nothing is asked of the browser until a button is pressed. A permission
 * prompt on page load is the one a person refuses by reflex, and a refusal is
 * very hard for them to find and undo.
 */
type State = "loading" | "server_off" | "unsupported" | "install" | "denied" | "off" | "on";

type Note = Readonly<{ key: MessageKey; tone: "status" | "error" }>;

type ServerStatus = Readonly<{ enabled: boolean; public_key: string | null; devices: number }>;

export function PushDeviceSwitch({
  locale,
  compact = false,
  onChange,
}: Readonly<{
  locale: AppLocale;
  /** The bell's footer: one line and the buttons, no lead paragraph. */
  compact?: boolean;
  /** Told when this device turns on or off, so the bell can drop its hint. */
  onChange?: (on: boolean) => void;
}>) {
  const t = useTranslator(locale);
  const [state, setState] = useState<State>("loading");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const settle = useCallback(
    (next: State) => {
      setState(next);
      if (next === "on" || next === "off") onChange?.(next === "on");
    },
    [onChange],
  );

  useEffect(() => {
    let ignore = false;
    void (async () => {
      const response = await fetch("/api/v1/push/subscription").catch(() => null);
      const body = response?.ok ? ((await response.json()) as { data: ServerStatus }) : null;
      if (ignore) return;
      if (!body?.data.enabled || !body.data.public_key) return settle("server_off");
      setPublicKey(body.data.public_key);

      const support = pushSupport();
      if (support !== "supported") return settle(support);
      if (Notification.permission === "denied") return settle("denied");

      const subscribed = (await currentSubscription()) !== null;
      // Re-sent so a row the server lost comes back; see `syncPush`.
      if (subscribed) void syncPush();
      if (!ignore) settle(subscribed && Notification.permission === "granted" ? "on" : "off");
    })();
    return () => {
      ignore = true;
    };
  }, [settle]);

  async function enable() {
    if (!publicKey) return;
    setBusy(true);
    setNote(null);
    const outcome = await enablePush(publicKey);
    setBusy(false);
    if (outcome === "enabled") {
      settle("on");
      setNote({ key: "pushDevice.enabled", tone: "status" });
    } else if (outcome === "denied") {
      // «default» means the prompt was closed without an answer; only a real
      // refusal locks the switch.
      settle(Notification.permission === "denied" ? "denied" : "off");
      if (Notification.permission !== "denied") setNote({ key: "pushDevice.dismissed", tone: "error" });
    } else if (outcome === "unsupported") {
      settle("unsupported");
    } else {
      setNote({ key: "pushDevice.failed", tone: "error" });
    }
  }

  async function disable() {
    setBusy(true);
    setNote(null);
    await forgetThisDevice();
    setBusy(false);
    settle("off");
  }

  async function test() {
    setBusy(true);
    setNote(null);
    const outcome = await testPush();
    setBusy(false);
    if (outcome === "sent") setNote({ key: "pushDevice.testSent", tone: "status" });
    else if (outcome === "gone") {
      await forgetThisDevice();
      settle("off");
      setNote({ key: "pushDevice.gone", tone: "error" });
    } else setNote({ key: "pushDevice.failed", tone: "error" });
  }

  // The bell has no room for a channel that does not exist here.
  if (compact && (state === "loading" || state === "server_off")) return null;

  const explanation: MessageKey | null =
    state === "loading"
      ? "pushDevice.loading"
      : state === "server_off"
        ? "pushDevice.serverOff"
        : state === "unsupported"
          ? "pushDevice.unsupported"
          : state === "install"
            ? "pushDevice.install"
            : state === "denied"
              ? "pushDevice.denied"
              : null;

  const stateBadge = (state === "on" || state === "off") && (
    <span className={state === "on" ? "push-switch-on" : "push-switch-off"}>
      {t(state === "on" ? "pushDevice.stateOn" : "pushDevice.stateOff")}
    </span>
  );

  const Wrapper = compact ? "div" : "section";
  return (
    <Wrapper
      className={compact ? "push-switch push-switch-compact" : "panel push-switch"}
      id={compact ? undefined : "notifications"}
    >
      {compact ? (
        <p className="push-switch-state">
          <strong>{t("pushDevice.title")}</strong>
          {stateBadge}
        </p>
      ) : (
        <h2 className="push-switch-state">
          {t("pushDevice.title")}
          {stateBadge}
        </h2>
      )}
      {!compact && state !== "loading" && <p className="muted">{t("pushDevice.lead")}</p>}
      {explanation && <p className="muted">{t(explanation)}</p>}

      {(state === "on" || state === "off") && (
        <div className="inline-actions">
          {state === "off" ? (
            <button className="primary-button" type="button" disabled={busy} onClick={enable}>
              {t("pushDevice.enable")}
            </button>
          ) : (
            <>
              <button className="secondary-button" type="button" disabled={busy} onClick={test}>
                {t("pushDevice.test")}
              </button>
              <button className="secondary-button" type="button" disabled={busy} onClick={disable}>
                {t("pushDevice.disable")}
              </button>
            </>
          )}
        </div>
      )}

      {note && (
        <p
          className={note.tone === "error" ? "form-error" : "muted"}
          role={note.tone === "error" ? "alert" : "status"}
        >
          {t(note.key)}
        </p>
      )}
    </Wrapper>
  );
}
