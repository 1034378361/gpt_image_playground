# 飞牛 NAS 单镜像部署说明

这份说明对应项目的单镜像方案。

相关文件：

- `deploy/Dockerfile.all-in-one`
- `docker-compose.single.yml`
- `docker-compose.single.build.yml`
- `deploy/fnnas.single.env.example`
- `deploy/build-single-image.mjs`
- `deploy/docker-entrypoint.sh`

## 1. 方案说明

这个方案会把：

- 前端静态页面
- FastAPI 后端

一起打进同一个镜像里，并由同一个 `uvicorn` 进程对外提供：

- `/api/*`：后端接口
- `/` 以及前端静态资源：前端页面

对飞牛 NAS 来说，这个方案的优点是：

- 只需要部署一个容器
- 只需要暴露一个端口
- 路径映射更简单
- 可以通过镜像标签做版本升级和回滚

## 1.1 当前镜像版本策略

`package.json` 是应用版本的唯一来源。正式发布时，Git tag 必须是 `v<package.json version>`，CI 会校验 tag、`package.json` 和 lockfile 版本一致后再发布镜像和 GitHub Release。

单镜像方案支持三类标签：

- 固定版本：例如 `<version>`
- Git 提交：例如 `sha-<commit>`
- `latest`

推荐生产环境在 `.env` 中固定使用版本号，例如：

```env
GIP_IMAGE_NAME=gpt-image-playground
GIP_IMAGE_TAG=<version>
```

这样升级和回滚都更明确，不会依赖 `latest`。`GIP_IMAGE_TAG` 用来选择或固定运行的镜像标签，不会改变应用的 canonical version。

## 2. 需要的文件

把整个项目目录放到 NAS 上，例如：

```text
/data/docker/gpt_image_playground
```

然后使用：

- `docker-compose.single.yml`
- `docker-compose.single.build.yml`（仅源码构建时需要）

不要和双容器版的 `docker-compose.yml` 混用。

## 3. 环境变量

复制：

```bash
cp deploy/fnnas.single.env.example .env
```

至少修改下面这些值：

```env
GIP_IMAGE_NAME=gpt-image-playground
GIP_IMAGE_TAG=<version>
GIP_HTTP_PORT=8080
GIP_SESSION_SECURE=false
GIP_CORS_ORIGINS=http://你的飞牛IP:8080
```

如果后续对外是 HTTPS 域名访问，改成：

```env
GIP_SESSION_SECURE=true
GIP_CORS_ORIGINS=https://你的域名
```

如果你是直接在 NAS 上用源码构建，也可以补充下面这些构建元信息：

```env
GIP_IMAGE_BUILD_VERSION=<version>
GIP_IMAGE_BUILD_VCS_REF=local
GIP_IMAGE_BUILD_DATE=unknown
```

## 4. 端口映射

单镜像版对外暴露的是容器内 `8000` 端口：

```yaml
ports:
  - "${GIP_HTTP_PORT:-8080}:8000"
```

所以用户最终访问：

```text
http://NAS_IP:8080
```

## 5. 路径映射

单镜像版仍然只需要持久化一个关键目录：

```yaml
volumes:
  - ./backend/data:/app/backend/data
```

也就是说，宿主机要保留：

```text
/data/docker/gpt_image_playground/backend/data
```

这里面会保存：

- `app.sqlite3`
- `assets/`
- `restore-points/`
- `startup-backups/`

其中 `startup-backups/` 会在容器每次启动前自动备份当前数据库，方便升级失败时快速回滚。

## 6. 构建、导出与启动

### 6.1 直接从源码构建并启动

如果 OpenClaw 直接从源码部署，执行：

```bash
docker compose -f docker-compose.single.yml -f docker-compose.single.build.yml up -d --build
```

即可。第一次从源码构建时，镜像会打成：

```text
${GIP_IMAGE_NAME}:${GIP_IMAGE_TAG}
```

### 6.2 在本机构建可分发镜像

推荐使用项目自带脚本：

```bash
npm run docker:save:single
```

它会自动：

- 读取 `package.json` 版本号
- 读取当前 Git commit
- 构建三个标签：
  - `gpt-image-playground:<version>`
  - `gpt-image-playground:sha-<commit>`
  - `gpt-image-playground:latest`
- 导出一个版本化 tar，例如：

```text
gpt-image-playground-<version>.tar
```

如果只想构建，不想导出 tar：

```bash
npm run docker:build:single
```

当然，也可以手动执行：

```bash
docker build \
  -f deploy/Dockerfile.all-in-one \
  --build-arg APP_VERSION=<version> \
  --build-arg VCS_REF=$(git rev-parse HEAD) \
  --build-arg BUILD_DATE=$(date -Iseconds) \
  -t gpt-image-playground:<version> \
  -t gpt-image-playground:latest \
  .
```

### 6.3 在 NAS 导入镜像并启动

把 tar 传到 NAS 后执行：

```bash
docker load -i gpt-image-playground-<version>.tar
docker compose -f docker-compose.single.yml up -d --force-recreate
```

这里故意只使用 `docker-compose.single.yml`，不再包含 `build` 配置，这样当指定 tag 不存在时会直接失败，而不是偷偷拿当前源码重建镜像。

## 7. 升级与回滚

### 7.1 推荐升级方式

1. 在本地生成新版本镜像 tar
2. 传到 NAS
3. `docker load -i ...`
4. 修改 `.env` 中的 `GIP_IMAGE_TAG`
5. 执行：

```bash
docker compose -f docker-compose.single.yml up -d --force-recreate
```

这时会发生：

- 容器重建
- 持久化数据目录保留
- 启动前自动备份当前数据库到 `backend/data/startup-backups`
- 后端启动时自动执行缺失字段补齐

### 7.2 回滚方式

如果新版本不符合预期：

1. 把 `GIP_IMAGE_TAG` 改回旧版本
2. 再次执行：

```bash
docker compose -f docker-compose.single.yml up -d --force-recreate
```

如果需要恢复升级前数据库，可从：

```text
backend/data/startup-backups/
```

中取回对应时间点的 `app-*.sqlite3`。

## 8. 首次使用

启动后浏览器访问：

```text
http://你的飞牛IP:8080
```

如果系统还没有用户，**首个注册用户会自动成为管理员**。

后续管理员在系统后台里维护：

- Base URL
- API Key
- 请求超时
- 模型列表

这些不需要写死在普通用户前端里。

## 9. 给 OpenClaw 的最短说明

```text
请使用单镜像方案部署这个项目：
1. 正式部署优先使用 docker-compose.single.yml
2. 如果要现场源码构建，再额外叠加 docker-compose.single.build.yml
3. .env 中固定 GIP_IMAGE_NAME 和 GIP_IMAGE_TAG
4. 宿主机必须把 backend/data 映射到容器 /app/backend/data
5. 升级时先 docker load 新 tar，再改 GIP_IMAGE_TAG，然后 docker compose up -d --force-recreate
6. 容器启动前会自动备份数据库到 backend/data/startup-backups
7. 首个注册用户自动成为管理员
```
