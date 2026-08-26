# @karinjs/sandbox-win32-arm64

Karin Agent 的 Windows arm64 原生进程树 Helper。子进程以 suspended 状态创建，加入带
`KILL_ON_JOB_CLOSE` 的 Job Object 后才恢复。正式发布由矩阵执行 Authenticode 签名并生成
SHA-256，Core 加载前同时校验哈希与 Authenticode `Valid` 状态。

Helper 会优先尝试 Restricted Token；主机不支持时退回 Job Object 兼容路径。当前包不实现目录
ACL、低权限专用身份或出站防火墙，因此不得标记为硬隔离；以
`karin agent sandbox doctor` 的运行时结果为准。
