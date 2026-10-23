const sharp = require('sharp');
const { PROTOCOLS, normalizeProtocol, inferProtocol } = require('./protocolRouter');
const { throwIfAborted } = require('./requestLifecycle');

async function generateMaskedImage(config, callbacks, generate) {
    if (!config.referenceImages?.[0]?.base64 || !config.maskImage?.base64) throw new Error('局部编辑需要原图和已绘制的遮罩');
    const sourceBuffer = Buffer.from(config.referenceImages[0].base64, 'base64');
    const maskBuffer = Buffer.from(config.maskImage.base64, 'base64');
    const source = sharp(sourceBuffer, { limitInputPixels: 64000000 });
    const [meta, maskMeta] = await Promise.all([source.metadata(), sharp(maskBuffer).metadata()]);
    if (maskMeta.format !== 'png' || !maskMeta.hasAlpha || meta.width !== maskMeta.width || meta.height !== maskMeta.height)
        throw new Error('遮罩必须是与原图尺寸相同、带透明通道的 PNG');
    const { width, height } = meta;
    const editAlpha = await sharp(maskBuffer).extractChannel('alpha').raw().toBuffer();
    for (let i = 0; i < editAlpha.length; i++) editAlpha[i] = 255 - editAlpha[i];
    if (!editAlpha.some(value => value > 0)) throw new Error('请先涂抹需要修改的区域');
    const sourcePng = await source.png().toBuffer();
    const rawProtocol = normalizeProtocol(config.protocol);
    const protocol = rawProtocol === PROTOCOLS.AUTO ? inferProtocol({ baseUrl: config.provider }, config.model) : rawProtocol;
    const nativeMask = protocol === PROTOCOLS.OPENAI_IMAGES && !/gemini|banana|seedream|grok|flux/i.test(config.model);
    // 第 1 张是被编辑的原图，后面原样带上其他参考图（标注图、比例版面等）
    const extras = config.referenceImages.slice(1).filter(ref => ref?.base64);
    const refs = [{ base64: sourcePng.toString('base64'), mimeType: 'image/png' }, ...extras];
    // 没有原生蒙版参数的模型：客户端没画涂抹时，服务端生成"原图 + 红色半透明涂抹"作为定位图
    // （Seedream 官方推荐的涂鸦标记写法），放在最后一张
    // 标记放在 maskImage 上：任务队列只复制已知字段，挂在 config 顶层会在排队时丢失
    const guideIncluded = !!(config.maskGuideIncluded || config.maskImage.guideIncluded);
    const addGuide = !nativeMask && !guideIncluded;
    if (addGuide) {
        const red = Buffer.alloc(width * height * 4);
        for (let i = 0; i < editAlpha.length; i += 1) {
            red[i * 4] = 239; red[i * 4 + 1] = 68; red[i * 4 + 2] = 68; red[i * 4 + 3] = Math.round(editAlpha[i] * 0.6);
        }
        const guide = await sharp(sourcePng).composite([{ input: red, raw: { width, height, channels: 4 } }]).png().toBuffer();
        refs.push({ base64: guide.toString('base64'), mimeType: 'image/png' });
    }
    // 原生蒙版原样发送（不外扩）：外扩会让改动范围比用户涂的更大
    const modelMask = nativeMask ? { base64: config.maskImage.base64, mimeType: config.maskImage.mimeType || 'image/png' } : null;
    // 原生蒙版必须贴回：实测中转站（Rolldeck / GPT Image 2.5）只返回涂抹区，区外是纯黑。
    // 其余模型默认直接用输出（整图重绘，区外基本不变、没有接缝），
    // 用户打开"严格保持涂抹区外不变"时才贴回（标记挂在 maskImage 上，才能穿过任务队列）
    const composite = nativeMask || !!config.maskImage.composite;
    throwIfAborted(callbacks.signal);
    const result = await generate({ ...config, referenceImages: refs,
        operation: nativeMask ? 'mask-edit' : 'generate', maskImage: modelMask,
        // 原生蒙版（OpenAI）按像素尺寸出图；其余协议只认 N:N 比例（如 Grsai 会把 WxH 退回 1:1 再被拉伸）
        ratio: nativeMask ? `${width}x${height}` : require('./apiService').convertToStandardRatio(width, height),
        prompt: !addGuide ? config.prompt : `对第一张原图进行局部编辑。最后一张图与原图相同，只是用红色半透明涂抹标出了需要修改的区域；只修改涂抹处，其余部分与原图保持完全一致。输出与原图构图相同的完整图片，不要出现红色涂抹。修改要求：${config.prompt}`
    }, callbacks);
    throwIfAborted(callbacks.signal);
    if (!composite) return { ...result, maskApplied: false };
    const rgb = await sharp(Buffer.from(result.base64, 'base64')).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    // 先把涂抹区往里收一圈再向内羽化：实测模型在涂抹边缘内侧约 2px 画成暗色（与区外的黑色过渡），
    // 这圈留给原图，就不会出现细黑线；取 min(收缩后的蒙版, 模糊)，涂抹区外永远是 0，原图像素一个都不动
    const inset = Math.max(2, Math.round(Math.min(width, height) * 0.002));
    const eroded = await sharp(editAlpha, { raw: { width, height, channels: 1 } }).dilate(inset).extractChannel(0).raw().toBuffer(); // sharp 的形态学以暗色为前景：dilate 才是收缩白色涂抹区
    const sigma = Math.max(0.8, Math.min(width, height) * 0.004);
    const blurred = await sharp(eroded, { raw: { width, height, channels: 1 } }).blur(sigma).extractChannel(0).raw().toBuffer(); // blur 会把单通道扩成三通道
    const feather = Buffer.alloc(editAlpha.length);
    for (let i = 0; i < editAlpha.length; i += 1) feather[i] = Math.min(eroded[i], blurred[i]);
    const patch = await sharp(rgb, { raw: { width, height, channels: 3 } })
        .joinChannel(feather, { raw: { width, height, channels: 1 } }).png().toBuffer();
    // Outside the brush mask, keep the original pixels, including alpha.
    const output = await sharp(sourcePng).composite([{ input: patch, blend: 'over' }]).png().toBuffer();
    return { ...result, base64: output.toString('base64'), mimeType: 'image/png', width, height, maskApplied: true };
}
module.exports = { generateMaskedImage };
