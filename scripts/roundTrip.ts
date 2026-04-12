import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileHide } from '../src/hideLoader';
import { musicXmlToHide } from '../src/musicXmlToHide';

const hidePath = process.argv[2];
if (!hidePath) {
  console.error('Usage: npx tsx scripts/roundTrip.ts <hide-file>');
  process.exit(1);
}

const resolved = resolve(hidePath);
console.log('[input]', resolved);

const source = readFileSync(resolved, 'utf8');
console.log('[original] length:', source.length);

const { musicXml, warnings: w1 } = compileHide(source);
console.log('[compile] MusicXML:', musicXml.length, 'chars, warnings:', w1.length);
if (w1.length > 0) console.log('  first:', w1[0]);

const { hideSource, warnings: w2, partsCount, measuresCount } = musicXmlToHide(musicXml);
console.log('[round-trip] .hide:', hideSource.length, 'chars, parts:', partsCount, 'measures:', measuresCount, 'warnings:', w2.length);

writeFileSync(resolved, hideSource, 'utf8');
console.log('[saved]', resolved);

const lines = hideSource.split('\n');
for (const l of lines.slice(0, 6)) console.log(l);
if (lines.length > 6) console.log(`... (${lines.length - 6} more lines)`);
