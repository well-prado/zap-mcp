// Renders the menu bar icon (a template image: black + alpha, macOS tints it).
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 22 22">
  <path d="M11 2.5c-4.7 0-8.5 3.5-8.5 7.9 0 2.4 1.1 4.5 2.9 6l-.8 3.1 3.4-1.7c.9.3 1.9.5 3 .5 4.7 0 8.5-3.5 8.5-7.9S15.7 2.5 11 2.5z" fill="none" stroke="#000" stroke-width="1.7" stroke-linejoin="round"/>
  <path d="M12.2 5.8 8 11.4h3.1l-1.3 4 4.3-5.7H11z" fill="#000"/>
</svg>`
for (const [size, name] of [[22, 'trayTemplate.png'], [44, 'trayTemplate@2x.png']]) {
  await sharp(Buffer.from(svg(size))).png().toFile(fileURLToPath(new URL(`../resources/${name}`, import.meta.url)))
}
console.log('ok')
