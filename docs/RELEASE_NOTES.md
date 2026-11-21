OneYes ComfyUI v0.1.7，基于 ComfyUI 0.46.0。

- 深度接入 19 个原版 API 节点：GPT 图片与 ChatGPT Responses、Claude、Gemini / Nano Banana、Grok 图片与视频及文件 / 高级选项。保留原节点 ID、参数、插槽与输出，支持原工作流导入。
- 平台 Key 独立加密保存与选择，首次连接复用已有平台 Key；Grok 图片与 Video 分组分别路由，避免混用。节点模型选择可刷新当前分组权限。
- 原分辨率上传多图，保留遮罩、涂鸦、透明通道、批次数量和高级参数。GPT 异步图片与 Grok 视频保存原回执，重启后原参数取回，不自动重复付费提交。
- 右上角账号入口改为 OneYes，未登录显示“OneYes 登录”；登录后显示账号名，悬停显示余额或连接状态。
- 点击账号按钮及原登录入口直接打开原生 OneYes 账户页，支持直接登录、二次验证码、复用客户端登录态与手动配置 Key。
- 移除原 Comfy 登录提示与 SSO／Google／GitHub 登录弹窗，新增 OneYes 官网注册和找回密码入口。
- 保留 ComfyUI 应用图标、原生画布与工作流；OneYes 登录态与 Comfy Org 身份独立。
- 四个平台验证真实账号按钮点击、登录状态更新、账户链接、权限隔离、原生工作流及 19 个原版节点的协议契约，再构建签名 OTA；测试不产生付费生成。

支持范围以 docs/NATIVE_NODES.zh-CN.md 为准；其他供应商专有接口仍禁用。OneYes 未提供的模型不伪装为可用能力，费用以 OneYes 为准。

支持 Windows x64、macOS Apple Silicon、Linux x64／ARM64；Linux 提供 AppImage、DEB、RPM。安装包内置完整运行依赖，更新保留登录状态、Key、工作流和任务。macOS 当前为 ad-hoc 自签名，未经过 Apple 公证。

完整源码见 Source.tar.gz；ComfyUI 引擎采用 GPL-3.0-or-later，图标来源与授权见 docs/THIRD_PARTY.md。
