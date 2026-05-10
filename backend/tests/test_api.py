from __future__ import annotations

import base64
import io
import importlib
import json
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
    assert len(client.get("/api/generations").json()) == 1

    deleted = client.delete(f"/api/templates/{template['id']}")
    assert deleted.status_code == 200


def test_open_prompt_library_import_sources_and_dedupes(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.main as main

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
    selected_key = preview_body["items"][0]["key"]

    imported = client.post(
        "/api/admin/templates/import-open-library",
        json={"source": "zerolu", "limit": 1, "selectedKeys": [selected_key]},
    )
    assert imported.status_code == 200
    assert imported.json()["source"] == "zerolu"
    assert imported.json()["created"] == 1

    templates = client.get("/api/templates?scope=public").json()
    assert len(templates) == 1
    assert templates[0]["sourceName"] == "ZeroLu awesome-gpt-image"
    assert templates[0]["sourceAuthor"] == "@tester"
    assert templates[0]["licenseName"] == "MIT"
    assert templates[0]["externalCoverUrl"].endswith("/assets/test-product.jpg")
    assert templates[0]["exampleImages"][0].endswith("/assets/test-product.jpg")
    assert templates[0]["recommendedModel"] == "gpt-image-2"
    assert templates[0]["qualityScore"] > 0

    sources = client.get("/api/admin/open-prompt-sources")
    assert sources.status_code == 200
    zerolu = next(item for item in sources.json() if item["id"] == "zerolu")
    assert zerolu["importedCount"] == 1
    assert zerolu["licenseName"] == "MIT"

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


def test_auto_import_discovers_hot_github_repos_and_uses_review_queue(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.main as main

    register(client)
    create_channel(client)

    readmes = {
        "acme/image-prompts": """
## Product Campaign

**Prompt:**
```text
A cinematic product poster with dramatic studio lighting, glass reflections, precise composition, and a premium launch mood.
```

![sample](assets/product.png)
""",
        "trusted/prompt-vault": """
## Character Sheet

**Prompt:**
```text
A polished character design sheet with turnaround poses, clean lighting, expressive details, and a consistent animation style.
```

![sample](images/character.png)
""",
        "docs/setup-guide": """
## Installation Guide

**Prompt:**
```text
Run `pip install deer-flow`, then launch the local service with `docker compose up --build` and connect to http://localhost:2026.
```
""",
    }

    class FakeAsyncClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url, **kwargs):
            request = httpx.Request("GET", url)
            if "api.github.com/search/repositories" in url:
                return httpx.Response(
                    200,
                    json={
                        "items": [
                            {
                                "full_name": "acme/image-prompts",
                                "html_url": "https://github.com/acme/image-prompts",
                                "description": "Image generation prompts",
                                "stargazers_count": 42,
                                "forks_count": 6,
                                "default_branch": "main",
                                "pushed_at": "2026-04-01T00:00:00Z",
                                "license": {"spdx_id": "MIT", "name": "MIT License"},
                            },
                            {
                                "full_name": "trusted/prompt-vault",
                                "html_url": "https://github.com/trusted/prompt-vault",
                                "description": "Curated prompt vault",
                                "stargazers_count": 100,
                                "forks_count": 10,
                                "default_branch": "main",
                                "pushed_at": "2026-04-01T00:00:00Z",
                                "license": {"spdx_id": "Apache-2.0", "name": "Apache License 2.0"},
                            },
                            {
                                "full_name": "docs/setup-guide",
                                "html_url": "https://github.com/docs/setup-guide",
                                "description": "Developer setup notes",
                                "stargazers_count": 88,
                                "forks_count": 9,
                                "default_branch": "main",
                                "pushed_at": "2026-04-01T00:00:00Z",
                                "license": {"spdx_id": "MIT", "name": "MIT License"},
                            },
                        ]
                    },
                    request=request,
                )
            for repo_name, readme in readmes.items():
                if f"raw.githubusercontent.com/{repo_name}/main/README.md" in url:
                    return httpx.Response(200, text=readme, request=request)
            return httpx.Response(404, request=request)

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeAsyncClient)

    settings = client.patch(
        "/api/admin/auto-import/settings",
        json={
            "enabled": False,
            "githubToken": "ghp_secret_token",
            "searchQueries": ["gpt image prompts"],
            "trustedRepos": ["trusted/prompt-vault"],
            "includeKnownSources": False,
            "autoApproveTrusted": True,
            "maxRepositories": 5,
            "maxTemplatesPerRun": 5,
            "minHotScore": 0,
        },
    )
    assert settings.status_code == 200
    assert settings.json()["githubTokenPreview"].startswith("ghp")
    assert "secret" not in settings.text

    run = client.post("/api/admin/auto-import/run")
    assert run.status_code == 200
    body = run.json()
    assert body["status"] == "done"
    assert body["discoveredRepositories"] == 2
    assert body["created"] == 2
    assert body["submitted"] == 1
    assert body["approved"] == 1

    submissions = client.get("/api/admin/template-submissions").json()
    assert any(item["sourceName"] == "GitHub acme/image-prompts" and item["submissionStatus"] == "submitted" for item in submissions)
    assert all(item["sourceName"] != "GitHub docs/setup-guide" for item in submissions)

    public_templates = client.get("/api/templates?scope=public").json()
    assert any(item["sourceName"] == "GitHub trusted/prompt-vault" and item["submissionStatus"] == "approved" for item in public_templates)

    discoveries = client.get("/api/admin/open-prompt-discoveries")
    assert discoveries.status_code == 200
    assert discoveries.json()[0]["hotScore"] >= discoveries.json()[1]["hotScore"]
    assert any(item["repoUrl"] == "https://github.com/trusted/prompt-vault" and item["lastStatus"] == "imported" for item in discoveries.json())


def test_asset_upload_read_delete(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.routes.assets as assets_mod

    register(client)
    copied_paths: list[str] = []
    monkeypatch.setattr(assets_mod, "copy_image_file_to_system_clipboard", lambda path: copied_paths.append(str(path)))

    upload = client.post(
        "/api/assets",
        files={"file": ("pixel.png", PIXEL_PNG, "image/png")},
        data={"type": "generated"},
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


def test_admin_can_export_and_import_server_backup(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)

    register(client)
    channel = create_channel(client)

    upload = client.post(
        "/api/assets",
        files={"file": ("pixel.png", PIXEL_PNG, "image/png")},
        data={"type": "generated"},
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

    archive = zipfile.ZipFile(io.BytesIO(exported.content))
    manifest = json.loads(archive.read("server-backup.json").decode("utf-8"))
    assert manifest["tables"]["users"][0]["username"] == "alice"
    assert asset["id"] in manifest["imageFiles"]

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
    assert any(item["id"] == template["id"] for item in templates)
    restored_asset = client.get(f"/api/assets/{asset['id']}")
    assert restored_asset.status_code == 200
    assert restored_asset.content == PIXEL_PNG


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


def test_queued_generation_survives_restart_and_rehydrates_inputs(monkeypatch, tmp_path):
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
