// Organizations — multi-tenant container. Every org must be owned by a user;
// the legacy shared `org-default` seed has been removed to prevent cross-tenant
// scope leakage. New users get an org auto-provisioned on first project create
// or explicitly via POST /api/orgs.
import { Schema, model, type InferSchemaType } from 'mongoose'

const organizationSchema = new Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, minlength: 1 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, default: null },
    // Owner of the org. Default null is kept for migration compatibility; new
    // rows MUST set user_id explicitly via the create routes.
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
