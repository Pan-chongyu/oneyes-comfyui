import traceback

from aiohttp import web

from comfy_api.latest import io
from comfy_api_nodes import nodes_elevenlabs as original
import nodes
from oneyes.elevenlabs import ELEVENLABS_NODES, UNAVAILABLE_NODES, UNAVAILABLE_REASON
from oneyes.service import OneYesError
from server import PromptServer


@PromptServer.instance.routes.get('/oneyes-test/elevenlabs')
async def check_elevenlabs(request):
    try:
        originals = {node.GET_SCHEMA().node_id: node for node in await original.ElevenLabsExtension().get_node_list()}
        assert len(originals) == len(ELEVENLABS_NODES) == 8
        for node in ELEVENLABS_NODES:
            schema = node.GET_SCHEMA()
            expected = originals[schema.node_id].GET_SCHEMA()
            assert nodes.NODE_CLASS_MAPPINGS[schema.node_id] is node
            assert [value.id for value in schema.inputs] == [value.id for value in expected.inputs]
            assert [value.get_io_type() for value in schema.outputs] == [value.get_io_type() for value in expected.outputs]
            assert schema.is_api_node is False
            assert all(value not in (io.Hidden.auth_token_comfy_org, io.Hidden.api_key_comfy_org) for value in schema.hidden or [])
        voices = nodes.NODE_CLASS_MAPPINGS['ElevenLabsVoiceSelector']
        for label, voice_id in original.ELEVENLABS_VOICE_MAP.items():
            assert voices.execute(label)[0] == voice_id
        for node in UNAVAILABLE_NODES:
            assert node.execute.__func__.__module__ == 'oneyes.elevenlabs'
            try:
                # Empty arguments intentionally verify rejection before any upload,
                # credentials, provider proxy or paid API could be evaluated.
                await node.execute()
                raise AssertionError('An unavailable ElevenLabs API was executed')
            except OneYesError as error:
                assert str(error) == UNAVAILABLE_REASON
        return web.json_response({'registered': sorted(originals), 'localVoices': len(original.ELEVENLABS_VOICES), 'unavailableApis': len(UNAVAILABLE_NODES), 'noPaidRequests': True})
    except Exception:
        raise web.HTTPInternalServerError(text=traceback.format_exc())
