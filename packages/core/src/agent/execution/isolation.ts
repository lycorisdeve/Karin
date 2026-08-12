import fs from 'node:fs'
import os from 'node:os'

export interface AgentIsolationBackendStatus {
  platform: NodeJS.Platform
  processIsolation: true
  hardIsolation: false
  detectedBackends: Array<'bwrap' | 'seatbelt'>
  reason: string
}

/**
 * Probe only. Karin does not label a process boundary as a hard sandbox until a
 * backend runner is wired to the Tool execution path and verified for this host.
 */
export const probeAgentIsolationBackends = (): AgentIsolationBackendStatus => {
  const detectedBackends: AgentIsolationBackendStatus['detectedBackends'] = []
  if (process.platform === 'linux' && [
    '/usr/bin/bwrap',
    '/bin/bwrap',
  ].some(filename => fs.existsSync(filename))) detectedBackends.push('bwrap')
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) {
    detectedBackends.push('seatbelt')
  }
  return {
    platform: process.platform,
    processIsolation: true,
    hardIsolation: false,
    detectedBackends,
    reason: detectedBackends.length
      ? `检测到 ${detectedBackends.join('、')}，当前版本仍按进程隔离标记，硬隔离要求失败关闭`
      : `${os.platform()} 未检测到可用的硬隔离后端`,
  }
}
