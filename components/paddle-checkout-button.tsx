"use client";

import { useState } from "react";
import Script from "next/script";

declare global {
  interface Window {
    Paddle?: {
      Environment?: { set: (environment: "sandbox" | "production") => void };
      Initialize: (options: { token: string; pwCustomer?: { id: string } }) => void;
      Checkout: {
        open: (options: {
          items: { priceId: string; quantity: number }[];
          customData?: Record<string, string>;
          discountCode?: string;
        }) => void;
      };
    };
  }
}

/**
 * What `Paddle.Initialize()` is given. `pwCustomer` is Paddle Retain's hook: the
 * signed-in customer's *Paddle* customer id (`ctm_…`), never our organization
 * id or an email. It is left out when the studio has no Paddle customer yet —
 * before its first checkout there is no id to give.
 */
export function paddleInitializeOptions(clientToken: string, paddleCustomerId: string | null = null) {
  return paddleCustomerId ? { token: clientToken, pwCustomer: { id: paddleCustomerId } } : { token: clientToken };
}

/**
 * Paddle Billing has no plain hosted-checkout link the way Lemon Squeezy
 * does — opening a checkout is a call into Paddle.js, so this is the one
 * piece of billing-settings.tsx that has to be a client component.
 *
 * `Environment.set('sandbox')` runs only when `environment` is `sandbox` and
 * must come before `Initialize` (Paddle.js reads it there). Live is Paddle.js's
 * default, so the live path calls nothing extra.
 */
export function PaddleCheckoutButton({
  clientToken,
  priceId,
  environment,
  organizationId,
  discountCode = null,
  paddleCustomerId = null,
  label,
}: {
  clientToken: string;
  priceId: string;
  environment: "sandbox" | "live";
  organizationId: string;
  /** Prefilled in the checkout's discount field; the studio can still clear it. */
  discountCode?: string | null;
  /** The studio's Paddle customer id when it has one, for Retain. */
  paddleCustomerId?: string | null;
  label: string;
}) {
  const [ready, setReady] = useState(false);

  return (
    <>
      <Script
        src="https://cdn.paddle.com/paddle/v2/paddle.js"
        onLoad={() => {
          if (environment === "sandbox") window.Paddle?.Environment?.set("sandbox");
          window.Paddle?.Initialize(paddleInitializeOptions(clientToken, paddleCustomerId));
          setReady(true);
        }}
      />
      <button
        className="primary-button"
        type="button"
        disabled={!ready}
        onClick={() =>
          window.Paddle?.Checkout.open({
            items: [{ priceId, quantity: 1 }],
            customData: { organization_id: organizationId },
            ...(discountCode ? { discountCode } : {}),
          })
        }
      >
        {label}
      </button>
    </>
  );
}

/**
 * Loads Paddle.js for a studio that already has a Paddle customer, so Retain
 * (payment recovery, cancellation flows) knows who is looking at the page. No
 * checkout button — the studio is past that.
 */
export function PaddleRetain({
  clientToken,
  environment,
  paddleCustomerId,
}: {
  clientToken: string;
  environment: "sandbox" | "live";
  paddleCustomerId: string;
}) {
  return (
    <Script
      src="https://cdn.paddle.com/paddle/v2/paddle.js"
      onLoad={() => {
        if (environment === "sandbox") window.Paddle?.Environment?.set("sandbox");
        window.Paddle?.Initialize(paddleInitializeOptions(clientToken, paddleCustomerId));
      }}
    />
  );
}
