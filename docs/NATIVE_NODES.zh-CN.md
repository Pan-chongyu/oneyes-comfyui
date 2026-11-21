# 原版节点与 OneYes

画布、队列、工作流文件、本地模型节点和自定义节点沿用 ComfyUI。下面的 19 个原版节点保留节点 ID、输入插槽和输出类型，由 OneYes 扩展接管云端请求；无需 Comfy 账号或 Comfy 积分。

| 原版节点 | OneYes 接口 | Key 用途 |
| --- | --- | --- |
| OpenAIGPTImage1、OpenAIGPTImageNodeV2 / V3 | 异步图片生成 / 编辑 | OpenAI / 通用图片 |
| OpenAIChatNode、OpenAIInputFiles、OpenAIChatConfig | Responses，支持图片、文件和高级选项 | OpenAI / 通用图片 |
| ClaudeNode | Anthropic Messages，支持多图、系统提示和推理参数 | Claude |
| GeminiNode、GeminiNodeV2 / V3、GeminiInputFiles | Gemini generateContent，支持文字、图片、音频、视频和文件 | Gemini |
| GeminiImageNode、GeminiImage2Node、GeminiNanoBanana2、GeminiNanoBanana2V2 | Gemini generateContent 图片模式，保留尺寸、比例、思考结果与文字输出 | Gemini |
| GrokImageNode、GrokImageEditNode / V2 | Grok 图片生成 / 编辑 | Grok 图片 |
| GrokVideoNode | Grok 视频生成与任务查询 | Grok 视频，选择 Video 分组 |

原来的 4 个 OneYes 节点继续提供通用 Chat Completions、异步生图、参考图编辑与原图片任务取回。通用文字 Key 可使用 DeepSeek，与原版 ChatGPT 的 Responses 接口独立。

## 原版本地节点与依赖

安装包保留原版全部内置本地节点；本版本核对 703 个本地节点可注册。构建时安装原版 `requirements.txt`（含 Kornia、Spandrel、PyAV、SciPy、PyOpenGL、ANGLE 等），并补齐 Python 3.12 上 SPZ v4 所需的 `backports.zstd`。依赖随四个平台的安装包及签名 OTA 分发，不在用户启动或执行节点时临时运行 pip。

发布检查逐项核对原版扩展的节点注册，并在移动到中文／空格路径后断网执行图像过滤、原版超分模型加载与放大、FLAC／MP3／Opus 编解码、视频编码／解码、SPZ v4 点云导入与 PLY 导出。测试使用合成素材和临时小模型，不下载权重。

模型权重需按原版放入对应目录；缺少权重与缺少 Python 包是两种情况。本版内置 CPU PyTorch，不将 CUDA 专用加速库、非商业超分扩展架构或第三方自定义节点包视为原版必备依赖；这些节点包仍由用户按其要求安装。

## 使用

1. 从右上角 OneYes 账号按钮登录或复用客户端登录态。首次连接自动复用已有的对应平台 Key；手动配置保持不变。缺少平台 Key 时可在“设置 → 用户 → 账户与 Key”选择现有 Key，或直接登录后为可用分组新建。
2. 搜索原版节点名称，或导入包含上述节点的原工作流。点击节点内“选择 OneYes 模型”，读取当前分组权限并刷新原生模型列表。选择后仍使用原版参数面板与插槽连线。
3. 参数能力与模型可用性以 OneYes 当前分组为准。未授权模型在付费提交前提示更换 Key 或模型；不会自动换模型或降低分辨率。

参考图片按原尺寸编码；遮罩透明度、GPT 图片涂鸦层、输出透明通道均保留。多张输出尺寸不同时，批次补齐画布，不缩放原图。GPT V2 / V3 的动态模型面板和种子参与任务去重。

GPT 图片保存原回执，可在重启后保持参数和种子重新运行，或用原图片任务取回节点恢复。Grok 视频保持参数、种子和 Key 重新运行，只查询原任务并使用本机结果缓存。取消或断网不会自动重发付费请求；未收到提交回执时，应先在官网核对。Gemini 和 Grok 同步图片接口未提供可恢复回执，不声称支持跨重启恢复。

## 范围

适配层仅调用固定的 OneYes 域名，图片与视频下载不携带 Key；Key 只在本机加密保存，不写入工作流。保留 ComfyUI 应用图标，原登录入口改为 OneYes。注册和找回密码打开 OneYes 官网。

尚未接入的其他原版付费供应商节点继续禁用；ElevenLabs 按下文保留工作流定义，不会将 OneYes 登录伪装成 Comfy 登录。Grok 图片等接口只有在 OneYes 对应分组实际提供模型时才能调用。不能把全部原版付费节点视为已兼容；GIF、SVG、原版视频编辑 / 延长、其他供应商专有接口需分别适配。OneYes 不提供的模型能力不会由本机补造。

四个平台的真实引擎测试在隔离目录验证这些节点的原版契约、五种请求协议、平台 Key、参考图、遮罩、涂鸦、透明通道和原任务恢复；使用本机测试传输，不产生收费生成。

## ElevenLabs 工作流

从 0.1.9 起保留原版 8 个 ElevenLabs 节点定义，包括音色选择、文本转语音、声音克隆、语音转写、语音隔离、音效、变声和多人对话。保留原节点 ID、动态参数和音色插槽，导入旧工作流不会再将它们误报为缺包或引擎版本过低。音色选择器只查询内置映射，可离线使用。

OneYes 当前可用分组未提供 ElevenLabs 模型，两个 OneYes 域名的标准音色接口 `/v1/voices` 均返回 404。因此其余 7 个云端节点标注“暂未接入”，运行前可查看原因；运行时明确报出接口缺失，不调用原 Comfy 代理，也不上传声音样本。安装 pip 包、Manager 或升级引擎不能补出上游接口。恢复节点定义不代表语音生成和克隆已经可用，需 OneYes 上游提供相应协议后再适配。

发布验证覆盖原节点契约、全部本地音色、含这三个节点的真实前端工作流导入、参数与连线恢复，以及云端操作在读取密钥或上传前停止。
