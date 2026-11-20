# OneYes ComfyUI OTA

此应用拥有独立的公开仓库和签名身份，不复用或更换 OneYes Desktop / Canvas 的签名密钥。公钥固定在 `desktop/update-key.cjs`。私钥仅保存在本机忽略目录与 GitHub Actions Secret `COMFY_OTA_PRIVATE_KEY`。

正式构建由 `.github/workflows/oneyes-desktop.yml` 按 `oneyes-vX.Y.Z` 标签启动，并使用相同标签发布 Release，与上游引擎版本分开。四个原生 Runner 先安装真实 ComfyUI CPU 环境，核对四种 OneYes 节点并运行本地工作流，测试通过后才构建。发布任务汇总 Windows x64 EXE、macOS ARM64 DMG / ZIP、Linux x64 / ARM64 AppImage / DEB / RPM，核对九个安装包并为八种 OTA 目标生成签名清单。

固定更新地址：`https://github.com/Pan-chongyu/oneyes-comfyui/releases/latest/download/comfy-latest.json`，Detached Ed25519 签名为 `.sig`。每种芯片及 Linux 安装格式独立选择；更新前验证清单签名与包 SHA-256。后台每六小时检查并下载，显示进度、失败重试、安装与自动重新打开；Windows 有独立可视化安装助手。保留断点续传与 Windows blockmap 校验；首版没有可适用的旧版增量基包。

历史 OTA 包按现有 updater 清理策略保留当前基包和正在下载的新版，其余清理。运行环境、模型、工作流、任务与 Key 位于用户数据目录，覆盖安装不会删除。macOS 应用使用 ad-hoc 签名，未经过 Apple 公证；OTA 密码学验证与 Apple 公证是不同机制。

不要手工覆盖正式 Release 包。发布完成后必须核对公开固定地址签名、九个安装包与应用中心下载 SHA-256。
