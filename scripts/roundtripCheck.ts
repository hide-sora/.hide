/**
 * roundtripCheck.ts — .hide → expand → MusicXML して measure 7 を確認
 */
import { readFileSync } from 'node:fs';
import { compileHide } from '../src/hideLoader';

const hidePath = 'C:\\Users\\lifes\\.Claude\\はもはも\\public\\samples\\hide\\band\\tokubechu.hide';
const hideSource = readFileSync(hidePath, 'utf8');

const result = compileHide(hideSource);
const xml = result.musicXml;
console.log(`Compiled: parts=${result.partsCount}, measures=${result.measuresCount}, warnings=${result.warnings.length}`);
if (result.warnings.length) {
  for (const w of result.warnings) console.log('  WARN: ' + w);
}

// Extract each part's measure 7
const parts = xml.split(/<part /);
for (let pi = 1; pi < parts.length; pi++) {
  const idMatch = parts[pi].match(/id="([^"]+)"/);
  const partId = idMatch ? idMatch[1] : '?';
  const measures = parts[pi].split(/<measure /);
  for (let mi = 1; mi < measures.length; mi++) {
    const mNum = measures[mi].match(/number="(\d+)"/)?.[1];
    if (mNum === '6' || mNum === '7') {
      const noteRe = /<note[\s\S]*?<\/note>/g;
      let nm;
      let seqDur = 0;
      let noteCount = 0;
      let hasGrace = false;
      while ((nm = noteRe.exec(measures[mi])) !== null) {
        const isChord = nm[0].includes('<chord/>');
        const isGrace = nm[0].includes('<grace');
        const dur = nm[0].match(/<duration>(\d+)/)?.[1];
        if (isGrace) hasGrace = true;
        if (!isChord && !isGrace && dur) seqDur += parseInt(dur);
        noteCount++;
      }
      console.log(`Part ${partId} m${mNum}: notes=${noteCount} seqDur=${seqDur} grace=${hasGrace}`);
    }
  }
}

// Also show the raw MusicXML for Part 2 measure 7 (the whole note)
const p2 = parts[2]; // second part
if (p2) {
  const measures = p2.split(/<measure /);
  for (let mi = 1; mi < measures.length; mi++) {
    const mNum = measures[mi].match(/number="(\d+)"/)?.[1];
    if (mNum === '7') {
      console.log('\n=== Part 2 Measure 7 raw MusicXML ===');
      console.log('<measure ' + measures[mi].substring(0, 800));
    }
  }
}
