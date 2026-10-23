// Runs in a separate, invisible renderer. Original-image decoding and canvas
// work never run in the application's main process or its interactive renderer.
window.createThumbnail = async function ({ src, width, height }) {
    const image = new Image();
    image.src = src;
    await image.decode();
    const scale = Math.min(1, width / image.naturalWidth, height / image.naturalHeight);
    const targetWidth = Math.max(1, Math.round(image.naturalWidth * scale));
    const targetHeight = Math.max(1, Math.round(image.naturalHeight * scale));
    const bitmap = await createImageBitmap(image, { resizeWidth: targetWidth, resizeHeight: targetHeight, resizeQuality: 'high' });
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    image.removeAttribute('src');
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('无法编码图片缩略图'));
        reader.readAsDataURL(blob);
    });
};
