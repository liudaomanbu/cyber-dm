# Cloudflare 免费部署可行性 · 2026-10-24

结论：Workers 免费架构是可行的候选路线，不能因为 Containers 要付费就排除整个 Cloudflare 平台。Oracle 的优势是现有 Node 应用可以较少改动地迁移，不是本项目必须使用它。用户目前询问 Workers 免费额度，尚未选定迁移方案。

已核对官方文档：

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)：免费计划每天 100,000 次请求、每次 HTTP 请求 10 ms CPU、128 MB 内存。等待外部网络不计 CPU；HTTP 连接保持时没有固定的墙钟时长上限，WebSocket 受运行时更新等影响仍需恢复机制。
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)：免费计划支持 SQLite Durable Objects；每天 100,000 次请求、13,000 GB-s 活跃时长；SQLite 每天 500 万行读取、10 万行写入、总存储 5 GB。不能只看 Workers 请求次数，实时音频消息、持续连接与存储各有额度。
- [Workers fs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)：虚拟文件系统基于内存，临时目录按请求隔离，不提供现有 `.data` 文件所需的持久性。

源码适配点：

| 当前实现 | Workers 候选实现 / 待验证点 |
| --- | --- |
| Vite 静态网页 | Workers 静态资源或 Pages |
| Fastify Node HTTP 服务 | 适配 Workers 请求入口与认证、上传、回调路由 |
| `.data` JSON、进程内会话与动作锁 | SQLite Durable Objects 持久化与每房间串行协调；配置密钥需单独处理访问控制 |
| `ws` 输入/输出双设备连接 | Workers/DO WebSocket 桥；验证灵矽握手、鉴权头、断线恢复和额度 |
| 服务端 Opus 解码、PDF 解析 | 测量 CPU/内存与依赖兼容性；评估 PCM 直传、浏览器处理等方案，不承诺原样运行 |
| 参考音频暂存与回源 | 单独设计持久存储、大小和有效期限制，不能继续依赖本机文件 |

单真人、少量测试有希望落在免费额度内。当前已在正式域名完成单真人开场实测；仍未完成完整整局容量测试。模型、ASR/TTS 的第三方费用不包含在 Cloudflare 免费额度里。

现有 Mac + Tunnel 保持运行，作为回退路径；没有开通付费资源。当前 Worker route 接管正式域名，DNS 记录未删除。长公开回合排查仍未完成：源码显示 `GameService` 在整轮角色生成、审核和主持调度全部完成后才提交，`bridgeStt` 收到整轮结果后才开始播报，因此存在累计等待；正式域名开场实测约 40 秒并返回非空 PCM，完整整局仍待优化。
