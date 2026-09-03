import { describe, expect, it } from "vitest";

import { renderNotificationHtml } from "@/lib/notification-email";

const LINK = "https://booking.example.test/b/abc?token=x&y=1";

const action = {
  label: "Перенести или отменить",
  url: LINK,
  fallbackLabel: "Если кнопка не открывается, скопируйте ссылку:",
};

describe("the HTML half of a transactional email", () => {
  it("puts the action behind a button and repeats it as a copyable link", () => {
    const html = renderNotificationHtml({
      locale: "ru",
      body: "Green Nails: запись на 2 сент. 2026 г., 13:00 подтверждена.",
      action,
    });

    // Once in the button, once in the line below it: a filter that strips the
    // anchor still leaves the client somewhere to go.
    expect(html.match(/href="https:\/\/booking\.example\.test/g)).toHaveLength(2);
    expect(html).toContain("Перенести или отменить");
    expect(html).toContain("Если кнопка не открывается");
    expect(html).toContain('lang="ru-MD"');
  });

  it("escapes every value it is handed", () => {
    const html = renderNotificationHtml({
      locale: "ru",
      body: 'Студия <b>"L\'Atelier"</b> & Co',
      action: { ...action, label: "<script>alert(1)</script>" },
    });

    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; Co");
    // The ampersand inside the URL's query string is an entity too, or the
    // href ends at the first parameter.
    expect(html).toContain("token=x&amp;y=1");
  });

  it("renders the message alone when there is nothing to act on", () => {
    const html = renderNotificationHtml({
      locale: "en",
      body: "Green Nails: your booking confirmation code is 123456.",
      action: null,
    });

    expect(html).toContain("123456");
    expect(html).not.toContain("<a ");
  });

  it("drops a button whose address is not an http(s) one", () => {
    // Never expected from this codebase's own links — it is the guard that
    // keeps a change upstream from turning into a `javascript:` button wearing
    // the studio's name.
    const html = renderNotificationHtml({
      locale: "ru",
      body: "Текст",
      action: { ...action, url: "javascript:alert(1)" },
    });

    expect(html).not.toContain("<a ");
    expect(html).not.toContain("javascript:");
  });
});
