# 飞牛 NAS 部署说明

这份说明是给飞牛 NAS / OpenClaw 直接落地用的，目标是把项目以 Docker 方式部署成：

- `frontend`：Nginx 静态站点，对外提供 Web 页面
- `backend`：FastAPI 后端，负责登录、权限、模板、任务、图片资源和上游转发

当前项目已经不是“纯前端静态站点”，必须同时部署前端和后端，并保证前端访问的 `/api/*` 能转发到后端。

## 1. 推荐部署方式

推荐直接使用仓库根目录的：

- `docker-compose.yml`
- `deploy/Dockerfile.frontend`
- `deploy/Dockerfile.backend`
- `deploy/nginx.docker.conf`

也就是说，**推荐让 OpenClaw 以源码目录直接构建并启动**，不需要你手动先改镜像内容。

## 2. 推荐目录结构

建议在飞牛 NAS 上准备一个固定目录，例如：

```text
/data/docker/gpt_image_playground
```

如果你的飞牛实际存储路径不是这个，就替换成你自己的真实路径。目录内建议结构如下：

```text
/data/docker/gpt_image_playground/
  ├─ docker-compose.yml
  ├─ .env
  ├─ deploy/
  ├─ backend/
  │   └─ data/
  ├─ src/
  ├─ package.json
  └─ ...
```

其中最重要的是：

```text
/data/docker/gpt_image_playground/backend/data
```

这个目录保存所有持久化数据，后续备份也主要备份它。

## 3. 环境变量

可以直接用 `deploy/nas.env.example` 复制为 `.env`，推荐起步值如下：

```env
GIP_HTTP_PORT=8080
GIP_SESSION_SECURE=false
OPENAI_BASE_URL=https://api.openai.com/v1
GIP_BACKEND_UPSTREAM=http://backend:8000
GIP_REQUEST_TIMEOUT_SECONDS=300
GIP_GENERATION_WORKER_COUNT=4
GIP_SESSION_TTL_SECONDS=604800
GIP_MAX_UPLOAD_BYTES=26214400
GIP_THUMBNAIL_MAX_SIZE=512
GIP_RESTORE_POINT_RETENTION=10
GIP_CORS_ORIGINS=http://你的飞牛IP:8080
```

### 关键变量说明

`GIP_HTTP_PORT`
- 前端容器对外暴露端口
- 例如 `8080`
- 浏览器最终访问地址就是 `http://你的飞牛IP:8080`

`GIP_SESSION_SECURE`
- 如果当前只是内网 HTTP 访问，先设为 `false`
- 如果后续通过飞牛反向代理、Nginx Proxy Manager 或其它方式走 HTTPS，对外访问是 `https://...`，就改成 `true`

`GIP_CORS_ORIGINS`
- 写成用户最终访问前端的实际地址
- 例如：
  - `http://192.168.1.20:8080`
  - `https://img.example.com`

`OPENAI_BASE_URL`
- 这是后端默认上游地址
- 主要影响管理员新建渠道时的默认值
- 普通用户不会看到这个值

`GIP_BACKEND_UPSTREAM`
- 前端容器内部代理后端时使用
- 默认保持 `http://backend:8000` 即可
- 只有当你把后端拆到另一台机器时，才需要改成实际后端地址

`GIP_GENERATION_WORKER_COUNT`
- 后端并发任务工作数
- 普通家庭 NAS 建议先用 `2` 或 `4`
- 如果机器配置一般，不建议一开始就开太大

## 4. 端口映射

当前 Compose 中的核心映射是：

```yaml
ports:
  - "${GIP_HTTP_PORT:-8080}:80"
```

含义：

- 宿主机端口：`8080`
- 容器内前端端口：`80`

后端不直接暴露给外部，只在容器网络内提供 `8000` 给前端代理使用。

这也是推荐做法，因为这样浏览器始终同源访问，不需要再额外折腾前端直连后端。

## 5. 路径映射

当前 Compose 已经配置：

```yaml
volumes:
  - ./backend/data:/app/backend/data
```

含义：

- 宿主机目录：`./backend/data`
- 容器目录：`/app/backend/data`

在飞牛上，这个宿主机目录最终对应你项目目录里的：

```text
/data/docker/gpt_image_playground/backend/data
```

这个目录会包含：

- `app.sqlite3`：主数据库
- `assets/`：上传和生成的图片资源
- `restore-points/`：系统导入前自动创建的恢复点

## 6. 构建镜像

如果 OpenClaw 是走“从源码部署”，那它直接执行：

```bash
docker compose up -d --build
```

就会自动构建两个镜像，不需要你手动准备。

如果它需要你先明确提供镜像构建命令，可以用下面这两条：

```bash
docker build -f deploy/Dockerfile.backend -t gpt-image-playground-backend:latest .
docker build -f deploy/Dockerfile.frontend -t gpt-image-playground-frontend:latest .
```

如果以后要改成“先构建镜像，再用 image 方式部署”，镜像名就可以直接沿用：

- `gpt-image-playground-backend:latest`
- `gpt-image-playground-frontend:latest`

## 7. 启动命令

在项目根目录执行：

```bash
cp deploy/nas.env.example .env
docker compose up -d --build
```

首次启动后访问：

```text
http://你的飞牛IP:8080
```

如果系统中还没有用户，**第一个注册用户会自动成为管理员**。

## 8. 首次上线后的管理员动作

部署成功后，管理员需要做的不是去改容器环境变量里的 API Key，而是：

1. 登录前端
2. 进入管理员设置
3. 新建渠道
4. 在渠道里配置：
   - Base URL
   - API Key
   - 请求超时
   - 模型列表
   - 接口类型 / Codex CLI 检测模式

也就是说：

- 容器环境变量里**不需要**预先写每个渠道的 API Key
- 上游渠道密钥由管理员在系统内维护

## 9. HTTPS 与反向代理

如果你之后会在飞牛上加域名和 HTTPS，建议：

1. 反向代理外部域名到 `frontend` 暴露端口
2. `.env` 中把 `GIP_SESSION_SECURE=true`
3. `GIP_CORS_ORIGINS` 改成最终访问域名

例如：

```env
GIP_SESSION_SECURE=true
GIP_CORS_ORIGINS=https://img.example.com
```

## 10. 备份建议

至少备份这个目录：

```text
/data/docker/gpt_image_playground/backend/data
```

备份它就等于备份了：

- 用户
- 角色
- 模板
- 项目
- 任务记录
- 图片资源
- 系统恢复点

## 11. 资源建议

起步建议：

- CPU 一般家用 NAS：`GIP_GENERATION_WORKER_COUNT=2`
- 稍强一些的 NAS：`GIP_GENERATION_WORKER_COUNT=4`
- 内存不足时，优先减少并发而不是改功能

因为当前后端默认是 SQLite，**同一套数据目录只建议跑一个 backend 实例**。

## 12. 常见注意事项

`页面能打开，但提示后端不可用`
- 一般是 `backend` 容器没启动成功
- 或者 `frontend` 没有正确代理到 `backend:8000`

`登录后反复掉线`
- 通常检查：
  - `GIP_SESSION_SECURE`
  - 实际访问是否已经切到了 HTTPS
  - `GIP_CORS_ORIGINS` 是否和真实访问地址一致

`容器重建后数据丢失`
- 基本就是宿主机目录没有正确映射到 `/app/backend/data`

`生成很慢`
- 先看上游渠道本身速度
- 再看 `GIP_GENERATION_WORKER_COUNT` 是否太小
- 但不要在低配 NAS 上盲目把并发开很高

## 13. 给 OpenClaw 的最短交付说明

如果你只想转一句最短的部署要求给 OpenClaw，可以直接发下面这段：

```text
请在飞牛 NAS 上用项目根目录的 docker-compose.yml 部署。
需要同时启动 frontend 和 backend 两个容器。
前端对外端口使用 .env 中的 GIP_HTTP_PORT，默认 8080。
必须把宿主机 backend/data 目录映射到容器 /app/backend/data。
首次部署先复制 deploy/nas.env.example 为 .env，并至少修改：
1. GIP_HTTP_PORT
2. GIP_SESSION_SECURE
3. GIP_CORS_ORIGINS
首次注册用户自动成为管理员，后续所有 Base URL / API Key / 模型配置都在管理员后台里维护，不写在普通用户前端里。
```
