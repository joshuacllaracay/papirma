export interface OutgoingEmail {
  to: string
  subject: string
  text: string
  html: string
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<void>
}

export function createResendMailer(apiKey: string, from: string): Mailer {
  return {
    async send(email) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
      })
      if (!res.ok) throw new Error(`email provider responded ${res.status}`)
    },
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const fmtDate = (d: Date) =>
  d.toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) + ' (PH time)'

export interface InvitationEmailInput {
  to: string
  senderName: string
  documentTitle: string | null
  link: string
  expiresAt: Date
  mode: 'link' | 'password' | 'email_otp'
}

/**
 * Invitation email. Deliberately contains no password, no code and no attachment.
 * Sender-supplied strings are escaped and kept out of the subject's first words
 * so the email can't easily be turned into a phishing template.
 */
export function invitationEmail(i: InvitationEmailInput): OutgoingEmail {
  const what = i.documentTitle ? `“${i.documentTitle}”` : 'a document'
  const modeLine =
    i.mode === 'password'
      ? `${i.senderName} will send you a password separately (not by this email). You will need it to open the document.`
      : i.mode === 'email_otp'
        ? 'For your security, we will email you a one-time code when you open the link.'
        : 'Anyone with this link can open the document, so please do not forward this email.'
  const text = [
    `${i.senderName} has asked you to sign ${what} using Papirma.`,
    '',
    `Open the document: ${i.link}`,
    '',
    modeLine,
    `This link expires on ${fmtDate(i.expiresAt)}.`,
    '',
    'If you were not expecting this, you can ignore this email.',
  ].join('\n')
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#0f172a;line-height:1.5">
<p><strong>${esc(i.senderName)}</strong> has asked you to sign ${esc(what)} using Papirma.</p>
<p><a href="${esc(i.link)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open the document</a></p>
<p>${esc(modeLine)}</p>
<p style="color:#64748b">This link expires on ${esc(fmtDate(i.expiresAt))}. If you were not expecting this, you can ignore this email.</p>
</body></html>`
  return { to: i.to, subject: 'Papirma: signature requested', text, html }
}
