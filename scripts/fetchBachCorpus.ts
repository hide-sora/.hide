/**
 * scripts/fetchBachCorpus.ts — music21 GitHub mirror から Bach chorales を fetch + 展開
 *
 * v1.9 ロードマップ #1 (Bach corpus port) の取り込みスクリプト。
 *
 * 出力:
 *   corpus/bach/xml/<bwvN.M>.xml   ... 解凍済み MusicXML (text、git-friendly)
 *   corpus/bach/hide/<bwvN.M>.hide ... 変換済み .hide source
 *   corpus/bach/INDEX.json          ... ファイル一覧 + 各件の diagnostics サマリ
 *
 * 使い方:
 *   npx tsx scripts/fetchBachCorpus.ts        ... 全 .mxl を fetch + 展開 + .hide 変換
 *   npx tsx scripts/fetchBachCorpus.ts --convert-only  ... fetch を skip、既存 xml だけ再変換
 *
 * 設計メモ:
 *  - .mxl は ZIP archive (PK\x03\x04) で、中身は META-INF/container.xml + 本体 .xml
 *  - 依存追加を避けるため node:zlib.inflateRawSync で最小限 ZIP リーダを内蔵
 *  - .krn (Humdrum) ファイルは別フォーマットなので scope 外
 *  - 既存の bwvX.X.xml (raw、非圧縮) も同じ場所にあり、そのまま採用
 *  - silent fill 禁止原則: 変換 diagnostics は INDEX.json に保存、テストはこれに頼らず
 *    各 xml を毎回再変換して analyzeMatrix まで通すことを assert する
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { musicXmlToHide } from '../src/musicXmlToHide.ts';
import { analyzeMatrix } from '../src/hideMatrix.ts';

// ============================================================
// パス設定
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const CORPUS_DIR = join(REPO_ROOT, 'corpus', 'bach');
const XML_DIR = join(CORPUS_DIR, 'xml');
const HIDE_DIR = join(CORPUS_DIR, 'hide');
const INDEX_PATH = join(CORPUS_DIR, 'INDEX.json');

const MUSIC21_API = 'https://api.github.com/repos/cuthbertLab/music21/contents/music21/corpus/bach?per_page=500';
const MUSIC21_RAW = 'https://raw.githubusercontent.com/cuthbertLab/music21/master/music21/corpus/bach';

// ============================================================
// 最小 ZIP リーダ (.mxl 専用)
// ============================================================
//
// 設計: 中央ディレクトリ (Central Directory) 経由で読む。理由:
//   - .mxl は flag bit 3 (data descriptor follows) を使う実装が混じっており、
//     その場合 local file header の compressed/uncompressed size は 0
//   - サイズ情報は CD には必ず正しく入っている (これが ZIP の正規構造)
//   - 古い実装では local header だけ見ても足りない (bwv113.8.mxl で発覚)

interface ZipEntry {
  filename: string;
  data: Buffer;
}

/**
 * End of Central Directory Record (EOCD) を末尾から探す。
 * 22 〜 22+65535 バイト以内に PK\x05\x06 がある。
 */
function findEocd(buf: Buffer): number {
  const minOffset = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      return i;
    }
  }
  throw new Error('EOCD record not found — not a valid ZIP archive');
}

/**
 * ZIP archive を Buffer から読んで全 entry を返す。
 * .mxl は通常 deflate (method=8) または stored (method=0) のみ。
 */
function readZip(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    const sig = buf.readUInt32LE(p);
    if (sig !== 0x02014b50) {
      throw new Error(`Bad central directory signature at offset ${p}: ${sig.toString(16)}`);
    }
    // Central directory file header:
    //   0: sig (4), 4: version made by (2), 6: version needed (2), 8: flags (2),
    //   10: method (2), 12: mtime (2), 14: mdate (2), 16: crc (4),
    //   20: comp size (4), 24: uncomp size (4),
    //   28: name len (2), 30: extra len (2), 32: comment len (2),
    //   34: disk start (2), 36: internal attrs (2), 38: external attrs (4),
    //   42: local header offset (4), 46: name + extra + comment
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const filename = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    // local file header から data までの offset を計算
    // (local header の name/extra length は CD のものと違う場合があるので個別に読む)
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compData = buf.slice(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) {
      data = compData;
    } else if (method === 8) {
      data = inflateRawSync(compData);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for entry ${filename}`);
    }
    if (data.length !== uncompSize && uncompSize !== 0xffffffff) {
      throw new Error(
        `ZIP entry ${filename} size mismatch: expected ${uncompSize}, got ${data.length}`,
      );
    }

    entries.push({ filename, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== cdOffset + cdSize) {
    // 軽い不整合警告 — fatal にはしない
    // (一部 .mxl 実装で末尾 padding が入る場合がある)
  }

  return entries;
}

/**
 * .mxl Buffer を受け取って、内部の score MusicXML を取り出す。
 * META-INF/container.xml の `<rootfile full-path="..."/>` が指すファイルを返す。
 * fallback: META-INF 以外で末尾が .xml の最大ファイル。
 */
function extractScoreXml(mxlBuf: Buffer, sourceName: string): string {
  const entries = readZip(mxlBuf);
  if (entries.length === 0) {
    throw new Error(`${sourceName}: empty ZIP archive`);
  }

  const container = entries.find((e) => e.filename === 'META-INF/container.xml');
  if (container) {
    const containerXml = container.data.toString('utf8');
    const match = containerXml.match(/<rootfile[^>]*full-path="([^"]+)"/);
    if (match) {
      const target = match[1];
      const root = entries.find((e) => e.filename === target);
      if (root) {
        return root.data.toString('utf8');
      }
    }
  }

  // fallback: META-INF 以外で最大の .xml
  const candidates = entries
    .filter((e) => !e.filename.startsWith('META-INF/') && e.filename.endsWith('.xml'))
    .sort((a, b) => b.data.length - a.data.length);
  if (candidates.length === 0) {
    throw new Error(`${sourceName}: no .xml entry found in ZIP`);
  }
  return candidates[0]!.data.toString('utf8');
}

// ============================================================
// HTTP fetch (依存追加なし、組み込み fetch を使う)
// ============================================================

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'hide-lang Bach corpus fetcher' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

interface CorpusListEntry {
  name: string;
  download_url: string;
  size: number;
}

async function listBachFiles(): Promise<CorpusListEntry[]> {
  const res = await fetch(MUSIC21_API, {
    headers: {
      'User-Agent': 'hide-lang Bach corpus fetcher',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  }
  const data = (await res.json()) as Array<{
    name: string;
    type: string;
    download_url: string | null;
    size: number;
  }>;
  return data
    .filter((f) => f.type === 'file' && f.download_url !== null)
    .filter((f) => f.name.endsWith('.mxl') || f.name.endsWith('.xml'))
    .map((f) => ({ name: f.name, download_url: f.download_url!, size: f.size }));
}

// ============================================================
// メイン pipeline
// ============================================================

interface IndexRecord {
  basename: string;
  source: string;
  xmlBytes: number;
  hideBytes: number | null;
  diagnostics: number;
  diagnosticKinds: Record<string, number>;
  warnings: number;
  matrixIssues: number;
  matrixOk: boolean;
  error: string | null;
}

interface RunOptions {
  convertOnly: boolean;
}

async function fetchAndExtract(opts: RunOptions): Promise<string[]> {
  if (opts.convertOnly) {
    const files = readdirSync(XML_DIR).filter((f) => f.endsWith('.xml'));
    console.log(`[fetch] --convert-only: skipping download, using ${files.length} existing xml`);
    return files;
  }

  console.log('[fetch] listing music21/corpus/bach via GitHub API...');
  const list = await listBachFiles();
  console.log(`[fetch] found ${list.length} candidate files (.mxl + .xml)`);

  mkdirSync(XML_DIR, { recursive: true });

  const written: string[] = [];
  let n = 0;
  for (const entry of list) {
    n++;
    const basename = entry.name.replace(/\.(mxl|xml)$/, '');
    const xmlOut = join(XML_DIR, `${basename}.xml`);

    if (existsSync(xmlOut)) {
      written.push(`${basename}.xml`);
      continue;
    }

    try {
      const buf = await fetchBuffer(entry.download_url);
      let xml: string;
      if (entry.name.endsWith('.mxl')) {
        xml = extractScoreXml(buf, entry.name);
      } else {
        xml = buf.toString('utf8');
      }
      writeFileSync(xmlOut, xml, 'utf8');
      written.push(`${basename}.xml`);
      if (n % 25 === 0) {
        console.log(`[fetch] ${n}/${list.length} ${entry.name}`);
      }
    } catch (err) {
      console.error(`[fetch] FAIL ${entry.name}: ${(err as Error).message}`);
    }
  }
  console.log(`[fetch] vendored ${written.length} xml files`);
  return written;
}

function convertAll(xmlFiles: string[]): IndexRecord[] {
  mkdirSync(HIDE_DIR, { recursive: true });
  const records: IndexRecord[] = [];

  for (const xmlName of xmlFiles.sort()) {
    const basename = xmlName.replace(/\.xml$/, '');
    const xmlPath = join(XML_DIR, xmlName);
    const hidePath = join(HIDE_DIR, `${basename}.hide`);
    const xml = readFileSync(xmlPath, 'utf8');

    const rec: IndexRecord = {
      basename,
      source: xmlName,
      xmlBytes: xml.length,
      hideBytes: null,
      diagnostics: 0,
      diagnosticKinds: {},
      warnings: 0,
      matrixIssues: 0,
      matrixOk: false,
      error: null,
    };

    try {
      const result = musicXmlToHide(xml);
      rec.diagnostics = result.diagnostics.length;
      rec.warnings = result.warnings.length;
      for (const d of result.diagnostics) {
        rec.diagnosticKinds[d.kind] = (rec.diagnosticKinds[d.kind] ?? 0) + 1;
      }
      writeFileSync(hidePath, result.hideSource, 'utf8');
      rec.hideBytes = result.hideSource.length;

      // analyzeMatrix で再 parse できることを確認
      const matrix = analyzeMatrix(result.hideSource);
      rec.matrixIssues = matrix.issues.length;
      rec.matrixOk = true;
    } catch (err) {
      rec.error = (err as Error).message;
    }

    records.push(rec);
  }

  writeFileSync(INDEX_PATH, JSON.stringify(records, null, 2), 'utf8');
  return records;
}

function summarize(records: IndexRecord[]): void {
  const total = records.length;
  const matrixOk = records.filter((r) => r.matrixOk).length;
  const errors = records.filter((r) => r.error !== null).length;
  const withDiagnostics = records.filter((r) => r.diagnostics > 0).length;
  const totalDiagnostics = records.reduce((s, r) => s + r.diagnostics, 0);
  const allKinds: Record<string, number> = {};
  for (const r of records) {
    for (const [k, v] of Object.entries(r.diagnosticKinds)) {
      allKinds[k] = (allKinds[k] ?? 0) + v;
    }
  }
  console.log('');
  console.log(`[summary] total files       : ${total}`);
  console.log(`[summary] matrix parse OK   : ${matrixOk}/${total}`);
  console.log(`[summary] conversion errors : ${errors}`);
  console.log(`[summary] files w/ diagnost.: ${withDiagnostics}`);
  console.log(`[summary] total diagnostics : ${totalDiagnostics}`);
  console.log(`[summary] kinds             :`, allKinds);
  if (errors > 0) {
    console.log('');
    console.log('[errors] (first 10)');
    for (const r of records.filter((r) => r.error).slice(0, 10)) {
      console.log(`  ${r.basename}: ${r.error}`);
    }
  }
}

// ============================================================
// CLI entry
// ============================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opts: RunOptions = {
    convertOnly: args.includes('--convert-only'),
  };

  mkdirSync(CORPUS_DIR, { recursive: true });

  const xmlFiles = await fetchAndExtract(opts);
  if (xmlFiles.length === 0) {
    console.error('[fetch] no files to convert, aborting');
    process.exit(1);
  }

  console.log(`[convert] running musicXmlToHide on ${xmlFiles.length} files...`);
  const records = convertAll(xmlFiles);
  summarize(records);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
