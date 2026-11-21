# OneYes ComfyUI

[中文](#中文) · [English](#english) · [下载 / Downloads](https://github.com/Pan-chongyu/oneyes-comfyui/releases/latest)

## 中文

基于 [ComfyUI](https://github.com/Comfy-Org/ComfyUI) 的公开派生版本。保留原有节点工作流、本地模型和自定义节点，支持直接登录 OneYes、复用 OneYes 客户端登录态，以及手动配置 Key。

### 主要功能

- **OneYes 文生图**：异步接口提交，保存原任务回执；断网或重启后继续取回，不自动重发付费请求。
- **OneYes 参考图编辑**：二进制上传全部参考图片，保留原分辨率。数量与参数能力由模型决定。
- **OneYes 取回原图片任务**：使用本地任务编号恢复原结果，无需再生成。
- **OneYes 文字生成**：通过 OpenAI 兼容 Chat Completions 接口生成提示词或其他文字。
- **账号登录**：邮箱 / 密码登录、二次验证码、加密保存登录状态并自动恢复；同一用户下打开并登录 OneYes 客户端后，可直接复用登录态。密码不保存，客户端账号令牌不复制到本软件。
- **Key 与模型管理**：默认 Key、图片 Key、文字 Key 分开配置；Key 使用本机 AES-256-GCM 加密，不写入导出的工作流，不调用 macOS 钥匙串。优先 oneyes.ai 直连线路。
- **安装即用**：安装包内置独立 Python、CPU 推理库和官方 ComfyUI 前端，首启自动启动画布，无需另装 Python 或在线下载依赖。关闭窗口可留在系统托盘，支持签名 OTA。

### 下载安装

| 系统 | 芯片 | 安装格式 |
| --- | --- | --- |
| Windows | x64 | EXE 安装器 |
| macOS | Apple Silicon / ARM64 | DMG、ZIP |
| Linux | x64、ARM64 | AppImage、DEB、RPM |

下载文件名包含系统与架构。首版不包含 Intel Mac 或 Windows ARM 包。macOS 当前采用 ad-hoc 自签名，尚未经过 Apple 公证。

1. 从 [Release](https://github.com/Pan-chongyu/oneyes-comfyui/releases/latest) 下载对应安装包，或通过 OneYes 应用中心安装。
2. 打开后自动启动画布并尝试复用本机 OneYes 客户端登录态；也可直接登录 OneYes 或手动填写 Key。首次连接自动选择 OpenAI 图片 Key 与 DeepSeek / OpenAI 文字 Key，保留已有手动配置。独立登录没有合适图片 Key 时，在可用 OpenAI VIP / SVIP 分组新建或复用 `ComfyUI_工作流` Key；复用模式不新建 Key。
3. 配置好后自动打开画布；无需云端功能时，也可直接点击“打开画布”使用本地功能。**启动无需联网安装依赖，云端调用仍需网络与可用 Key**。没有内置模型权重，也不会自动下载模型。
4. 在 ComfyUI 中搜索 `OneYes` 添加节点，在节点中选择可用模型，连接原生“预览图像”或“保存图像”节点后运行。
5. 重启恢复图片：保留原参数与任务种子重新运行，或在“OneYes 设置 → 图片任务”复制本地任务编号，交给“取回原图片任务”节点。原 Key 必须仍然有效。提交结果不明确时先在官网核对，不会自动重复收费生成。

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

桌面开发：Node.js 24，`npm ci`、`npm run prepare:desktop`、`npm run prepare:runtime`、`npm start`。依赖仅在准备安装包时下载；Windows 构建机需 Visual Studio C++ 可再发行文件以打包本地运行库。测试：`npm test`、`npm run test:python`、`npm run test:engine`。真实引擎测试会将完整环境移动到含中文与空格的新路径，在离线配置、全新用户目录下运行，不发送付费生成请求。

`npm run test:account-ui` 在隔离的 Electron 窗口中检查登录、二次验证、选择 Key、客户端连接与账号切换，使用测试接口，不发送真实密码或生成请求。登录接口启用官网人机验证或登录协议时，请在 OneYes 客户端完成验证后复用；不会绕过官网验证。退出本软件会清除该账号导入的 Key，保留手动 Key，不会退出主客户端。切换 Key 后取回历史任务仍需原 Key。

Key 存储文件与本机主密钥受用户目录权限保护；能读取该用户全部文件的进程仍可解密，不能视为硬件安全存储。任务记录和原图保存在本机，不上传诊断信息。模型、工作流与数据不会随覆盖升级删除。

## English

OneYes ComfyUI is a public fork of ComfyUI with OneYes cloud nodes and a desktop runtime manager. Original local-model nodes, workflows and custom nodes are preserved.

Included nodes: asynchronous image generation, reference-image editing, original image-task recovery and Chat Completions text generation. Credentials are encrypted locally, kept outside workflows and never sent with image downloads. The model picker loads the current key's available IDs. Separate image/text keys support different OneYes groups.

Sign in directly with your OneYes email/password and optional two-factor code, or reuse a running OneYes Desktop session on the same OS user. Select existing keys for image and text nodes; direct sign-in can create/reuse a `ComfyUI_工作流` key in an available group. Passwords are not stored. Desktop account tokens are never copied. Encrypted sessions survive restarts; signing out here leaves OneYes Desktop signed in. Manual key configuration remains available. If the official login requires additional website verification, complete it in OneYes Desktop before connecting.

Desktop installers support Windows x64, macOS Apple Silicon and Linux x64 / ARM64. **Standalone Python, CPU PyTorch and the official frontend are bundled; the engine starts automatically without downloading dependencies.** First connection selects suitable existing image/text keys, or creates/reuses a workflow key in an available OpenAI VIP/SVIP group for direct sign-in. Manual keys are preserved. The canvas opens automatically once configured; local use is available without signing in. Cloud requests require network access and a usable key. No model weights are included or automatically downloaded. GPU inference is available by managing a normal ComfyUI GPU environment from source.

Image receipts survive restarts. Re-run identical parameters with the same task seed, or use the recovery node with the local task ID from Settings. A missing submission receipt is never silently resubmitted. Automatic updates verify an independent Ed25519-signed manifest and package SHA-256. macOS builds are currently ad-hoc signed, without Apple notarization.

See [release notes](docs/RELEASE_NOTES.md), [OTA policy](docs/OTA_POLICY.zh-CN.md) and [third-party notices](docs/THIRD_PARTY.md). This is a community fork, not an official Comfy Org distribution. Licensed under GPL-3.0-or-later; full corresponding source is available here and in each release. Original project documentation is retained in [UPSTREAM_README](docs/UPSTREAM_README.md).
