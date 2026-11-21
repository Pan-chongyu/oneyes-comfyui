OneYes ComfyUI v0.1.6，基于 ComfyUI 0.46.0。

- 去除独立的启动设置窗口，打开软件直接加载 ComfyUI 画布，无需先登录或填写 Key。
- 原生“设置 → 用户”改为 OneYes 账户页：登录、二次验证、复用客户端登录态、自动／手动 Key 配置、可用模型、图片任务与更新统一在画布内操作。
- 顶部 OneYes 菜单、系统菜单、节点设置按钮均复用原生设置框；托盘直接返回画布。
- 继续内置 Python、PyTorch CPU、完整引擎依赖；首次启动无需下载依赖。保留原工作流、本地模型与自定义节点。
- 四个平台用真实引擎验证免登录启动、原生设置切换、账户与 Key、菜单导航和权限隔离，再构建签名 OTA。

支持 Windows x64、macOS Apple Silicon、Linux x64／ARM64；Linux 提供 AppImage、DEB、RPM。更新保留登录状态、Key、工作流和任务。macOS 当前为 ad-hoc 自签名，未经过 Apple 公证。

完整源码见 Source.tar.gz；ComfyUI 引擎采用 GPL-3.0-or-later，图标来源与授权见 docs/THIRD_PARTY.md。
