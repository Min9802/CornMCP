// Organizations — multi-tenant container. A default `org-default` row is
// seeded by initSchemas() so single-user deployments work out of the box.
import { Schema, model, type InferSchemaType } from 'mongoose'

const organizationSchema = new Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, minlength: 1 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, default: null },
    // Added by SQLite migration 0001 — owner of the org. Null on the
    // seed `org-default` row so the bootstrap remains shared.
    user_id: { type: String, default: null, index: true },
  },
  {
    collection: 'organizations',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
    _id: false,
  },
)

export type OrganizationDoc = InferSchemaType<typeof organizationSchema>
export const Organization = model<OrganizationDoc>('Organization', organizationSchema)
