from __future__ import annotations

import asyncio
import base64
import io
import importlib
import json
import socket
import threading
import time
import zipfile

import httpx
from fastapi.testclient import TestClient
from PIL import Image

_image_buffer = io.BytesIO()
Image.new("RGB", (1, 1), (255, 255, 255)).save(_image_buffer, format="PNG")
PIXEL_PNG = _image_buffer.getvalue()
PIXEL_DATA_URL = f"data:image/png;base64,{base64.b64encode(PIXEL_PNG).decode('ascii')}"


def make_client(monkeypatch, tmp_path):
    monkeypatch.setenv("GIP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("GIP_DATABASE_PATH", str(tmp_path / "data" / "test.sqlite3"))
    monkeypatch.setenv("GIP_ASSET_DIR", str(tmp_path / "data" / "assets"))

    import backend.app.config as config
    import backend.app.db as db
    import backend.app.main as main

    importlib.reload(config)
    importlib.reload(db)
    main = importlib.reload(main)
    db.init_db()
    return TestClient(main.app)


def register(client: TestClient, username: str = "alice", password: str = "password123", invite_code: str | None = None):
    payload = {"username": username, "password": password}
    if invite_code is not None:
        payload["inviteCode"] = invite_code
    response = client.post("/api/auth/register", json=payload)
    assert response.status_code == 200
    return response.json()


def login(client: TestClient, username: str, password: str = "password123"):
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200
    return response.json()


def create_channel(client: TestClient, name: str = "OpenAI"):
    response = client.post(
        "/api/admin/channels",
        json={
            "name": name,
            "baseUrl": "https://example.test/v1",
            "apiKey": "sk-test",
            "models": [
                {"id": "gpt-image-2", "label": "GPT Image 2", "apiMode": "images", "enabled": True},
                {"id": "gpt-5.5", "label": "GPT 5.5", "apiMode": "responses", "enabled": True},
            ],
            "timeoutSeconds": 45,
            "codexCli": False,
            "codexCliMode": "auto",
            "isEnabled": True,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["timeoutSeconds"] == 45
    assert body["codexCliMode"] == "auto"
    assert body["healthStatus"] == "unknown"
    assert body["compatibilityStatus"] == "unknown"
    return body


def mock_open_prompt_readme(monkeypatch, readme: str) -> None:
    import backend.app.main as main

    class FakeAsyncClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url):
            request = httpx.Request("GET", url)
            return httpx.Response(200, text=readme, request=request)

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeAsyncClient)


class FakeRemoteImageResponse:
    def __init__(self, data: bytes, content_type: str = "image/png", status_code: int = 200):
        self.status_code = status_code
        self.headers = {"content-type": content_type, "content-length": str(len(data))}
        self._data = data

    def to_http_bytes(self) -> bytes:
        reason = "OK" if self.status_code < 400 else "Error"
        header_lines = [f"HTTP/1.1 {self.status_code} {reason}"]
        header_lines.extend(f"{key}: {value}" for key, value in self.headers.items())
        return ("\r\n".join(header_lines) + "\r\n\r\n").encode("ascii") + self._data


class FakeRemoteImageWriter:
    def write(self, _data: bytes) -> None:
        pass

    async def drain(self) -> None:
        pass

    def close(self) -> None:
        pass

    async def wait_closed(self) -> None:
        pass


class FakeRemoteImageClient:
    calls = 0
    response = FakeRemoteImageResponse(PIXEL_PNG)

    @staticmethod
    async def open_connection(**_kwargs):
        FakeRemoteImageClient.calls += 1
        reader = asyncio.StreamReader()
        reader.feed_data(FakeRemoteImageClient.response.to_http_bytes())
        reader.feed_eof()
        return reader, FakeRemoteImageWriter()


def template_payload(channel_id: str):
    return {
        "title": "Hero product",
        "description": "Clean white background",
        "prompt": "A premium bottle on white background",
        "negativePrompt": None,
        "tags": ["product", "white"],
        "category": "commerce",
        "params": {
            "size": "auto",
            "quality": "auto",
            "output_format": "png",
            "output_compression": None,
            "moderation": "auto",
            "n": 1,
        },
        "channelId": channel_id,
        "apiMode": "images",
        "model": "gpt-image-2",
        "coverImageId": None,
        "linkedTaskIds": [],
        "isFavorite": False,
    }


def mock_remote_image_download(monkeypatch, data: bytes = PIXEL_PNG, content_type: str = "image/png") -> type[FakeRemoteImageClient]:
    import backend.app.remote_image_cache as remote_image_cache

    FakeRemoteImageClient.calls = 0
    FakeRemoteImageClient.response = FakeRemoteImageResponse(data, content_type)
    monkeypatch.setattr(remote_image_cache, "_open_connection", FakeRemoteImageClient.open_connection)
    async def resolve_public_host(_hostname):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 443))]

    monkeypatch.setattr(remote_image_cache, "_resolve_addresses", resolve_public_host)
    return FakeRemoteImageClient


def wait_for_task(client: TestClient, task_id: str, timeout: float = 3.0):
    deadline = time.time() + timeout
    task = client.get(f"/api/generations/{task_id}").json()
    while task["status"] in {"queued", "running"} and time.time() < deadline:
        time.sleep(0.05)
        task = client.get(f"/api/generations/{task_id}").json()
    return task


def test_auth_register_login_logout(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    user = register(client)
    assert user["username"] == "alice"
    assert client.get("/api/auth/me").json()["username"] == "alice"

    logout = client.post("/api/auth/logout")
    assert logout.status_code == 200
    assert client.get("/api/auth/me").status_code == 401

    login = client.post("/api/auth/login", json={"username": "alice", "password": "password123"})
    assert login.status_code == 200
    assert client.get("/api/auth/me").json()["username"] == "alice"


def test_admin_can_close_registration_and_reopen(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    register(client)
    settings = client.get("/api/auth/settings")
    assert settings.status_code == 200
    assert settings.json()["registrationMode"] == "open"

    updated = client.patch("/api/admin/auth/settings", json={"registrationMode": "disabled"})
    assert updated.status_code == 200
    assert updated.json()["registrationMode"] == "disabled"
    assert updated.json()["allowRegistration"] is False

    client.post("/api/auth/logout")
    blocked = client.post("/api/auth/register", json={"username": "bob", "password": "password123"})
    assert blocked.status_code == 403
    assert "关闭" in blocked.text

    login(client, "alice")
    reopened = client.patch("/api/admin/auth/settings", json={"registrationMode": "open"})
    assert reopened.status_code == 200
    client.post("/api/auth/logout")

    second_user = client.post("/api/auth/register", json={"username": "bob", "password": "password123"})
    assert second_user.status_code == 200
    assert second_user.json()["role"] == "user"


def test_invite_only_registration_requires_valid_invite_code(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    register(client)
    switched = client.patch("/api/admin/auth/settings", json={"registrationMode": "invite_only"})
    assert switched.status_code == 200
    assert switched.json()["inviteCodeRequired"] is True

    created = client.post(
        "/api/admin/auth/invite-codes",
        json={"note": "beta", "maxUses": 1},
    )
    assert created.status_code == 200
    invite = created.json()
    assert invite["usedCount"] == 0
    assert invite["remainingUses"] == 1

    client.post("/api/auth/logout")
    missing = client.post("/api/auth/register", json={"username": "bob", "password": "password123"})
    assert missing.status_code == 400
    assert "邀请码" in missing.text

    invalid = client.post(
        "/api/auth/register",
        json={"username": "bob", "password": "password123", "inviteCode": "INV-INVALID"},
    )
    assert invalid.status_code == 400

    accepted = client.post(
        "/api/auth/register",
        json={"username": "bob", "password": "password123", "inviteCode": invite["code"]},
    )
    assert accepted.status_code == 200
    assert accepted.json()["role"] == "user"

    login(client, "alice")
    listed = client.get("/api/admin/auth/invite-codes")
    assert listed.status_code == 200
    updated_invite = next(item for item in listed.json() if item["id"] == invite["id"])
    assert updated_invite["usedCount"] == 1
    assert updated_invite["recentUses"][0]["username"] == "bob"

    client.post("/api/auth/logout")
    exhausted = client.post(
        "/api/auth/register",
        json={"username": "carol", "password": "password123", "inviteCode": invite["code"]},
    )
    assert exhausted.status_code == 400
    assert "用完" in exhausted.text


def test_admin_can_batch_create_invite_codes(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    register(client)
    created = client.post(
        "/api/admin/auth/invite-codes/batch",
        json={"count": 3, "note": "batch", "maxUses": 2},
    )
    assert created.status_code == 200
    body = created.json()
    assert len(body) == 3
    assert len({item["code"] for item in body}) == 3
    assert all(item["note"] == "batch" for item in body)
    assert all(item["maxUses"] == 2 for item in body)

    listed = client.get("/api/admin/auth/invite-codes")
    assert listed.status_code == 200
    assert len(listed.json()) == 3


def test_admin_batch_invite_codes_default_to_single_use(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    register(client)
    created = client.post(
        "/api/admin/auth/invite-codes/batch",
        json={"count": 2, "note": "default-single-use"},
    )
    assert created.status_code == 200
    body = created.json()
    assert len(body) == 2
    assert all(item["maxUses"] == 1 for item in body)
    assert all(item["remainingUses"] == 1 for item in body)


def test_admin_can_edit_invite_code_metadata(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    register(client)
    created = client.post(
        "/api/admin/auth/invite-codes",
        json={"note": "old", "maxUses": 2},
    )
    assert created.status_code == 200
    invite = created.json()

    expires_at = int(time.time() * 1000) + 86400000
    updated = client.patch(
        f"/api/admin/auth/invite-codes/{invite['id']}",
        json={"note": "new note", "maxUses": 5, "expiresAt": expires_at},
    )
    assert updated.status_code == 200
    body = updated.json()
    assert body["note"] == "new note"
    assert body["maxUses"] == 5
    assert body["expiresAt"] == expires_at

    cleared = client.patch(
        f"/api/admin/auth/invite-codes/{invite['id']}",
        json={"maxUses": None, "expiresAt": None},
    )
    assert cleared.status_code == 200
    cleared_body = cleared.json()
    assert cleared_body["maxUses"] is None
    assert cleared_body["expiresAt"] is None


def test_admin_invite_code_patch_rejects_null_enabled(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    register(client)
    created = client.post(
        "/api/admin/auth/invite-codes",
        json={"note": "nullable-enabled"},
    )
    assert created.status_code == 200
    invite = created.json()

    invalid = client.patch(
        f"/api/admin/auth/invite-codes/{invite['id']}",
        json={"isEnabled": None},
    )
    assert invalid.status_code == 400
    assert "不能为空" in invalid.text


def test_admin_can_list_full_invite_code_use_history(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    admin = register(client)
    switched = client.patch("/api/admin/auth/settings", json={"registrationMode": "invite_only"})
    assert switched.status_code == 200
    created = client.post(
        "/api/admin/auth/invite-codes",
        json={"note": "history"},
    )
    assert created.status_code == 200
    invite = created.json()

    client.post("/api/auth/logout")
    first_user = client.post(
        "/api/auth/register",
        json={"username": "bob", "password": "password123", "inviteCode": invite["code"]},
    )
    assert first_user.status_code == 200

    client.post("/api/auth/logout")
    second_user = client.post(
        "/api/auth/register",
        json={"username": "carol", "password": "password123", "inviteCode": invite["code"]},
    )
    assert second_user.status_code == 200

    client.post("/api/auth/logout")
    login(client, admin["username"])
    uses = client.get(f"/api/admin/auth/invite-codes/{invite['id']}/uses?limit=10")
    assert uses.status_code == 200
    body = uses.json()
    assert len(body) == 2
    assert [item["username"] for item in body] == ["carol", "bob"]


def test_template_crud_duplicate_and_generation_link(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    register(client)
    channel = create_channel(client)

    created = client.post("/api/templates", json=template_payload(channel["id"]))
    assert created.status_code == 200
    template = created.json()
    assert template["version"] == 1
    assert template["usageCount"] == 0
    assert template["qualityScore"] > 0

    patched = client.patch(f"/api/templates/{template['id']}", json={"isFavorite": True, "tags": ["product", "studio"]})
    assert patched.status_code == 200
    assert patched.json()["isFavorite"] is True
    assert patched.json()["version"] == 2

    duplicated = client.post(f"/api/templates/{template['id']}/duplicate")
    assert duplicated.status_code == 200
    assert duplicated.json()["title"].endswith("副本")
    assert duplicated.json()["linkedTaskIds"] == []

    used = client.post(f"/api/templates/{template['id']}/use")
    assert used.status_code == 200
    assert used.json()["usageCount"] == 1
    assert used.json()["lastUsedAt"] is not None

    task_payload = {
        "templateId": template["id"],
        "templateVersionId": str(patched.json()["version"]),
        "prompt": "A premium bottle on white background",
        "params": template_payload(channel["id"])["params"],
        "inputImageIds": [],
        "outputImages": [],
        "status": "done",
        "channelId": channel["id"],
        "apiMode": "images",
        "model": "gpt-image-2",
    }
    task = client.post("/api/generations", json=task_payload)
    assert task.status_code == 200
    assert task.json()["templateId"] == template["id"]
    generations = client.get("/api/generations").json()
    assert generations["total"] == 1
    assert len(generations["items"]) == 1

    deleted = client.delete(f"/api/templates/{template['id']}")
    assert deleted.status_code == 200


def test_generation_list_pagination(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    register(client)
    channel = create_channel(client)

    for index in range(5):
        response = client.post(
            "/api/generations",
            json={
                "prompt": f"Task {index}",
                "params": template_payload(channel["id"])["params"],
                "inputImageIds": [],
                "outputImages": [],
                "status": "done",
                "createdAt": 1000 + index,
                "channelId": channel["id"],
                "apiMode": "images",
                "model": "gpt-image-2",
            },
        )
        assert response.status_code == 200

    first_page = client.get("/api/generations?limit=2&offset=0")
    assert first_page.status_code == 200
    first_body = first_page.json()
    assert first_body["total"] == 5
    assert first_body["limit"] == 2
    assert first_body["offset"] == 0
    assert first_body["hasMore"] is True
    assert [item["prompt"] for item in first_body["items"]] == ["Task 4", "Task 3"]

    second_body = client.get("/api/generations?limit=2&offset=2").json()
    assert {item["id"] for item in first_body["items"]}.isdisjoint({item["id"] for item in second_body["items"]})
    assert [item["prompt"] for item in second_body["items"]] == ["Task 2", "Task 1"]

    assert client.get("/api/generations?limit=0").status_code == 422
    assert client.get("/api/generations?limit=201").status_code == 422
    assert client.get("/api/generations?offset=-1").status_code == 422


def test_template_list_pagination_and_scope_permissions(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    register(client)
    channel = create_channel(client)

    for index in range(5):
        payload = template_payload(channel["id"])
        payload["title"] = f"Template {index}"
        response = client.post("/api/templates", json=payload)
        assert response.status_code == 200

    first_page = client.get("/api/templates?scope=all&limit=2&offset=0")
    assert first_page.status_code == 200
    first_body = first_page.json()
    assert first_body["total"] == 5
    assert first_body["limit"] == 2
    assert first_body["offset"] == 0
    assert first_body["hasMore"] is True
    assert len(first_body["items"]) == 2

    second_body = client.get("/api/templates?scope=all&limit=2&offset=2").json()
    assert {item["id"] for item in first_body["items"]}.isdisjoint({item["id"] for item in second_body["items"]})
    assert client.get("/api/templates?scope=mine&limit=2").json()["total"] == 5
    assert client.get("/api/templates?scope=public&limit=2").json()["total"] == 5

    client.post("/api/auth/logout")
    register(client, "bob")
    assert client.get("/api/templates?scope=submissions").status_code == 403
    assert client.get("/api/templates?limit=0").status_code == 422
    assert client.get("/api/templates?limit=201").status_code == 422
    assert client.get("/api/templates?offset=-1").status_code == 422


def test_open_prompt_library_import_sources_and_dedupes(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    register(client)
    create_channel(client)

    readme = """
### Test Product Ad
<img width="500" alt="image" src="assets/test-product.jpg" />

**Prompt:**
```text
A premium test product on a clean studio background
```
**Source:** [@tester](https://x.com/tester/status/1)
"""

    mock_open_prompt_readme(monkeypatch, readme)

    preview = client.get("/api/admin/templates/import-open-library/preview?source=zerolu&limit=1")
    assert preview.status_code == 200
    preview_body = preview.json()
    assert preview_body["source"] == "zerolu"
    assert preview_body["total"] == 1
    assert preview_body["loaded"] == 1
    assert preview_body["truncated"] is False
    assert preview_body["newCount"] == 1
    assert preview_body["duplicateCount"] == 0
    assert preview_body["items"][0]["isDuplicate"] is False
    assert preview_body["items"][0]["qualityScore"] >= 70
    assert preview_body["highQualityCount"] == 1
    assert preview_body["highQualityNewCount"] == 1
    selected_key = preview_body["items"][0]["key"]

    imported = client.post(
        "/api/admin/templates/import-open-library",
        json={"source": "zerolu", "limit": 1, "selectedKeys": [selected_key]},
    )
    assert imported.status_code == 200
    assert imported.json()["source"] == "zerolu"
    assert imported.json()["created"] == 1

    templates = client.get("/api/templates?scope=public").json()
    assert templates["total"] == 1
    assert len(templates["items"]) == 1
    assert templates["items"][0]["sourceName"] == "ZeroLu awesome-gpt-image"
    assert templates["items"][0]["sourceAuthor"] == "@tester"
    assert templates["items"][0]["licenseName"] == "MIT"
    assert templates["items"][0]["externalCoverUrl"].endswith("/assets/test-product.jpg")
    assert templates["items"][0]["exampleImages"][0].endswith("/assets/test-product.jpg")
    assert templates["items"][0]["recommendedModel"] == "gpt-image-2"
    assert templates["items"][0]["qualityScore"] >= 70

    sources = client.get("/api/admin/open-prompt-sources")
    assert sources.status_code == 200
    zerolu = next(item for item in sources.json() if item["id"] == "zerolu")
    assert zerolu["importedCount"] == 1
    assert zerolu["licenseName"] == "MIT"

    from backend.app.db import get_conn
    with get_conn() as conn:
        conn.execute(
            "UPDATE prompt_templates SET quality_score = ? WHERE id = ?",
            (95, templates["items"][0]["id"]),
        )

    repeated_preview = client.get("/api/admin/templates/import-open-library/preview?source=zerolu&limit=1")
    assert repeated_preview.status_code == 200
    assert repeated_preview.json()["items"][0]["isDuplicate"] is True
    assert repeated_preview.json()["newCount"] == 0
    assert repeated_preview.json()["duplicateCount"] == 1

    repeated = client.post(
        "/api/admin/templates/import-open-library",
        json={"source": "zerolu", "limit": 1, "selectedKeys": [selected_key]},
    )
    assert repeated.status_code == 200
    assert repeated.json()["created"] == 0
    assert repeated.json()["skipped"] == 1
    refreshed_templates = client.get("/api/templates?scope=public").json()
    assert refreshed_templates["items"][0]["qualityScore"] == 95


def test_open_prompt_preview_keeps_sparse_prompts_below_high_quality(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    register(client)
    create_channel(client)

    readme = """
### Simple Scene

**Prompt:**
```text
A photo of a plain object on a simple background with soft studio lighting.
```
"""

    mock_open_prompt_readme(monkeypatch, readme)

    preview = client.get("/api/admin/templates/import-open-library/preview?source=zerolu&limit=1")
    assert preview.status_code == 200
    preview_body = preview.json()
    assert preview_body["items"][0]["qualityScore"] < 70
    assert preview_body["highQualityCount"] == 0
    assert preview_body["highQualityNewCount"] == 0


def test_open_prompt_preview_rejects_code_like_prompt_sections(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    register(client)
    create_channel(client)

    readme = """
### API Usage

**Prompt:**
```text
npm install image-sdk
import { renderImage } from 'image-sdk'
const result = await renderImage({ prompt: 'Create a cinematic product photo with studio lighting' })
```
"""

    mock_open_prompt_readme(monkeypatch, readme)

    preview = client.get("/api/admin/templates/import-open-library/preview?source=zerolu&limit=1")
    assert preview.status_code == 200
    preview_body = preview.json()
    assert preview_body["total"] == 0
    assert preview_body["items"] == []


def test_open_prompt_import_respects_empty_selection_and_omitted_selection(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    register(client)
    create_channel(client)

    readme = """
### Test Product Ad
<img width="500" alt="image" src="assets/test-product.jpg" />

**Prompt:**
```text
A premium test product on a clean studio background
```
**Source:** [@tester](https://x.com/tester/status/1)
"""

    mock_open_prompt_readme(monkeypatch, readme)

    empty_import = client.post(
        "/api/admin/templates/import-open-library",
        json={"source": "zerolu", "limit": 1, "selectedKeys": []},
    )
    assert empty_import.status_code == 200
    assert empty_import.json()["created"] == 0
    empty_templates = client.get("/api/templates?scope=public").json()
    assert empty_templates["items"] == []
    assert empty_templates["total"] == 0

    imported = client.post(
        "/api/admin/templates/import-open-library",
        json={"source": "zerolu", "limit": 1},
    )
    assert imported.status_code == 200
    assert imported.json()["created"] == 1
    templates = client.get("/api/templates?scope=public").json()
    assert templates["total"] == 1
    assert len(templates["items"]) == 1


def test_asset_upload_read_delete(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.routes.assets as assets_mod

    register(client)
    copied_paths: list[str] = []
    monkeypatch.setattr(assets_mod, "copy_image_file_to_system_clipboard", lambda path: copied_paths.append(str(path)))

    upload = client.post(
        "/api/assets",
        files={"file": ("pixel.png", PIXEL_PNG, "image/png")},
    )
    assert upload.status_code == 200
    asset = upload.json()
    assert asset["mime"] == "image/png"
    assert asset["sizeBytes"] == len(PIXEL_PNG)
    assert asset["width"] == 1
    assert asset["height"] == 1
    assert asset["hasThumbnail"] is True

    read = client.get(f"/api/assets/{asset['id']}")
    assert read.status_code == 200
    assert read.content == PIXEL_PNG

    thumbnail = client.get(f"/api/assets/{asset['id']}/thumbnail")
    assert thumbnail.status_code == 200
    assert thumbnail.headers["content-type"] == "image/webp"

    copied = client.post(f"/api/assets/{asset['id']}/copy-to-clipboard")
    assert copied.status_code == 200
    assert copied.json()["method"] == "system"
    assert copied_paths and copied_paths[0].endswith(".png")

    deleted = client.delete(f"/api/assets/{asset['id']}")
    assert deleted.status_code == 200
    assert client.get(f"/api/assets/{asset['id']}").status_code == 404


def test_asset_upload_rejects_trusted_metadata(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    register(client)

    forged = client.post(
        "/api/assets",
        files={"file": ("pixel.png", PIXEL_PNG, "image/png")},
        data={"type": "generated", "taskId": "fake-task", "templateId": "fake-template"},
    )

    assert forged.status_code == 400


def test_template_remote_image_cache_is_allowlisted_and_reused(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    register(client)
    channel = create_channel(client)
    client.post("/api/auth/logout")
    register(client, "bob")
    fake_client = mock_remote_image_download(monkeypatch)

    payload = template_payload(channel["id"])
    payload["externalCoverUrl"] = "https://cdn.example.test/cover.png"
    created = client.post("/api/templates", json=payload)
    assert created.status_code == 200
    template = created.json()
    cache_url = template["cachedExternalCoverUrl"]
    assert cache_url.startswith(f"/api/assets/remote-cache/templates/{template['id']}?url=")

    first = client.get(cache_url)
    assert first.status_code == 200
    assert first.content == PIXEL_PNG
    assert first.headers["cache-control"] == "private, no-store"
    assert fake_client.calls == 1
    assert (tmp_path / "data" / "assets" / "remote-cache").exists()

    second = client.get(cache_url)
    assert second.status_code == 200
    assert second.content == PIXEL_PNG
    assert second.headers["cache-control"] == "private, no-store"
    assert fake_client.calls == 1

    from backend.app.db import get_conn

    with get_conn() as conn:
        conn.execute(
            "UPDATE prompt_templates SET visibility = 'public', submission_status = 'approved' WHERE id = ?",
            (template["id"],),
        )

    public = client.get(cache_url)
    assert public.status_code == 200
    assert public.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert fake_client.calls == 1

    blocked = client.get(f"/api/assets/remote-cache/templates/{template['id']}?url=https://evil.example.test/other.png")
    assert blocked.status_code == 404


def test_remote_image_cache_prunes_old_files_over_size_limit(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    register(client)
    channel = create_channel(client)

    import backend.app.config as config
    import backend.app.remote_image_cache as remote_image_cache

    monkeypatch.setattr(config.settings, "remote_image_cache_max_bytes", len(PIXEL_PNG) + 10)
    fake_client = mock_remote_image_download(monkeypatch)

    first_payload = template_payload(channel["id"])
    first_payload["externalCoverUrl"] = "https://cdn.example.test/prune-first.png"
    first_template = client.post("/api/templates", json=first_payload).json()
    assert client.get(first_template["cachedExternalCoverUrl"]).status_code == 200
    first_path = remote_image_cache._cache_path("https://cdn.example.test/prune-first.png", ".png")
    assert first_path.exists()

    second_payload = template_payload(channel["id"])
    second_payload["title"] = "Second remote image"
    second_payload["externalCoverUrl"] = "https://cdn.example.test/prune-second.png"
    second_template = client.post("/api/templates", json=second_payload).json()
    assert client.get(second_template["cachedExternalCoverUrl"]).status_code == 200
    second_path = remote_image_cache._cache_path("https://cdn.example.test/prune-second.png", ".png")

    assert fake_client.calls == 2
    assert not first_path.exists()
    assert second_path.exists()


def test_remote_image_cache_rejects_unsafe_hosts_and_payloads(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    register(client)
    channel = create_channel(client)

    localhost_payload = template_payload(channel["id"])
    localhost_payload["externalCoverUrl"] = "http://127.0.0.1/cover.png"
    localhost_template = client.post("/api/templates", json=localhost_payload).json()
    localhost = client.get(localhost_template["cachedExternalCoverUrl"])
    assert localhost.status_code == 400

    bad_type_payload = template_payload(channel["id"])
    bad_type_payload["title"] = "Bad type"
    bad_type_payload["externalCoverUrl"] = "https://cdn.example.test/bad.txt"
    bad_type_template = client.post("/api/templates", json=bad_type_payload).json()
    mock_remote_image_download(monkeypatch, b"not image", "text/plain")
    bad_type = client.get(bad_type_template["cachedExternalCoverUrl"])
    assert bad_type.status_code == 415

    huge_payload = template_payload(channel["id"])
    huge_payload["title"] = "Huge image"
    huge_payload["externalCoverUrl"] = "https://cdn.example.test/huge.png"
    huge_template = client.post("/api/templates", json=huge_payload).json()
    mock_remote_image_download(monkeypatch, b"x" * (10 * 1024 * 1024 + 1), "image/png")
    huge = client.get(huge_template["cachedExternalCoverUrl"])
    assert huge.status_code == 413


def test_remote_image_cache_uses_current_asset_dir_after_reload(monkeypatch, tmp_path):
    first_client = make_client(monkeypatch, tmp_path / "first")
    register(first_client)
    first_channel = create_channel(first_client)
    first_fake = mock_remote_image_download(monkeypatch)

    first_payload = template_payload(first_channel["id"])
    first_payload["externalCoverUrl"] = "https://cdn.example.test/first.png"
    first_template = first_client.post("/api/templates", json=first_payload).json()
    assert first_client.get(first_template["cachedExternalCoverUrl"]).status_code == 200
    assert first_fake.calls == 1

    second_client = make_client(monkeypatch, tmp_path / "second")
    register(second_client)
    second_channel = create_channel(second_client)
    second_fake = mock_remote_image_download(monkeypatch)

    second_payload = template_payload(second_channel["id"])
    second_payload["externalCoverUrl"] = "https://cdn.example.test/second.png"
    second_template = second_client.post("/api/templates", json=second_payload).json()
    assert second_client.get(second_template["cachedExternalCoverUrl"]).status_code == 200

    assert second_fake.calls == 1
    assert (tmp_path / "second" / "data" / "assets" / "remote-cache").exists()


def test_remote_image_cache_handles_chunked_responses(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    register(client)
    channel = create_channel(client)

    payload = template_payload(channel["id"])
    payload["externalCoverUrl"] = "https://cdn.example.test/chunked.png"
    created = client.post("/api/templates", json=payload)
    assert created.status_code == 200
    cache_url = created.json()["cachedExternalCoverUrl"]

    import backend.app.remote_image_cache as remote_image_cache

    async def resolve_public_host(_hostname):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 443))]

    monkeypatch.setattr(remote_image_cache, "_resolve_addresses", resolve_public_host)

    async def open_chunked_connection(**_kwargs):
        reader = asyncio.StreamReader()
        reader.feed_data(
            b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\n\r\n"
            + f"{len(PIXEL_PNG):x}".encode("ascii")
            + b"\r\n"
            + PIXEL_PNG
            + b"\r\n0\r\n\r\n"
        )
        reader.feed_eof()
        return reader, FakeRemoteImageWriter()

    monkeypatch.setattr(remote_image_cache, "_open_connection", open_chunked_connection)
    cached = client.get(cache_url)
    assert cached.status_code == 200
    assert cached.content == PIXEL_PNG

    payload["title"] = "Bad chunk metadata"
    payload["externalCoverUrl"] = "https://cdn.example.test/bad-chunk.png"
    bad_template = client.post("/api/templates", json=payload).json()

    async def open_bad_chunked_connection(**_kwargs):
        reader = asyncio.StreamReader()
        reader.feed_data(
            b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\n\r\n"
            + b"f" * 5000
        )
        reader.feed_eof()
        return reader, FakeRemoteImageWriter()

    monkeypatch.setattr(remote_image_cache, "_open_connection", open_bad_chunked_connection)
    rejected = client.get(bad_template["cachedExternalCoverUrl"])
    assert rejected.status_code == 502


def test_open_prompt_remote_cache_url_is_bound_to_preview_image(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    register(client)
    create_channel(client)

    readme = """
### Test Product Ad
<img width="500" alt="image" src="assets/test-product.jpg" />

**Prompt:**
```text
A premium test product on a clean studio background
```
**Source:** [@tester](https://x.com/tester/status/1)
"""
    fetched_readme = readme

    import backend.app.routes.templates as templates_mod
    import backend.app.remote_image_cache as remote_image_cache

    class FakeOpenPromptClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url):
            request = httpx.Request("GET", url)
            return httpx.Response(200, text=fetched_readme, request=request)

    FakeRemoteImageClient.calls = 0
    FakeRemoteImageClient.response = FakeRemoteImageResponse(PIXEL_PNG)
    monkeypatch.setattr(templates_mod.httpx, "AsyncClient", FakeOpenPromptClient)
    monkeypatch.setattr(remote_image_cache, "_open_connection", FakeRemoteImageClient.open_connection)
    async def resolve_public_host(_hostname):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 443))]

    monkeypatch.setattr(remote_image_cache, "_resolve_addresses", resolve_public_host)

    preview = client.get("/api/admin/templates/import-open-library/preview?source=zerolu&limit=1")
    assert preview.status_code == 200
    item = preview.json()["items"][0]
    assert item["cachedImage"].startswith("/api/assets/remote-cache/open-prompt/zerolu/")
    assert "url=https%3A%2F%2Fraw.githubusercontent.com" in item["cachedImage"]
    assert "sig=" in item["cachedImage"]

    fetched_readme = readme.replace("assets/test-product.jpg", "assets/changed-product.jpg")
    cached = client.get(item["cachedImage"])
    assert cached.status_code == 200
    assert cached.content == PIXEL_PNG
    assert cached.headers["cache-control"] == "public, max-age=31536000, immutable"

    tampered = client.get(item["cachedImage"].replace("test-product.jpg", "changed-product.jpg"))
    assert tampered.status_code == 404

    missing = client.get("/api/assets/remote-cache/open-prompt/zerolu/not-a-real-key")
    assert missing.status_code == 422


def test_async_generation_run_persists_task_assets_and_metadata(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.main as main

    register(client)
    channel = create_channel(client)

    async def fake_call_upstream(_payload):
        return (
            [PIXEL_DATA_URL],
            {"size": "1024x1024", "quality": "high"},
            [{"size": "1024x1024", "quality": "high"}],
            ["A revised studio prompt"],
        )

    monkeypatch.setattr("backend.app.routes.generations.call_upstream", fake_call_upstream)

    payload = {
        "channelId": channel["id"],
        "model": "gpt-image-2",
        "prompt": "A bottle on a clean white background",
        "params": template_payload(channel["id"])["params"],
        "inputImageDataUrls": [],
        "maskDataUrl": None,
    }
    started = client.post("/api/generations/run", json=payload)
    assert started.status_code == 200
    task_id = started.json()["task"]["id"]
    assert started.json()["task"]["status"] == "queued"

    task = wait_for_task(client, task_id)
    assert task["status"] == "done"
    assert task["actualParams"]["n"] == 1
    assert task["actualParamsByImage"]
    assert task["revisedPromptByImage"]
    assert len(task["outputImages"]) == 1

    asset_id = task["outputImages"][0]
    asset = client.get(f"/api/assets/{asset_id}")
    assert asset.status_code == 200
    assert asset.content == PIXEL_PNG
    assert client.get(f"/api/assets/{asset_id}/thumbnail").status_code == 200


def test_delete_generation_removes_orphan_assets(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.db as db
    import backend.app.main as main

    register(client)
    channel = create_channel(client)

    async def fake_call_upstream(_payload):
        return (
            [PIXEL_DATA_URL],
            {"size": "1024x1024", "quality": "high"},
            [{"size": "1024x1024", "quality": "high"}],
            ["A revised studio prompt"],
        )

    monkeypatch.setattr("backend.app.routes.generations.call_upstream", fake_call_upstream)

    generated = client.post(
        "/api/generate",
        json={
            "channelId": channel["id"],
            "model": "gpt-image-2",
            "prompt": "A bottle on a clean white background",
            "params": template_payload(channel["id"])["params"],
            "inputImageDataUrls": [],
            "maskDataUrl": None,
        },
    )
    assert generated.status_code == 200
    task = generated.json()["task"]
    asset_id = task["outputImages"][0]

    with db.get_conn() as conn:
        asset_row = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
    assert asset_row is not None

    deleted = client.delete(f"/api/generations/{task['id']}")
    assert deleted.status_code == 200
    assert client.get(f"/api/assets/{asset_id}").status_code == 404
    assert client.get(f"/api/generations/{task['id']}").status_code == 404
    assert not main.Path(asset_row["path"]).exists()


def test_batch_delete_generations_removes_assets_shared_within_deleted_batch(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.db as db
    import backend.app.main as main

    user = register(client)
    channel = create_channel(client)

    async def fake_call_upstream(_payload):
        return (
            [PIXEL_DATA_URL],
            {"size": "1024x1024", "quality": "high"},
            [{"size": "1024x1024", "quality": "high"}],
            ["A revised studio prompt"],
        )

    monkeypatch.setattr("backend.app.routes.generations.call_upstream", fake_call_upstream)

    generated = client.post(
        "/api/generate",
        json={
            "channelId": channel["id"],
            "model": "gpt-image-2",
            "prompt": "A bottle on a clean white background",
            "params": template_payload(channel["id"])["params"],
            "inputImageDataUrls": [],
            "maskDataUrl": None,
        },
    )
    assert generated.status_code == 200
    first_task = generated.json()["task"]
    asset_id = first_task["outputImages"][0]
    second_task_id = "task-shared-asset"

    with db.get_conn() as conn:
        asset_row = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        assert asset_row is not None
        conn.execute(
            """
            INSERT INTO generation_tasks (
              id, user_id, prompt, params_json, input_image_ids_json, mask_target_image_id, mask_image_id,
              output_image_ids_json, actual_params_json, actual_params_by_image_json, revised_prompt_by_image_json,
              status, error, created_at, finished_at, elapsed, is_favorite, diagnostics_json, channel_id, api_mode, model
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                second_task_id,
                user["id"],
                "A second task sharing the first output",
                json.dumps(template_payload(channel["id"])["params"]),
                json.dumps([asset_id]),
                None,
                None,
                json.dumps([asset_id]),
                None,
                None,
                None,
                "done",
                None,
                10,
                20,
                10,
                0,
                "[]",
                channel["id"],
                "images",
                "gpt-image-2",
            ),
        )

    deleted = client.post("/api/generations/batch-delete", json={"ids": [first_task["id"], second_task_id]})

    assert deleted.status_code == 200
    assert deleted.json()["deleted"] == 2
    assert client.get(f"/api/generations/{first_task['id']}").status_code == 404
    assert client.get(f"/api/generations/{second_task_id}").status_code == 404
    assert client.get(f"/api/assets/{asset_id}").status_code == 404
    assert not main.Path(asset_row["path"]).exists()


def test_admin_can_export_and_import_server_backup(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    register(client)
    channel = create_channel(client)

    upload = client.post(
        "/api/assets",
        files={"file": ("pixel.png", PIXEL_PNG, "image/png")},
    )
    assert upload.status_code == 200
    asset = upload.json()

    created = client.post(
        "/api/templates",
        json={**template_payload(channel["id"]), "coverImageId": asset["id"]},
    )
    assert created.status_code == 200
    template = created.json()

    exported = client.get("/api/admin/system/export")
    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith("application/zip")

    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        manifest = json.loads(archive.read("server-backup.json").decode("utf-8"))
    assert manifest["tables"]["users"][0]["username"] == "alice"
    assert asset["id"] in manifest["imageFiles"]
    assert manifest["imageFiles"][asset["id"]]["path"].endswith(f"{asset['id']}.png")
    assert manifest["imageFiles"][asset["id"]]["thumbnailPath"].endswith(f"{asset['id']}.thumb.webp")

    preview = client.post(
        "/api/admin/system/import-preview",
        files={"file": ("backup.zip", exported.content, "application/zip")},
    )
    assert preview.status_code == 200
    preview_body = preview.json()
    assert preview_body["tableCounts"]["users"] == 1
    assert preview_body["tableCounts"]["prompt_templates"] >= 1
    assert preview_body["assetFileCount"] >= 1
    assert preview_body["hasAdminUser"] is True

    client.delete(f"/api/templates/{template['id']}")
    client.delete(f"/api/assets/{asset['id']}")
    assert client.get(f"/api/assets/{asset['id']}").status_code == 404

    imported = client.post(
        "/api/admin/system/import",
        files={"file": ("backup.zip", exported.content, "application/zip")},
    )
    assert imported.status_code == 200
    assert imported.json()["restorePointName"].startswith("restore-")
    assert client.get("/api/auth/me").status_code == 200

    templates = client.get("/api/templates").json()
    assert any(item["id"] == template["id"] for item in templates["items"])
    restored_asset = client.get(f"/api/assets/{asset['id']}")
    assert restored_asset.status_code == 200
    assert restored_asset.content == PIXEL_PNG


def test_backup_import_preserves_admin_when_actor_is_not_in_backup(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    register(client)
    exported = client.get("/api/admin/system/export")
    assert exported.status_code == 200

    with zipfile.ZipFile(io.BytesIO(exported.content)) as source_archive:
        manifest = json.loads(source_archive.read("server-backup.json").decode("utf-8"))
        manifest["tables"]["users"][0]["id"] = "restored-admin-id"
        manifest["tables"]["users"][0]["username"] = "restored-admin"

        backup_buffer = io.BytesIO()
        with zipfile.ZipFile(backup_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as backup_archive:
            for name in source_archive.namelist():
                if name == "server-backup.json":
                    backup_archive.writestr(name, json.dumps(manifest))
                else:
                    backup_archive.writestr(name, source_archive.read(name))

    imported = client.post(
        "/api/admin/system/import",
        files={"file": ("backup.zip", backup_buffer.getvalue(), "application/zip")},
    )
    assert imported.status_code == 200

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["role"] == "admin"

    users = client.get("/api/admin/users")
    assert users.status_code == 200
    assert any(user["role"] == "admin" for user in users.json())


def test_backup_import_rolls_back_when_asset_file_is_missing(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    register(client)
    create_channel(client)

    upload = client.post(
        "/api/assets",
        files={"file": ("pixel.png", PIXEL_PNG, "image/png")},
    )
    assert upload.status_code == 200
    asset = upload.json()

    exported = client.get("/api/admin/system/export")
    assert exported.status_code == 200

    with zipfile.ZipFile(io.BytesIO(exported.content)) as source_archive:
        manifest = json.loads(source_archive.read("server-backup.json").decode("utf-8"))
        missing_asset_path = manifest["imageFiles"][asset["id"]]["path"]

        broken_buffer = io.BytesIO()
        with zipfile.ZipFile(broken_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as broken_archive:
            for name in source_archive.namelist():
                if name == missing_asset_path:
                    continue
                broken_archive.writestr(name, source_archive.read(name))

    imported = client.post(
        "/api/admin/system/import",
        files={"file": ("backup.zip", broken_buffer.getvalue(), "application/zip")},
    )
    assert imported.status_code == 400

    restored_asset = client.get(f"/api/assets/{asset['id']}")
    assert restored_asset.status_code == 200
    assert restored_asset.content == PIXEL_PNG


def test_backup_import_rejects_unsafe_or_oversized_archives(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    register(client)

    import backend.app.routes.admin as admin_mod

    traversal_buffer = io.BytesIO()
    with zipfile.ZipFile(traversal_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("server-backup.json", json.dumps({"tables": {"users": []}, "imageFiles": {}}))
        archive.writestr("../evil.png", PIXEL_PNG)

    traversal = client.post(
        "/api/admin/system/import-preview",
        files={"file": ("backup.zip", traversal_buffer.getvalue(), "application/zip")},
    )
    assert traversal.status_code == 400

    monkeypatch.setattr(admin_mod, "SERVER_BACKUP_MAX_UNCOMPRESSED_BYTES", 10)
    oversized_buffer = io.BytesIO()
    with zipfile.ZipFile(oversized_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("server-backup.json", json.dumps({"tables": {"users": []}, "imageFiles": {}}))

    oversized = client.post(
        "/api/admin/system/import-preview",
        files={"file": ("backup.zip", oversized_buffer.getvalue(), "application/zip")},
    )
    assert oversized.status_code == 413


def test_generation_queue_stats_counts_user_and_global(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    register(client)
    channel = create_channel(client)
    payload = template_payload(channel["id"])["params"]

    queued = client.post(
        "/api/generations",
        json={
            "prompt": "queued task",
            "params": payload,
            "inputImageIds": [],
            "outputImages": [],
            "status": "queued",
            "channelId": channel["id"],
            "apiMode": "images",
            "model": "gpt-image-2",
        },
    )
    assert queued.status_code == 200

    running = client.post(
        "/api/generations",
        json={
            "prompt": "running task",
            "params": payload,
            "inputImageIds": [],
            "outputImages": [],
            "status": "running",
            "channelId": channel["id"],
            "apiMode": "images",
            "model": "gpt-image-2",
        },
    )
    assert running.status_code == 200

    stats = client.get("/api/generations/queue-stats")
    assert stats.status_code == 200
    body = stats.json()
    assert body["workerCount"] >= 1
    assert body["queuedCount"] >= 1
    assert body["runningCount"] >= 1
    assert body["yourQueuedCount"] >= 1
    assert body["yourRunningCount"] >= 1


def test_reviewer_can_review_templates_but_cannot_manage_system(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    admin = register(client)
    channel = create_channel(client)
    client.post("/api/auth/logout")

    reviewer = client.post("/api/auth/register", json={"username": "reviewer", "password": "password123"})
    assert reviewer.status_code == 200
    reviewer_user = reviewer.json()
    assert reviewer_user["role"] == "user"

    client.post("/api/auth/logout")
    login(client, admin["username"])
    updated = client.patch(f"/api/admin/users/{reviewer_user['id']}/role", json={"role": "reviewer"})
    assert updated.status_code == 200
    assert updated.json()["role"] == "reviewer"

    client.post("/api/auth/logout")
    logged_in_reviewer = login(client, "reviewer")
    assert logged_in_reviewer["role"] == "reviewer"

    submissions = client.get("/api/admin/template-submissions")
    assert submissions.status_code == 200
    sources = client.get("/api/admin/open-prompt-sources")
    assert sources.status_code == 200
    channels = client.get("/api/admin/channels")
    assert channels.status_code == 403

    client.post("/api/auth/logout")
    login(client, admin["username"])
    demoted = client.patch(f"/api/admin/users/{admin['id']}/role", json={"role": "user"})
    assert demoted.status_code == 400


def test_async_generation_run_is_rate_limited(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.db as db
    import backend.app.routes.generations as generations

    user = register(client)
    channel = create_channel(client)
    rate_limit_globals = generations.assert_generation_not_rate_limited.__globals__
    rate_limit_state = rate_limit_globals["GENERATION_ATTEMPTS"]
    rate_limit_now_ms = rate_limit_globals["now_ms"]
    monkeypatch.setattr(rate_limit_globals["settings"], "generation_rate_limit", 1)
    rate_limit_state.clear()
    rate_limit_state[user["id"]].append(rate_limit_now_ms())
    monkeypatch.setattr("backend.app.routes.generations.ensure_generation_workers", lambda: None)

    blocked = client.post(
        "/api/generations/run",
        json={
            "channelId": channel["id"],
            "model": "gpt-image-2",
            "prompt": "A bottle on a clean white background",
            "params": template_payload(channel["id"])["params"],
            "inputImageDataUrls": [],
            "maskDataUrl": None,
        },
    )

    assert blocked.status_code == 429
    with db.get_conn() as conn:
        count = conn.execute("SELECT COUNT(*) FROM generation_tasks WHERE user_id = ?", (user["id"],)).fetchone()[0]
    assert count == 0


def test_queued_generation_recovers_after_restart(monkeypatch, tmp_path):
    import backend.app.routes.generations as generations
    _real_ensure_workers = generations.ensure_generation_workers

    with make_client(monkeypatch, tmp_path) as client:
        import backend.app.main as main

        register(client)
        channel = create_channel(client)

        for task in list(main.GENERATION_RUNTIME.worker_tasks):
            task.cancel()
        main.GENERATION_RUNTIME.worker_tasks.clear()
        monkeypatch.setattr("backend.app.routes.generations.ensure_generation_workers", lambda: None)

        payload = {
            "channelId": channel["id"],
            "model": "gpt-image-2",
            "prompt": "A bottle on a clean white background",
            "params": template_payload(channel["id"])["params"],
            "inputImageDataUrls": [PIXEL_DATA_URL],
            "maskDataUrl": None,
        }
        started = client.post("/api/generations/run", json=payload)
        assert started.status_code == 200
        queued = started.json()["task"]
        assert queued["status"] == "queued"
        assert len(queued["inputImageIds"]) == 1
        task_id = queued["id"]

    # Restore real ensure_generation_workers so the second make_client starts workers
    monkeypatch.setattr("backend.app.routes.generations.ensure_generation_workers", _real_ensure_workers)

    class FakeAsyncClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, **kwargs):
            request = httpx.Request("POST", url)
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "b64_json": base64.b64encode(PIXEL_PNG).decode("ascii"),
                            "revised_prompt": "Restarted queue prompt",
                        }
                    ],
                    "size": "1024x1024",
                },
                request=request,
            )

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    with make_client(monkeypatch, tmp_path) as client:
        login(client, "alice")

        task = wait_for_task(client, task_id)
        assert task["status"] == "done"
        assert len(task["inputImageIds"]) == 1
        assert len(task["outputImages"]) == 1
        assert task["error"] is None

        asset = client.get(f"/api/assets/{task['outputImages'][0]}")
        assert asset.status_code == 200
        assert asset.content == PIXEL_PNG


def test_auto_codex_cli_detection_retries_without_quality(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.main as main

    register(client)
    channel = create_channel(client)
    calls: list[dict] = []

    class FakeAsyncClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, **kwargs):
            calls.append({"url": url, **kwargs})
            request = httpx.Request("POST", url)
            if len(calls) == 1:
                return httpx.Response(
                    400,
                    json={"error": {"message": "Unsupported parameter: quality"}},
                    request=request,
                )
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "b64_json": base64.b64encode(PIXEL_PNG).decode("ascii"),
                            "revised_prompt": "A revised studio prompt",
                        }
                    ],
                    "size": "1024x1024",
                },
                request=request,
            )

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeAsyncClient)

    payload = {
        "channelId": channel["id"],
        "model": "gpt-image-2",
        "prompt": "A bottle on a clean white background",
        "params": {**template_payload(channel["id"])["params"], "quality": "high"},
        "inputImageDataUrls": [],
        "maskDataUrl": None,
    }
    generated = client.post("/api/generate", json=payload)

    assert generated.status_code == 200
    assert len(calls) == 2
    assert calls[0]["json"]["quality"] == "high"
    assert "quality" not in calls[1]["json"]
    assert calls[1]["json"]["prompt"].startswith("Use the following text as the complete prompt.")

    channels = client.get("/api/admin/channels").json()
    updated = next(item for item in channels if item["id"] == channel["id"])
    assert updated["codexCliMode"] == "auto"
    assert updated["codexCli"] is True
    assert updated["compatibilityStatus"] == "codex"


def test_channel_patch_empty_api_key_keeps_existing_key(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.main as main

    register(client)
    channel = create_channel(client)

    patched = client.patch(
        f"/api/admin/channels/{channel['id']}",
        json={"name": "Renamed", "apiKey": ""},
    )
    assert patched.status_code == 200
    assert patched.json()["name"] == "Renamed"

    class FakeAsyncClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url, **kwargs):
            request = httpx.Request("GET", url)
            assert kwargs["headers"]["Authorization"] == "Bearer sk-test"
            return httpx.Response(200, json={"data": [{"id": "gpt-image-2"}]}, request=request)

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeAsyncClient)

    checked = client.post(f"/api/admin/channels/{channel['id']}/health-check")
    assert checked.status_code == 200


def test_channel_health_is_public_and_audited(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.main as main

    register(client)
    channel = create_channel(client)

    class FakeAsyncClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url, **kwargs):
            request = httpx.Request("GET", url)
            return httpx.Response(
                200,
                json={"data": [{"id": "gpt-image-2"}, {"id": "gpt-5.5"}]},
                request=request,
            )

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeAsyncClient)

    checked = client.post(f"/api/admin/channels/{channel['id']}/health-check")
    assert checked.status_code == 200
    assert checked.json()["healthStatus"] == "healthy"

    public_channels = client.get("/api/channels")
    assert public_channels.status_code == 200
    public_channel = next(item for item in public_channels.json() if item["id"] == channel["id"])
    assert public_channel["healthStatus"] == "healthy"
    assert "baseUrl" not in public_channel
    assert "apiKeyPreview" not in public_channel

    logs = client.get("/api/admin/audit-logs")
    assert logs.status_code == 200
    actions = [item["action"] for item in logs.json()]
    assert "channel.create" in actions
    assert "channel.health_check" in actions


def test_channel_compatibility_check_detects_standard_and_is_public(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.main as main

    register(client)
    channel = create_channel(client)

    class FakeAsyncClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, **kwargs):
            request = httpx.Request("POST", url)
            assert kwargs["json"]["quality"] == "low"
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "b64_json": base64.b64encode(PIXEL_PNG).decode("ascii"),
                            "revised_prompt": "Compatibility probe",
                        }
                    ],
                    "size": "1024x1024",
                },
                request=request,
            )

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeAsyncClient)

    checked = client.post(f"/api/admin/channels/{channel['id']}/compatibility-check")
    assert checked.status_code == 200
    assert checked.json()["compatibilityStatus"] == "standard"
    assert checked.json()["codexCli"] is False

    public_channel = next(item for item in client.get("/api/channels").json() if item["id"] == channel["id"])
    assert public_channel["compatibilityStatus"] == "standard"
    assert "baseUrl" not in public_channel

    logs = client.get("/api/admin/audit-logs").json()
    assert any(item["action"] == "channel.compatibility_check" for item in logs)


def test_generation_diagnostics_surface_upstream_error_message(monkeypatch, tmp_path):
    make_client(monkeypatch, tmp_path)
    from backend.app.routes.generations import classify_generation_exception

    request = httpx.Request("POST", "https://example.test/v1/images/generations")
    response = httpx.Response(
        400,
        json={"error": {"message": "Prompt blocked by upstream reviewer", "code": "content_policy_violation"}},
        request=request,
    )
    exc = httpx.HTTPStatusError("400 Client Error", request=request, response=response)

    error_message, diagnostics = classify_generation_exception(exc)

    assert diagnostics[0].code == "policy_rejected"
    assert diagnostics[0].title == "上游拒绝生成"
    assert "Prompt blocked by upstream reviewer" in diagnostics[0].detail
    assert "Prompt blocked by upstream reviewer" in error_message


def test_generation_diagnostics_surface_connection_reset(monkeypatch, tmp_path):
    make_client(monkeypatch, tmp_path)
    from backend.app.routes.generations import classify_generation_exception

    request = httpx.Request("POST", "https://example.test/v1/images/generations")
    exc = httpx.ConnectError(
        "[WinError 10054] 远程主机强迫关闭了一个现有的连接。",
        request=request,
    )

    error_message, diagnostics = classify_generation_exception(exc)

    assert diagnostics[0].code == "upstream_connection_reset"
    assert diagnostics[0].title == "上游连接被重置"
    assert "10054" in diagnostics[0].detail
    assert "10054" in error_message


def test_upstream_no_image_reason_for_responses_output_summary(monkeypatch, tmp_path):
    make_client(monkeypatch, tmp_path)
    from backend.app.routes.generations import upstream_no_image_reason

    reason = upstream_no_image_reason(
        {
            "output": [
                {
                    "type": "image_generation_call",
                    "status": "completed",
                    "result": None,
                    "message": "blocked upstream",
                }
            ]
        },
        "responses",
    )

    assert "responses 未返回 image_generation_call.result" in reason
    assert "status=completed" in reason
    assert "message=blocked upstream" in reason


def test_upstream_no_image_reason_for_images_output_summary(monkeypatch, tmp_path):
    make_client(monkeypatch, tmp_path)
    from backend.app.routes.generations import upstream_no_image_reason

    reason = upstream_no_image_reason(
        {
            "data": [
                {
                    "revised_prompt": "refined prompt",
                    "message": "no image payload",
                }
            ]
        },
        "images",
    )

    assert "images data 中没有 b64_json/url" in reason
    assert "字段=message,revised_prompt" in reason
    assert "refined prompt" in reason or "no image payload" in reason


    client = make_client(monkeypatch, tmp_path)
    import backend.app.routes.generations as generations

    user = register(client)
    channel = create_channel(client)
    old_created_at = 1_700_000_000_000

    created = client.post(
        "/api/generations",
        json={
            "prompt": "queued task",
            "params": template_payload(channel["id"])["params"],
            "inputImageIds": [],
            "outputImages": [],
            "status": "queued",
            "createdAt": old_created_at,
            "channelId": channel["id"],
            "apiMode": "images",
            "model": "gpt-image-2",
        },
    )
    assert created.status_code == 200
    task_id = created.json()["id"]

    execution = generations.prepare_generation_execution(task_id)
    assert execution is not None
    assert execution.user_id == user["id"]
    assert execution.started_at >= old_created_at
    assert execution.started_at != old_created_at

    task = client.get(f"/api/generations/{task_id}")
    assert task.status_code == 200
    assert task.json()["status"] == "running"


def test_queued_generation_can_be_canceled(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.main as main

    register(client)
    channel = create_channel(client)
    monkeypatch.setattr("backend.app.routes.generations.ensure_generation_workers", lambda: None)

    payload = {
        "channelId": channel["id"],
        "model": "gpt-image-2",
        "prompt": "A bottle on a clean white background",
        "params": template_payload(channel["id"])["params"],
        "inputImageDataUrls": [],
        "maskDataUrl": None,
    }
    started = client.post("/api/generations/run", json=payload)
    assert started.status_code == 200
    task = started.json()["task"]
    assert task["status"] == "queued"

    canceled = client.post(f"/api/generations/{task['id']}/cancel")
    assert canceled.status_code == 200
    assert canceled.json()["status"] == "canceled"

    logs = client.get("/api/admin/audit-logs").json()
    assert any(item["action"] == "generation.cancel" for item in logs)


def test_running_generation_canceled_without_task_cancel_stays_canceled(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.main as main

    register(client)
    channel = create_channel(client)

    release_upstream = threading.Event()

    async def fake_call_upstream(_payload):
        while not release_upstream.is_set():
            await asyncio.sleep(0.01)
        return ([PIXEL_DATA_URL], {"size": "1024x1024"}, [{"size": "1024x1024"}], ["revised"])

    monkeypatch.setattr("backend.app.routes.generations.call_upstream", fake_call_upstream)
    monkeypatch.setattr(main._state.GENERATION_RUNTIME, "cancel_active", lambda _task_id: None)

    payload = {
        "channelId": channel["id"],
        "model": "gpt-image-2",
        "prompt": "A bottle on a clean white background",
        "params": template_payload(channel["id"])["params"],
        "inputImageDataUrls": [],
        "maskDataUrl": None,
    }
    started = client.post("/api/generations/run", json=payload)
    assert started.status_code == 200
    task_id = started.json()["task"]["id"]

    deadline = time.time() + 3
    task = client.get(f"/api/generations/{task_id}").json()
    while task["status"] == "queued" and time.time() < deadline:
        time.sleep(0.05)
        task = client.get(f"/api/generations/{task_id}").json()
    assert task["status"] == "running"

    canceled = client.post(f"/api/generations/{task_id}/cancel")
    assert canceled.status_code == 200
    assert canceled.json()["status"] == "canceled"

    release_upstream.set()
    final_task = wait_for_task(client, task_id)
    assert final_task["status"] == "canceled"
    assert final_task["error"] == "已取消"


def test_user_template_submission_can_be_approved_to_public(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    admin = register(client)
    channel = create_channel(client)

    client.post("/api/auth/logout")
    user = client.post("/api/auth/register", json={"username": "bob", "password": "password123"})
    assert user.status_code == 200
    bob = user.json()
    assert bob["role"] == "user"

    created = client.post("/api/templates", json=template_payload(channel["id"]))
    assert created.status_code == 200
    template = created.json()
    assert template["visibility"] == "private"
    assert template["submissionStatus"] == "draft"

    submitted = client.post(f"/api/templates/{template['id']}/submit")
    assert submitted.status_code == 200
    assert submitted.json()["submissionStatus"] == "submitted"
    assert submitted.json()["visibility"] == "private"

    client.post("/api/auth/logout")
    logged_in_admin = login(client, admin["username"])
    assert logged_in_admin["role"] == "admin"

    queue = client.get("/api/admin/template-submissions")
    assert queue.status_code == 200
    assert any(item["id"] == template["id"] for item in queue.json())

    approved = client.post(f"/api/admin/template-submissions/{template['id']}/approve")
    assert approved.status_code == 200
    approved_body = approved.json()
    assert approved_body["visibility"] == "public"
    assert approved_body["submissionStatus"] == "approved"
    assert approved_body["reviewedBy"] == admin["id"]


def test_forged_generated_asset_is_not_public_template_sample(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    admin = register(client)
    channel = create_channel(client)

    client.post("/api/auth/logout")
    bob = client.post("/api/auth/register", json={"username": "bob", "password": "password123"}).json()
    created = client.post("/api/templates", json=template_payload(channel["id"]))
    assert created.status_code == 200
    template = created.json()
    assert client.post(f"/api/templates/{template['id']}/submit").status_code == 200

    upload = client.post("/api/assets", files={"file": ("pixel.png", PIXEL_PNG, "image/png")})
    assert upload.status_code == 200
    forged_asset_id = upload.json()["id"]

    from backend.app.db import get_conn

    with get_conn() as conn:
        task_id = "forged-task"
        conn.execute(
            """
            INSERT INTO generation_tasks (
              id, user_id, prompt, params_json, input_image_ids_json, mask_target_image_id, mask_image_id,
              output_image_ids_json, actual_params_json, actual_params_by_image_json, revised_prompt_by_image_json,
              status, error, created_at, finished_at, elapsed, is_favorite, diagnostics_json, channel_id, api_mode, model
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                bob["id"],
                "forged task",
                json.dumps(template_payload(channel["id"])["params"]),
                "[]",
                None,
                None,
                "[]",
                None,
                None,
                None,
                "done",
                None,
                1,
                2,
                1,
                0,
                "[]",
                channel["id"],
                "images",
                "gpt-image-2",
            ),
        )
        conn.execute(
            "UPDATE assets SET type = 'generated', task_id = ?, template_id = ? WHERE id = ?",
            (task_id, template["id"], forged_asset_id),
        )

    client.post("/api/auth/logout")
    login(client, admin["username"])
    approved = client.post(f"/api/admin/template-submissions/{template['id']}/approve")
    assert approved.status_code == 200

    exposed_asset = client.get(f"/api/assets/{forged_asset_id}")
    assert exposed_asset.status_code == 404

    samples = client.get(f"/api/templates/{template['id']}/samples")
    assert samples.status_code == 200
    assert all(item["imageId"] != forged_asset_id for item in samples.json())


def test_template_gallery_versions_rating_pack_similarity_and_leaderboard(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.main as main

    register(client)
    channel = create_channel(client)

    created = client.post("/api/templates", json=template_payload(channel["id"]))
    assert created.status_code == 200
    template = created.json()

    initial_versions = client.get(f"/api/templates/{template['id']}/versions")
    assert initial_versions.status_code == 200
    assert any(item["version"] == 1 for item in initial_versions.json())

    patched = client.patch(f"/api/templates/{template['id']}", json={"title": "Hero product v2"})
    assert patched.status_code == 200
    assert patched.json()["version"] == 2

    version_one = next(item for item in client.get(f"/api/templates/{template['id']}/versions").json() if item["version"] == 1)
    restored = client.post(f"/api/templates/{template['id']}/versions/{version_one['id']}/restore")
    assert restored.status_code == 200
    assert restored.json()["title"] == "Hero product"
    assert restored.json()["version"] == 3

    rated = client.post(f"/api/templates/{template['id']}/rate", json={"score": 5})
    assert rated.status_code == 200
    assert rated.json()["ratingCount"] == 1
    assert rated.json()["averageRating"] == 5

    imported = client.post(
        "/api/templates/import-pack",
        json={
            "templates": [
                {
                    "title": "Packshot sibling",
                    "description": "Similar product template",
                    "prompt": "A premium product bottle on a clean white studio background",
                    "tags": ["product", "studio"],
                    "category": "commerce",
                    "params": template_payload(channel["id"])["params"],
                    "apiMode": "images",
                    "model": "gpt-image-2",
                }
            ]
        },
    )
    assert imported.status_code == 200
    assert imported.json()["created"] == 1

    similar = client.get(f"/api/templates/similar?templateId={template['id']}&limit=5")
    assert similar.status_code == 200
    assert any(item["title"] == "Packshot sibling" for item in similar.json())

    async def fake_call_upstream(_payload):
        return (
            [PIXEL_DATA_URL],
            {"size": "1024x1024", "quality": "high"},
            [{"size": "1024x1024", "quality": "high"}],
            ["A revised studio prompt"],
        )

    monkeypatch.setattr("backend.app.routes.generations.call_upstream", fake_call_upstream)
    generated = client.post(
        "/api/generate",
        json={
            "templateId": template["id"],
            "templateVersionId": str(restored.json()["version"]),
            "channelId": channel["id"],
            "model": "gpt-image-2",
            "prompt": "A bottle on a clean white background",
            "params": template_payload(channel["id"])["params"],
            "inputImageDataUrls": [],
            "maskDataUrl": None,
        },
    )
    assert generated.status_code == 200
    output_id = generated.json()["task"]["outputImages"][0]

    samples = client.get(f"/api/templates/{template['id']}/samples")
    assert samples.status_code == 200
    assert any(item["imageId"] == output_id for item in samples.json())

    updated_template = client.get(f"/api/templates/{template['id']}").json()
    assert updated_template["successCount"] == 1

    similar_from_image = client.get(f"/api/templates/similar?assetId={output_id}&limit=5")
    assert similar_from_image.status_code == 200
    assert any(item["title"] == "Packshot sibling" for item in similar_from_image.json())

    leaderboard = client.get("/api/channels/leaderboard")
    assert leaderboard.status_code == 200
    assert any(item["channelId"] == channel["id"] and item["successCount"] >= 1 for item in leaderboard.json())

    optimized = client.post("/api/prompts/optimize", json={"prompt": "A bottle"})
    assert optimized.status_code == 200
    assert optimized.json()["method"] == "local"
    assert "A bottle" in optimized.json()["prompt"]
