import { describe, expect, it } from 'vitest'
import { mcpToolRisk } from '@/agent/mcp/client'

describe('MCP Tool risk mapping', () => {
  it('allows declared read-only Tools and keeps unspecified Tools approval-gated', () => {
    expect(mcpToolRisk({ readOnlyHint: true })).toEqual({
      risk: 'read',
      idempotent: true,
    })
    expect(mcpToolRisk()).toEqual({
      risk: 'external',
      idempotent: false,
    })
    expect(mcpToolRisk({ readOnlyHint: false })).toEqual({
      risk: 'external',
      idempotent: false,
    })
  })
})
