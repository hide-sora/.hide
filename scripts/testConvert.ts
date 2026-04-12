/**
 * MusicXML → .hide 変換テスト
 * Usage: npx tsx scripts/testConvert.ts <file.musicxml|file.mxl>
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import JSZip from 'jszip';
import { musicXmlToHide, analyzeMatrix } from '../src/index.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: npx tsx scripts/testConvert.ts <file>');
  process.exit(1);
}

const absPath = resolve(filePath);
const buf = readFileSync(absPath);

let xmlStr: string;
if (absPath.endsWith('.mxl')) {
  const zip = await JSZip.loadAsync(buf);
  let xmlFile: JSZip.JSZipObject | null = null;
  const container = zip.file('META-INF/container.xml');
  if (container) {
    const containerXml = await container.async('string');
    const rootMatch = /full-path="([^"]+)"/.exec(containerXml);
    if (rootMatch) xmlFile = zip.file(rootMatch[1]);
  }
  if (!xmlFile) {
    const xmlFiles = zip.file(/\.xml$/i).filter(f => !f.name.includes('META-INF'));
    xmlFile = xmlFiles[0] ?? null;
  }
  if (!xmlFile) { console.error('MXL内にXMLなし'); process.exit(1); }
  xmlStr = await xmlFile.async('string');
} else {
  xmlStr = buf.toString('utf-8');
}

console.log(`\n=== ${absPath} ===`);
console.log(`XML: ${xmlStr.length} chars\n`);

const result = musicXmlToHide(xmlStr);
console.log('--- .hide (先頭2000文字) ---');
console.log(result.hideSource.substring(0, 2000));
if (result.hideSource.length > 2000) console.log(`\n... (計 ${result.hideSource.length} 文字)`);

console.log(`\nParts: ${result.partsCount}, Measures: ${result.measuresCount}`);
console.log(`Warnings: ${result.warnings.length}`);
const uniqueW = [...new Set(result.warnings.map(w => w.replace(/小節 \d+/g, '小節 N')))];
uniqueW.slice(0, 10).forEach(w => console.log(`  - ${w}`));

console.log(`\n--- Round-trip ---`);
const { matrix, issues } = analyzeMatrix(result.hideSource);
console.log(`Matrix: ${matrix.partLabels.join(',')} × ${matrix.measures.length} measures`);
console.log(`Issues: ${issues.length}`);
issues.slice(0, 10).forEach(iss => console.log(`  - ${JSON.stringify(iss)}`));
