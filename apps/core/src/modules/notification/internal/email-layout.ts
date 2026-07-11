/**
 * Branded, email-client-safe HTML layout for Brain transactional email.
 *
 * Constraints (why it looks the way it does): email clients (Gmail, Outlook,
 * Apple Mail) strip <style>/external CSS and are unreliable with flexbox/grid —
 * so this uses a table-based layout with INLINE styles and a web-safe system
 * font stack only. A plain-text fallback is always sent alongside (SES multipart).
 */

export interface BrainEmailContent {
  /** Preheader — the grey preview snippet shown in the inbox list. */
  preheader: string;
  /** Big heading inside the card. */
  heading: string;
  /** One or two short intro sentences (plain text; rendered as a paragraph). */
  intro: string;
  /** Call-to-action button label. */
  ctaLabel: string;
  /** Call-to-action URL (also shown as a copy-paste fallback link). */
  ctaUrl: string;
  /** Small note under the button (e.g. expiry). */
  note?: string;
  /** Reassurance footer line (e.g. "didn't request this → ignore"). */
  footer: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Wrap content in the Brain email shell. Colors: near-black header (#0B1220),
 * indigo CTA (#4F46E5), neutral greys. Card max-width 480px, centered.
 */
export function renderBrainEmail(c: BrainEmailContent): string {
  const url = esc(c.ctaUrl);
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>${esc(c.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;-webkit-font-smoothing:antialiased;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(c.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;background:#ffffff;border:1px solid #e6e8eb;border-radius:14px;overflow:hidden;">
          <tr>
            <td style="background:#0b1220;padding:26px 40px;">
              <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.5px;">Brain</span>
              <span style="color:#8b95a5;font-size:12px;padding-left:10px;">AI-native commerce OS</span>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 40px 32px;">
              <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#0b1220;font-weight:700;">${esc(c.heading)}</h1>
              <p style="margin:0 0 26px;font-size:15px;line-height:1.6;color:#4a5361;">${esc(c.intro)}</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="border-radius:10px;background:#4f46e5;">
                    <a href="${url}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 30px;font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:10px;">${esc(c.ctaLabel)}</a>
                  </td>
                </tr>
              </table>
              ${c.note ? `<p style="margin:26px 0 0;font-size:13px;line-height:1.6;color:#8b95a5;">${esc(c.note)}</p>` : ''}
              <p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#8b95a5;">If the button doesn't work, copy and paste this link:</p>
              <p style="margin:6px 0 0;font-size:13px;line-height:1.5;word-break:break-all;"><a href="${url}" target="_blank" rel="noopener" style="color:#4f46e5;text-decoration:underline;">${url}</a></p>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 40px;border-top:1px solid #eef0f2;background:#fbfbfc;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#98a2b3;">${esc(c.footer)}</p>
            </td>
          </tr>
        </table>
        <p style="margin:18px 0 0;font-size:11px;line-height:1.5;color:#b0b8c4;">Brain &middot; Capture Truth &rarr; Build Trust &rarr; Enable Decisions</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
