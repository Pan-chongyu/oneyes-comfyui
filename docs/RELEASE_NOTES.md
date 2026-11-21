OneYes ComfyUI v0.1.4，基于 ComfyUI 0.46.0。

- 安装包内置 Python、PyTorch CPU、全部引擎依赖和官方前端，安装后自动启动，无需另装 Python 或等待下载依赖。
- 自动复用本机 OneYes 登录态；直接登录后自动选择可用图片 / 文字 Key，已有手动配置保持不变。独立登录可自动创建 / 复用工作流 Key。
- 配置完成自动打开画布；不登录也能打开本地画布。云端生成仍需网络与可用 Key，本地模型权重不包含在安装包中。
- Windows 内置本地 C++ 运行库；Python 缓存与数据保存在用户目录，更新保留工作流、图片任务与 Key。
- 四个平台验证全新用户、中文 / 空格安装路径的离线启动、原生与 OneYes 节点执行，以及打包后运行库导入。

支持 Windows x64、macOS Apple Silicon、Linux x64 / ARM64；Linux 可选 AppImage、DEB、RPM。安装包文件名标注系统与架构，全部提供签名 OTA。macOS 当前为 ad-hoc 自签名，未经过 Apple 公证。

完整源码见 Source.tar.gz；ComfyUI 引擎采用 GPL-3.0-or-later，图标来源与授权见仓库 docs/THIRD_PARTY.md。
