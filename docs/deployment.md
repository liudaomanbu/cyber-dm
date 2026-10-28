# HTTPS 子域名部署

## Cloudflare Workers 免费版（当前部署）

当前版本已部署到 Cloudflare Workers，并通过现有路由 `cyber-dm.caotc.org/*` 提供服务。房间状态、配置、草稿、浏览器密钥和参考音频已迁移到 SQLite Durable Object；Worker 不依赖 Mac 文件系统。灵矽与模型凭据只作为 Cloudflare Secret 保存，仓库和公开响应不会包含它们。

部署入口配置在 `wrangler.jsonc`。首次迁移使用本地忽略目录中的一次性迁移令牌调用 `/__migration/import`，成功后该入口拒绝再次迁移。后续发布只需：

```sh
npm run build
npx wrangler deploy --keep-vars --secrets-file .data/worker-secrets.json
```

免费额度按 Cloudflare 账户计算：Workers 请求、Durable Objects 请求/活跃时长/SQLite 读写分别受限；模型和灵矽费用不包含在内。当前单真人实测公开开场通过，仍应监控长回合耗时和免费额度。若需要回退，删除 Worker route 后原来的 Cloudflare Tunnel DNS 和 Mac 服务仍可恢复。

## 历史回退方案：Mac + Cloudflare Tunnel

用户已选择在当前 Mac 运行应用，由 Cloudflare Tunnel 提供 `https://cyber-dm.caotc.org`。不需要开放路由器入站端口；Mac 和应用、隧道进程必须保持运行，休眠会使站点不可用。

1. 安装 `brew install cloudflared`，执行 `cloudflared tunnel login`，在浏览器登录并授权 `caotc.org`。
2. 执行 `cloudflared tunnel create cyber-dm`，将返回的 UUID 和凭据文件绝对路径填入 `deploy/cloudflared.example.yml` 的副本 `.data/cloudflared.yml`。
3. 执行 `cloudflared tunnel route dns cyber-dm cyber-dm.caotc.org`，只为此子域名建立隧道 DNS 记录。
4. 在 `.data/deployment.env` 设置以下内容（文件权限设为 `600`，口令使用随机值）：

```dotenv
HOST=127.0.0.1
PORT=3001
CYBER_DM_PUBLIC_ORIGIN=https://cyber-dm.caotc.org
CYBER_DM_ACCESS_CODE=替换为至少16字符的随机口令
```

5. 停止旧的开发服务后，运行 `python3 scripts/macos-services.py install`，用 macOS LaunchAgent 管理应用和隧道。两个服务在当前用户登录时自动启动，退出后自动拉起，不依赖终端或开发工具会话。
6. 从公网验证 `/healthz` 返回成功，`/api/bootstrap` 未登录时返回 401，再通过首页登录。手机使用同一 HTTPS 域名。

应用内部使用 HTTP，公网 TLS 由 Cloudflare 终止；WebSocket 自动通过隧道转发。不要使用 Host 覆盖来规避应用的来源校验。业务回调仍使用下面的固定 HTTPS 地址和独立回调 Token。隧道凭据与访问口令仅保存在本机忽略目录，不能提交仓库。

当前 Mac 的网络上曾出现 QUIC 隧道上传大文件停滞，模板及本机配置已固定 `protocol: http2`（Cloudflare 边缘到隧道连接使用 HTTP/2）。切换后经公网验证 38 秒／3.65 MB 和 60 秒／5.76 MB WAV 上传成功；浏览器端仍使用 HTTPS，音色复刻不受传输协议选择影响。

当前 Mac 已使用官方 `cloudflared` 2026.10.3 的 Intel Mac 二进制，保存在 `.data/bin/cloudflared`，下载后已与 GitHub Release 的 SHA-256 摘要核对。手动执行上面的登录、创建和 DNS 命令时，把 `cloudflared` 替换为 `.data/bin/cloudflared`；启动脚本会自动使用本地版本。访问口令保存在 `.data/deployment.env`，业务回调 Token 在 `.data/config.json`，均不要复制到公开文档中。

服务管理：

```sh
python3 scripts/macos-services.py status
```

日志在 `.data/logs/`；服务名为 `org.caotc.cyber-dm.server` 和 `org.caotc.cyber-dm.tunnel`。升级 Node 路径或修改启动配置后重新运行 `install`。需要停止自动运行时执行 `python3 scripts/macos-services.py uninstall`，它保留本地资料和 Cloudflare DNS。调试时仍可手动运行 `sh scripts/start-tunnel-server.sh` 和 `sh scripts/start-tunnel.sh`，但不要与 LaunchAgent 重复启动。

Cloudflare 1033 表示没有可用隧道连接；先检查 tunnel 服务与日志。若隧道在线但源站未启动，一般会出现 502，检查 server 服务和 `http://127.0.0.1:3001/healthz`。LaunchAgent 不会让关机、休眠、注销或断网的 Mac 保持公网在线；恢复联网并登录后由服务继续重连。

## 其他部署环境：Caddy

手机浏览器的麦克风只会在安全上下文中工作，因此验收环境需要使用 HTTPS。反向代理必须同时转发普通 HTTP、`/voice/socket` WebSocket，以及灵矽的 `/integrations/linx/chat/stream` 回调。

下面以 Caddy 为例。本项目使用的子域名是 `cyber-dm.caotc.org`，应用运行在同一台机器的 `127.0.0.1:3001`：

```caddyfile
cyber-dm.caotc.org {
    reverse_proxy 127.0.0.1:3001
}
```

Caddy 会自动申请和续期证书，并默认支持 WebSocket。DNS 的 `cyber-dm.caotc.org` A/AAAA 记录需要先指向这台机器，防火墙只开放 80 和 443。

应用启动前设置访问口令和公网来源。来源必须与浏览器地址完全一致，不要带路径：

```sh
export HOST=127.0.0.1
export PORT=3001
export CYBER_DM_ACCESS_CODE='至少16字符的本地验收口令'
export CYBER_DM_PUBLIC_ORIGIN='https://cyber-dm.caotc.org'
npm start
```

启动后检查：

```sh
curl -I https://cyber-dm.caotc.org/
curl -fsS https://cyber-dm.caotc.org/healthz
```

在网页“连接与声音”填写模型和灵矽凭证，再把灵矽第三方业务回调设置为：

```text
https://cyber-dm.caotc.org/integrations/linx/chat/stream
```

回调使用同一份业务回调 Token。参考音频复刻还需要把页面中的“公网 HTTPS 地址”填写为 `https://cyber-dm.caotc.org`，服务会生成一小时有效的一次性音频 URL。不要把证书、访问口令、模型 API Key 或灵矽 Token 提交到 Git。

## 直接由应用终止 TLS

没有反向代理时，也可以让 Node 直接监听 HTTPS。证书文件必须在本机，且证书和私钥同时设置：

```sh
export HOST=0.0.0.0
export PORT=3001
export CYBER_DM_TLS_CERT=/etc/letsencrypt/live/cyber-dm.caotc.org/fullchain.pem
export CYBER_DM_TLS_KEY=/etc/letsencrypt/live/cyber-dm.caotc.org/privkey.pem
npm start
```

此方式仍需要把域名解析到机器，并在防火墙放行 3001；生产验收更推荐使用 443 反代。浏览器打开的地址、`CYBER_DM_PUBLIC_ORIGIN` 和灵矽回调域名必须保持一致。

## 验收顺序

1. 用 PC Chrome 打开 HTTPS 地址，登录访问口令，上传或发布一个完整 JSON 短本。
2. 在“连接与声音”填入至少一个模型服务，为 DM 和每个角色分别绑定模型与灵矽音色 ID；只有旧版第三方 TTS 回调才需要 `tts_provider / voice_type`。
3. 填入灵矽 API Key、WebSocket Token、Device ID、Client ID、业务回调 Token，点击“发车检查”。
4. 先在 PC Chrome 完成一局，再用 macOS Safari、Android Chrome 和 iPhone Safari 各完成录音、识别、播放和断线重连检查。

自动化测试和本地模拟 WebSocket 只能证明规则与协议桥的代码行为，不能替代真实灵矽账号和真机语音验收。
