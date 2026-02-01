const A4 = 440;
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

export function freqToNote(freqHz) {
  const midi = 69 + 12 * Math.log2(freqHz / A4);
  const midiRound = Math.round(midi);
  const noteIdx = (midiRound + 1200) % 12;
  const octave = Math.floor(midiRound / 12) - 1;
  const noteName = `${NOTE_NAMES[noteIdx]}${octave}`;
  const cents = Math.round((midi - midiRound) * 100);
  return { midi, midiRound, noteName, cents };
}
