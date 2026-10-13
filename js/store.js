/* État du projet (pistes, morceaux), calculs de volume des morceaux et historique annuler/rétablir. */
(function (MA) {
  'use strict';
  const U = MA.U;

  const TRACK_COLORS = ['#4c8ee8', '#2fb3a3', '#e2588c', '#d9a52b', '#8f6ee8', '#63b64a', '#3fb0e0', '#e8744f'];

  /* ---------- Calculs sur un morceau (clip) ----------
     Un morceau joue la portion [offset, offset + duration] de son fichier source,
     placée à `start` secondes sur la ligne de temps.
     - gain : volume du morceau en dB
     - fadeIn / fadeOut : durées des fondus en secondes
     - envelope : points {t, g} de la courbe de volume ; t est exprimé en temps du
       fichier source (il reste donc juste quand on coupe ou rogne le morceau),
       g est un gain linéaire (1 = volume d'origine). */
  const Clip = {};

  Clip.end = (c) => c.start + c.duration;

  // Les deux fondus ne peuvent pas dépasser la durée du morceau.
  Clip.fades = (c) => {
    let fi = Math.max(0, c.fadeIn || 0);
    let fo = Math.max(0, c.fadeOut || 0);
    if (fi + fo > c.duration && fi + fo > 0) {
      const k = c.duration / (fi + fo);
      fi *= k;
      fo *= k;
    }
    return { fi, fo };
  };

  // Courbe des fondus « à puissance constante » : un fondu enchaîné entre deux
  // morceaux garde un niveau régulier.
  Clip.fadeCurve = (x) => Math.sin(U.clamp(x, 0, 1) * Math.PI / 2);

  Clip.fadeGainAt = (c, t) => {
    const local = t - c.start;
    if (local < 0 || local > c.duration) return 0;
    const { fi, fo } = Clip.fades(c);
    let g = 1;
    if (fi > 0 && local < fi) g *= Clip.fadeCurve(local / fi);
    if (fo > 0 && local > c.duration - fo) g *= Clip.fadeCurve((c.duration - local) / fo);
    return g;
  };

  // Valeur d'une suite de points {t, v} triés : linéaire entre les points,
  // constante avant le premier et après le dernier.
  Clip.interpolate = (points, t, key = 'v') => {
    if (!points.length) return 1;
    if (t <= points[0].t) return points[0][key];
    const last = points[points.length - 1];
    if (t >= last.t) return last[key];
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = points[lo];
    const b = points[hi];
    const span = b.t - a.t;
    if (span <= 0) return b[key];
    return a[key] + (b[key] - a[key]) * ((t - a.t) / span);
  };

  Clip.envelopeAtSource = (c, srcT) => (c.envelope && c.envelope.length ? Clip.interpolate(c.envelope, srcT, 'g') : 1);

  // Gain total du morceau à l'instant t de la ligne de temps (volume x courbe x fondus).
  Clip.gainAt = (c, t) =>
    U.dbToGain(c.gain || 0) * Clip.envelopeAtSource(c, c.offset + (t - c.start)) * Clip.fadeGainAt(c, t);

  // Points de la courbe de volume convertis en temps de la ligne de temps
  // (avec les valeurs aux bords du morceau), multipliés par le volume du morceau.
  Clip.envelopeBreakpoints = (c) => {
    const base = U.dbToGain(c.gain || 0);
    const end = Clip.end(c);
    const env = c.envelope || [];
    if (!env.length) return [{ t: c.start, v: base }, { t: end, v: base }];
    const pts = [{ t: c.start, v: base * Clip.envelopeAtSource(c, c.offset) }];
    for (const p of env) {
      const t = c.start + (p.t - c.offset);
      if (t > c.start && t < end) pts.push({ t, v: base * p.g });
    }
    pts.push({ t: end, v: base * Clip.envelopeAtSource(c, c.offset + c.duration) });
    return pts;
  };

  // Points des fondus (la courbe est échantillonnée, puis jouée par segments).
  Clip.fadeBreakpoints = (c, steps = 24) => {
    const { fi, fo } = Clip.fades(c);
    const end = Clip.end(c);
    const pts = [];
    if (fi > 0) {
      for (let i = 0; i <= steps; i++) pts.push({ t: c.start + (fi * i) / steps, v: Clip.fadeCurve(i / steps) });
    } else {
      pts.push({ t: c.start, v: 1 });
    }
    if (fo > 0) {
      for (let i = steps; i >= 0; i--) pts.push({ t: end - (fo * i) / steps, v: Clip.fadeCurve(i / steps) });
    } else {
      pts.push({ t: end, v: 1 });
    }
    return pts;
  };

  /* ---------- Atténuation automatique (« s'efface sous la voix ») ----------
     Une piste marquée `duck` baisse quand un morceau joue sur une autre piste
     audible qui n'est pas elle-même marquée. */
  const DUCK = { attack: 0.4, release: 0.8 };

  Clip.duckIntervals = (state) => {
    const anySolo = state.tracks.some((t) => t.solo);
    const voiceTracks = new Set(
      state.tracks.filter((t) => !t.duck && !t.mute && (!anySolo || t.solo)).map((t) => t.id)
    );
    const spans = state.clips
      .filter((c) => voiceTracks.has(c.trackId))
      .map((c) => [c.start, Clip.end(c)])
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    const gap = DUCK.attack + DUCK.release;
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1] + gap) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    return merged;
  };

  Clip.duckBreakpoints = (state, track) => {
    const low = U.dbToGain(track.duckDb == null ? -12 : track.duckDb);
    const pts = [];
    for (const [a, b] of Clip.duckIntervals(state)) {
      pts.push({ t: a - DUCK.attack, v: 1 }, { t: a, v: low }, { t: b, v: low }, { t: b + DUCK.release, v: 1 });
    }
    return pts;
  };
  Clip.DUCK = DUCK;

  /* ---------- Store ---------- */
  const Store = {
    state: null,
    sources: new Map(), // id -> {id, name, mime, data: ArrayBuffer, buffer: AudioBuffer, peaks}
    undoStack: [],
    redoStack: [],
    listeners: [],
    selection: new Set(), // ids des morceaux sélectionnés
    selectedTrackId: null,
    playhead: 0,
    clipboard: null,
    isDemo: false,
  };

  Store.emptyState = () => ({
    version: 1,
    name: 'Mon montage',
    master: 0,
    tracks: [],
    clips: [],
  });

  Store.subscribe = (fn) => Store.listeners.push(fn);

  // kind : 'mix' (volumes en direct), 'clips' (montage modifié), 'meta' (noms), 'all'
  Store.emit = (kind = 'all', opts = {}) => {
    for (const fn of Store.listeners) fn(kind, opts);
  };

  Store.load = (state, { keepHistory = false } = {}) => {
    Store.state = state;
    Store.selection.clear();
    if (!keepHistory) {
      Store.undoStack = [];
      Store.redoStack = [];
    }
    Store.selectedTrackId = state.tracks[0] ? state.tracks[0].id : null;
    Store.emit('all');
  };

  /* --- Historique --- */
  const snapshot = () => JSON.stringify(Store.state);

  Store.checkpoint = (label) => {
    Store.undoStack.push({ label, json: snapshot(), selection: [...Store.selection] });
    if (Store.undoStack.length > 300) Store.undoStack.shift();
    Store.redoStack = [];
  };

  Store.undo = () => {
    const entry = Store.undoStack.pop();
    if (!entry) return null;
    Store.redoStack.push({ label: entry.label, json: snapshot(), selection: [...Store.selection] });
    restore(entry);
    return entry.label;
  };

  Store.redo = () => {
    const entry = Store.redoStack.pop();
    if (!entry) return null;
    Store.undoStack.push({ label: entry.label, json: snapshot(), selection: [...Store.selection] });
    restore(entry);
    return entry.label;
  };

  function restore(entry) {
    Store.state = JSON.parse(entry.json);
    Store.selection = new Set(entry.selection.filter((id) => Store.clip(id)));
    if (!Store.track(Store.selectedTrackId)) Store.selectedTrackId = Store.state.tracks[0] ? Store.state.tracks[0].id : null;
    Store.emit('all');
  }

  // Raccourci : enregistre un point d'annulation, applique la modification, prévient l'interface.
  Store.transact = (label, fn, kind = 'clips') => {
    Store.checkpoint(label);
    const result = fn(Store.state);
    Store.emit(kind);
    return result;
  };

  /* --- Lecture --- */
  Store.track = (id) => (Store.state ? Store.state.tracks.find((t) => t.id === id) : null);
  Store.clip = (id) => (Store.state ? Store.state.clips.find((c) => c.id === id) : null);
  Store.trackIndex = (id) => Store.state.tracks.findIndex((t) => t.id === id);
  Store.clipsOf = (trackId) => Store.state.clips.filter((c) => c.trackId === trackId);
  Store.selectedClips = () => Store.state.clips.filter((c) => Store.selection.has(c.id));
  Store.projectEnd = () => Store.state.clips.reduce((m, c) => Math.max(m, Clip.end(c)), 0);
  Store.source = (id) => Store.sources.get(id);
  Store.sourceDuration = (id) => {
    const s = Store.sources.get(id);
    return s && s.buffer ? s.buffer.duration : 0;
  };

  /* --- Fabrication --- */
  Store.nextColor = () => {
    const used = Store.state.tracks.map((t) => t.color);
    const free = TRACK_COLORS.find((c) => !used.includes(c));
    return free || TRACK_COLORS[Store.state.tracks.length % TRACK_COLORS.length];
  };

  Store.makeTrack = (props = {}) => ({
    id: U.uid(),
    name: props.name || `Piste ${Store.state.tracks.length + 1}`,
    color: props.color || Store.nextColor(),
    volume: 0,
    pan: 0,
    mute: false,
    solo: false,
    duck: false,
    duckDb: -12,
    ...props,
  });

  Store.makeClip = (props) => ({
    id: U.uid(),
    trackId: null,
    sourceId: null,
    name: '',
    start: 0,
    offset: 0,
    duration: 0,
    gain: 0,
    fadeIn: 0,
    fadeOut: 0,
    envelope: [],
    ...props,
  });

  // Ajoute une piste (sans point d'annulation : à appeler dans une transaction).
  Store.addTrack = (props, index) => {
    const t = Store.makeTrack(props);
    if (index == null || index >= Store.state.tracks.length) Store.state.tracks.push(t);
    else Store.state.tracks.splice(Math.max(0, index), 0, t);
    return t;
  };

  Store.addClip = (props) => {
    const c = Store.makeClip(props);
    Store.state.clips.push(c);
    return c;
  };

  Store.removeClips = (ids) => {
    const set = new Set(ids);
    Store.state.clips = Store.state.clips.filter((c) => !set.has(c.id));
    for (const id of ids) Store.selection.delete(id);
  };

  Store.removeTrack = (id) => {
    Store.removeClips(Store.clipsOf(id).map((c) => c.id));
    Store.state.tracks = Store.state.tracks.filter((t) => t.id !== id);
    if (Store.selectedTrackId === id) Store.selectedTrackId = Store.state.tracks[0] ? Store.state.tracks[0].id : null;
  };

  // Coupe un morceau en deux à l'instant t. Renvoie le morceau de droite (ou null).
  Store.splitClip = (c, t) => {
    const minLen = 0.005;
    if (t <= c.start + minLen || t >= Clip.end(c) - minLen) return null;
    const leftDur = t - c.start;
    const right = Store.makeClip({
      ...JSON.parse(JSON.stringify(c)),
      id: U.uid(),
      start: t,
      offset: c.offset + leftDur,
      duration: c.duration - leftDur,
      fadeIn: 0,
      fadeOut: Math.min(c.fadeOut || 0, c.duration - leftDur),
    });
    c.duration = leftDur;
    c.fadeOut = 0;
    c.fadeIn = Math.min(c.fadeIn || 0, leftDur);
    Store.state.clips.push(right);
    return right;
  };

  // Copie profonde d'un morceau avec un nouvel identifiant.
  Store.cloneClip = (c, props) => ({ ...JSON.parse(JSON.stringify(c)), id: U.uid(), ...props });

  Store.effectiveTrackGain = (track, anySolo) => {
    if (track.mute) return 0;
    if (anySolo && !track.solo) return 0;
    return U.dbToGain(track.volume);
  };

  // Morceaux utilisés -> identifiants des fichiers sources nécessaires.
  Store.usedSourceIds = (state = Store.state) => new Set(state.clips.map((c) => c.sourceId));

  MA.Clip = Clip;
  MA.Store = Store;
  MA.TRACK_COLORS = TRACK_COLORS;
})((window.MA = window.MA || {}));
