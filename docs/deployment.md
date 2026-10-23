# HTTPS 子域名部署

手机浏览器的麦克风只会在安全上下文中工作，因此验收环境需要使用 HTTPS。反向代理必须同时转发普通 HTTP、`/voice/socket` WebSocket，以及灵矽的 `/integrations/linx/chat/stream` 回调。

下面以 Caddy 为例。假设子域名是 `dm.example.com`，应用运行在同一台机器的 `127.0.0.1:3001`：

```caddyfile
dm.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

Caddy 会自动申请和续期证书，并默认支持 WebSocket。DNS 的 `dm.example.com` A/AAAA 记录需要先指向这台机器，防火墙只开放 80 和 443。

应用启动前设置访问口令和公网来源。来源必须与浏览器地址完全一致，不要带路径：

```sh
export HOST=127.0.0.1
export PORT=3001
export CYBER_DM_ACCESS_CODE='至少16字符的本地验收口令'
export CYBER_DM_PUBLIC_ORIGIN='https://dm.example.com'
npm start
```

启动后检查：

```sh
curl -I https://dm.example.com/
```

在网页“连接与声音”填写模型和灵矽凭证，再把灵矽第三方业务回调设置为：

```text
https://dm.example.com/integrations/linx/chat/stream
```

回调使用同一份业务回调 Token。参考音频复刻还需要把页面中的“公网 HTTPS 地址”填写为 `https://dm.example.com`，服务会生成一小时有效的一次性音频 URL。不要把证书、访问口令、模型 API Key 或灵矽 Token 提交到 Git。

## 直接由应用终止 TLS

没有反向代理时，也可以让 Node 直接监听 HTTPS。证书文件必须在本机，且证书和私钥同时设置：

```sh
export HOST=0.0.0.0
export PORT=3001
export CYBER_DM_TLS_CERT=/etc/letsencrypt/live/dm.example.com/fullchain.pem
export CYBER_DM_TLS_KEY=/etc/letsencrypt/live/dm.example.com/privkey.pem
npm start
```

此方式仍需要把域名解析到机器，并在防火墙放行 3001；生产验收更推荐使用 443 反代。浏览器打开的地址、`CYBER_DM_PUBLIC_ORIGIN` 和灵矽回调域名必须保持一致。

## 验收顺序

1. 用 PC Chrome 打开 HTTPS 地址，登录访问口令，上传或发布一个完整 JSON 短本。
2. 在“连接与声音”填入至少一个模型服务，为 DM 和每个角色分别绑定模型与 `tts_provider / voice_type`。
3. 填入灵矽 API Key、WebSocket Token、Device ID、Client ID、业务回调 Token，点击“发车检查”。
4. 先在 PC Chrome 完成一局，再用 macOS Safari、Android Chrome 和 iPhone Safari 各完成录音、识别、播放和断线重连检查。

自动化测试和本地模拟 WebSocket 只能证明规则与协议桥的代码行为，不能替代真实灵矽账号和真机语音验收。
