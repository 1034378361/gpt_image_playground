from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urljoin

from ..state import OpenPromptSource

def _github_raw_url(source: OpenPromptSource, src: str) -> str:
    value = src.strip()
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return urljoin(source.raw_base_url, value.removeprefix("./").lstrip("/"))


def _iter_markdown_h3_sections(markdown: str) -> list[tuple[str, str]]:
    headings = list(re.finditer(r"^###\s+(?P<title>.+?)\s*$", markdown, re.MULTILINE))
    sections: list[tuple[str, str]] = []
    for index, match in enumerate(headings):
        start = match.end()
        end = headings[index + 1].start() if index + 1 < len(headings) else len(markdown)
        sections.append((match.group("title").strip(), markdown[start:end]))
    return sections


def _markdown_links(text: str) -> list[tuple[str, str]]:
    return [(label.strip(), url.strip()) for label, url in re.findall(r"\[([^\]]+)\]\(([^)]+)\)", text)]


def _extract_prompt_image(source: OpenPromptSource, body: str) -> str:
    images: list[tuple[str, str]] = []
    for match in re.finditer(r"<img\b(?P<attrs>[^>]*)>", body, re.IGNORECASE):
        attrs = match.group("attrs")
        src_match = re.search(r'\bsrc="(?P<src>[^"]+)"', attrs, re.IGNORECASE)
        if not src_match:
            continue
        alt_match = re.search(r'\balt="(?P<alt>[^"]*)"', attrs, re.IGNORECASE)
        images.append((alt_match.group("alt") if alt_match else attrs, src_match.group("src")))
    images.extend((alt, src) for alt, src in re.findall(r"!\[([^\]]*)\]\(([^)]+)\)", body))
    if not images:
        return ""
    preferred = next((src for label, src in images if "gpt" in label.lower()), None)
    if not preferred and "nano banana" in body.lower() and "gpt-image" in body.lower() and len(images) > 1:
        preferred = images[-1][1]
    return _github_raw_url(source, preferred or images[0][1])


def _source_author_from_links(links: list[tuple[str, str]]) -> str:
    if not links:
        return ""
    label = next((label for label, _ in links if label.strip().startswith("@")), links[-1][0])
    return re.sub(r"\s+", " ", label).strip()

IMAGE_PROMPT_POSITIVE_TERMS = (
    "image", "photo", "photography", "photorealistic", "render", "poster", "portrait",
    "product", "scene", "lighting", "composition", "background", "illustration", "cinematic",
    "camera", "lens", "close-up", "close up", "editorial", "studio", "macro", "texture",
    "color grading", "3d", "cgi", "character", "mascot", "anime", "logo", "brand",
    "packaging", "ad campaign", "fashion", "food", "landscape", "flat lay", "depth of field",
    "bokeh", "海报", "产品图", "摄影", "写实", "插画", "构图", "灯光", "场景",
)

IMAGE_PROMPT_NEGATIVE_TERMS = (
    "install", "installation", "setup", "configure", "configuration", "usage",
    "getting started", "quickstart", "api", "sdk", "cli", "workflow", "agent",
    "repository", "codebase", "docker", "docker compose", "pip install", "npm install",
    "pnpm install", "yarn install", "git clone", "localhost", "environment variable",
    "token", "compiler", "benchmark", "inference", "transcript", "ocr", "audio",
    "speech", "video frame", "markdown", "fastapi", "langgraph", "typescript",
    "python package", "api key", "安装", "配置", "接入", "启动服务", "部署", "命令行", "仓库", "编译", "推理",
)

IMAGE_PROMPT_TITLE_BLOCKLIST = re.compile(
    r"\b("
    r"install|installation|setup|usage|guide|quickstart|getting started|configuration|config|"
    r"api|sdk|cli|integration|deployment|docker|requirements|benchmark|compiler|inference|"
    r"architecture|changelog|release notes|faq|contributing|for humans|structured content|"
    r"offline inference|one-line agent|agent setup|flagos|usage examples|python installation"
    r")\b",
    re.IGNORECASE,
)

IMAGE_PROMPT_HARD_REJECT_PATTERN = re.compile(
    r"\b("
    r"pip install|npm install|pnpm install|yarn install|git clone|docker compose|uv pip|"
    r"python -m|export [A-Z_]+|set [A-Z_]+=|localhost:\d+|http://localhost|https://localhost|"
    r"import [a-zA-Z_]|from [a-zA-Z0-9_.]+ import|def [a-zA-Z_]+\(|class [A-Z][A-Za-z0-9_]*|"
    r"async def |cargo install|go install|cmake --build|make install"
    r")\b",
    re.IGNORECASE,
)


def _count_term_hits(text: str, terms: tuple[str, ...]) -> int:
    haystack = text.lower()
    hits = 0
    for term in terms:
        if term in haystack:
            hits += 1
    return hits


def _looks_like_image_generation_prompt(
    title: str,
    prompt: str,
    *,
    image: str = "",
    tags: list[str] | None = None,
    category: str = "",
    body: str = "",
) -> bool:
    normalized_title = title.strip().lower()
    normalized_prompt = prompt.strip().lower()
    if len(normalized_prompt) < 40:
        return False
    if len(normalized_prompt) > 4500:
        return False

    combined = " ".join(
        [
            normalized_title,
            normalized_prompt,
            category.strip().lower(),
            " ".join((tags or [])).lower(),
            body.strip().lower(),
        ],
    )
    positive_hits = _count_term_hits(combined, IMAGE_PROMPT_POSITIVE_TERMS)
    negative_hits = _count_term_hits(combined, IMAGE_PROMPT_NEGATIVE_TERMS)
    has_visual_anchor = bool(image.strip()) or bool(category.strip()) or bool(tags)

    if IMAGE_PROMPT_TITLE_BLOCKLIST.search(normalized_title):
        return False
    if IMAGE_PROMPT_HARD_REJECT_PATTERN.search(normalized_prompt[:1400]):
        return False
    if body and IMAGE_PROMPT_HARD_REJECT_PATTERN.search(body[:2200].lower()):
        return False
    if "<summary>" in normalized_prompt or "</details>" in normalized_prompt:
        return False
    bullet_like_lines = sum(
        1
        for line in prompt.splitlines()
        if line.strip().startswith(("-", "*", "<details>", "<summary>", "`"))
    )
    if bullet_like_lines >= 3 and positive_hits < 4:
        return False
    if negative_hits >= 2 and positive_hits < 3:
        return False
    if has_visual_anchor and positive_hits >= 1 and negative_hits == 0:
        return True
    return positive_hits >= 3 and negative_hits == 0


def _text_matches_any(text: str, patterns: tuple[str, ...]) -> bool:
    lowered = text.lower()
    for pattern in patterns:
        if " " in pattern or "-" in pattern:
            if pattern in lowered:
                return True
            continue
        if re.search(rf"\b{re.escape(pattern)}\b", lowered):
            return True
    return False


def _infer_template_category(section: str, title: str) -> str:
    text = f"{section} {title}".lower()
    if _text_matches_any(text, ("e-commerce", "product")):
        return "product"
    if _text_matches_any(text, ("portrait",)):
        return "portrait"
    if _text_matches_any(text, ("character",)):
        return "character"
    if _text_matches_any(text, ("logo", "brand")):
        return "brand"
    if _text_matches_any(text, ("ui",)):
        return "ui"
    if _text_matches_any(text, ("advertising", "poster", "campaign", "flyer", "banner")):
        return "poster"
    if _text_matches_any(text, ("anime",)):
        return "anime"
    if _text_matches_any(text, ("food",)):
        return "food"
    if _text_matches_any(text, ("landscape",)):
        return "landscape"
    return "inspiration"


def _infer_template_tags(section: str, title: str, prompt: str) -> list[str]:
    text = f"{section} {title} {prompt}".lower()
    rules = {
        "product": ["product", "e-commerce", "skincare", "perfume", "bottle", "shoes", "watch"],
        "poster": ["poster", "ad ", "advertising", "flyer", "banner", "campaign"],
        "ui": ["ui", "interface", "dashboard", "mockup", "app"],
        "photo": ["photo", "photography", "photorealistic", "studio", "cinematic"],
        "3d": ["3d", "cgi", "render", "diorama", "unreal"],
        "portrait": ["portrait", "headshot", "face"],
        "character": ["character", "mascot", "sheet"],
        "anime": ["anime", "manga"],
        "logo": ["logo", "brand identity", "branding"],
        "illustration": ["illustration", "illustrated", "drawing"],
        "food": ["food", "burger", "drink", "soda"],
        "infographic": ["infographic", "feature list", "icons"],
        "fashion": ["fashion", "streetwear", "sneaker", "loafers"],
    }
    tags = [tag for tag, needles in rules.items() if any(needle in text for needle in needles)]
    return tags[:6] or ["inspiration"]


def _parse_evolink_prompt_readme(source: OpenPromptSource, markdown: str) -> list[dict[str, str | list[str]]]:
    items: list[dict[str, str | list[str]]] = []
    section_pattern = re.compile(r"^##\s+(?P<section>.+?)\s*$", re.MULTILINE)
    sections = list(section_pattern.finditer(markdown))

    for index, section_match in enumerate(sections):
        section = section_match.group("section").strip()
        if section.lower() in {"introduction", "news", "\U0001f4d1 menu"}:
            continue
        start = section_match.end()
        end = sections[index + 1].start() if index + 1 < len(sections) else len(markdown)
        body = markdown[start:end]
        case_pattern = re.compile(
            r"^###\s+Case\s+(?P<case>\d+):\s+\[(?P<title>[^\]]+)\]\((?P<source_url>[^)]+)\)\s+\(by\s+\[@(?P<author>[^\]]+)\]\([^)]+\)\)",
            re.MULTILINE,
        )
        case_matches = list(case_pattern.finditer(body))
        for case_index, case_match in enumerate(case_matches):
            case_start = case_match.end()
            case_end = case_matches[case_index + 1].start() if case_index + 1 < len(case_matches) else len(body)
            case_body = body[case_start:case_end]
            prompt_match = re.search(r"\*\*Prompt:\*\*\s*```[^\n]*\n(?P<prompt>[\s\S]*?)```", case_body)
            image_match = re.search(r'<img\s+src="(?P<src>[^"]+)"', case_body)
            if not prompt_match:
                continue
            prompt = prompt_match.group("prompt").strip()
            title = case_match.group("title").strip()
            items.append(
                {
                    "title": title,
                    "prompt": prompt[:4000],
                    "image": _github_raw_url(source, image_match.group("src")) if image_match else "",
                    "sourceUrl": case_match.group("source_url").strip(),
                    "sourceAuthor": f"@{case_match.group('author').strip()}",
                    "category": _infer_template_category(section, title),
                    "tags": _infer_template_tags(section, title, prompt),
                }
            )
    return items


def _parse_zerolu_prompt_readme(source: OpenPromptSource, markdown: str) -> list[dict[str, str | list[str]]]:
    items: list[dict[str, str | list[str]]] = []
    for title, body in _iter_markdown_h3_sections(markdown):
        prompt_match = re.search(r"\*\*Prompt:\*\*\s*```[^\n]*\n(?P<prompt>[\s\S]*?)```", body)
        if not prompt_match:
            continue
        source_line = re.search(r"(?:\*\*Source:\*\*|\*Source:)\s*(?P<source>.+?)(?:\n|$)", body)
        links = _markdown_links(source_line.group("source").strip().strip("*")) if source_line else []
        source_url = links[0][1] if links else source.repo_url
        source_author = _source_author_from_links(links)
        prompt = prompt_match.group("prompt").strip()
        image = _extract_prompt_image(source, body)
        category = _infer_template_category("gpt image", title)
        tags = _infer_template_tags("gpt image", title, prompt)
        if not _looks_like_image_generation_prompt(
            title, prompt, image=image, tags=tags, category=category, body=body,
        ):
            continue
        items.append(
            {
                "title": title,
                "prompt": prompt[:4000],
                "image": image,
                "sourceUrl": source_url,
                "sourceAuthor": source_author,
                "category": category,
                "tags": tags,
            }
        )
    return items


def _parse_imgedify_prompt_readme(source: OpenPromptSource, markdown: str) -> list[dict[str, str | list[str]]]:
    items: list[dict[str, str | list[str]]] = []
    for title, body in _iter_markdown_h3_sections(markdown):
        if title.lower() == "table of contents":
            continue
        prompt_match = re.search(
            r"-\s+\*\*Prompt Text:\*\*\s*`(?P<inline>[\s\S]*?)`\s*\n-\s+\*\*Example Image:\*\*",
            body,
        )
        if not prompt_match:
            prompt_match = re.search(r"-\s+\*\*Prompt Text:\*\*\s*```[^\n]*\n(?P<fenced>[\s\S]*?)```", body)
        if not prompt_match:
            continue
        prompt = (prompt_match.groupdict().get("inline") or prompt_match.groupdict().get("fenced") or "").strip()
        author_line = re.search(r"-\s+\*\*Author:\*\*\s*(?P<author>.+?)(?:\n|$)", body)
        links = _markdown_links(author_line.group("author")) if author_line else []
        source_url = links[0][1] if links else source.repo_url
        source_author = _source_author_from_links(links)
        tags = _infer_template_tags("gpt4o image", title, prompt)
        if "gpt4o" not in tags:
            tags = [*tags, "gpt4o"][:6]
        items.append(
            {
                "title": title,
                "prompt": prompt[:4000],
                "image": _extract_prompt_image(source, body),
                "sourceUrl": source_url,
                "sourceAuthor": source_author,
                "category": _infer_template_category("gpt4o image", title),
                "tags": tags,
            }
        )
    return items


def _parse_youmind_prompt_readme(source: OpenPromptSource, markdown: str) -> list[dict[str, str | list[str]]]:
    items: list[dict[str, str | list[str]]] = []
    entry_pattern = re.compile(
        r"^###\s+No\.\s*\d+:\s*(?P<title>.+?)\s*$",
        re.MULTILINE,
    )
    entries = list(entry_pattern.finditer(markdown))
    for index, match in enumerate(entries):
        title = match.group("title").strip()
        start = match.end()
        end = entries[index + 1].start() if index + 1 < len(entries) else len(markdown)
        body = markdown[start:end]
        prompt_match = re.search(r"```[^\n]*\n([\s\S]*?)```", body)
        if not prompt_match:
            continue
        prompt = prompt_match.group(1).strip()
        if len(prompt) < 20:
            continue
        image_match = re.search(r'<img\s+src="(?P<url>[^"]+)"', body)
        image = image_match.group("url") if image_match else ""
        author_match = re.search(r"\*\*Author:\*\*\s*\[(?P<name>[^\]]+)\]\((?P<url>[^)]+)\)", body)
        source_match = re.search(r"\*\*Source:\*\*\s*\[(?P<label>[^\]]+)\]\((?P<url>[^)]+)\)", body)
        source_url = source_match.group("url") if source_match else source.repo_url
        source_author = f"@{author_match.group('name')}" if author_match else ""
        items.append(
            {
                "title": title,
                "prompt": prompt[:4000],
                "image": image,
                "sourceUrl": source_url,
                "sourceAuthor": source_author,
                "category": _infer_template_category("gpt-image-2", title),
                "tags": _infer_template_tags("gpt-image-2", title, prompt),
            }
        )
    return items


def _parse_nanobanana_prompts_json(source: OpenPromptSource, text: str) -> list[dict[str, str | list[str]]]:
    items: list[dict[str, str | list[str]]] = []
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return items
    if not isinstance(data, list):
        return items
    for entry in data:
        if not isinstance(entry, dict):
            continue
        prompt = str(entry.get("prompt") or "").strip()
        if len(prompt) < 20:
            continue
        title = prompt[:60].split("\n")[0].strip()
        if len(title) > 50:
            title = title[:50] + "..."
        image = str(entry.get("image") or "")
        author_name = str(entry.get("author_name") or "")
        source_url = str(entry.get("source_url") or source.repo_url)
        categories = entry.get("categories") or []
        tags = [str(c) for c in categories[:6]] if isinstance(categories, list) else []
        if not tags:
            tags = _infer_template_tags("trending", title, prompt)
        items.append(
            {
                "title": title,
                "prompt": prompt[:4000],
                "image": image,
                "sourceUrl": source_url,
                "sourceAuthor": f"@{author_name}" if author_name else "",
                "category": _infer_template_category("trending", title),
                "tags": tags,
            }
        )
    return items


def _clean_markdown_title(value: str) -> str:
    title = re.sub(r"<[^>]+>", "", value)
    title = re.sub(r"[*_`#\[\]]+", "", title)
    title = re.sub(r"\s+", " ", title).strip(" -:|")
    return title[:120]


def _iter_markdown_heading_sections(markdown: str) -> list[tuple[str, str]]:
    headings = list(re.finditer(r"^(?P<level>#{2,4})\s+(?P<title>.+?)\s*$", markdown, re.MULTILINE))
    sections: list[tuple[str, str]] = []
    for index, match in enumerate(headings):
        start = match.end()
        end = headings[index + 1].start() if index + 1 < len(headings) else len(markdown)
        sections.append((_clean_markdown_title(match.group("title")), markdown[start:end]))
    return sections


def _extract_generic_prompt_text(body: str) -> str:
    patterns = [
        r"(?:\*\*)?\s*Prompt(?:\s+Text)?\s*(?:\*\*)?\s*[:：]\s*```[^\n]*\n(?P<prompt>[\s\S]*?)```",
        r"(?:\*\*)?\s*提示词\s*(?:\*\*)?\s*[:：]\s*```[^\n]*\n(?P<prompt>[\s\S]*?)```",
        r"(?:\*\*)?\s*Prompt(?:\s+Text)?\s*(?:\*\*)?\s*[:：]\s*`(?P<inline>[^`]{40,})`",
        r"(?:\*\*)?\s*提示词\s*(?:\*\*)?\s*[:：]\s*`(?P<inline_zh>[^`]{20,})`",
    ]
    for pattern in patterns:
        match = re.search(pattern, body, re.IGNORECASE)
        if match:
            prompt = next((value for value in match.groupdict().values() if value), "")
            if prompt.strip():
                return prompt.strip()

    code_blocks = re.findall(r"```(?:text|prompt|markdown|md)?\s*\n([\s\S]*?)```", body, re.IGNORECASE)
    for block in code_blocks:
        prompt = block.strip()
        if len(prompt) >= 50 and not re.search(r"\b(npm|pip|git clone|import |function |const )\b", prompt[:300], re.IGNORECASE):
            return prompt

    quote_lines = [line[1:].strip() for line in body.splitlines() if line.strip().startswith(">")]
    quote = "\n".join(line for line in quote_lines if line)
    if len(quote) >= 80 and re.search(r"\b(image|photo|render|style|scene|composition|lighting)\b", quote, re.IGNORECASE):
        return quote

    return ""


def _parse_generic_prompt_readme(source: OpenPromptSource, markdown: str) -> list[dict[str, str | list[str]]]:
    items: list[dict[str, str | list[str]]] = []
    skip_titles = {
        "table of contents", "license", "installation", "usage", "intro",
        "introduction", "contributing", "getting started", "quickstart",
        "setup", "configuration", "faq",
    }
    for title, body in _iter_markdown_heading_sections(markdown):
        if not title or title.lower() in skip_titles:
            continue
        prompt = _extract_generic_prompt_text(body)
        if not prompt:
            continue
        image = _extract_prompt_image(source, body)
        category = _infer_template_category("gpt image", title)
        tags = _infer_template_tags("gpt image", title, prompt)
        if not _looks_like_image_generation_prompt(
            title, prompt, image=image, tags=tags, category=category, body=body,
        ):
            continue
        links = _markdown_links(body)
        source_url = next((url for _, url in links if url.startswith("http")), source.repo_url)
        source_author = _source_author_from_links(links)
        items.append(
            {
                "title": title,
                "prompt": prompt[:4000],
                "image": image,
                "sourceUrl": source_url,
                "sourceAuthor": source_author,
                "category": category,
                "tags": tags,
            }
        )
        if len(items) >= 300:
            break
    return items


OPEN_PROMPT_SOURCES: dict[str, OpenPromptSource] = {
    "evolink": OpenPromptSource(
        id="evolink",
        label="EvoLinkAI",
        readme_url="https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/README.md",
        repo_url="https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts",
        raw_base_url="https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/",
        source_name="EvoLinkAI awesome-gpt-image-2-prompts",
        license_name="README: CC BY 4.0; repository LICENSE: Apache-2.0",
        parser=_parse_evolink_prompt_readme,
    ),
    "zerolu": OpenPromptSource(
        id="zerolu",
        label="ZeroLu GPT Image",
        readme_url="https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main/README.md",
        repo_url="https://github.com/ZeroLu/awesome-gpt-image",
        raw_base_url="https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main/",
        source_name="ZeroLu awesome-gpt-image",
        license_name="MIT",
        parser=_parse_zerolu_prompt_readme,
    ),
    "imgedify": OpenPromptSource(
        id="imgedify",
        label="ImgEdify GPT4o Prompts",
        readme_url="https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main/README.md",
        repo_url="https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts",
        raw_base_url="https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main/",
        source_name="ImgEdify Awesome-GPT4o-Image-Prompts",
        license_name="MIT",
        parser=_parse_imgedify_prompt_readme,
    ),
    "youmind": OpenPromptSource(
        id="youmind",
        label="YouMind GPT Image 2 (5000+)",
        readme_url="https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main/README.md",
        repo_url="https://github.com/YouMind-OpenLab/awesome-gpt-image-2",
        raw_base_url="https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main/",
        source_name="YouMind awesome-gpt-image-2",
        license_name="CC BY 4.0",
        parser=_parse_youmind_prompt_readme,
    ),
    "nanobanana": OpenPromptSource(
        id="nanobanana",
        label="Trending Prompts from X (1400+)",
        readme_url="https://raw.githubusercontent.com/jau123/nanobanana-trending-prompts/main/prompts/prompts.json",
        repo_url="https://github.com/jau123/nanobanana-trending-prompts",
        raw_base_url="https://raw.githubusercontent.com/jau123/nanobanana-trending-prompts/main/",
        source_name="nanobanana-trending-prompts",
        license_name="CC BY 4.0",
        parser=_parse_nanobanana_prompts_json,
    ),
}
