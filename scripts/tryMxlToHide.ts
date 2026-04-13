import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { musicXmlToHide } from '../src/musicXmlToHide';

const xmlPath = process.argv[2];
if (!xmlPath) {
  console.error('Usage: npx tsx scripts/tryMxlToHide.ts <musicxml-path>');
  process.exit(1);
}

const resolved = resolve(xmlPath);
console.log(`[input] ${resolved}`);

const xml = readFileSync(resolved, 'utf8');
console.log(`[size] ${xml.length} chars`);

try {
  const result = musicXmlToHide(xml);
  console.log(`[keys] ${Object.keys(result)}`);
  console.log(`[header] ${result.header ? Object.keys(result.header) : 'none'}`);
  console.log(`[hideSource len] ${result.hideSource?.length ?? 0}`);
  console.log(`[parts] ${result.partsCount}`);
  console.log(`[measures] ${result.measuresCount}`);

  const outPath = resolved.replace(/\.(xml|musicxml)$/i, '.hide');
  writeFileSync(outPath, result.hideSource, 'utf8');
  console.log(`[output] ${outPath}`);

  const lines = result.hideSource.split('\n');
  console.log('\n--- .hide source (first 50 lines) ---');
  for (const l of lines.slice(0, 50)) console.log(l);
  if (lines.length > 50) console.log(`... (${lines.length - 50} more lines)`);
} catch (err) {
  console.error('[ERROR]', (err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
}
