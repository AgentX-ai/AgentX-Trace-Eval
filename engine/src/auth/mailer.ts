import { promises as fs } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

// Outbound email for AGENTX_AUTH=enabled features (verification, password reset, invitations).
// Transport picked from env, checked in order:
//   AGENTX_EMAIL_DEBUG_DIR  - writes each mail as a JSON file (dev + integration tests)
//   AGENTX_RESEND_API_KEY   - Resend's HTTPS API (no extra dependency)
//   AGENTX_SMTP_URL         - smtp[s]://user:pass@host:port via nodemailer (lazy-imported so
//                             the dependency never loads unless SMTP is actually configured)
// None configured -> mailerConfigured() is false and email-dependent features degrade
// gracefully: verification stays off, invitations remain copy-a-link, reset is hidden.
// AGENTX_EMAIL_FROM sets the sender (default onboarding-style noreply).

export type Mail = { to: string; subject: string; text: string };

export function mailerConfigured(): boolean {
  return !!(
    process.env.AGENTX_EMAIL_DEBUG_DIR ||
    process.env.AGENTX_RESEND_API_KEY ||
    process.env.AGENTX_SMTP_URL
  );
}

function fromAddress(): string {
  return process.env.AGENTX_EMAIL_FROM || "AgentX <noreply@localhost>";
}

export async function sendMail(mail: Mail): Promise<void> {
  const debugDir = process.env.AGENTX_EMAIL_DEBUG_DIR;
  if (debugDir) {
    await fs.mkdir(debugDir, { recursive: true });
    await fs.writeFile(
      path.join(debugDir, `${Date.now()}-${nanoid(6)}.json`),
      JSON.stringify({ from: fromAddress(), ...mail, sentAt: new Date().toISOString() }, null, 2)
    );
    return;
  }

  const resendKey = process.env.AGENTX_RESEND_API_KEY;
  if (resendKey) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromAddress(), to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!response.ok) {
      throw new Error(`Resend rejected the email (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
    }
    return;
  }

  const smtpUrl = process.env.AGENTX_SMTP_URL;
  if (smtpUrl) {
    const { createTransport } = await import("nodemailer");
    const transport = createTransport(smtpUrl);
    await transport.sendMail({ from: fromAddress(), to: mail.to, subject: mail.subject, text: mail.text });
    return;
  }

  throw new Error("No mailer configured (set AGENTX_RESEND_API_KEY, AGENTX_SMTP_URL, or AGENTX_EMAIL_DEBUG_DIR)");
}

// Fire-and-forget wrapper for paths where a mail failure must not fail the request (an
// invitation still returns its link; a signup still succeeds). Errors land in the log.
export function sendMailInBackground(mail: Mail): void {
  void sendMail(mail).catch(err => {
    console.error(`Email to ${mail.to} failed:`, err instanceof Error ? err.message : err);
  });
}
