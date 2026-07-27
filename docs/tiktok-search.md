# 平台关键词搜索脚本

这个脚本最初只做关键词搜索和结果提取；当前项目已经扩展为“搜索 + 自动评论执行队列”。网页模式会在拿到入口结果后继续启动评论流程，支持 TikTok、Facebook Reel 和 Facebook 普通帖子。

## 运行

```bash
cd /Users/riverhuang/Desktop/project/traffic-intercept-tool
npm run search -- --keyword "skincare routine" --limit 10
```

如果你想看到浏览器打开过程，直接用上面的命令即可。  
如果你想静默运行：

```bash
npm run search -- --keyword "skincare routine" --limit 10 --headless
```

## 输出

脚本会在 `data/searches/` 目录生成：

- `*.json`：结构化结果
- `*.csv`：便于表格查看
- `*.png`：当前搜索页截图，方便排查

## 网页前端

如果你想用网页输入关键词、查看结果并启动自动评论队列，先启动本地服务：

```bash
npm run search:web
```

然后在浏览器打开：

```text
http://127.0.0.1:4318
```

## 自动评论能力

当前主网页 `public/index.html` 支持搜索完成后启动自动评论队列：

- TikTok：从入口视频进入视频流，打开评论区，检测是否已有相同评论；如果有可见高赞评论，会尝试回复高赞评论，同时发送主评论。
- Facebook Reel：搜索 Reel 结果，逐条打开并执行评论/回复流程。
- Facebook 普通帖子：从搜索列表收集可评论帖子，逐条发送主评论。
- 队列状态可通过网页轮询，也可通过 `GET /api/review-sequence` 查看。
- 可通过 `POST /api/review-sequence/stop` 停止队列。

`public/comment-draft-tool.html` 是单独的评论草稿工作台，它只生成/导出草稿，不负责自动发送。

## 说明

- CLI 搜索命令主要用于关键词搜索和结果提取。
- 主网页模式包含自动评论、自动发送和状态校验能力。
- 如果 TikTok 弹出登录或验证码，脚本会把状态和截图保存下来
- 如果你在登录链路里点了 `Sign in with Google`，Google 可能会提示 `This browser or app may not be secure`，这是自动化浏览器被拦截；优先改用 TikTok 直登，或者先在普通 Chrome 完成登录
- 网页模式会优先同步你本机最近活跃的 Chrome Profile，尽量复用现有登录态；如果同步到了错误的 Profile，可以用 `CHROME_PROFILE_NAME` 指定
- 如果当前网络出口被 TikTok 地区限制拦截，脚本会返回 `geo_blocked`
