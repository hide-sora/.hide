/**
 * scripts/templateGen.ts — Bravura.otf → src/pdfHideTemplates.ts generator
 *
 * Phase 2b の template matching で必要となる SMuFL glyph (notehead, accidental, clef,
 * rest 等) を Bravura.otf から取り出し、複数 staffSpace size に raster 化して
 * `src/pdfHideTemplates.ts` に書き出す。
 *
 * 起動方法:
 *   npx tsx scripts/templateGen.ts
 *
 * 設計:
 *  - opentype.js (devDep, 純 JS) で OTF を parse
 *  - 各 glyph を target staff space (pixel 単位) に scale → cubic Bezier を de Casteljau で
 *    polyline 化 → scanline 多角形塗りつぶしで bitmap 生成
 *  - フィル規則は even-odd (hollow notehead や穴あき clef を正しく扱える)
 *  - production deps はゼロのまま (devDep のみ、CI 時に再生成不要、生成物は git commit)
 *  - native binary 依存なし (pure TS rasterizer なので Windows/macOS/Linux いずれでも動く)
 *
 * Bravura font (c) Steinberg Media Technologies GmbH, SIL Open Font License 1.1
 *  - フォント本体: corpus/fonts/Bravura.otf
 *  - ライセンス全文: corpus/fonts/LICENSE.txt
 *
 * 出力ファイル `src/pdfHideTemplates.ts` は generated. 手動編集禁止。
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSync } from 'opentype.js';
import type { Font, Glyph, PathCommand } from 'opentype.js';

// ============================================================
// パス設定
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const FONT_PATH = join(REPO_ROOT, 'corpus', 'fonts', 'Bravura.otf');
const OUTPUT_PATH = join(REPO_ROOT, 'src', 'pdfHideTemplates.ts');

// ============================================================
// ターゲット glyph 定義
// ============================================================

interface GlyphSpec {
  /** SMuFL canonical 名 (TS 上の TemplateName と一致させる) */
  name: string;
  /** SMuFL Unicode code point */
  codePoint: number;
  /** 人間可読な説明 (生成ファイル先頭の table comment 用) */
  description: string;
}

/**
 * Phase 2b で必要となる SMuFL glyph 一覧。
 * code point は SMuFL glyphnames.json (https://github.com/w3c/smufl) 由来。
 *
 * MVP では:
 *  - notehead × 4 (filled, half, whole, x)
 *  - accidental × 5 (sharp, flat, natural, double sharp, double flat)
 *  - clef × 4 (G, F, C, percussion)
 *  - rest × 5 (whole, half, quarter, 8th, 16th)
 *
 * 合計 18 個。Phase 2b の進捗に応じて dynamics / articulation / 進行記号を追加していく。
 */
const TARGET_GLYPHS: GlyphSpec[] = [
  // ----- noteheads -----
  { name: 'noteheadBlack', codePoint: 0xe0a4, description: 'black notehead (filled, quarter/eighth/etc.)' },
  { name: 'noteheadHalf', codePoint: 0xe0a3, description: 'half notehead (hollow, half note)' },
  { name: 'noteheadWhole', codePoint: 0xe0a2, description: 'whole notehead (oval hollow)' },
  { name: 'noteheadXBlack', codePoint: 0xe0a9, description: 'X notehead (percussion, filled)' },

  // ----- accidentals -----
  { name: 'accidentalSharp', codePoint: 0xe262, description: 'sharp #' },
  { name: 'accidentalFlat', codePoint: 0xe260, description: 'flat b' },
  { name: 'accidentalNatural', codePoint: 0xe261, description: 'natural ♮' },
  { name: 'accidentalDoubleSharp', codePoint: 0xe263, description: 'double sharp x' },
  { name: 'accidentalDoubleFlat', codePoint: 0xe264, description: 'double flat bb' },

  // ----- clefs -----
  { name: 'gClef', codePoint: 0xe050, description: 'G clef (treble)' },
  { name: 'fClef', codePoint: 0xe062, description: 'F clef (bass)' },
  { name: 'cClef', codePoint: 0xe05c, description: 'C clef (alto/tenor)' },
  { name: 'unpitchedPercussionClef1', codePoint: 0xe069, description: 'percussion clef (2 vertical bars)' },

  // ----- rests -----
  { name: 'restWhole', codePoint: 0xe4e3, description: 'whole rest' },
  { name: 'restHalf', codePoint: 0xe4e4, description: 'half rest' },
  { name: 'restQuarter', codePoint: 0xe4e5, description: 'quarter rest' },
  { name: 'rest8th', codePoint: 0xe4e6, description: 'eighth rest' },
  { name: 'rest16th', codePoint: 0xe4e7, description: '16th rest' },
];

/**
 * 生成する staffSpace pixel size の離散セット。
 * runtime では layout 検出された `staffBand.lineSpacing` から最近傍を選ぶ。
 *
 * engraved PDF の典型 line spacing 範囲 8〜16 px をカバー。
 * 5 段階あれば最近傍誤差が高々 ±1 px 程度に抑えられる。
 */
const STAFF_SPACE_SIZES = [8, 10, 12, 14, 16] as const;

/** Bravura は SMuFL 仕様で staffSpace = 250 design units に正規化されている */
const BRAVURA_STAFF_SPACE_UNITS = 250;

// ============================================================
// rasterizer (pure TS)
// ============================================================

interface Point {
  x: number;
  y: number;
}

/**
 * 1 つの sub-path (`M` で開始 → `Z` または次の `M` で終了) を、
 * Bezier 平滑化込みの polyline (Point の配列) に変換する。
 * 戻り値の最終点は `Z` で開始点に閉じてある。
 */
function flattenSubpath(cmds: PathCommand[]): Point[] {
  const out: Point[] = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  for (const c of cmds) {
    switch (c.type) {
      case 'M':
        cx = c.x;
        cy = c.y;
        startX = cx;
        startY = cy;
        out.push({ x: cx, y: cy });
        break;
      case 'L':
        cx = c.x;
        cy = c.y;
        out.push({ x: cx, y: cy });
        break;
      case 'C': {
        const pts = flattenCubic(cx, cy, c.x1, c.y1, c.x2, c.y2, c.x, c.y, 0);
        for (let i = 1; i < pts.length; i++) out.push(pts[i]);
        cx = c.x;
        cy = c.y;
        break;
      }
      case 'Q': {
        const pts = flattenQuadratic(cx, cy, c.x1, c.y1, c.x, c.y, 0);
        for (let i = 1; i < pts.length; i++) out.push(pts[i]);
        cx = c.x;
        cy = c.y;
        break;
      }
      case 'Z':
        if (out.length > 0 && (cx !== startX || cy !== startY)) {
          out.push({ x: startX, y: startY });
          cx = startX;
          cy = startY;
        }
        break;
    }
  }
  return out;
}

/**
 * Cubic Bezier の de Casteljau 再帰平滑化。
 * c1, c2 と弦 (P0–P3) の距離が 0.25 px 未満で直線近似に切り替える。
 * 再帰深度 16 を上限 (発散防止)。
 */
function flattenCubic(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  depth: number,
): Point[] {
  if (depth >= 16) {
    return [
      { x: x0, y: y0 },
      { x: x3, y: y3 },
    ];
  }
  const dx = x3 - x0;
  const dy = y3 - y0;
  const chordLen = Math.hypot(dx, dy);
  const TOL = 0.25;
  let flatEnough: boolean;
  if (chordLen > 0) {
    const d1 = Math.abs(dy * x1 - dx * y1 + x3 * y0 - y3 * x0) / chordLen;
    const d2 = Math.abs(dy * x2 - dx * y2 + x3 * y0 - y3 * x0) / chordLen;
    flatEnough = d1 < TOL && d2 < TOL;
  } else {
    // 始終点が同じ (loop) → 制御点までの距離で判定
    const m1 = Math.hypot(x1 - x0, y1 - y0);
    const m2 = Math.hypot(x2 - x0, y2 - y0);
    flatEnough = Math.max(m1, m2) < TOL;
  }
  if (flatEnough) {
    return [
      { x: x0, y: y0 },
      { x: x3, y: y3 },
    ];
  }
  const mx01 = (x0 + x1) / 2;
  const my01 = (y0 + y1) / 2;
  const mx12 = (x1 + x2) / 2;
  const my12 = (y1 + y2) / 2;
  const mx23 = (x2 + x3) / 2;
  const my23 = (y2 + y3) / 2;
  const mx012 = (mx01 + mx12) / 2;
  const my012 = (my01 + my12) / 2;
  const mx123 = (mx12 + mx23) / 2;
  const my123 = (my12 + my23) / 2;
  const mx0123 = (mx012 + mx123) / 2;
  const my0123 = (my012 + my123) / 2;
  const left = flattenCubic(x0, y0, mx01, my01, mx012, my012, mx0123, my0123, depth + 1);
  const right = flattenCubic(mx0123, my0123, mx123, my123, mx23, my23, x3, y3, depth + 1);
  return left.concat(right.slice(1));
}

/**
 * Quadratic Bezier の de Casteljau 再帰平滑化 (Bravura は CFF outline で
 * 通常 cubic only だが念のため対応)。
 */
function flattenQuadratic(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  depth: number,
): Point[] {
  if (depth >= 16) {
    return [
      { x: x0, y: y0 },
      { x: x2, y: y2 },
    ];
  }
  const dx = x2 - x0;
  const dy = y2 - y0;
  const chordLen = Math.hypot(dx, dy);
  const TOL = 0.25;
  if (chordLen > 0) {
    const d = Math.abs(dy * x1 - dx * y1 + x2 * y0 - y2 * x0) / chordLen;
    if (d < TOL) {
      return [
        { x: x0, y: y0 },
        { x: x2, y: y2 },
      ];
    }
  }
  const mx01 = (x0 + x1) / 2;
  const my01 = (y0 + y1) / 2;
  const mx12 = (x1 + x2) / 2;
  const my12 = (y1 + y2) / 2;
  const mx012 = (mx01 + mx12) / 2;
  const my012 = (my01 + my12) / 2;
  const left = flattenQuadratic(x0, y0, mx01, my01, mx012, my012, depth + 1);
  const right = flattenQuadratic(mx012, my012, mx12, my12, x2, y2, depth + 1);
  return left.concat(right.slice(1));
}

/**
 * scanline polygon fill (even-odd rule)。
 *
 * 入力: subpaths の配列 (各 sub-path は閉じた多角形)
 * 出力: Uint8Array (row-major、0 = 背景、1 = 前景 (黒))
 *
 * 各 scanline で半開区間 `[ymin, ymax)` のテストを使い、
 * peak/valley の vertex を二重カウントしないようにする。
 * 交差点は sub-pixel center `y + 0.5` で取って、整数 y のジャギーを抑える。
 *
 * 同じ y の交差点を sort してペアごとに塗る (even-odd) — hollow notehead や
 * 穴あき clef が正しく hollow になる。
 */
function fillSubpaths(
  subpaths: Point[][],
  width: number,
  height: number,
): Uint8Array {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (const sub of subpaths) {
      for (let i = 0; i < sub.length - 1; i++) {
        const p1 = sub[i];
        const p2 = sub[i + 1];
        const ymin = Math.min(p1.y, p2.y);
        const ymax = Math.max(p1.y, p2.y);
        if (yc < ymin || yc >= ymax) continue;
        const t = (yc - p1.y) / (p2.y - p1.y);
        const x = p1.x + t * (p2.x - p1.x);
        xs.push(x);
      }
    }
    if (xs.length === 0) continue;
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.round(xs[i]));
      const x1 = Math.min(width, Math.round(xs[i + 1]));
      for (let x = x0; x < x1; x++) {
        data[y * width + x] = 1;
      }
    }
  }
  return data;
}

interface RasterResult {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * 1 つの glyph を staffSpace pixel に scale して raster 化する。
 *
 * Bravura は SMuFL の staffSpace = 250 design unit に正規化されているので、
 * scale = `staffSpacePx / 250` を全座標に適用すれば「staffSpace 1 つ = staffSpacePx」になる。
 * notehead は約 1 staffSpace 高、clef は約 4〜5 staffSpace 高、accidental は約 2〜3 staffSpace 高。
 */
function rasterizeGlyph(glyph: Glyph, staffSpacePx: number): RasterResult {
  const scale = staffSpacePx / BRAVURA_STAFF_SPACE_UNITS;
  // fontSize = unitsPerEm = 1000 で 1:1 マッピング (font unit = pixel) を一旦取得
  const path = glyph.getPath(0, 0, 1000);

  // 全 commands を scale 化 (型を維持)
  const scaled: PathCommand[] = path.commands.map((c): PathCommand => {
    switch (c.type) {
      case 'M':
        return { type: 'M', x: c.x * scale, y: c.y * scale };
      case 'L':
        return { type: 'L', x: c.x * scale, y: c.y * scale };
      case 'C':
        return {
          type: 'C',
          x1: c.x1 * scale,
          y1: c.y1 * scale,
          x2: c.x2 * scale,
          y2: c.y2 * scale,
          x: c.x * scale,
          y: c.y * scale,
        };
      case 'Q':
        return {
          type: 'Q',
          x1: c.x1 * scale,
          y1: c.y1 * scale,
          x: c.x * scale,
          y: c.y * scale,
        };
      case 'Z':
        return { type: 'Z' };
    }
  });

  // sub-path に分割し flatten
  const subpaths: Point[][] = [];
  let buf: PathCommand[] = [];
  const flush = (): void => {
    if (buf.length > 0) {
      const sub = flattenSubpath(buf);
      if (sub.length >= 3) subpaths.push(sub);
    }
    buf = [];
  };
  for (const c of scaled) {
    if (c.type === 'M') {
      flush();
      buf.push(c);
    } else {
      buf.push(c);
    }
  }
  flush();

  if (subpaths.length === 0) {
    return { width: 1, height: 1, data: new Uint8Array(1) };
  }

  // pixel bbox (1px のマージン込み)
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sub of subpaths) {
    for (const p of sub) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const ix0 = Math.floor(minX) - 1;
  const iy0 = Math.floor(minY) - 1;
  const ix1 = Math.ceil(maxX) + 1;
  const iy1 = Math.ceil(maxY) + 1;
  const width = Math.max(1, ix1 - ix0);
  const height = Math.max(1, iy1 - iy0);

  // bbox の左上を (0,0) に平行移動
  const translated = subpaths.map((sub) =>
    sub.map((p) => ({ x: p.x - ix0, y: p.y - iy0 })),
  );

  const data = fillSubpaths(translated, width, height);
  return { width, height, data };
}

// ============================================================
// 出力エンコード
// ============================================================

interface BitmapEntry {
  glyphName: string;
  staffSpace: number;
  width: number;
  height: number;
  /** row-major の "0"/"1" 連結。デコードは bits() helper で行う */
  bits: string;
}

function encodeBits(b: RasterResult): string {
  let s = '';
  for (let i = 0; i < b.data.length; i++) s += b.data[i] ? '1' : '0';
  return s;
}

function generateOutput(
  entries: BitmapEntry[],
  glyphSpecs: GlyphSpec[],
): string {
  // group by glyphName, preserving the order from glyphSpecs
  const grouped = new Map<string, BitmapEntry[]>();
  for (const spec of glyphSpecs) grouped.set(spec.name, []);
  for (const e of entries) {
    const arr = grouped.get(e.glyphName);
    if (arr) arr.push(e);
  }
  // sort each group by staffSpace
  for (const arr of grouped.values()) {
    arr.sort((a, b) => a.staffSpace - b.staffSpace);
  }
  // glyphSpecs にあって entries に1 つも無いものは TemplateName から除外
  const usedGlyphs = glyphSpecs.filter((s) => (grouped.get(s.name) ?? []).length > 0);
  const glyphNames = usedGlyphs.map((s) => s.name);

  let s = '';
  s += '/**\n';
  s += ' * pdfHideTemplates.ts — SMuFL glyph bitmap templates (generated)\n';
  s += ' *\n';
  s += ' * 自動生成: scripts/templateGen.ts (Bravura.otf → bitmap)\n';
  s += ' * 手動編集禁止。再生成は `npx tsx scripts/templateGen.ts`。\n';
  s += ' *\n';
  s += ' * 各 glyph は SMuFL canonical 名で identify される。\n';
  s += ' * 各 size は staffSpace pixel (5 線の line spacing) を意味する。\n';
  s += ' * runtime では layout 検出した `staffBand.lineSpacing` から最近傍 size を選ぶ。\n';
  s += ' *\n';
  s += ' * 含まれる glyph 一覧:\n';
  for (const spec of usedGlyphs) {
    s += ` *  - ${spec.name} (U+${spec.codePoint.toString(16).toUpperCase()}): ${spec.description}\n`;
  }
  s += ' *\n';
  s += ' * Bravura font (c) Steinberg Media Technologies GmbH, SIL Open Font License 1.1\n';
  s += ' * フォント本体: corpus/fonts/Bravura.otf, ライセンス: corpus/fonts/LICENSE.txt\n';
  s += ' */\n\n';

  s += '/**\n';
  s += ' * 1 つの SMuFL glyph の特定 staffSpace size における raster bitmap。\n';
  s += ' * `data` は row-major、0 = 背景、1 = 前景 (黒インク)。\n';
  s += ' */\n';
  s += 'export interface TemplateBitmap {\n';
  s += '  width: number;\n';
  s += '  height: number;\n';
  s += '  data: Uint8Array;\n';
  s += '}\n\n';

  s += '/** template の SMuFL canonical 名 */\n';
  s += 'export type TemplateName =\n';
  for (let i = 0; i < glyphNames.length; i++) {
    const sep = i === glyphNames.length - 1 ? ';' : '';
    s += `  | '${glyphNames[i]}'${sep}\n`;
  }
  s += '\n';

  s += '/** 生成済みの staffSpace pixel size (template lookup の離散セット) */\n';
  s += `export const TEMPLATE_STAFF_SPACE_SIZES = [${STAFF_SPACE_SIZES.join(', ')}] as const;\n\n`;

  s += '/**\n';
  s += ' * compact "0"/"1" 文字列 → Uint8Array (内部 helper、module load 時に 1 回だけ実行)\n';
  s += ' */\n';
  s += 'function bits(s: string): Uint8Array {\n';
  s += '  const out = new Uint8Array(s.length);\n';
  s += '  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) === 49 ? 1 : 0;\n';
  s += '  return out;\n';
  s += '}\n\n';

  s += '/**\n';
  s += ' * 全 template の lookup 表。\n';
  s += ' * `TEMPLATES[name][staffSpacePx]` で取り出す。\n';
  s += ' * 通常は `getTemplate(name, lineSpacing)` を使う。\n';
  s += ' */\n';
  s += 'export const TEMPLATES: Record<TemplateName, Record<number, TemplateBitmap>> = {\n';
  for (const name of glyphNames) {
    s += `  ${name}: {\n`;
    const arr = grouped.get(name) ?? [];
    for (const e of arr) {
      s += `    ${e.staffSpace}: { width: ${e.width}, height: ${e.height}, data: bits('${e.bits}') },\n`;
    }
    s += '  },\n';
  }
  s += '};\n\n';

  s += '/**\n';
  s += ' * `lineSpacing` (= staffSpace pixel) に最も近い template を返す。\n';
  s += ' * lineSpacing が discrete サイズ間にある場合は最近傍を選ぶ。\n';
  s += ' * 該当 glyph が template 表に無い場合は undefined。\n';
  s += ' */\n';
  s += 'export function getTemplate(\n';
  s += '  name: TemplateName,\n';
  s += '  lineSpacing: number,\n';
  s += '): TemplateBitmap | undefined {\n';
  s += '  const variants = TEMPLATES[name];\n';
  s += '  if (!variants) return undefined;\n';
  s += '  let best: number | undefined;\n';
  s += '  let bestDist = Infinity;\n';
  s += '  for (const sz of TEMPLATE_STAFF_SPACE_SIZES) {\n';
  s += '    if (!variants[sz]) continue;\n';
  s += '    const d = Math.abs(sz - lineSpacing);\n';
  s += '    if (d < bestDist) {\n';
  s += '      bestDist = d;\n';
  s += '      best = sz;\n';
  s += '    }\n';
  s += '  }\n';
  s += '  return best === undefined ? undefined : variants[best];\n';
  s += '}\n';

  return s;
}

// ============================================================
// メイン
// ============================================================

function main(): void {
  console.log(`[templateGen] loading ${FONT_PATH}`);
  const font: Font = loadSync(FONT_PATH);
  console.log(`[templateGen] numGlyphs=${font.numGlyphs} unitsPerEm=${font.unitsPerEm}`);

  const entries: BitmapEntry[] = [];
  for (const spec of TARGET_GLYPHS) {
    const glyph = font.charToGlyph(String.fromCodePoint(spec.codePoint));
    if (!glyph || glyph.index === 0) {
      console.warn(
        `[templateGen] missing glyph: ${spec.name} (U+${spec.codePoint
          .toString(16)
          .toUpperCase()})`,
      );
      continue;
    }
    for (const size of STAFF_SPACE_SIZES) {
      const bm = rasterizeGlyph(glyph, size);
      const fillCount = bm.data.reduce((acc: number, v: number) => acc + v, 0);
      const fillRatio = (fillCount / bm.data.length).toFixed(2);
      entries.push({
        glyphName: spec.name,
        staffSpace: size,
        width: bm.width,
        height: bm.height,
        bits: encodeBits(bm),
      });
      console.log(
        `  ${spec.name.padEnd(28)} ${String(size).padStart(2)}px → ${String(bm.width).padStart(3)}x${String(bm.height).padStart(3)} fill=${fillRatio}`,
      );
    }
  }

  const out = generateOutput(entries, TARGET_GLYPHS);
  writeFileSync(OUTPUT_PATH, out, 'utf-8');
  console.log(
    `[templateGen] wrote ${OUTPUT_PATH} (${out.length} bytes, ${entries.length} bitmaps)`,
  );
}

main();
