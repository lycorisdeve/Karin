import type { AgentToolOptions } from '../agent'
import type { PkgInfo, PluginFile } from './base'

export interface AgentTool extends AgentToolOptions {
  file: PluginFile<'tool'>
  pkg: PkgInfo
}
