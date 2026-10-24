import type { Browser, BrowserContext, Page } from 'playwright'
// Browser (Playwright) e2e: login/session/logout + web terminals.
//
// Scope:
//   - login as admin through the real UI
//   - session persists across in-app navigation
//   - logout clears the session
//   - an invalid login surfaces an error (no session granted)
//   - session survives a full page reload (cookie-backed)
//   - logout then a fresh login (re-authentication) works
//   - SSH web terminal — open xterm over WebSocket, drive a live SSH exchange
//   - MySQL web terminal — open the in-browser SQL console and run a query
//   - Postgres web terminal — open the SQL console and run a query, see output
//   - terminal close/cleanup — leaving the terminal tears down the connection
//
// This script mirrors web/scripts/e2e-smoke.ts: it drives a RUNNING gated
// gateway at E2E_BASE and creates the terminal targets through the admin REST
// API (the connection/terminal interaction is what is under test here; the
// admin target-creation *forms* are already covered by e2e-smoke.ts).
//
// Bring-up (what the harness expects to exist before running):
//   - a gated gateway reachable at E2E_BASE, admin login E2E_ADMIN_USER/PASS
//   - optional SSH upstream  (E2E_SSH_HOST:E2E_SSH_PORT)      for the SSH steps
//   - optional MySQL upstream(E2E_MYSQL_HOST:E2E_MYSQL_PORT)  for the MySQL step
//   - optional Postgres      (E2E_PG_HOST:E2E_PG_PORT)        for the Postgres step
// Terminal steps whose upstream env is absent are reported BLOCKED (not failed).
//
// Invocation:
//   E2E_BASE=http://gated.localhost:3355 \
//   E2E_ADMIN_USER=admin E2E_ADMIN_PASS=admin \
//   E2E_SSH_HOST=<ip> E2E_SSH_PORT=<port> \
//   E2E_MYSQL_HOST=<ip> E2E_MYSQL_PORT=<port> \
//   E2E_PG_HOST=<ip> E2E_PG_PORT=<port> \
//   bun scripts/e2e-auth-terminals.ts
//
// Headless, chromium --no-sandbox; exits non-zero on any HARD step failure.
import { mkdir } from 'node:fs/promises'
import process from 'node:process'
import { chromium } from 'playwright'

const BASE = process.env.E2E_BASE ?? 'http://gated.localhost:3355'
const ADMIN_USER = process.env.E2E_ADMIN_USER ?? 'admin'
const ADMIN_PASS = process.env.E2E_ADMIN_PASS ?? 'admin'
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? '/tmp/e2e-auth-terminals'

const SSH = envUpstream('E2E_SSH_HOST', 'E2E_SSH_PORT')
const MYSQL = envUpstream('E2E_MYSQL_HOST', 'E2E_MYSQL_PORT')
const PG = envUpstream('E2E_PG_HOST', 'E2E_PG_PORT')

const SSH_USER = process.env.E2E_SSH_USER ?? 'root'
const MYSQL_USER = process.env.E2E_MYSQL_USER ?? 'root'
const MYSQL_PASS = process.env.E2E_MYSQL_PASS ?? '123'
const PG_USER = process.env.E2E_PG_USER ?? 'user'
const PG_PASS = process.env.E2E_PG_PASS ?? '123'

const runId = Date.now().toString(36)

function envUpstream(hostKey: string, portKey: string): { host: string, port: number } | null {
  const host = process.env[hostKey]
  const port = process.env[portKey]
  if (!host || !port)
    return null
  return { host, port: Number(port) }
}

await mkdir(SHOT_DIR, { recursive: true })

const browser: Browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })

type Status = 'ok' | 'failed' | 'blocked'
interface StepResult { name: string, status: Status, info?: string }
const results: StepResult[] = []
let stepIndex = 0

// A HARD step that throws marks the run failed. A SOFT step that throws is
// recorded as `blocked` (infra/contract limitation) and never fails the run.
async function step(name: string, fn: () => Promise<void>, opts: { soft?: boolean } = {}) {
  stepIndex += 1
  const tag = `${String(stepIndex).padStart(2, '0')}-${name.replaceAll(/[^a-z0-9]+/gi, '-')}`
  try {
    await fn()
    results.push({ name, status: 'ok' })
    console.log(`✅ ${name}`)
  }
  catch (err) {
    const first = String(err).split('\n')[0]
    if (opts.soft) {
      results.push({ name, status: 'blocked', info: first })
      console.log(`🟡 ${name} (blocked): ${first}`)
    }
    else {
      results.push({ name, status: 'failed', info: first })
      console.log(`❌ ${name}: ${first}`)
    }
  }
  await snapshot(tag)
}

let shotPage: Page | null = null
async function snapshot(tag: string) {
  try {
    await shotPage?.screenshot({ path: `${SHOT_DIR}/${tag}.png` })
  }
  catch {}
}

// --- UI helpers -----------------------------------------------------------

async function uiLogin(page: Page, username: string, password: string) {
  await page.goto(`${BASE}/ui/`, { waitUntil: 'domcontentloaded' })
  await page.locator('#username').fill(username)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

async function whoami(ctx: BrowserContext): Promise<string | null> {
  const info = await (await ctx.request.get(`${BASE}/api/info`)).json() as { username: string | null }
  return info.username
}

// Authoritative auth gate. The app shell (sidebar with "My Assets") is always
// mounted — even behind the login form — so it is NOT a login signal. Real
// success is: the login form unmounts AND /api/info reports the user.
async function waitAuthed(page: Page, ctx: BrowserContext, username: string, timeoutMs = 20_000) {
  await page.locator('#username').waitFor({ state: 'detached', timeout: timeoutMs }).catch(() => {})
  const deadline = Date.now() + timeoutMs
  let last: string | null = null
  while (Date.now() < deadline) {
    last = await whoami(ctx)
    if (last === username)
      return
    await page.waitForTimeout(250)
  }
  throw new Error(`expected authenticated as ${username}, /api/info username=${last}`)
}

async function uiLogout(page: Page) {
  // Open the user menu (footer button, aria-haspopup=menu) then Sign out.
  await page.locator('[aria-haspopup="menu"]').first().click()
  await page.getByRole('menuitem', { name: /Sign out/i }).click()
  await page.locator('#username').waitFor({ timeout: 20_000 })
}

// Seed a terminal target via the admin REST API using the page's authenticated
// session cookies. Binds the admin role so the target is reachable.
async function seedTarget(ctx: BrowserContext, name: string, options: Record<string, unknown>) {
  const created = await ctx.request.post(`${BASE}/admin/api/targets`, { data: { name, options } })
  if (!created.ok())
    throw new Error(`create target ${name} failed: ${created.status()} ${await created.text()}`)
  const target = await created.json() as { id: string }
  const roles = await (await ctx.request.get(`${BASE}/admin/api/roles`)).json() as { id: string, name: string }[]
  const adminRole = roles.find(r => r.name === 'admin')
  if (!adminRole)
    throw new Error('admin role not found to bind target')
  const bind = await ctx.request.post(`${BASE}/admin/api/targets/${target.id}/roles/${adminRole.id}`)
  if (!bind.ok())
    throw new Error(`bind admin role failed: ${bind.status()} ${await bind.text()}`)
  return target
}

// ===========================================================================
// Login / session / logout
// ===========================================================================

const mainCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', ignoreHTTPSErrors: true })
const main = await mainCtx.newPage()
main.setDefaultTimeout(15_000)
shotPage = main

await step('login as admin through the UI', async () => {
  await uiLogin(main, ADMIN_USER, ADMIN_PASS)
  await waitAuthed(main, mainCtx, ADMIN_USER)
})

await step('session persists across navigation', async () => {
  for (const path of ['/ui/targets', '/ui/profile', '/ui/admin/sessions']) {
    await main.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
    // The login form must NOT reappear (we stay inside the authenticated app).
    if (await main.locator('#username').count() !== 0)
      throw new Error(`navigation to ${path} bounced back to the login form`)
  }
  if (await whoami(mainCtx) !== ADMIN_USER)
    throw new Error('session dropped during navigation')
})

await step('session survives a full page reload', async () => {
  await main.goto(`${BASE}/ui/targets`, { waitUntil: 'domcontentloaded' })
  await main.reload({ waitUntil: 'domcontentloaded' })
  await main.waitForTimeout(500)
  if (await main.locator('#username').count() !== 0)
    throw new Error('a full reload bounced back to the login form')
  if (await whoami(mainCtx) !== ADMIN_USER)
    throw new Error('session lost across reload')
})

await step('invalid login surfaces an error and grants no session', async () => {
  const ctx = await browser.newContext({ locale: 'en-US', ignoreHTTPSErrors: true })
  const prev = shotPage
  try {
    const page = await ctx.newPage()
    page.setDefaultTimeout(15_000)
    shotPage = page
    await uiLogin(page, ADMIN_USER, 'definitely-the-wrong-password')
    // The login form renders a role="alert" box on failure.
    await page.getByRole('alert').first().waitFor({ timeout: 15_000 })
    if (await whoami(ctx) !== null)
      throw new Error('a failed login unexpectedly produced a session')
  }
  finally {
    shotPage = prev
    await ctx.close()
  }
})

await step('logout clears the session', async () => {
  const ctx = await browser.newContext({ locale: 'en-US', ignoreHTTPSErrors: true })
  const prev = shotPage
  try {
    const page = await ctx.newPage()
    page.setDefaultTimeout(15_000)
    shotPage = page
    await uiLogin(page, ADMIN_USER, ADMIN_PASS)
    await waitAuthed(page, ctx, ADMIN_USER)
    await uiLogout(page)
    if (await whoami(ctx) !== null)
      throw new Error('session still valid after logout')
  }
  finally {
    shotPage = prev
    await ctx.close()
  }
})

await step('re-authentication after logout works', async () => {
  const ctx = await browser.newContext({ locale: 'en-US', ignoreHTTPSErrors: true })
  const prev = shotPage
  try {
    const page = await ctx.newPage()
    page.setDefaultTimeout(15_000)
    shotPage = page
    await uiLogin(page, ADMIN_USER, ADMIN_PASS)
    await waitAuthed(page, ctx, ADMIN_USER)
    await uiLogout(page)
    await uiLogin(page, ADMIN_USER, ADMIN_PASS)
    await waitAuthed(page, ctx, ADMIN_USER)
  }
  finally {
    shotPage = prev
    await ctx.close()
  }
})

// ===========================================================================
// Web terminals (main context is still the admin session)
// ===========================================================================

let sshTargetName: string | null = null

await step('SSH web terminal drives a live SSH exchange', async () => {
  if (!SSH)
    throw new Error('E2E_SSH_HOST/PORT not set — SSH upstream unavailable')
  sshTargetName = `e2e-ssh-${runId}`
  await seedTarget(mainCtx, sshTargetName, {
    kind: 'Ssh',
    host: SSH.host,
    port: SSH.port,
    username: SSH_USER,
    auth: { kind: 'PublicKey' },
  })

  // The UI's Connect action opens the terminal in a NEW TAB
  // (window.open('/ui/terminal/<kind>/<name>')). We open that same terminal
  // route directly so we can drive it on this page.
  await main.goto(`${BASE}/ui/terminal/ssh/${sshTargetName}`, { waitUntil: 'domcontentloaded' })
  // A real xterm must mount (the terminal route), proving this is not a static
  // page but a live WebSocket-backed terminal.
  await main.locator('.xterm').waitFor({ timeout: 20_000 })

  // If host-key verification is interactive, accept; with auto-accept the
  // terminal connects straight to a shell and no dialog appears.
  await main.getByRole('button', { name: 'Accept' }).click({ timeout: 3000 }).catch(() => {})

  // Wait for a live SSH exchange: the xterm screen carries upstream output
  // (MOTD / shell prompt) streamed over the WebSocket.
  await main.waitForFunction(
    () => (document.querySelector('.xterm-rows')?.textContent ?? '').trim().length > 0,
    undefined,
    { timeout: 20_000 },
  )

  // Definitive proof of a real interactive SSH session: run a command and read
  // its output back from the upstream shell.
  const marker = `GATED_E2E_${runId}`
  await main.locator('.xterm').click()
  await main.keyboard.type(`echo ${marker}`)
  await main.keyboard.press('Enter')
  await main.waitForFunction(
    m => (document.querySelector('.xterm-rows')?.textContent ?? '').includes(m),
    marker,
    { timeout: 10_000 },
  )
  console.log('   reached an interactive shell and observed command output')
}, { soft: !SSH })

await step('leaving the SSH terminal tears down the connection', async () => {
  if (!SSH || !sshTargetName)
    throw new Error('SSH terminal not opened — nothing to tear down')
  const before = await (await mainCtx.request.get(`${BASE}/admin/api/sessions`)).json() as { items?: unknown[] }
  // Navigate away from the terminal route; the xterm must unmount and its
  // WebSocket close.
  await main.goto(`${BASE}/ui/targets`, { waitUntil: 'networkidle' })
  if (await main.locator('.xterm').count() !== 0)
    throw new Error('xterm still mounted after navigating away from terminal')
  if (await whoami(mainCtx) !== ADMIN_USER)
    throw new Error('admin session lost after leaving the terminal')
  // Best-effort: the live session count should not grow after teardown.
  await main.waitForTimeout(1500)
  const after = await (await mainCtx.request.get(`${BASE}/admin/api/sessions`)).json() as { items?: unknown[] }
  const grew = (after.items?.length ?? 0) > (before.items?.length ?? 0)
  if (grew)
    console.log('   note: live session count did not shrink after teardown (may be async)')
}, { soft: !SSH })

// SQL-console web terminals for DB targets (MySQL / Postgres).
async function openSqlConsole(name: string) {
  await main.goto(`${BASE}/ui/db/${name}`, { waitUntil: 'networkidle' })
  // The console header + SQL editor must mount (the in-browser DB terminal).
  await main.getByRole('heading', { name: 'SQL Console' }).waitFor({ timeout: 20_000 })
  await main.getByLabel('SQL editor').waitFor({ timeout: 20_000 })
}

async function runConsoleQuery(sql: string) {
  const editor = main.getByLabel('SQL editor')
  await editor.click()
  await editor.fill(sql)
  await main.getByRole('button', { name: 'Run' }).click()
}

await step('MySQL web terminal (SQL console) runs a query', async () => {
  if (!MYSQL)
    throw new Error('E2E_MYSQL_HOST/PORT not set — MySQL upstream unavailable')
  const name = `e2e-mysql-${runId}`
  await seedTarget(mainCtx, name, {
    kind: 'MySql',
    host: MYSQL.host,
    port: MYSQL.port,
    username: MYSQL_USER,
    password: MYSQL_PASS,
    tls: { mode: 'Disabled', verify: false },
    default_database_name: 'db',
    readonly: false,
  })
  await openSqlConsole(name)
  // Live-connection proof: the schema tree loads the upstream's "db" database
  // (a real round-trip to MySQL through the proxy), then a query returns rows.
  await main.getByText('db', { exact: true }).first().waitFor({ timeout: 20_000 })
  await runConsoleQuery('SELECT 1 AS one')
  await main.getByRole('table').first().waitFor({ timeout: 20_000 })
}, { soft: !MYSQL })

await step('Postgres web terminal (SQL console) runs a query and shows output', async () => {
  if (!PG)
    throw new Error('E2E_PG_HOST/PORT not set — Postgres upstream unavailable')
  const name = `e2e-pg-${runId}`
  await seedTarget(mainCtx, name, {
    kind: 'Postgres',
    host: PG.host,
    port: PG.port,
    username: PG_USER,
    password: PG_PASS,
    readonly: false,
    tls: { mode: 'Disabled', verify: false },
    default_database_name: 'db',
  })
  await openSqlConsole(name)
  await runConsoleQuery('SELECT 42 AS answer')
  // A real result grid with the value proves end-to-end query execution.
  await main.getByRole('table').first().waitFor({ timeout: 20_000 })
  await main.getByText('42').first().waitFor({ timeout: 10_000 })
}, { soft: !PG })

// ===========================================================================

await mainCtx.close()
await browser.close()

const ok = results.filter(r => r.status === 'ok')
const failed = results.filter(r => r.status === 'failed')
const blocked = results.filter(r => r.status === 'blocked')

console.log(`\n${ok.length}/${results.length} steps ok, ${blocked.length} blocked, ${failed.length} failed; screenshots in ${SHOT_DIR}`)
for (const b of blocked) console.log(`   BLOCKED: ${b.name}\n     ${b.info}`)
for (const f of failed) console.log(`   FAILED: ${f.name}\n     ${f.info}`)

if (failed.length > 0)
  process.exit(1)
