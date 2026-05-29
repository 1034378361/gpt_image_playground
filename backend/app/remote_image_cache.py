from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import ipaddress
import secrets
import socket
import ssl
import uuid
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse

from fastapi import HTTPException
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError

from . import config

REMOTE_IMAGE_ALLOWED_MIMES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
REMOTE_IMAGE_MAX_BYTES = 10 * 1024 * 1024
REMOTE_IMAGE_TIMEOUT_SECONDS = 10
REMOTE_IMAGE_PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable"
REMOTE_IMAGE_PRIVATE_CACHE_CONTROL = "private, no-store"
_REMOTE_IMAGE_REDIRECT_LIMIT = 3
_REMOTE_IMAGE_HEADER_LIMIT = 64 * 1024
_REMOTE_IMAGE_CHUNK_SIZE = 64 * 1024
_REMOTE_IMAGE_CHUNK_METADATA_LIMIT = 4096
_METADATA_IPS = {ipaddress.ip_address("169.254.169.254")}
_MIME_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
_EXTENSION_MIMES = {extension: mime for mime, extension in _MIME_EXTENSIONS.items()}
_EXTENSION_MIMES[".jpeg"] = "image/jpeg"


_open_connection = asyncio.open_connection


async def _resolve_addresses(hostname: str):
    loop = asyncio.get_running_loop()
    return await loop.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)


def remote_template_cache_url(template_id: str, url: str | None) -> str:
    if not url:
        return ""
    return f"/api/assets/remote-cache/templates/{template_id}?url={quote(url, safe='')}"


def remote_open_prompt_cache_url(source: str, key: str, image_url: str | None = None) -> str:
    if not key or not image_url:
        return ""
    signature = sign_open_prompt_cache_url(source, key, image_url)
    return f"/api/assets/remote-cache/open-prompt/{source}/{quote(key, safe='')}?url={quote(image_url, safe='')}&sig={signature}"


def sign_open_prompt_cache_url(source: str, key: str, image_url: str) -> str:
    payload = f"{source}\0{key}\0{image_url}".encode("utf-8")
    return hmac.new(_open_prompt_cache_secret(), payload, hashlib.sha256).hexdigest()


def verify_open_prompt_cache_url(source: str, key: str, image_url: str, signature: str) -> bool:
    return hmac.compare_digest(signature, sign_open_prompt_cache_url(source, key, image_url))


def _open_prompt_cache_secret() -> bytes:
    secret_path = config.settings.data_dir / "remote-cache-signing-key"
    try:
        return secret_path.read_bytes()
    except FileNotFoundError:
        secret_path.parent.mkdir(parents=True, exist_ok=True)
        secret = secrets.token_bytes(32)
        secret_path.write_bytes(secret)
        return secret


async def get_cached_remote_image(url: str, cache_control: str = REMOTE_IMAGE_PUBLIC_CACHE_CONTROL) -> FileResponse:
    original_url = _normalize_remote_url(url)
    cached = _cached_file_for_url(original_url)
    if cached:
        return _remote_image_response(cached, cache_control=cache_control)

    data, mime = await _download_remote_image(original_url)
    path = _cache_path(original_url, _extension_for_mime(mime))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp_path.write_bytes(data)
        tmp_path.replace(path)
        _prune_remote_image_cache(path)
    finally:
        tmp_path.unlink(missing_ok=True)
    return _remote_image_response(path, mime, cache_control)


def _remote_image_response(path: Path, mime: str | None = None, cache_control: str = REMOTE_IMAGE_PUBLIC_CACHE_CONTROL) -> FileResponse:
    media_type = mime or _mime_for_path(path)
    return FileResponse(
        path,
        media_type=media_type,
        headers={"Cache-Control": cache_control},
    )


def _normalize_remote_url(url: str) -> str:
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="Invalid remote image URL")
    return parsed.geturl()


async def _resolve_public_remote_host(hostname: str) -> str:
    try:
        infos = await _resolve_addresses(hostname)
    except socket.gaierror as exc:
        raise HTTPException(status_code=400, detail="Remote image host cannot be resolved") from exc

    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise HTTPException(status_code=400, detail="Remote image host cannot be resolved")

    for address in addresses:
        ip = ipaddress.ip_address(address)
        if _is_unsafe_remote_ip(ip):
            raise HTTPException(status_code=400, detail="Remote image host is not allowed")
    return sorted(addresses)[0]


def _is_unsafe_remote_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return (
        ip in _METADATA_IPS
        or ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _cached_file_for_url(url: str) -> Path | None:
    digest = _url_digest(url)
    cache_dir = _cache_dir()
    for extension in _MIME_EXTENSIONS.values():
        path = cache_dir / f"{digest}{extension}"
        if path.exists():
            try:
                path.touch()
            except OSError:
                pass
            return path
    return None


def _cache_path(url: str, extension: str) -> Path:
    return _cache_dir() / f"{_url_digest(url)}{extension}"


def _cache_dir() -> Path:
    return config.settings.asset_dir / "remote-cache"


def _prune_remote_image_cache(protected_path: Path) -> None:
    max_bytes = config.settings.remote_image_cache_max_bytes
    if max_bytes <= 0:
        return
    cache_dir = _cache_dir()
    if not cache_dir.exists():
        return

    entries: list[tuple[float, Path, int]] = []
    total_size = 0
    for path in cache_dir.iterdir():
        if not path.is_file() or path.suffix.lower() not in _EXTENSION_MIMES:
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        total_size += stat.st_size
        entries.append((stat.st_mtime, path, stat.st_size))

    protected_path = protected_path.resolve()
    for _, path, size in sorted(entries):
        if total_size <= max_bytes:
            break
        try:
            if path.resolve() == protected_path:
                continue
            path.unlink()
        except OSError:
            continue
        total_size -= size


def _url_digest(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


async def _download_remote_image(url: str) -> tuple[bytes, str]:
    try:
        async with asyncio.timeout(REMOTE_IMAGE_TIMEOUT_SECONDS):
            return await _download_remote_image_with_redirects(url)
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Remote image download timed out") from exc
    except (OSError, ssl.SSLError) as exc:
        raise HTTPException(status_code=502, detail="Remote image download failed") from exc


async def _download_remote_image_with_redirects(url: str) -> tuple[bytes, str]:
    current_url = url
    for _ in range(_REMOTE_IMAGE_REDIRECT_LIMIT + 1):
        status_code, headers, reader, writer, initial_body = await _open_remote_response(current_url)
        try:
            if status_code in {301, 302, 303, 307, 308}:
                location = headers.get("location")
                if not location:
                    raise HTTPException(status_code=400, detail="Remote image redirect missing location")
                current_url = urljoin(current_url, location)
                _normalize_remote_url(current_url)
                continue

            if status_code >= 400:
                raise HTTPException(status_code=502, detail="Remote image download failed")

            mime = _clean_content_type(headers.get("content-type", ""))
            if mime not in REMOTE_IMAGE_ALLOWED_MIMES:
                raise HTTPException(status_code=415, detail="Remote image type is not allowed")

            _validate_content_length(headers.get("content-length"))
            data = await _read_response_body(reader, initial_body, headers)
            detected_mime = _validate_image_bytes(data, mime)
            return data, detected_mime
        finally:
            writer.close()
            await writer.wait_closed()

    raise HTTPException(status_code=400, detail="Too many remote image redirects")


async def _open_remote_response(url: str) -> tuple[int, dict[str, str], asyncio.StreamReader, asyncio.StreamWriter, bytes]:
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Invalid remote image URL")

    resolved_ip = await _resolve_public_remote_host(parsed.hostname)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    ssl_context = ssl.create_default_context() if parsed.scheme == "https" else None
    reader, writer = await _open_connection(
        host=resolved_ip,
        port=port,
        ssl=ssl_context,
        server_hostname=parsed.hostname if ssl_context else None,
    )
    target = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
    host = _host_header(parsed.hostname, parsed.port, parsed.scheme)
    request = (
        f"GET {target} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "User-Agent: GPT-Image-Playground-Remote-Image-Cache\r\n"
        "Accept: image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8\r\n"
        "Connection: close\r\n"
        "\r\n"
    )
    writer.write(request.encode("ascii"))
    await writer.drain()
    return await _read_response_headers(reader, writer)


def _host_header(hostname: str, port: int | None, scheme: str) -> str:
    is_default_port = port is None or (scheme == "https" and port == 443) or (scheme == "http" and port == 80)
    host = f"[{hostname}]" if ":" in hostname and not hostname.startswith("[") else hostname
    return host if is_default_port else f"{host}:{port}"


async def _read_response_headers(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> tuple[int, dict[str, str], asyncio.StreamReader, asyncio.StreamWriter, bytes]:
    buffer = bytearray()
    while b"\r\n\r\n" not in buffer:
        chunk = await reader.read(4096)
        if not chunk:
            raise HTTPException(status_code=502, detail="Remote image response is invalid")
        buffer.extend(chunk)
        if len(buffer) > _REMOTE_IMAGE_HEADER_LIMIT:
            raise HTTPException(status_code=502, detail="Remote image response headers are too large")

    header_bytes, initial_body = bytes(buffer).split(b"\r\n\r\n", 1)
    header_lines = header_bytes.decode("iso-8859-1").split("\r\n")
    status_parts = header_lines[0].split(" ", 2)
    if len(status_parts) < 2 or not status_parts[1].isdigit():
        raise HTTPException(status_code=502, detail="Remote image response is invalid")

    headers: dict[str, str] = {}
    for line in header_lines[1:]:
        if not line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()
    return int(status_parts[1]), headers, reader, writer, initial_body


async def _read_response_body(reader: asyncio.StreamReader, initial_body: bytes, headers: dict[str, str]) -> bytes:
    transfer_encoding = headers.get("transfer-encoding", "").lower()
    if "chunked" in transfer_encoding:
        return await _read_chunked_body(reader, initial_body)

    content_length = headers.get("content-length")
    if content_length:
        return await _read_fixed_length_body(reader, initial_body, int(content_length))

    return await _read_until_eof_body(reader, initial_body)


async def _read_fixed_length_body(reader: asyncio.StreamReader, initial_body: bytes, content_length: int) -> bytes:
    body = bytearray(initial_body[:content_length])
    while len(body) < content_length:
        chunk = await reader.read(min(_REMOTE_IMAGE_CHUNK_SIZE, content_length - len(body)))
        if not chunk:
            break
        body.extend(chunk)
        _assert_remote_image_size(len(body))
    return bytes(body)


async def _read_until_eof_body(reader: asyncio.StreamReader, initial_body: bytes) -> bytes:
    body = bytearray(initial_body)
    _assert_remote_image_size(len(body))
    while True:
        chunk = await reader.read(_REMOTE_IMAGE_CHUNK_SIZE)
        if not chunk:
            return bytes(body)
        body.extend(chunk)
        _assert_remote_image_size(len(body))


async def _read_chunked_body(reader: asyncio.StreamReader, initial_body: bytes) -> bytes:
    buffer = bytearray(initial_body)
    body = bytearray()
    while True:
        while b"\r\n" not in buffer:
            if len(buffer) > _REMOTE_IMAGE_CHUNK_METADATA_LIMIT:
                raise HTTPException(status_code=502, detail="Remote image response is invalid")
            buffer.extend(await _read_required_chunk(reader, _REMOTE_IMAGE_CHUNK_METADATA_LIMIT - len(buffer)))
        line_end = buffer.index(b"\r\n")
        size_line = bytes(buffer[:line_end]).split(b";", 1)[0].strip()
        del buffer[: line_end + 2]
        try:
            chunk_size = int(size_line, 16)
        except ValueError as exc:
            raise HTTPException(status_code=502, detail="Remote image response is invalid") from exc
        if chunk_size == 0:
            return bytes(body)
        _assert_remote_image_size(len(body) + chunk_size)
        while len(buffer) < chunk_size + 2:
            buffer.extend(await _read_required_chunk(reader))
            _assert_remote_image_size(len(body) + min(len(buffer), chunk_size))
        body.extend(buffer[:chunk_size])
        if buffer[chunk_size : chunk_size + 2] != b"\r\n":
            raise HTTPException(status_code=502, detail="Remote image response is invalid")
        del buffer[: chunk_size + 2]


async def _read_required_chunk(reader: asyncio.StreamReader, size: int = _REMOTE_IMAGE_CHUNK_SIZE) -> bytes:
    chunk = await reader.read(max(1, min(_REMOTE_IMAGE_CHUNK_SIZE, size)))
    if not chunk:
        raise HTTPException(status_code=502, detail="Remote image response is invalid")
    return chunk


def _validate_content_length(value: str | None) -> None:
    if not value:
        return
    try:
        declared_size = int(value)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="Remote image response is invalid") from exc
    _assert_remote_image_size(declared_size)


def _assert_remote_image_size(size: int) -> None:
    if size > REMOTE_IMAGE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Remote image is too large")


def _clean_content_type(value: str) -> str:
    return value.split(";", 1)[0].strip().lower()


def _validate_image_bytes(data: bytes, expected_mime: str) -> str:
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.verify()
            detected_mime = Image.MIME.get(image.format or "", expected_mime)
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=400, detail="Invalid remote image") from exc

    if detected_mime not in REMOTE_IMAGE_ALLOWED_MIMES:
        raise HTTPException(status_code=415, detail="Remote image type is not allowed")
    return detected_mime


def _extension_for_mime(mime: str) -> str:
    return _MIME_EXTENSIONS.get(mime, ".bin")


def _mime_for_path(path: Path) -> str:
    return _EXTENSION_MIMES.get(path.suffix.lower(), "application/octet-stream")
