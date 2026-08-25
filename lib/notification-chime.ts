"use client";

let sharedContext: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext })
    .webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedContext) sharedContext = new Ctor();
  return sharedContext;
}

/**
 * Browsers suspend audio until a real gesture has happened somewhere on the
 * page. A poll firing minutes later is not that gesture, so this listens once,
 * broadly, for the first click or keypress — by the time a new request could
 * plausibly land, the context is already unlocked.
 */
export function unlockNotificationChime() {
  const ctx = audioContext();
  if (!ctx) return;

  const resume = () => {
    if (ctx.state === "suspended") void ctx.resume();
  };
  document.addEventListener("pointerdown", resume, { once: true });
  document.addEventListener("keydown", resume, { once: true });
}

/** Two short rising notes — a request landed, not an alarm. */
export function playNotificationChime() {
  const ctx = audioContext();
  if (!ctx || ctx.state === "suspended") return;

  const now = ctx.currentTime;
  for (const [index, frequency] of [660, 880].entries()) {
    const start = now + index * 0.12;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.2, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.2);
  }
}
