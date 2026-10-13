/* Projet d'exemple : trois pistes de musique synthétisées sur place (aucun fichier à télécharger). */
(function (MA) {
  'use strict';

  const SR = 44100;
  const BPM = 120;
  const BEAT = 60 / BPM;

  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // Bruit blanc reproductible (le même exemple à chaque fois).
  function noiseBuffer(ctx, seconds) {
    const len = Math.ceil(seconds * ctx.sampleRate);
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    let x = 123456789;
    for (let i = 0; i < len; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      d[i] = ((x >>> 0) / 4294967296) * 2 - 1;
    }
    return b;
  }

  function offline(seconds) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    return new OAC(2, Math.ceil(seconds * SR), SR);
  }

  // Nappe d'accords : la mineur, fa, do, sol (4 s chacun).
  async function renderPad() {
    const ctx = offline(17);
    const out = ctx.createGain();
    out.gain.value = 0.16;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    lp.Q.value = 0.4;
    out.connect(lp).connect(ctx.destination);
    const chords = [
      [57, 60, 64],
      [53, 57, 60],
      [55, 60, 64],
      [55, 59, 62],
    ];
    const roots = [45, 41, 48, 43];
    chords.forEach((notes, i) => {
      const t0 = i * 4;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(1, t0 + 0.7);
      env.gain.setValueAtTime(1, t0 + 3.6);
      env.gain.linearRampToValueAtTime(0, t0 + 5);
      env.connect(out);
      for (const n of notes) {
        [-7, 7].forEach((cents, k) => {
          const o = ctx.createOscillator();
          o.type = k ? 'sawtooth' : 'triangle';
          o.frequency.value = midiHz(n);
          o.detune.value = cents;
          const p = ctx.createStereoPanner();
          p.pan.value = k ? 0.45 : -0.45;
          o.connect(p).connect(env);
          o.start(t0);
          o.stop(t0 + 5.1);
        });
      }
      const bass = ctx.createOscillator();
      bass.type = 'sine';
      bass.frequency.value = midiHz(roots[i]);
      const bg = ctx.createGain();
      bg.gain.value = 1.6;
      bass.connect(bg).connect(env);
      bass.start(t0);
      bass.stop(t0 + 5.1);
    });
    return ctx.startRendering();
  }

  // Rythme : 4 mesures de grosse caisse, caisse claire et charleston.
  async function renderBeat() {
    const bars = 4;
    const ctx = offline(bars * 4 * BEAT);
    const out = ctx.createGain();
    out.gain.value = 0.7;
    out.connect(ctx.destination);
    const noise = noiseBuffer(ctx, 1);

    const kick = (t) => {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.14);
      const g = ctx.createGain();
      g.gain.setValueAtTime(1, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.5);
    };
    const snare = (t) => {
      const n = ctx.createBufferSource();
      n.buffer = noise;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1900;
      bp.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.55, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      const p = ctx.createStereoPanner();
      p.pan.value = 0.1;
      n.connect(bp).connect(g).connect(p).connect(out);
      n.start(t, 0.1);
      n.stop(t + 0.25);
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 190;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.35, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      o.connect(og).connect(out);
      o.start(t);
      o.stop(t + 0.12);
    };
    const hat = (t, open) => {
      const n = ctx.createBufferSource();
      n.buffer = noise;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 7500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(open ? 0.18 : 0.14, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.22 : 0.05));
      const p = ctx.createStereoPanner();
      p.pan.value = -0.35;
      n.connect(hp).connect(g).connect(p).connect(out);
      n.start(t, 0.4 + (t % 0.3));
      n.stop(t + 0.25);
    };

    for (let b = 0; b < bars * 4; b++) {
      const t = b * BEAT;
      if (b % 2 === 0) kick(t);
      if (b % 8 === 7) kick(t + BEAT / 2);
      if (b % 2 === 1) snare(t);
      hat(t, false);
      hat(t + BEAT / 2, b % 4 === 3);
    }
    return ctx.startRendering();
  }

  // Mélodie pincée avec un léger écho.
  async function renderMelody() {
    const ctx = offline(17);
    const dry = ctx.createGain();
    dry.gain.value = 0.32;
    const p = ctx.createStereoPanner();
    p.pan.value = 0.15;
    dry.connect(p).connect(ctx.destination);
    const delay = ctx.createDelay(1);
    delay.delayTime.value = BEAT * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    const wp = ctx.createStereoPanner();
    wp.pan.value = -0.5;
    dry.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(wet).connect(wp).connect(ctx.destination);

    // Une note par temps ; null = silence. Une ligne par accord.
    const phrase = [
      [76, null, 69, 72, 76, null, 74, 72],
      [72, null, 69, 72, 77, null, 76, 72],
      [79, null, 76, 72, 76, null, 79, 81],
      [74, null, 71, 74, 79, null, 74, 71],
    ];
    phrase.forEach((row, i) => {
      row.forEach((note, j) => {
        if (note == null) return;
        const t = i * 4 + j * BEAT;
        const len = j === 7 && i === 3 ? 1.6 : 0.7;
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = midiHz(note);
        const o2 = ctx.createOscillator();
        o2.type = 'sine';
        o2.frequency.value = midiHz(note + 12);
        const g2 = ctx.createGain();
        g2.gain.value = 0.25;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(1, t + 0.006);
        g.gain.exponentialRampToValueAtTime(0.001, t + len);
        o.connect(g);
        o2.connect(g2).connect(g);
        g.connect(dry);
        o.start(t);
        o2.start(t);
        o.stop(t + len + 0.05);
        o2.stop(t + len + 0.05);
      });
    });
    return ctx.startRendering();
  }

  // Construit le projet d'exemple et enregistre ses sons comme des fichiers importés.
  async function build(addSource) {
    const [pad, beat, melody] = await Promise.all([renderPad(), renderBeat(), renderMelody()]);
    const Store = MA.Store;
    const padSrc = await addSource(pad, 'Nappe (exemple).wav');
    const beatSrc = await addSource(beat, 'Rythme (exemple).wav');
    const melSrc = await addSource(melody, 'Mélodie (exemple).wav');

    const state = Store.emptyState();
    state.name = 'Exemple à explorer';
    Store.state = state;
    const tPad = Store.addTrack({ name: 'Ambiance', volume: -3 });
    const tBeat = Store.addTrack({ name: 'Rythme', volume: -5 });
    const tMel = Store.addTrack({ name: 'Mélodie', volume: -4, pan: 0.2 });
    const beatLen = beat.duration;

    Store.addClip({ trackId: tPad.id, sourceId: padSrc, name: 'Nappe', start: 0, duration: 16, fadeIn: 3 });
    Store.addClip({ trackId: tPad.id, sourceId: padSrc, name: 'Nappe', start: 16, duration: 16.6, fadeOut: 4 });
    for (let i = 0; i < 3; i++) {
      Store.addClip({
        trackId: tBeat.id,
        sourceId: beatSrc,
        name: 'Rythme',
        start: 8 + i * beatLen,
        duration: beatLen,
        fadeOut: i === 2 ? 2.5 : 0,
      });
    }
    Store.addClip({
      trackId: tMel.id,
      sourceId: melSrc,
      name: 'Mélodie',
      start: 16,
      duration: 16.6,
      fadeOut: 1.5,
      envelope: [
        { t: 7.6, g: 1 },
        { t: 8.2, g: 0.45 },
        { t: 11.6, g: 0.45 },
        { t: 12.2, g: 1 },
      ],
    });
    return state;
  }

  MA.Demo = { build };
})((window.MA = window.MA || {}));
