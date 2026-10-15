import { LandingExperience } from "@/components/landing-experience";
import { getSupportEmail } from "@/env";
import { resolveLocale } from "@/lib/locale";

export default async function HomePage() {
  return <LandingExperience locale={await resolveLocale()} supportEmail={getSupportEmail()} />;
}
