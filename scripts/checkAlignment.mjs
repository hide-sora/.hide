import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const dir = 'C:/Users/lifes/.Claude/はもはも/public/samples/hide/band';
const files = readdirSync(dir).filter(f => f.endsWith('.hide'));

let allOk = true;
for (const file of files) {
  const content = readFileSync(join(dir, file), 'utf8');
  const lines = content.split('\n').filter(l => /^\[/.test(l));
  const counts = lines.map(l => {
    const label = l.match(/^\[([^\]]+)\]/)?.[1] || '?';
    const measures = l.split('|').length - 2; // first is label prefix, last is trailing
    return { label, measures };
  });
  const allSame = counts.every(c => c.measures === counts[0]?.measures);
  if (allSame) {
    console.log(`${file}: OK — ${counts.length} parts × ${counts[0]?.measures} measures`);
  } else {
    allOk = false;
    console.log(`${file}: MISALIGNED!`);
    for (const c of counts) {
      console.log(`  ${c.label}: ${c.measures} measures`);
    }
  }
}

console.log(allOk ? '\nAll files aligned!' : '\nSome files have alignment issues!');
