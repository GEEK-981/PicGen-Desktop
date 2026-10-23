const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
async function buildIcons() {
    const root = path.resolve(__dirname, '..', 'assets');
    const svg = await fs.readFile(path.join(root, 'picgen-icon.svg'));
    const sizes = [16, 32, 48, 64, 128, 256];
    const images = await Promise.all(sizes.map(size => sharp(svg).resize(size, size).png().toBuffer()));
    const header = Buffer.alloc(6 + images.length * 16);
    header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach((image, i) => {
        const index = 6 + i * 16;
        header[index] = sizes[i] % 256; header[index + 1] = sizes[i] % 256;
        header.writeUInt16LE(1, index + 4); header.writeUInt16LE(32, index + 6);
        header.writeUInt32LE(image.length, index + 8); header.writeUInt32LE(offset, index + 12);
        offset += image.length;
    });
    await fs.writeFile(path.join(root, 'picgen.ico'), Buffer.concat([header, ...images]));
    await fs.writeFile(path.join(root, 'picgen-icon.png'), images.at(-1));
}
buildIcons().catch(error => { console.error(error); process.exitCode = 1; });
