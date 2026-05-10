// Users + auth core. Mirrors `users` SQL table; cascade middleware below
// fans out delete to every collection that references `user_id`.
//
// `_id` keeps the legacy `usr_<hex>` prefix from generateId() so existing
// JWTs and API key rows continue to resolve. We do NOT auto-cast to
// ObjectId — this is a string PK by design.
import mongoose, { Schema, model, type InferSchemaType } from 'mongoose'

const userSchema = new Schema(
  {
    // generateId('usr') yields `usr-<8 hex>`; legacy rows may still use
    // the `user-<uuid>` shape. Match both.
    _id: { type: String, required: true, match: /^(usr|user)-[0-9a-f-]+$/ },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    // Nullable so OAuth-only accounts (Google) can exist without a password.
    password_hash: { type: String, default: null },
    name: { type: String, required: true, minlength: 1 },
    role: { type: String, enum: ['admin', 'user'], default: 'user', required: true },
    is_active: { type: Boolean, default: true, required: true },
    email_verified: { type: Boolean, default: false, required: true },
    google_id: { type: String, default: null },
    avatar_url: { type: String, default: null },
  },
  {
    collection: 'users',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
    _id: false,
  },
)

// Sparse so multiple OAuth-less users don't collide on null google_id.
userSchema.index({ google_id: 1 }, { unique: true, sparse: true })

// ── Cascade on delete ────────────────────────────────────
// Document middleware: only fires for `user.deleteOne()` (instance), not
// `User.deleteOne(filter)` (query). Caller code that wants the cascade
// must load the doc first then call `.deleteOne()`. See section 11.4 of
// the migration plan.
userSchema.pre('deleteOne', { document: true, query: false }, async function () {
  const userId = this._id
  await Promise.all([
    mongoose.model('EmailOtp').deleteMany({ user_id: userId }),
    mongoose.model('ApiKey').deleteMany({ user_id: userId }),
    mongoose.model('AgentMemory').deleteMany({ user_id: userId }),
  ])
})

export type UserDoc = InferSchemaType<typeof userSchema>
export const User = model<UserDoc>('User', userSchema)
