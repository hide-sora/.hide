---
title: ".hide: A Compact Symbolic Music Notation Language Designed for LLM-Era Multi-Voice Generation, Analysis, and Optical Music Recognition"
subtitle: "Priority Paper / 先取権公開文書"
author: "hide-sora"
affiliation: "Independent Researcher / Hamoren Project (https://hamoren.com)"
repository: "https://github.com/hide-sora/.hide"
version: "Specification v1.9 (v1.8 stream mode + v1.9 matrix mode, both implemented)"
date: "2026-04-07"
license: "Specification: CC BY 4.0. Reference implementation: MIT."
keywords: ["symbolic music representation", "music notation language", "compact notation", "Optical Music Recognition", "Large Language Models", "multi-voice analysis", "MusicXML", "kern", "ABC notation", "computational musicology"]
---

# .hide

## A Compact Symbolic Music Notation Language Designed for LLM-Era Multi-Voice Generation, Analysis, and Optical Music Recognition

**Author:** hide-sora
**Date of public disclosure:** 2026-04-07
**Specification version:** v1.9 (v1.8 stream mode + v1.9 matrix mode; both implemented in the reference codebase)
**Reference implementation:** TypeScript, in the *Hamoren* a-cappella practice platform (https://hamoren.com)
**Source repository:** https://github.com/hide-sora/.hide

---

## Abstract

We introduce **.hide** (pronounced *hai-dee*), a plain-text symbolic music notation language designed from first principles for the era of Large Language Models (LLMs). `.hide` targets three simultaneous goals that no prior notation language combines:

1. **Extreme lexical compactness** — a single pitched note with octave and duration is written in **three characters** (e.g., `C4k` is a quarter-note middle C). Average information density is, to our knowledge, the highest among publicly documented symbolic music languages that retain full multi-voice, lyric, articulation, repeat, tuplet, transposition, and tied-note expressivity.
2. **Zero parser ambiguity over a tiny vocabulary** — the entire surface lexicon is small enough that an LLM can be taught to *write* `.hide` reliably with a single prompt and short few-shot exemplar, and to *read* `.hide` with negligible hallucination. This makes `.hide` simultaneously a human-authored input format **and** a stable target for both LLM-driven generation and Optical Music Recognition (OMR) post-correction.
3. **A grid-mode (v1.9) extension that aligns multiple voices into time-synchronous columns**, recovering the analytic affordances pioneered by Humdrum **kern but in a per-token footprint roughly one-fifth the size, intended as a substrate for multi-voice analysis, reharmonisation, hamoring (close-harmony) suggestion, and AI-assisted composition.

This document is published as a **priority paper / 先取権公開文書** to establish a timestamped public record of the design choices that, taken together, constitute the originality of `.hide`. We carefully separate (a) **prior art**, which we acknowledge openly and build upon, from (b) **specific novel claims**, which we enumerate in §8 so that future researchers and reviewers may cite, contest, or build on them.

> *Disclaimer.* This is a *priority paper*, not a peer-reviewed publication. Its purpose is to fix the date and content of the design publicly, in the spirit of preprint deposits in physics and the priority claims used in chemistry and computer science. The author welcomes correction, prior-art citations, and collaboration.

---

## 要旨 (Japanese abstract)

`.hide` (ハイドと発音) は、LLM 時代の記号的音楽表現を再設計するために生まれた平文楽譜記述言語である。本仕様は次の三点を **同時に** 達成する点で、現存する既知の楽譜記述言語と一線を画す。

1. **極限の語彙圧縮** — 4分音符の中央ハ音は **`C4k` の3文字** で表現される。多声・歌詞・アーティキュレーション・反復・連符・移調・タイを完全保持したまま、トークン密度は (我々が知る限り) 既存公開言語中で最も高い。
2. **超小語彙ゆえの曖昧性ゼロのパース性** — LLM が短いプロンプトと少数例だけで `.hide` を **書き** 得るほど語彙が小さく、また `.hide` を **読む** 際の幻覚率がほぼ無視できる。これにより `.hide` は人間が直接書ける入力形式であると同時に、OMR 後段補正と LLM 生成の両方に対する安定したターゲット表現として機能する。
3. **グリッドモード (v1.9) によって多声を時間軸同期の列として整合化** し、Humdrum **kern が拓いた多声解析の可能性を、トークン量にしてその約 1/5 の footprint で再現する。多声解析・リハーモナイズ・ハモリ提案・AI作曲補助の基盤を意図する。

本文書は `.hide` の設計選択を時刻付きで公的に記録するための **先取権公開文書 (priority paper)** である。§2 で **既存技術** を率直に引用し、§8 で **新規性主張** を箇条書きで明示する。後続研究者・査読者はこれを引用・反証・拡張できる。

---

## Table of Contents

1. [Introduction and motivation](#1-introduction-and-motivation)
2. [Related work and prior art](#2-related-work-and-prior-art)
3. [Formal specification of `.hide` v1.8](#3-formal-specification-of-hide-v18)
4. [Matrix mode (v1.9): grid-aligned multi-voice extension](#4-matrix-mode-v19-grid-aligned-multi-voice-extension)
5. [Compilation pipeline: `.hide → MusicXML`](#5-compilation-pipeline-hide-→-musicxml)
6. [LLM-era considerations: why language minimality matters](#6-llm-era-considerations-why-language-minimality-matters)
7. [Use cases and reference implementation](#7-use-cases-and-reference-implementation)
8. [Specific claims of originality](#8-specific-claims-of-originality)
9. [Versioning timeline](#9-versioning-timeline)
10. [Limitations and future work](#10-limitations-and-future-work)
11. [Conclusion](#11-conclusion)
12. [References](#12-references)
13. [Appendix A — BNF grammar (v1.8)](#appendix-a--bnf-grammar-v18)
14. [Appendix B — Worked examples](#appendix-b--worked-examples)
15. [Appendix C — Token-density measurements](#appendix-c--token-density-measurements)

---

## 1. Introduction and motivation

### 1.1 The two pressures on symbolic music representation in 2025–2026

By the time of writing, two distinct pressures have come to bear on the design of symbolic music representations:

- **Pressure A — LLM context economy.** Large language models such as Claude (Anthropic), GPT (OpenAI), and Gemini (Google) operate on token budgets. A symbolic representation that costs ten times more tokens per measure than necessary effectively reduces the model's musical "working memory" by the same factor. Existing standards — MusicXML, MEI, even moderately verbose `**kern` — were designed under no such pressure and treat each note as a node-with-attributes rather than as a glyph.
- **Pressure B — End-user practicality on consumer devices.** Sheet music is ubiquitous as PDF, but Optical Music Recognition (OMR) is hard on consumer hardware: the leading open systems (Audiveris, oemer, etc.) are heavy JVM- or Python-based pipelines that are impractical to run in the browser. This blocks any "drop a PDF and play it back" experience on the web.

These two pressures are mutually reinforcing: a representation that is **dense enough** for LLMs is also **simple enough** that an LLM can serve as a soft OMR backend by *transcribing* a cropped staff image directly into that representation, sidestepping classical OMR entirely on the difficult bits.

`.hide` was designed against both pressures simultaneously. Its compactness is not aesthetic minimalism; it is **load-bearing** for both objectives.

### 1.2 What this paper claims

This paper does **not** claim that any single design feature of `.hide` is unprecedented in isolation. Letter pitches go back to Guido d'Arezzo. Compact letter notation in plain text was pioneered by ABC (Walshaw, 1991). Grid-aligned multi-voice columns are the defining contribution of Humdrum **kern (Huron, 1990s). Header omission and ASCII economy permeate text-music traditions from MIDI's `.mml` derivatives to modern crockford-style stream formats.

What `.hide` claims is **the specific combination**:

- The compactness of ABC, taken further (3 characters per pitched note rather than 1–6) by exploiting **case as a carrier of articulation**;
- A **contiguous-letter length alphabet** (`h`–`m`) chosen so each successive letter doubles duration — exploiting the fact that humans can memorise six adjacent letters trivially;
- The **column-time grid** of `**kern`, but inheriting `.hide`'s 3-character glyphs rather than `**kern`'s 3–6;
- A **compile-to-MusicXML** strategy that lets `.hide` ride the existing rendering and playback pipeline (OpenSheetMusicDisplay, Tone.js, etc.) without re-implementing engraving;
- An explicit **transposition-shift operator `[K+n]`** that is decoupled from the underlying key signature (a separation we have been unable to find a precedent for in other plain-text notation languages);
- A two-tier **Rule B accidental memory** that distinguishes user-explicit accidentals from key-signature-implicit ones at the data layer.

These are the things this paper exists to fix in time.

### 1.3 The Hamoren context

`.hide` was designed inside *Hamoren* (はもはも), an a-cappella rehearsal platform (https://hamoren.com) where amateur singers need to load a score, isolate their part, transpose to their range, and rehearse against the other parts. The platform already uses MusicXML internally (driving OpenSheetMusicDisplay for rendering and a custom Tone.js / SoundFont stack for playback). The friction the team faced was not playback or rendering — it was **getting MusicXML in the first place**. Most amateur scores arrive as PDF, and most existing OMR is too heavy or too inaccurate for clean amateur a-cappella PDFs to be a usable input.

`.hide` was conceived as a representation small enough that:

- a user can **write a measure by hand** in seconds (no editor required);
- an LLM can **transcribe a cropped staff image** into it in one Vision API call;
- a hand-written `.hide → MusicXML` compiler can drop the result into the existing pipeline with no changes to the renderer or playback engine.

These three properties, plus the future grid-mode aspiration (§4), are the reasons `.hide` exists.

---

## 2. Related work and prior art

We acknowledge the following bodies of work as direct intellectual ancestors of `.hide`. Where possible we cite the original designers; we **do not** claim originality for any feature already present in these prior works.

### 2.1 ABC notation (Chris Walshaw, 1991)

ABC is the closest spiritual ancestor of `.hide`. It is letter-based, plain-text, and uses note letters `A`–`G` for pitches with `^` / `_` for accidentals and digits for duration multipliers. Multi-voice support is provided via `V:` voice declarations.

**What `.hide` inherits from ABC:**

- The fundamental insight that letter-based plain text can encode music compactly enough to be hand-typed.
- The `[T...]`-style header convention (though `.hide` extends this with extreme defaults).
- The use of `+` for tied/joined notes.

**What `.hide` does differently:**

- ABC uses **case to indicate octave** (`C` ≠ `c`), and explicit `,` / `'` for octave shifts. `.hide` uses an **explicit octave digit** (`C4`), freeing the case bit to carry **articulation** instead (slur start / staccato).
- ABC's duration is **multiplicative** (default note length × ratio), which interacts with the `L:` header in subtle ways. `.hide`'s duration is **absolute** via single-letter aliases `h`–`m`, requiring no surrounding context to interpret a single glyph.
- ABC's accidental syntax `^C`, `_D`, `=E` puts the accidental **before** the letter; `.hide` puts it **after** (`Cs4k`, `Db4k`, `Cn4k`), which preserves left-to-right reading of "what note, then how altered".
- ABC has no formal separation between *original key* and *transposition shift*. `.hide` introduces this separation as a first-class language construct (`[K+n]`).

### 2.2 Humdrum `**kern` (David Huron, 1990s)

`**kern` is the definitive **grid-aligned** symbolic music representation. Each spine (column) is a voice; each row is a time point. The format is the de-facto standard for computational musicology: the *Music21* corpus, Bach chorales, and many large-scale corpus studies use `**kern` as their canonical form.

**What `.hide` inherits from `**kern`:**

- The decision (in v1.9 matrix mode) to align voices as **columns** rather than as switched-context streams — that is, time-synchronous columnar layout as the canonical representation for multi-voice analysis.
- The recognition that columnar alignment makes per-time-point queries (chord extraction, voice-leading, harmonic analysis) trivial, as opposed to switched-context formats which require expensive re-interleaving.

**What `.hide` does differently:**

- A `**kern` quarter-note middle C is written `4c` (two characters) but a `**kern` eighth `D♯` is `8d#` (three) and a chord requires multi-spine spreading. The token-cost-per-musical-event is between 2× and 5× that of `.hide` once you account for separators, spine markers, and accidentals.
- `**kern` has no strong pressure toward token economy; it is designed for analysis-after-the-fact, and its per-spine verbosity is irrelevant to its use cases.
- `.hide`'s grid mode (v1.9) is a **superset** of its scalar mode (v1.8) — the same parser accepts both — whereas `**kern` is grid-only.

### 2.3 LilyPond (Han-Wen Nienhuys & Jan Nieuwenhuizen, 1996–)

LilyPond is the leading open-source music engraving system. It uses a text-based input language that is far more compact than MusicXML but is optimised for *typesetting* rather than analysis or LLM ingestion. A LilyPond quarter-note C is `c4` (two characters in monophonic context).

**What `.hide` inherits:** the conviction that text-based music input can be both human-writable and machine-parseable without losing expressivity.

**What `.hide` does differently:** LilyPond's focus is engraving, with hundreds of typesetting directives, articulations, and layout primitives. `.hide` deliberately omits all engraving control because rendering is delegated to MusicXML consumers (OpenSheetMusicDisplay in the reference implementation). This makes `.hide` roughly one order of magnitude smaller in vocabulary.

### 2.4 MusicXML (Recordare LLC / Michael Good, 2004; W3C, ongoing)

MusicXML is the de-facto interop standard for digital sheet music. It is XML-based, verbose, and explicitly designed for **complete** representation rather than compactness.

**Relationship:** `.hide` **compiles to** MusicXML. MusicXML is treated as a *target* representation, not a competitor. The reference compiler emits MusicXML 3.1 partwise documents that OpenSheetMusicDisplay accepts.

### 2.5 MEI — Music Encoding Initiative

MEI is an XML-based scholarly encoding format with very rich metadata facilities, used in musicology and digital editions. It is the most expressive of the XML formats but also the most verbose. `.hide` does not target MEI directly but its grid mode (v1.9) is loosely analogous to `mei:staff` interleaved with `mei:layer` constructs.

### 2.6 MusicTeX, GUIDO, MNX, OPUS, and others

There are many more text-based music notation languages, including:

- **MusicTeX / MusiXTeX** (TeX-based, engraving-focused, very verbose);
- **GUIDO** (academic, semi-structured, moderately compact);
- **MNX** (W3C draft successor to MusicXML, JSON/XML, work-in-progress);
- **OPUS**, **GUIDO-NoteServer**, **PMX**, **abjad** input dialects, and others.

None of these target the simultaneous goals of `.hide`. We do not claim familiarity with every notation language ever published; if a precedent exists for any individual feature claimed in §8, the author will gladly amend this paper to acknowledge it.

### 2.7 LLM-targeted music representations (2023–)

A small but growing literature uses LLMs to generate symbolic music. Notable approaches include:

- **ABC-format generation** (multiple academic papers and the *folk-rnn* family of models, which use ABC as the target language for monophonic folk-tune generation);
- **MIDI-event tokenisations** such as REMI, MMM, and Music Transformer's Magenta-derived encodings;
- **MusicXML or text-form generation** in general LLM prompting.

`.hide` differs from all of these in that it is **not** retrofitted from an existing format for LLM use. It is designed *natively* for LLM ingestion and emission, with the explicit constraint that the entire surface vocabulary must fit comfortably in a one-page prompt. To our knowledge, `.hide` is the first plain-text notation language whose design optimisation criterion is **LLM token economy combined with multi-voice grid alignment**.

---

## 3. Formal specification of `.hide` v1.8

### 3.1 Design principles

The language is governed by five principles, in order of priority when they conflict:

1. **Compactness over readability** when the two conflict — but only when the resulting glyph remains *decodable* without context. (`C4k` is compact but unambiguous; we never abbreviate to the point of relying on global state.)
2. **Zero parser ambiguity** — every glyph has exactly one valid interpretation given its surrounding tokens.
3. **Tiny surface vocabulary** — the entire lexicon must fit on one page, so an LLM can be taught to read and write `.hide` from a single prompt.
4. **Header omission with sane defaults** — a 4/4 piece in C major needs no header.
5. **Compile-to-MusicXML interoperability** — `.hide` does not replace existing rendering/playback infrastructure; it feeds it.

### 3.2 Lexical structure

A `.hide` source consists of an **optional header** delimited by `[ ... ]` followed by a **body** consisting of tokens. Whitespace, line breaks, and the bar-line character `|` are all ignored, as are line comments introduced by `;`. This means the same musical content can be written as a single line for token economy, or with line breaks and bar lines for human readability — both forms parse identically.

```
[Treble 4/4 KC D32]    ; optional header
C4k D4k E4k F4k |      ; bar 1
G4k A4k B4k C5k |      ; bar 2
```

The above is exactly equivalent to:

```
C4kD4kE4kF4kG4kA4kB4kC5k
```

This whitespace-irrelevance is the basis for matrix mode (§4): the same parser accepts both stream and grid layouts.

### 3.3 Pitch syntax

A single pitched note token has the canonical form

```
[letter][accidental?][octave-digit][length-letter]
```

with semantics:

| Element | Range | Meaning |
|---|---|---|
| **letter** | `A`–`G` (uppercase) or `a`–`g` (lowercase) | Note name. Case carries articulation: lowercase = slur start. |
| **accidental** | `s`, `b`, `n`, or `#` (synonym for `s`) | Sharp, flat, or natural. Optional. Implies "explicit" tracking (Rule B). |
| **octave-digit** | `0`–`9` | Octave in scientific pitch notation (middle C = `C4`). |
| **length-letter** | `h`, `i`, `j`, `k`, `l`, `m` (lowercase) or `H`–`M` (uppercase) | Duration alias; UPPERCASE = staccato. |

**Length alphabet (the `h`–`m` doubling sequence):**

| Letter | Duration (DIV=32) | Standard name |
|---|---|---|
| `h` | 1 unit | 32nd note |
| `i` | 2 units | 16th note |
| `j` | 4 units | 8th note |
| `k` | 8 units | quarter note |
| `l` | 16 units | half note |
| `m` | 32 units | whole note |

The choice of `h`–`m` is intentional: six successive ASCII letters where each successive letter exactly doubles the previous duration. This is mnemonic (six adjacent letters), terse (one character), and avoids collision with the pitch alphabet `A`–`G`.

> *Why uppercase = staccato.* Conventional music typography marks staccato as a dot above the note, an inherently *sharp/short* visual character. Uppercase letters are visually heavier and more "stop-like" than their lowercase counterparts; we exploit this association.

> *Why lowercase = slur-start.* A slur is a curve, a flowing connection. Lowercase letters have descenders and ascenders that *flow*; uppercase are blocky. The same association is used in many natural-language typography conventions.

### 3.4 Chords

A chord is a sequence of pitch-letters-with-octave concatenated **without** length, terminated by a single shared length:

```
C4E4G4k       ; C major chord, quarter note
c4e4g4k       ; same chord, slur-starts on the C
```

Only the first letter's case is interpreted for slur; subsequent letters are case-insensitive. The shared length applies to all chord members, eliminating per-note duration repetition (a key compactness win over `**kern` and ABC, both of which require per-note duration in chords).

### 3.5 Rests

```
Rk            ; quarter rest
RK            ; staccato quarter rest (legal but unusual)
Rm            ; whole rest
```

The single capital `R` followed by a length letter is unambiguous because no pitch letter is `R`.

### 3.6 Tie

Tie is the single character `+` placed *after* the note it ties from:

```
C4l+C4k       ; half C tied to quarter C (= dotted half)
```

### 3.7 Lyrics

Any character not matching the note / rest / meta / repeat / tuplet patterns is treated as a **lyric** belonging to the most recent note token. Multi-character lyric sequences (Japanese, English words) are absorbed greedily:

```
C4kやD4kまE4kとF4kをG4kあl
       や         まと          を      あ
```

Which renders as the melody C-D-E-F-G with lyrics "や" "まと" "を" "あ" (Japanese syllables).

For the rare case where a lyric character collides with the note grammar (e.g., a literal `C4k` appearing as text), the apostrophe `'` forces the next token to be parsed as lyric:

```
C4k'C4k       ; sings the literal text "C4k" on the quarter note C
```

This **lyric escape operator** is a specific design choice to keep the parser context-free at the cost of one rare character.

### 3.8 Meta commands

Body-level meta commands are written `[X...]`:

| Form | Meaning |
|---|---|
| `[T120]` | Set tempo to 120 BPM. |
| `[M3/4]` | Change time signature to 3/4. |
| `[KC]` / `[KCm]` / `[KBb]` | Set the *original key* (C major, C minor, B♭ major). Letter form. |
| `[K+2]` / `[K-3]` | **Transposition shift** by ±n semitones (see §3.10). |
| `[1]` `[2]` `[3]` ... `[N]` | Add / switch to **numbered vocal part** 1, 2, 3, … N. Intended for arbitrary-size a-cappella scores. Displayed as `Voice 1`, `Voice 2`, …. |
| `[P]` | Add / switch to **voice percussion** (ボイスパーカッション / ボイパ). Displayed as `Voice Percussion`. Optional — an a-cappella score without VP simply omits `[P]`. |

#### The general part-switch rule

> **When the content inside `[...]` is exactly a sequence of digits, or exactly the single letter `P`, that meta token introduces a new part.** No other meta token introduces a part.

That is, `[1]`, `[2]`, …, `[12]`, `[P]` all add a new part to the score. Returning to a previously declared label (e.g. writing `[1]` again later) appends to the same part. This is the **only** multi-part syntax in `.hide` from v1.9 onward; the older `[S][A][T][B]` SATB labels and `[P1]..[PN]` numbered-with-prefix syntax have both been **removed**. A four-part choral score is now written as `[1][2][3][4]`, not `[S][A][T][B]`.

#### Why numbered + percussion is the canonical (and only) model

A-cappella ensembles in practice are not four-part SATB. A typical contemporary group is **6 members** = 5 vocal parts + 1 voice percussion, and group sizes of 4, 5, 7, 8 are also common. The fixed `[S][A][T][B]` labels do not generalise to these cases without inventing arbitrary part letters; nor does it match how amateur a-cappella groups *think* about their lines (they refer to "the lead", "the second", "VP", not by classical voice taxonomy).

`.hide` therefore commits to **`[1]..[N]`** as the only part-switch syntax for vocal parts, and **`[P]`** as the dedicated (and optional) voice-percussion label. The internal MIDI program for `[P]` is the same as for vocal parts (53, Voice Oohs) because voice percussion is *physically a human voice* — playback consumers may override this to a drum sound if desired.

### 3.9 Tuplets

A tuplet is written as `N(...)` where `N` is the **target duration in units** that the contents fit into:

```
8(C4jD4jE4j)     ; triplet of 8th-notes filling 8 units (= one quarter)
```

Inside the parentheses, the *natural* total duration of the contents (here `4 + 4 + 4 = 12` units) is mapped onto the *target* `8`, producing a triplet ratio of 3:2.

### 3.10 Repeats

A repeat block is delimited by colons with an optional integer count after the closing colon:

```
:C4kD4kE4kF4k:2     ; play these four notes 2 times total (one repeat)
```

Repeats may be nested.

### 3.11 Transposition vs key signature: the `[K+n]` separation

`.hide` makes a sharp distinction between two related but **distinct** concepts that most existing notation languages conflate:

- **Original key** (`keyFifths` in the AST, `[KC]` / `[KBb]` etc. in the source). This is the key in which the piece was *composed*. It governs which accidentals are key-signature-implicit vs. key-signature-explicit, and it never changes once set.
- **Transposition shift** (`transposeSemitones` in the AST, `[K+n]` / `[K-n]` in the source). This is a *user-driven* semitone shift that re-pitches the entire piece *without* losing track of what the original key was.

When both are present, the *displayed* key signature (what `.hide → MusicXML` emits as `<fifths>`) is computed as

```
new_fifths = normalise_to_minus6_plus6((original_fifths + 7 * semitones) mod 12)
```

and the spelling (sharp vs flat enharmonic) of every transposed note is chosen to **match the new key's circle-of-fifths direction**, so that a piece transposed up two semitones from C major to D major correctly spells `C♯` rather than `D♭`.

This separation matters for amateur singing groups, where a song is *composed* in C but a particular ensemble needs to *sing* it in B♭ — and on returning the score to a different ensemble next week, must shift it again. With most notation languages, you would have to re-key the whole piece. In `.hide`, you change a single `[K+n]` token and the original is preserved.

We have searched for a precedent for this exact construct in plain-text notation languages and have not found one. ABC, `**kern`, LilyPond, and MusicXML all support transposition (typically as a tool-level operation or as a `<transpose>` element wrapping a single concert-pitch encoding), but none expose a *first-class language operator* that semantically separates *original key* from *play-time semitone shift*. We claim this as one of `.hide`'s specific original contributions (§8.4).

### 3.12 Rule B: 1-measure accidental memory with explicit tracking

Standard music typography practice is that an accidental applied to a note carries through the rest of the bar at the same pitch and octave (and is cancelled at the next bar line). `.hide`'s parser implements this rule (we call it **Rule B**) at the data layer, but with one extension that we believe is novel:

Each pitch in the AST carries an `accidentalExplicit: boolean` flag, distinguishing accidentals **the user wrote** from accidentals **inherited from the key signature**. This matters when:

- **transposing** — explicit accidentals must be re-spelled in the new key direction; implicit ones disappear into the new key signature;
- **rendering** — the MusicXML `<accidental>` element should be emitted only when the user wrote one explicitly, not when the engine "inherited" it for rendering convenience;
- **AI re-harmonisation and analysis** — distinguishing user-intent from key-implicit notes is essential for correctly interpreting the harmonic language of a piece.

This intent-vs-effect separation at the type level is, to our knowledge, not found in prior plain-text notation languages.

### 3.13 Header omission and extreme defaults (v1.8)

In v1.8 the entire header may be **omitted**. The defaults are:

```
clef               = TREBLE
time signature     = 4/4
key (original)     = C major (fifths = 0)
DIV                = 32 (units per whole note → 8 units per quarter)
transpose shift    = 0 semitones
```

Thus the minimum viable `.hide` document is just the body — for example, the four-note motive

```
C4kD4kE4kF4k
```

is a complete, parseable, renderable `.hide` document with implicit treble-clef 4/4 C-major header. This **zero-configuration** principle is essential for LLM prompting (the model does not waste tokens emitting boilerplate headers) and for short-snippet sharing.

### 3.14 DIV: division resolution

`DIV` is the **number of duration units per whole note**. The default is 32, so a quarter note `k` is 8 units. For high-resolution scores (32nd-note triplets, 64th notes, etc.) the user may write `D64` in the header, which causes all length aliases to scale by 2× and gives the parser sub-32nd-note resolution. The MusicXML compiler maps `DIV/4` to MusicXML's `<divisions>` element.

A subtle constraint: the units-per-measure must be an integer. This is checked at parse time:

```
units_per_measure = (timeNum / timeDen) * DIV    ; must be integral
```

For 3/4 with DIV=32, this yields 24 units per measure; for 6/8 with DIV=32, also 24; for 4/4 with DIV=32, 32. The constraint catches a class of input errors (mismatched DIV and time signature) at the earliest possible point.

---

## 4. Matrix mode (v1.9): grid-aligned multi-voice extension

### 4.1 Motivation

A central observation in *Hamoren*'s use case is that **multi-voice a-cappella music is intrinsically two-dimensional**: time runs along one axis, voice runs along the other. Existing per-voice serialisations (ABC `V:`, `**kern` spines, `.hide`'s own `[1][2][3]…[P]` part-switch stream) all *flatten* this two-dimensional object into a one-dimensional string and require the consumer to re-construct the time-alignment as a separate step.

Matrix mode (v1.9, **implemented**) treats the two-dimensional structure as a first-class language object.

### 4.2 Key insight: v1.8 already accepts the grid layout

Because the v1.8 lexer ignores whitespace, line breaks, and bar lines, a grid layout like

```
[1]|C5k|E5k|G5k|C6k|
[2]|G4k|G4k|G4k|G4k|
[3]|E4k|C4k|E4k|E4k|
[4]|C4k|C3k|C4k|C3k|
```

is already a valid v1.9 document. The lexer flattens it to four part-switched streams. Matrix mode therefore does not require a parser rewrite; it requires two additions, both of which are now implemented in `src/hideMatrix.ts`:

1. **Per-measure consistency checker** — verifies that each `|`-delimited *measure* has the same total duration across all parts. A mismatch is reported as a `measureDurationMismatch` / `measureCountMismatch` issue with the offending measure index. The reference implementation adds a `barline` raw lexer token (silently skipped by the v1.8 stream parser, so v1.8 compatibility is bit-for-bit preserved) and walks the raw token stream once per part to recover measure boundaries.
2. **Iterator API `iterateMeasures()`** — yields a `HideMatrixMeasure` (containing `Map<partLabel, HideMatrixCell>` plus per-cell pitches and durations) for each time-aligned measure, enabling per-time-point queries (chord extraction, harmonic analysis, hamoring suggestion) in O(1) per measure. A companion helper `measureToChord(matrix, measure)` returns a flat `HidePitch[]` for the most common chord-extraction use.

There is intentionally **no** `[GRID N]` strict-mode delimiter: the part count is already implied by the `[1]..[N]+[P]` declarations themselves, so a separate `[GRID N]` marker would be redundant. (An earlier draft of v1.9 included one; it was removed before release for vocabulary minimality.)

The public API is exported from `src/index.ts` as `analyzeMatrix(source)`, `iterateMeasures(matrix)`, and `measureToChord(matrix, measure)`. The full surface and the regression tests live in `src/hideMatrix.test.ts` (vitest) and the visual harness `public/test_hide.html`.

### 4.3 Why this matters

A column iterator on a grid-aligned multi-voice score is the most efficient possible substrate for:

- **Chord extraction** at a given beat (just read the column);
- **Voice-leading analysis** between adjacent columns (subtract pitches);
- **Hamoring suggestion** (close-harmony generation) — given a melody column, propose Alto/Tenor/Bass columns;
- **Reharmonisation** — given the grid, ask an LLM to rewrite specific columns under a constraint;
- **Style transfer** — rewrite the same melody under a different harmonic style;
- **AI-assisted composition** — incremental column-by-column generation with constraints.

Every one of these AI-assisted operations becomes essentially trivial once you have `iterateColumns()`. `**kern` provides this (and the *Music21* library exposes a similar API on `**kern` data), but at substantially higher per-column token cost.

### 4.4 Strategic intent: a successor to `**kern` for the LLM era

We position matrix-mode `.hide` as a **modern successor to `**kern`** for the specific use case of LLM-assisted multi-voice analysis and generation. `**kern` was designed in the era of static corpus studies; its verbosity is irrelevant because it is read by programs once and cached. `.hide` matrix mode is designed for the era where every analytic operation may involve a round-trip to an LLM, and where token budgets are the binding constraint.

We have ported the Bach chorale corpus from the *Music21* mirror (`cuthbertLab/music21/master/music21/corpus/bach`) into `.hide` as a comparison baseline, and we invite the research community to use `.hide` as a token-economical substrate for LLM-era musicology experiments. The vendored artefact lives at `corpus/bach/hide/*.hide` (410 files; the conventional "Bach 389 chorales" is the Riemenschneider 4-part SATB subset, of which 365 are present in the *Music21* mirror, the remaining 45 files being 5/6/7-part cantata movements and one solo melody). The forward conversion is regression-tested on every commit by `src/bachCorpus.test.ts` (419 cases) which re-runs `musicXmlToHide` on the original `corpus/bach/xml/*.xml` and asserts byte-equality with the vendored `.hide`.

> *Disclosure of conversion fidelity.* The Bach corpus port surfaces ~4,200 `nonStandardDuration` diagnostics across 372 of the 410 files (rare durations approximated to the nearest standard length cell, with the deviation recorded as a structured diagnostic rather than silently filled). This is not a conversion failure — every file round-trips through `analyzeMatrix` without parse error — but it is a known precision-vs-vocabulary trade-off that future work on `musicXmlToHide` may further reduce.

---

## 5. Compilation pipeline: `.hide → MusicXML`

The reference implementation compiles `.hide` directly to MusicXML 3.1 partwise. The pipeline is intentionally minimal:

```
.hide source
   │
   │   tokenize()       ── lexer (hideLexer.ts)
   ▼
HideLexResult { header, tokens, positions, source }
   │
   │   parse()          ── parser (hideParser.ts)
   ▼
HideAst { header, body }
   │
   │   astToMusicXML()  ── compiler (hideToMusicXML.ts)
   ▼
MusicXML 3.1 partwise document
   │
   │   (consumed by OpenSheetMusicDisplay for rendering,
   │    by Tone.js/SoundFont stack for playback)
   ▼
Sheet display + audio playback
```

Key compilation decisions:

- **divisions = DIV / 4** so the MusicXML quantum matches `.hide`'s internal unit.
- **Transposition is applied at compile time**: pitches are re-spelled into the new key direction before being emitted; the MusicXML output contains the *transposed* pitches and the *transposed* `<fifths>`. This means downstream tools see a normal score in the target key, not a `<transpose>` element wrapping a concert-pitch encoding. (Both strategies are valid; we chose the simpler one.)
- **Rule B is applied per measure**: a small `Map<string, alter>` tracks which pitch-octaves have already been altered in the current measure, and `<alter>` is emitted only when the user-requested alter differs from the currently effective one.
- **Slur, staccato, tie** are emitted as standard MusicXML `<notations>` children.
- **Lyrics** are attached to the chord-head note only.

The compiler is approximately 480 lines of TypeScript in the reference implementation. We consider this a feasibility lower bound.

---

## 6. LLM-era considerations: why language minimality matters

### 6.1 Token economy as a first-class constraint

Modern LLMs operate on context windows measured in tokens, where one token roughly corresponds to 3–4 characters of English. A symbolic music representation that costs 30 characters per measure uses ~10 tokens per measure; one that costs 300 characters per measure uses ~100. Over a 200-measure piece, the difference is 18 000 tokens — a substantial fraction of even the largest commercial context windows.

`.hide`'s per-measure footprint is, in our reference corpus, between 4 and 12 characters per voice per measure for typical homophonic content. This is approximately:

- **5–10× more compact than MusicXML**;
- **2–3× more compact than `**kern`**;
- **comparable to or slightly more compact than ABC** (depending on the use of accidentals and chords);
- **substantially more compact than any XML or JSON-based format**.

Detailed measurements are given in Appendix C.

### 6.2 Vocabulary smallness as an LLM-friendliness criterion

Token economy alone is not enough. An LLM also needs to *understand* the language well enough to produce valid output. We observe that LLMs handle small, regular grammars far better than large irregular ones — the failure mode is invariably hallucinated syntax, and the more syntax there is, the more there is to hallucinate.

`.hide`'s entire surface lexicon is:

- 7 pitch letters (`A`–`G`)
- 3 accidentals (`s`, `b`, `n`)
- 10 octave digits (`0`–`9`)
- 6 length aliases (`h`–`m`), each in two cases
- 1 rest letter (`R`)
- 1 tie character (`+`)
- 1 lyric escape (`'`)
- 4 grouping characters (`[`, `]`, `(`, `)`)
- 1 repeat boundary (`:`)
- ~10 meta command keys (`T`, `M`, `K`, `S`, `A`, `T`, `B`, `P`, `D`)

That's roughly **fifty distinguishing surface elements**, all of which can be enumerated in a single page of prompt. We have empirically verified that current-generation LLMs (Claude Opus 4.5–4.6, Claude Sonnet 4.5–4.6) can be taught to write valid `.hide` from a one-page specification with no fine-tuning. The same is *not* true of MusicXML, which we have observed LLMs to consistently malformed at the schema level even in-context.

### 6.3 The hybrid OMR strategy

A consequence of (6.1) and (6.2) is that an LLM with vision capability becomes a viable **OMR backend** for `.hide` specifically:

1. The classical OMR pipeline (staff detection → glyph segmentation → pitch/duration classification) handles the easy regions of a clean PDF.
2. Regions where classical confidence is low — typically tuplets, ornaments, dense chord stacks, beamed eighth groups — are cropped to small images and sent to a vision-capable LLM with the prompt "transcribe this staff into `.hide`".
3. The LLM's output is **validated by attempting to compile it**. If compilation fails, the failure message (with line/column position) is sent back to the LLM for a corrected attempt — a verification loop.
4. Successfully compiled regions are merged back into the partial classical-OMR output.

This hybrid is feasible *because* `.hide` is small enough that the LLM does not hallucinate its grammar, and *because* the compiler provides a precise oracle for "is this output valid?". With MusicXML as the target, neither property holds; with `**kern` as the target, the per-region prompt is workable but more expensive.

We claim this **OMR-validated-by-compilation hybrid** as a system-level contribution — not the OMR techniques themselves (which are largely standard), but the *specific use of a compact notation language as a feedback-loop OMR target*.

### 6.4 Reference pipeline: PDF → `.hide` consumer wiring

The reference implementation exposes the hybrid as four composable phases. Each phase is pure (no network, no side effects); the consumer owns LLM calls and retry policy. A minimal end-to-end wiring looks like this:

```ts
import {
  buildPdfHideMetaPrompt, applyPdfHideMetaResponse,            // Phase 1
  extractPageLayout,                                            // Phase 2a
  detectNoteheadsInCell,                                        // Phase 2b
  assemblePdfHide,                                              // Phase 3
  buildPdfHideLlmFallbackPrompt, applyPdfHideLlmFallbackResponse, // Phase 4
} from 'hide-lang';
import type {
  PdfHideImage, CellBox, NoteheadDetectionResult, PdfHideClefName,
} from 'hide-lang';

async function pdfToHide(
  pageImages: PdfHideImage[],                                         // pure-TS ImageData
  pageBase64: { base64: string; mediaType: 'image/png'; pageNumber: number }[],
  anthropic: AnthropicClient,
) {
  // ===== Phase 1 — LLM whole-piece structure (1 call, all pages) =====
  const metaPrompt = buildPdfHideMetaPrompt({ pageImages: pageBase64 });
  const metaResp = await anthropic.messages.create({
    model: 'claude-opus-4-6', max_tokens: 4096,
    system: metaPrompt.systemPrompt,
    messages: [{ role: 'user', content: metaPrompt.userContent }],
  });
  const meta = applyPdfHideMetaResponse({ llmResponse: metaResp.content[0].text });
  if (!meta.context) throw new Error(meta.parseError);
  const context = meta.context;

  // ===== Phase 2a — classical OMR layout (staff/system/cell geometry) =====
  const pageLayouts = extractPageLayout({ pageImages, context });

  // ===== Phase 2b — notehead detection per cell (Bravura template match) =====
  const noteheadsByCell = new Map<CellBox, NoteheadDetectionResult>();
  for (const pl of pageLayouts) {
    for (const sys of pl.systems) {
      for (const cell of sys.cells) {
        const staff = sys.staves[cell.staffIndex];
        const clef = context.clefsPerStaff[cell.staffIndex] as PdfHideClefName;
        noteheadsByCell.set(cell, detectNoteheadsInCell({
          pageImage: pageImages[pl.pageIndex],
          cell, staffBand: staff, clef,
          keyFifths: context.initialKeyFifths,
        }));
      }
    }
  }

  // ===== Phase 3 — assemble draft + confidence flagging (no silent fill) =====
  const draft = assemblePdfHide({ context, pageLayouts, noteheadsByCell });
  if (draft.lowConfidenceCells.length === 0) {
    return { hideSource: draft.hideSource, diagnostics: draft.diagnostics };
  }

  // ===== Phase 4 — LLM fallback, per page in parallel (low-confidence cells only) =====
  const byPage = new Map<number, typeof draft.lowConfidenceCells>();
  for (const c of draft.lowConfidenceCells) {
    let arr = byPage.get(c.pageIndex);
    if (!arr) { arr = []; byPage.set(c.pageIndex, arr); }
    arr.push(c);
  }
  const fallbacks = await Promise.all([...byPage.entries()].map(async ([pageIdx, cells]) => {
    const cellRefs = cells.map(c => ({
      cellId: `p${c.pageIndex}s${c.systemIndex}i${c.staffIndex}m${c.measureIndex}`,
      partLabel: c.partLabel,
      globalMeasureIndex: c.globalMeasureIndex,
      confidence: (c.confidence === 'high' ? 'mid' : c.confidence) as 'mid' | 'low' | 'unknown',
    }));
    const prompt = buildPdfHideLlmFallbackPrompt({
      pageImage: pageBase64[pageIdx],
      draftHideSourceForPage: draft.hideSource, // multi-page: slice lines whose cellId contains `p${pageIdx}s`
      lowConfidenceCells: cellRefs,
      context: {
        clef: context.clefsPerStaff[0],
        timeSignature: context.initialTimeSignature,
        keyFifths: context.initialKeyFifths,
      },
    });
    const resp = await anthropic.messages.create({
      model: 'claude-opus-4-6', max_tokens: 4096,
      system: prompt.systemPrompt,
      messages: [{ role: 'user', content: prompt.userContent }],
    });
    return applyPdfHideLlmFallbackResponse({
      llmResponse: resp.content[0].text,
      expectedCellIds: cellRefs.map(c => c.cellId),
    });
  }));

  // Consumer merges fallbacks[].cellOverrides back into draft.hideSource by matching
  // `;<status>:<cellId>` markers. Cells with `stillUncertain === true` and any
  // `fallbacks[].unresolved` item stay as diagnostics in the editor — never a silent fill.
  return { draft, fallbacks };
}
```

Four design properties follow from this shape:

- **Adaptive cost.** Phase 1 is one LLM call regardless of page count. Phase 4 is zero calls when classical OMR already hit 100% confidence, and otherwise scales with the number of low-confidence *cells*, not pages. A clean engraved PDF typically settles at one LLM call total; a noisy scan with dense chords adds a per-page fallback call only for pages that actually need it. For reference, the target envelope is ≈ $0.56 – 0.68 per 4-voice a-cappella piece, versus ≈ $1.4 – 2.5 if every page were routed through a vision LLM (the all-LLM baseline, "Plan D").
- **Silent-fill-free guarantee.** Phase 3 never writes a note it did not detect; it emits a `;unknown:<cellId>` rest placeholder and a structured `PdfHideDiagnostic`. Phase 4 preserves the contract: if the LLM still cannot commit, the cell comes back as `stillUncertain` or in `unresolved`, and the editor surfaces it for a human. At no stage does the pipeline promote guesses to "final".
- **cellId as the merge key.** The string `p{page}s{system}i{staff}m{measure}` is deterministic from layout and is what both phases (assemble and fallback) carry as their contract. Consumers merge overrides by matching that marker at end-of-line, so the merge is line-local and order-independent.
- **Pure phases, consumer-owned I/O.** No phase imports a network client or filesystem. LLM calls, retries, timeouts, rate limiting, caching, and the Phase 4 per-page parallelism all live in the consumer. This is what lets the same primitives drive the Hamoren web UI, a CLI, and a unit test that replays a captured LLM transcript.

---

## 7. Use cases and reference implementation

### 7.1 The Hamoren a-cappella platform

The reference implementation lives inside *Hamoren* (https://hamoren.com), an a-cappella rehearsal platform whose users are amateur close-harmony groups. The integration points are:

- A `/hide-playground` route where a user can type `.hide` and see a live rendering and hear playback.
- A `/pdf-import` route where a user drops a PDF, which is processed by the hybrid OMR pipeline (§6.3) into a `.hide` document, which is then compiled to MusicXML and dropped into the existing player.
- A trivial single-line addition to the existing `MusicPlayer` component to load `.hide` files alongside MusicXML, recognising the file by the `.hide` extension.

The intent is that the existing renderer, playback engine, transpose UI, loop UI, and lyric display all continue to work **without any modification** because the input to all of them is still MusicXML. `.hide` is, from the existing player's perspective, a convenient alternative source format.

### 7.2 Beyond Hamoren

We expect `.hide` to be useful in any context where:

- a developer wants to drop a few measures of music into source code without managing an XML file;
- an LLM is asked to generate or analyse multi-voice music;
- an OMR pipeline needs a compact target representation that can be validated by compilation;
- a teaching context needs a tiny notation language students can learn in one sitting.

---

## 8. Specific claims of originality

This section enumerates the specific design decisions for which we claim originality. The numbering is intended for citation. We invite reviewers and prior-art researchers to challenge any item; if a precedent is shown, the item will be amended in a subsequent revision of this paper.

> **Claim 8.1 — The 3-character pitched-note glyph form `[letter][octave-digit][length-letter]`** as the canonical encoding of a pitched note with octave and duration in a plain-text notation language. We are aware that ABC achieves 1–2 character pitches via case-encoded octave, and `**kern` achieves 2-character pitches via leading-duration prefix, but neither matches `.hide`'s combination of (a) explicit octave digit, (b) freed letter case for articulation, and (c) doubling-letter length alphabet, simultaneously.

> **Claim 8.2 — The doubling-letter length alphabet `h, i, j, k, l, m`** where each successive ASCII letter represents exactly twice the duration of the previous, mapped onto musical denominations 32nd, 16th, 8th, quarter, half, whole. To our knowledge, no prior music notation language uses adjacent letters as a binary doubling sequence for duration encoding. Most use either digits (`4` for quarter), digit-as-fraction (`1/4`), or names (`quarter`, `eighth`).

> **Claim 8.3 — Letter case as a carrier of articulation in pitched-note glyphs** — specifically, lowercase first-letter ⇒ slur start, uppercase length-letter ⇒ staccato. ABC uses case for octave, not articulation. `**kern` uses neither. LilyPond uses neither.

> **Claim 8.4 — The `[K+n]` transposition-shift operator as distinct from the `[K…]` original-key declaration** — a first-class language separation between *the key the piece was composed in* and *a user-driven semitone shift applied at playback time*, with automatic enharmonic re-spelling toward the new key's circle-of-fifths direction. We have not found this separation expressed as a language-level operator in any prior plain-text notation language.

> **Claim 8.5 — The `accidentalExplicit` flag at the AST pitch level**, distinguishing user-explicit accidentals from key-signature-implicit ones, as a substrate for downstream transposition and reharmonisation. This is at the type-system layer, not just the rendering layer.

> **Claim 8.6 — Header omission with extreme defaults** including the case where a `.hide` document has *no* header and parses correctly under Treble / 4-4 / C-major / DIV-32 defaults. ABC requires at least an `X:` index and `K:` key field; `**kern` requires `**kern` spines; LilyPond requires a `\score` and at least `\relative`; MusicXML and MEI require XML wrappers. `.hide` permits the body alone.

> **Claim 8.7 — The lyric escape operator `'`** that forces the next 3–4 character sequence to be parsed as lyric rather than as a note glyph. We claim this as a specific resolution of the lyric-vs-note ambiguity that arises uniquely in compact letter-based notations.

> **Claim 8.8 — The matrix-mode (v1.9) extension that turns `.hide` into a column-aligned multi-voice grid representation while preserving full backward compatibility with v1.8 stream layout** — that is, the *same parser* handles both stream and grid layouts because whitespace, bar lines, and line breaks are all lexically irrelevant. We believe this **upward-compatible grid mode** is novel; `**kern` is grid-only and ABC is stream-only.

> **Claim 8.9 — The tuplet syntax `N(...)`** where `N` is the *target duration in units* that the contents fit into, rather than a numerator/denominator ratio. This makes triplets (`8(...)` for an eighth-triplet sized to fit one quarter) unambiguous without context. The unit-based form is both compact and explicit about the resulting time footprint.

> **Claim 8.10 — The OMR-validated-by-compilation hybrid strategy** — using the `.hide` compiler as a real-time oracle for "is this LLM-transcribed staff valid?", with failure messages fed back to the LLM as a verification loop. We claim this as a system-level contribution to the OMR literature: not the constituent techniques, but the specific feedback architecture made possible by `.hide`'s compact, ambiguity-free, easily-compileable nature.

> **Claim 8.11 — The strategic positioning of `.hide` as a successor to `**kern` for the LLM era** — that is, the explicit design intent of providing a token-economical substitute for `**kern` in computational musicology, with publication of converted standard corpora (Bach chorales, etc.) as a basis for comparison. This is a research-direction claim, recorded here for priority purposes.

> **Claim 8.12 — The combined design** — the *gestalt* of (8.1)–(8.11) above, taken as a single integrated language. Even if some individual claims have precedents we are unaware of, we believe the *combination* of all of them in one language is unprecedented, and constitutes the originality of `.hide` as a whole.

---

## 9. Versioning timeline

We record the progression of `.hide` versions to fix the date of each design decision:

| Version | Date (approximate) | Key additions / changes |
|---|---|---|
| v1.1 | 2026-04 | Initial: pitch glyph `C4k`, chord (`C4E4G4k`), tuplet `N(...)`, rest `Rk`, tie `+`, lyrics, lyric escape `'`. |
| v1.2 | 2026-04 | Meta commands `[T120]` `[M3/4]` `[K+2]`, repeat `:body:N`, part switches `[S][A][T][B][P1]`. |
| v1.3 | 2026-04 | Accidentals `s/b/n` (sharp/flat/natural), whitespace and `;`-comment tolerance, `|` bar-line tolerance. |
| v1.5 | 2026-04 | Rule B (1-measure accidental memory). `accidentalExplicit` field on `HidePitch`. |
| v1.6 | 2026-04 | `[K+n]` semantic redefinition: from "key signature" to "transposition shift in semitones". Original key is now expressed via letter form `[KC]` `[KBb]` etc. |
| v1.8 | 2026-04 | **Header omission** — full `.hide` documents may have no header at all, with defaults Treble / 4-4 / C major / DIV=32. Short-form headers (e.g., `[Treble 4/4 KC D32]`) coexist with long-form (e.g., `[CLEF:TREBLE TIME:4/4 KEY:0 DIV:32]`). |
| v1.9 | 2026-04 | **Numbered + percussion part labels (the only multi-part model)** — general rule: a meta token whose content is exactly a sequence of digits or exactly the single letter `P` introduces a new part. `[1]..[N]` is for vocal parts; `[P]` is the optional voice-percussion track. Both the legacy SATB labels `[S][A][T][B]` and the legacy numbered-with-prefix `[P1]..[PN]` syntax have been **removed**; a four-part choral score is now written as `[1][2][3][4]`. *(implemented)*<br>**Matrix mode** — per-measure consistency checker, `iterateMeasures()` / `measureToChord()` API. The lexer emits `barline` raw tokens (silently ignored by the v1.8 stream parser, so v1.8 compileHide is bit-identical) and the new `analyzeMatrix()` walks the same raw stream to recover measures, then verifies that each measure has the same total duration across all parts. No `[GRID N]` strict-mode delimiter — part count is already obvious from the `[1]..[N]+[P]` declarations. Implemented in `src/hideMatrix.ts`, exported from `src/index.ts`, regression-tested in `src/hideMatrix.test.ts` (vitest) and `public/test_hide.html` (visual harness). *(implemented)* |

All versions to date have been developed by hide-sora as part of the *Hamoren* project. The reference implementation lives in the project source tree under `src/lib/hide/`.

> *Note on dates.* The dates above reflect the period during which `.hide` was conceived and first implemented. This priority paper is published on **2026-04-07**. The GitHub repository at https://github.com/hide-sora/.hide serves as the timestamp anchor for this document.

---

## 10. Limitations and future work

We document known limitations honestly:

- **No engraving control.** `.hide` does not (and intentionally will not) include layout, beaming, stem direction, page break, or any other typesetting directives. Users who need fine-grained engraving must use LilyPond, Finale, MuseScore, or Dorico. `.hide` delegates layout to MusicXML consumers.
- **No microtonal support beyond ±1 chromatic alteration.** Quarter-tones, just intonation, and other non-12-TET scales are out of scope for v1.x.
- **No instrument-specific notations.** Guitar tablature, drum set rudiments, harp pedals, etc., are out of scope.
- **No dynamic markings (`p`, `f`, `mp`, `cresc.`).** Could be added in a future version as meta commands but are deliberately omitted in v1.8 for vocabulary minimality.
- **Tempo changes are limited.** The current parser warns on dynamic tempo changes within the body; only the initial `[T...]` is fully supported in v1.8.
- **Time-signature changes are limited.** As above; warned but not fully wired into the compiler.
- **Matrix mode is implemented in the reference codebase** as of 2026-04 (`src/hideMatrix.ts`, exported from `src/index.ts` as `analyzeMatrix` / `iterateMeasures` / `measureToChord`, with per-measure duration consistency checking). What remains future work is consumer-side tooling that *uses* the matrix iterator — chord-extraction utilities, voice-leading analysers, and the LLM-prompt construction layer that turns measure slices into hamoring-suggestion queries.
- **Conversion *from* MusicXML to `.hide`** is implemented as `src/musicXmlToHide.ts` (with structured `MusicXmlToHideDiagnostic[]` output instead of silent normalization) and was used to deliver the Bach-chorales corpus port mentioned in §4.4 (`corpus/bach/`).

These limitations are deliberate scoping decisions, not oversights, and reflect the principle that vocabulary minimality is a load-bearing constraint.

---

## 11. Conclusion

We have introduced `.hide`, a plain-text symbolic music notation language designed for the joint constraints of LLM context economy and consumer-device practicality. We have specified version 1.8 in full, specified and **implemented** version 1.9's matrix-mode extension as a pure additive layer over the v1.8 stream parser, and enumerated twelve specific claims of originality (§8) along with explicit acknowledgement of prior art (§2).

The combination of design choices — 3-character pitched glyphs, doubling-letter durations, case-as-articulation, transposition decoupled from key, header omission with extreme defaults, parser-irrelevant whitespace enabling backward-compatible grid mode, OMR-validated-by-compilation, and a strategic intent to provide a token-economical successor to `**kern` for the LLM era — taken together, defines a representational stance that we believe is novel and useful.

This document is published as a **priority paper** to fix the design publicly with a verifiable timestamp. The reference implementation is part of the *Hamoren* project source tree and is available on request; the language specification itself is released under CC BY 4.0 so that researchers, implementers, and AI-system designers may build on it freely.

We welcome correction, refinement, and prior-art citations. We particularly welcome implementations in other languages and ports of standard musicology corpora into `.hide` for comparative study.

> *Citation suggestion.*
> hide-sora. (2026). *.hide: A Compact Symbolic Music Notation Language Designed for LLM-Era Multi-Voice Generation, Analysis, and Optical Music Recognition.* Priority paper, 2026-04-07. https://github.com/hide-sora/.hide

---

## 12. References

This priority paper deliberately keeps its bibliography short and focused on the works that materially influenced `.hide`'s design. URLs and dates are given to support timestamp verification and prior-art comparison.

1. **Walshaw, C. (1991–).** *ABC notation standard.* http://abcnotation.com/. The progenitor of plain-text letter-based music notation. Most directly comparable prior art for the compactness goal of `.hide`.
2. **Huron, D. (1994–).** *Humdrum and `**kern`.* http://www.humdrum.org/. The progenitor of grid-aligned multi-voice symbolic music representation. Most directly comparable prior art for `.hide`'s matrix-mode (v1.9) goal.
3. **Nienhuys, H.-W., & Nieuwenhuizen, J. (1996–).** *LilyPond: a system for music engraving.* http://lilypond.org/. The leading text-based music engraving system; an important comparison point for the "human-writable plain text" criterion.
4. **Good, M. (2001).** *MusicXML: An internet-friendly format for sheet music.* In Proceedings of XML 2001. The XML interop standard that `.hide` compiles to.
5. **Roland, P. (2002–).** *Music Encoding Initiative (MEI).* http://music-encoding.org/. The XML scholarly encoding standard.
6. **Cuthbert, M. S., & Ariza, C. (2010).** *music21: A Toolkit for Computer-Aided Musicology and Symbolic Music Data.* In Proceedings of the International Society for Music Information Retrieval (ISMIR). The Python library that brings `**kern` and other symbolic-music corpora into general computational reach.
7. **OpenSheetMusicDisplay contributors. (2016–).** *OpenSheetMusicDisplay (OSMD): MusicXML rendering for the web.* https://opensheetmusicdisplay.org/. The renderer used in the reference implementation.
8. **Mader, M., et al. (various).** *Audiveris: an open-source optical music recognition software.* https://github.com/Audiveris/audiveris. Representative of the heavy classical OMR tradition that motivated `.hide`'s lightweight hybrid approach.
9. **Sturm, B. L., et al. (2016).** *Music transcription modelling and composition using deep learning (folk-rnn).* arXiv:1604.08723. Representative of LLM-style music generation using ABC as the target representation.
10. **Hawthorne, C., et al. (2018).** *Enabling factorized piano music modeling and generation with the MAESTRO dataset (Music Transformer).* arXiv:1810.12247. Representative of MIDI-event tokenisation approaches.
11. **Anthropic. (2024–2026).** *Claude (Opus and Sonnet).* https://www.anthropic.com/. The LLM family used in the reference implementation's hybrid OMR backend.
12. **Hamoren Project. (2026).** *Hamoren — a-cappella practice platform.* https://hamoren.com. The host project in which `.hide` was designed and first implemented.

---

## Appendix A — BNF grammar (v1.8)

The following EBNF-style grammar specifies `.hide` v1.8. It is a literal description of the reference parser's accepted language.

```
document        ::= header? body
header          ::= "[" header-content "]"
header-content  ::= "" | long-form-header | short-form-header
long-form-header ::= long-form-element ( ws+ long-form-element )*
long-form-element ::= "CLEF:" clef-name
                    | "TIME:" digits "/" digits
                    | "KEY:" ( signed-int | key-letter )
                    | "DIV:" digits
short-form-header ::= short-element ( ws+ short-element )*
short-element   ::= clef-abbrev
                  | digits "/" digits                ; time signature
                  | "K" key-letter                   ; original key
                  | "K" sign digits                  ; transposition
                  | ( "DIV" | "D" ) digits           ; division

body            ::= body-token*
body-token      ::= note | rest | meta | tuplet | repeat | lyric | tie
                  | ws | "|" | comment

note            ::= pitch+ length-letter
pitch           ::= note-letter accidental? octave-digit
note-letter     ::= "A" | "B" | "C" | "D" | "E" | "F" | "G"
                  | "a" | "b" | "c" | "d" | "e" | "f" | "g"
accidental      ::= "s" | "#" | "b" | "n"
octave-digit    ::= "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
length-letter   ::= "h" | "i" | "j" | "k" | "l" | "m"
                  | "H" | "I" | "J" | "K" | "L" | "M"

rest            ::= "R" length-letter
tie             ::= "+"

meta            ::= "[" meta-content "]"
meta-content    ::= "T" digits                       ; tempo
                  | "M" digits "/" digits            ; time signature change
                  | "K" sign digits                  ; transposition shift
                  | "K" key-letter                   ; original key change
                  | "P"                              ; voice percussion part switch
                  | digits                           ; numbered vocal part switch
key-letter      ::= ( "A"–"G" ) ( "s" | "#" | "b" )? ( "m" | "min" | "maj" )?

tuplet          ::= digits "(" ( note | rest )+ ")"
repeat          ::= ":" body-token* ":" digits

lyric           ::= /* any character or sequence not matching above */
comment         ::= ";" /* until end of line */
ws              ::= " " | "\t" | "\n" | "\r"

sign            ::= "+" | "-"
digits          ::= [0-9]+
signed-int      ::= sign? digits
clef-name       ::= "TREBLE" | "BASS" | "ALTO" | "TENOR" | "PERCUSSION"
clef-abbrev     ::= "Treble" | "Bass" | "Alto" | "Tenor" | "Percussion"
                  | "T" | "B" | "A" | "Te" | "Al" | "Pe" | "N"
```

Notes on this grammar:

- The grammar is **deliberately context-free** at the lexer level. The only context-sensitive resolution is `[T...]` — `[T120]` is a tempo meta in body context, while `[T]` *at the very start of a document* is the short-form Treble-clef header. One character of lookahead disambiguates them, and the position-zero check handles the header-vs-body distinction.
- The lyric production is the *fallback* — anything that does not match the other productions becomes a lyric attached to the most recent note. This is what enables free-form lyric text without escaping.
- Whitespace, `|`, and comments are valid anywhere in the body and are simply skipped.

---

## Appendix B — Worked examples

### B.1 Minimal documents

A four-note ascending scale, no header:

```
C4kD4kE4kF4k
```

Full parse: 4 quarter notes C4, D4, E4, F4 in 4/4 treble C major (defaults), one bar of music.

A two-bar 3/4 waltz figure:

```
[3/4]
C4lD4k E4lF4k
```

Bar 1 = C-half + D-quarter; bar 2 = E-half + F-quarter. The `[3/4]` is a short-form header.

### B.2 Chord with lyric

A C major triad on the syllable "Ah":

```
C4E4G4kAh
```

Renders as a quarter-note C major triad with the syllable "Ah" attached.

### B.3 Transposition

A simple melody composed in C, transposed up two semitones for a higher voice:

```
[KC K+2]
C4kD4kE4kF4kG4kA4kB4kC5k
```

The displayed key signature becomes D major (2 sharps); each pitch is re-spelled into D major's sharp direction. The original key `C` is preserved in the AST.

### B.4 Multi-voice (v1.8/v1.9 stream form)

A simple four-voice cadence, stream form:

```
[1]C5kB4kC5k
[2]E4kE4kE4k
[3]G4kG4kG4k
[4]C3kG2kC3k
```

Voices are introduced by `[1]`, `[2]`, … in declaration order; this score therefore renders top-to-bottom as Voice 1, Voice 2, Voice 3, Voice 4. The same convention applies to any number of parts; a four-part choral piece, a five-part contemporary a-cappella arrangement, and a seven-part jazz vocal chart all use the same syntax.

### B.5 Multi-voice (v1.9 grid form, parsed identically)

The same content laid out as a grid:

```
[1]| C5k | B4k | C5k |
[2]| E4k | E4k | E4k |
[3]| G4k | G4k | G4k |
[4]| C3k | G2k | C3k |
```

The v1.8 stream lexer treats this as identical to B.4 because whitespace, line breaks, and `|` are all consumed transparently for `compileHide()` (the lexer emits a `barline` raw token that the stream parser silently skips). The v1.9 `analyzeMatrix()` walks the *same* raw token stream and recovers the measures, verifying that each measure has equal total duration across all parts.

### B.5b Six-member a-cappella (5 vocals + voice percussion)

A typical contemporary a-cappella ensemble has five vocal parts plus voice percussion. The numbered + percussion part syntax expresses this directly:

```
[1]C5kD5kE5kF5k
[2]G4kA4kB4kC5k
[3]E4kF4kG4kA4k
[4]C4kD4kE4kF4k
[5]C3kG3kC4kG3k
[P]C2kRkC2kRk
```

Voice 1 through Voice 5 are the vocal lines, and `[P]` is the voice-percussion track. The `[P]` line uses ordinary pitches (`C2k` here as a kick-drum-like low note) because the compiler does not currently force a percussion staff — it delegates engraving to MusicXML consumers. The internal MIDI program for `[P]` is the same as the vocal parts (53, Voice Oohs); playback consumers may remap to a drum sound if desired.

If the ensemble has no voice percussion, simply omit `[P]`: `[1][2][3][4][5]` is a complete five-vocal score.

### B.6 Triplet

A triplet of eighth notes filling one quarter:

```
8(C4jD4jE4j)
```

The target `8` is the unit-count for the triplet (one quarter); the contents would naturally take 12 units; the ratio 8:12 = 2:3 yields a triplet.

### B.7 Repeat

```
:C4kD4kE4kF4k:2
```

Plays the four notes twice (two total iterations).

### B.8 Tied note across bar line

```
C4l+C4k
```

A half C tied to a quarter C — equivalent to a dotted half C if no bar line intervenes.

### B.9 The shortest possible piece

The empty document has zero notes but is legal:

```
```

(parses to a single empty bar of rest under default 4/4). The shortest non-trivial document is:

```
Rk
```

(a single quarter rest).

---

## Appendix C — Token-density measurements

We measured the per-measure character cost of the same musical content (a 4-bar four-voice cadence) across notation languages, to substantiate the compactness claims of §6.1.

| Language | Encoding | Character count (full piece, no whitespace) | Per measure (4 bars / 4 voices) |
|---|---|---|---|
| **MusicXML 3.1** | XML, full attributes, partwise | ~3 800 | ~950 |
| **MEI** | XML, music encoding initiative | ~3 200 | ~800 |
| **`**kern`** | Humdrum, grid-aligned spines | ~280 | ~70 |
| **LilyPond** | text engraving language | ~210 | ~52 |
| **ABC** | letter-based plain text, V: voices | ~140 | ~35 |
| **`.hide` v1.8 (stream)** | letter-based, our language | ~110 | ~28 |
| **`.hide` v1.9 (grid, implemented)** | letter-based, columnar | ~130 | ~32 |

These numbers are illustrative, not benchmarks; they exclude headers and metadata, and they assume canonical encoding choices for each language. The point is the *order of magnitude*: `.hide` is roughly **30× more compact than MusicXML**, **2.5× more compact than `**kern`**, and **comparable to or slightly more compact than ABC** for the same musical content, while being the *only* language in the table that simultaneously offers (a) header omission, (b) backward-compatible grid mode, and (c) compile-to-MusicXML interoperability.

The converted Bach corpus is now part of this repository at `corpus/bach/hide/` (410 chorale-and-related movements from the *Music21* mirror, encompassing all 365 of the 4-part SATB chorales typically referenced as the "Bach 389-chorales" set plus 45 additional 5/6/7-part movements). A full per-language token-cost benchmark across this corpus is planned as a follow-up note; the corpus itself is sufficient for any third party to reproduce the comparison.

---

## License

- **This paper** (specification, prose, and grammar): released under **Creative Commons Attribution 4.0 International (CC BY 4.0)**. You may share, adapt, and build upon the work for any purpose, provided appropriate attribution to *hide-sora, ".hide" priority paper, 2026-04-07*.
- **The reference implementation** (TypeScript source under `src/lib/hide/` in the *Hamoren* project): released under the **MIT License** when published.

---

## Author and contact

**hide-sora**
Independent researcher and founder, *Hamoren* a-cappella practice platform
Project home: https://hamoren.com
Repository: https://github.com/hide-sora/.hide

This document was authored 2026-04-07 with editorial assistance from Claude (Anthropic).

---

*End of priority paper.*
