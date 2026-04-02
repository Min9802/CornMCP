import nodemailer from 'nodemailer'
import { createLogger } from '@corn/shared-utils'

const logger = createLogger('mailer')

function createTransport() {
  const host = process.env['MAIL_HOST']
  const port = Number(process.env['MAIL_PORT'] || 587)
  const user = process.env['MAIL_USERNAME']
  const pass = process.env['MAIL_PASSWORD']

  if (!host || !user || !pass) {
    logger.warn('MAIL_* env vars not configured — emails will be logged to console')
    return null
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  })
}

let transporter: nodemailer.Transporter | null = null

function getTransporter() {
  if (!transporter) transporter = createTransport()
  return transporter
}

export async function sendOtpEmail(to: string, otp: string): Promise<boolean> {
  const appName = process.env['APP_NAME'] || 'CornMCP'
  const fromAddr = process.env['MAIL_FROM_ADDRESS'] || process.env['MAIL_USERNAME'] || 'noreply@cornmcp.com'
  const fromName = (process.env['MAIL_FROM_NAME'] || appName).replace('${APP_NAME}', appName)

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

  const transport = getTransporter()

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
