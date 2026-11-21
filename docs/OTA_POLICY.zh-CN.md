# OneYes ComfyUI OTA

此应用拥有独立的公开仓库和签名身份，不复用或更换 OneYes Desktop / Canvas 的签名密钥。公钥固定在 `desktop/update-key.cjs`。私钥仅保存在本机忽略目录与 GitHub Actions Secret `COMFY_OTA_PRIVATE_KEY`。

正式构建由 `.github/workflows/oneyes-desktop.yml` 按 `oneyes-vX.Y.Z` 标签启动，并使用相同标签发布 Release，与上游引擎版本分开。四个原生 Runner 先安装真实 ComfyUI CPU 环境，核对四种 OneYes 节点并运行本地工作流，测试通过后才构建。发布任务汇总 Windows x64 EXE、macOS ARM64 DMG / ZIP、Linux x64 / ARM64 AppImage / DEB / RPM，核对九个安装包并为八种 OTA 目标生成签名清单。

固定更新地址：`https://github.com/Pan-chongyu/oneyes-comfyui/releases/latest/download/comfy-latest.json`，Detached Ed25519 签名为 `.sig`。每种芯片及 Linux 安装格式独立选择；更新前验证清单签名与包 SHA-256。后台每六小时检查并下载，显示进度、失败重试、安装与自动重新打开；Windows 有独立可视化安装助手。保留断点续传与 Windows blockmap 校验；首版没有可适用的旧版增量基包。

历史 OTA 包按现有 updater 清理策略保留当前基包和正在下载的新版，其余清理。从 0.1.5 起，完整独立 Python、CPU 依赖和前端随安装包及 OTA 一起提供，不再在用户电脑下载依赖；模型、工作流、任务与 Key 仍位于用户数据目录，覆盖安装不会删除。旧版用户目录的运行环境不再使用，原数据保留。macOS 应用使用 ad-hoc 签名，未经过 Apple 公证；OTA 密码学验证与 Apple 公证是不同机制。

发布前同时运行账号服务测试与 `npm run test:account-ui`，验证登录、二次验证、Key 分组选择、复用客户端、切换账号和 IPC 来源限制；在四个平台通过后再打包。账号会话独立加密保存在用户数据目录，与现有 Key 一起在覆盖更新后保留，不随程序包分发。

不要手工覆盖正式 Release 包。发布完成后必须核对公开固定地址签名、九个安装包与应用中心下载 SHA-256。

发布前运行 `npm run prepare:desktop`、`npm run prepare:runtime`；后者只在构建阶段下载并组装固定 Python 3.12.16 与依赖。四个平台必须通过移动到中文 / 空格路径后的离线冷启动测试，并执行全部四类 OneYes 节点和原生工作流。打包后再次导入资源目录内的 PyTorch / 前端依赖，验证实际使用私有 Python 目录；macOS 额外验证启动依赖后签名仍有效。客户端不在应用包内写入 Python 字节码，缓存保存在用户目录。

macOS 的 ad-hoc 签名使用 `scripts/sign-macos.cjs` 顺序扫描 Mach-O 文件并从内到外签名，不将图片、文档或 Python 字节码当作可执行程序；全部资源由最外层应用签名封存，最后执行 `codesign --verify --deep --strict`。

Windows 安装器在安装及静默 OTA 更新后发送 Shell 图标刷新通知；应用身份、安装目录和签名公钥保持一致，旧版本可直接升级到使用 ComfyUI Logo 的新版。
