// One-time codes for email verification / password reset. TTL index on
// `expires_at` auto-cleans expired rows so we don't have to sweep manually.
// Cascade to delete on user removal lives in `user.ts`.
import { Schema, model, type InferSchemaType } from 'mongoose'

const emailOtpSchema = new Schema(
  {
    _id: { type: String, required: true },
    user_id: { type: String, required: true, index: true },
    otp_hash: { type: String, required: true },
    expires_at: { type: Date, required: true },
  },
  {
    collection: 'email_otps',
    timestamps: { createdAt: 'created_at', updatedAt: false },
    versionKey: false,
    _id: false,
  },
)

// MongoDB TTL: when `expires_at` is reached, the doc is purged on the
// next monitor pass (~60s granularity). expireAfterSeconds=0 means use
// the field value as the absolute expiration time.
emailOtpSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 })

export type EmailOtpDoc = InferSchemaType<typeof emailOtpSchema>
export const EmailOtp = model<EmailOtpDoc>('EmailOtp', emailOtpSchema)
