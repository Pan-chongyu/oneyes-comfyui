import base64
from io import BytesIO
import json
import traceback
from pathlib import Path

from aiohttp import web
import numpy as np
from PIL import Image
import torch

import folder_paths
import nodes
from server import PromptServer
from oneyes import native
from oneyes.routes import client
from oneyes.service import OneYesError, ORIGINS


@PromptServer.instance.routes.get('/oneyes-test/native')
async def check_native(request):
    original_request, original_download = client.request, client.download
    calls = []
    stream = BytesIO(); Image.new('RGBA', (17, 23), (30, 70, 90, 51)).save(stream, 'PNG')
    encoded = base64.b64encode(stream.getvalue()).decode()
    models = ['gpt-image-2', 'gpt-image-2.5', 'gpt-6.1-sol', 'claude-opus-4-6', 'gemini-2.5-flash-image', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-image', 'grok-imagine-image-2.0', 'grok-imagine-video']

    async def reply(origin, path, key, payload=None, multipart=None):
        assert origin in (*ORIGINS, 'https://oneyes.ai/v1beta')
        assert key == 'test-only-do-not-call'
        calls.append((origin, path, payload, multipart))
        if path == '/models':
            return {'data': [{'id': model} for model in models]}, 1
        if path == '/responses':
            return {'id': 'text-receipt', 'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': 'OneYes responses'}]}]}, 1
        if path == '/messages':
            return {'content': [{'type': 'text', 'text': 'OneYes Claude'}]}, 1
        if ':generateContent' in path:
            parts = [{'text': 'OneYes Gemini'}]
            if 'responseModalities' in payload.get('generationConfig', {}):
                parts.extend([{'inlineData': {'mimeType': 'image/png', 'data': encoded}}, {'thought': True, 'inlineData': {'mimeType': 'image/png', 'data': encoded}}])
            return {'candidates': [{'content': {'role': 'model', 'parts': parts}, 'finishReason': 'STOP'}]}, 1
        if path == '/videos/generations':
            return {'request_id': 'native-video'}, 1
        if path == '/videos/native-video':
            return {'status': 'done', 'video': {'url': 'https://example.com/native.mp4'}}, 1
        if path.endswith('/async'):
            return {'task_id': 'native-image'}, 1
        if path == '/images/tasks/native-image':
            return {'task_id': 'native-image', 'status': 'completed', 'result': {'data': [{'b64_json': encoded}] * 2}}, 1
        if path in ('/images/generations', '/images/edits'):
            return {'data': [{'b64_json': encoded}]}, 1
        raise AssertionError('Unexpected native route ' + path)

    async def download(url, target=None):
        assert url == 'https://example.com/native.mp4'
        assert target is not None
        target.write_bytes(b'isolated-video-no-network')

    client.request, client.download = reply, download
    client.catalog.clear()
    try:
        for node in native.NATIVE_NODES:
            schema = node.define_schema()
            assert schema.node_id in nodes.NODE_CLASS_MAPPINGS, schema.node_id
            assert not schema.is_api_node, schema.node_id
            assert all(value not in (native.io.Hidden.auth_token_comfy_org, native.io.Hidden.api_key_comfy_org) for value in schema.hidden or [])
            if issubclass(node, native.NativeNode):
                original = node.__bases__[1].define_schema()
                assert schema.node_id == original.node_id
                assert [value.get_io_type() for value in schema.outputs] == [value.get_io_type() for value in original.outputs]
                assert [value.id for value in schema.inputs] == [value.id for value in original.inputs]

        image = torch.zeros((2, 23, 17, 3))
        result = await native.GPTImage.execute('native legacy', seed=101, quality='high', background='transparent', image=image[:1], mask=torch.ones((1, 23, 17)), n=2, size='Custom', custom_width=4096, custom_height=3072)
        assert tuple(result[0].shape) == (2, 23, 17, 4)
        assert abs(result[0][0, 0, 0, 3].item() - .2) < .001
        form = next(value[3] for value in calls if value[1] == '/images/edits/async')
        fields = {details['name']: value for details, headers, value in form._fields}
        assert fields['n'] == '2' and fields['size'] == '4096x3072'
        assert Image.open(BytesIO(fields['mask'])).getpixel((0, 0))[3] == 0

        options = {'model': 'gpt-image-2.5', 'size': 'auto', 'quality': 'high', 'background': 'transparent', 'complexity': 'high', 'images': {'a': image, 'b': image}}
        before = len(calls)
        await native.GPTImageV2.execute('native dynamic', options, 2, 102)
        form = next(value[3] for value in calls[before:] if value[1] == '/images/edits/async')
        assert sum(details['name'] == 'image[]' for details, headers, value in form._fields) == 4
        await native.GPTImageV3.execute({**options, 'prompt': 'native markup', 'seed': 103, 'markup': image[:1], 'markup_alpha': torch.ones((1, 23, 17))})
        form = [value[3] for value in calls if value[1] == '/images/edits/async'][-1]
        assert any(details['name'] == 'markup' for details, headers, value in form._fields)

        # Large original images must remain lossless; the native Comfy helper downsizes them.
        raw = native.references(torch.zeros((1, 2049, 3073, 3)))[0]
        assert Image.open(BytesIO(raw)).size == (3073, 2049)
        config = native.openai.OpenAIChatConfig.execute('disabled', 'system', 500, 'high')[0]
        assert (await native.ChatGPT.execute('prompt', model='gpt-6.1-sol', images=image, advanced_options=config))[0] == 'OneYes responses'
        payload = next(value[2] for value in calls if value[1] == '/responses')
        assert payload['reasoning']['effort'] == 'high' and payload['instructions'] == 'system'
        assert len(payload['input'][0]['content']) == 3
        assert (await native.Claude.execute('prompt', {'model': 'Opus 4.6', 'max_tokens': 5000, 'reasoning_effort': 'high'}, 5, {'images': image}, 'system'))[0] == 'OneYes Claude'
        payload = next(value[2] for value in calls if value[1] == '/messages')
        assert payload['model'] == 'claude-opus-4-6' and len(payload['messages'][0]['content']) == 3

        assert (await native.GeminiText.execute('prompt', 'gemini-3.1-pro-preview', 1, images=image))[0] == 'OneYes Gemini'
        text_options = {'model': 'Gemini 3.1 Pro', 'thinking_level': 'HIGH', 'max_output_tokens': 5000, 'images': {'image': image}, 'prompt': 'prompt', 'seed': 1}
        await native.GeminiTextV2.execute('prompt', text_options, 1)
        await native.GeminiTextV3.execute(text_options)
        output = await native.GeminiImage.execute('prompt', 'gemini-2.5-flash-image', 1, images=image)
        assert tuple(output[0].shape) == (1, 23, 17, 4) and output[1] == 'OneYes Gemini'
        await native.GeminiImage2.execute('prompt', 'Nano Banana 2 (Gemini 3.1 Flash Image)', 1, '16:9', '4K', 'IMAGE+TEXT', images=image)
        output = await native.NanoBanana.execute('prompt', 'gemini-3.1-flash-image', 1, '16:9', '4K', 'IMAGE+TEXT', 'HIGH', images=image)
        assert tuple(output[2].shape) == (1, 23, 17, 4)
        await native.NanoBananaV2.execute('prompt', {'model': 'Nano Banana 2 (Gemini 3.1 Flash Image)', 'resolution': '4K', 'aspect_ratio': '16:9', 'thinking_level': 'HIGH', 'images': {'image': image}}, 1, 'IMAGE+TEXT')
        assert any(value[2].get('generationConfig', {}).get('imageConfig', {}).get('imageSize') == '4K' for value in calls if value[2])

        await native.GrokImage.execute('grok-imagine-image-2.0', 'prompt', '16:9', 1, 10)
        await native.GrokImageEdit.execute('grok-imagine-image-2.0', image, 'prompt', '2K', 1, 10)
        await native.GrokImageEditV2.execute('prompt', {'model': 'grok-imagine-image-2.0', 'resolution': '2K', 'number_of_images': 1, 'images': {'one': image, 'two': image}}, 10)
        payload = [value[2] for value in calls if value[1] == '/images/edits'][-1]
        assert len(payload['images']) == 4 and payload['resolution'] == '2k'
        video = await native.GrokVideo.execute('grok-imagine-video', 'prompt', '720p', '16:9', 5, 111, image=image[:1])
        before = len(calls)
        await native.GrokVideo.execute('grok-imagine-video', 'prompt', '720p', '16:9', 5, 111, image=image[:1])
        assert len(calls) == before, 'Re-execution must not create another video'
        assert video[0] is not None

        file = Path(folder_paths.get_input_directory()) / 'native-test.txt'
        file.write_text('native file context', encoding='utf-8')
        assert len(native.OpenAIFiles.execute(file.name)[0]) == 1
        assert len(native.GeminiFiles.execute(file.name)[0]) == 1
        for node in [native.OpenAIFiles, native.GeminiFiles]:
            try:
                node.execute('../vault.master')
                raise AssertionError('Escaped the input directory')
            except (OneYesError, ValueError):
                pass
        for node in [native.GPTImageV2, native.Claude, native.GeminiTextV2]:
            choices = next(value for value in node.define_schema().inputs if value.id == 'model').options
            assert any(option.key in models for option in choices)
        return web.json_response({'nativeNodes': len(native.NATIVE_NODES), 'protocols': ['OpenAI async image', 'OpenAI Responses', 'Anthropic Messages', 'Gemini generateContent', 'Grok image/video'], 'originalResolution': True, 'alpha': True, 'receipts': True, 'noPaidRequests': True})
    except Exception:
        raise web.HTTPInternalServerError(text=traceback.format_exc())
    finally:
        client.request, client.download = original_request, original_download
        client.catalog.clear()
