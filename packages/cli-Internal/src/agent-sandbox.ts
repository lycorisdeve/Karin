const sandboxModule = 'node-karin/agent/sandbox'

export const sandboxDoctor = async () => {
  const { doctorAgentSandbox } = await import(sandboxModule)
  const status = await doctorAgentSandbox()
  console.log(JSON.stringify(status, null, 2))
  if (!status.hardIsolation) process.exitCode = 1
}

export const sandboxSetup = async () => {
  const { setupAgentSandbox } = await import(sandboxModule)
  const result = await setupAgentSandbox()
  console.log(JSON.stringify(result, null, 2))
}
