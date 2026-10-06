import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { emptyKeys, SectionEmpty, type EmptySection } from "@/components/section-empty";
import { dictionaries } from "@/i18n/dictionary";
import { getTranslator } from "@/i18n/t";

const sections = Object.keys(emptyKeys) as EmptySection[];
const t = getTranslator("ru");

function render(section: EmptySection, businessType: "solo" | "studio", action?: { href: string }) {
  return renderToStaticMarkup(createElement(SectionEmpty, { section, businessType, t, action }));
}

describe("SectionEmpty", () => {
  it.each(sections)("%s: says why the section exists, and differently to a solo master and a studio", (section) => {
    const solo = render(section, "solo");
    const studio = render(section, "studio");
    expect(solo).toContain(dictionaries.ru[emptyKeys[section].lead.solo] as string);
    expect(studio).toContain(dictionaries.ru[emptyKeys[section].lead.studio] as string);
    expect(solo).not.toEqual(studio);
  });

  it.each(sections)("%s: offers no button to a role that cannot take the first step", (section) => {
    expect(render(section, "studio")).not.toContain("<a ");
  });

  it("points an #anchor action at the page's own add panel", () => {
    const html = render("clients", "studio", { href: "#add-client" });
    expect(html).toContain('href="#add-client"');
    expect(html).toContain(dictionaries.ru["empty.clients.action"] as string);
  });

  it("links a route action as a page", () => {
    const html = render("visits", "solo", { href: "/app/visits/new" });
    expect(html).toContain('href="/app/visits/new"');
  });
});
