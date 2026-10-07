import { MAX_IMAGE_DATA_BYTES } from './domain/layout';
import type { Widget } from './domain/layout';

export type ImportedImage = { name: string; data: string; width: number; height: number };
export async function verifyImportedImages(widgets: readonly Widget[]): Promise<void> {
  const checked = new Set<string>();
  for (const widget of widgets) {
    if (widget.type !== 'image' || checked.has(widget.settings.data)) continue;
    try {
      const bytes = Uint8Array.from(atob(widget.settings.data.slice('data:image/png;base64,'.length)), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      bitmap.close(); checked.add(widget.settings.data);
    } catch { throw new Error(`${widget.settings.label || 'Image'}: embedded PNG pixels could not be decoded. Replace this image and retry.`); }
  }
}
export async function readImportImage(file: File): Promise<ImportedImage> {
  if (!/\.(png|jpe?g|webp)$/i.test(file.name)) throw new Error('Choose a PNG, JPEG or WebP image. SVG and animated files are unsupported.');
  if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name}: choose an image smaller than 4 MB.`);
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width > 4096 || bitmap.height > 4096 || bitmap.width * bitmap.height > 16_000_000) throw new Error(`${file.name}: use dimensions up to 4096 px and 16 million pixels.`);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image import is unavailable in this browser.');
    context.drawImage(bitmap, 0, 0);
    const data = canvas.toDataURL('image/png');
    if (data.length > MAX_IMAGE_DATA_BYTES) throw new Error(`${file.name}: the portable PNG is too large. Resize or compress the image, then import it again.`);
    return { name: file.name, data, width: bitmap.width, height: bitmap.height };
  } finally { bitmap.close(); }
}

export function imageWidget(image: ImportedImage, canvas: { width: number; height: number }, index: number): Widget {
  const scale = Math.min(1, 400 / image.width, 300 / image.height, canvas.width / image.width, canvas.height / image.height);
  return { id: `import-image-${index + 1}`, type: 'image', x: 0, y: 0, width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)),
    settings: { label: image.name.slice(0, 80), data: image.data, fit: 'contain', opacity: 100 } };
}
