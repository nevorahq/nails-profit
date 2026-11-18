import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { displayFont } from "@/app/display-font";
import { PublicBookingFlow } from "@/components/public-booking-flow";
import { loadPublicProfile } from "@/lib/public-booking";
import { loadPublicGallery } from "@/lib/public-gallery";

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
  // Together: the gallery asks its own question of the database, and the page
  // should not wait for the profile before it starts.
  const [profile, gallery] = await Promise.all([loadPublicProfile(slug), loadPublicGallery(slug)]);
  if (!profile) notFound();

  // The Mint headline serif is declared for this subtree only, as on the landing:
  // the application screens never download it.
  return (
    <div className={displayFont.variable}>
      <PublicBookingFlow profile={profile.dto} gallery={gallery} />
    </div>
  );
}
