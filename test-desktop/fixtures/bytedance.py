import asyncio
import base64
from io import BytesIO
from pathlib import Path
import traceback

import aiohttp
from aiohttp import web
from PIL import Image
import torch

import folder_paths
import nodes
from comfy_api.latest import Types
from comfy_api_nodes import nodes_bytedance as original
from oneyes import native
from oneyes.routes import client
from oneyes.service import OneYesError, ORIGINS
from server import PromptServer


@PromptServer.instance.routes.get('/oneyes-test/bytedance')
async def check_bytedance(request):
    original_request, original_download, original_relay = client.request, client.download, client.download_video
    calls = []
    models = ['doubao-seedance-2.0', 'doubao-seedance-2.5', 'doubao-seedance-2.0 [480p-4k 4-15s ¥13.2/百万Token起]', 'grok-imagine-video']
    video_buffer = BytesIO()
    nodes.NODE_CLASS_MAPPINGS['CreateVideo'].execute(torch.zeros((3, 16, 16, 3)), 3)[0].save_to(video_buffer, format=Types.VideoContainer.MP4, codec=Types.VideoCodec.H264)
    video_bytes = video_buffer.getvalue()

    async def reply(origin, path, key, payload=None, multipart=None):
        assert origin in ORIGINS
        assert key == 'test-only-do-not-call'
        assert multipart is None
        calls.append((path, payload))
        if path == '/models':
            return {'data': [{'id': model} for model in models]}, 1
        if path == '/videos':
            assert payload['model'] in models
            assert isinstance(payload['generate_audio'], bool) and isinstance(payload['watermark'], bool)
            assert payload['ratio'] == 'adaptive' and payload['duration'] == 5 and payload['resolution'] == '1080p'
            assert not any(key in payload for key in ('images', 'reference_images', 'image', 'camera_fixed'))
            assert Image.open(BytesIO(base64.b64decode(payload['first_frame'].split(',')[1]))).size == (3073, 2049)
            assert Image.open(BytesIO(base64.b64decode(payload['last_frame'].split(',')[1]))).size == (17, 23)
            return {'code': 0, 'data': {'id': 'seedance-first-last'}}, 1
        assert path == '/videos/seedance-first-last'
        return {'code': 0, 'data': {'id': 'seedance-first-last', 'status': 'completed', 'url': '/v1/videos/seedance-first-last/content'}}, 1

    async def relay(record, key, target):
        assert key == 'test-only-do-not-call'
        assert record['url'] == '/videos/seedance-first-last/content'
        target.write_bytes(video_bytes)

    client.request, client.download_video = reply, relay
    client.catalog.clear()
    try:
        node = native.ByteDanceFirstLastFrame
        schema, expected = node.GET_SCHEMA(), original.ByteDanceFirstLastFrameNode.GET_SCHEMA()
        assert nodes.NODE_CLASS_MAPPINGS['ByteDanceFirstLastFrameNode'] is node
        assert schema.node_id == expected.node_id
        assert [(item.id, item.get_io_type()) for item in schema.inputs] == [(item.id, item.get_io_type()) for item in expected.inputs]
        assert [item.get_io_type() for item in schema.outputs] == ['VIDEO']
        assert schema.is_api_node is False and schema.is_deprecated is False
        assert not any(item in (native.io.Hidden.auth_token_comfy_org, native.io.Hidden.api_key_comfy_org) for item in schema.hidden or [])
        first, last = torch.zeros((1, 2049, 3073, 3)), torch.ones((1, 23, 17, 3))
        await client.models('video')
        choices = next(item for item in node.define_schema().inputs if item.id == 'model')
        assert choices.default == 'doubao-seedance-2.0'
        assert all(model in choices.options for model in models if model.startswith('doubao-'))
        assert 'seedance-1-5-pro-251215' in choices.options, 'Saved model values must remain valid during workflow import'
        for model in models[:3]:
            result = await node.execute(model, 'first-last test', first, last, '1080p', 'adaptive', 5, 812, True, False, True)
            assert tuple(result[0].get_components().images.shape) == (3, 16, 16, 3)
            result[0].save_to(str(Path(folder_paths.get_output_directory()) / 'native-seedance-result.mp4'), format=Types.VideoContainer.MP4, codec=Types.VideoCodec.H264)
            sent = [payload for path, payload in calls if path == '/videos'][-1]
            assert sent['model'] == model and sent['seed'] == 812
            assert sent['generate_audio'] is True and sent['watermark'] is False
            assert sent['prompt'].endswith('镜头固定，保持机位不移动。')
            before = len(calls)
            await node.execute(model, 'first-last test', first, last, '1080p', 'adaptive', 5, 812, True, False, True)
            assert len(calls) == before, 'Rerun must use the saved video, never create a new paid task'
        before = len(calls)
        for model in ['seedance-1-5-pro-251215', 'seedance-1-0-pro-250528', 'doubao-seedance-unknown', 'grok-imagine-video']:
            try:
                await node.execute(model, 'not submitted', first, last, '1080p', 'adaptive', 5)
                raise AssertionError('An unavailable model was submitted or silently replaced')
            except OneYesError as error:
                assert '选择 OneYes 模型' in str(error)
        assert len(calls) == before
        try:
            await node.execute(models[0], 'not submitted', last.repeat(2, 1, 1, 1), last, '1080p', 'adaptive', 5)
            raise AssertionError('The first-frame batch was silently truncated')
        except OneYesError as error:
            assert '首帧需要一张' in str(error)
        assert len(calls) == before
        Image.open(BytesIO(native.references(first)[0])).save(Path(folder_paths.get_input_directory()) / 'seedance-first.png')
        Image.open(BytesIO(native.references(last)[0])).save(Path(folder_paths.get_input_directory()) / 'seedance-last.png')
        prompt = {
            '1': {'class_type': 'LoadImage', 'inputs': {'image': 'seedance-first.png'}},
            '2': {'class_type': 'LoadImage', 'inputs': {'image': 'seedance-last.png'}},
            '3': {'class_type': 'ByteDanceFirstLastFrameNode', 'inputs': {'model': models[0], 'prompt': 'queued workflow', 'first_frame': ['1', 0], 'last_frame': ['2', 0], 'resolution': '1080p', 'aspect_ratio': 'adaptive', 'duration': 5, 'seed': 913, 'watermark': False, 'generate_audio': True}},
            '4': {'class_type': 'SaveVideo', 'inputs': {'video': ['3', 0], 'filename_prefix': 'native-seedance-queued', 'format': 'mp4', 'format.codec': 'h264', 'format.codec.encoding': 'auto'}},
        }
        async with aiohttp.ClientSession() as session:
            origin = f'http://127.0.0.1:{request.url.port}'
            async with session.post(origin + '/prompt', json={'prompt': prompt}) as response:
                submitted = await response.json()
                assert response.status == 200, submitted
            while True:
                async with session.get(origin + '/history/' + submitted['prompt_id']) as response:
                    history = await response.json()
                if submitted['prompt_id'] in history:
                    assert history[submitted['prompt_id']]['status']['status_str'] == 'success', history
                    break
                await asyncio.sleep(.25)
        assert list(Path(folder_paths.get_output_directory()).glob('native-seedance-queued*.mp4'))
        assert list(Path(folder_paths.get_output_directory()).glob('native-seedance-result*.mp4'))
        return web.json_response({'registered': schema.node_id, 'contract': True, 'exactModelIds': True, 'originalResolution': True, 'queuedWorkflow': True, 'localVideoSaved': True, 'noResubmission': True, 'noPaidRequests': True})
    except Exception:
        raise web.HTTPInternalServerError(text=traceback.format_exc())
    finally:
        client.request, client.download, client.download_video = original_request, original_download, original_relay
        client.catalog.clear()
