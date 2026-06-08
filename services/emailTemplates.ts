/**
 * Shared email chrome + building blocks for every transactional email.
 *
 * Matches the WebSoroban frontend: deep-space dark canvas, a single electric-iris
 * accent, restraint over neon. All styles are inlined (email clients strip <style>),
 * everything is table-based for Outlook, and the palette is the dark-mode token set
 * from the app (see web-soroban/app/globals.css).
 */

const FRONTEND = process.env.FRONTEND_URL || 'https://websoroban.in';

// Dark-mode brand tokens resolved to hex (HSL → hex from globals.css).
export const C = {
  canvas: '#0A0B12',     // --background 234 32% 5%
  card: '#0F111A',       // --card 233 26% 8%
  inset: '#0C0E15',      // slightly darker than card for nested panels
  border: '#23252F',     // --border 233 16% 16%
  borderSoft: '#1A1C24', // hairline dividers
  fg: '#F2F4F8',         // --foreground 220 18% 96%
  muted: '#9299AB',      // --muted-foreground 224 12% 62%
  brand: '#775EF3',      // --brand 250 86% 66% (electric iris)
  cosmic: '#BF65EC',     // --cosmic 280 78% 66%
  success: '#33C17F',    // --success 152 58% 48%
  warning: '#F9B339',    // --warning 38 94% 60%
  white: '#FFFFFF',
};

const FONT = "'Geist','Geist Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'Geist Mono','SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";

export interface ShellOptions {
  /** Hidden inbox preview text. */
  preheader: string;
  /** Small uppercase label above the title. */
  eyebrow: string;
  /** Main heading. */
  title: string;
  /** Pre-rendered body HTML (compose with the helpers below). */
  inner: string;
}

/** Wrap body HTML in the branded dark shell (header wordmark, accent line, footer). */
export function emailShell({ preheader, eyebrow, title, inner }: ShellOptions): string {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${C.canvas};-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.canvas};font-size:1px;line-height:1px;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.canvas};">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;background:${C.card};border:1px solid ${C.border};border-radius:16px;overflow:hidden;">
          <tr>
            <td style="height:3px;line-height:3px;font-size:0;background:linear-gradient(90deg,${C.brand},${C.cosmic});">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:28px 36px 0 36px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <span style="display:inline-block;width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,${C.brand},${C.cosmic});"></span>
                  </td>
                  <td style="vertical-align:middle;padding-left:10px;">
                    <span style="font-family:${FONT};font-size:17px;font-weight:600;letter-spacing:-0.02em;color:${C.fg};">WebSoroban</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 36px 0 36px;">
              <p style="margin:0 0 10px 0;font-family:${FONT};font-size:12px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:${C.brand};">${eyebrow}</p>
              <h1 style="margin:0;font-family:${FONT};font-size:23px;line-height:1.28;font-weight:600;letter-spacing:-0.02em;color:${C.fg};">${title}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 36px 6px 36px;">${inner}</td>
          </tr>
          <tr>
            <td style="padding:26px 36px 30px 36px;border-top:1px solid ${C.borderSoft};">
              <p style="margin:0 0 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">
                <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${C.success};vertical-align:middle;margin-right:7px;"></span>
                Stellar Testnet — no real funds are ever used.
              </p>
              <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">
                <a href="${FRONTEND}/ide" style="color:${C.muted};text-decoration:underline;">Open the IDE</a>
                &nbsp;·&nbsp;
                <a href="mailto:support@websoroban.in" style="color:${C.muted};text-decoration:underline;">support@websoroban.in</a>
              </p>
              <p style="margin:14px 0 0 0;font-family:${FONT};font-size:11px;line-height:1.5;color:${C.muted};">© ${year} WebSoroban · A browser IDE for Stellar smart contracts.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Body paragraph. */
export function p(text: string): string {
  return `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:1.65;color:${C.fg};opacity:0.88;">${text}</p>`;
}

/** Small muted note (fine print, secondary instructions). */
export function note(text: string): string {
  return `<p style="margin:0 0 10px 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${C.muted};">${text}</p>`;
}

/** Gradient call-to-action button. */
export function ctaButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px 0;">
    <tr>
      <td style="border-radius:10px;background:linear-gradient(135deg,${C.brand},${C.cosmic});">
        <a href="${href}" style="display:inline-block;padding:13px 24px;font-family:${FONT};font-size:14px;font-weight:600;letter-spacing:-0.01em;color:${C.white};text-decoration:none;border-radius:10px;">${label} &rarr;</a>
      </td>
    </tr>
  </table>`;
}

/** A monospaced highlight block — used for the invite code. */
export function codeBlock(label: string, code: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 22px 0;background:${C.inset};border:1px solid ${C.border};border-radius:12px;">
    <tr>
      <td align="center" style="padding:26px 18px;">
        <p style="margin:0 0 12px 0;font-family:${FONT};font-size:11px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:${C.muted};">${label}</p>
        <p style="margin:0;font-family:${MONO};font-size:30px;font-weight:600;letter-spacing:0.18em;color:${C.fg};">${code}</p>
      </td>
    </tr>
  </table>`;
}

export interface DetailRow {
  label: string;
  value: string;
  mono?: boolean;
}

/** A key/value detail panel with hairline dividers. */
export function detailCard(rows: DetailRow[]): string {
  const last = rows.length - 1;
  const body = rows
    .map((r, i) => {
      const bb = i === last ? '' : `border-bottom:1px solid ${C.borderSoft};`;
      return `<tr>
        <td style="padding:11px 0;${bb}font-family:${FONT};font-size:13px;color:${C.muted};vertical-align:top;white-space:nowrap;">${r.label}</td>
        <td style="padding:11px 0 11px 16px;${bb}font-family:${r.mono ? MONO : FONT};font-size:13px;color:${C.fg};text-align:right;vertical-align:top;word-break:break-all;">${r.value}</td>
      </tr>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 20px 0;background:${C.inset};border:1px solid ${C.border};border-radius:12px;">
    <tr>
      <td style="padding:4px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table>
      </td>
    </tr>
  </table>`;
}

/** A bulleted list with brand-dot markers. */
export function bullets(items: string[]): string {
  const li = items
    .map(
      (t) => `<tr>
      <td style="vertical-align:top;padding:6px 11px 6px 0;"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${C.brand};"></span></td>
      <td style="vertical-align:top;padding:3px 0;font-family:${FONT};font-size:14px;line-height:1.5;color:${C.fg};opacity:0.88;">${t}</td>
    </tr>`,
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:2px 0 20px 0;">${li}</table>`;
}

/** Plain-text footer shared by every text email. */
export function textFooter(): string {
  return `\n—\nStellar Testnet — no real funds are ever used.\nOpen the IDE: ${FRONTEND}/ide\nSupport: support@websoroban.in\n© ${new Date().getFullYear()} WebSoroban`;
}

export { FRONTEND };
