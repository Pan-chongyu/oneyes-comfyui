import io as byte_io

import numpy as np
from PIL import Image
import torch

import comfy.model_management
from comfy_api.latest import ComfyExtension, io

from .routes import client


def output_images(images, task_id):
    return io.NodeOutput([torch.from_numpy(np.asarray(image).copy().astype(np.float32) / 255.0).unsqueeze(0) for image in images], task_id)


def image_inputs():
    return [
        io.String.Input("model", display_name="模型", default="gpt-image-1", tooltip="在节点的“选择 OneYes 模型”中选择当前 Key 可用的完整模型 ID"),
        io.String.Input("prompt", display_name="提示词", multiline=True),
        io.String.Input("size", display_name="尺寸", default="auto", tooltip="原样传递，例如 auto、1024x1024；不会自动降低分辨率"),
        io.Combo.Input("quality", display_name="质量", options=["auto", "low", "medium", "high"], default="auto"),
        io.Int.Input("seed", display_name="任务种子", default=0, min=0, max=2**53 - 1, control_after_generate=True, tooltip="种子用于本机任务去重，不是云端采样种子。更换种子创建新任务；保留种子可取回原任务。"),
    ]


class OneYesImage(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="OneYesImage", display_name="OneYes 文生图", category="OneYes/图片", inputs=image_inputs(), outputs=[io.Image.Output(display_name="图片", is_output_list=True), io.String.Output(display_name="本地任务编号")], description="异步生图，回执本机持久保存。重启后保持相同参数和种子，重新运行只取回原任务。")

    @classmethod
    async def execute(cls, model, prompt, size, quality, seed):
        images, task_id = await client.image(model, prompt, size, quality, seed, check_interrupt=comfy.model_management.throw_exception_if_processing_interrupted)
        return output_images(images, task_id)


class OneYesImageEdit(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="OneYesImageEdit", display_name="OneYes 参考图编辑", category="OneYes/图片", inputs=[io.Image.Input("images", display_name="参考图片"), *image_inputs()], outputs=[io.Image.Output(display_name="图片", is_output_list=True), io.String.Output(display_name="本地任务编号")], description="图片批次中的所有图片按原分辨率上传，不裁剪、不缩放。参考图数量和尺寸限制由所选模型决定。")

    @classmethod
    async def execute(cls, images, model, prompt, size, quality, seed):
        references = []
        for tensor in images:
            image = Image.fromarray(np.clip(tensor.cpu().numpy() * 255.0, 0, 255).astype(np.uint8))
            buffer = byte_io.BytesIO()
            image.save(buffer, format="PNG")
            references.append(buffer.getvalue())
        results, task_id = await client.image(model, prompt, size, quality, seed, references, comfy.model_management.throw_exception_if_processing_interrupted)
        return output_images(results, task_id)


class OneYesRecoverImage(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="OneYesRecoverImage", display_name="OneYes 取回原图片任务", category="OneYes/图片", inputs=[io.String.Input("task_id", display_name="本地任务编号", tooltip="从 OneYes 设置的任务列表复制；只查询原任务，不创建付费请求")], outputs=[io.Image.Output(display_name="图片", is_output_list=True), io.String.Output(display_name="本地任务编号")])

    @classmethod
    async def execute(cls, task_id):
        images, job_id = await client.recover(task_id, comfy.model_management.throw_exception_if_processing_interrupted)
        return output_images(images, job_id)


class OneYesText(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="OneYesText", display_name="OneYes 文字生成", category="OneYes/文字", inputs=[io.String.Input("model", display_name="模型", default="gpt-4.1-mini"), io.String.Input("prompt", display_name="提示词", multiline=True), io.String.Input("system", display_name="系统提示词", default="", multiline=True), io.Float.Input("temperature", display_name="温度", default=0.7, min=0, max=2, step=0.1)], outputs=[io.String.Output(display_name="文本")], description="调用 OneYes 的 OpenAI 兼容 Chat Completions 接口。模型使用当前 Key 的可用列表，不会自动换用其他付费模型。")

    @classmethod
    async def execute(cls, model, prompt, system, temperature):
        return io.NodeOutput(await client.text(model, prompt, system, temperature))


class OneYesExtension(ComfyExtension):
    async def get_node_list(self):
        return [OneYesImage, OneYesImageEdit, OneYesRecoverImage, OneYesText]


async def comfy_entrypoint():
    return OneYesExtension()
