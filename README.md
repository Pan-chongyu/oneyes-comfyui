# OneYes ComfyUI

[中文](#中文) · [English](#english) · [下载 / Downloads](https://github.com/Pan-chongyu/oneyes-comfyui/releases/latest)

## 中文

基于 [ComfyUI](https://github.com/Comfy-Org/ComfyUI) 的公开派生版本。保留原有节点工作流、本地模型和自定义节点，支持直接登录 OneYes、复用 OneYes 客户端登录态，以及手动配置 Key。打开后直接进入 ComfyUI 画布，账户、Key、模型、任务和更新整合在原生“设置 → 用户”中。

### 主要功能

- **原版 API 节点接入**：适配 19 个原版节点，包含 GPT 图片 / ChatGPT、Claude、Gemini / Nano Banana、Grok 图片与视频及文件 / 高级选项。保留原节点 ID、参数与输出，导入工作流继续连线使用；具体范围见 [原版节点适配](docs/NATIVE_NODES.zh-CN.md)。
- **OneYes 文生图**：异步接口提交，保存原任务回执；断网或重启后继续取回，不自动重发付费请求。
- **OneYes 参考图编辑**：二进制上传全部参考图片，保留原分辨率。数量与参数能力由模型决定。
- **OneYes 取回原图片任务**：使用本地任务编号恢复原结果，无需再生成。
- **OneYes 文字生成**：通过 OpenAI 兼容 Chat Completions 接口生成提示词或其他文字。
- **独立账号登录**：无需安装或运行 OneYes 客户端，可直接邮箱 / 密码登录、完成二次验证，或手动填写 Key。需要官网验证码、登录协议时，使用本软件的“网站登录”窗口完成验证。登录状态本机加密保存，重启自动恢复，密码不保存；复用主客户端仍是可选方式。
- **Key 与模型管理**：默认、通用图片 / 文字及 Claude、Gemini、Grok 图片 / 视频 Key 分开配置；Video 分组独立路由，模型选择按当前 Key 权限刷新。Key 使用本机 AES-256-GCM 加密，不写入导出的工作流，不调用 macOS 钥匙串。优先 oneyes.ai 直连线路。
- **安装即用**：安装包内置独立 Python、CPU 推理库和官方 ComfyUI 前端，首启自动启动画布，无需另装 Python 或在线下载依赖。关闭窗口可留在系统托盘，支持签名 OTA。
- **原版节点依赖随包提供**：核对全部原版内置节点加载，补齐 SPZ v4 依赖；离线验证图像、超分、音视频和 3D 导入导出。模型权重仍按原版放入对应目录。
- **ElevenLabs 工作流兼容**：保留 8 个原版节点定义，本地音色选择器可用。OneYes 尚未提供的语音生成、克隆等接口明确标注暂未接入，不再误报为缺包或版本过低。

### 下载安装

| 系统 | 芯片 | 安装格式 |
| --- | --- | --- |
| Windows | x64 | EXE 安装器 |
| macOS | Apple Silicon / ARM64 | DMG、ZIP |
| Linux | x64、ARM64 | AppImage、DEB、RPM |

下载文件名包含系统与架构。首版不包含 Intel Mac 或 Windows ARM 包。macOS 当前采用 ad-hoc 自签名，尚未经过 Apple 公证。

1. 从 [Release](https://github.com/Pan-chongyu/oneyes-comfyui/releases/latest) 下载对应安装包，或通过 OneYes 应用中心安装。
2. 打开后自动启动画布，恢复本软件的登录状态；首次使用直接登录 OneYes 或手动填写 Key，不检查或依赖主客户端。首次连接自动选择 OpenAI 图片 Key 与 DeepSeek / OpenAI 文字 Key，保留已有手动配置。独立登录没有合适图片 Key 时，在可用 OpenAI VIP / SVIP 分组新建或复用 `ComfyUI_工作流` Key；可选的客户端复用模式不新建 Key。
3. 启动直接进入画布，不先显示独立设置页；从右上角“OneYes 登录”、顶部 OneYes 菜单、节点设置按钮或“设置 → 用户”登录与配置，免登录也可使用本地功能。**启动无需联网安装依赖，云端调用仍需网络与可用 Key**。没有内置模型权重，也不会自动下载模型。
4. 搜索 `OneYes` 或已适配的原版节点名称，在节点中选择 OneYes 可用模型，连接原生“预览图像”或“保存图像”等节点后运行。原版 API 节点使用 OneYes，费用以 OneYes 为准。
5. 重启恢复 GPT / OneYes 图片：保留原参数与任务种子重新运行，或在“OneYes 设置 → 云端任务”复制本地任务编号，交给“取回原图片任务”节点。图片下载兼容代理 Fake-IP DNS（198.18.0.0/15）及 HTTP(S) 代理环境变量，保持 HTTPS 域名证书校验。Grok 视频保持原参数与种子重新运行原节点取回。原 Key 必须仍然有效。提交结果不明确时先在官网核对，不会自动重复收费生成。

内置运行环境使用 CPU；云端生成不需要本地显卡。GPU 用户可按 ComfyUI 官方说明管理自己的 CUDA / ROCm 环境并手动安装本扩展。不要在不受信任的网络开放本机服务。

### 已有 ComfyUI / 从源码运行

```sh
git clone https://github.com/Pan-chongyu/oneyes-comfyui.git
cd oneyes-comfyui
# 使用独立 Python 环境，按 ComfyUI 官方说明安装匹配硬件的 PyTorch
python -m pip install -r requirements.txt -r oneyes/requirements.txt
python -m oneyes.install
python -m oneyes.configure
python main.py --cpu --listen 127.0.0.1 --disable-partner-nodes
```

桌面开发：Node.js 24，`npm ci`、`npm run prepare:desktop`、`npm run prepare:runtime`、`npm run prepare:frontend`、`npm start`。依赖仅在准备安装包时下载；Windows 构建机需 Visual Studio C++ 可再发行文件以打包本地运行库。测试：`npm test`、`npm run test:python`、`npm run test:engine`。真实引擎测试会将完整环境移动到含中文与空格的新路径，在离线配置、全新用户目录下运行，不发送付费生成请求。

`npm run test:account-ui` 启动真实 ComfyUI 与隔离用户目录，验证主客户端不存在时的登录、二次验证、GPT 图片工作流，以及独立网站登录、原生用户页、菜单、可选客户端连接和账号切换。认证与云端生成使用测试接口，不产生真实费用；网站登录窗口使用隔离会话，只接收 OneYes 官方域名主页面的登录结果，再向服务端验证账号，关闭后清除临时网站数据。退出本软件会清除该账号导入的 Key，保留手动 Key，不会退出主客户端。切换 Key 后取回历史任务仍需原 Key。

Key 存储文件与本机主密钥受用户目录权限保护；能读取该用户全部文件的进程仍可解密，不能视为硬件安全存储。任务记录和原图保存在本机，不上传诊断信息。模型、工作流与数据不会随覆盖升级删除。

## English

OneYes ComfyUI is a public fork of ComfyUI with OneYes cloud nodes and accounts integrated into native Settings → User. Original local-model nodes, workflows and custom nodes are preserved.

Original built-in node dependencies are bundled, including Zstandard for SPZ v4. Every desktop target verifies built-in node registration and executes representative image, upscaling, audio, video and 3D workflows offline. Model weights remain separate.

Eight original ElevenLabs node definitions are preserved for workflow import, and the local voice selector works offline. The seven cloud operations are explicitly marked unavailable because OneYes does not currently expose the corresponding APIs; installing packages cannot enable those upstream services.

Included nodes: asynchronous image generation, reference-image editing, original image-task recovery and Chat Completions text generation. Credentials are encrypted locally, kept outside workflows and never sent with image downloads. The model picker loads the current key's available IDs. Separate image/text keys support different OneYes groups.

19 original API nodes now use OneYes transport while preserving their workflow IDs, inputs and outputs: GPT images and ChatGPT Responses, Claude Messages, Gemini text / Nano Banana images, Grok images / video, and their file/config helpers. Platform keys are separate, including a dedicated Video-group key. Native model pickers can refresh from the current OneYes group. Original-resolution references, masks, markup and image alpha are preserved. GPT image and Grok video receipts can resume without another paid submission. Other vendors, GIF/SVG generation and video editing/extension are not yet adapted; availability still depends on OneYes. See the [compatibility table](docs/NATIVE_NODES.zh-CN.md).

OneYes Desktop is optional: sign in independently with your OneYes email/password and two-factor code, or paste an API key. The in-app website sign-in window handles official CAPTCHA and login agreements in an isolated session; the account is verified server-side and temporary website storage is cleared on close. Select existing keys for image and text nodes; direct sign-in can create/reuse a `ComfyUI_工作流` key in an available group. Passwords are not stored. Encrypted sessions survive restarts; signing out here leaves OneYes Desktop signed in. Reusing a running OneYes Desktop account remains an optional action, never a prerequisite.

Desktop installers support Windows x64, macOS Apple Silicon and Linux x64 / ARM64. **Standalone Python, CPU PyTorch and the official frontend are bundled; the engine starts automatically without downloading dependencies.** First connection selects suitable existing image/text keys, or creates/reuses a workflow key in an available OpenAI VIP/SVIP group for direct sign-in. Manual keys are preserved. The app opens directly into the canvas without a separate launcher. The top-right OneYes account button shows your sign-in state and opens native Settings → User. Sign in, manage keys, browse models and tasks, and update there or through the OneYes menu. Registration and password recovery open the OneYes website. Local use is available without signing in. Cloud requests require network access and a usable key. No model weights are included or automatically downloaded. GPU inference is available by managing a normal ComfyUI GPU environment from source.

Image receipts survive restarts. Re-run identical parameters with the same task seed, or use the recovery node with the local task ID from Settings. Downloads support proxy Fake-IP DNS (198.18.0.0/15) and HTTP(S) proxy environment variables while keeping HTTPS hostname verification. Failed downloads retain the original receipt. A missing submission receipt is never silently resubmitted. Automatic updates verify an independent Ed25519-signed manifest and package SHA-256. macOS builds are currently ad-hoc signed, without Apple notarization.

See [release notes](docs/RELEASE_NOTES.md), [OTA policy](docs/OTA_POLICY.zh-CN.md) and [third-party notices](docs/THIRD_PARTY.md). This is a community fork, not an official Comfy Org distribution. Licensed under GPL-3.0-or-later; full corresponding source is available here and in each release. Original project documentation is retained in [UPSTREAM_README](docs/UPSTREAM_README.md).
