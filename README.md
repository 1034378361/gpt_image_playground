# GPT Image Playground

基于 OpenAI 图像生成接口的图片生成与编辑工具。当前版本已经改为前后端一体化使用：前端负责界面，FastAPI 后端统一负责登录、渠道配置、模板审核、任务与图片数据存储。

> 本项目基于原始 `gpt_image_playground` Fork 演进，但当前版本已经按独立产品线维护，版本号、部署方式和功能路线不再严格跟随上游。

> 当前版本不能再单独作为纯静态站点使用。无论是本地、Docker 还是线上环境，都需要同时提供同源 `/api/*` 后端。

---

## 📸 示例截图

<div align="center">
  <b>桌面端主界面</b><br>
  <img src="docs/images/example_pc_1.png" alt="桌面端主界面" />
</div>

<br>

<div align="center">
  <b>任务详情与实际参数</b><br>
  <img src="docs/images/example_pc_2.png" alt="任务详情与实际参数" />
</div>

<br>

<div align="center">
  <b>桌面端批量选择</b><br>
  <img src="docs/images/example_pc_3.png" alt="桌面端批量选择" />
</div>

<br>

<div align="center">
  <b>移动端主界面</b><br>
  <img src="docs/images/example_mb_1.jpg" alt="移动端主界面" width="420" />
</div>

<br>

<div align="center">
  <b>移动端侧滑多选</b><br>
  <img src="docs/images/example_mb_2.jpg" alt="移动端侧滑多选" width="420" />
</div>

---

## ✨ 功能特性

### 🎨 核心能力
- **文本生图**：输入提示词，可调用 `images/generations` 或 Responses API 的 `image_generation` 工具生成图片。
- **参考图编辑**：支持上传最多 16 张参考图，可调用 `images/edits` 或 Responses API 多模态输入进行图片编辑。支持文件选择、粘贴和拖拽三种方式。
- **遮罩编辑**：支持在参考图上绘制遮罩后进行局部编辑。遮罩主图会按官方接口限制预处理为安全工作图，避免高分辨率图片导致提交失败。需要注意的是，根据官方文档说明，遮罩编辑仍基于提示词引导模型，无法完全控制模型实际编辑区域。
- **接口模式切换**：支持在设置中选择 Images API (`/v1/images`) 或 Responses API (`/v1/responses`)。
- **批量生成**：单次可设置生成多张图片。
- **Codex CLI 兼容模式**：管理员可为渠道选择自动检测、标准 OpenAI 或 Codex CLI。自动检测会先按标准请求，若上游明确不支持 `quality` 参数，则自动切换为兼容模式并重试。

### ⚙️ 精细化参数控制
- **智能尺寸选择器**：支持 `auto`、按 `1K / 2K / 4K` 结合常用比例自动计算分辨率，同时也支持手动输入自定义宽高。
- **自动规整**：为了兼容模型限制，自定义尺寸会自动规整到合法范围：宽高均为 16 的倍数，最大边长 `3840px`，宽高比不超过 `3:1`，总像素限制为 `655360` 到 `8294400`。
- **预设反推**：打开尺寸选择弹窗时，会自动根据当前尺寸匹配对应的预设比例。
- **其他选项**：支持调整质量 (`low`, `medium`, `high`)、输出格式 (`PNG`, `JPEG`, `WebP`)、压缩率 (0-100) 以及审核强度。
- **实际参数追踪**：会记录 API 返回的实际尺寸、质量、格式、数量与改写提示词，并在与请求值不一致时高亮展示。

### 📁 历史记录与工作流
- **瀑布流任务卡片**：直观展示生成缩略图、提示词、参数和耗时。支持按状态筛选与关键词搜索。
- **收藏与筛选**：支持收藏常用记录，并可一键只看收藏内容。
- **多选批量操作**：桌面端支持拖拽框选和 Ctrl/⌘ 点击多选，移动端支持左右侧滑选择；选中后可批量收藏、删除或全选当前可见记录。
- **快速复用**：一键将历史记录的配置与提示词回填到输入框。
- **迭代生成**：支持将生成的输出结果直接添加到参考图列表中，进行下一轮迭代编辑。
- **画廊与详情**：点击任务卡片可查看完整输入输出，支持大图浏览。
- **快捷操作**：支持图片右键或移动端长按唤出自定义菜单，快速复制、下载图片，或将图片加入参考图后继续编辑。

### 📱 体验优化
- **响应式布局**：桌面端提供更高效的批量选择与底部输入栏，移动端输入栏可折叠，并针对侧滑、多选和弹窗交互做了适配。
- **PWA 支持**：支持渐进式 Web 应用（PWA），可将网页作为独立应用安装到桌面或移动设备主屏幕，提供类似原生 App 的沉浸式体验，并适配 iOS PWA 顶部安全区。

### 💾 后端统一管理
- **登录后使用**：访问前端时需要先登录；系统没有账号时，首个注册用户会自动成为管理员。
- **服务端配置**：Base URL、API Key、渠道模型和请求超时只由管理员在后端配置，普通用户只能选择管理员开放的渠道与模型。
- **模板审核**：用户可以创建私有模板，并提交到公共模板库；公共模板需要管理员审批后才会对所有用户可见。
- **角色细分**：除管理员外，还支持审核员角色；审核员可以处理公共模板审核与开源模板导入，但不能查看渠道密钥、用户角色或服务端备份。
- **服务端备份**：管理员设置中的导入/导出会直接备份和恢复后端数据库与图片资源，不再依赖浏览器本地缓存。

---

## 🚀 部署与使用

前端需要配合 FastAPI 后端使用。开发环境下，Vite 会把 `/api/*` 代理到 `http://127.0.0.1:8000`。

<details>
<summary><strong>▲ 方式一：Vercel 部署前端壳 + 自己提供同源后端</strong></summary>

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2F1034378361%2Fgpt_image_playground&project-name=gpt-image-playground&repository-name=gpt-image-playground)

点击上方按钮后，Vercel 只会构建并托管前端静态资源。你仍然必须额外提供 FastAPI 后端，并把站点的 `/api/*` 反向代理到后端服务，否则页面会直接提示“当前部署缺少后端”。

部署完成后，登录管理员账号，在管理员设置中维护上游渠道、模型、API Key、Base URL 和请求超时。

**更新说明：**

- 如果你是通过一键按钮部署，Vercel 通常会为你创建一份自己的 Git 仓库，并从该仓库自动部署。
- 后续想更新到本项目最新版时，请先将你的仓库同步到本仓库最新代码，再让 Vercel 重新部署。
- 如果你的仓库是 Fork，可以在 GitHub 仓库页面点击 **Sync fork** 同步；同步后，Vercel 会按你的项目设置自动部署。
- 如果你关闭了 Vercel 自动部署，也可以在 Vercel 项目的 **Deployments** 页面手动 Redeploy 最新提交。

</details>

<details>
<summary><strong>🐳 方式二：Docker Compose（推荐 NAS 使用）</strong></summary>

当前仓库已经提供可直接用于 NAS 的双容器部署：

- `frontend`：提供前端页面，并把 `/api/*` 同源转发给后端
- `backend`：FastAPI + SQLite + 图片资源存储

### 1. 准备环境文件

把 `deploy/nas.env.example` 复制为 `.env`，按需修改：

```bash
cp deploy/nas.env.example .env
```

至少建议确认这几个值：

- `GIP_HTTP_PORT=8080`
- `GIP_SESSION_SECURE=false`（仅限内网 HTTP；应用默认值是 `true`）
- `GIP_CORS_ORIGINS=http://你的NAS地址:8080`

如果你会通过 NAS 自带反向代理或 Nginx Proxy Manager 用 HTTPS 暴露出去，请改成：

```env
GIP_SESSION_SECURE=true
```

如果你的前端容器需要代理到另一台机器上的后端，也可以额外改：

```env
GIP_BACKEND_UPSTREAM=http://你的后端地址:8000
```

### 2. 启动容器

```bash
docker compose up -d --build
```

启动后浏览器访问：

```text
http://你的NAS地址:8080
```

系统里还没有账号时，**首个注册用户会自动成为管理员**。

### 3. 数据持久化

Compose 已经默认把下面的目录挂载到宿主机：

```text
./backend/data
```

其中包含：

- `app.sqlite3`
- `assets/`
- `restore-points/`

所以你在 NAS 里只需要备份 `backend/data` 这个目录即可。

### 4. 更新

双容器源码部署仍然可以继续使用：

```bash
docker compose up -d --build
```

如果你希望改成“按镜像版本升级容器”，请优先使用单镜像方案，相关文件和升级步骤见：

- `deploy/FN_NAS_SINGLE_IMAGE.md`
- `docker-compose.single.yml`
- `deploy/build-single-image.mjs`

### 5. 说明

- Compose 用的是：
  - `deploy/Dockerfile.frontend`
  - `deploy/Dockerfile.backend`
- `deploy/nginx.docker.conf`
- `deploy/Dockerfile` 也已经切到同样的反向代理模式，适合单独构建前端壳镜像后再自己指定后端上游
- 如果你是飞牛 NAS，可直接参考 `deploy/FN_NAS_DEPLOY.md`
- 如果你想改成支持镜像版本管理的单镜像部署，可参考 `deploy/FN_NAS_SINGLE_IMAGE.md`、`deploy/Dockerfile.all-in-one`、`docker-compose.single.yml`、`docker-compose.single.build.yml` 和 `deploy/build-single-image.mjs`
- 如果你不使用内置 `frontend` 容器，而是自己已有反向代理，也可以参考 `deploy/nginx.reverse-proxy.conf.example`

</details>

<details>
<summary><strong>💻 方式三：本地开发与自行构建</strong></summary>

1. **安装依赖与启动开发服务器**
   ```bash
   npm install
   npm run backend:dev
   npm run dev
   ```
   随后浏览器访问 `http://localhost:5173`，首个注册用户会成为管理员。

2. **构建前端静态产物**
   ```bash
   npm run build
   ```
   构建输出的文件会存放在 `dist/` 目录下。它只是前端静态资源，线上部署时必须额外配置同源 `/api/*` 后端转发。

</details>

---

## 🛠️ API 配置说明

管理员可以在管理员设置中维护多个渠道，每个渠道包含 Base URL、API Key、请求超时和可用模型。普通用户无法看到这些敏感配置，只能在输入区选择已启用的渠道与模型。

- **Images API**：后端调用 `/v1/images/generations` 和 `/v1/images/edits`，模型需要配置为 GPT Image 模型，例如 `gpt-image-2`。
- **Responses API**：后端调用 `/v1/responses` 并使用 `image_generation` 工具，模型需要配置为支持该工具的文本模型。
- **Codex CLI 检测**：渠道可选择自动检测、标准 OpenAI 或 Codex CLI。自动模式会先发送标准请求；如果上游返回 `quality` 参数不支持，后端会保存检测结果并自动重试，之后普通用户的质量选项会固定为 `auto`。

---

## 🔐 上线前检查

- 前端和 FastAPI 后端必须同域部署，并把 `/api/*` 反向代理到后端。
- 线上务必开启 HTTPS，并将 `GIP_SESSION_SECURE=true`。
- 建议把 SQLite 数据目录和 `restore-points/` 纳入服务器备份策略。
- 首个管理员创建完成后，建议再额外保留至少一个管理员账号，避免单点权限丢失。
- 导入系统备份前，界面会先做预检查，后端也会自动创建恢复点。
- NAS 场景建议只跑一个后端实例，避免多个容器同时写同一个 SQLite 文件。

---

## 💻 技术栈

- **框架**：[React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- **构建工具**：[Vite](https://vite.dev/)
- **样式**：[Tailwind CSS 3](https://tailwindcss.com/)
- **状态管理**：[Zustand](https://zustand.docs.pmnd.rs/)
- **数据存储**：FastAPI + SQLite，浏览器 IndexedDB 仅用于本地图片缓存

## 📄 许可证

[MIT License](LICENSE)

## 🧭 版本策略

- 当前版本线从 `1.0.0` 开始，表示项目已经从原始前端直连工具演进为独立的后端统一管理版本。
- 后续版本号按本仓库自己的发布节奏维护，不再要求与上游仓库保持同步。
- `package.json` 是应用版本的唯一来源；`package-lock.json` 必须保持同步。
- Release tag 必须使用 `v<package.json version>` 格式，例如 `v1.6.1`；CI 会校验 tag、`package.json` 和 lockfile 版本一致后才继续发布。
- GitHub Release 由 `v*` tag 发布流程创建，前端的版本更新提示会读取最新 GitHub Release。
- 版本变更先记录在 `CHANGELOG.md` 的 `Unreleased` 中，正式发布时再移动到对应版本号。
- 如果需要追溯来源，建议在 Release 或变更记录中注明“forked from upstream, independently evolved”。

## 🔗 致谢

[LINUX DO](https://linux.do)
