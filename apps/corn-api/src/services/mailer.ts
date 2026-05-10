import nodemailer from 'nodemailer'
import { createLogger } from '@corn/shared-utils'
import { getSetting } from './settings.js'

const logger = createLogger('mailer')

// S2.3 — every config knob below now goes through `getSetting()` so admin
// edits in the dashboard take effect on the next call (TTL-bounded, no
// process restart). The env-var names are kept as `fallbackEnv` so an
// unconfigured fresh deploy still works against legacy `.env`.
async function createTransport(): Promise<nodemailer.Transporter | null> {
  const host = await getSetting('mail.host', 'MAIL_HOST')
  const portStr = (await getSetting('mail.port', 'MAIL_PORT')) ?? '587'
  const port = Number(portStr) || 587
  const user = await getSetting('mail.username', 'MAIL_USERNAME')
  const pass = await getSetting('mail.password', 'MAIL_PASSWORD')

  if (!host || !user || !pass) {
    logger.warn('mail.* settings not configured — emails will be logged to console')
    return null
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  })
}

// Transporter recreation policy: do NOT cache at module scope. Each send
// rebuilds the transport via the (TTL-cached) settings layer, so any admin
// edit takes effect on the next email without a per-mailer cache invalidation
// hook. This is fine for OTP-frequency traffic; high-volume mail would want
// a setting-version-keyed cache here.
export async function sendOtpEmail(to: string, otp: string): Promise<boolean> {
  const appName = (await getSetting('mail.app_name', 'APP_NAME')) || 'CornMCP'
  const fromAddrSetting = await getSetting('mail.from_address', 'MAIL_FROM_ADDRESS')
  const userSetting = await getSetting('mail.username', 'MAIL_USERNAME')
  const fromAddr = fromAddrSetting || userSetting || 'noreply@cornmcp.com'
  const fromNameRaw = (await getSetting('mail.from_name', 'MAIL_FROM_NAME')) || appName
  const fromName = fromNameRaw.replace('${APP_NAME}', appName)

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f0f23;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:40px auto;background:#1a1a2e;border-radius:16px;border:1px solid rgba(255,255,255,0.08);overflow:hidden;">
    <div style="padding:32px 32px 24px;text-align:center;background:linear-gradient(135deg,rgba(251,191,36,0.1),rgba(59,130,246,0.1));">
      <div style="font-size:48px;margin-bottom:8px;">🌽</div>
      <h1 style="color:#fbbf24;font-size:24px;margin:0;">${appName}</h1>
    </div>
    <div style="padding:32px;">
      <p style="color:#e2e8f0;font-size:16px;margin:0 0 24px;text-align:center;">Your verification code is:</p>
      <div style="background:rgba(0,0,0,0.3);border-radius:12px;padding:24px;text-align:center;border:1px solid rgba(251,191,36,0.2);margin-bottom:24px;">
        <span style="font-size:36px;font-weight:800;letter-spacing:12px;color:#fbbf24;font-family:monospace;">${otp}</span>
      </div>
      <p style="color:#94a3b8;font-size:13px;text-align:center;margin:0 0 8px;">This code expires in <strong style="color:#e2e8f0;">10 minutes</strong>.</p>
      <p style="color:#64748b;font-size:12px;text-align:center;margin:0;">If you didn't request this, you can safely ignore this email.</p>
    </div>
    <div style="padding:16px 32px;background:rgba(0,0,0,0.2);text-align:center;">
      <p style="color:#475569;font-size:11px;margin:0;">&copy; ${new Date().getFullYear()} ${appName} — AI Agent Intelligence Platform</p>
    </div>
  </div>
</body>
</html>`

  const transport = await createTransport()

  if (!transport) {
    logger.info(`[DEV] OTP for ${to}: ${otp}`)
    return true
  }

  try {
    await transport.sendMail({
      from: `"${fromName}" <${fromAddr}>`,
      to,
      subject: `${otp} — ${appName} Verification Code`,
      html,
    })
    logger.info(`OTP email sent to ${to}`)
    return true
  } catch (err) {
    logger.error(`Failed to send OTP email to ${to}:`, err)
    return false
  }
}
