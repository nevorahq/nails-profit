import { LandingExperience } from "@/components/landing-experience";
import { getSupportEmail } from "@/env";
import { resolveLocale } from "@/lib/locale";

import { displayFont } from "./display-font";

export default async function HomePage() {
  return (
    <LandingExperience
      locale={await resolveLocale()}
      supportEmail={getSupportEmail()}
      displayFont={displayFont.variable}
    />
  );
}
