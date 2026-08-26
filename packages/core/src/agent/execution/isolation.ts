import { agentSandboxStatus } from './sandbox'

export const probeAgentIsolationBackends = () => {
  const status = agentSandboxStatus()
  return status
    ? { ...status, processIsolation: true }
    : {
      platform: process.platform,
      processIsolation: true,
      hardIsolation: false,
      detectedBackends: [],
      backend: 'none' as const,
      mode: 'fallback' as const,
      network: 'deny' as const,
      configuredBackend: 'auto' as const,
      reason: 'Agent SandboxRunner 尚未初始化',
    }
}
