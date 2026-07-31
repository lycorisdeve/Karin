import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) =>
  readFileSync(resolve(process.cwd(), path), 'utf8')

describe('WebUI config routing', () => {
  it('registers the independent adapter route before the generic config route', () => {
    const source = readSource('packages/web/src/App.tsx')
    const adapterRoute = source.indexOf("path='/config/adapter'")
    const genericRoute = source.indexOf("path='/config/:tab'")

    expect(adapterRoute).toBeGreaterThan(-1)
    expect(genericRoute).toBeGreaterThan(adapterRoute)
  })

  it('keeps adapter out of the common config tabs and ignores stale requests', () => {
    const source = readSource('packages/web/src/pages/dashboard/config/index.tsx')
    const componentStart = source.indexOf('export default function ConfigPage')
    const lazyCalls = [...source.matchAll(/\blazy\(/g)].map(match => match.index)

    expect(source).not.toContain("| 'adapter'")
    expect(source).not.toContain("key: 'adapter'")
    expect(lazyCalls.length).toBeGreaterThan(0)
    expect(lazyCalls.every(index => index < componentStart)).toBe(true)
    expect(source).toContain('let active = true')
    expect(source).toContain('active = false')
    expect(source).toContain('loadedConfig?.type === selectedTab')
  })

  it('uses common config as the first child of system config', () => {
    const site = readSource('packages/web/src/config/site.ts')
    const systemConfig = site.slice(site.indexOf("label: '系统配置'"))
    const commonConfig = systemConfig.indexOf("href: '/config/config'")
    const adapterConfig = systemConfig.indexOf("href: '/config/adapter'")
    const appearance = systemConfig.indexOf("href: '/appearance'")

    expect(commonConfig).toBeGreaterThan(-1)
    expect(adapterConfig).toBeGreaterThan(commonConfig)
    expect(appearance).toBeGreaterThan(adapterConfig)
  })
})
