# 平台关键词搜索脚本

这个脚本做的事情只有一件：按关键词打开当前平台适配器的搜索页，提取可见视频结果，并导出到本地文件。当前适配器是 TikTok。

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

如果你想用网页输入关键词并直接看结果，先启动本地服务：

```bash
npm run search:web
```

然后在浏览器打开：

```text
http://127.0.0.1:4318
```

## 说明

- 只实现关键词搜索和结果提取
- 不包含自动评论、自动发送、自动互动
- 如果 TikTok 弹出登录或验证码，脚本会把状态和截图保存下来
- 如果你在登录链路里点了 `Sign in with Google`，Google 可能会提示 `This browser or app may not be secure`，这是自动化浏览器被拦截；优先改用 TikTok 直登，或者先在普通 Chrome 完成登录
- 网页模式会优先同步你本机最近活跃的 Chrome Profile，尽量复用现有登录态；如果同步到了错误的 Profile，可以用 `CHROME_PROFILE_NAME` 指定
- 如果当前网络出口被 TikTok 地区限制拦截，脚本会返回 `geo_blocked`
