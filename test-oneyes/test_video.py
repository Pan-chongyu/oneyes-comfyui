from contextlib import asynccontextmanager
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import aiohttp

from oneyes.service import OneYesClient, OneYesError, ORIGINS


class VideoTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.client = OneYesClient(self.temp.name)
        self.client.vault.save({"video": "test-video-key"})
        self.payload = {"model": "doubao-seedance-2.0", "prompt": "test", "duration": 5, "seed": 4}
        self.calls = []

    def transport(self, result):
        async def reply(origin, path, key, payload=None, multipart=None):
            self.assertIn(origin, ORIGINS)
            self.assertEqual(key, "test-video-key")
            self.calls.append(path)
            if path == "/models":
                return {"data": [{"id": self.payload["model"]}]}, 1
            if path == "/videos":
                self.assertEqual(payload, self.payload)
                return {"code": 0, "data": {"id": "public-task"}}, 1
            self.assertEqual(path, "/videos/public-task")
            return {"code": "0", "data": {"id": "public-task", "status": "completed", **result}}, 1
        return reply

    async def test_bridge_receipts_and_all_public_result_shapes_survive_restart(self):
        for result in [{"url": "https://example.com/video.mp4"}, {"result_url": "https://example.com/video.mp4"}, {"video_url": "https://example.com/video.mp4"}, {"content": {"video_url": "https://example.com/video.mp4"}}]:
            with self.subTest(result=result):
                self.payload["seed"] += 1
                self.client.request = self.transport(result)
                async def download(url, target):
                    self.assertEqual(url, "https://example.com/video.mp4")
                    target.write_bytes(b"test-video")
                self.client.download = download
                path = await self.client.video(self.payload, endpoint="/videos")
                self.assertEqual(path.read_bytes(), b"test-video")
                before = list(self.calls)
                reopened = OneYesClient(self.temp.name)
                reopened.request = self.client.request
                self.assertEqual(await reopened.video(self.payload, endpoint="/videos"), path)
                self.assertEqual(self.calls, before)

    async def test_failed_content_download_recovers_original_job_without_reposting(self):
        self.client.request = self.transport({"url": "/v1/videos/public-task/content"})
        async def unavailable(record, key, target):
            self.assertEqual(record["url"], "/videos/public-task/content")
            raise OneYesError("下载中断")
        self.client.download_video = unavailable
        with self.assertRaisesRegex(OneYesError, "下载中断"):
            await self.client.video(self.payload, endpoint="/videos")
        reopened = OneYesClient(self.temp.name)
        reopened.request = self.client.request
        async def recovered(record, key, target):
            self.assertEqual(key, "test-video-key")
            target.write_bytes(b"recovered-original")
        reopened.download_video = recovered
        path = await reopened.video(self.payload, endpoint="/videos")
        self.assertEqual(path.read_bytes(), b"recovered-original")
        self.assertEqual(self.calls, ["/models", "/videos", "/videos/public-task"])

    async def test_absolute_oneyes_relay_uses_fixed_authenticated_task_path(self):
        self.client.request = self.transport({"video": {"url": "https://api.oneyes.ai/v1/videos/public-task/content"}})
        async def relay(record, key, target):
            self.assertEqual(record["url"], "/videos/public-task/content")
            self.assertEqual(record["origin"], ORIGINS[0])
            target.write_bytes(b"relay-original")
        self.client.download_video = relay
        self.assertEqual((await self.client.video(self.payload, endpoint="/videos")).read_bytes(), b"relay-original")

    async def test_mismatched_receipt_or_missing_result_stops_without_reposting(self):
        for result in [{"id": "other-task", "url": "https://example.com/video.mp4"}, {}]:
            with self.subTest(result=result):
                self.payload["seed"] += 1
                self.client.request = self.transport(result)
                before = self.calls.count("/videos")
                for _ in range(2):
                    with self.assertRaisesRegex(OneYesError, "回执不一致|暂未返回原件"):
                        await self.client.video(self.payload, endpoint="/videos")
                self.assertEqual(self.calls.count("/videos"), before + 1)

    async def test_uncertain_bridge_submission_is_never_replayed(self):
        original = self.transport({})
        async def lost(origin, path, key, payload=None, multipart=None):
            if path == "/videos":
                self.calls.append(path)
                raise aiohttp.ClientConnectionError("unknown submit result")
            return await original(origin, path, key, payload, multipart)
        self.client.request = lost
        for _ in range(2):
            with self.assertRaisesRegex(OneYesError, "不会.*重复提交"):
                await self.client.video(self.payload, endpoint="/videos")
        self.assertEqual(self.calls.count("/videos"), 1)

    async def test_relay_credentials_never_follow_redirects_and_json_is_not_saved_as_video(self):
        class Body:
            async def iter_chunked(self, size):
                yield b"original-mp4"
        class Response:
            content = Body()
        target = Path(self.temp.name) / "video.mp4"
        record = {"origin": ORIGINS[0], "remote_id": "public-task"}
        for status, headers in [(200, {"Content-Type": "video/mp4"}), (302, {"Location": "https://example.com/original.mp4"}), (200, {"Content-Type": "application/json"}), (503, {})]:
            with self.subTest(status=status, headers=headers):
                target.unlink(missing_ok=True)
                @asynccontextmanager
                async def get(url, **kwargs):
                    self.assertEqual(url, ORIGINS[0] + "/videos/public-task/content")
                    self.assertEqual(kwargs["headers"], {"Authorization": "Bearer test-video-key"})
                    self.assertIs(kwargs["allow_redirects"], False)
                    response = Response(); response.status = status; response.headers = headers
                    yield response
                class Session:
                    pass
                @asynccontextmanager
                async def session(**kwargs):
                    value = Session(); value.get = get
                    yield value
                async def download(url, destination):
                    self.assertEqual(url, "https://example.com/original.mp4")
                    destination.write_bytes(b"redirected-original")
                self.client.download = download
                with patch("oneyes.service.aiohttp.ClientSession", session):
                    if status == 503 or headers.get("Content-Type") == "application/json":
                        with self.assertRaises(OneYesError):
                            await self.client.download_video(record, "test-video-key", target)
                        self.assertFalse(target.exists())
                    else:
                        await self.client.download_video(record, "test-video-key", target)
                        self.assertEqual(target.read_bytes(), b"original-mp4" if status == 200 else b"redirected-original")

    async def test_video_endpoints_and_media_paths_cannot_escape_trusted_hosts(self):
        for endpoint in ["//evil.test", "/unrelated", "https://evil.test/videos"]:
            with self.assertRaisesRegex(OneYesError, "接口无效"):
                await self.client.video(self.payload, endpoint=endpoint)
        with self.assertRaisesRegex(OneYesError, "取回地址无效"):
            await self.client.download_video({"origin": "https://evil.test", "remote_id": "public-task"}, "test-video-key", Path(self.temp.name) / "video.mp4")
        self.client.request = self.transport({"url": "/v1/videos/other-task/content"})
        with self.assertRaisesRegex(OneYesError, "公开 HTTPS"):
            await self.client.video(self.payload, endpoint="/videos")
