import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const BASE = process.env.SCREENSHOT_BASE ?? 'http://localhost:5173/ui'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'docs', 'screenshots')

const ROUTES: Array<{ name: string, path: string }> = [
  { name: 'overview', path: '/overview' },
  { name: 'targets', path: '/targets' },
  { name: 'target-detail', path: '/targets/t1' },
  { name: 'sessions', path: '/sessions' },
  { name: 'auth-requests', path: '/auth-requests' },
  { name: 'profile', path: '/profile' },
  { name: 'credentials', path: '/credentials' },
  { name: 'tickets', path: '/tickets' },
  { name: 'api-tokens', path: '/api-tokens' },
  { name: 'admin-sessions', path: '/admin/sessions' },
  { name: 'admin-audit', path: '/admin/audit' },
  { name: 'admin-targets', path: '/admin/targets' },
  { name: 'admin-target-detail', path: '/admin/targets/t1' },
  { name: 'admin-target-groups', path: '/admin/target-groups' },
  { name: 'admin-users', path: '/admin/users' },
  { name: 'admin-roles', path: '/admin/roles' },
  { name: 'admin-accounts', path: '/admin/accounts' },
  { name: 'admin-tickets', path: '/admin/tickets' },
  { name: 'admin-known-hosts', path: '/admin/known-hosts' },
  { name: 'admin-params', path: '/admin/params' },
  { name: 'login', path: '/auth/login' },
]

await mkdir(OUT_DIR, { recursive: true })

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })

try {
  for (const theme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: theme,
    })
    const page = await ctx.newPage()

    // Login route is unauthenticated — fetch first
    for (const route of ROUTES) {
      const url = `${BASE}${route.path}?theme=${theme}`

      console.log(`→ ${theme} ${route.name} ${url}`)
      await page.goto(url, { waitUntil: 'networkidle' })
      // Give the route render a tick
      await page.waitForTimeout(400)
      const file = join(OUT_DIR, `${route.name}-${theme}.png`)
      await page.screenshot({ path: file, fullPage: false })
    }

    await ctx.close()
  }
}
finally {
  await browser.close()
}

console.log(`wrote ${ROUTES.length * 2} screenshots to ${OUT_DIR}`)
