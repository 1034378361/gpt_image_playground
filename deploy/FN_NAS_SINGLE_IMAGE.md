# 飞牛 NAS 单镜像部署说明

这份说明对应项目的单镜像方案。

相关文件：

- `deploy/Dockerfile.all-in-one`
- `docker-compose.single.yml`
- `deploy/fnnas.single.env.example`

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

## 2. 需要的文件

把整个项目目录放到 NAS 上，例如：

```text
/data/docker/gpt_image_playground
```

然后使用：

- `docker-compose.single.yml`

不要和双容器版的 `docker-compose.yml` 混用。

## 3. 环境变量

复制：

```bash
cp deploy/fnnas.single.env.example .env
```

至少修改下面这些值：

```env
GIP_HTTP_PORT=8080
GIP_SESSION_SECURE=false
GIP_CORS_ORIGINS=http://你的飞牛IP:8080
```

如果后续对外是 HTTPS 域名访问，改成：

```env
GIP_SESSION_SECURE=true
GIP_CORS_ORIGINS=https://你的域名
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

## 6. 构建与启动

如果 OpenClaw 直接从源码部署，执行：

```bash
docker compose -f docker-compose.single.yml up -d --build
```

即可。

如果需要先单独构建镜像：

```bash
docker build -f deploy/Dockerfile.all-in-one -t gpt-image-playground:all-in-one .
```

## 7. 首次使用

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

## 8. 给 OpenClaw 的最短说明

```text
请使用单镜像方案部署这个项目：
1. 使用 deploy/Dockerfile.all-in-one 构建镜像
2. 使用 docker-compose.single.yml 启动
3. 复制 deploy/fnnas.single.env.example 为 .env
4. 至少修改 GIP_HTTP_PORT、GIP_SESSION_SECURE、GIP_CORS_ORIGINS
5. 必须把宿主机 backend/data 映射到容器 /app/backend/data
6. 首个注册用户自动成为管理员
```
