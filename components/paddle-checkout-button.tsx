"use client";

import { useState } from "react";
import Script from "next/script";

declare global {
  interface Window {
    Paddle?: {
      Initialize: (options: { token: string }) => void;
      Checkout: {
        open: (options: {
          items: { priceId: string; quantity: number }[];
          customData?: Record<string, string>;
        }) => void;
      };
    };
  }
}

/**
 * Paddle Billing has no plain hosted-checkout link the way Lemon Squeezy
 * does — opening a checkout is a call into Paddle.js, so this is the one
 * piece of billing-settings.tsx that has to be a client component.
 */
export function PaddleCheckoutButton({
  clientToken,
  priceId,
  organizationId,
  label,
}: {
  clientToken: string;
  priceId: string;
  organizationId: string;
  label: string;
}) {
  const [ready, setReady] = useState(false);

  return (
    <>
      <Script
        src="https://cdn.paddle.com/paddle/v2/paddle.js"
        onLoad={() => {
          window.Paddle?.Initialize({ token: clientToken });
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
          })
        }
      >
        {label}
      </button>
    </>
  );
}
