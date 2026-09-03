import type { AppLocale } from "@/i18n/messages";
import { localeTag } from "@/i18n/translate";

/**
 * The HTML half of a transactional email.
 *
 * Deliberately one paragraph, one button and the bare link underneath — every
 * element on the page is one more thing to render wrong in a client nobody
 * here can test against. Outlook composes with Word's engine (no flexbox, no
 * grid, no `padding` on an `<a>`), Gmail strips `<style>` blocks, and both
 * ignore anything loaded from elsewhere. So: tables, inline styles, no images,
 * no web fonts, no external CSS.
 *
 * The bare link is not a decoration. Corporate filters rewrite or remove
 * anchors, and a message whose only way forward was the button becomes a dead
 * end for exactly the clients least able to ask why.
 */

export type EmailAction = Readonly<{
  /** The button's words — a verb, from the message catalogue. */
  label: string;
  url: string;
  /** Introduces the copyable link for whoever the button failed. */
  fallbackLabel: string;
}>;

export type EmailContent = Readonly<{
  locale: AppLocale;
  body: string;
  action: EmailAction | null;
}>;

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Every interpolated value — a studio's name, a master's name, a link — is
 * typed by a person somewhere. Escaped for the same reason any other template
 * escapes: an apostrophe in "L'Atelier" must not end an attribute.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Only an absolute http(s) address becomes a button. Every link this codebase
 * puts in a message is one it built itself, so this is not expected to fire —
 * it is here so that the day one is built from something else, the failure is
 * a missing button rather than a `javascript:` link with the studio's name on
 * it.
 */
function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function button(action: EmailAction): string {
  const href = escapeHtml(action.url);
  return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
          <tr>
            <td align="center" bgcolor="#1c1917" style="border-radius:8px;">
              <a href="${href}" style="display:inline-block;padding:14px 28px;font-family:${FONT_STACK};font-size:16px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(action.label)}</a>
            </td>
          </tr>
        </table>
        <p style="margin:0;font-family:${FONT_STACK};font-size:13px;line-height:1.5;color:#78716c;">
          ${escapeHtml(action.fallbackLabel)}<br />
          <a href="${href}" style="color:#78716c;word-break:break-all;">${href}</a>
        </p>`;
}

/**
 * `color-scheme` is what stops a client from inverting a light card into
 * something with white text on white; the explicit `background` on every
 * container is what stops the rest of them.
 */
export function renderNotificationHtml(content: EmailContent): string {
  const action = content.action && isSafeUrl(content.action.url) ? content.action : null;

  return `<!doctype html>
<html lang="${escapeHtml(localeTag(content.locale))}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
</head>
<body style="margin:0;padding:0;background-color:#f5f5f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f5f4;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:12px;">
        <tr>
          <td style="padding:32px 28px;">
            <p style="margin:0 0 24px;font-family:${FONT_STACK};font-size:16px;line-height:1.6;color:#1c1917;">${escapeHtml(content.body)}</p>${action ? button(action) : ""}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
