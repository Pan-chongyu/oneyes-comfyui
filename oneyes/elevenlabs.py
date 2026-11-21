"""Preserve native ElevenLabs workflows while OneYes has no matching API."""
from comfy_api.latest import io
from comfy_api_nodes import nodes_elevenlabs as original

from .service import OneYesError


UNAVAILABLE_REASON = (
    "OneYes 当前尚未接入 ElevenLabs 语音生成、转写和声音克隆接口。"
    "节点参数与连线已保留，请等待 OneYes 开通对应接口后再运行；"
    "安装节点包、ComfyUI Manager 或升级引擎无法解决此接口缺失。"
)


class UnavailableElevenLabs:
    @classmethod
    def define_schema(cls):
        schema = super().define_schema()
        schema.is_api_node = False
        schema.price_badge = None
        schema.hidden = [item for item in schema.hidden or [] if item not in (io.Hidden.auth_token_comfy_org, io.Hidden.api_key_comfy_org)]
        schema.display_name += "（OneYes 暂未接入）"
        schema.description = UNAVAILABLE_REASON + "\n" + (schema.description or "")
        return schema

    @classmethod
    async def execute(cls, *args, **kwargs):
        raise OneYesError(UNAVAILABLE_REASON)


# Keep the original schemas, sockets and IDs; never execute Comfy's paid proxy.
UNAVAILABLE_NODES = [type(node.__name__, (UnavailableElevenLabs, node), {"__module__": __name__}) for node in (
    original.ElevenLabsSpeechToText,
    original.ElevenLabsTextToSpeech,
    original.ElevenLabsAudioIsolation,
    original.ElevenLabsTextToSoundEffects,
    original.ElevenLabsInstantVoiceClone,
    original.ElevenLabsSpeechToSpeech,
    original.ElevenLabsTextToDialogue,
)]
ELEVENLABS_NODES = [original.ElevenLabsVoiceSelector, *UNAVAILABLE_NODES]
