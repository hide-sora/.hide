/**
 * convertPbScores.ts — PocketBase の scores コレクションから
 * 全 MusicXML ファイルをダウンロードし .hide に変換するバッチスクリプト。
 *
 * Usage: npx tsx scripts/convertPbScores.ts [--out <dir>]
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { musicXmlToHide } from '../src/musicXmlToHide';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PB_URL = process.env.PB_URL || 'https://hamoren.com/pb';
const PB_EMAIL = process.env.PB_ADMIN_EMAIL || '';
const PB_PASSWORD = process.env.PB_ADMIN_PASSWORD || '';

if (!PB_EMAIL || !PB_PASSWORD) {
  console.error('Set PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD environment variables');
  process.exit(1);
}

const outDir = process.argv.includes('--out')
  ? resolve(process.argv[process.argv.indexOf('--out') + 1])
  : resolve(__dirname, '..', 'corpus', 'hamohamo');

async function main() {
  // 出力ディレクトリ作成
  const xmlDir = join(outDir, 'xml');
  const hideDir = join(outDir, 'hide');
  mkdirSync(xmlDir, { recursive: true });
  mkdirSync(hideDir, { recursive: true });

  // 1. PocketBase 認証
  console.log('[auth] Authenticating...');
  const authRes = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: PB_EMAIL, password: PB_PASSWORD }),
  });
  const authData = await authRes.json() as { token: string };
  const token = authData.token;
  console.log('[auth] OK');

  // 2. 全スコア取得 (ページネーション対応)
  let page = 1;
  const allItems: any[] = [];
  while (true) {
    const res = await fetch(
      `${PB_URL}/api/collections/scores/records?perPage=200&page=${page}`,
      { headers: { Authorization: token } },
    );
    const data = await res.json() as { items: any[]; totalPages: number };
    allItems.push(...data.items);
    if (page >= data.totalPages) break;
    page++;
  }
  console.log(`[scores] ${allItems.length} total records`);

  // 3. MusicXML ファイルだけフィルタ (.mxl, .musicxml, .xml)
  const musicXmlItems = allItems.filter(
    (i) => i.file && /\.(mxl|musicxml|xml)$/i.test(i.file),
  );
  console.log(`[filter] ${musicXmlItems.length} MusicXML files`);

  // 重複除去: 同じタイトルのものは最新のみ残す
  const byTitle = new Map<string, any>();
  for (const item of musicXmlItems) {
    const key = (item.title || '').trim().toLowerCase();
    const existing = byTitle.get(key);
    if (!existing || item.updated > existing.updated) {
      byTitle.set(key, item);
    }
  }
  const unique = [...byTitle.values()];
  console.log(`[unique] ${unique.length} unique titles (from ${musicXmlItems.length})`);

  // 4. ダウンロード＆変換
  let success = 0;
  let fail = 0;
  const errors: Array<{ title: string; error: string }> = [];

  for (let idx = 0; idx < unique.length; idx++) {
    const item = unique[idx];
    const title = item.title || 'untitled';
    const safeTitle = sanitize(title);
    const ext = item.file.match(/\.(mxl|musicxml|xml)$/i)?.[0] || '.xml';
    const fileUrl = `${PB_URL}/api/files/${item.collectionId}/${item.id}/${item.file}`;

    process.stdout.write(`[${idx + 1}/${unique.length}] ${title}... `);

    try {
      // ダウンロード
      const fileRes = await fetch(fileUrl, { headers: { Authorization: token } });
      if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);
      const buf = Buffer.from(await fileRes.arrayBuffer());

      // XML 文字列を取得 (.mxl は ZIP なので解凍)
      let xmlStr: string;
      if (ext === '.mxl') {
        xmlStr = extractXmlFromMxl(buf, xmlDir, safeTitle);
      } else {
        xmlStr = buf.toString('utf8');
        writeFileSync(join(xmlDir, `${safeTitle}.xml`), xmlStr);
      }

      // 変換
      const result = musicXmlToHide(xmlStr);
      const hidePath = join(hideDir, `${safeTitle}.hide`);
      writeFileSync(hidePath, result.hideSource);

      console.log(
        `OK (parts=${result.partsCount}, measures=${result.measuresCount}, ` +
        `warnings=${result.warnings.length})`,
      );
      success++;
    } catch (err: any) {
      console.log(`FAIL: ${err.message}`);
      errors.push({ title, error: err.message });
      fail++;
    }
  }

  // サマリー
  console.log('\n=============================');
  console.log(`[done] ${success} success, ${fail} fail`);
  console.log(`[output] ${hideDir}`);
  if (errors.length > 0) {
    console.log('\n[errors]');
    errors.forEach((e) => console.log(`  - ${e.title}: ${e.error}`));
  }
}

/** .mxl (ZIP) から XML を抽出 */
function extractXmlFromMxl(buf: Buffer, xmlDir: string, safeTitle: string): string {
  // Node.js で ZIP を解凍 (zlib ベースの簡易 unzip)
  const tmpMxl = join(xmlDir, `${safeTitle}.mxl`);
  writeFileSync(tmpMxl, buf);

  // unzip コマンドで XML を抽出
  const tmpDir = join(xmlDir, `_tmp_${safeTitle}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    execSync(`unzip -o -q "${tmpMxl}" -d "${tmpDir}"`, { stdio: 'pipe' });
  } catch {
    // unzip が失敗した場合は PowerShell で試す
    execSync(
      `powershell -Command "Expand-Archive -Path '${tmpMxl}' -DestinationPath '${tmpDir}' -Force"`,
      { stdio: 'pipe' },
    );
  }

  // META-INF/container.xml から rootfile を読む、なければ *.xml を探す
  let xmlFile: string | undefined;

  const containerPath = join(tmpDir, 'META-INF', 'container.xml');
  if (existsSync(containerPath)) {
    const container = readFileSync(containerPath, 'utf8');
    const rootMatch = /full-path="([^"]+)"/.exec(container);
    if (rootMatch) xmlFile = join(tmpDir, rootMatch[1]);
  }

  if (!xmlFile || !existsSync(xmlFile)) {
    // フォールバック: .xml ファイルを探す (META-INF 以外)
    const findXml = (dir: string): string | undefined => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory() && f.name !== 'META-INF') {
          const found = findXml(join(dir, f.name));
          if (found) return found;
        }
        if (f.isFile() && f.name.endsWith('.xml') && f.name !== 'container.xml') {
          return join(dir, f.name);
        }
      }
      return undefined;
    };
    xmlFile = findXml(tmpDir);
  }

  if (!xmlFile || !existsSync(xmlFile)) {
    throw new Error('No XML found in .mxl archive');
  }

  const xmlStr = readFileSync(xmlFile, 'utf8');
  const outXml = join(xmlDir, `${safeTitle}.xml`);
  writeFileSync(outXml, xmlStr);

  // 一時ファイル削除
  rmSync(tmpDir, { recursive: true, force: true });

  return xmlStr;
}

/** ファイル名をサニタイズ */
function sanitize(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 100);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
