OneYes ComfyUI 首个桌面版本，基于 ComfyUI 0.46.0。

- OneYes 文字生成、异步文生图、参考图编辑、原图片任务取回四种节点。
- 默认 Key 与独立图片 / 文字 Key；本机 AES-256-GCM 加密，不写入工作流，不调用 macOS 钥匙串。
- 当前 Key 的完整模型列表、搜索和选择；优先 oneyes.ai 直连线路。
- 异步任务持久保存回执，重启、断网后继续查询原任务，不自动重新发送付费生成请求。参考图按原尺寸二进制上传。
- 自动安装独立 Python 与 CPU 依赖，首次启动需要联网下载；不需要用户手动安装 Python 或 Git。保留 ComfyUI 原有本地模型与自定义节点。
- Windows x64、macOS Apple Silicon、Linux x64 / ARM64 原生安装包；Intel Mac 和 Windows ARM 不在首版支持范围。
- 独立 Ed25519 签名 OTA、下载进度、校验和更新后重新打开。macOS 当前为 ad-hoc 自签名，未经过 Apple 公证。

安装包文件名标注系统与架构。Linux 可选 AppImage、DEB、RPM。完整 GPL 对应源码见 Source.tar.gz；第三方授权见仓库 docs/THIRD_PARTY.md。
