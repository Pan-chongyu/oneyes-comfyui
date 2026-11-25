"""Native ComfyUI node contracts with OneYes-owned credentials and transport."""
import asyncio
import base64
from copy import deepcopy
from io import BytesIO
from pathlib import Path
from urllib.parse import quote

import numpy as np
from PIL import Image
import torch

import comfy.model_management
import folder_paths
from comfy_api.latest import io, InputImpl
from comfy_api_nodes import nodes_openai as openai, nodes_anthropic as anthropic, nodes_gemini as gemini, nodes_grok as grok, nodes_bytedance as bytedance
from comfy_api_nodes.apis.gemini import GeminiGenerateContentResponse

from .routes import client
from .service import OneYesError


interrupt = comfy.model_management.throw_exception_if_processing_interrupted


def png(tensor):
    image = Image.fromarray(np.clip(tensor.cpu().numpy() * 255, 0, 255).astype(np.uint8))
    stream = BytesIO()
    image.save(stream, "PNG")
    return stream.getvalue()


def references(images):
    values = images.values() if isinstance(images, dict) else images if isinstance(images, list) else [images]
    return [png(frame) for tensor in values if tensor is not None for frame in (tensor if tensor.ndim == 4 else [tensor])]


def batch(images):
    if not images:
        return None
    rgba = any("A" in image.getbands() or "transparency" in image.info for image in images)
    mode = "RGBA" if rgba else "RGB"
    width, height = max(image.width for image in images), max(image.height for image in images)
    tensors = []
    for image in images:
        canvas = Image.new(mode, (width, height))
        canvas.paste(image.convert(mode), (0, 0))
        tensors.append(torch.from_numpy(np.asarray(canvas).copy().astype(np.float32) / 255))
    return torch.stack(tensors)


async def image_sources(sources):
    images = []
    for source in sources:
        interrupt()
        if source.get("b64_json"):
            raw = base64.b64decode(source["b64_json"], validate=True)
        elif source.get("url"):
            raw = await client.download(source["url"])
        else:
            raise OneYesError("没有取得图片原件，请在官网检查原请求")
        with Image.open(BytesIO(raw)) as image:
            images.append(image.copy())
    return batch(images)


class NativeNode:
    profile = "image"
    model_prefixes = ()
    model_includes = ()
    model_excludes = ()

    @classmethod
    def supports_model(cls, value):
        value = value.lower()
        return value.startswith(cls.model_prefixes) and (not cls.model_includes or any(term in value for term in cls.model_includes)) and not any(term in value for term in cls.model_excludes)

    @classmethod
    def define_schema(cls):
        schema = super().define_schema()
        schema.is_api_node = False
        schema.price_badge = None
        schema.hidden = [item for item in schema.hidden or [] if item not in (io.Hidden.auth_token_comfy_org, io.Hidden.api_key_comfy_org)]
        schema.description = "通过 OneYes 调用，保留原版节点输入和输出。请在 OneYes 设置中配置对应平台的 Key；费用以 OneYes 为准。\n" + (schema.description or "")
        schema.is_deprecated = False
        for item in schema.inputs:
            if item.id != "model":
                continue
            models = [value for value in client.cached_models(cls.profile) if cls.supports_model(value)]
            if isinstance(item, io.DynamicCombo.Input):
                existing = {option.key for option in item.options}
                aliases = anthropic.CLAUDE_MODELS if cls.profile == 'claude' else gemini.GEMINI_TEXT_MODELS if cls.profile == 'gemini' else {}
                for value in models:
                    if value in existing:
                        continue
                    template = next((option for option in item.options if aliases.get(option.key) == value), item.options[0])
                    item.options.append(io.DynamicCombo.Option(value, deepcopy(template.inputs)))
            elif isinstance(item, io.Combo.Input):
                item.options = list(dict.fromkeys([*item.options, *models]))
        return schema


async def gpt_image(model, prompt, size, quality, seed, images=None, mask=None, n=1, background="opaque", complexity=None, markup=None):
    if model not in (await client.connection("image"))["models"]:
        raise OneYesError("当前 OpenAI Key 无此模型权限，请在节点中选择 OneYes 可用模型")
    files = references(images) if images is not None else []
    mask_file = None
    if mask is not None:
        if not files:
            raise OneYesError("使用遮罩时请连接参考图")
        if mask.ndim == 3:
            mask = mask[0]
        with Image.open(BytesIO(files[0])) as first:
            if first.size != (mask.shape[1], mask.shape[0]):
                raise OneYesError("遮罩和第一张参考图尺寸需一致，请使用同一张图的遮罩")
        rgba = Image.new("RGBA", (mask.shape[1], mask.shape[0]))
        rgba.putalpha(Image.fromarray(np.clip((1 - mask.cpu().numpy()) * 255, 0, 255).astype(np.uint8)))
        stream = BytesIO(); rgba.save(stream, "PNG"); mask_file = stream.getvalue()
    options = {"n": n, "background": background}
    if complexity is not None:
        options["complexity"] = complexity
    result, _ = await client.image(model, prompt, size, quality, seed, files, interrupt, options=options, mask=mask_file, markup=markup)
    return io.NodeOutput(batch(result))


def image_size(model):
    size = model.get("size", "auto")
    return f'{model["custom_width"]}x{model["custom_height"]}' if size == "Custom" else size


class GPTImage(NativeNode, openai.OpenAIGPTImage1):
    model_prefixes = ("gpt-image",)

    @classmethod
    async def execute(cls, prompt, seed=0, quality="low", background="opaque", image=None, mask=None, n=1, size="1024x1024", custom_width=1024, custom_height=1024, model="gpt-image-2"):
        if size == "Custom":
            size = f"{custom_width}x{custom_height}"
        return await gpt_image(model, prompt, size, quality, seed, image, mask, n, background)


class GPTImageV2(NativeNode, openai.OpenAIGPTImageNodeV2):
    model_prefixes = ("gpt-image",)

    @classmethod
    async def execute(cls, prompt, model, n, seed):
        return await gpt_image(model["model"], prompt, image_size(model), model["quality"], seed, model.get("images"), model.get("mask"), n, model["background"], model.get("complexity"))


class GPTImageV3(NativeNode, openai.OpenAIGPTImageNodeV3):
    model_prefixes = ("gpt-image",)

    @classmethod
    async def execute(cls, model):
        images = list((model.get("images") or {}).values())
        markup, alpha = model.get("markup"), model.get("markup_alpha")
        layer = None
        if (markup is None) != (alpha is None):
            raise OneYesError("请同时连接涂鸦图片和涂鸦遮罩")
        if markup is not None and alpha.any():
            if not images:
                raise OneYesError("使用涂鸦时请连接参考图")
            if markup.shape[0] != 1 or alpha.shape[0] != 1 or markup.shape[1:3] != alpha.shape[1:3]:
                raise OneYesError("涂鸦图片与遮罩尺寸需一致")
            layer = png(torch.cat([markup[..., :3].cpu(), alpha.cpu().unsqueeze(-1)], dim=-1)[0])
        return await gpt_image(model["model"], model["prompt"], image_size(model), model["quality"], model["seed"], images, n=1, background=model["background"], complexity=model.get("complexity"), markup=layer)


class ChatGPT(NativeNode, openai.OpenAIChatNode):
    model_prefixes = ("gpt-", "chatgpt-", "o1", "o3", "o4")
    model_excludes = ("image", "tts", "transcribe", "realtime")

    @classmethod
    async def execute(cls, prompt, persist_context=False, model="gpt-5", images=None, files=None, advanced_options=None):
        contents = [{"type": "input_text", "text": prompt}]
        contents.extend({"type": "input_image", "image_url": "data:image/png;base64," + base64.b64encode(raw).decode(), "detail": "auto"} for raw in references(images) if images is not None)
        contents.extend(item.model_dump(exclude_none=True) for item in files or [])
        payload = {"model": model, "input": [{"role": "user", "content": contents}], "store": True, "stream": False}
        if advanced_options is not None:
            payload.update(advanced_options.model_dump(exclude_none=True))
        interrupt()
        response = await client.generate("image", "/responses", payload)
        origin = (await client.connection("image"))["origin"]
        while response.get("status") in ("queued", "in_progress"):
            interrupt()
            await asyncio.sleep(3)
            response, _ = await client.request(origin, "/responses/" + quote(response["id"], safe=""), client.vault.key("image"))
        if response.get("error") or response.get("status") in ("failed", "cancelled"):
            raise OneYesError("文字任务未完成，请在 OneYes 查看原请求")
        text = "\n".join(part.get("text", "") for item in response.get("output", []) for part in item.get("content", []) if part.get("type") == "output_text")
        if not text:
            raise OneYesError("此模型没有返回文字，请检查模型权限和参数")
        return io.NodeOutput(text)


class Claude(NativeNode, anthropic.ClaudeNode):
    profile = "claude"
    model_prefixes = ("claude-",)

    @classmethod
    async def execute(cls, prompt, model, seed, images=None, system_prompt=""):
        label = model["model"]
        model_id = anthropic.CLAUDE_MODELS.get(label, label)
        label = next((name for name, value in anthropic.CLAUDE_MODELS.items() if value == model_id), label)
        content = [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(raw).decode()}} for raw in references(images) if images is not None]
        content.append({"type": "text", "text": prompt})
        payload = {"model": model_id, "max_tokens": model.get("max_tokens", 32768), "messages": [{"role": "user", "content": content}], "stream": False}
        if system_prompt:
            payload["system"] = system_prompt
        effort = model.get("reasoning_effort", "off")
        if label in anthropic._ALWAYS_THINKING_MODELS:
            payload["output_config"] = {"effort": effort}
        elif effort not in ("off", None) and label not in anthropic._THINKING_UNSUPPORTED:
            payload.update(thinking={"type": "adaptive"}, output_config={"effort": effort})
        elif label in anthropic._EXPLICIT_THINKING_OFF_MODELS:
            payload["thinking"] = {"type": anthropic._EXPLICIT_THINKING_OFF_MODELS[label]}
        if label not in anthropic._NO_TEMPERATURE_MODELS and "thinking" not in payload and label not in anthropic._ALWAYS_THINKING_MODELS:
            payload["temperature"] = model.get("temperature", 1)
        interrupt()
        response = await client.generate("claude", "/messages", payload)
        text = "\n".join(part.get("text", "") for part in response.get("content", []) if part.get("type") == "text")
        if not text:
            raise OneYesError("Claude 没有返回文字，请在 OneYes 检查原请求")
        return io.NodeOutput(text)


def gemini_parts(prompt, images=None, files=None, audios=None, videos=None, video_processing=None):
    parts = [{"text": prompt}]
    parts.extend({"inlineData": {"mimeType": "image/png", "data": base64.b64encode(raw).decode()}} for raw in references(images) if images is not None)
    parts.extend(item.model_dump(mode="json", exclude_none=True) for item in files or [])
    for audio in audios or []:
        parts.extend(part.model_dump(mode="json", exclude_none=True) for part in gemini.create_audio_parts(audio))
    for video in videos or []:
        for part in gemini.create_video_parts(video):
            value = part.model_dump(mode="json", exclude_none=True)
            if video_processing == "agentic":
                value["mediaProcessing"] = "AGENTIC"
            parts.append(value)
    return parts


async def gemini_generate(model, prompt, config, images=None, files=None, system="", audios=None, videos=None, video_processing=None):
    payload = {"contents": [{"role": "user", "parts": gemini_parts(prompt, images, files, audios, videos, video_processing)}], "generationConfig": config}
    if system:
        payload["systemInstruction"] = {"parts": [{"text": system}]}
    interrupt()
    response = await client.generate("gemini", "/models/" + quote(model, safe="") + ":generateContent", payload, gemini=True, model=model)
    return GeminiGenerateContentResponse.model_validate(response)


def gemini_model(value):
    return {"Nano Banana 2 (Gemini 3.1 Flash Image)": "gemini-3.1-flash-image", "Nano Banana 2 Lite": "gemini-3.1-flash-lite-image", "Gemini Nano Banana 2.1": "gemini-nano-banana-2.1"}.get(value, gemini.GEMINI_TEXT_MODELS.get(value, value))


async def gemini_image(model, prompt, images, files, aspect_ratio, resolution, modalities, system, thinking=None, temperature=None, top_p=None):
    image_config = {}
    if resolution:
        image_config["imageSize"] = resolution
    if aspect_ratio and aspect_ratio != "auto":
        image_config["aspectRatio"] = aspect_ratio
    config = {"responseModalities": ["IMAGE"] if modalities == "IMAGE" else ["TEXT", "IMAGE"], "imageConfig": image_config}
    if thinking:
        config["thinkingConfig"] = {"thinkingLevel": thinking}
    if temperature is not None:
        config["temperature"] = temperature
    if top_p is not None:
        config["topP"] = top_p
    response = await gemini_generate(gemini_model(model), prompt, config, images, files, system)
    output, thoughts = [], []
    for candidate in response.candidates or []:
        for part in candidate.content.parts if candidate.content else []:
            data = part.inlineData
            if data and str(data.mimeType.value if hasattr(data.mimeType, "value") else data.mimeType).startswith("image/"):
                with Image.open(BytesIO(base64.b64decode(data.data, validate=True))) as image:
                    (thoughts if part.thought else output).append(image.copy())
    return batch(output), gemini.get_text_from_response(response), batch(thoughts)


class GeminiImage(NativeNode, gemini.GeminiImage):
    profile = "gemini"
    model_prefixes = ("gemini-", "nano-banana")
    model_includes = ("image", "nano-banana")

    @classmethod
    async def execute(cls, prompt, model, seed, images=None, files=None, aspect_ratio="auto", response_modalities="IMAGE+TEXT", system_prompt=""):
        image, text, _ = await gemini_image(model, prompt, images, files, aspect_ratio, None, response_modalities, system_prompt)
        return io.NodeOutput(image, text)


class GeminiImage2(NativeNode, gemini.GeminiImage2):
    profile = "gemini"
    model_prefixes = ("gemini-", "nano-banana")
    model_includes = ("image", "nano-banana")

    @classmethod
    async def execute(cls, prompt, model, seed, aspect_ratio, resolution, response_modalities, images=None, files=None, system_prompt=""):
        image, text, _ = await gemini_image(model, prompt, images, files, aspect_ratio, resolution, response_modalities, system_prompt)
        return io.NodeOutput(image, text)


class NanoBanana(NativeNode, gemini.GeminiNanoBanana2):
    profile = "gemini"
    model_prefixes = ("gemini-", "nano-banana")
    model_includes = ("image", "nano-banana")

    @classmethod
    async def execute(cls, prompt, model, seed, aspect_ratio, resolution, response_modalities, thinking_level, images=None, files=None, system_prompt=""):
        return io.NodeOutput(*await gemini_image(model, prompt, images, files, aspect_ratio, resolution, response_modalities, system_prompt, thinking_level))


class NanoBananaV2(NativeNode, gemini.GeminiNanoBanana2V2):
    profile = "gemini"
    model_prefixes = ("gemini-", "nano-banana")
    model_includes = ("image", "nano-banana")

    @classmethod
    async def execute(cls, prompt, model, seed, response_modalities, system_prompt="", temperature=1, top_p=0.95):
        if model["model"] == "Gemini Nano Banana 2.1":
            temperature = top_p = None
        return io.NodeOutput(*await gemini_image(model["model"], prompt, model.get("images"), model.get("files"), model["aspect_ratio"], model["resolution"], response_modalities, system_prompt, model.get("thinking_level"), temperature, top_p))


async def gemini_text(model, prompt, seed, system, images=None, files=None, audios=None, videos=None, options=None, video_processing=None):
    config = {"seed": seed, **(options or {})}
    response = await gemini_generate(gemini_model(model), prompt, config, images, files, system, audios, videos, video_processing)
    text = gemini.get_text_from_response(response)
    if not text:
        raise OneYesError("Gemini 没有返回文字，请在 OneYes 检查原请求")
    return io.NodeOutput(text)


class GeminiText(NativeNode, gemini.GeminiNode):
    profile = "gemini"
    model_prefixes = ("gemini-",)
    model_excludes = ("image", "omni", "tts")

    @classmethod
    async def execute(cls, prompt, model, seed, images=None, audio=None, video=None, files=None, system_prompt=""):
        return await gemini_text(model, prompt, seed, system_prompt, images, files, [audio] if audio is not None else [], [video] if video is not None else [])


class GeminiTextV2(NativeNode, gemini.GeminiNodeV2):
    profile = "gemini"
    model_prefixes = ("gemini-",)
    model_excludes = ("image", "omni", "tts")

    @classmethod
    async def execute(cls, prompt, model, seed, system_prompt=""):
        options = {"maxOutputTokens": model["max_output_tokens"], "thinkingConfig": {"thinkingLevel": model["thinking_level"]}}
        for key, value in (("temperature", model.get("temperature")), ("topP", model.get("top_p"))):
            if value is not None:
                options[key] = value
        return await gemini_text(model["model"], prompt, seed, system_prompt, model.get("images"), model.get("files"), list((model.get("audio") or {}).values()), list((model.get("video") or {}).values()), options, model.get("video_processing"))


class GeminiTextV3(NativeNode, gemini.GeminiNodeV3):
    profile = "gemini"
    model_prefixes = ("gemini-",)
    model_excludes = ("image", "omni", "tts")

    @classmethod
    async def execute(cls, model):
        return await GeminiTextV2.execute(model["prompt"], model, model["seed"], model.get("system_prompt") or "")


async def grok_image(model, prompt, aspect_ratio, count, seed, resolution, quality=None, images=None):
    payload = {"model": model, "prompt": prompt, "n": count, "seed": seed, "resolution": resolution.lower()}
    if aspect_ratio != "auto":
        payload["aspect_ratio"] = aspect_ratio
    if quality is not None:
        payload["quality"] = quality
    if images is not None:
        payload["images"] = [{"url": "data:image/png;base64," + base64.b64encode(raw).decode()} for raw in references(images)]
    interrupt()
    response = await client.generate("grok", "/images/edits" if images is not None else "/images/generations", payload)
    result = await image_sources(response.get("data", []))
    if result is None:
        raise OneYesError("Grok 没有返回图片，请在 OneYes 检查原请求")
    return io.NodeOutput(result)


class GrokImage(NativeNode, grok.GrokImageNode):
    profile = "grok"
    model_prefixes = ("grok-imagine-image",)

    @classmethod
    async def execute(cls, model, prompt, aspect_ratio, number_of_images, seed, resolution="1K", quality="medium"):
        return await grok_image(model, prompt, aspect_ratio, number_of_images, seed, resolution, quality)


class GrokImageEdit(NativeNode, grok.GrokImageEditNode):
    profile = "grok"
    model_prefixes = ("grok-imagine-image",)

    @classmethod
    async def execute(cls, model, image, prompt, resolution, number_of_images, seed, aspect_ratio="auto"):
        return await grok_image(model, prompt, aspect_ratio, number_of_images, seed, resolution, images=image)


class GrokImageEditV2(NativeNode, grok.GrokImageEditNodeV2):
    profile = "grok"
    model_prefixes = ("grok-imagine-image",)

    @classmethod
    async def execute(cls, prompt, model, seed):
        return await grok_image(model["model"], prompt, model.get("aspect_ratio", "auto"), model["number_of_images"], seed, model["resolution"], model.get("quality"), model.get("images"))


class GrokVideo(NativeNode, grok.GrokVideoNode):
    profile = "video"
    model_prefixes = ("grok-imagine-video",)

    @classmethod
    async def execute(cls, model, prompt, resolution, aspect_ratio, duration, seed, image=None):
        payload = {"model": model, "prompt": prompt, "resolution": resolution, "duration": duration, "seed": seed}
        if aspect_ratio != "auto":
            payload["aspect_ratio"] = aspect_ratio
        if image is not None:
            files = references(image)
            if len(files) != 1:
                raise OneYesError("此视频节点使用一张起始参考图，请先选择一张图片")
            payload["image"] = {"url": "data:image/png;base64," + base64.b64encode(files[0]).decode()}
        path = await client.video(payload, interrupt)
        return io.NodeOutput(InputImpl.VideoFromFile(str(path)))


class ByteDanceFirstLastFrame(NativeNode, bytedance.ByteDanceFirstLastFrameNode):
    profile = "video"
    model_prefixes = ("doubao-seedance-",)

    @classmethod
    def define_schema(cls):
        schema = super().define_schema()
        schema.description = "使用 OneYes Video 分组生成首尾帧视频，原节点 ID、参数与连线保持兼容。旧模板的 seedance-1-* 不自动换成其他计费模型；请点击“选择 OneYes 模型”选择当前 Key 可用的 doubao-seedance 模型。原图不缩放，任务回执保存在本机，保留参数重新运行可取回原视频。"
        model = next(item for item in schema.inputs if item.id == "model")
        models = [value for value in client.cached_models(cls.profile) if cls.supports_model(value)]
        model.options = list(dict.fromkeys([*model.options, "doubao-seedance-2.0"]))
        model.default = models[0] if models else "doubao-seedance-2.0"
        for item in schema.inputs:
            if item.id == "camera_fixed":
                item.tooltip = "通过提示词要求镜头固定；当前模型不接受独立 camera_fixed 参数，实际效果由模型决定。"
        return schema

    @classmethod
    async def execute(cls, model, prompt, first_frame, last_frame, resolution, aspect_ratio, duration, seed=0, camera_fixed=False, watermark=False, generate_audio=False):
        if not cls.supports_model(model) or model not in (await client.connection("video"))["models"]:
            raise OneYesError("当前 OneYes Video Key 未提供此首尾帧模型，请点击节点的“选择 OneYes 模型”选择可用的 doubao-seedance 模型；原设置已保留，未提交生成")
        frames = []
        for label, tensor in (("首帧", first_frame), ("尾帧", last_frame)):
            files = references(tensor)
            if len(files) != 1:
                raise OneYesError(f"{label}需要一张图片，请从图片批次中选择对应的一帧；未提交生成")
            frames.append("data:image/png;base64," + base64.b64encode(files[0]).decode())
        payload = {
            "model": model, "prompt": prompt + ("\n镜头固定，保持机位不移动。" if camera_fixed else ""),
            "first_frame": frames[0], "last_frame": frames[1], "resolution": resolution,
            "ratio": aspect_ratio, "duration": duration, "seed": seed,
            "watermark": watermark, "generate_audio": generate_audio,
        }
        path = await client.video(payload, interrupt, endpoint="/videos")
        return io.NodeOutput(InputImpl.VideoFromFile(str(path)))


def input_file(file, suffixes):
    root = Path(folder_paths.get_input_directory()).resolve()
    path = Path(folder_paths.get_annotated_filepath(file)).resolve()
    if not path.is_relative_to(root) or path.suffix.lower() not in suffixes or not path.is_file():
        raise OneYesError("请选择 input 目录中的受支持文件")
    return str(path)


class OpenAIFiles(openai.OpenAIInputFiles):
    @classmethod
    def execute(cls, file, OPENAI_INPUT_FILES=None):
        return io.NodeOutput([cls.create_input_file_content(input_file(file, (".txt", ".pdf"))), *(OPENAI_INPUT_FILES or [])])


class GeminiFiles(gemini.GeminiInputFiles):
    @classmethod
    def execute(cls, file, GEMINI_INPUT_FILES=None):
        return io.NodeOutput([cls.create_file_part(input_file(file, (".txt", ".pdf"))), *(GEMINI_INPUT_FILES or [])])


NATIVE_NODES = [GPTImage, GPTImageV2, GPTImageV3, ChatGPT, OpenAIFiles, openai.OpenAIChatConfig, Claude, GeminiText, GeminiTextV2, GeminiTextV3, GeminiFiles, GeminiImage, GeminiImage2, NanoBanana, NanoBananaV2, GrokImage, GrokImageEdit, GrokImageEditV2, GrokVideo, ByteDanceFirstLastFrame]
