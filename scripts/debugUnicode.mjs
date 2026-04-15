import { readdirSync } from 'fs';

const dir = 'C:/Users/lifes/.claude/.hide/corpus/hamohamo/xml';
const files = readdirSync(dir).filter(f => f.endsWith('.xml'));

const keywords = ['ラブソング','マイフレンド','スパークル','とくべチュ','わたがし'];
for (const kw of keywords) {
  const matches = files.filter(f => f.includes(kw));
  console.log(`${kw}: ${matches.length} matches`);
  if (matches.length === 0) {
    // NFC/NFD normalize both sides
    const kwNFC = kw.normalize('NFC');
    const kwNFD = kw.normalize('NFD');
    for (const f of files) {
      const fNFC = f.normalize('NFC');
      if (fNFC.includes(kwNFC)) {
        console.log(`  NFC match: ${f}`);
      }
      if (f.normalize('NFD').includes(kwNFD)) {
        console.log(`  NFD match: ${f}`);
      }
    }
  }
}
