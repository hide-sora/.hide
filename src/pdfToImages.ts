/**
 * pdfToImages.ts — PDF ファイルを PdfHideImage[] に変換する
 *
 * pdfjs-dist (Node.js canvas-free mode) を使い、各ページを RGBA 画像として
 * レンダリングする。browser 環境では OffscreenCanvas、Node.js 環境では
 * pdfjs-dist 内蔵の SVG→ImageData パスを使う。
 *
 * 依存: pdfjs-dist (devDependencies に配置。runtime では dynamic import)
 */

import type { PdfHideImage } from './pdfHideImage';

// ============================================================
// 公開型
// ============================================================

export interface PdfToImagesOptions {
  /** レンダリング DPI (default: 150) */
  dpi?: number;
  /** 最大ページ数 (default: 制限なし) */
  maxPages?: number;
}

export interface PdfToImagesResult {
  /** ページ画像 (0-indexed) */
  images: PdfHideImage[];
  /** 各ページの base64 PNG (LLM prompt 用) */
  base64Pages: Array<{ base64: string; mediaType: 'image/png' }>;
  /** ページ数 */
  pageCount: number;
}

// ============================================================
// 公開API
// ============================================================

/**
 * PDF バイナリを全ページ画像に変換する。
 *
 * @param pdfData PDF ファイルの ArrayBuffer or Uint8Array
 * @param opts レンダリングオプション
 * @returns 各ページの PdfHideImage + base64 PNG
 */
export async function pdfToImages(
  pdfData: ArrayBuffer | Uint8Array,
  opts: PdfToImagesOptions = {},
): Promise<PdfToImagesResult> {
  const dpi = opts.dpi ?? 150;
  const scale = dpi / 72; // PDF standard = 72 DPI

  // Dynamic import to keep pdfjs-dist optional
  const pdfjsLib = await import('pdfjs-dist');

  const doc = await pdfjsLib.getDocument({
    data: pdfData instanceof ArrayBuffer ? new Uint8Array(pdfData) : pdfData,
    useSystemFonts: true,
    // Disable worker for Node.js simplicity
    isEvalSupported: false,
  }).promise;

  const pageCount = opts.maxPages
    ? Math.min(doc.numPages, opts.maxPages)
    : doc.numPages;

  const images: PdfHideImage[] = [];
  const base64Pages: PdfToImagesResult['base64Pages'] = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const width = Math.floor(viewport.width);
    const height = Math.floor(viewport.height);

    // Use OffscreenCanvas (Node 20+ / browser)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const OC = (globalThis as any).OffscreenCanvas;
    if (!OC) {
      throw new Error(
        'pdfToImages requires OffscreenCanvas (Node 20+ or browser). ' +
        'For older Node, use pdfToImagesFromFile() with canvas package.',
      );
    }
    const canvas = new OC(width, height);
    const ctx = canvas.getContext('2d')!;

    await page.render({
      canvasContext: ctx,
      viewport,
      canvas: canvas,
    } as Parameters<typeof page.render>[0]).promise;

    const imageData = ctx.getImageData(0, 0, width, height);
    const image: PdfHideImage = {
      data: imageData.data,
      width,
      height,
    };
    images.push(image);

    // Generate base64 PNG for LLM prompts
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const arrayBuf = await blob.arrayBuffer();
    const b64 = bufferToBase64(new Uint8Array(arrayBuf));
    base64Pages.push({ base64: b64, mediaType: 'image/png' });

    page.cleanup();
  }

  return { images, base64Pages, pageCount };
}

/**
 * PDF ファイルパスから画像に変換する (Node.js 専用)。
 * readFileSync で読み込んでから pdfToImages に委譲する。
 */
export async function pdfToImagesFromFile(
  filePath: string,
  opts: PdfToImagesOptions = {},
): Promise<PdfToImagesResult> {
  const { readFileSync } = await import('node:fs');
  const data = readFileSync(filePath);
  return pdfToImages(data.buffer as ArrayBuffer, opts);
}

// ============================================================
// 内部ヘルパー
// ============================================================

function bufferToBase64(bytes: Uint8Array): string {
  // Node.js
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  // Browser
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
