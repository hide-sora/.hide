/**
 * reconvertBand.ts — 全バンドスコアXMLを .hide に再変換するスクリプト
 * Usage: npx tsx scripts/reconvertBand.ts
 */
import { readFileSync, writeFileSync, copyFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { musicXmlToHide } from '../src/musicXmlToHide';

const xmlDir = 'C:\\Users\\lifes\\.claude\\.hide\\corpus\\hamohamo\\xml';
const bandDir = 'C:\\Users\\lifes\\.Claude\\はもはも\\public\\samples\\hide\\band';
const rootDir = 'C:\\Users\\lifes\\.Claude\\はもはも\\public\\samples\\hide';

// キーワード → output .hide filename mapping
// readdirSync で全ファイルを取得し、キーワードで一致するXMLを見つける
const mapping: [string[], string][] = [
  [['115万2番抜き完成.xml'], '115man.hide'],
  [['カントリーロード'], 'country-road.hide'],
  [['Daft_Punk.xml'], 'daft-punk.hide'],
  [['The_Gospellers'], 'eien-ni-tomoni-gospellers.hide'],
  [['永遠にともに'], 'eien-ni-tomoni.hide'],
  [['フィクション2'], 'fiction.hide'],
  [['i_wish'], 'i-wish.hide'],
  [['キラキラ_aiko'], 'kirakira.hide'],
  [['ラブソング'], 'love-song.hide'],
  [['マイフレンド'], 'my-friend.hide'],
  [['niji.xml'], 'niji.hide'],
  [['さくら_修正版'], 'sakura-fix.hide'],
  [['さくら_2'], 'sakura.hide'],
  [['スパークル'], 'sparkle.hide'],
  [['とくべチュ'], 'tokubechu.hide'],
  [['わたがし'], 'watagashi.hide'],
  [['私は最強_Awesome!版'], 'watashi-wa-saikyo.hide'],
];

// ディレクトリ内の全XMLファイル名をキャッシュ
const allXmlFiles = readdirSync(xmlDir).filter(f => f.endsWith('.xml'));
console.log(`xmlDir: ${xmlDir}`);
console.log(`bandDir: ${bandDir}`);
console.log(`Found ${allXmlFiles.length} XML files\n`);

function findXmlFile(keywords: string[]): string {
  for (const kw of keywords) {
    const kwN = kw.normalize('NFC');
    // 完全一致
    const exact = allXmlFiles.find(f => f.normalize('NFC') === kwN);
    if (exact) return join(xmlDir, exact);
    // 部分一致
    const match = allXmlFiles.find(f => f.normalize('NFC').includes(kwN));
    if (match) return join(xmlDir, match);
  }
  throw new Error(`XML not found for keywords: ${keywords.join(', ')}`);
}

let success = 0;
let fail = 0;

for (const [keywords, hideName] of mapping) {
  process.stdout.write(`${hideName} ... `);
  try {
    const xmlPath = findXmlFile(keywords);
    const xml = readFileSync(xmlPath, 'utf8');
    const result = musicXmlToHide(xml);

    // band/ に書き出し
    writeFileSync(join(bandDir, hideName), result.hideSource);
    // root にもコピー
    copyFileSync(join(bandDir, hideName), join(rootDir, hideName));

    console.log(`OK (parts=${result.partsCount}, measures=${result.measuresCount}, warnings=${result.warnings.length})`);
    success++;
  } catch (err: any) {
    console.log(`FAIL: ${err.message}`);
    fail++;
  }
}

console.log(`\n=== Done: ${success} OK, ${fail} FAIL ===`);
