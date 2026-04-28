from __future__ import annotations

import base64
import io
import importlib

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


def register(client: TestClient):
    response = client.post("/api/auth/register", json={"username": "alice", "password": "password123"})
    assert response.status_code == 200
    return response.json()


def template_payload():
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
        "apiMode": "images",
        "model": "gpt-image-2",
        "coverImageId": None,
        "linkedTaskIds": [],
        "isFavorite": False,
    }


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


def test_template_crud_duplicate_and_generation_link(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    register(client)

    created = client.post("/api/templates", json=template_payload())
    assert created.status_code == 200
    template = created.json()
    assert template["version"] == 1

    patched = client.patch(f"/api/templates/{template['id']}", json={"isFavorite": True, "tags": ["product", "studio"]})
    assert patched.status_code == 200
    assert patched.json()["isFavorite"] is True
    assert patched.json()["version"] == 2

    duplicated = client.post(f"/api/templates/{template['id']}/duplicate")
    assert duplicated.status_code == 200
    assert duplicated.json()["title"].endswith("副本")
    assert duplicated.json()["linkedTaskIds"] == []

    task_payload = {
        "templateId": template["id"],
        "templateVersionId": str(patched.json()["version"]),
        "prompt": "A premium bottle on white background",
        "params": template_payload()["params"],
        "inputImageIds": [],
        "outputImages": [],
        "status": "done",
        "apiMode": "images",
        "model": "gpt-image-2",
    }
    task = client.post("/api/generations", json=task_payload)
    assert task.status_code == 200
    assert task.json()["templateId"] == template["id"]
    assert len(client.get("/api/generations").json()) == 1

    deleted = client.delete(f"/api/templates/{template['id']}")
    assert deleted.status_code == 200


def test_asset_upload_read_delete(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    register(client)

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

    deleted = client.delete(f"/api/assets/{asset['id']}")
    assert deleted.status_code == 200
    assert client.get(f"/api/assets/{asset['id']}").status_code == 404


def test_async_generation_run_persists_task_assets_and_metadata(monkeypatch, tmp_path):
    client = make_client(monkeypatch, tmp_path)
    import backend.app.main as main

    register(client)

    async def fake_call_upstream(_payload):
        return (
            [PIXEL_DATA_URL],
            {"size": "1024x1024", "quality": "high"},
            [{"size": "1024x1024", "quality": "high"}],
            ["A revised studio prompt"],
        )

    monkeypatch.setattr(main, "call_upstream", fake_call_upstream)

    payload = {
        "settings": {
            "baseUrl": "https://example.test/v1",
            "apiKey": "",
            "model": "gpt-image-2",
            "timeout": 10,
            "apiMode": "images",
            "codexCli": False,
        },
        "prompt": "A bottle on a clean white background",
        "params": template_payload()["params"],
        "inputImageDataUrls": [],
        "maskDataUrl": None,
    }
    started = client.post("/api/generations/run", json=payload)
    assert started.status_code == 200
    task_id = started.json()["task"]["id"]
    assert started.json()["task"]["status"] == "running"

    task = client.get(f"/api/generations/{task_id}").json()
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
