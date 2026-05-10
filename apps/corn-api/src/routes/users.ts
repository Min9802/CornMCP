import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { generateId } from '@corn/shared-utils'
import { User } from '../db/mongoose/index.js'
import { jwtAuthMiddleware, adminOnly, getAuthCtx } from '../middleware/auth.js'

export const usersRouter = new Hono()

// All users routes require JWT + admin
usersRouter.use('*', jwtAuthMiddleware)
usersRouter.use('*', adminOnly)

// ─── List users ─────────────────────────────────────────────
usersRouter.get('/', async (c) => {
  // .lean() returns plain objects; we don't need any User method on the
  // dashboard list view so this avoids the Document hydration cost.
  const docs = await User.find(
    {},
    { _id: 1, email: 1, name: 1, role: 1, is_active: 1, created_at: 1, updated_at: 1 },
  )
    .sort({ created_at: 1 })
    .lean()

  // Preserve the legacy `id` field name expected by the dashboard.
  const users = docs.map((d) => ({
    id: d._id,
    email: d.email,
    name: d.name,
    role: d.role,
    is_active: d.is_active,
    created_at: d.created_at,
    updated_at: d.updated_at,
  }))
  return c.json({ users })
})

// ─── Create user (admin creates for others) ──────────────
usersRouter.post('/', async (c) => {
  const body = await c.req.json()
  const { email, password, name, role = 'user' } = body

  if (!email || !password || !name) {
    return c.json({ error: 'email, password and name are required' }, 400)
  }
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)
  if (!['admin', 'user'].includes(role)) return c.json({ error: 'role must be admin or user' }, 400)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Invalid email format' }, 400)

  const lowercased = (email as string).toLowerCase()
  const existing = await User.findOne({ email: lowercased }, { _id: 1 }).lean()
  if (existing) return c.json({ error: 'Email already registered' }, 409)

  const id = generateId('usr')
  const passwordHash = await bcrypt.hash(password, 12)

  // is_active defaults to true via the schema; no need to pass it.
  await User.create({
    _id: id,
    email: lowercased,
    password_hash: passwordHash,
    name,
    role,
  })

  return c.json({ ok: true, id, email: lowercased, name, role }, 201)
})

// ─── Update user ─────────────────────────────────────────────
usersRouter.put('/:id', async (c) => {
  const { id } = c.req.param()
  const { user: admin } = getAuthCtx(c)
  const body = await c.req.json()

  const existing = await User.findById(id, { _id: 1 }).lean()
  if (!existing) return c.json({ error: 'User not found' }, 404)

  const update: Record<string, unknown> = {}

  if (body.name) update['name'] = body.name
  if (body.role && ['admin', 'user'].includes(body.role)) {
    if (id === admin.id && body.role !== 'admin') {
      return c.json({ error: 'Cannot demote your own account' }, 400)
    }
    update['role'] = body.role
  }
  if (typeof body.isActive === 'boolean') {
    if (id === admin.id && !body.isActive) {
      return c.json({ error: 'Cannot deactivate your own account' }, 400)
    }
    update['is_active'] = body.isActive
  }
  if (body.password) {
    if (body.password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)
    update['password_hash'] = await bcrypt.hash(body.password, 12)
  }

  if (Object.keys(update).length === 0) return c.json({ error: 'No fields to update' }, 400)

  // updated_at is auto-managed by `timestamps: true` on the schema.
  await User.updateOne({ _id: id }, { $set: update })
  return c.json({ ok: true })
})

// ─── Delete user ─────────────────────────────────────────────
usersRouter.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const { user: admin } = getAuthCtx(c)

  if (id === admin.id) return c.json({ error: 'Cannot delete your own account' }, 400)

  // Load the doc first so the document-level cascade middleware
  // (User.pre('deleteOne')) fires and tears down email_otps + api_keys +
  // agent_memories that reference this user.
  const user = await User.findById(id)
  if (!user) return c.json({ error: 'User not found' }, 404)

  await user.deleteOne()
  return c.json({ ok: true })
})
