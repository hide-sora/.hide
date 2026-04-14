/**
 * pdfHideAudiveris.ts — Audiveris CLI wrapper
 *
 * PDF → Audiveris (batch OMR) → MusicXML テキスト
 *
 * 依存: Audiveris がシステムにインストールされていること
 *       https://github.com/Audiveris/audiveris/releases
 */

import { execFile, execSync } from 'node:child_process';
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

// promisify(execFile) のインライン実装 (node:util を避けてブラウザバンドルを安全にする)
function execFileAsync(
  file: string,
  args: readonly string[],
  options?: { timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args as string[], { maxBuffer: 50 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

// ============================================================
// 公開型
// ============================================================

export interface AudiverisOptions {
  /** Audiveris 実行ファイルのパス (省略時は自動検出) */
  audiverisPath?: string;
  /** 処理タイムアウト ms (default: 600000 = 10分) */
  timeout?: number;
  /** 進捗コールバック */
  onProgress?: (detail: string) => void;
}

export interface AudiverisResult {
  /** 抽出した MusicXML テキスト */
  musicXml: string;
  /** Audiveris の処理ログ */
  log: string;
}

// ============================================================
// 公開API
// ============================================================

/**
 * Audiveris CLI で PDF を MusicXML に変換する。
 *
 * @param pdfPath PDF ファイルの絶対パス
 * @param opts オプション
 */
export async function runAudiveris(
  pdfPath: string,
  opts: AudiverisOptions = {},
): Promise<AudiverisResult> {
  const audiveris = opts.audiverisPath ?? findAudiverisPath();
  const timeout = opts.timeout ?? 600_000;
  const progress = opts.onProgress ?? (() => {});

  const tmpDir = mkdtempSync(join(tmpdir(), 'hide-audiveris-'));

  try {
    progress('Audiveris で OMR 処理中...');

    const { stdout, stderr } = await execFileAsync(audiveris, [
      '-batch',
      '-transcribe',
      '-export',
      '-output', tmpDir,
      '--', pdfPath,
    ], { timeout, maxBuffer: 10 * 1024 * 1024 });

    const log = (stdout + '\n' + stderr).trim();
    progress('Audiveris 処理完了');

    // Find output: .mxl (default) or .xml
    const pdfBase = basename(pdfPath).replace(/\.pdf$/i, '');
    const musicXml = findAndReadMusicXml(tmpDir, pdfBase);

    return { musicXml, log };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================
// 内部: MusicXML ファイル検索・読み込み
// ============================================================

function findAndReadMusicXml(dir: string, pdfBase: string): string {
  // 1. Uncompressed .xml
  const xmlPath = join(dir, `${pdfBase}.xml`);
  if (existsSync(xmlPath)) {
    return readFileSync(xmlPath, 'utf8');
  }

  // 2. Compressed .mxl
  const mxlPath = join(dir, `${pdfBase}.mxl`);
  if (existsSync(mxlPath)) {
    return extractMxl(mxlPath, dir);
  }

  // 3. Fallback: any .mxl or .xml in directory
  const files = readdirSync(dir);
  const found = files.find(f => f.endsWith('.mxl') || f.endsWith('.xml'));
  if (found) {
    const p = join(dir, found);
    return found.endsWith('.mxl') ? extractMxl(p, dir) : readFileSync(p, 'utf8');
  }

  throw new Error(
    'Audiveris が MusicXML を出力しませんでした。\n' +
    `出力ディレクトリ: ${dir}\n` +
    `ファイル: ${files.join(', ')}`,
  );
}

/**
 * .mxl (ZIP 圧縮 MusicXML) から XML テキストを抽出する。
 */
function extractMxl(mxlPath: string, workDir: string): string {
  const extractDir = join(workDir, '_mxl_extract');

  // unzip (git bash / Linux / macOS) or PowerShell (Windows fallback)
  try {
    execSync(`unzip -o "${mxlPath}" -d "${extractDir}"`, { stdio: 'pipe' });
  } catch {
    try {
      execSync(
        `powershell.exe -Command "Expand-Archive -Path '${mxlPath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: 'pipe' },
      );
    } catch {
      throw new Error(
        'MXL の解凍に失敗しました。unzip または PowerShell が必要です。',
      );
    }
  }

  const xmlFile = findXmlInDir(extractDir);
  if (!xmlFile) {
    throw new Error(`MXL 内に MusicXML が見つかりませんでした: ${mxlPath}`);
  }
  return readFileSync(xmlFile, 'utf8');
}

function findXmlInDir(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = findXmlInDir(join(dir, entry.name));
      if (found) return found;
    } else if (entry.name.endsWith('.xml') && entry.name !== 'container.xml') {
      return join(dir, entry.name);
    }
  }
  return null;
}

// ============================================================
// 内部: Audiveris パス自動検出
// ============================================================

function findAudiverisPath(): string {
  const candidates = [
    'C:/Program Files/Audiveris/Audiveris.exe',
    'C:/Program Files (x86)/Audiveris/Audiveris.exe',
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // PATH から検索
  try {
    const result = execSync(
      process.platform === 'win32'
        ? 'where audiveris 2>NUL'
        : 'which audiveris 2>/dev/null',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (result) return result.split('\n')[0].trim();
  } catch { /* not on PATH */ }

  throw new Error(
    'Audiveris が見つかりません。\n' +
    'https://github.com/Audiveris/audiveris/releases からインストールするか、\n' +
    'opts.audiverisPath でパスを指定してください。',
  );
}
