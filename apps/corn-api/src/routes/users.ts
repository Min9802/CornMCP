import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { dbAll, dbGet, dbRun } from '../db/client.js'
import { generateId } from '@corn/shared-utils'
import { jwtAuthMiddleware, adminOnly, getAuthCtx } from '../middleware/auth.js'

export const usersRouter = new Hono()

// All users routes require JWT + admin
usersRouter.use('*', jwtAuthMiddleware)
usersRouter.use('*', adminOnly)

// ─── List users ──────────────────────────────────────────
usersRouter.get('/', async (c) => {
  const users = await dbAll(
    'SELECT id, email, name, role, is_active, created_at, updated_at FROM users ORDER BY created_at ASC',
  )
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

  const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()])
  if (existing) return c.json({ error: 'Email already registered' }, 409)

  const id = generateId('usr')
  const passwordHash = await bcrypt.hash(password, 12)

  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
    [id, email.toLowerCase(), passwordHash, name, role],
  )

  return c.json({ ok: true, id, email: email.toLowerCase(), name, role }, 201)
})

// ─── Update user ─────────────────────────────────────────
usersRouter.put('/:id', async (c) => {
  const { id } = c.req.param()
  const { user: admin } = getAuthCtx(c)
  const body = await c.req.json()

  const existing = await dbGet(
    'SELECT id FROM users WHERE id = ?',
    [id],
  )
  if (!existing) return c.json({ error: 'User not found' }, 404)

  const fields: string[] = []
  const values: unknown[] = []

  if (body.name) { fields.push('name = ?'); values.push(body.name) }
  if (body.role && ['admin', 'user'].includes(body.role)) {
    if (id === admin.id && body.role !== 'admin') {
      return c.json({ error: 'Cannot demote your own account' }, 400)
    }
    fields.push('role = ?'); values.push(body.role)
  }
  if (typeof body.isActive === 'boolean') {
    if (id === admin.id && !body.isActive) {
      return c.json({ error: 'Cannot deactivate your own account' }, 400)
    }
    fields.push('is_active = ?')
    values.push(body.isActive ? 1 : 0)
  }
  if (body.password) {
    if (body.password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)
    fields.push('password_hash = ?')
    values.push(await bcrypt.hash(body.password, 12))
  }

  if (fields.length === 0) return c.json({ error: 'No fields to update' }, 400)

  fields.push("updated_at = datetime('now')")
  values.push(id)

  await dbRun(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values)
  return c.json({ ok: true })
})

// ─── Delete user ─────────────────────────────────────────
usersRouter.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const { user: admin } = getAuthCtx(c)

  if (id === admin.id) return c.json({ error: 'Cannot delete your own account' }, 400)

  const existing = await dbGet('SELECT id FROM users WHERE id = ?', [id])
  if (!existing) return c.json({ error: 'User not found' }, 404)

  await dbRun('DELETE FROM users WHERE id = ?', [id])
  return c.json({ ok: true })
})
