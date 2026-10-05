import type { MetadataRoute } from "next";

/**
 * What a phone needs to put the studio's app on its home screen.
 *
 * Installing is not a convenience here, it is the condition: an iPhone delivers
 * web push only to a site added to the home screen, and the whole point of the
 * manifest is a master hearing about a request while her hands are busy.
 *
 * Opens on `/app`, the signed-in screens, because nobody installs the landing
 * page. Standalone, so it looks like an application and — on iOS — is allowed
 * to receive notifications. No description: the manifest is one file for every
 * language, and a sentence in the wrong one is worse than none.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: "Nail Profit OS",
    short_name: "Nail Profit",
    start_url: "/app",
    display: "standalone",
    // `--paper` and `--ink` from `app/globals.css`, where the splash and the
    // status bar meet the first screen.
    background_color: "#e3eed4",
    theme_color: "#0f2a1d",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
