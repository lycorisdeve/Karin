import type {
  AgentActor,
  AgentGeneratedToolVersion,
  AgentScriptToolDefinition,
  AgentToolContext,
} from '@/types/agent'
import type { AgentDatabase } from '../persistence/database'
import { AgentPythonRuntime } from '../scripts/runtime'
import type { AgentToolRegistry } from '../tools/registry'

const generatedName = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/

export class AgentGeneratedToolLibrary {
  private readonly registered = new Set<string>()

  constructor (
    private readonly database: AgentDatabase,
    private readonly registry: AgentToolRegistry,
    readonly runtime: AgentPythonRuntime
  ) {}

  list () {
    return this.database.listGeneratedTools()
  }

  async versions (reference: string) {
    const tool = await this.database.getGeneratedTool(reference)
    if (!tool) throw new Error('Generated Tool 不存在')
    return this.database.getGeneratedToolVersions(tool.id)
  }

  async create (
    input: {
      name: string
      description: string
      definition: AgentScriptToolDefinition
      activate?: boolean
      legacyAlias?: string
    },
    context: Pick<AgentToolContext, 'threadId' | 'turnId' | 'actor' | 'signal'>
  ) {
    const name = String(input.name).trim().toLowerCase()
    if (!generatedName.test(name)) {
      throw new Error('Generated Tool 名称必须是至少两段的小写点分名称')
    }
    const normalized = await this.runtime.validate(input.definition, context.signal)
    const current = await this.database.getGeneratedTool(name)
    const result = await this.database.addGeneratedToolVersion({
      toolId: current?.id,
      name,
      description: String(input.description || normalized.description).trim().slice(0, 500),
      definition: normalized,
      validationStatus: 'valid',
      validationReport: 'Python AST、白名单导入、JSON Schema 与隔离执行校验通过',
      sourceTurnId: context.turnId,
      activate: input.activate !== false,
      legacyAlias: input.legacyAlias,
    })
    await this.database.audit(
      context.actor.id,
      current ? 'generated-tool.version.create' : 'generated-tool.create',
      result.toolId,
      {
        name,
        versionId: result.versionId,
        sourceHash: normalized.sourceHash,
        autoApproved: true,
        reason: 'trusted-generated-sandbox',
      },
      context.threadId
    )
    await this.refresh()
    return {
      created: !current,
      updated: Boolean(current),
      autoApproved: true,
      ...result,
      name,
      sourceHash: normalized.sourceHash,
    }
  }

  async validate (reference: string, signal: AbortSignal) {
    const versions = await this.versions(reference)
    const version = versions[0]
    if (!version) throw new Error('Generated Tool 没有版本')
    const normalized = await this.runtime.validate(version.definition, signal)
    return {
      valid: true,
      versionId: version.id,
      sourceHash: normalized.sourceHash,
      report: 'Python AST、白名单导入、JSON Schema 与隔离执行校验通过',
    }
  }

  async setEnabled (reference: string, enabled: boolean, actor: AgentActor, threadId?: string) {
    const tool = await this.database.getGeneratedTool(reference)
    if (!tool) throw new Error('Generated Tool 不存在')
    const updated = await this.database.setGeneratedToolEnabled(tool.id, enabled)
    await this.database.audit(
      actor.id,
      'generated-tool.state',
      tool.id,
      { enabled, autoApproved: true },
      threadId
    )
    await this.refresh()
    return updated
  }

  async rollback (
    reference: string,
    versionId: string,
    actor: AgentActor,
    threadId?: string
  ) {
    const tool = await this.database.getGeneratedTool(reference)
    if (!tool) throw new Error('Generated Tool 不存在')
    const updated = await this.database.rollbackGeneratedTool(tool.id, versionId)
    await this.database.audit(
      actor.id,
      'generated-tool.rollback',
      tool.id,
      { versionId, updated, autoApproved: true },
      threadId
    )
    await this.refresh()
    return updated
  }

  async delete (reference: string, actor: AgentActor, threadId?: string) {
    const tool = await this.database.getGeneratedTool(reference)
    if (!tool) throw new Error('Generated Tool 不存在')
    this.registry.unregister(tool.name)
    const deleted = await this.database.deleteGeneratedTool(tool.id)
    await this.database.audit(
      actor.id,
      'generated-tool.delete',
      tool.id,
      { name: tool.name, deleted },
      threadId
    )
    await this.refresh()
    return deleted
  }

  async refresh () {
    for (const name of this.registered) this.registry.unregister(name)
    this.registered.clear()
    for (const version of await this.database.getActiveGeneratedToolVersions()) {
      await this.register(version)
    }
  }

  close () {
    for (const name of this.registered) this.registry.unregister(name)
    this.registered.clear()
  }

  private async register (version: AgentGeneratedToolVersion) {
    const tool = await this.database.getGeneratedTool(version.toolId)
    if (!tool) return
    const normalized = await this.runtime.validate(version.definition)
    if (normalized.sourceHash !== version.definition.sourceHash) {
      throw new Error(`Generated Tool ${tool.name} 源码哈希不一致`)
    }
    if (this.registry.get(tool.name)) this.registry.unregister(tool.name)
    this.registry.register({
      name: tool.name,
      description: tool.description,
      toolset: `generated.${tool.id}`,
      tags: ['Generated Tool', normalized.name, normalized.semantics.objective],
      inputSchema: normalized.inputSchema,
      outputSchema: normalized.outputSchema,
      risk: 'read',
      permission: 'all',
      timeout: normalized.stop.timeoutMs,
      idempotent: normalized.semantics.idempotent,
      reversible: true,
      requirements: ['Python 3'],
      availability: () => true,
      execute: (input, context) =>
        this.runtime.execute(normalized, input, context.signal, context),
    }, true, 'generated-sandbox')
    this.registered.add(tool.name)
  }
}
