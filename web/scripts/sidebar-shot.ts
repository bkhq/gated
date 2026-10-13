import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const BASE = process.env.SCREENSHOT_BASE ?? 'http://gated.localhost:1355/ui'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'docs', 'screenshots')

await mkdir(OUT_DIR, { recursive: true })

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })

interface Inspect {
  sidebarWidth: number
  sidebarHeight: number
  headerHeight: number
  headerPadL: number
  itemHeight: number
  itemFontSize: string
  itemPaddingX: string
  itemPaddingY: string
  itemGap: string
  labelFontSize: string
  labelTransform: string
  labelTracking: string
  labelPadding: string
  activeBg: string
  hoverBg: string
  footerHeight: number
}

try {
  for (const theme of ['light', 'dark'] as const) {
    for (const collapsed of [false, true] as const) {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        colorScheme: theme,
      })
      const page = await ctx.newPage()
      const url = `${BASE}/overview?theme=${theme}`
      console.log(`→ ${theme} ${collapsed ? 'collapsed' : 'expanded'} ${url}`)
      await page.goto(url, { waitUntil: 'networkidle' })
      await page.waitForTimeout(300)
      // Drive theme + sidebar via the shared zustand store (uses keyboard shortcut to toggle if needed)
      await page.evaluate(({ wantTheme, wantCollapsed }) => {
        const html = document.documentElement
        if (wantTheme === 'dark')
          html.classList.add('dark')
        else
          html.classList.remove('dark')
        // Toggle sidebar via ctrl+b twice if necessary by checking data-state
        const sb = document.querySelector('[data-slot="sidebar"]')
        const state = sb?.getAttribute('data-state')
        const isCollapsed = state === 'collapsed'
        if (wantCollapsed !== isCollapsed) {
          // Find the BrandHeader collapse/expand button
          const btn = document.querySelector<HTMLButtonElement>('button[aria-label="Collapse sidebar"], button[aria-label="Expand sidebar"]')
          btn?.click()
        }
      }, { wantTheme: theme, wantCollapsed: collapsed })
      await page.waitForTimeout(400)

      // Capture inspect info before the screenshot
      const info = await page.evaluate((): Inspect => {
        const inner = document.querySelector<HTMLElement>('[data-slot="sidebar-inner"]')
        const header = document.querySelector<HTMLElement>('[data-slot="sidebar-header"]')
        const firstItem = document.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')
        const itemCs = firstItem ? getComputedStyle(firstItem) : null
        const menu = document.querySelector<HTMLElement>('[data-slot="sidebar-menu"]')
        const menuCs = menu ? getComputedStyle(menu) : null
        const groupLabel = document.querySelector<HTMLElement>('[data-slot="sidebar-group-label"]')
        const labelCs = groupLabel ? getComputedStyle(groupLabel) : null
        const footer = document.querySelector<HTMLElement>('[data-slot="sidebar-footer"]')
        const activeItem = document.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"][data-active="true"]')
        const activeBg = activeItem ? getComputedStyle(activeItem).backgroundColor : ''
        return {
          sidebarWidth: inner?.getBoundingClientRect().width ?? 0,
          sidebarHeight: inner?.getBoundingClientRect().height ?? 0,
          headerHeight: header?.getBoundingClientRect().height ?? 0,
          headerPadL: header ? Number.parseFloat(getComputedStyle(header).paddingLeft) : 0,
          itemHeight: firstItem?.getBoundingClientRect().height ?? 0,
          itemFontSize: itemCs?.fontSize ?? '',
          itemPaddingX: itemCs?.paddingLeft ?? '',
          itemPaddingY: itemCs?.paddingTop ?? '',
          itemGap: menuCs?.rowGap ?? menuCs?.gap ?? '',
          labelFontSize: labelCs?.fontSize ?? '',
          labelTransform: labelCs?.textTransform ?? '',
          labelTracking: labelCs?.letterSpacing ?? '',
          labelPadding: groupLabel && labelCs ? `${labelCs.paddingTop}/${labelCs.paddingRight}/${labelCs.paddingBottom}/${labelCs.paddingLeft}` : '',
          activeBg,
          hoverBg: '',
          footerHeight: footer?.getBoundingClientRect().height ?? 0,
        }
      })
      console.log(JSON.stringify(info, null, 2))

      const suffix = collapsed ? 'collapsed' : 'expanded'
      const file = join(OUT_DIR, `sidebar-${suffix}-${theme}.png`)
      await page.screenshot({ path: file, fullPage: false, clip: { x: 0, y: 0, width: collapsed ? 80 : 264, height: 900 } })
      console.log(`  wrote ${file}`)

      await ctx.close()
    }
  }
}
finally {
  await browser.close()
}
