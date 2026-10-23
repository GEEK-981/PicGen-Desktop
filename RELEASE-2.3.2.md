# PicGen 2.3.2

- 提示词反推与优化支持 OpenAI 兼容、Gemini Native、Claude SSE 流式输出，使用 Appica TextAnimate Typewriter 展示新增片段。可停止、复制；成功后写入结果。优化过程中修改原文或切换序列，不会误覆盖其他草稿。
- 图片悬停预览使用 Appica Card，保留尺寸、模型和供应商信息。同一历史图片区域内跨图片移动复用窗口；解码与编码在独立工作线程完成，预览最大边 1000 像素，结果缓存。
- 局部编辑先把原图和 PNG alpha 遮罩发送到活动序列，不要求先填写提示词或配置供应商。待编辑图片可见、可取消，按序列独立保存于当前运行会话。填写提示词后生成，单次 1 张；明确的入队失败保留遮罩。
- 支持原生遮罩的 OpenAI Images 接口发送 multipart image + mask。其他参考图接口发送原图和黑白区域指引，随后将结果按遮罩合成回原图，保持原始尺寸及遮罩外像素。模型对指令和区域的理解仍取决于供应商；未执行付费供应商实测。
- 相似图的特征与分组持久保存到 desktop-cache/similarity-index.json。启动后低速检查文件变化；主动打开加速处理缺失项。已完成分组直接复用。聚类按构图、颜色和比例，已放宽阈值，属于视觉特征匹配。
- 相似组默认收起为照片堆，仅使用缓存缩略图，最多展示 10 层；角标显示总数，悬停微展，点击展开。缩略图失败时不会改用大图。
- 窗口高度不超过 720px 时，最近图片减少到 5 张并改为单行横向滚动；普通高度仍为最近 10 张。序列胶囊收窄，比例图形在固定图标列居中、文字左对齐。
- Gemini / Nano Banana 与 GPT / DALL-E 标识采用 LobeHub 官方静态 SVG，MIT 许可附在 assets/model-icons/LICENSE。供应的 PicGen 图案重绘为纯 SVG，并生成 Windows ICO 与托盘 PNG；悬浮入口为 60px 圆形。
- 并发与网络设置的自动保存串行提交，避免快速切换时旧请求覆盖最后选择；排行更新保留现有内容，减少闪动。

实现来源：

- https://appica.dev/ui/components/react/card
- https://appica.dev/ui/components/react/text-animate
- https://github.com/lobehub/lobe-icons
- https://github.com/rexxars/eventsource-parser
- https://sharp.pixelplumbing.com/

本版验证使用隔离的临时配置和本地模拟接口，不读取或改写用户的供应商密钥、历史图片和保存目录。
