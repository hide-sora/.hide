import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import JSZip from 'jszip';
import { musicXmlToHide } from '../src/index.js';

const filePath = process.argv[2];
const outPath = process.argv[3] || '/tmp/hide_output.txt';
const buf = readFileSync(resolve(filePath));
let xmlStr: string;
if (filePath.endsWith('.mxl')) {
  const zip = await JSZip.loadAsync(buf);
  const xmlFiles = zip.file(/\.xml$/i).filter(f => !f.name.includes('META-INF'));
  xmlStr = await xmlFiles[0].async('string');
} else {
  xmlStr = buf.toString('utf-8');
}
const result = musicXmlToHide(xmlStr);
writeFileSync(outPath, result.hideSource);
console.log(`Written ${result.hideSource.length} chars to ${outPath}`);
const lines = result.hideSource.split('\n');
console.log(`Lines: ${lines.length}`);
for (const l of lines) {
  console.log(l.substring(0, 80));
}
