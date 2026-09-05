# Zeabur 部署

- 网站：https://photo-image2.zeabur.app
- 管理项目：https://zeabur.com/projects/6a9b8c9539c2940e7ee0e5a5
- 应用服务：`6a9b8d3f39c2940e7ee0e5cd`
- 环境：`6a9b8c95a34c0097522d3b1e`
- 数据库：本项目独立 MySQL 服务，账号、次数、会员和 API 设置保存在数据库。
- 上传模板存储：`template-uploads` 挂载至 `/app/user_templates`。

## 管理员登录

在网页右上角进入管理后台，输入 Zeabur 应用服务环境变量 `ADMIN_PASSWORD` 的值。
初始化密码保存在本机被 Git 忽略的 `deployment-private-admin.txt`，不要提交或公开该文件。
修改密码请更新 Zeabur 的 `ADMIN_PASSWORD` 并重启应用；旧会话将在重启后失效。
API 密钥通过管理后台设置，保存后不会回显，留空表示保持原值。

## 运行配置

使用 Dockerfile 启动 Node 服务。Zeabur 注入 `MYSQL_HOST`、`MYSQL_PORT`、
`MYSQL_USERNAME`、`MYSQL_PASSWORD`、`MYSQL_DATABASE`。生产环境设置
`NODE_ENV=production`、`REQUIRE_DATABASE=true`、`ADMIN_PASSWORD`。
`GET /api/health` 应返回 `database: mysql`。数据库不可用时停止启动，避免使用临时 JSON 文件。

## 更新与验证

当前通过 Zeabur CLI 上传源码部署，尚未连接 GitHub 自动部署。
推送 GitHub 后，需要将相同版本源码通过 `zeabur deploy` 更新到上述服务和环境。
应从干净的 Git 导出目录上传，不要上传本地用户数据、密钥配置或依赖目录。
运行 `node --test auth.test.js` 检查登录会话、越权保护和静态文件隔离。
运行 `node --check server.js` 检查后端语法。

## 已完成验证

HTTPS 首页可访问；管理员登录、API 设置保存和未授权访问拦截通过。
新账号获得 10 次免费机会；应用重启后账号和 API 设置仍保留。
测试账号已清理。本次没有调用付费图片生成接口，生成效果和上游密钥有效性需另行验证。
