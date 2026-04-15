import { readFileSync } from 'fs';

const file = process.argv[2] || 'C:/Users/lifes/.Claude/はもはも/public/samples/hide/love-song.hide';
const content = readFileSync(file, 'utf8');
const lines = content.split('\n');
const divMatch = /DIV:(\d+)/.exec(lines[0]);
const div = divMatch ? parseInt(divMatch[1]) : 64;
const timeMatch = /TIME:(\d+)\/(\d+)/.exec(lines[0]);
const timeNum = timeMatch ? parseInt(timeMatch[1]) : 4;
const timeDen = timeMatch ? parseInt(timeMatch[2]) : 4;
const expected = Math.round((timeNum / timeDen) * div);

const unitMap = { g: 1, h: 2, i: 4, j: 8, k: 16, l: 32, m: 64, n: 128 };
function getUnits(ch) { return Math.round((unitMap[ch] * div) / 64); }

for (const line of lines) {
  const lm = /^\[([^\]]+)\]\|/.exec(line);
  if (!lm) continue;
  const label = lm[1];
  const cells = line.split('|').slice(1, -1);
  const issues = [];
  for (let mi = 0; mi < cells.length; mi++) {
    const cell = cells[mi].trim();
    let total = 0;
    // Tuplets: N(...) -> use N as total duration
    const tupRe = /(\d+)\([^)]*\)/g;
    let tm;
    while ((tm = tupRe.exec(cell)) !== null) {
      total += parseInt(tm[1]);
    }
    // Remove tuplets, grace notes, meta commands for remaining analysis
    let cleaned = cell;
    cleaned = cleaned.replace(/\d+\([^)]*\)/g, '');
    // Grace notes: backtick + note (no duration contribution)
    cleaned = cleaned.replace(/``[^\s,|]+/g, '');
    cleaned = cleaned.replace(/`[^\s,|]+/g, '');
    // Meta commands
    cleaned = cleaned.replace(/\[[^\]]*\]/g, '');
    // Lyrics
    cleaned = cleaned.replace(/'[^\s,|]*/g, '');
    // Find duration chars: letter [g-n] with optional dots
    const noteRe = /([g-n])(\.{0,3})/g;
    let nm;
    while ((nm = noteRe.exec(cleaned)) !== null) {
      let u = getUnits(nm[1]);
      const dots = nm[2].length;
      if (dots === 1) u = Math.round(u * 1.5);
      else if (dots === 2) u = Math.round(u * 1.75);
      else if (dots === 3) u = Math.round(u * 1.875);
      total += u;
    }
    if (total !== expected) {
      issues.push(`m${mi + 1}:${total}(${total > expected ? '+' : ''}${total - expected})`);
    }
  }
  if (issues.length) {
    console.log(`Part ${label}: ${issues.length} bad: ${issues.join(' ')}`);
  } else {
    console.log(`Part ${label}: all ${cells.length} measures = ${expected}u OK`);
  }
}
