import asyncio
import base64
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import aiohttp
from PIL import Image

from oneyes.service import OneYesClient, OneYesError, ORIGINS, public_url
from oneyes.storage import Vault, write_json


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.client = OneYesClient(self.temp.name)
        self.client.vault.save({"default": "test-private-key"})
        buffer = BytesIO(); Image.new("RGB", (17, 23), "blue").save(buffer, "PNG")
        self.png = buffer.getvalue()
        self.calls = []

    async def reply(self, origin, path, key, payload=None, multipart=None):
        self.calls.append((origin, path, key, payload, multipart))
        if path == "/models":
            return {"data": [{"id": "example-image"}]}, 1
        if path.endswith("/async"):
            return {"task_id": "remote-original", "status": "processing"}, 1
        return {"id": "remote-original", "status": "completed", "result": {"data": [{"b64_json": base64.b64encode(self.png).decode()}]}}, 1

    async def test_reopen_resumes_original_receipt_and_preserves_image_size(self):
        self.client.request = self.reply
        images, job = await self.client.image("example-image", "prompt", "auto", "auto", 8)
        self.assertEqual(images[0].size, (17, 23))
        self.assertEqual(sum(path.endswith("/async") for _, path, *_ in self.calls), 1)
        reopened = OneYesClient(self.temp.name); reopened.request = self.reply
        self.calls.clear()
        images, restored = await reopened.image("example-image", "prompt", "auto", "auto", 8)
        self.assertEqual(restored, job)
        self.assertEqual(images[0].size, (17, 23))
        self.assertEqual(self.calls, [])
        self.assertNotIn("test-private-key", json.dumps(reopened.records()))

    async def test_recover_pending_uses_get_after_restart(self):
        self.client.request = self.reply
        await self.client.image("example-image", "prompt", "auto", "auto", 7)
        record = self.client.records()[0]; path = self.client.record_path(record["id"])
        stored = json.loads(path.read_text()); stored.pop("sources"); stored["status"] = "processing"; write_json(path, stored)
        self.calls.clear()
        reopened = OneYesClient(self.temp.name); reopened.request = self.reply
        images, _ = await reopened.recover(record["id"])
        self.assertEqual(len(images), 1)
        self.assertEqual([item[1] for item in self.calls], ["/images/tasks/remote-original"])

    async def test_lost_submission_does_not_repeat_paid_request(self):
        async def disconnected(origin, path, key, payload=None, multipart=None):
            if path == "/models": return await self.reply(origin, path, key)
            self.calls.append((origin, path, key, payload, multipart))
            raise aiohttp.ClientConnectionError("lost reply")
        self.client.request = disconnected
        with self.assertRaisesRegex(OneYesError, "不会自动重复"):
            await self.client.image("example-image", "prompt", "auto", "auto", 1)
        with self.assertRaisesRegex(OneYesError, "不会重复"):
            await self.client.image("example-image", "prompt", "auto", "auto", 1)
        self.assertEqual(sum(path.endswith("/async") for _, path, *_ in self.calls), 1)

    async def test_all_reference_images_are_binary_multipart(self):
        self.client.request = self.reply
        await self.client.image("example-image", "prompt", "1024x1536", "high", 2, [self.png] * 3)
        _, path, _, payload, form = next(item for item in self.calls if item[1].endswith("/async"))
        self.assertEqual(path, "/images/edits/async"); self.assertIsNone(payload)
        images = [value for details, headers, value in form._fields if details["name"] == "image[]"]
        self.assertEqual(images, [self.png] * 3)

    async def test_changed_key_cannot_retrieve_another_keys_task(self):
        self.client.request = self.reply
        _, job = await self.client.image("example-image", "prompt", "auto", "auto", 3)
        self.client.vault.save({"default": "different-key"})
        with self.assertRaisesRegex(OneYesError, "原来的 API Key"):
            await self.client.recover(job)

    async def test_direct_route_preferred_and_post_never_fails_over(self):
        self.client.request = self.reply
        await self.client.models("default")
        self.assertEqual(self.calls[0][0], ORIGINS[0])
        async def fail(origin, path, key, payload=None, multipart=None):
            self.calls.append((origin, path, key, payload, multipart))
            if origin == ORIGINS[0]: raise aiohttp.ClientConnectionError()
            return {"data": [{"id": "model"}]}, 1
        self.client.request = fail; self.calls.clear()
        self.assertEqual((await self.client.models("default"))["origin"], ORIGINS[1])
        self.assertEqual(len(self.calls), 2)

    async def test_network_error_messages_do_not_contain_key_or_prompt(self):
        self.client.request = self.reply
        with self.assertRaises(OneYesError):
            self.client.record_path("../../secret")
        for url in ["http://example.com/image", "https://127.0.0.1/x", "https://192.168.1.3/x", "https://user:pass@example.com/x", "https://localhost/x", "https://[::1]/x"]:
            with self.assertRaises(OneYesError): public_url(url)
        self.assertEqual(public_url("https://example.com/image.png"), "https://example.com/image.png")


class StorageTests(unittest.TestCase):
    def test_keys_are_encrypted_and_profile_falls_back(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Vault(directory); vault.save({"default": "secret-default", "image": "secret-image"})
            self.assertEqual(vault.key("text"), "secret-default")
            self.assertEqual(vault.key("image"), "secret-image")
            self.assertNotIn("secret-default", (Path(directory) / "vault.json").read_text())
            vault.save({"image": ""})
            self.assertEqual(vault.key("image"), "secret-default")


if __name__ == "__main__": unittest.main()
