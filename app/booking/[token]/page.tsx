import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { displayFont } from "@/app/display-font";
import { PublicBookingManage } from "@/components/public-booking-manage";
import { loadPublicBookingAccess } from "@/lib/public-booking-access";

export const metadata: Metadata = {
  title: "Manage appointment — Nail Profit OS",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function BookingManagePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const access = await loadPublicBookingAccess(token);
  if (!access) notFound();
  return (
    <div className={displayFont.variable}>
      <PublicBookingManage token={token} initial={access.dto} />
    </div>
  );
}
