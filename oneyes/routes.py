import hmac
import os

from aiohttp import web
from server import PromptServer

from .service import OneYesClient, OneYesError
from .storage import PROFILES


client = OneYesClient()


def authorize(request):
    if request.remote not in ("127.0.0.1", "::1") or request.host not in (f"127.0.0.1:{request.url.port}", f"localhost:{request.url.port}", f"[::1]:{request.url.port}"):
        raise web.HTTPForbidden(text="OneYes settings are local-only")
    origin = request.headers.get("Origin")
    if origin and origin != f"{request.scheme}://{request.host}":
        raise web.HTTPForbidden()
    if request.headers.get("Sec-Fetch-Site") == "cross-site":
        raise web.HTTPForbidden()
    token = os.environ.get("ONEYES_LOCAL_TOKEN")
    if token and not hmac.compare_digest(request.headers.get("X-OneYes-Session", ""), token):
        raise web.HTTPForbidden()


@PromptServer.instance.routes.get("/oneyes/settings")
async def settings(request):
    authorize(request)
    return web.json_response({"configured": client.vault.status()}, headers={"Cache-Control": "no-store"})


@PromptServer.instance.routes.put("/oneyes/settings")
async def save_settings(request):
    authorize(request)
    if request.content_type != "application/json":
        raise web.HTTPUnsupportedMediaType()
    data = await request.json()
    if not isinstance(data, dict) or set(data) - set(PROFILES) or any(not isinstance(value, str) for value in data.values()):
        raise web.HTTPBadRequest()
    client.vault.save(data)
    return web.json_response({"configured": client.vault.status()})


@PromptServer.instance.routes.get("/oneyes/models/{profile}")
async def models(request):
    authorize(request)
    profile = request.match_info["profile"]
    if profile not in PROFILES:
        raise web.HTTPBadRequest()
    try:
        return web.json_response(await client.models(profile), headers={"Cache-Control": "no-store"})
    except (OneYesError, ValueError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except (OSError, TimeoutError):
        return web.json_response({"error": "模型列表连接失败，请检查网络或代理后重试"}, status=502)


@PromptServer.instance.routes.get("/oneyes/tasks")
async def tasks(request):
    authorize(request)
    return web.json_response({"tasks": client.records()}, headers={"Cache-Control": "no-store"})


@PromptServer.instance.routes.get("/oneyes/native-nodes")
async def native_nodes(request):
    authorize(request)
    # Imported here because native adapters share the client owned by these routes.
    from .native import NATIVE_NODES, NativeNode
    from .elevenlabs import UNAVAILABLE_NODES, UNAVAILABLE_REASON
    metadata = {node.define_schema().node_id: {"profile": node.profile, "prefixes": node.model_prefixes, "includes": node.model_includes, "excludes": node.model_excludes} for node in NATIVE_NODES if issubclass(node, NativeNode)}
    metadata.update({node.define_schema().node_id: {"unavailable": UNAVAILABLE_REASON} for node in UNAVAILABLE_NODES})
    return web.json_response(metadata)
