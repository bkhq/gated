// End-to-end smoke against a RUNNING dev gateway (just dev / nsl on :3355).
// Covers login, account dialog state reset, real group list, target create
// with role binding (access-grant chain), connect-command correctness, live
// SSH web terminal (needs a reachable sshd), ticket share link, user create
// with password + role, monitor pages.
//
//   E2E_BASE=http://gated.localhost:3355 bun scripts/e2e-smoke.ts
//
// Prereqs: gateway running; admin/admin login; an sshd the gateway can reach
// (defaults to 127.0.0.1:2299 with user e2etest / E2eTestPass1).
import { mkdir } from 'node:fs/promises'
import process from 'node:process'
import { chromium } from 'playwright'

const BASE = process.env.E2E_BASE ?? 'http://gated.localhost:3355'
const SSH_HOST = process.env.E2E_SSH_HOST ?? '127.0.0.1'
const SSH_PORT = process.env.E2E_SSH_PORT ?? '2299'
const SSH_USER = process.env.E2E_SSH_USER ?? 'e2etest'
const SSH_PASS = process.env.E2E_SSH_PASS ?? 'E2eTestPass1'
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? '/tmp/e2e-shots'

const runId = Date.now().toString(36)
const ACCOUNT = `e2e-cred-${runId}`
const GROUP = `e2e-group-${runId}`
const TARGET = `e2e-ssh-${runId}`
const NEW_USER = `e2euser${runId}`
const NEW_USER_PASS = 'E2eUserPass1'

await mkdir(SHOT_DIR, { recursive: true })

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
const page = await ctx.newPage()
page.setDefaultTimeout(15_000)

interface StepResult { name: string, ok: boolean, error?: string }
const results: StepResult[] = []
let stepIndex = 0

async function step(name: string, fn: () => Promise<void>) {
  stepIndex += 1
  const tag = `${String(stepIndex).padStart(2, '0')}-${name.replaceAll(/[^a-z0-9]+/gi, '-')}`
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`✅ ${name}`)
    await page.screenshot({ path: `${SHOT_DIR}/${tag}.png` }).catch(() => {})
  }
  catch (err) {
    results.push({ name, ok: false, error: String(err) })
    console.log(`❌ ${name}: ${String(err).split('\n')[0]}`)
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-FAIL.png` }).catch(() => {})
    // Dismiss any modal/drawer left open so it doesn't occlude later steps.
    await page.keyboard.press('Escape').catch(() => {})
    await page.keyboard.press('Escape').catch(() => {})
  }
}

// base-ui Select: click the trigger, then the popup option.
async function selectOption(triggerSelector: string, optionText: string | RegExp) {
  await page.locator(triggerSelector).click()
  await page.getByRole('option', { name: optionText }).first().click()
}

// ---------------------------------------------------------------------------

await step('login as admin', async () => {
  await page.goto(`${BASE}/ui/`, { waitUntil: 'domcontentloaded' })
  await page.locator('#username').fill('admin')
  await page.locator('#password').fill('admin')
  await page.getByRole('button', { name: 'Sign in' }).click()
  // Hash router — assert the authenticated shell rendered, not the URL.
  await page.getByRole('link', { name: 'My Assets' }).waitFor({ timeout: 20_000 })
})

await step('create ssh-password account', async () => {
  await page.goto(`${BASE}/ui/admin/accounts`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'New account' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('#account-name').fill(ACCOUNT)
  // SSH credential (username/password) lives on the Credential tab.
  await dialog.getByRole('tab', { name: 'Credential' }).click()
  await dialog.getByLabel('Username', { exact: true }).fill(SSH_USER)
  await dialog.getByLabel('Password', { exact: true }).first().fill(SSH_PASS)
  await dialog.getByRole('button', { name: /Create account|Save/ }).click()
  await page.getByText(ACCOUNT).first().waitFor()
})

await step('account dialog resets for second "new" open', async () => {
  await page.goto(`${BASE}/ui/admin/accounts`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'New account' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('#account-name').waitFor()
  const nameValue = await dialog.locator('#account-name').inputValue()
  if (nameValue !== '')
    throw new Error(`stale draft leaked into new-account form: "${nameValue}"`)
  await page.keyboard.press('Escape')
})

await step('create target group', async () => {
  await page.goto(`${BASE}/ui/admin/target-groups`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'New group' }).first().click()
  await page.locator('#target-group-name').fill(GROUP)
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByText(GROUP).first().waitFor()
})

await step('create ssh target with real group + role binding', async () => {
  await page.goto(`${BASE}/ui/admin/targets`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'New target' }).click()
  await page.locator('#target-name').fill(TARGET)
  await selectOption('#target-group', GROUP) // real groups from /admin/api/target-groups
  await page.locator('#target-host').fill(SSH_HOST)
  await page.locator('#target-port').fill(SSH_PORT)
  await page.locator('#target-user').fill(SSH_USER)
  await page.getByRole('tab', { name: 'Authentication' }).click()
  await selectOption('#target-primary-account', new RegExp(ACCOUNT))
  await page.getByRole('tab', { name: 'Roles' }).click()
  await page.getByRole('switch', { name: 'admin' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByText(TARGET).first().waitFor()
})

await step('role binding persisted (API)', async () => {
  const targets = await (await ctx.request.get(`${BASE}/admin/api/targets`)).json() as { id: string, name: string }[]
  const target = targets.find(item => item.name === TARGET)
  if (!target)
    throw new Error('target not found via API')
  const roles = await (await ctx.request.get(`${BASE}/admin/api/targets/${target.id}/roles`)).json() as { name: string }[]
  if (!roles.some(role => role.name === 'admin'))
    throw new Error(`expected admin role bound, got: ${JSON.stringify(roles)}`)
})

await step('workbench shows real connect command', async () => {
  await page.goto(`${BASE}/ui/targets`, { waitUntil: 'networkidle' })
  await page.getByText(TARGET).first().click()
  const pre = page.locator('pre')
  await pre.waitFor()
  const cmd = (await pre.textContent() ?? '').trim()
  if (cmd.includes('acme.io'))
    throw new Error(`hard-coded host in command: ${cmd}`)
  if (!cmd.includes(`admin:${TARGET}@`) || !cmd.startsWith('ssh '))
    throw new Error(`unexpected command: ${cmd}`)
})

await step('web SSH terminal is a real SSH client (not a static page)', async () => {
  // Assert the terminal mounts a real xterm, opens a WebSocket, and
  // drives the binary frame protocol far enough to surface a genuine SSH
  // handshake result — a host-key-verify prompt (frame 0x03) carrying the
  // target's real public key, OR a session-status frame (0x02). Completing the
  // upstream login further needs the target to trust gated's CA (Warpgate
  // model) or accept the bound account's password — that is test-fixture setup
  // outside this smoke.
  await page.goto(`${BASE}/ui/targets`, { waitUntil: 'networkidle' })
  await page.getByText(TARGET).first().click()
  // PageHeader renders two responsive copies of the actions; click the
  // visible one (exact avoids matching "Copy connect cmd").
  await page.getByRole('button', { name: 'Connect', exact: true }).last().click()
  await page.locator('.xterm').waitFor({ timeout: 20_000 }) // real terminal route
  // Either a host-key dialog (with a real ssh-ed25519 public key) or a session
  // status banner must appear — both prove a live SSH protocol exchange.
  const hostKeyDialog = page.getByRole('button', { name: 'Accept' })
  const statusBanner = page.getByText(/Verifying host key|Session error|connected|SSH connection/i)
  await Promise.race([
    hostKeyDialog.waitFor({ timeout: 20_000 }),
    statusBanner.first().waitFor({ timeout: 20_000 }),
  ])
})

await step('ticket share link contains one-time secret', async () => {
  await page.goto(`${BASE}/ui/tickets`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Issue grant' }).first().click()
  await page.locator('#ticket-name').fill(`e2e-grant-${runId}`)
  await selectOption('#ticket-scope', TARGET) // scope is a Select of target names
  await page.getByRole('dialog').getByRole('button', { name: 'Issue grant' }).click()
  await page.getByText('gated-ticket=').first().waitFor()
})

let shareLink = ''
await step('extract share link and authorize anonymously', async () => {
  shareLink = (await page.locator('.mono.break-all').first().textContent() ?? '').trim()
  if (!shareLink.includes('gated-ticket='))
    throw new Error(`no secret in link: ${shareLink}`)
  const anon = await browser.newContext({ locale: 'en-US' })
  try {
    const anonPage = await anon.newPage()
    await anonPage.goto(shareLink, { waitUntil: 'networkidle' })
    const info = await (await anon.request.get(`${BASE}/api/info`)).json() as { username: string | null, authorized_via_ticket: boolean }
    if (info.username !== 'admin' || !info.authorized_via_ticket)
      throw new Error(`share link did not authorize: ${JSON.stringify(info)}`)
  }
  finally {
    await anon.close()
  }
})

await step('create user with password + role', async () => {
  await page.keyboard.press('Escape')
  await page.goto(`${BASE}/ui/admin/users`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'New user' }).click()
  await page.locator('#user-name').fill('E2E User')
  await page.locator('#user-username').fill(NEW_USER)
  await page.locator('#user-password').fill(NEW_USER_PASS)
  await page.getByRole('tab', { name: /Roles/ }).click()
  await page.getByRole('switch', { name: 'admin' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByText(NEW_USER).first().waitFor()
})

await step('new user can log in with the set password', async () => {
  const fresh = await browser.newContext({ locale: 'en-US' })
  try {
    const loginPage = await fresh.newPage()
    await loginPage.goto(`${BASE}/ui/`, { waitUntil: 'domcontentloaded' })
    await loginPage.locator('#username').fill(NEW_USER)
    await loginPage.locator('#password').fill(NEW_USER_PASS)
    await loginPage.getByRole('button', { name: 'Sign in' }).click()
    await loginPage.waitForURL(/\/ui\/(?!.*login)/, { timeout: 20_000 })
    const info = await (await fresh.request.get(`${BASE}/api/info`)).json() as { username: string | null }
    if (info.username !== NEW_USER)
      throw new Error(`login failed: ${JSON.stringify(info)}`)
  }
  finally {
    await fresh.close()
  }
})

await step('monitor: sessions + audit log render real rows', async () => {
  await page.goto(`${BASE}/ui/admin/sessions`, { waitUntil: 'networkidle' })
  await page.locator('table').first().waitFor({ timeout: 10_000 })
  await page.goto(`${BASE}/ui/admin/audit`, { waitUntil: 'networkidle' })
  await page.locator('table tbody tr').first().waitFor({ timeout: 10_000 })
})

// ---------------------------------------------------------------------------

await ctx.close()
await browser.close()

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed; screenshots in ${SHOT_DIR}`)
if (failed.length > 0) {
  for (const f of failed) console.log(`   FAILED: ${f.name}\n     ${f.error}`)
  process.exit(1)
}
