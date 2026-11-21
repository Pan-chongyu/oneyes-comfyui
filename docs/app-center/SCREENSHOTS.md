# 应用中心截图来源

以下截图实拍自 OneYes ComfyUI 0.1.11（源码 `1b497a8`），使用 Windows x64 桌面程序、随包运行环境和独立空白用户目录，画面尺寸均为 1440 × 960。没有使用真实账号、API Key 或付费请求。

| 截图 | 展示内容 |
| --- | --- |
| `image-workflow-69b9077efef5.webp` | 图片加载 → 原生 GPT 图片节点 → 保存图片。展示参考图编辑的连接和参数；未执行云端生成，保存节点不展示虚构结果。 |
| `standalone-account-105fde7901d7.webp` | 原生“设置 → 用户”内的 OneYes 独立登录、网站登录、注册与找回密码入口。 |
| `encrypted-keys-db521fe45e63.webp` | 手动 Key 配置与本机加密说明。输入框为空，未使用真实密钥。 |
| `local-workflow-105754a130a0.webp` | 图片加载 → Canny 边缘检测 → 预览图片。已在本机实际运行，右侧为本次本地计算的结果。 |

截图由 Electron 捕获实际应用内容，以无损 WebP 保存；文件名末尾为文件 SHA-256 的前 12 位。应用中心使用固定 Git 提交链接，不跟随分支内容漂移。后续增加或替换截图时，应同步记录对应版本、来源和实际执行范围。

参考图片来自 [Comfy Org 官方工作流模板的示例素材](https://github.com/Comfy-Org/workflow_templates/blob/main/input/hairstyle_makeup_base_gpt_image25.png)，按该项目 [MIT 许可](https://github.com/Comfy-Org/workflow_templates/blob/main/LICENSE)使用；完整声明见同目录 [WORKFLOW-TEMPLATES-LICENSE.txt](WORKFLOW-TEMPLATES-LICENSE.txt)。ComfyUI 名称与图标归其权利人所有，OneYes ComfyUI 为独立的社区派生版本。
