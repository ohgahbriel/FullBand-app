// Parses a pasted "chord sheet" — the plain-text chord-over-lyrics format
// used by sites like CifraClub or Ultimate Guitar (chords on their own line,
// positioned directly above the words they apply to). This module only turns
// text into structured rows; FullBand never fetches or scrapes this content
// itself — the user pastes it in from wherever they already have the right
// to view it, the same way they'd paste it into a text editor.

// A deliberately bounded chord-token matcher: root note, optional accidental,
// then one recognized quality/extension — US notation (m, 7, m7, maj7, sus4,
// sus2, dim, aug, add9, bare 6/9/11/13) as well as the Brazilian convention
// of suffixing "M" for major (7M/9M/11M/13M meaning maj7/maj9/etc, as used on
// sites like CifraClub) — an optional parenthesized alteration like "(b5)",
// and an optional slash bass note. Not a full chord-theory parser — narrow
// enough that ordinary capitalized words ("Baby", "Give") don't match, since
// real chord notation always ends in one of these suffixes and plain words
// don't. Exotic notations outside this list just fall through to being
// treated as a lyric line instead of a chord line — a safe, non-crashing
// degradation.
const CHORD_TOKEN =
  /^[A-G](?:#|b)?(?:maj7|m7|M7|7M|9M|11M|13M|m|7|9|11|13|sus4|sus2|dim|aug|add\d+|6|M)?(?:\([^)]{1,6}\))?(?:\/[A-G](?:#|b)?)?$/;
const LABEL_LINE = /^\s*\[.+\]\s*$/; // e.g. "[Chorus]", "[Verse 1]" — dropped, not synced

function isChordLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return trimmed.split(/\s+/).every((tok) => CHORD_TOKEN.test(tok));
}

// [{label, col}] — col is the character offset into the (untrimmed) line.
function chordPositions(line) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line))) out.push({ label: m[0], col: m.index });
  return out;
}

// Returns [{ text, chords: [{label, col}] }], in song order. `col` on each
// chord is re-based to the *trimmed* text's coordinate space, since that's
// what callers render/measure against. A chord line with no lyric line under
// it (e.g. an intro/instrumental bar) becomes a row with text: "".
export function parseChordSheet(input) {
  const lines = String(input).replace(/\r\n?/g, "\n").split("\n");
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || LABEL_LINE.test(line)) { i++; continue; }
    if (isChordLine(line)) {
      const raw = chordPositions(line);
      const next = lines[i + 1];
      const nextIsLyric = next != null && next.trim() && !isChordLine(next) && !LABEL_LINE.test(next);
      if (nextIsLyric) {
        const leading = next.length - next.trimStart().length;
        rows.push({
          text: next.trim(),
          chords: raw.map((c) => ({ label: c.label, col: Math.max(0, c.col - leading) })),
        });
        i += 2;
      } else {
        rows.push({ text: "", chords: raw });
        i += 1;
      }
    } else {
      rows.push({ text: line.trim(), chords: [] });
      i += 1;
    }
  }
  return rows;
}
