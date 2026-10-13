/* Ligne de temps : pistes, morceaux, règle, tête de lecture et manipulations à la souris. */
(function (MA) {
  'use strict';
  const { U, Store, Clip, Peaks } = MA;

  const LABEL_H = 18; // bandeau du nom en haut de chaque morceau
  const ENV_PAD = 5; // marge haute et basse de la courbe de volume
  const SNAP_PX = 8;
  const FADE_MIN_X = 7; // les poignées de fondu restent visibles même sans fondu
  const MIN_ZOOM = 0.3;
  const MAX_ZOOM = 3000;

  const TL = {
    zoom: 40, // pixels par seconde
    headerW: 232,
    contentW: 0,
    snap: true,
    rows: new Map(), // trackId -> références DOM
    clips: new Map(), // clipId -> références DOM
    drag: null,
    colors: {},
    MIN_ZOOM,
    MAX_ZOOM,
  };
  let els = {};
  let wavesQueued = false;
  let rulerQueued = false;

  /* ---------- Repères ---------- */
  TL.timeAt = (clientX) => {
    const r = els.scroller.getBoundingClientRect();
    return (clientX - r.left - TL.headerW + els.scroller.scrollLeft) / TL.zoom;
  };

  TL.viewWidth = () => Math.max(50, els.scroller.clientWidth - TL.headerW);

  TL.viewRange = () => {
    const t0 = els.scroller.scrollLeft / TL.zoom;
    return [t0, t0 + TL.viewWidth() / TL.zoom];
  };

  // Indice de la piste sous l'ordonnée clientY (tracks.length = sous la dernière piste).
  TL.trackIndexAtY = (clientY) => {
    const tracks = Store.state.tracks;
    for (let i = 0; i < tracks.length; i++) {
      const refs = TL.rows.get(tracks[i].id);
      if (!refs) continue;
      const r = refs.el.getBoundingClientRect();
      if (clientY < r.bottom) return i;
    }
    return tracks.length;
  };

  TL.readMetrics = () => {
    const cs = getComputedStyle(document.documentElement);
    TL.headerW = parseFloat(cs.getPropertyValue('--head-w')) || 232;
    const get = (n) => cs.getPropertyValue(n).trim();
    TL.colors = {
      env: get('--env-line'),
      envDim: get('--env-dim'),
      fadeShade: get('--fade-shade'),
      fadeLine: get('--fade-line'),
      surface: get('--surface-2'),
      tick: get('--muted'),
      tickMinor: get('--line-strong'),
      text: get('--fg'),
      accent: get('--accent'),
      rulerBg: get('--surface'),
      font: get('--font-mono') || 'monospace',
      ok: get('--ok'),
      warn: get('--warn'),
      danger: get('--danger'),
      meterBg: get('--meter-bg'),
    };
  };

  /* ---------- Rendu ---------- */
  TL.init = (refs) => {
    els = refs;
    TL.readMetrics();
    bindEvents();
  };

  TL.render = () => {
    if (!Store.state) return;
    renderTracks();
    renderClips();
    TL.updateSize();
    TL.queueRuler();
    TL.updatePlayhead();
    els.empty.hidden = Store.state.clips.length > 0;
  };

  TL.invalidateWaves = () => {
    for (const refs of TL.clips.values()) refs.drawn = null;
    TL.queueWaves();
  };

  TL.updateSize = () => {
    const viewW = TL.viewWidth();
    let end = Store.projectEnd();
    if (TL.drag && TL.drag.maxEnd) end = Math.max(end, TL.drag.maxEnd);
    const tail = Math.max(15, (viewW * 0.4) / TL.zoom);
    const contentW = Math.max(viewW, Math.ceil((end + tail) * TL.zoom));
    if (contentW !== TL.contentW) {
      TL.contentW = contentW;
      els.inner.style.width = TL.headerW + contentW + 'px';
    }
    const step = rulerSteps().major * TL.zoom;
    els.inner.style.setProperty('--grid-step', step + 'px');
  };

  function renderTracks() {
    const tracks = Store.state.tracks;
    const seen = new Set();
    tracks.forEach((t, i) => {
      let refs = TL.rows.get(t.id);
      if (!refs) {
        refs = buildRow(t.id);
        TL.rows.set(t.id, refs);
      }
      updateRow(t, refs, i);
      if (els.tracks.children[i] !== refs.el) els.tracks.insertBefore(refs.el, els.tracks.children[i] || null);
      seen.add(t.id);
    });
    for (const [id, refs] of TL.rows) {
      if (!seen.has(id)) {
        refs.el.remove();
        TL.rows.delete(id);
      }
    }
  }

  function buildRow(trackId) {
    const icon = MA.icon;
    const track = () => Store.track(trackId);
    const row = U.el('div', { class: 'track-row', dataset: { trackId } });
    const head = U.el('div', { class: 'track-head' });
    const color = U.el('button', { class: 'th-color', type: 'button', title: 'Changer la couleur', 'aria-label': 'Changer la couleur de la piste' });
    const name = U.el('input', { class: 'th-name', type: 'text', 'aria-label': 'Nom de la piste', spellcheck: 'false' });
    const more = U.el('button', { class: 'btn icon-only small th-more', type: 'button', title: 'Autres réglages de la piste', 'aria-label': 'Autres réglages de la piste', html: icon('more') });
    const mute = U.el('button', { class: 'toggle th-mute', type: 'button', title: 'Couper le son de cette piste (muet)', text: 'Muet' });
    const solo = U.el('button', { class: 'toggle th-solo', type: 'button', title: 'N’écouter que cette piste (solo)', text: 'Solo' });
    const duck = U.el('span', { class: 'th-duck', title: 'Cette piste baisse automatiquement quand une autre piste joue', html: icon('duck', 14) + '<span>S’efface</span>' });
    const meter = U.el('div', { class: 'th-meter', 'aria-hidden': 'true' }, [U.el('div', { class: 'cover' })]);
    const volId = 'vol-' + trackId;
    const panId = 'pan-' + trackId;
    const vol = U.el('input', { class: 'th-vol', id: volId, type: 'range', min: 0, max: 1000, step: 4, title: 'Volume de la piste (double-clic : 0 dB)' });
    const volOut = U.el('output', { class: 'th-val', for: volId });
    const pan = U.el('input', { class: 'th-pan', id: panId, type: 'range', min: -100, max: 100, step: 1, title: 'Balance gauche / droite (double-clic : centre)' });
    const panOut = U.el('output', { class: 'th-val', for: panId });

    head.append(
      U.el('div', { class: 'th-top' }, [color, name, more]),
      U.el('div', { class: 'th-buttons' }, [mute, solo, duck, meter]),
      U.el('div', { class: 'th-slider' }, [U.el('label', { for: volId, class: 'th-label', text: 'Volume' }), vol, volOut]),
      U.el('div', { class: 'th-slider th-pan-row' }, [U.el('label', { for: panId, class: 'th-label', text: 'Balance' }), pan, panOut])
    );
    const lane = U.el('div', { class: 'lane', dataset: { trackId } });
    row.append(head, lane);

    head.addEventListener('pointerdown', () => MA.App.selectTrack(trackId));

    name.addEventListener('change', () => {
      const v = name.value.trim() || 'Piste';
      if (v !== track().name) Store.transact('Renommer la piste', () => (track().name = v), 'meta');
    });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') name.blur();
    });

    mute.addEventListener('click', () => {
      const t = track();
      Store.transact(t.mute ? 'Réactiver la piste' : 'Rendre muette la piste', () => (t.mute = !t.mute), 'mix');
    });
    solo.addEventListener('click', () => {
      const t = track();
      Store.transact(t.solo ? 'Désactiver le solo' : 'Écouter en solo', () => (t.solo = !t.solo), 'mix');
    });

    MA.UI.bindSlider(vol, {
      label: 'Volume de la piste',
      read: () => U.dbToFader(track().volume) * 1000,
      write: (v) => {
        const db = U.faderToDb(v / 1000);
        track().volume = isFinite(db) ? Math.round(db * 10) / 10 : -100;
      },
      reset: () => (track().volume = 0),
      kind: 'mix',
      out: () => (volOut.textContent = U.formatDb(track().volume)),
    });
    MA.UI.bindSlider(pan, {
      label: 'Balance de la piste',
      read: () => Math.round((track().pan || 0) * 100),
      write: (v) => (track().pan = Math.abs(v) < 3 ? 0 : v / 100),
      reset: () => (track().pan = 0),
      kind: 'mix',
      out: () => (panOut.textContent = U.formatPan(track().pan || 0)),
    });

    more.addEventListener('click', () => MA.UI.trackMenu(trackId, more));
    color.addEventListener('click', () => MA.UI.colorMenu(trackId, color));

    return { el: row, head, lane, color, name, mute, solo, duck, meterCover: meter.firstChild, vol, volOut, pan, panOut, duckZones: [] };
  }

  function updateRow(t, refs) {
    refs.el.style.setProperty('--track-color', t.color);
    refs.el.classList.toggle('selected', Store.selectedTrackId === t.id);
    const anySolo = Store.state.tracks.some((x) => x.solo);
    refs.el.classList.toggle('silent', t.mute || (anySolo && !t.solo));
    if (document.activeElement !== refs.name) refs.name.value = t.name;
    refs.mute.setAttribute('aria-pressed', String(!!t.mute));
    refs.solo.setAttribute('aria-pressed', String(!!t.solo));
    refs.duck.hidden = !t.duck;
    if (!refs.vol.matches(':active')) refs.vol.value = U.dbToFader(t.volume) * 1000;
    if (!refs.pan.matches(':active')) refs.pan.value = Math.round((t.pan || 0) * 100);
    refs.volOut.textContent = U.formatDb(t.volume);
    refs.panOut.textContent = U.formatPan(t.pan || 0);
  }

  function buildClip(clipId) {
    const el = U.el('div', { class: 'clip', dataset: { clipId } });
    const canvas = U.el('canvas', { class: 'wave' });
    const name = U.el('span', { class: 'clip-name' });
    const badge = U.el('span', { class: 'clip-badge' });
    const label = U.el('div', { class: 'clip-label' }, [name, badge]);
    const fin = U.el('div', { class: 'fade-handle fade-in', title: 'Glisser pour régler le fondu d’entrée' });
    const fout = U.el('div', { class: 'fade-handle fade-out', title: 'Glisser pour régler le fondu de sortie' });
    el.append(canvas, label, fin, fout);
    return { el, canvas, name, badge, fin, fout, drawn: null };
  }

  function renderClips() {
    const seen = new Set();
    for (const c of Store.state.clips) {
      const row = TL.rows.get(c.trackId);
      if (!row) continue;
      let refs = TL.clips.get(c.id);
      if (!refs) {
        refs = buildClip(c.id);
        TL.clips.set(c.id, refs);
      }
      if (refs.el.parentNode !== row.lane) row.lane.append(refs.el);
      updateClip(c, refs);
      seen.add(c.id);
    }
    for (const [id, refs] of TL.clips) {
      if (!seen.has(id)) {
        refs.el.remove();
        TL.clips.delete(id);
      }
    }
    renderDuckZones();
    TL.queueWaves();
  }
  TL.renderClips = renderClips;

  function updateClip(c, refs) {
    const track = Store.track(c.trackId);
    const left = c.start * TL.zoom;
    const width = Math.max(2, c.duration * TL.zoom);
    refs.el.style.left = left + 'px';
    refs.el.style.width = width + 'px';
    refs.el.style.setProperty('--clip-color', track ? track.color : '#888');
    refs.el.classList.toggle('selected', Store.selection.has(c.id));
    refs.el.classList.toggle('narrow', width < 36);
    refs.el.classList.toggle('missing', !Store.source(c.sourceId));
    const label = c.name || 'Morceau';
    if (refs.name.textContent !== label) refs.name.textContent = label;
    const badge = Math.abs(c.gain || 0) >= 0.05 ? U.formatDb(c.gain) : '';
    if (refs.badge.textContent !== badge) refs.badge.textContent = badge;
    refs.badge.hidden = !badge;
    const { fi, fo } = Clip.fades(c);
    refs.fin.style.left = Math.max(FADE_MIN_X, fi * TL.zoom) + 'px';
    refs.fout.style.right = Math.max(FADE_MIN_X, fo * TL.zoom) + 'px';
    refs.el.title = `${label} — début ${U.formatTime(c.start)}, durée ${U.formatSeconds(c.duration)}`;
  }

  function renderDuckZones() {
    const duckTracks = Store.state.tracks.filter((t) => t.duck);
    const intervals = duckTracks.length ? Clip.duckIntervals(Store.state) : [];
    for (const [id, refs] of TL.rows) {
      const t = Store.track(id);
      const wanted = t && t.duck ? intervals : [];
      while (refs.duckZones.length > wanted.length) refs.duckZones.pop().remove();
      wanted.forEach(([a, b], i) => {
        let z = refs.duckZones[i];
        if (!z) {
          z = U.el('div', { class: 'duck-zone', title: 'Volume baissé automatiquement ici' });
          refs.lane.prepend(z);
          refs.duckZones.push(z);
        }
        const x0 = (a - Clip.DUCK.attack) * TL.zoom;
        z.style.left = x0 + 'px';
        z.style.width = (b + Clip.DUCK.release - (a - Clip.DUCK.attack)) * TL.zoom + 'px';
        z.style.setProperty('--ramp-in', Clip.DUCK.attack * TL.zoom + 'px');
        z.style.setProperty('--ramp-out', Clip.DUCK.release * TL.zoom + 'px');
      });
    }
  }

  /* ---------- Formes d'onde ---------- */
  TL.queueWaves = () => {
    if (wavesQueued) return;
    wavesQueued = true;
    requestAnimationFrame(drawWaves);
  };

  function signature(c, selected, dpr, h) {
    const src = Store.source(c.sourceId);
    return [
      TL.zoom, c.start, c.offset, c.duration, c.gain, c.fadeIn, c.fadeOut,
      JSON.stringify(c.envelope), selected ? 1 : 0, dpr, h, src && src.peaks ? 1 : 0,
      Store.track(c.trackId) ? Store.track(c.trackId).color : '', TL.colors.env,
    ].join('|');
  }

  function drawWaves() {
    wavesQueued = false;
    if (!Store.state) return;
    const [v0, v1] = TL.viewRange();
    const margin = (v1 - v0) * 0.5;
    const dpr = window.devicePixelRatio || 1;
    for (const c of Store.state.clips) {
      const refs = TL.clips.get(c.id);
      if (!refs) continue;
      const end = Clip.end(c);
      const visA = Math.max(c.start, v0);
      const visB = Math.min(end, v1);
      if (visB <= visA) continue;
      const selected = Store.selection.has(c.id);
      const h = refs.canvas.clientHeight;
      const sig = signature(c, selected, dpr, h);
      const d = refs.drawn;
      if (d && d.sig === sig && d.a <= visA + 1e-6 && d.b >= visB - 1e-6) continue;
      const a = Math.max(c.start, v0 - margin);
      const b = Math.min(end, v1 + margin);
      refs.canvas.style.left = (a - c.start) * TL.zoom + 'px';
      refs.canvas.style.width = Math.max(1, (b - a) * TL.zoom) + 'px';
      const src = Store.source(c.sourceId);
      const track = Store.track(c.trackId);
      Peaks.draw(refs.canvas, c, src && src.peaks, a, b, TL.zoom, track ? track.color : '#888');
      drawOverlays(refs.canvas, c, a, b, selected);
      refs.drawn = { sig, a, b };
    }
  }

  // Ordonnée (px CSS, relative au morceau) d'un gain de courbe de volume.
  function envY(gain, clipH) {
    const h = clipH - LABEL_H - ENV_PAD * 2;
    return LABEL_H + ENV_PAD + (1 - U.envGainToPos(gain)) * h;
  }
  function envGainAtY(y, clipH) {
    const h = clipH - LABEL_H - ENV_PAD * 2;
    let pos = 1 - (y - LABEL_H - ENV_PAD) / h;
    pos = U.clamp(pos, 0, 1);
    let g = U.envPosToGain(pos);
    if (Math.abs(pos - U.envGainToPos(1)) < 0.025) g = 1; // aimanté sur le volume d'origine
    return g;
  }

  function drawOverlays(canvas, c, a, b, selected) {
    const g = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const H = canvas.height;
    const x = (t) => (t - a) * TL.zoom * dpr;
    const { fi, fo } = Clip.fades(c);
    const end = Clip.end(c);
    const N = 32;
    g.lineWidth = 1.5 * dpr;
    const fade = (t0, len, rising) => {
      if (len <= 0 || t0 > b || t0 + len < a) return;
      g.beginPath();
      g.moveTo(x(t0), 0);
      for (let i = 0; i <= N; i++) {
        const k = i / N;
        const v = Clip.fadeCurve(rising ? k : 1 - k);
        g.lineTo(x(t0 + len * k), (1 - v) * H);
      }
      g.lineTo(x(t0 + len), 0);
      g.closePath();
      g.fillStyle = TL.colors.fadeShade;
      g.fill();
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        const k = i / N;
        const v = Clip.fadeCurve(rising ? k : 1 - k);
        const px = x(t0 + len * k);
        const py = (1 - v) * H;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.strokeStyle = TL.colors.fadeLine;
      g.stroke();
    };
    fade(c.start, fi, true);
    fade(end - fo, fo, false);

    const env = c.envelope || [];
    if (!selected && !env.length) return;
    // La courbe est dessinée dans le repère du canevas (qui commence sous le bandeau du nom).
    const clipH = H / dpr + LABEL_H;
    const y = (gain) => (envY(gain, clipH) - LABEL_H) * dpr;
    const pts = [{ t: a, g: Clip.envelopeAtSource(c, c.offset + (a - c.start)) }];
    for (const p of env) {
      const t = c.start + (p.t - c.offset);
      if (t > a && t < b) pts.push({ t, g: p.g, real: true });
    }
    pts.push({ t: b, g: Clip.envelopeAtSource(c, c.offset + (b - c.start)) });
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(x(p.t), y(p.g)) : g.moveTo(x(p.t), y(p.g))));
    g.strokeStyle = selected ? TL.colors.env : TL.colors.envDim;
    g.lineWidth = (selected ? 2 : 1.5) * dpr;
    g.stroke();
    if (selected) {
      for (const p of pts) {
        if (!p.real) continue;
        g.beginPath();
        g.arc(x(p.t), y(p.g), 4.5 * dpr, 0, Math.PI * 2);
        g.fillStyle = TL.colors.env;
        g.fill();
        g.lineWidth = 1.5 * dpr;
        g.strokeStyle = TL.colors.surface;
        g.stroke();
      }
    }
  }

  /* ---------- Règle ---------- */
  function rulerSteps() {
    const steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    let major = steps[steps.length - 1];
    for (const s of steps) {
      if (s * TL.zoom >= 90) {
        major = s;
        break;
      }
    }
    const minorDiv = [0.05, 0.5, 5, 50, 300].includes(major) ? 5 : [15, 900].includes(major) ? 3 : [1, 10, 60, 600, 3600, 0.1].includes(major) ? 4 : 2;
    return { major, minor: major / minorDiv };
  }

  TL.queueRuler = () => {
    if (rulerQueued) return;
    rulerQueued = true;
    requestAnimationFrame(() => {
      rulerQueued = false;
      drawRuler();
    });
  };

  function drawRuler() {
    const canvas = els.ruler;
    const dpr = window.devicePixelRatio || 1;
    const w = TL.viewWidth();
    const h = canvas.clientHeight || 30;
    canvas.style.width = w + 'px';
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const [t0, t1] = TL.viewRange();
    const { major, minor } = rulerSteps();
    const x = (t) => (t - t0) * TL.zoom;
    g.strokeStyle = TL.colors.tickMinor;
    g.lineWidth = 1;
    g.beginPath();
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const px = Math.round(x(t)) + 0.5;
      g.moveTo(px, h - 6);
      g.lineTo(px, h);
    }
    g.stroke();
    g.strokeStyle = TL.colors.tick;
    g.fillStyle = TL.colors.text;
    g.font = `500 11px ${TL.colors.font}`;
    g.textBaseline = 'top';
    g.beginPath();
    const decimals = major < 1 ? (major < 0.1 ? 2 : 1) : 0;
    for (let t = Math.floor(t0 / major) * major; t <= t1 + major; t += major) {
      const tt = Math.round(t * 1000) / 1000;
      const px = Math.round(x(tt)) + 0.5;
      g.moveTo(px, h - 12);
      g.lineTo(px, h);
      g.fillText(U.formatTime(tt, decimals), px + 4, 5);
    }
    g.stroke();
    // Repère de la tête de lecture
    const ph = MA.Engine.playing ? MA.Engine.position() : Store.playhead;
    const px = x(ph);
    if (px >= -8 && px <= w + 8) {
      g.fillStyle = TL.colors.accent;
      g.beginPath();
      g.moveTo(px - 6, h - 10);
      g.lineTo(px + 6, h - 10);
      g.lineTo(px, h);
      g.closePath();
      g.fill();
    }
  }

  /* ---------- Tête de lecture ---------- */
  TL.updatePlayhead = (t) => {
    if (t == null) t = MA.Engine.playing ? MA.Engine.position() : Store.playhead;
    els.playhead.style.transform = `translateX(${TL.headerW + t * TL.zoom}px)`;
    TL.queueRuler();
  };

  // Pendant la lecture, fait défiler la vue pour garder la tête de lecture visible.
  TL.follow = (t) => {
    const [v0, v1] = TL.viewRange();
    if (t > v1 - (v1 - v0) * 0.04 || t < v0) {
      els.scroller.scrollLeft = Math.max(0, t * TL.zoom - TL.viewWidth() * 0.1);
    }
  };

  TL.scrollToTime = (t) => {
    const [v0, v1] = TL.viewRange();
    if (t < v0 || t > v1) els.scroller.scrollLeft = Math.max(0, t * TL.zoom - TL.viewWidth() * 0.3);
  };

  /* ---------- Zoom ---------- */
  TL.setZoom = (z, anchorClientX) => {
    z = U.clamp(z, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(z - TL.zoom) < 1e-9) return;
    const r = els.scroller.getBoundingClientRect();
    let anchorX;
    if (anchorClientX == null) {
      // Ancre sur la tête de lecture si elle est visible, sinon au centre
      const ph = Store.playhead;
      const [v0, v1] = TL.viewRange();
      anchorX = ph >= v0 && ph <= v1 ? (ph - v0) * TL.zoom : TL.viewWidth() / 2;
    } else {
      anchorX = anchorClientX - r.left - TL.headerW;
    }
    const t = (els.scroller.scrollLeft + anchorX) / TL.zoom;
    TL.zoom = z;
    renderClips();
    TL.updateSize();
    els.scroller.scrollLeft = Math.max(0, t * z - anchorX);
    TL.updatePlayhead();
    TL.queueRuler();
    MA.App.onZoom();
  };

  TL.zoomFit = () => {
    const end = Math.max(5, Store.projectEnd());
    TL.setZoom((TL.viewWidth() - 24) / end);
    els.scroller.scrollLeft = 0;
    TL.queueRuler();
    TL.queueWaves();
  };

  /* ---------- Aimantation ---------- */
  function snapTargets(excludeIds) {
    const targets = [0, Store.playhead];
    for (const c of Store.state.clips) {
      if (excludeIds.has(c.id)) continue;
      targets.push(c.start, Clip.end(c));
    }
    return targets;
  }

  // Cherche la cible la plus proche d'un des instants proposés. Renvoie {delta, at} ou null.
  function findSnap(times, targets, noSnap) {
    if (!TL.snap || noSnap) return null;
    const thr = SNAP_PX / TL.zoom;
    let best = null;
    for (const t of times) {
      for (const target of targets) {
        const d = target - t;
        if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: target };
      }
    }
    return best;
  }

  function showSnap(at) {
    if (at == null) {
      els.snapline.hidden = true;
      return;
    }
    els.snapline.hidden = false;
    els.snapline.style.transform = `translateX(${TL.headerW + at * TL.zoom}px)`;
  }

  /* ---------- Repérage dans un morceau ---------- */
  function hitTest(c, el, clientX, clientY) {
    const r = el.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    const W = r.width;
    const H = r.height;
    if (Store.selection.has(c.id) && y > LABEL_H) {
      const env = c.envelope || [];
      for (let i = 0; i < env.length; i++) {
        const px = (env[i].t - c.offset) * TL.zoom;
        const py = envY(env[i].g, H);
        if (Math.hypot(px - x, py - y) <= 8) return { zone: 'env-point', index: i };
      }
      const g = Clip.envelopeAtSource(c, c.offset + x / TL.zoom);
      if (Math.abs(envY(g, H) - y) <= 5 && x > 4 && x < W - 4) return { zone: 'env-line' };
    }
    if (y <= LABEL_H + 2 && W >= 24) {
      const { fi, fo } = Clip.fades(c);
      const fx = Math.max(FADE_MIN_X, fi * TL.zoom);
      const fox = W - Math.max(FADE_MIN_X, fo * TL.zoom);
      const dIn = Math.abs(x - fx);
      const dOut = Math.abs(x - fox);
      if (dIn <= 9 && dIn <= dOut) return { zone: 'fade-in' };
      if (dOut <= 9) return { zone: 'fade-out' };
    }
    const edge = Math.min(8, W / 4);
    if (x < edge) return { zone: 'trim-left' };
    if (x > W - edge) return { zone: 'trim-right' };
    return { zone: 'move' };
  }

  const CURSORS = {
    'env-point': 'grab',
    'env-line': 'copy',
    'fade-in': 'ew-resize',
    'fade-out': 'ew-resize',
    'trim-left': 'w-resize',
    'trim-right': 'e-resize',
    move: 'grab',
  };

  /* ---------- Événements ---------- */
  function bindEvents() {
    const sc = els.scroller;
    sc.addEventListener('scroll', () => {
      TL.queueRuler();
      TL.queueWaves();
    });
    sc.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          TL.setZoom(TL.zoom * Math.exp(-e.deltaY * 0.0025), e.clientX);
        }
      },
      { passive: false }
    );
    sc.addEventListener('pointerdown', onPointerDown);
    sc.addEventListener('pointermove', onHover);
    sc.addEventListener('dblclick', onDoubleClick);
    sc.addEventListener('contextmenu', onContextMenu);
    els.ruler.addEventListener('pointerdown', onRulerDown);
    els.ruler.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        TL.setZoom(TL.zoom * Math.exp(-e.deltaY * 0.0025), e.clientX);
      }
    }, { passive: false });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  function onHover(e) {
    if (TL.drag) return;
    const el = e.target.closest('.clip');
    if (!el) return;
    const c = Store.clip(el.dataset.clipId);
    if (!c) return;
    el.style.cursor = CURSORS[hitTest(c, el, e.clientX, e.clientY).zone];
  }

  function onRulerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const wasPlaying = MA.Engine.playing;
    if (wasPlaying) MA.Engine.stop();
    TL.drag = { type: 'scrub', wasPlaying };
    MA.App.seek(TL.timeAt(e.clientX), { keepPlaying: false });
  }

  function onPointerDown(e) {
    if (e.target.closest('.track-head') || e.target.closest('.add-head') || e.target.closest('.empty-card')) return;
    if (e.button !== 0) return;
    const clipEl = e.target.closest('.clip');
    if (clipEl && !clipEl.classList.contains('recording')) {
      clipDown(e, clipEl);
      return;
    }
    const lane = e.target.closest('.lane') || e.target.closest('.add-lane');
    if (lane) laneDown(e, lane);
  }

  function laneDown(e, lane) {
    e.preventDefault();
    const inner = els.inner.getBoundingClientRect();
    if (lane.dataset.trackId) MA.App.selectTrack(lane.dataset.trackId);
    TL.drag = {
      type: 'marquee',
      x0: e.clientX - inner.left,
      y0: e.clientY - inner.top,
      clientX0: e.clientX,
      clientY0: e.clientY,
      additive: e.shiftKey || U.modKey(e),
      base: new Set(Store.selection),
      moved: false,
    };
  }

  function clipDown(e, el) {
    const c = Store.clip(el.dataset.clipId);
    if (!c) return;
    e.preventDefault();
    const hit = hitTest(c, el, e.clientX, e.clientY);
    const toggle = e.shiftKey || U.modKey(e);
    const wasSelected = Store.selection.has(c.id);
    MA.App.selectTrack(c.trackId, { silent: true });

    if (!wasSelected) {
      if (!toggle) Store.selection.clear();
      Store.selection.add(c.id);
      MA.App.selectionChanged();
    }
    const base = {
      clipId: c.id,
      downX: e.clientX,
      downY: e.clientY,
      moved: false,
      toggle,
      wasSelected,
      noSnap: e.altKey,
    };

    if (hit.zone === 'env-point' || hit.zone === 'env-line') {
      let index = hit.index;
      if (hit.zone === 'env-line') {
        Store.checkpoint('Ajouter un point de volume');
        const r = el.getBoundingClientRect();
        const srcT = c.offset + (e.clientX - r.left) / TL.zoom;
        const gNow = Clip.envelopeAtSource(c, srcT);
        c.envelope = (c.envelope || []).slice();
        c.envelope.push({ t: srcT, g: gNow });
        c.envelope.sort((p, q) => p.t - q.t);
        index = c.envelope.findIndex((p) => p.t === srcT);
        base.moved = true;
        base.checkpointed = true;
        refreshClip(c);
      }
      TL.drag = { ...base, type: 'env', index, clipH: el.getBoundingClientRect().height };
      return;
    }
    if (hit.zone === 'fade-in' || hit.zone === 'fade-out') {
      TL.drag = { ...base, type: hit.zone, orig: { fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0 } };
      return;
    }
    if (hit.zone === 'trim-left' || hit.zone === 'trim-right') {
      TL.drag = {
        ...base,
        type: hit.zone,
        orig: { start: c.start, offset: c.offset, duration: c.duration },
        targets: snapTargets(new Set([c.id])),
      };
      return;
    }
    // Déplacement de tous les morceaux sélectionnés
    const ids = [...Store.selection];
    const tracks = Store.state.tracks;
    const orig = new Map();
    for (const id of ids) {
      const x = Store.clip(id);
      if (x) orig.set(id, { start: x.start, trackIdx: Store.trackIndex(x.trackId) });
    }
    TL.drag = {
      ...base,
      type: 'move',
      orig,
      leadIdx: Store.trackIndex(c.trackId),
      targets: snapTargets(new Set(ids)),
      sameTrack: new Set([...orig.values()].map((o) => o.trackIdx)).size === 1,
      trackCount: tracks.length,
    };
    el.style.cursor = 'grabbing';
  }

  function refreshClip(c) {
    const refs = TL.clips.get(c.id);
    if (refs) {
      updateClip(c, refs);
      refs.drawn = null;
    }
    TL.queueWaves();
  }

  function autoScroll(clientX) {
    const r = els.scroller.getBoundingClientRect();
    if (clientX > r.right - 40) els.scroller.scrollLeft += 12;
    else if (clientX < r.left + TL.headerW + 30 && els.scroller.scrollLeft > 0) els.scroller.scrollLeft -= 12;
  }

  function onPointerMove(e) {
    const d = TL.drag;
    if (!d) return;
    if (d.type === 'scrub') {
      MA.App.seek(TL.timeAt(e.clientX), { keepPlaying: false });
      return;
    }
    if (d.type === 'marquee') return marqueeMove(e, d);

    const dx = e.clientX - d.downX;
    const dy = e.clientY - d.downY;
    if (!d.moved) {
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      d.moved = true;
    }
    const c = Store.clip(d.clipId);
    if (!c) return;
    const dt = dx / TL.zoom;
    const labels = {
      move: 'Déplacer',
      'trim-left': 'Raccourcir le début',
      'trim-right': 'Raccourcir la fin',
      'fade-in': 'Fondu d’entrée',
      'fade-out': 'Fondu de sortie',
      env: 'Courbe de volume',
    };
    if (!d.checkpointed) {
      Store.checkpoint(labels[d.type]);
      d.checkpointed = true;
    }
    autoScroll(e.clientX);

    if (d.type === 'move') {
      moveSelection(e, d, dt);
      return;
    }
    if (d.type === 'trim-left') {
      const o = d.orig;
      const end = o.start + o.duration;
      let s = o.start + dt;
      const snap = findSnap([s], d.targets, d.noSnap || e.altKey);
      if (snap) s += snap.delta;
      s = U.clamp(s, Math.max(0, o.start - o.offset), end - Math.max(0.01, 4 / TL.zoom));
      c.start = s;
      c.offset = o.offset + (s - o.start);
      c.duration = end - s;
      showSnap(snap && Math.abs(c.start - snap.at) < 1e-6 ? snap.at : null);
      MA.UI.tip(e, `Début : ${U.formatTime(c.start, 2)}`);
    } else if (d.type === 'trim-right') {
      const o = d.orig;
      const srcDur = Store.sourceDuration(c.sourceId) || o.offset + o.duration;
      let en = o.start + o.duration + dt;
      const snap = findSnap([en], d.targets, d.noSnap || e.altKey);
      if (snap) en += snap.delta;
      en = U.clamp(en, o.start + Math.max(0.01, 4 / TL.zoom), o.start + (srcDur - o.offset));
      c.duration = en - o.start;
      showSnap(snap && Math.abs(en - snap.at) < 1e-6 ? snap.at : null);
      MA.UI.tip(e, `Fin : ${U.formatTime(en, 2)}`);
    } else if (d.type === 'fade-in') {
      const r = TL.clips.get(c.id).el.getBoundingClientRect();
      c.fadeIn = U.clamp((e.clientX - r.left) / TL.zoom, 0, c.duration - (c.fadeOut || 0));
      if (c.fadeIn * TL.zoom < 3) c.fadeIn = 0;
      MA.UI.tip(e, c.fadeIn ? `Fondu d’entrée : ${U.formatSeconds(c.fadeIn)}` : 'Pas de fondu');
    } else if (d.type === 'fade-out') {
      const r = TL.clips.get(c.id).el.getBoundingClientRect();
      c.fadeOut = U.clamp((r.right - e.clientX) / TL.zoom, 0, c.duration - (c.fadeIn || 0));
      if (c.fadeOut * TL.zoom < 3) c.fadeOut = 0;
      MA.UI.tip(e, c.fadeOut ? `Fondu de sortie : ${U.formatSeconds(c.fadeOut)}` : 'Pas de fondu');
    } else if (d.type === 'env') {
      const el = TL.clips.get(c.id).el;
      const r = el.getBoundingClientRect();
      const env = c.envelope;
      const p = env[d.index];
      if (!p) return;
      const lo = d.index > 0 ? env[d.index - 1].t + 0.001 : c.offset;
      const hi = d.index < env.length - 1 ? env[d.index + 1].t - 0.001 : c.offset + c.duration;
      p.t = U.clamp(c.offset + (e.clientX - r.left) / TL.zoom, lo, hi);
      p.g = envGainAtY(e.clientY - r.top, d.clipH);
      MA.UI.tip(e, `${U.formatDb(U.gainToDb(p.g))} à ${U.formatTime(c.start + p.t - c.offset, 1)}`);
    }
    refreshClip(c);
  }

  function moveSelection(e, d, dt) {
    const tracks = Store.state.tracks;
    let minStart = Infinity;
    for (const o of d.orig.values()) minStart = Math.min(minStart, o.start);
    if (minStart + dt < 0) dt = -minStart;
    const lead = Store.clip(d.clipId);
    const leadOrig = d.orig.get(d.clipId);
    const snap = findSnap([leadOrig.start + dt, leadOrig.start + dt + lead.duration], d.targets, d.noSnap || e.altKey);
    if (snap && minStart + dt + snap.delta >= 0) dt += snap.delta;
    showSnap(snap ? snap.at : null);

    // Changement de piste
    let ti = TL.trackIndexAtY(e.clientY);
    d.newTrack = false;
    if (ti >= tracks.length) {
      if (d.sameTrack) d.newTrack = true;
      ti = tracks.length - 1;
    }
    let dTrack = ti - d.leadIdx;
    let minIdx = Infinity;
    let maxIdx = -Infinity;
    for (const o of d.orig.values()) {
      minIdx = Math.min(minIdx, o.trackIdx);
      maxIdx = Math.max(maxIdx, o.trackIdx);
    }
    dTrack = U.clamp(dTrack, -minIdx, tracks.length - 1 - maxIdx);
    let maxEnd = 0;
    for (const [id, o] of d.orig) {
      const c = Store.clip(id);
      if (!c) continue;
      c.start = o.start + dt;
      c.trackId = tracks[o.trackIdx + dTrack].id;
      maxEnd = Math.max(maxEnd, Clip.end(c));
    }
    d.maxEnd = maxEnd;
    els.addRow.classList.toggle('drop-target', d.newTrack);
    renderClips();
    TL.updateSize();
    MA.UI.tip(e, d.newTrack ? 'Relâcher pour créer une nouvelle piste' : `Début : ${U.formatTime(lead.start, 2)}`);
  }

  function marqueeMove(e, d) {
    const inner = els.inner.getBoundingClientRect();
    const x = e.clientX - inner.left;
    const y = e.clientY - inner.top;
    if (!d.moved && Math.hypot(e.clientX - d.clientX0, e.clientY - d.clientY0) < 4) return;
    d.moved = true;
    autoScroll(e.clientX);
    const box = els.marquee;
    box.hidden = false;
    const l = Math.min(x, d.x0);
    const t = Math.min(y, d.y0);
    box.style.left = l + 'px';
    box.style.top = t + 'px';
    box.style.width = Math.abs(x - d.x0) + 'px';
    box.style.height = Math.abs(y - d.y0) + 'px';
    const sel = new Set(d.additive ? d.base : []);
    const bx0 = inner.left + l;
    const bx1 = inner.left + l + Math.abs(x - d.x0);
    const by0 = inner.top + t;
    const by1 = inner.top + t + Math.abs(y - d.y0);
    for (const [id, refs] of TL.clips) {
      const r = refs.el.getBoundingClientRect();
      if (r.right > bx0 && r.left < bx1 && r.bottom > by0 && r.top < by1) sel.add(id);
    }
    const changed = sel.size !== Store.selection.size || [...sel].some((id) => !Store.selection.has(id));
    if (changed) {
      Store.selection = sel;
      MA.App.selectionChanged();
    }
  }

  function onPointerUp(e) {
    const d = TL.drag;
    if (!d) return;
    TL.drag = null;
    showSnap(null);
    MA.UI.tip(null);
    els.addRow.classList.remove('drop-target');
    if (d.type === 'scrub') {
      if (d.wasPlaying) MA.App.play();
      return;
    }
    if (d.type === 'marquee') {
      els.marquee.hidden = true;
      if (!d.moved && e.type !== 'pointercancel') {
        if (!d.additive && Store.selection.size) {
          Store.selection.clear();
          MA.App.selectionChanged();
        }
        MA.App.seek(TL.timeAt(e.clientX));
      }
      return;
    }
    const el = TL.clips.get(d.clipId);
    if (el) el.el.style.cursor = '';
    if (!d.moved) {
      if (e.type === 'pointercancel') return;
      // Simple clic : gestion de la sélection et placement de la tête de lecture
      if (d.toggle && d.wasSelected) {
        Store.selection.delete(d.clipId);
        MA.App.selectionChanged();
      } else if (!d.toggle && Store.selection.size > 1) {
        Store.selection = new Set([d.clipId]);
        MA.App.selectionChanged();
      }
      if (!d.toggle && d.type === 'move') MA.App.seek(TL.timeAt(e.clientX));
      return;
    }
    if (d.type === 'move' && d.newTrack) {
      const lead = Store.clip(d.clipId);
      const t = Store.addTrack({ name: lead ? lead.name : undefined });
      for (const id of d.orig.keys()) {
        const c = Store.clip(id);
        if (c) c.trackId = t.id;
      }
      Store.selectedTrackId = t.id;
    }
    if (d.type === 'env') {
      // Supprime les points inutiles laissés sur une ligne plate au volume d'origine
      const c = Store.clip(d.clipId);
      if (c && c.envelope.length === 1 && c.envelope[0].g === 1) c.envelope = [];
    }
    Store.emit('clips');
  }

  function onDoubleClick(e) {
    const el = e.target.closest('.clip');
    if (!el) return;
    const c = Store.clip(el.dataset.clipId);
    if (!c) return;
    const hit = hitTest(c, el, e.clientX, e.clientY);
    if (hit.zone === 'env-point') {
      Store.transact('Retirer un point de volume', () => c.envelope.splice(hit.index, 1));
    } else if (hit.zone === 'fade-in' || hit.zone === 'fade-out') {
      Store.transact('Retirer le fondu', () => {
        if (hit.zone === 'fade-in') c.fadeIn = 0;
        else c.fadeOut = 0;
      });
    }
  }

  function onContextMenu(e) {
    if (e.target.closest('.track-head') || e.target.closest('input')) return;
    const el = e.target.closest('.clip');
    const lane = e.target.closest('.lane');
    if (!el && !lane) return;
    e.preventDefault();
    if (el) {
      const c = Store.clip(el.dataset.clipId);
      if (!c) return;
      const hit = hitTest(c, el, e.clientX, e.clientY);
      if (!Store.selection.has(c.id)) {
        Store.selection = new Set([c.id]);
        MA.App.selectionChanged();
      }
      MA.UI.clipMenu(e.clientX, e.clientY, c, hit);
    } else {
      MA.UI.laneMenu(e.clientX, e.clientY, lane.dataset.trackId, TL.timeAt(e.clientX));
    }
  }

  /* ---------- Vu-mètres des pistes ---------- */
  TL.updateMeters = (levels) => {
    for (const [id, refs] of TL.rows) {
      const peak = levels ? levels.get(id) || 0 : 0;
      const db = U.gainToDb(peak);
      const frac = U.clamp((db + 48) / 51, 0, 1);
      refs.meterCover.style.transform = `scaleX(${1 - frac})`;
    }
  };

  /* ---------- Enregistrement en cours ---------- */
  TL.showRecording = (trackId, start, duration) => {
    const refs = TL.rows.get(trackId);
    if (!refs) return;
    let el = refs.lane.querySelector('.clip.recording');
    if (!el) {
      el = U.el('div', { class: 'clip recording' }, [U.el('div', { class: 'clip-label' }, [U.el('span', { class: 'clip-name', text: 'Enregistrement…' })])]);
      refs.lane.append(el);
    }
    el.style.left = start * TL.zoom + 'px';
    el.style.width = Math.max(2, duration * TL.zoom) + 'px';
  };

  TL.hideRecording = () => {
    for (const el of els.tracks.querySelectorAll('.clip.recording')) el.remove();
  };

  TL.LABEL_H = LABEL_H;
  MA.Timeline = TL;
})((window.MA = window.MA || {}));
