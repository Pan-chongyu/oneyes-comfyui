import asyncio
import base64
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import io
import ipaddress
import json
from pathlib import Path
import re
import socket
from urllib.parse import quote, urlsplit

import aiohttp
from PIL import Image

from .storage import Vault, data_directory, write_json


ORIGINS = ("https://oneyes.ai/v1", "https://api.oneyes.ai/v1")
GEMINI_ORIGINS = tuple(origin.removesuffix("/v1") + "/v1beta" for origin in ORIGINS)
FAKE_IP_NETWORK = ipaddress.ip_network("198.18.0.0/15")


class OneYesError(RuntimeError):
    def __init__(self, message, status=0):
        super().__init__(message)
        self.status = status


def safe_error(status):
    return {401: "API Key 无效，请检查 OneYes 设置", 403: "Key 没有访问此模型的权限，请检查 Key 分组", 402: "余额不足，请前往 OneYes 充值", 429: "请求过多，请稍后再试", 404: "当前接口或模型不可用，请刷新模型列表或检查分组"}.get(status, f"OneYes 请求失败（HTTP {status}），请在官网检查原任务")


def retry_after(value):
    if value and value.isdigit():
        return max(1, int(value))
    if value:
        try:
            return max(1, (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds())
        except (ValueError, TypeError):
            pass
    return 3


class PublicResolver(aiohttp.abc.AbstractResolver):
    async def resolve(self, host, port=0, family=socket.AF_INET):
        addresses = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        values = []
        for family, _, proto, _, address in addresses:
            ip = ipaddress.ip_address(address[0])
            # Proxy Fake-IP DNS uses this range; HTTPS still verifies the original hostname.
            if not ip.is_global and ip not in FAKE_IP_NETWORK:
                raise OneYesError("素材域名解析到了内网地址，请检查代理或 DNS 后再次取回原任务")
            values.append({"hostname": host, "host": address[0], "port": port, "family": family, "proto": proto, "flags": 0})
        return values

    async def close(self):
        pass


def public_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise OneYesError("素材必须使用公开 HTTPS 地址")
    try:
        address = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        if parsed.hostname == "localhost" or parsed.hostname.endswith((".localhost", ".local")):
            raise OneYesError("素材下载地址无效")
    else:
        if not address.is_global:
            raise OneYesError("素材下载地址无效")
    return url


class OneYesClient:
    def __init__(self, directory=None):
        self.directory = Path(directory or data_directory())
        self.vault = Vault(self.directory)
        self.locks = {}
        self.catalog = {}

    async def request(self, origin, path, key, payload=None, multipart=None):
        if origin not in ORIGINS + GEMINI_ORIGINS or not path.startswith("/") or path.startswith("//"):
            raise OneYesError("请求地址无效")
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=60 if payload is None and multipart is None else None)
        headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
        if path == "/messages":
            headers.update({"anthropic-version": "2023-06-01", "x-api-key": key})
        async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as session:
            async with session.request("POST" if payload is not None or multipart is not None else "GET", origin + path, headers=headers, json=payload, data=multipart, allow_redirects=False) as response:
                if not 200 <= response.status < 300:
                    raise OneYesError(safe_error(response.status), response.status)
                try:
                    return await response.json(), retry_after(response.headers.get("Retry-After"))
                except (json.JSONDecodeError, aiohttp.ContentTypeError):
                    raise OneYesError("OneYes 响应格式无效，请在官网检查原任务") from None

    async def models(self, profile):
        key = self.vault.key(profile)
        for index, origin in enumerate(ORIGINS):
            try:
                value, _ = await self.request(origin, "/models", key)
                models = [item["id"] for item in value.get("data", []) if isinstance(item, dict) and isinstance(item.get("id"), str)]
                result = {"models": sorted(set(models)), "origin": origin}
                self.catalog[hashlib.sha256(key.encode()).hexdigest()] = result
                return result
            except (aiohttp.ClientError, TimeoutError, OneYesError) as error:
                if index or isinstance(error, OneYesError) and error.status in (401, 402, 403):
                    raise

    def cached_models(self, profile):
        try:
            key = self.vault.key(profile)
        except ValueError:
            return []
        return self.catalog.get(hashlib.sha256(key.encode()).hexdigest(), {}).get("models", [])

    async def connection(self, profile):
        key = self.vault.key(profile)
        return self.catalog.get(hashlib.sha256(key.encode()).hexdigest()) or await self.models(profile)

    async def generate(self, profile, path, payload, gemini=False, model=None):
        connection = await self.connection(profile)
        selected = model or payload.get("model")
        if selected and selected not in connection["models"]:
            raise OneYesError("当前 Key 无此模型权限，请在节点中选择 OneYes 可用模型，或更换对应平台的 Key")
        origin = connection["origin"]
        if gemini:
            origin = origin.removesuffix("/v1") + "/v1beta"
        try:
            value, _ = await self.request(origin, path, self.vault.key(profile), payload)
            return value
        except (aiohttp.ClientError, TimeoutError):
            raise OneYesError("连接中断，请在官网核对原请求；不会自动重复提交") from None

    async def download(self, url, target=None):
        url = public_url(url)
        async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(resolver=PublicResolver()), timeout=aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=60), trust_env=True) as session:
            async with session.get(url, allow_redirects=False) as response:
                if response.status != 200:
                    raise OneYesError("素材原件暂时无法下载，请再次取回原任务")
                if target is None:
                    return await response.read()
                temporary = target.with_suffix(".part")
                with temporary.open("wb") as file:
                    async for chunk in response.content.iter_chunked(1024 * 1024):
                        file.write(chunk)
                temporary.replace(target)

    async def video(self, payload, check_interrupt=lambda: None):
        key = self.vault.key("video")
        job_id = hashlib.sha256(("video\0" + hashlib.sha256(key.encode()).hexdigest() + json.dumps(payload, sort_keys=True, separators=(",", ":"))).encode()).hexdigest()
        async with self.locks.setdefault(job_id, asyncio.Lock()):
            path = self.record_path(job_id)
            if path.exists():
                record = self.read_record(job_id)
            else:
                origin = (await self.connection("video"))["origin"]
                check_interrupt()
                record = {"id": job_id, "origin": origin, "kind": "video", "profile": "video", "key_hash": hashlib.sha256(key.encode()).hexdigest(), "status": "submitting", "created": datetime.now(timezone.utc).isoformat(), "model": payload["model"]}
                write_json(path, record)
                try:
                    reply, delay = await self.request(origin, "/videos/generations", key, payload)
                    remote_id = reply.get("request_id") or reply.get("task_id") or reply.get("id")
                    if not isinstance(remote_id, str) or not remote_id:
                        raise OneYesError("没有取得任务回执")
                    record.update(remote_id=remote_id, status="processing", delay=delay)
                except (aiohttp.ClientError, TimeoutError, OneYesError):
                    record["status"] = "unknown"
                    raise OneYesError("视频提交结果未确认，请在官网核对；不会自动重复提交") from None
                finally:
                    write_json(path, record)
            if not record.get("remote_id"):
                raise OneYesError("视频提交结果未确认，请在官网核对；不会重复提交")
            while record["status"] != "completed":
                if record["status"] in ("failed", "cancelled"):
                    raise OneYesError("原视频任务未完成，请在官网查看失败原因；不会重复生成")
                check_interrupt()
                try:
                    reply, delay = await self.request(record["origin"], "/videos/" + quote(record["remote_id"], safe=""), key)
                except (aiohttp.ClientError, TimeoutError):
                    await asyncio.sleep(record.get("delay", 3))
                    continue
                except OneYesError as error:
                    if error.status in (429, 500, 502, 503, 504, 524):
                        await asyncio.sleep(record.get("delay", 3))
                        continue
                    raise
                status = str(reply.get("status", "")).lower()
                if status in ("failed", "error", "cancelled", "canceled", "expired"):
                    record["status"] = "failed"
                    write_json(path, record)
                    continue
                url = (reply.get("video") or {}).get("url") or reply.get("video_url")
                if url and status in ("", "completed", "complete", "succeeded", "success", "done"):
                    record.update(status="completed", url=public_url(url))
                    write_json(path, record)
                else:
                    await asyncio.sleep(delay)
            folder = self.directory / "results" / job_id
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            target = folder / "video.mp4"
            if not target.exists():
                check_interrupt()
                await self.download(record["url"], target)
            return target

    def record_path(self, job_id):
        if not re.fullmatch(r"[a-f0-9]{64}", job_id):
            raise OneYesError("本地任务编号无效")
        return self.directory / "tasks" / f"{job_id}.json"

    def read_record(self, job_id):
        path = self.record_path(job_id)
        if not path.exists():
            raise OneYesError("找不到本地任务记录，请在任务列表中选择")
        return json.loads(path.read_text("utf-8"))

    def records(self):
        folder = self.directory / "tasks"
        if not folder.exists():
            return []
        result = []
        for path in folder.glob("*.json"):
            item = json.loads(path.read_text("utf-8"))
            result.append({name: item.get(name) for name in ("id", "remote_id", "status", "created", "model", "kind")})
        return sorted(result, key=lambda item: item["created"], reverse=True)

    async def image(self, model, prompt, size, quality, seed, images=None, check_interrupt=lambda: None, *, options=None, mask=None, markup=None):
        key = self.vault.key("image")
        digest = hashlib.sha256()
        for value in (model, prompt, size, quality, str(seed), hashlib.sha256(key.encode()).hexdigest()):
            digest.update(value.encode()); digest.update(b"\0")
        for image in images or []:
            digest.update(hashlib.sha256(image).digest())
        if options:
            digest.update(json.dumps(options, sort_keys=True, separators=(",", ":")).encode())
        if mask is not None:
            digest.update(hashlib.sha256(mask).digest())
        if markup is not None:
            digest.update(b"markup\0" + hashlib.sha256(markup).digest())
        job_id = digest.hexdigest()
        async with self.locks.setdefault(job_id, asyncio.Lock()):
            path = self.record_path(job_id)
            if path.exists():
                return await self.recover(job_id, check_interrupt)
            origin = (await self.connection("image"))["origin"]
            check_interrupt()
            record = {"id": job_id, "origin": origin, "profile": "image", "key_hash": hashlib.sha256(key.encode()).hexdigest(), "status": "submitting", "created": datetime.now(timezone.utc).isoformat(), "model": model}
            write_json(path, record)
            payload = {"model": model, "prompt": prompt, "n": 1}
            if size != "auto":
                payload["size"] = size
            if quality != "auto":
                payload["quality"] = quality
            if options:
                payload.update(options)
            form = None
            endpoint = "/images/generations/async"
            if images:
                form = aiohttp.FormData()
                for name, value in payload.items():
                    form.add_field(name, str(value))
                for index, image in enumerate(images):
                    form.add_field("image[]", image, filename=f"reference-{index + 1}.png", content_type="image/png")
                if mask is not None:
                    form.add_field("mask", mask, filename="mask.png", content_type="image/png")
                if markup is not None:
                    form.add_field("markup", markup, filename="markup.png", content_type="image/png")
                payload = None
                endpoint = "/images/edits/async"
            try:
                reply, delay = await self.request(origin, endpoint, key, payload, form)
                remote_id = reply.get("task_id") or reply.get("id")
                if not isinstance(remote_id, str) or not remote_id:
                    raise OneYesError("没有取得任务回执，请在官网检查；不会自动重复提交")
                record.update(remote_id=remote_id, status="processing", delay=delay)
                write_json(path, record)
            except (aiohttp.ClientError, TimeoutError, OneYesError) as error:
                record["status"] = "unknown"
                write_json(path, record)
                raise OneYesError(f"没有确认提交结果，本地任务 {job_id} 已保留。请在官网核对，不会自动重复收费生成") from error
            return await self.recover(job_id, check_interrupt)

    async def recover(self, job_id, check_interrupt=lambda: None):
        record = self.read_record(job_id)
        if record.get("kind") == "video":
            raise OneYesError("这是视频任务，请保持原参数重新运行原视频节点取回")
        key = self.vault.key(record["profile"])
        if hashlib.sha256(key.encode()).hexdigest() != record["key_hash"]:
            raise OneYesError("此任务需要原来的 API Key，请恢复图片 Key 后取回")
        if not record.get("remote_id"):
            raise OneYesError("提交结果未确认，请在官网核对原记录；不会重复提交")
        if record["status"] in ("failed", "cancelled"):
            raise OneYesError("原任务未完成，请在官网查看失败原因；不会重复生成")
        while record["status"] != "completed":
            check_interrupt()
            try:
                reply, delay = await self.request(record["origin"], "/images/tasks/" + quote(record["remote_id"], safe=""), key)
            except (aiohttp.ClientError, TimeoutError):
                await asyncio.sleep(3)
                continue
            except OneYesError as error:
                if error.status in (429, 500, 502, 503, 504, 524):
                    await asyncio.sleep(record.get("delay", 3))
                    continue
                raise
            returned_id = reply.get("task_id") or reply.get("id")
            if returned_id and returned_id != record["remote_id"]:
                raise OneYesError("原任务回执不一致，已停止取回")
            status = str(reply.get("status", "processing")).lower()
            if status in ("failed", "error", "cancelled", "canceled", "expired"):
                record["status"] = "cancelled" if status in ("cancelled", "canceled") else "failed"
                write_json(self.record_path(job_id), record)
                raise OneYesError("原任务未完成，请在官网查看失败原因；不会重复生成")
            if status in ("completed", "succeeded", "success"):
                result = reply.get("result", reply)
                sources = result.get("data", []) if isinstance(result, dict) else []
                if not sources and reply.get("image_url"):
                    sources = [{"url": reply["image_url"]}]
                if not sources:
                    raise OneYesError("原任务已完成但暂无可取回的图片，请稍后再次取回")
                record.update(status="completed", sources=sources)
                write_json(self.record_path(job_id), record)
                break
            record["delay"] = delay
            await asyncio.sleep(delay)
        return await self.images_from_record(record, check_interrupt), job_id

    async def images_from_record(self, record, check_interrupt):
        results = []
        folder = self.directory / "results" / record["id"]
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        for index, source in enumerate(record["sources"]):
            check_interrupt()
            target = folder / f"{index}.png"
            if not target.exists():
                if source.get("b64_json"):
                    raw = base64.b64decode(source["b64_json"], validate=True)
                elif source.get("url"):
                    raw = await self.download(source["url"])
                else:
                    raise OneYesError("图片原件地址缺失，请稍后再次取回")
                with Image.open(io.BytesIO(raw)) as image:
                    temporary = target.with_suffix(".part")
                    image.convert("RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB").save(temporary, format="PNG")
                    temporary.replace(target)
            with Image.open(target) as image:
                results.append(image.copy())
        return results

    async def text(self, model, prompt, system, temperature):
        origin = (await self.models("text"))["origin"]
        messages = []
        if system.strip():
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        try:
            value, _ = await self.request(origin, "/chat/completions", self.vault.key("text"), {"model": model, "messages": messages, "temperature": temperature, "stream": False})
        except (aiohttp.ClientError, TimeoutError):
            raise OneYesError("连接中断，请在官网核对原请求；不会自动重复提交") from None
        choices = value.get("choices", [])
        if not choices or not isinstance(choices[0].get("message", {}).get("content"), str):
            raise OneYesError("此模型没有返回文字，请核对模型支持的文本接口")
        return choices[0]["message"]["content"]
