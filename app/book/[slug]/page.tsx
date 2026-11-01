import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { displayFont } from "@/app/display-font";
import { PublicBookingFlow } from "@/components/public-booking-flow";
import { loadPublicProfile } from "@/lib/public-booking";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const profile = await loadPublicProfile(slug);
  return profile
    ? { title: `${profile.dto.name} — Online booking`, robots: { index: true, follow: true } }
    : { title: "Online booking", robots: { index: false, follow: false } };
}

export default async function PublicBookingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const profile = await loadPublicProfile(slug);
  if (!profile) notFound();

  // The Mint headline serif is declared for this subtree only, as on the landing:
  // the application screens never download it.
  return (
    <div className={displayFont.variable}>
      <PublicBookingFlow profile={profile.dto} />
    </div>
  );
}
