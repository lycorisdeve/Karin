import initAdapter from './adapter'
import initAgent from './agent'
import initConfig from './config'
import initEnv from './env'
import initGroups from './groups'
import initPrivates from './privates'
import initRender from './render'
import initWebUI from './webui'
import initHelp from './help'

export * from './adapter'
export * from './agent'
export * from './config'
export * from './env'
export * from './groups'
export * from './privates'
export * from './render'
export * from './webui'
export * from './help'
export * from './pm2'
export * from './redis'

/**
 * @internal

 * @description 初始全部化配置文件
 * @param dir 配置文件根目录
 */
export const initConfigCache = (dir: string) => {
  initEnv()
  initAgent(dir)
  initAdapter(dir)
  initConfig(dir)
  initGroups(dir)
  initPrivates(dir)
  initRender(dir)
  initWebUI(dir)
  initHelp(dir)
}
