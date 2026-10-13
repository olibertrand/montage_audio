/* Formes d'onde : calcul des crêtes d'un fichier, dessin et mesures de niveau. */
(function (MA) {
  'use strict';
  const U = MA.U;
  const Clip = MA.Clip;

  const BASE = 256; // échantillons par crête au niveau le plus fin
  const FACTOR = 8;

  const Peaks = {};

  // Calcule min/max (toutes voies confondues) et énergie moyenne par bloc de 256 échantillons,
  // puis des niveaux plus grossiers pour les zooms arrière.
  Peaks.compute = (buffer) => {
    const n = buffer.length;
    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    const count = Math.ceil(n / BASE);
    const min = new Float32Array(count);
    const max = new Float32Array(count);
    const ms = new Float32Array(count); // moyenne des carrés
    const nc = chans.length;
    for (let i = 0; i < count; i++) {
      const s = i * BASE;
      const e = Math.min(n, s + BASE);
      let lo = 0;
      let hi = 0;
      let sq = 0;
      for (let c = 0; c < nc; c++) {
        const d = chans[c];
        for (let j = s; j < e; j++) {
          const v = d[j];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
          sq += v * v;
        }
      }
      min[i] = lo;
      max[i] = hi;
      ms[i] = sq / ((e - s) * nc);
    }
    const levels = [{ spp: BASE, min, max }];
    let prev = levels[0];
    while (prev.min.length > 64) {
      const len = Math.ceil(prev.min.length / FACTOR);
      const lmin = new Float32Array(len);
      const lmax = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        let lo = 0;
        let hi = 0;
        const e = Math.min(prev.min.length, (i + 1) * FACTOR);
        for (let j = i * FACTOR; j < e; j++) {
          if (prev.min[j] < lo) lo = prev.min[j];
          if (prev.max[j] > hi) hi = prev.max[j];
        }
        lmin[i] = lo;
        lmax[i] = hi;
      }
      prev = { spp: prev.spp * FACTOR, min: lmin, max: lmax };
      levels.push(prev);
    }
    return { sr: buffer.sampleRate, length: n, levels, ms, chans };
  };

  // [min, max] sur les échantillons [s0, s1).
  Peaks.range = (peaks, s0, s1) => {
    s0 = Math.max(0, s0);
    s1 = Math.min(peaks.length, s1);
    if (s1 <= s0) return [0, 0];
    const span = s1 - s0;
    let lo = 0;
    let hi = 0;
    if (span < BASE * 2) {
      for (const d of peaks.chans) {
        for (let j = s0; j < s1; j++) {
          const v = d[j];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      return [lo, hi];
    }
    let level = peaks.levels[0];
    for (const l of peaks.levels) if (l.spp * 2 <= span) level = l;
    const i0 = Math.floor(s0 / level.spp);
    const i1 = Math.min(level.min.length, Math.ceil(s1 / level.spp));
    for (let i = i0; i < i1; i++) {
      if (level.min[i] < lo) lo = level.min[i];
      if (level.max[i] > hi) hi = level.max[i];
    }
    return [lo, hi];
  };

  // Crête et sonie approximative (moyenne quadratique avec seuils, à la manière des mesures LUFS)
  // de la portion [t0, t1] (secondes du fichier source).
  Peaks.stats = (peaks, t0, t1) => {
    const s0 = Math.max(0, Math.floor(t0 * peaks.sr));
    const s1 = Math.min(peaks.length, Math.ceil(t1 * peaks.sr));
    const [lo, hi] = Peaks.range(peaks, s0, s1);
    const peak = Math.max(-lo, hi);
    const b0 = Math.floor(s0 / BASE);
    const b1 = Math.min(peaks.ms.length, Math.ceil(s1 / BASE));
    const win = Math.max(1, Math.round((0.4 * peaks.sr) / BASE));
    const windows = [];
    for (let b = b0; b < b1; b += win) {
      const e = Math.min(b1, b + win);
      let sum = 0;
      for (let i = b; i < e; i++) sum += peaks.ms[i];
      windows.push(sum / (e - b));
    }
    const audible = windows.filter((w) => w > 1e-7); // seuil absolu ~ -70 dB
    let loudness = -Infinity;
    if (audible.length) {
      const mean = audible.reduce((a, b) => a + b, 0) / audible.length;
      const gated = audible.filter((w) => w > mean * 0.1); // seuil relatif -10 dB
      const m = gated.reduce((a, b) => a + b, 0) / gated.length;
      loudness = 10 * Math.log10(m);
    }
    return { peak, peakDb: U.gainToDb(peak), loudness };
  };

  // Dessine la portion visible [t0, t1] (temps de la ligne de temps) d'un morceau.
  // La forme d'onde tient compte du volume, de la courbe et des fondus du morceau.
  Peaks.draw = (canvas, clip, peaks, t0, t1, zoom, color) => {
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, Math.round((t1 - t0) * zoom));
    const cssH = canvas.clientHeight || parseFloat(canvas.style.height) || 60;
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (!peaks) return;
    const mid = H / 2;
    const amp = H / 2 - dpr;
    g.fillStyle = color;
    const secPerPx = 1 / (zoom * dpr);
    const sr = peaks.sr;
    const shift = clip.offset - clip.start;
    for (let x = 0; x < W; x++) {
      const ta = t0 + x * secPerPx;
      const tb = ta + secPerPx;
      const sa = Math.floor((ta + shift) * sr);
      const sb = Math.max(sa + 1, Math.floor((tb + shift) * sr));
      const r = Peaks.range(peaks, sa, sb);
      const gain = Clip.gainAt(clip, (ta + tb) / 2);
      const top = mid - Math.min(1, r[1] * gain) * amp;
      const bot = mid - Math.max(-1, r[0] * gain) * amp;
      g.fillRect(x, top, 1, Math.max(dpr * 0.75, bot - top));
    }
  };

  MA.Peaks = Peaks;
})((window.MA = window.MA || {}));
