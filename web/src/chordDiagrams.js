// Chord diagrams: guitar fretboard + one-octave piano highlight, derived
// formulaically from two moveable barre shapes (E-shape and A-shape), with
// open-position overrides for the handful of chords normally taught open
// (C, D, Dm, G). Covers every major/minor label the backend can emit.
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Per-string offsets from the shape's root fret, low E to high e. null = muted.
const E_MAJ = [0, 2, 2, 1, 0, 0];
const E_MIN = [0, 2, 2, 0, 0, 0];
const A_MAJ = [null, 0, 2, 2, 2, 0];
const A_MIN = [null, 0, 2, 2, 1, 0];

// Chords with a nicer, widely-taught open-position shape than the barre
// formula would produce.
const OPEN_OVERRIDES = {
  C: [null, 3, 2, 0, 1, 0],
  D: [null, null, 0, 2, 3, 2],
  Dm: [null, null, 0, 2, 3, 1],
  G: [3, 2, 0, 0, 0, 3],
};

function fretFrom(rootIdx, shapeIdx) {
  return ((rootIdx - shapeIdx) % 12 + 12) % 12;
}

function parseLabel(label) {
  if (!label || label === "N" || label === "—") return null;
  const m = label.match(/^([A-G]#?)(m?)$/);
  return m ? { root: m[1], minor: !!m[2] } : null;
}

// { frets: (number|null)[6], baseFret } — baseFret is the lowest fret the
// shape occupies (0 = nut/open position).
export function guitarVoicing(label) {
  const p = parseLabel(label);
  if (!p) return null;
  const key = p.root + (p.minor ? "m" : "");
  if (OPEN_OVERRIDES[key]) return { frets: OPEN_OVERRIDES[key], baseFret: 0 };
  const rootIdx = NOTE_NAMES.indexOf(p.root);
  const fretE = fretFrom(rootIdx, NOTE_NAMES.indexOf("E"));
  const fretA = fretFrom(rootIdx, NOTE_NAMES.indexOf("A"));
  const useE = fretE <= fretA;
  const fret = useE ? fretE : fretA;
  const shape = useE ? (p.minor ? E_MIN : E_MAJ) : (p.minor ? A_MIN : A_MAJ);
  return { frets: shape.map((o) => (o == null ? null : o + fret)), baseFret: fret };
}

// Root/third/fifth as 0-11 semitone classes, for a one-octave piano highlight.
export function chordTones(label) {
  const p = parseLabel(label);
  if (!p) return null;
  const r = NOTE_NAMES.indexOf(p.root);
  return { root: r, third: (r + (p.minor ? 3 : 4)) % 12, fifth: (r + 7) % 12 };
}

const STRING_X = [10, 26, 42, 58, 74, 90];
const FRET_Y = [20, 40, 60, 80, 100];

export function guitarDiagramSVG(label) {
  const v = guitarVoicing(label);
  if (!v) return "";
  const { frets } = v;
  const atNut = frets.includes(0);
  const pressed = frets.filter((f) => f != null && f > 0);
  const startFret = pressed.length ? Math.min(...pressed) : 1;
  const win = atNut ? 0 : startFret;
  const firstShownFret = atNut ? 1 : win;

  let svg = `<svg viewBox="0 0 100 128" class="chord-fret">`;
  STRING_X.forEach((x) => { svg += `<line x1="${x}" y1="20" x2="${x}" y2="100" class="fret-string"/>`; });
  FRET_Y.forEach((y, i) => { svg += `<line x1="10" y1="${y}" x2="90" y2="${y}" class="${i === 0 && win === 0 ? "fret-nut" : "fret-line"}"/>`; });
  if (win > 0) svg += `<text x="2" y="16" class="fret-pos">${win}fr</text>`;

  const barreStrings = !atNut ? frets.map((f, i) => (f === startFret ? i : -1)).filter((i) => i >= 0) : [];
  if (barreStrings.length > 1) {
    const y = FRET_Y[0] + (FRET_Y[1] - FRET_Y[0]) / 2;
    svg += `<line x1="${STRING_X[barreStrings[0]]}" y1="${y}" x2="${STRING_X[barreStrings[barreStrings.length - 1]]}" y2="${y}" class="fret-barre"/>`;
  }

  frets.forEach((f, i) => {
    const x = STRING_X[i];
    if (f == null) { svg += `<text x="${x}" y="12" class="fret-mark">×</text>`; return; }
    if (f === 0) { svg += `<circle cx="${x}" cy="14" r="4" class="fret-open"/>`; return; }
    const rel = f - firstShownFret + 1;
    if (rel < 1 || rel > 4) return;
    const y = FRET_Y[rel - 1] + (FRET_Y[rel] - FRET_Y[rel - 1]) / 2;
    svg += `<circle cx="${x}" cy="${y}" r="6" class="fret-dot"/>`;
  });
  svg += `</svg>`;
  return svg;
}

const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];         // C D E F G A B
const BLACK_OFFSETS = [1, 3, null, 6, 8, 10, null];    // after C D _ F G A _

export function pianoDiagramSVG(label) {
  const t = chordTones(label);
  if (!t) return "";
  const on = new Set([t.root, t.third, t.fifth]);
  const wKeyW = 100 / 7;
  let svg = `<svg viewBox="0 0 100 60" class="chord-piano">`;
  WHITE_OFFSETS.forEach((semi, i) => {
    svg += `<rect x="${i * wKeyW}" y="0" width="${wKeyW}" height="60" class="${on.has(semi) ? "pk-white on" : "pk-white"}"/>`;
  });
  BLACK_OFFSETS.forEach((semi, i) => {
    if (semi == null) return;
    const x = (i + 1) * wKeyW - wKeyW * 0.18;
    svg += `<rect x="${x}" y="0" width="${wKeyW * 0.36}" height="36" class="${on.has(semi) ? "pk-black on" : "pk-black"}"/>`;
  });
  svg += `</svg>`;
  return svg;
}
