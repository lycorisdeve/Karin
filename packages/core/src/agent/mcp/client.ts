import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'

import type { AgentConfig, AgentMcpServerConfig } from '@/types/agent'
import type { AgentToolRegistry } from '../tools/registry'

interface Connection {
  config: AgentMcpServerConfig
  client: Client
  tools: string[]
}

const expandEnv = (value: string) =>
  value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => {
    const result = process.env[key]
    if (result === undefined) throw new Error(`环境变量未配置: ${key}`)
    return result
  })

const redactMcpError = (error: unknown, config: AgentMcpServerConfig) => {
  const references = [
    ...Object.values(config.headers || {}),
    ...Object.values(config.env || {}),
    config.url || '',
    config.command || '',
    ...(config.args || []),
  ].flatMap(value => [...value.matchAll(/\$\{([A-Z0-9_]+)\}/g)])
    .map(match => process.env[match[1]] || '')
    .filter(Boolean)
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of references) message = message.split(secret).join('[REDACTED]')
  return message
}

const safeSegment = (value: string) => {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return /^[a-z]/.test(result) ? result : `tool_${result || 'unnamed'}`
}

export const mcpToolRisk = (annotations?: { readOnlyHint?: boolean }) => ({
  risk: annotations?.readOnlyHint === true ? 'read' as const : 'external' as const,
  idempotent: annotations?.readOnlyHint === true,
})

export class AgentMcpClientManager {
  private readonly connections = new Map<string, Connection>()
  private readonly errors = new Map<string, string>()

  constructor (
    private readonly registry: AgentToolRegistry,
    private readonly getConfig: () => AgentConfig
  ) {}

  async init () {
    if (!this.getConfig().mcp.enabled) return
    await this.reload()
  }

  async reload () {
    await this.close()
    this.registry.unregisterPrefix('mcp.')
    this.errors.clear()

    const servers = this.getConfig().mcp.servers.filter(server => server.enabled)
    await Promise.allSettled(
      servers.map(async server => {
        try {
          await this.connect(server)
        } catch (error) {
          const message = redactMcpError(error, server)
          this.errors.set(server.name, message)
          logger.error(`[agent][mcp] ${server.name} 连接失败: ${message}`)
        }
      })
    )
  }

  private async connect (config: AgentMcpServerConfig) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(config.name)) {
      throw new Error('MCP Server 名称非法')
    }

    const client = new Client(
      { name: 'karin-agent', version: process.env.KARIN_VERSION || 'development' },
      { versionNegotiation: { mode: 'auto' } }
    )
    if (config.transport === 'stdio') {
      if (!config.command) throw new Error('stdio MCP Server 缺少 command')
      const configuredEnv = Object.fromEntries(
        Object.entries(config.env || {}).map(([key, value]) => [key, expandEnv(value)])
      )
      await client.connect(
        new StdioClientTransport({
          command: expandEnv(config.command),
          args: (config.args || []).map(expandEnv),
          cwd: config.cwd ? expandEnv(config.cwd) : undefined,
          env: { ...getDefaultEnvironment(), ...configuredEnv },
          stderr: 'pipe',
        })
      )
    } else {
      if (!config.url) throw new Error('HTTP MCP Server 缺少 url')
      const headers = Object.fromEntries(
        Object.entries(config.headers || {}).map(([key, value]) => [key, expandEnv(value)])
      )
      await client.connect(
        new StreamableHTTPClientTransport(new URL(expandEnv(config.url)), {
          requestInit: { headers },
        })
      )
    }

    const listed = await client.listTools()
    const registered: string[] = []
    for (const remote of listed.tools) {
      const name = `mcp.${safeSegment(config.name)}.${safeSegment(remote.name)}`
      const risk = mcpToolRisk(remote.annotations)
      this.registry.register(
        {
          name,
          description: `[MCP:${config.name}] ${remote.description || remote.name}`,
          inputSchema: remote.inputSchema as Record<string, unknown>,
          outputSchema: remote.outputSchema as Record<string, unknown> | undefined,
          risk: risk.risk,
          permission: 'all',
          timeout: 30_000,
          idempotent: risk.idempotent,
          execute: async input => {
            return client.callTool({
              name: remote.name,
              arguments: input,
            })
          },
        },
        true
      )
      registered.push(name)
    }

    this.connections.set(config.name, { config, client, tools: registered })
    logger.info(`[agent][mcp] ${config.name} 已连接，发现 ${registered.length} 个工具`)
  }

  status () {
    const configured = this.getConfig().mcp.servers
    return configured.map(server => ({
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
      connected: this.connections.has(server.name),
      tools: this.connections.get(server.name)?.tools || [],
      error: this.errors.get(server.name),
    }))
  }

  async close () {
    await Promise.allSettled(
      [...this.connections.values()].map(connection => connection.client.close())
    )
    this.connections.clear()
  }
}
