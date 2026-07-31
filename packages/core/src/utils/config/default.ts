import type {
  Adapters,
  AgentConfig,
  Config,
  Groups,
  PM2,
  Privates,
  Redis,
  Renders,
  WebUIAppearanceConfig,
  HelpAppearanceConfig,
} from '@/types/config'

/**
 * @description 默认配置
 */
export const defaultConfig: {
  adapter: Adapters
  agent: AgentConfig
  config: Config
  groups: Groups
  pm2: PM2
  redis: Redis
  render: Renders
  privates: Privates
  webui: WebUIAppearanceConfig
  help: HelpAppearanceConfig
} = Object.freeze({
  adapter: {
    console: {
      isLocal: true,
      token: '',
      host: '',
    },
    onebot: {
      ws_server: {
        enable: true,
        timeout: 120,
      },
      ws_client: [
        {
          enable: false,
          url: 'ws://127.0.0.1:7778',
          token: '',
        },
      ],
      http_server: [
        {
          enable: false,
          self_id: 'default',
          url: 'http://127.0.0.1:6099',
          token: '',
          api_token: '',
          post_token: '',
        },
      ],
    },
    wecom: [],
    feishu: [],
    telegram: [],
    qqbot: [],
    wechat: [],
    dingtalk: [],
    discord: [],
    whatsapp: [],
    email: [],
  },
  agent: {
    version: 7,
    enabled: false,
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai',
        enabled: true,
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: '',
        timeout: 30000,
      },
    ],
    routing: {
      primary: 'openai',
      fallback: [],
    },
    trigger: {
      private: true,
      groupMention: true,
      wakeWords: [],
    },
    limits: {
      maxToolRounds: 8,
      maxToolOutputBytes: 65536,
      maxRecentMessages: 40,
      maxSubagents: 3,
    },
    policy: {
      approvalTtlMs: 300000,
      hardDeny: [],
      rules: [],
      defaults: {
        read: 'allow',
        write: 'ask',
        external: 'ask',
        destructive: 'ask',
      },
    },
    learning: {
      memory: true,
      skills: true,
      reflection: {
        enabled: true,
        afterFailure: true,
        successInterval: 5,
      },
      curator: {
        enabled: true,
        intervalHours: 168,
        minIdleMinutes: 120,
        staleAfterDays: 30,
        archiveAfterDays: 90,
      },
      promotion: {
        autoMemory: true,
        autoRouting: true,
        autoDeclarativeSkills: true,
        minEvidence: 3,
        minSuccessRate: 0.8,
        maxRegressionRate: 0.05,
        autoRollback: true,
        rollbackWindow: 20,
      },
    },
    recovery: {
      enabled: true,
      maxCycles: 2,
      maxDiagnosticCalls: 8,
      maxDurationMs: 120000,
      researchPolicy: 'evidence-driven',
      repair: {
        requireApproval: true,
        workspaceRoots: [],
      },
    },
    tools: {
      disabled: [],
      disabledToolsets: [],
    },
    mcp: {
      enabled: false,
      servers: [],
    },
    scriptRuntime: {
      pythonExecutable: '',
      defaultTimeoutMs: 30000,
      maxTimeoutMs: 120000,
      defaultMaxOutputBytes: 65536,
      maxOutputBytes: 1048576,
    },
  },
  config: {
    master: [
      'console',
    ],
    admin: [],
    user: {
      enable_list: [],
      disable_list: [],
    },
    friend: {
      enable: true,
      enable_list: [],
      disable_list: [],
      log_enable_list: [],
      log_disable_list: [],
    },
    group: {
      enable: true,
      enable_list: [],
      disable_list: [],
      log_enable_list: [],
      log_disable_list: [],
    },
    directs: {
      enable: true,
      enable_list: [],
      disable_list: [],
      log_enable_list: [],
      log_disable_list: [],
    },
    guilds: {
      enable: true,
      enable_list: [],
      disable_list: [],
      log_enable_list: [],
      log_disable_list: [],
    },
    channels: {
      enable: true,
      enable_list: [],
      disable_list: [],
      log_enable_list: [],
      log_disable_list: [],
    },
  },
  groups: [
    {
      key: 'default',
      inherit: true,
      cd: 0,
      userCD: 0,
      mode: 0,
      alias: [],
      enable: [],
      disable: [],
      member_enable: [],
      member_disable: [],
    },
    {
      key: 'global',
      inherit: true,
      cd: 0,
      userCD: 0,
      mode: 0,
      alias: [],
      enable: [],
      disable: [],
      member_enable: [],
      member_disable: [],
    },
    {
      key: 'Bot:selfId',
      inherit: true,
      cd: 0,
      userCD: 0,
      mode: 0,
      alias: [],
      enable: [],
      disable: [],
      member_enable: [],
      member_disable: [],
    },
    {
      key: 'Bot:selfId:groupId',
      inherit: true,
      cd: 0,
      userCD: 0,
      mode: 0,
      alias: [],
      enable: [],
      disable: [],
      member_enable: [],
      member_disable: [],
    },
    {
      key: 'Bot:selfId:guildId',
      inherit: true,
      cd: 0,
      userCD: 0,
      mode: 0,
      alias: [],
      enable: [],
      disable: [],
      member_enable: [],
      member_disable: [],
    },
    {
      key: 'Bot:selfId:guildId:channelId',
      inherit: true,
      cd: 0,
      userCD: 0,
      mode: 0,
      alias: [],
      enable: [],
      disable: [],
      member_enable: [],
      member_disable: [],
    },
  ],
  pm2: {
    lines: 1000,
    apps: [
      {
        name: 'karin',
        script: 'index.js',
        autorestart: true,
        max_restarts: 60,
        max_memory_restart: '1G',
        restart_delay: 2000,
        merge_logs: true,
        error_file: './@karinjs/logs/pm2_error.log',
        out_file: './@karinjs/logs/pm2_out.log',
      },
    ],
  },
  privates: [
    {
      key: 'default',
      inherit: true,
      cd: 0,
      mode: 0,
      alias: [],
      enable: [],
      disable: [],
    },
    {
      key: 'global',
      inherit: true,
      cd: 0,
      mode: 0,
      alias: [],
      enable: [],
      disable: [],
    },
    {
      key: 'Bot:selfId',
      inherit: true,
      cd: 0,
      mode: 0,
      alias: [],
      enable: [],
      disable: [],
    },
    {
      key: 'Bot:selfId:userId',
      inherit: true,
      cd: 0,
      mode: 0,
      alias: [],
      enable: [],
      disable: [],
    },
  ],
  redis: {
    url: 'redis://127.0.0.1:6379',
    username: '',
    password: '',
    database: 0,
  },
  render: {
    ws_server: {
      enable: true,
    },
    ws_client: [
      {
        enable: false,
        url: 'ws://127.0.0.1:7005',
        token: '123456',
        isSnapka: false,
        reconnectTime: 5000,
        heartbeatTime: 30000,
      },
    ],
    http_server: [
      {
        enable: false,
        url: 'http://127.0.0.1:7005',
        token: '123456',
        isSnapka: false,
      },
    ],
  },
  webui: {
    version: 1,
    revision: 1,
    activeThemeId: 'karin-bloom',
    mode: 'system',
    themes: [],
  },
  help: {
    version: 1,
    revision: 1,
    title: 'Karin 帮助',
    subtitle: 'Karin Bot & Plugins',
    backgroundAsset: '',
    backgroundPosition: 'center',
    overlay: 0.16,
  },
})
