import { Hono } from 'hono'
import { dbAll, dbRun } from '../db/client.js'
import { generateId } from '@corn/shared-utils'

export const projectsRouter = new Hono()

projectsRouter.get('/', async (c) => {
  const projects = await dbAll('SELECT * FROM projects ORDER BY created_at DESC')
  return c.json({ projects })
})

projectsRouter.post('/', async (c) => {
  const body = await c.req.json()
  const id = generateId('proj')
  const slug = (body.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')

  await dbRun(
    `INSERT INTO projects (id, org_id, name, slug, description, git_repo_url, git_provider)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.orgId || 'org-default',
      body.name,
      slug,
      body.description || null,
      body.gitRepoUrl || null,
      body.gitProvider || null,
    ],
  )

  return c.json({ ok: true, id })
})

export const orgsRouter = new Hono()

orgsRouter.get('/', async (c) => {
  const orgs = await dbAll('SELECT * FROM organizations ORDER BY created_at DESC')
  return c.json({ organizations: orgs })
})

orgsRouter.post('/', async (c) => {
  const body = await c.req.json()
  const id = generateId('org')
  const slug = (body.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')

  await dbRun(
    `INSERT INTO organizations (id, name, slug, description) VALUES (?, ?, ?, ?)`,
    [id, body.name, slug, body.description || null],
  )

  return c.json({ ok: true, id })
})
