import ast
import inspect
from io import BytesIO
from pathlib import Path
import struct
import sys
import traceback

from aiohttp import web
import av
from backports import zstd
import torch
from spandrel.architectures.ESRGAN.__arch.RRDB import RRDBNet

import folder_paths
import nodes
from comfy_api.latest import Types
from server import PromptServer


@PromptServer.instance.routes.get('/oneyes-test/builtins')
async def check_builtins(request):
    try:
        source = ast.parse(inspect.getsource(nodes.init_builtin_extra_nodes))
        files = next(ast.literal_eval(item.value) for item in ast.walk(source)
                     if isinstance(item, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'extras_files' for target in item.targets))
        node_ids = set()
        for name in files:
            file = Path(nodes.__file__).resolve().parent / 'comfy_extras' / name
            module = sys.modules.get(str(file.with_suffix('')))
            assert module is not None, f'Original module was not loaded: {name}'
            if hasattr(module, 'NODE_CLASS_MAPPINGS'):
                declared = module.NODE_CLASS_MAPPINGS.items()
            else:
                extension = module.comfy_entrypoint()
                if inspect.isawaitable(extension):
                    extension = await extension
                declared = [(cls.GET_SCHEMA().node_id, cls) for cls in await extension.get_node_list()]
            for node_id, cls in declared:
                assert nodes.NODE_CLASS_MAPPINGS.get(node_id) is cls, f'Original node failed to register: {name}/{node_id}'
                node_ids.add(node_id)

        image = torch.zeros((1, 16, 16, 3))
        image[:, 4:12, 4:12] = 1
        canny = nodes.NODE_CLASS_MAPPINGS['Canny'].execute(image, .1, .2)[0]
        assert canny.shape == image.shape and canny.sum() > 0
        dilated = nodes.NODE_CLASS_MAPPINGS['Morphology'].execute(image, 'dilate', 3)[0]
        assert dilated.shape == image.shape and dilated.sum() > image.sum()

        # Synthetic weights exercise the native loader without downloading a model.
        model_dir = Path(folder_paths.get_folder_paths('upscale_models')[0])
        model_dir.mkdir(parents=True, exist_ok=True)
        weights = model_dir / 'builtin-smoke.pth'
        torch.save(RRDBNet(num_filters=8, num_blocks=1, scale=2).state_dict(), weights)
        try:
            model = nodes.NODE_CLASS_MAPPINGS['UpscaleModelLoader'].execute(weights.name)[0]
            upscaled = nodes.NODE_CLASS_MAPPINGS['ImageUpscaleWithModel'].execute(model, image)[0]
            assert tuple(upscaled.shape) == (1, 32, 32, 3)
        finally:
            weights.unlink()

        audio = {'waveform': torch.sin(torch.arange(4800).float() * .1).reshape(1, 1, -1), 'sample_rate': 48000}
        for node_id, format in [('SaveAudio', 'flac'), ('SaveAudioMP3', 'mp3'), ('SaveAudioOpus', 'opus')]:
            node = nodes.NODE_CLASS_MAPPINGS[node_id].PREPARE_CLASS_CLONE(None)
            result = node.execute(audio, filename_prefix='builtin-smoke/audio', format=format)
            item = result.ui.as_dict()['audio'][0]
            file = Path(folder_paths.get_output_directory()) / item['subfolder'] / item['filename']
            with av.open(str(file)) as container:
                assert next(container.decode(audio=0)).samples > 0
            input_audio = Path(folder_paths.get_input_directory()) / f'builtin-smoke.{format}'
            input_audio.write_bytes(file.read_bytes())
            loaded_audio = nodes.NODE_CLASS_MAPPINGS['LoadAudio'].execute(input_audio.name)[0]
            assert loaded_audio['waveform'].shape[-1] > 0

        video = nodes.NODE_CLASS_MAPPINGS['CreateVideo'].execute(image.repeat(3, 1, 1, 1), 3)[0]
        output = BytesIO()
        video.save_to(output, format=Types.VideoContainer.MP4, codec=Types.VideoCodec.H264)
        video_file = Path(folder_paths.get_input_directory()) / 'builtin-smoke.mp4'
        video_file.write_bytes(output.getvalue())
        decoded = nodes.NODE_CLASS_MAPPINGS['LoadVideo'].execute(video_file.name)[0].get_components()
        assert tuple(decoded.images.shape) == (3, 16, 16, 3)

        # A one-point SPZ v4 file uses five Zstandard streams after its table.
        arrays = [bytes(9), bytes([128]), bytes([128] * 3), bytes([120] * 3), struct.pack('<I', 3 << 30)]
        streams = [zstd.compress(value) for value in arrays]
        header = struct.pack('<IIIBBBB', 0x5053474E, 4, 1, 0, 12, 0, 5)
        table = b''.join(struct.pack('<QQ', len(stream), len(raw)) for stream, raw in zip(streams, arrays))
        file = Types.File3D(BytesIO(header + struct.pack('<I', 20) + table + b''.join(streams)), file_format='spz')
        splat = nodes.NODE_CLASS_MAPPINGS['File3DToSplat'].execute(file)[0]
        assert tuple(splat.positions.shape) == (1, 1, 3) and torch.isfinite(splat.scales).all()
        exported = nodes.NODE_CLASS_MAPPINGS['SplatToFile3D'].execute(splat, 'ply')[0]
        assert exported.get_bytes().startswith(b'ply')
        return web.json_response({'builtinModules': len(files), 'extraNodes': len(node_ids), 'executed': ['Canny', 'Morphology', 'UpscaleModelLoader', 'ImageUpscaleWithModel', 'SaveAudio', 'SaveAudioMP3', 'SaveAudioOpus', 'LoadAudio', 'CreateVideo', 'LoadVideo', 'File3DToSplat SPZ v4', 'SplatToFile3D'], 'offline': True})
    except Exception:
        raise web.HTTPInternalServerError(text=traceback.format_exc())
