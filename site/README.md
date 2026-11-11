# PicGen 下载落地页

一个纯静态页面，视觉沿用 AZGLB 主站（azglb.top）的设计语言：白底、`#16181d` 墨色、`#3a45c4` 靛蓝小标题、胶囊按钮、细边框卡片，以图片和图标为主、文字尽量少。页面顶栏和底部「更多工具和服务」引导回主站。

专门为国内访问做过处理：

- **不加载任何外部资源**：没有 Google Fonts、没有海外 CDN、没有统计脚本。CSS 和 JS 都内联在 `index.html` 里，一次请求就能渲染。
- **字体**：和主站一样用系统字体栈（苹方 / 微软雅黑），不下载几 MB 的中文网页字体。图标是内联 SVG。
- **图片**：截图压缩成 WebP，总共约 650 KB，滚动到才加载。
- **exe 和页面同域名**：直接下载不经过 GitHub。另外提供百度网盘作为备用。

## 生成

```bash
npm run build:win:portable   # 先打出 dist/release/PicGen-<版本>-x64.exe
npm run build:site           # 生成 dist/site（会复制 exe，算大小和 SHA-256）
npm run preview:site         # 本地预览 http://127.0.0.1:4321/
```

`dist/site` 就是要上传的全部内容：

```
dist/site/
├── index.html          页面
├── version.json        最新版本信息（版本、文件名、大小、SHA-256、下载地址）
├── img/                截图、图标、分享卡片
└── download/PicGen-<版本>-x64.exe
```

## 配置：`site/site.config.json`

| 字段 | 说明 |
| - | - |
| `siteUrl` | 页面的正式地址，例如 `https://picgen.example.cn`。用于 canonical 链接，可以不填。 |
| `mainSiteUrl` | AZGLB 主站地址，默认 `https://azglb.top`。顶栏「AZGLB 主站」和底部三张引导卡片（免费 3D 模型检测 / 亚马逊视觉案例 / 找我做图）都从这里拼链接。 |
| `directDownloadUrl` | exe 的下载地址。**留空**时 exe 会被复制到 `download/`，和页面放在同一个地方。exe 放在别处（比如对象存储）时，把完整地址填在这里，生成时就不再复制。 |
| `copyExeToSite` | 留空 `directDownloadUrl` 时是否复制 exe，默认 `true`。 |
| `baiduPanUrl` / `baiduPanCode` | 百度网盘分享链接（必须是 `https://pan.baidu.com/` 开头）和提取码。不填时页面显示"网盘链接整理中"。现在填的是 **PicGen 文件夹**的分享链接：发新版时把 exe 上传到这个文件夹即可，不用再改这里。 |
| `contact` | 页脚的联系方式，比如 QQ 群或邮箱，可以不填。 |

改完配置要重新运行 `npm run build:site`。

## 部署到国内

页面本身很小，真正需要考虑的是 **120 MB 左右的 exe**：每次下载就是 0.12 GB 流量。

**推荐：对象存储 + CDN + 已备案域名**（阿里云 OSS / 腾讯云 COS 都可以）

1. 建一个存储桶，开启"静态网站托管"，默认首页设为 `index.html`。
2. 把 `dist/site` 里的所有文件上传到存储桶根目录。
3. 绑定**已经 ICP 备案的自定义域名**，并开启 CDN。
   - 不能直接用存储桶的默认域名当网页：阿里云 OSS 通过默认域名访问 HTML 时会强制下载，而不是打开网页。
   - 在中国大陆使用自定义域名和 CDN 都需要 ICP 备案。
4. 建议给 `download/*.exe` 设置 `Content-Disposition: attachment`，让浏览器直接下载而不是尝试打开。

**自己有云服务器**

把 `dist/site` 放到 nginx 的站点目录即可。服务器带宽小时（比如 3~5 Mbps），exe 下载会很慢。这种情况建议把 exe 单独放到对象存储，在 `directDownloadUrl` 里填对象存储的地址，页面仍放在服务器上。

**防止被盗刷流量**：在对象存储或 CDN 上开启防盗链（Referer 白名单，允许空 Referer 和自己的域名），并设置流量或费用告警。

## 百度网盘

1. 把 `dist/release/PicGen-<版本>-x64.exe` 上传到网盘。
2. 分享 → 有效期选"永久有效" → 选"有提取码"。
3. 把链接和提取码填进 `site.config.json` 的 `baiduPanUrl` / `baiduPanCode`，重新生成页面。

访客点"打开百度网盘"时，提取码会自动复制到剪贴板。

## 线上地址与一键部署

线上地址：<https://picgen.azglb.top>（nginx 静态站，Let's Encrypt 证书自动续期）。

服务器上的目录结构：`/var/www/picgen/releases/<版本-时间>/` 存每次上传的完整站点，`/var/www/picgen/current` 软链接指向正在使用的那一份，nginx 只认 `current`。切换软链接是原子操作，访客不会看到上传了一半的页面；回滚就是把软链接改回旧目录。

`npm run deploy:site` = 生成页面 + 上传新目录 + 切换软链接 + 只保留最近 3 份。服务器地址和密钥路径写在 `site/deploy.local.json`（已加入 .gitignore，不会提交到公开仓库）：

```json
{ "host": "root@服务器IP", "key": "C:/Users/你/.ssh/服务器密钥.pem", "root": "/var/www/picgen", "keep": 3 }
```

## 发新版本

1. `npm run build:win:portable`
2. 把新 exe 上传到网盘，更新 `site.config.json` 里的链接（网盘链接会变）。
3. `npm run deploy:site`。

页面上的版本号、文件大小、SHA-256 和下载文件名都在生成时自动从 exe 读取，不用手改。
