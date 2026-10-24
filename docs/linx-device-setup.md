# 灵矽 Web 语音身份与连接凭据

本项目的浏览器经 Mac 后端连接灵矽。平台所说的“设备”可以是软件语音客户端，无需额外购买硬件。

- **设备 ID**：后端语音客户端的固定身份，使用 MAC 格式。OTA 请求头 `Device-Id` 与请求体 `mac_address` 必须一致。当前项目使用基于本机网络硬件身份和客户端 ID 派生的独立伪 MAC，保存在本机配置。
- **WebSocket Token／设备连接 Token**：设备绑定智能体后，OTA 返回的 `websocket.token`，用于 WebSocket 的 Bearer 鉴权。
- **平台 API Key**：管理智能体、设备绑定、音色和复刻的凭据，不能直接当作上述 Token。
- **客户端 ID**：软件生成并持久保存的 UUID，OTA 和 WebSocket 使用相同值。
- **业务回调 Token**：本项目生成的独立凭据，用于验证灵矽发往游戏服务的请求。

## 获取步骤

1. 创建专用于项目的灵矽智能体。
2. 确定并保存设备 ID、客户端 ID。向 `https://xrobo.qiniuapi.com/v1/ota/` 发送设备上报；未绑定时返回六位 `activation.code`。
3. 在灵矽控制台绑定激活码，或使用已授权的平台 API 调用 `POST /xiaozhi/device/bind/{agentId}/{deviceCode}`。
4. 使用相同设备身份再次上报 OTA，获取 `websocket.url` 和 `websocket.token`。Token 保存在服务端，不输出到日志。
5. 以此身份建立 WebSocket、发送 `hello` 并检查服务端应答。这仅验证语音连接鉴权。
6. 另行配置第三方 Chat 业务回调及验证真实 ASR、角色回复和 TTS，才能验收语音整局。

## 本机验证记录

2026-10-24 已使用现有 API Key 创建 `Cyber DM Web Voice` 智能体，关闭平台记忆、意图识别与唤醒问候，完成软件设备绑定并自动保存设备 ID、智能体 ID 和连接 Token。用户刷新配置页面即可看到，勿用刷新前的旧表单覆盖新配置。

真实灵矽 WSS 已鉴权成功，收到带 session ID 的 `hello`，协商结果为单声道 PCM、16 kHz、16 bit、20 ms。尚不能据此认定第三方 Chat 回调、录音识别或整局语音已经通过；配置页的字段齐全检查也不是实际联调结果。

来源：[OTA 网关](https://linx.qiniu.com/docs/xrobot/platform/OTA)、[设备 API](https://linx.qiniu.com/docs/xrobot/api/device)、[WebSocket 协议](https://linx.qiniu.com/docs/xrobot/platform/websocket)、[Mac/Linux 客户端](https://linx.qiniu.com/docs/xrobot/guide/client-demo)。
