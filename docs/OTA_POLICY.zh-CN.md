# OneYes ComfyUI OTA

此应用拥有独立的公开仓库和签名身份，不复用或更换 OneYes Desktop / Canvas 的签名密钥。公钥固定在 `desktop/update-key.cjs`。私钥仅保存在本机忽略目录与 GitHub Actions Secret `COMFY_OTA_PRIVATE_KEY`。

正式构建由 `.github/workflows/oneyes-desktop.yml` 按 `oneyes-vX.Y.Z` 标签启动，并使用相同标签发布 Release，与上游引擎版本分开。四个原生 Runner 先安装真实 ComfyUI CPU 环境，核对四种 OneYes 节点、19 个原版节点适配与本地工作流，测试通过后才构建。发布任务汇总 Windows x64 EXE、macOS ARM64 DMG / ZIP、Linux x64 / ARM64 AppImage / DEB / RPM，核对九个安装包并为八种 OTA 目标生成签名清单。

固定更新地址：`https://github.com/Pan-chongyu/oneyes-comfyui/releases/latest/download/comfy-latest.json`，Detached Ed25519 签名为 `.sig`。每种芯片及 Linux 安装格式独立选择；更新前验证清单签名与包 SHA-256。后台每六小时检查并下载，显示进度、失败重试、安装与自动重新打开；Windows 有独立可视化安装助手。保留断点续传与 Windows blockmap 校验；首版没有可适用的旧版增量基包。

历史 OTA 包按现有 updater 清理策略保留当前基包和正在下载的新版，其余清理。从 0.1.5 起，完整独立 Python、CPU 依赖和前端随安装包及 OTA 一起提供，不再在用户电脑下载依赖；模型、工作流、任务与 Key 仍位于用户数据目录，覆盖安装不会删除。旧版用户目录的运行环境不再使用，原数据保留。macOS 应用使用 ad-hoc 签名，未经过 Apple 公证；OTA 密码学验证与 Apple 公证是不同机制。

发布前同时运行账号服务测试与 `npm run test:account-ui`，启动真实 ComfyUI，验证免登录直达画布、原生用户页与菜单入口、登录、二次验证、Key 分组选择、复用客户端、切换账号和 IPC 来源限制；在四个平台通过后再打包。账号会话独立加密保存在用户数据目录，与现有 Key 一起在覆盖更新后保留，不随程序包分发。

不要手工覆盖正式 Release 包。发布完成后必须核对公开固定地址签名、九个安装包与应用中心下载 SHA-256。

应用中心介绍和截图按用户长期要求固定维护，基线位于 `docs/app-center/listing.json`，截图使用已提交的固定版本链接。后续同步使用 `scripts/catalog-entry.mjs` 的 `catalogRelease`，读取现有应用后只更新版本、下载包和检测版本；摘要、用途、使用步骤、截图及说明、图标、安装方式与排序全部保留，不以仓库模板覆盖管理后台的人工维护内容。`catalogPresentation` 仅在用户明确要求修改介绍时使用，不能在常规发布路径调用。资料更新不需要更改客户端版本，正式安装包及 OTA 保持原有签名。

发布前运行 `npm run prepare:desktop`、`npm run prepare:runtime`、`npm run prepare:frontend`；运行环境准备只在构建阶段下载并组装固定 Python 3.12.16 与依赖。四个平台必须通过移动到中文 / 空格路径后的离线冷启动测试，并执行全部四类 OneYes 节点和原生工作流。打包后再次导入资源目录内的 PyTorch / 前端依赖，验证实际使用私有 Python 目录；macOS 额外验证启动依赖后签名仍有效。客户端不在应用包内写入 Python 字节码，缓存保存在用户目录。

macOS 的 ad-hoc 签名使用 `scripts/sign-macos.cjs` 顺序扫描 Mach-O 文件并从内到外签名，不将图片、文档或 Python 字节码当作可执行程序；全部资源由最外层应用签名封存，最后执行 `codesign --verify --deep --strict`。

Windows 安装器在安装及静默 OTA 更新后发送 Shell 图标刷新通知；应用身份、安装目录和签名公钥保持一致，旧版本可直接升级到使用 ComfyUI Logo 的新版。

从 0.1.8 起，补齐原版 SPZ v4 点云导入所需的 Zstandard 依赖；要求四个平台在离线搬移后的真实引擎中逐项核对全部原版内置扩展注册，并执行依赖 Kornia、Spandrel、PyAV 和 Zstandard 的代表性节点。打包后再验证包内 Zstandard 可压缩／解压，防止开发环境有包而安装包漏包。依赖变化纳入现有运行环境指纹，旧版环境不能被误判为已经准备完成。

从 0.1.9 起，四个平台额外验证 8 个 ElevenLabs 原版节点定义、工作流导入和本地音色选择器。OneYes 尚未提供的 7 个语音操作保留契约并明确标注不可用，不执行原 Comfy API，也不把它们计为已经接入 OneYes 的生成节点。修复随引擎和前端扩展进入同一签名 OTA。

从 0.1.10 起，菜单退出、Command-Q、系统退出和 OTA 重启均先处理工作流的关闭拦截；用户取消时保留引擎和更新器，确认关闭所有窗口后才停止更新器与后台引擎。清理只执行一次，启动期间退出会等待启动收尾，避免新建遗留进程。四个平台的真实桌面测试必须验证缩到托盘、重新打开、取消退出后本地接口仍可访问，以及确认退出后引擎已停止、程序进程正常结束。

从 0.1.6 起不再提供独立启动设置窗口。单窗口加载引擎后直接显示 ComfyUI 画布，原生“设置 → 用户”集中账户、Key、模型和任务。从 0.1.16 起，软件版本与更新移到“设置 → 关于”，菜单及托盘检查更新跳转到同一页面，保留状态推送、下载进度、安装并重新打开与失败重试。构建阶段从固定 1.59.10 前端生成定制用户及关于面板；预期模块或导出变化时停止构建，禁止静默丢失界面。四个平台验证侧栏与菜单跳转、更新状态及操作按钮，打包后检查关于面板及其模板随同引擎进入安装包和签名 OTA。

从 0.1.7 起右上角账号按钮与原登录弹窗入口统一为 OneYes。四个平台必须测试实际点击账号按钮、登录状态与余额更新、固定注册／找回密码链接、上游登录入口重定向。OneYes 会话不写入 Comfy Org 身份存储，不会解锁其付费 API 节点。

同一版本的原版节点适配由 OneYes 扩展注册原节点 ID，保留参数与输出类型；仅扩展层发起 OneYes 请求，不修改核心推理实现。发布前测试 OpenAI 异步图片 / Responses、Anthropic Messages、Gemini generateContent、Grok 图片 / 视频协议，核对平台 Key、原尺寸参考图、遮罩、涂鸦、透明通道、重启恢复与不重复提交。缺少上游能力的供应商不冒充可用节点。模型 / 账号缓存、加密 Key 与原任务文件在 OTA 覆盖升级后保留。
