/**
 * hideToVexflow.js — HideMatrix を VexFlow 5 で「行=パート × 列=小節」描画する
 *
 * test_hide.html / test_hide_mini.html 用の vanilla ES module。
 * public/ 配下にあるため Vite 静的配信でそのままブラウザに渡される
 * (Vite の transform は通らない)。
 *
 * VexFlow は esm.sh の ESM CDN から動的に取得する (hide-lang 本体に
 * vexflow を直接依存させないため)。
 *
 * ※ ロジックは hamoren の src/lib/hideRuntime/hideToVexflow.ts と同じ。
 *    container.clientWidth ベースで MIN_MEASURE_WIDTH=200px を確保する
 *    シンプルなレイアウト方式を採用する (Hamo Studio で動作実績あり)。
 */
import VexFlow from 'https://esm.sh/vexflow@5.0.0';

const {
  Renderer,
  Stave,
  StaveNote,
  StaveConnector,
  Voice,
  Formatter,
  Accidental,
  Articulation,
  StaveTie,
  Curve,
  Annotation,
  Dot,
} = VexFlow;

// ============================================================
// 描画パラメータ
// ============================================================

const LEFT_MARGIN = 16;
const TOP_MARGIN = 16;
const STAVE_HEIGHT = 90;          // 1 stave の縦幅 (notation + ledger lines)
const STAVE_VERTICAL_GAP = 20;    // パート間の隙間
const SYSTEM_VERTICAL_GAP = 36;   // 改段の隙間
const FIRST_MEASURE_EXTRA = 60;   // 最初の小節は clef/key/time の分だけ広く
const MIN_MEASURE_WIDTH = 200;    // 1 小節の最小幅 (note glyph がきちんと収まる)

// ============================================================
// 公開 API
// ============================================================

/**
 * HideMatrix を VexFlow で描画する。
 * container はあらかじめ空にしておくこと (この関数は冪等に再描画する)。
 *
 * @param {HTMLDivElement} container
 * @param {import('hide-lang').HideMatrix} matrix
 */
export function renderHideMatrix(container, matrix) {
  // 1. 既存内容を破棄
  container.innerHTML = '';

  if (matrix.partLabels.length === 0 || matrix.measures.length === 0) {
    const empty = document.createElement('div');
    empty.style.padding = '16px';
    empty.style.color = '#888';
    empty.style.fontFamily = 'system-ui, sans-serif';
    empty.textContent = '(空の matrix — パートか小節が 0 件)';
    container.appendChild(empty);
    return;
  }

  // 2. レイアウト計算
  // container が極端に狭い (test card のグリッド表示等) でも最低幅を確保する。
  const containerWidth = Math.max(container.clientWidth || 0, 320);
  const partCount = matrix.partLabels.length;
  const measureCount = matrix.measures.length;

  // 1段に何小節入るかを決める。
  const usableWidth = containerWidth - LEFT_MARGIN * 2;
  const measuresPerSystem = Math.max(
    1,
    Math.floor((usableWidth - FIRST_MEASURE_EXTRA) / MIN_MEASURE_WIDTH),
  );
  // 実際の小節幅は余りを均等に配分 (各小節を少し広めに)
  const measureWidth = Math.max(
    MIN_MEASURE_WIDTH,
    (usableWidth - FIRST_MEASURE_EXTRA) / measuresPerSystem,
  );

  const systemCount = Math.ceil(measureCount / measuresPerSystem);
  const systemHeight =
    partCount * STAVE_HEIGHT +
    Math.max(0, partCount - 1) * STAVE_VERTICAL_GAP +
    SYSTEM_VERTICAL_GAP;
  const totalHeight = TOP_MARGIN + systemCount * systemHeight + TOP_MARGIN;

  // 3. Renderer 初期化
  const renderer = new Renderer(container, Renderer.Backends.SVG);
  renderer.resize(containerWidth, totalHeight);
  const ctx = renderer.getContext();

  // 4. 各 system × part × measure を描画
  const partClefs = matrix.partLabels.map((label) => inferClefForPart(matrix, label));
  const timeSignature = `${matrix.header.timeNum}/${matrix.header.timeDen}`;
  const keySig = keySignatureForVexflow(matrix.header.keyFifths);

  // 全システム × 全パートの entries をパート別に集める。
  const partEntriesAllSystems = Array.from({ length: partCount }, () => []);

  for (let systemIdx = 0; systemIdx < systemCount; systemIdx++) {
    const systemStartMeasure = systemIdx * measuresPerSystem;
    const systemEndMeasure = Math.min(measureCount, systemStartMeasure + measuresPerSystem);
    const systemMeasureCount = systemEndMeasure - systemStartMeasure;
    const systemTopY = TOP_MARGIN + systemIdx * systemHeight;

    const firstStavesInSystem = [];

    for (let partIdx = 0; partIdx < partCount; partIdx++) {
      const partLabel = matrix.partLabels[partIdx];
      const partClef = partClefs[partIdx];
      const partTopY = systemTopY + partIdx * (STAVE_HEIGHT + STAVE_VERTICAL_GAP);

      let xCursor = LEFT_MARGIN;
      for (let m = 0; m < systemMeasureCount; m++) {
        const measureIdx = systemStartMeasure + m;
        const measure = matrix.measures[measureIdx];
        const cell = measure?.cells.get(partLabel);

        const isFirstInSystem = m === 0;
        const width = isFirstInSystem
          ? measureWidth + FIRST_MEASURE_EXTRA
          : measureWidth;

        const stave = new Stave(xCursor, partTopY, width);
        if (isFirstInSystem) {
          stave.addClef(partClef);
          if (keySig) stave.addKeySignature(keySig);
          if (systemIdx === 0) stave.addTimeSignature(timeSignature);
          firstStavesInSystem.push(stave);
        }
        stave.setContext(ctx).draw();

        if (cell) {
          const cellEntries = drawCellOnStave(
            ctx, stave, cell, matrix.header.div,
            matrix.header.timeNum, matrix.header.timeDen, partClef,
          );
          partEntriesAllSystems[partIdx].push(...cellEntries);
        }

        xCursor += width;
      }
    }

    // system 内の全パートを先頭で縦に繋ぐ (合唱/アカペラ用のブラケット + 左縦線)。
    if (firstStavesInSystem.length >= 2) {
      const topStave = firstStavesInSystem[0];
      const bottomStave = firstStavesInSystem[firstStavesInSystem.length - 1];
      try {
        new StaveConnector(topStave, bottomStave)
          .setType(StaveConnector.type.SINGLE_LEFT)
          .setContext(ctx)
          .draw();
        new StaveConnector(topStave, bottomStave)
          .setType(StaveConnector.type.BRACKET)
          .setContext(ctx)
          .draw();
      } catch (e) {
        console.warn('[hideToVexflow] connector draw failed', e);
      }
    }
  }

  // 全 stave/note を描画し終わった後、パートごとにタイ/スラーを描く
  for (let partIdx = 0; partIdx < partCount; partIdx++) {
    drawTiesAndSlurs(ctx, partEntriesAllSystems[partIdx]);
  }
}

// ============================================================
// パート別 clef 推定
// ============================================================

const STEP_TO_SEMITONE = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

const CLEF_RANGES = [
  // treble: 5 線 = E4-F5 (MIDI 64-77)
  { name: 'treble', min: 64, max: 77 },
  // bass: 5 線 = G2-A3 (MIDI 43-57)
  { name: 'bass', min: 43, max: 57 },
];

function pitchToMidi(p) {
  const semis = STEP_TO_SEMITONE[p.step] ?? 0;
  return (p.octave + 1) * 12 + semis + (p.alter ?? 0);
}

function inferClefForPart(matrix, partLabel) {
  const midis = [];
  for (const measure of matrix.measures) {
    const cell = measure.cells.get(partLabel);
    if (!cell) continue;
    for (const tok of flattenTokens(cell.body)) {
      if (tok.kind !== 'note') continue;
      for (const p of tok.pitches) midis.push(pitchToMidi(p));
    }
  }
  if (midis.length === 0) return 'treble';

  let bestClef = 'treble';
  let bestScore = Infinity;
  for (const range of CLEF_RANGES) {
    let score = 0;
    for (const m of midis) {
      if (m < range.min) score += range.min - m;
      else if (m > range.max) score += m - range.max;
    }
    if (score < bestScore) {
      bestScore = score;
      bestClef = range.name;
    }
  }
  return bestClef;
}

// ============================================================
// 1 セルを Stave に描く
// ============================================================

function drawCellOnStave(ctx, stave, cell, div, timeNum, timeDen, clef) {
  const flatTokens = flattenTokens(cell.body);
  if (flatTokens.length === 0) return [];

  const entries = [];
  for (const tok of flatTokens) {
    const sn = tokenToStaveNote(tok, div, clef);
    if (sn) entries.push({ token: tok, staveNote: sn });
  }
  if (entries.length === 0) return [];

  const notes = entries.map((e) => e.staveNote);

  const voice = new Voice({ numBeats: timeNum, beatValue: timeDen });
  voice.setMode(Voice.Mode.SOFT);
  voice.addTickables(notes);

  const formatter = new Formatter();
  formatter.joinVoices([voice]);
  // stave 内の note 描画領域 (clef/key/time prefix を引いた幅) を使う。
  // ぴったりだと最後の音が右端を超えやすいので少し詰める。
  const noteAreaWidth = stave.getNoteEndX() - stave.getNoteStartX();
  const innerWidth = Math.max(40, noteAreaWidth - 20);
  formatter.format([voice], innerWidth);
  voice.draw(ctx, stave);

  return entries;
}

// ============================================================
// タイ・スラー描画
// ============================================================

function drawTiesAndSlurs(ctx, entries) {
  // 第 1 パス: タイ
  for (let i = 0; i < entries.length - 1; i++) {
    if (!entries[i].token.tieToNext) continue;
    const a = entries[i].staveNote;
    const b = entries[i + 1].staveNote;
    const staveA = a.getStave();
    const staveB = b.getStave();
    const sameRow = staveA && staveB && staveA.getY() === staveB.getY();
    try {
      if (sameRow) {
        const tie = new StaveTie({
          firstNote: a,
          lastNote: b,
          firstIndexes: [0],
          lastIndexes: [0],
        });
        tie.setContext(ctx).draw();
      } else if (staveA && staveB) {
        drawHalfTie(ctx, a, 'right', staveA);
        drawHalfTie(ctx, b, 'left', staveB);
      }
    } catch (e) {
      console.warn('[hideToVexflow] tie draw failed', e);
    }
  }

  // 第 2 パス: スラー
  for (let i = 0; i < entries.length - 1; i++) {
    const cur = entries[i].token;
    if (cur.kind !== 'note' || !cur.slurStart) continue;
    let j = i + 1;
    while (j < entries.length && entries[j].token.kind !== 'note') j++;
    if (j >= entries.length) continue;
    try {
      const curve = new Curve(entries[i].staveNote, entries[j].staveNote, {});
      curve.setContext(ctx).draw();
    } catch (e) {
      console.warn('[hideToVexflow] slur draw failed', e);
    }
  }
}

function drawHalfTie(ctx, note, side, stave) {
  const noteX = note.getAbsoluteX();
  const stemExtents = note.getStemExtents?.() ?? { baseY: stave.getYForLine(2), topY: stave.getYForLine(2) };
  const stemDir = note.getStemDirection?.() ?? 1;
  const baseY = stemExtents.baseY;
  const tieY = baseY + (stemDir === 1 ? 6 : -6);
  const curveDir = stemDir === 1 ? 1 : -1;

  const NOTE_HEAD_WIDTH = 11;
  const MAX_HALF_TIE = 28;

  let xStart;
  let xEnd;
  if (side === 'right') {
    xStart = noteX + NOTE_HEAD_WIDTH;
    const staveRight = stave.getX() + stave.getWidth() - 2;
    xEnd = Math.min(xStart + MAX_HALF_TIE, staveRight);
  } else {
    xEnd = noteX;
    const staveLeft = stave.getNoteStartX();
    xStart = Math.max(xEnd - MAX_HALF_TIE, staveLeft);
  }
  if (xEnd - xStart < 6) return;

  const midX = (xStart + xEnd) / 2;
  const arcAmp = 8 * curveDir;
  const thickness = 4 * curveDir;
  const cp1Y = tieY + arcAmp;
  const cp2Y = tieY + arcAmp + thickness;

  ctx.beginPath();
  ctx.moveTo(xStart, tieY);
  ctx.quadraticCurveTo(midX, cp1Y, xEnd, tieY);
  ctx.quadraticCurveTo(midX, cp2Y, xStart, tieY);
  ctx.closePath();
  ctx.fill();
}

// ============================================================
// HideToken 階層をフラット化
// ============================================================

function flattenTokens(tokens) {
  const out = [];
  for (const t of tokens) {
    switch (t.kind) {
      case 'note':
      case 'rest':
        out.push(t);
        break;
      case 'repeat':
        for (let i = 0; i < t.count; i++) {
          out.push(...flattenTokens(t.body));
        }
        break;
      case 'tuplet':
        for (const m of t.members) out.push(m);
        break;
      case 'meta':
      case 'measureBarrier':
        break;
    }
  }
  return out;
}

// ============================================================
// HideNoteToken / HideRestToken → VexFlow StaveNote
// ============================================================

function tokenToStaveNote(tok, div, clef) {
  const durStr = unitsToVexDuration(tok.durationUnits, div);
  if (!durStr) return null;

  if (tok.kind === 'rest') {
    const restNote = new StaveNote({ keys: ['b/4'], duration: `${durStr}r`, clef });
    if (tok.staccato) {
      restNote.addModifier(new Articulation('a.').setPosition(3), 0);
    }
    return restNote;
  }

  if (tok.pitches.length === 0) return null;

  const keys = tok.pitches.map(pitchToVexKey);
  const note = new StaveNote({ keys, duration: durStr, clef });

  tok.pitches.forEach((p, idx) => {
    if (p.alter === 1) note.addModifier(new Accidental('#'), idx);
    else if (p.alter === -1) note.addModifier(new Accidental('b'), idx);
    else if (p.accidentalExplicit) note.addModifier(new Accidental('n'), idx);
  });

  if (tok.staccato) {
    note.addModifier(new Articulation('a.').setPosition(3), 0);
  }

  if (tok.lyric) {
    const ann = new Annotation(tok.lyric)
      .setVerticalJustification(Annotation.VerticalJustify.BOTTOM);
    note.addModifier(ann, 0);
  }

  return note;
}

function pitchToVexKey(p) {
  return `${p.step.toLowerCase()}/${p.octave}`;
}

function unitsToVexDuration(units, div) {
  if (units <= 0 || div <= 0) return null;

  // .hide duration units scale: base values h=1..m=32 at DIV=32,
  // actual units = base * div / 32. So quarter note = div/4 units.
  // Multiply by 32 so all comparisons stay integer.
  const u = units * 32;
  const levels = [
    [div * 32, 'w'],   // whole   = 4 × div
    [div * 16, 'h'],   // half    = 2 × div
    [div * 8,  'q'],   // quarter = 1 × div
    [div * 4,  '8'],   // 8th     = div / 2
    [div * 2,  '16'],  // 16th    = div / 4
    [div * 1,  '32'],  // 32nd    = div / 8
  ];

  for (const [base, vex] of levels) {
    if (u === base)           return vex;
    if (u * 2 === base * 3)   return vex + 'd';    // dotted   = 1.5×
    if (u * 4 === base * 7)   return vex + 'dd';   // double-dotted = 1.75×
  }

  // Fallback: largest base that fits
  for (const [base, vex] of levels) {
    if (u >= base) return vex;
  }
  return '32';
}

// ============================================================
// keyFifths → VexFlow key signature
// ============================================================

const KEY_SIG_BY_FIFTHS = {
  [-7]: 'Cb',
  [-6]: 'Gb',
  [-5]: 'Db',
  [-4]: 'Ab',
  [-3]: 'Eb',
  [-2]: 'Bb',
  [-1]: 'F',
  [0]: 'C',
  [1]: 'G',
  [2]: 'D',
  [3]: 'A',
  [4]: 'E',
  [5]: 'B',
  [6]: 'F#',
  [7]: 'C#',
};

function keySignatureForVexflow(fifths) {
  return KEY_SIG_BY_FIFTHS[fifths] ?? null;
}
