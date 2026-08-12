import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentCapabilityCatalog } from '../../packages/core/src/agent/capabilities/catalog'
import { AgentDatabase } from '../../packages/core/src/agent/persistence/database'
import { AgentToolRegistry } from '../../packages/core/src/agent/tools/registry'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('Agent capability catalog', () => {
  it('distinguishes globally registered Tools from Tools callable in the current round', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-capability-test-'))
    directories.push(directory)
    const database = new AgentDatabase(directory)
    await database.init()
    const registry = new AgentToolRegistry()
    registry.register({
      name: 'test.catalog.visible',
      description: 'catalog search visible',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      execute: () => 'visible',
    })
    registry.register({
      name: 'test.catalog.hidden',
      description: 'catalog search hidden',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      execute: () => 'hidden',
    })
    registry.register({
      name: 'test.catalog.unavailable',
      description: 'catalog search unavailable',
      inputSchema: { type: 'object', additionalProperties: false },
      risk: 'read',
      availability: () => false,
      execute: () => 'unavailable',
    })

    try {
      const results = await new AgentCapabilityCatalog(database, registry).search(
        'thread-1',
        'catalog search',
        ['test.catalog.visible']
      )
      const byName = new Map(results.map(item => [item.name, item]))

      expect(byName.get('test.catalog.visible')).toMatchObject({
        registered: true,
        available: true,
        callable: true,
      })
      expect(byName.get('test.catalog.hidden')).toMatchObject({
        registered: true,
        available: true,
        callable: false,
      })
      expect(byName.get('test.catalog.unavailable')).toMatchObject({
        registered: true,
        available: false,
        callable: false,
      })
    } finally {
      registry.unregister('test.catalog.visible')
      registry.unregister('test.catalog.hidden')
      registry.unregister('test.catalog.unavailable')
      await database.close()
    }
  })
})
