'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, fakeBuffer } = require('./load');

const MA = load('util.js', 'store.js', 'peaks.js', 'formats.js');
const { U, Clip, Store, Peaks, Wav, Zip } = MA;

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('format du temps et des volumes en français', () => {
  assert.equal(U.formatTime(0), '0:00,0');
  assert.equal(U.formatTime(83.44), '1:23,4');
  assert.equal(U.formatTime(59.96), '1:00,0');
  assert.equal(U.formatTime(3725), '1:02:05,0');
  assert.equal(U.formatTime(5, 0), '0:05');
  assert.equal(U.formatDb(0), '0,0 dB');
  assert.equal(U.formatDb(-6.02), '−6,0 dB');
  assert.equal(U.formatDb(3.5), '+3,5 dB');
  assert.equal(U.formatDb(-Infinity), '−∞ dB');
  assert.equal(U.formatPan(0), 'Centre');
  assert.equal(U.formatPan(-0.3), 'G 30');
  assert.equal(U.formatSeconds(2.5), '2,5 s');
  assert.equal(U.formatSeconds(65), '1 min 05 s');
});

test('curseurs de volume : 0 dB au bon endroit, aller-retour exact', () => {
  near(U.faderToGain(1), 4);
  near(U.faderToDb(U.dbToFader(0)), 0, 1e-9);
  near(U.faderToDb(U.dbToFader(-12.5)), -12.5, 1e-9);
  assert.equal(U.faderToGain(0), 0);
  near(U.envPosToGain(U.envGainToPos(1)), 1);
  near(U.envPosToGain(1), 2);
});

test('fondus : courbe à puissance constante et limite à la durée', () => {
  const c = { start: 10, offset: 0, duration: 4, gain: 0, fadeIn: 3, fadeOut: 3, envelope: [] };
  const { fi, fo } = Clip.fades(c);
  near(fi, 2);
  near(fo, 2);
  near(Clip.fadeGainAt(c, 10), 0);
  near(Clip.fadeGainAt(c, 11), Math.SQRT1_2);
  near(Clip.fadeGainAt(c, 12), 1);
  near(Clip.fadeGainAt(c, 14), 0);
  assert.equal(Clip.fadeGainAt(c, 9), 0);
  // fondu enchaîné : la puissance totale reste constante
  for (const x of [0, 0.25, 0.5, 0.9]) near(Clip.fadeCurve(x) ** 2 + Clip.fadeCurve(1 - x) ** 2, 1);
});

test('courbe de volume : interpolation et repères de la ligne de temps', () => {
  const c = { start: 5, offset: 2, duration: 4, gain: U.gainToDb(0.5), envelope: [{ t: 3, g: 1 }, { t: 4, g: 0.5 }] };
  near(Clip.envelopeAtSource(c, 2), 1);
  near(Clip.envelopeAtSource(c, 3.5), 0.75);
  near(Clip.envelopeAtSource(c, 5), 0.5);
  const pts = Clip.envelopeBreakpoints(c);
  assert.deepEqual(pts.map((p) => +p.t.toFixed(6)), [5, 6, 7, 9]);
  assert.deepEqual(pts.map((p) => +p.v.toFixed(6)), [0.5, 0.5, 0.25, 0.25]);
  near(Clip.gainAt({ ...c, fadeIn: 0, fadeOut: 0 }, 6.5), 0.5 * 0.75);
});

test('couper un morceau garde le son au même endroit', () => {
  Store.state = Store.emptyState();
  const t = Store.addTrack({ name: 'A' });
  const c = Store.addClip({ trackId: t.id, sourceId: 's', start: 2, offset: 1, duration: 6, fadeIn: 1, fadeOut: 2, envelope: [{ t: 4, g: 0.5 }] });
  const right = Store.splitClip(c, 5);
  assert.ok(right);
  assert.deepEqual([c.start, c.offset, c.duration, c.fadeIn, c.fadeOut], [2, 1, 3, 1, 0]);
  assert.deepEqual([right.start, right.offset, right.duration, right.fadeIn, right.fadeOut], [5, 4, 3, 0, 2]);
  assert.notEqual(right.id, c.id);
  assert.deepEqual(right.envelope, c.envelope);
  assert.notEqual(right.envelope, c.envelope);
  assert.equal(Store.splitClip(c, 2), null);
  assert.equal(Store.state.clips.length, 2);
});

test('annuler / rétablir', () => {
  Store.state = Store.emptyState();
  Store.undoStack = [];
  Store.redoStack = [];
  Store.transact('Ajouter', () => Store.addTrack({ name: 'Voix' }));
  Store.transact('Renommer', () => (Store.state.tracks[0].name = 'Musique'));
  assert.equal(Store.undo(), 'Renommer');
  assert.equal(Store.state.tracks[0].name, 'Voix');
  assert.equal(Store.undo(), 'Ajouter');
  assert.equal(Store.state.tracks.length, 0);
  assert.equal(Store.redo(), 'Ajouter');
  assert.equal(Store.redo(), 'Renommer');
  assert.equal(Store.state.tracks[0].name, 'Musique');
  assert.equal(Store.redo(), null);
});

test('effacement automatique : intervalles fusionnés, pistes muettes ignorées', () => {
  const state = {
    tracks: [
      { id: 'v', mute: false, solo: false, duck: false },
      { id: 'm', mute: false, solo: false, duck: true },
      { id: 'x', mute: true, solo: false, duck: false },
    ],
    clips: [
      { trackId: 'v', start: 0, duration: 2 },
      { trackId: 'v', start: 2.5, duration: 1 },
      { trackId: 'v', start: 10, duration: 1 },
      { trackId: 'x', start: 20, duration: 1 },
      { trackId: 'm', start: 0, duration: 30 },
    ],
  };
  assert.deepEqual(Clip.duckIntervals(state), [[0, 3.5], [10, 11]]);
});

test('formes d’onde : crêtes et mesures de niveau', () => {
  // 4 s à 8192 Hz : 2 s à l'amplitude 0,5 puis 2 s à 0,25 (soit 6 dB de moins)
  const sr = 8192;
  const a = new Float32Array(4 * sr);
  for (let i = 0; i < a.length; i++) a[i] = (i < 2 * sr ? 0.5 : 0.25) * Math.sin(i / 3);
  const peaks = Peaks.compute(fakeBuffer([a], sr));
  const [lo, hi] = Peaks.range(peaks, 0, a.length);
  near(hi, 0.5, 0.01);
  near(lo, -0.5, 0.01);
  const first = Peaks.stats(peaks, 0, 2);
  const second = Peaks.stats(peaks, 2, 4);
  near(first.peak, 0.5, 0.01);
  near(first.loudness - second.loudness, 20 * Math.log10(2), 0.05);
  const silent = Peaks.stats(Peaks.compute(fakeBuffer([new Float32Array(3000)], sr)), 0, 3);
  assert.equal(silent.peak, 0);
  assert.equal(silent.loudness, -Infinity);
});

test('WAV 16 bits : en-tête et échantillons', () => {
  const buf = Wav.encode([new Float32Array([0, 1, -1, 0.5]), new Float32Array([0, -1, 2, -0.5])], 44100);
  const v = new DataView(buf);
  const str = (o) => String.fromCharCode(...new Uint8Array(buf, o, 4));
  assert.equal(str(0), 'RIFF');
  assert.equal(str(8), 'WAVE');
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint32(40, true), 16);
  const s = new Int16Array(buf, 44);
  assert.deepEqual([...s], [0, 0, 32767, -32768, -32768, 32767, 16384, -16384]);
});

test('archive ZIP : aller-retour', async () => {
  const bytes = new Uint8Array(1000).map((_, i) => i % 251);
  const blob = Zip.create([
    { name: 'projet.json', data: JSON.stringify({ ok: 'é' }) },
    { name: 'sons/a.wav', data: bytes },
  ]);
  const files = await Zip.read(await blob.arrayBuffer());
  assert.deepEqual([...files.keys()], ['projet.json', 'sons/a.wav']);
  assert.deepEqual(JSON.parse(Zip.text(files.get('projet.json'))), { ok: 'é' });
  assert.deepEqual([...files.get('sons/a.wav')], [...bytes]);
  assert.equal(Zip.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});
