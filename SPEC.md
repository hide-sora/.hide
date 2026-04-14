# .hide v2.1 Specification

**Version:** 2.1 (v2.0 + Finale Broadway 全グリフ対応)
**Date:** 2026-04-14
**Author:** hide-sora

---

## 1. Design Principles

1. **Elements on the staff** (attached to notes) → token suffixes/prefixes
2. **Elements off the staff** (dynamics, tempo, rehearsal, etc.) → `[...]` meta commands
3. **Header fully optional** (extreme defaults)
4. **LLM token density first**

---

## 2. Lexical Structure

- Whitespace, line breaks → ignored
- `|` → cell separator (matrix mode), whitespace
- `;` → line comment (to end of line)
- `/* ... */` → block comment

---

## 3. Pitch Syntax

### 3.1 Note Token Structure

```
[letter][accidental?][octave][notehead?][duration][dots?][articulations?][ornaments?]
```

### 3.1.1 Notehead Variants (v2.1)

`!` + 1文字でノートヘッド変形を指定 (octave と duration の間):

| 構文 | 意味 | 用途 |
|------|------|------|
| `!d` | Diamond | Natural harmonics |
| `!x` | X | Ghost note / dead note |
| `!/` | Slash | Rhythm notation |
| `!t` | Triangle | 特殊パーカッション |

```
C4!dk         ; diamond notehead, quarter
C4E4G4!xk     ; X notehead chord
C4!/l         ; slash notehead, half note
```

### 3.2 Note Name

`A` `B` `C` `D` `E` `F` `G` (uppercase)

Lowercase first letter = **slur start**: `c4k` starts a slur on C4.

### 3.3 Octave

`0`-`9` (scientific pitch notation; C4 = middle C)

### 3.4 Accidentals (Part of Pitch)

Accidentals define the **pitch itself**, not a display marking.

| Symbol | Meaning | Semitone offset |
|--------|---------|-----------------|
| `#` | Sharp | +1 |
| `b` | Flat | -1 |
| `*` | Natural | reset to 0 |
| `x` | Double sharp | +2 |
| `bb` | Double flat | -2 |

**Two-stage stacking:** Accidentals may appear both before and after the octave digit.

```
C#4k      ; C-sharp 4, quarter note
Cb4k      ; C-flat 4, quarter note
C#4#k     ; C-double-sharp 4 (enharmonic D4), quarter note
C#4*k     ; C-natural 4 (sharp cancelled by natural), quarter note
Cx4k      ; C-double-sharp 4, quarter note
Cbb4k     ; C-double-flat 4, quarter note
```

**No Rule B:** Every note specifies its absolute pitch explicitly. Accidental display on the score is determined automatically by the renderer based on key signature context.

### 3.5 Duration (Length Alphabet)

Eight consecutive ASCII letters, each doubling the previous:

| Letter | Note value | Units (DIV=64) |
|--------|-----------|-----------------|
| `g` | 64th note | 1 |
| `h` | 32nd note | 2 |
| `i` | 16th note | 4 |
| `j` | 8th note | 8 |
| `k` | quarter note | 16 |
| `l` | half note | 32 |
| `m` | whole note | 64 |
| `n` | double whole (breve) | 128 |

Duration letters are **case-insensitive** for the note value itself. Case is no longer used for staccato.

### 3.6 Dots (Augmentation)

| Syntax | Multiplier | Example |
|--------|-----------|---------|
| `.` | ×1.5 | `C4k.` = dotted quarter |
| `..` | ×1.75 | `C4k..` = double-dotted quarter |
| `...` | ×1.875 | `C4k...` = triple-dotted quarter |

### 3.7 Chords

Multiple pitches concatenated, terminated by a single shared duration:

```
C4E4G4k       ; C major chord, quarter note
C#4E4G#4k     ; C# major chord, quarter note
c4e4g4k       ; C major chord with slur start
```

### 3.8 Rests

```
Rk            ; quarter rest
Rg            ; 64th rest
Rn            ; double-whole rest
Rk.           ; dotted quarter rest
```

---

## 4. Tie

`+` after a note ties it to the following note of the same pitch:

```
C4l+C4k       ; half C tied to quarter C
```

---

## 5. Slur

- **Slur start:** lowercase first pitch letter (`c4k`)
- **Slur end:** `_` suffix after duration/articulations (`k_`)

```
c4k D4k E4k_     ; slur from C4 through E4
```

---

## 6. Articulations (Suffixes)

Applied after duration letter (and dots). Multiple may be stacked.

### 6.1 Basic Articulations

| Suffix | Meaning | Example |
|--------|---------|---------|
| `s` | Staccato | `C4ks` |
| `S` | Staccatissimo | `C4kS` |
| `>` | Accent | `C4k>` |
| `^` | Marcato | `C4k^` |
| `-` | Tenuto | `C4k-` |
| `~` | Fermata | `C4k~` |
| `~s` | Short fermata (angular) | `C4k~s` |
| `~l` | Long fermata (square) | `C4k~l` |

### 6.2 Bowing & Techniques (v2.1)

| Suffix | Meaning | Example |
|--------|---------|---------|
| `V` | Up-bow (∨) | `C4kV` |
| `W` | Down-bow (∏) | `C4kW` |
| `O` | Harmonic (○) | `C4kO` |
| `X` | Snap pizzicato (Bartók) | `C4kX` |
| `T` | Stopped / mute (+) | `C4kT` |

**Combinations:**
```
C4ks-         ; louré (staccato + tenuto)
C4k>s         ; accent + staccato
C4k>-         ; accent + tenuto
C4kVs         ; up-bow + staccato
```

---

## 7. Ornaments (2-character Suffixes)

Applied after articulations.

### 7.1 Standard Ornaments

| Suffix | Meaning | Example |
|--------|---------|---------|
| `tr` | Trill | `C4ktr` |
| `mr` | Mordent (lower) | `C4kmr` |
| `MR` | Inverted mordent (upper) | `C4kMR` |
| `tn` | Turn | `C4ktn` |
| `TN` | Inverted turn | `C4kTN` |
| `z1` | Tremolo 1-stroke (8th subdivision) | `C4kz1` |
| `z2` | Tremolo 2-stroke (16th subdivision) | `C4kz2` |
| `z3` | Tremolo 3-stroke (32nd subdivision) | `C4kz3` |
| `ar` | Arpeggio | `C4E4G4kar` |
| `gl` | Glissando | `C4kgl` |
| `vb` | Vibrato | `C4kvb` |
| `bn` | Bend (guitar) | `C4kbn` |

### 7.2 Jazz Articulations (v2.1)

| Suffix | Meaning | Example |
|--------|---------|---------|
| `jf` | Fall (下降線) | `C4kjf` |
| `jd` | Doit (上昇線) | `C4kjd` |
| `jp` | Plop (上から落下) | `C4kjp` |
| `js` | Scoop (下からすくい上げ) | `C4kjs` |

---

## 8. Grace Notes (Prefix)

Backtick `` ` `` prefix:

```
`C4k D4k      ; appoggiatura C before D
``C4k D4k     ; acciaccatura C before D
```

---

## 9. Meta Commands `[...]`

All elements "off the staff" use bracket meta command syntax.

### 9.1 Dynamics `[D...]`

**Point dynamics:**
`[Dpppp]` `[Dppp]` `[Dpp]` `[Dp]` `[Dmp]` `[Dmf]` `[Df]` `[Dff]` `[Dfff]` `[Dffff]`
`[Dfp]` `[Dfz]` `[Dsf]` `[Dsfz]` `[Dsffz]` `[Dsfp]` `[Dsfpp]` `[Drfz]` `[Drf]`

**Hairpins:**
- `[D<]` = crescendo start
- `[D>]` = diminuendo start
- `[D/]` = hairpin end (wedge stop)

### 9.2 Tempo `[T...]`

```
[T120]          ; set tempo to 120 BPM
[T:Allegro]     ; tempo text "Allegro"
[T:Andante]     ; tempo text "Andante"
[T:rit]         ; ritardando
[T:accel]       ; accelerando
[T:atempo]      ; a tempo
```

### 9.3 Time Signature `[M...]`

```
[M3/4]          ; 3/4 time
[M6/8]          ; 6/8 time
```

### 9.4 Key Signature `[K...]`

```
[KC]            ; C major
[KCm]           ; C minor
[KBb]           ; B-flat major
[KF#m]          ; F-sharp minor
```

### 9.5 Transposition `[K+n]` / `[K-n]`

```
[K+2]           ; transpose up 2 semitones
[K-3]           ; transpose down 3 semitones
```

### 9.6 Clef

| Syntax | Clef |
|--------|------|
| `[T]` | Treble |
| `[T8]` | Treble 8va alta |
| `[T-8]` | Treble 8va bassa |
| `[B]` | Bass |
| `[A]` | Alto |
| `[Te]` | Tenor |
| `[Pe]` | Percussion |
| `[So]` | Soprano |
| `[Br]` | Baritone |

### 9.7 Part Switch

```
[1]             ; switch to Voice 1
[2]             ; switch to Voice 2
[P]             ; switch to Voice Percussion
[1:Piano]       ; switch to Part 1, instrument name "Piano"
[2:Guitar]      ; switch to Part 2, instrument name "Guitar"
```

Part + clef combinations:
```
[1T]            ; Voice 1 + Treble clef
[2B]            ; Voice 2 + Bass clef
[3T-8]          ; Voice 3 + Treble 8vb
```

### 9.8 Volta

```
[V1]            ; first ending
[V2]            ; second ending
```

### 9.9 Navigation

```
[segno]         ; Segno sign
[segno2]        ; Segno variant (serpent)
[coda]          ; Coda sign
[coda2]         ; Coda variant (square)
[DC]            ; Da Capo
[DC.fine]       ; D.C. al Fine
[DC.coda]       ; D.C. al Coda
[DS]            ; Dal Segno
[DS.fine]       ; D.S. al Fine
[DS.coda]       ; D.S. al Coda
[fine]          ; Fine
[tocoda]        ; To Coda
[%]             ; Measure repeat
```

### 9.10 Rehearsal Marks

```
[R:A]           ; Rehearsal mark "A"
[R:B]           ; Rehearsal mark "B"
[R:1]           ; Rehearsal mark "1"
```

### 9.11 Text

```
[text:pizz.]    ; Staff text "pizz."
[text:arco]     ; Staff text "arco"
[expr:dolce]    ; Expression text "dolce"
[expr:espressivo] ; Expression text "espressivo"
```

### 9.12 Breath & Pause

```
[breath]        ; Breath mark
[caesura]        ; Caesura
```

### 9.13 Ottava Lines

```
[8va]           ; 8va alta start
[8vb]           ; 8va bassa start
[15ma]          ; 15ma alta start
[15mb]          ; 15ma bassa start
[8va/]          ; 8va end
[8vb/]          ; 8vb end
[15ma/]         ; 15ma end
[15mb/]         ; 15mb end
```

### 9.14 Pedal

```
[ped]           ; Pedal down
[ped/]          ; Pedal up
```

### 9.15 Chord Symbols

```
[C:Cmaj7]      ; Cmaj7
[C:Am7]        ; Am7
[C:G7/B]       ; G7/B (slash chord)
[C:Bdim]       ; Bdim
```

### 9.16 Fingering (v2.1)

```
[F:1]           ; 指番号 1
[F:3]           ; 指番号 3
[F:p]           ; 親指 (thumb)
```

### 9.17 String Number (v2.1)

```
[S:1]           ; 第1弦
[S:4]           ; 第4弦
```

### 9.18 Swing / Straight (v2.1)

```
[swing]         ; Swing feel
[straight]      ; Straight feel
```

### 9.19 Multi-Measure Rest (v2.1)

```
[mmr:8]         ; 8小節休符
[mmr:16]        ; 16小節休符
```

---

## 10. Barlines

| Syntax | Style |
|--------|-------|
| `,` | Single barline |
| `,,` | Double barline (light-light) |
| `,,,` | Final barline (light-heavy) |
| `,:` | Repeat start (forward repeat) |
| `:,` | Repeat end (backward repeat) |
| `,-` | Dashed barline |
| `,.` | Invisible barline |

---

## 11. Repeats

```
:C4k D4k E4k F4k:2     ; play 2 times total
```

Repeats may be nested: `::C4k:2 D4k:3`

---

## 12. Tuplets

```
N(contents)
```

`N` = target duration in units. Contents are mapped to fit.

```
16(C4jD4jE4j)    ; triplet: 3 eighth notes in 16 units (= 1 quarter at DIV=64)
```

---

## 13. Lyrics

Non-token characters after a note are lyrics:

```
C4kや D4kま E4kと     ; lyrics: や ま と
```

Lyric escape with `'`:
```
C4k'C4k               ; literal text "C4k" as lyric
```

---

## 14. Header

Optional header in `[...]` at the start of the document:

**Long form:**
```
[CLEF:TREBLE TIME:4/4 KEY:C DIV:64]
```

**Short form:**
```
[Treble 4/4 KC D64]
```

**Defaults (when header omitted):**
- Clef: TREBLE
- Time: 4/4
- Key: C major
- DIV: 64

---

## 15. DIV (Division Resolution)

Units per whole note. Default: **64**.

| DIV | Quarter = | 64th = | Breve = |
|-----|-----------|--------|---------|
| 64 | 16u | 1u | 128u |
| 128 | 32u | 2u | 256u |

---

## 16. Comments

```
; This is a line comment
C4k D4k ; inline comment

/* This is a
   block comment */
C4k D4k
```

---

## 17. Matrix Mode

Same tokens in grid layout:

```
[1]| C4k | E4k | G4k | C5k |
[2]| G3k | G3k | G3k | G3k |
[3]| E3k | C3k | E3k | E3k |
[4]| C3k | C2k | C3k | C2k |
```

Parser accepts both stream and grid layouts identically.

---

## 18. Scope

### In scope:
- Standard 5-line staff notation
- Percussion notation (via `[Pe]` clef)
- Multi-part scores (vocal, instrumental)
- Chord symbols
- Jazz articulations (fall, doit, scoop, plop)
- Notehead variants (diamond, X, slash, triangle)
- Bowing / string techniques (up-bow, down-bow, harmonic, snap pizz, stopped)
- Multi-measure rest
- Fingering / string numbers

### Out of scope:
- Tablature (guitar TAB)
- Microtonal accidentals beyond ±2 semitones
- Engraving directives (layout, beaming, stem direction)

---

## Appendix A: Quick Reference

```
; === PITCH ===
C4k           ; middle C, quarter
C#4k          ; C-sharp 4, quarter
Cb4k          ; C-flat 4, quarter
C*4k          ; C-natural 4, quarter
Cx4k          ; C-double-sharp 4, quarter
Cbb4k         ; C-double-flat 4, quarter
C#4#k         ; C-double-sharp 4 (stacked)

; === DURATION ===
C4g C4h C4i C4j C4k C4l C4m C4n
;   64th 32nd 16th 8th  qtr  half whole breve
C4k.          ; dotted quarter
C4k..         ; double-dotted quarter
C4k...        ; triple-dotted quarter

; === CHORD ===
C4E4G4k       ; C major chord, quarter

; === REST ===
Rk            ; quarter rest

; === TIE ===
C4l+C4k       ; half + quarter tie

; === SLUR ===
c4k D4k E4k_  ; slur from C to E

; === NOTEHEADS (v2.1) ===
C4!dk         ; diamond notehead
C4!xk         ; X notehead
C4!/k         ; slash notehead
C4!tk         ; triangle notehead

; === ARTICULATIONS ===
C4ks          ; staccato
C4kS          ; staccatissimo
C4k>          ; accent
C4k^          ; marcato
C4k-          ; tenuto
C4k~          ; fermata
C4k~s         ; short fermata
C4k~l         ; long fermata
C4ks-         ; louré
C4kV          ; up-bow
C4kW          ; down-bow
C4kO          ; harmonic
C4kX          ; snap pizzicato
C4kT          ; stopped/mute

; === ORNAMENTS ===
C4ktr         ; trill
C4kmr         ; mordent (lower)
C4kMR         ; inverted mordent (upper)
C4ktn         ; turn
C4kTN         ; inverted turn
C4kz1         ; tremolo 1-stroke
C4E4G4kar     ; arpeggio
C4kgl         ; glissando
C4kvb         ; vibrato
C4kbn         ; bend

; === JAZZ (v2.1) ===
C4kjf         ; fall
C4kjd         ; doit
C4kjp         ; plop
C4kjs         ; scoop

; === GRACE NOTES ===
`C4k D4k      ; appoggiatura
``C4k D4k     ; acciaccatura

; === DYNAMICS ===
[Dp] [Df] [Dff] [Dsfz] [D<] [D>] [D/]

; === TEMPO ===
[T120] [T:Allegro] [T:rit] [T:accel] [T:atempo]

; === SIGNATURES ===
[M3/4] [KC] [KCm] [K+2]

; === CLEF ===
[T] [B] [A] [Te] [So] [Br] [Pe] [T8] [T-8]

; === PARTS ===
[1] [2] [P] [1:Piano] [2:Guitar]

; === NAVIGATION ===
[segno] [segno2] [coda] [coda2] [DC] [DS] [fine] [tocoda]
[DC.fine] [DC.coda] [DS.fine] [DS.coda]
[V1] [V2] [%]

; === TEXT ===
[R:A] [text:pizz.] [expr:dolce]

; === OTHER ===
[breath] [caesura] [8va] [8vb] [8va/] [ped] [ped/]
[F:1] [F:p]          ; fingering
[S:1] [S:4]          ; string number
[swing] [straight]   ; feel
[mmr:8]              ; multi-measure rest

; === BARLINES ===
,  ,,  ,,,  ,:  :,  ,-  ,.

; === REPEAT ===
:C4k D4k:2    ; play 2 times

; === TUPLET ===
16(C4jD4jE4j) ; triplet

; === LYRICS ===
C4kや D4kま    ; lyrics
C4k'C4k       ; escaped lyric

; === COMMENTS ===
; line comment
/* block comment */
```
