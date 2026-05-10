// System settings — dynamic key/value config (with secret encryption).
//
// `_id` is the setting key (e.g. `mail.host`, `auth.session_timeout`). Mongo
// reserves `.` and `$` in field paths, but `_id` is a top-level field so
// dotted keys ARE valid here. Verified against MongoDB docs: dots in `_id`
// strings are fine, only nested field paths can't contain them.
//
// Audit: written explicitly by `services/settings.setSetting()` so the
// secret-masking logic (••••<last4>) lives in one place. We deliberately do
// NOT register a `pre('save')` middleware here — the schema would only see
// the encrypted ciphertext and couldn't render a sensible mask.
import { Schema, model, type InferSchemaType } from 'mongoose'

const systemSettingSchema = new Schema(
  {
    _id: { type: String, required: true },
    value: { type: String, default: null },
    is_secret: { type: Boolean, default: false, required: true },
    category: { type: String, default: 'general', required: true, index: true },
    description: { type: String, default: null },
    default_value: { type: String, default: null },
    updated_by: { type: String, default: null },
  },
  {
    collection: 'system_settings',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
    _id: false,
    strict: true,
  },
)

export type SystemSettingDoc = InferSchemaType<typeof systemSettingSchema>
export const SystemSetting = model<SystemSettingDoc>('SystemSetting', systemSettingSchema)
