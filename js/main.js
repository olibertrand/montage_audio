/* Chef d'orchestre : démarrage, actions de l'application, clavier, import, export, sauvegarde. */
(function (MA) {
  'use strict';
  const { U, Store, Clip, Engine, Peaks, UI, Persist, Download, Wav, Mp3, Recorder } = MA;
  const TL = MA.Timeline;
  const icon = MA.icon;

  const App = { playStart: 0 };
  const $ = (id) => document.getElementById(id);
  let els = {};
  let storageWarned = false;

  /* ---------- Démarrage ---------- */
  App.start = async () => {
    document.documentElement.lang = 'fr';
    for (const node of document.querySelectorAll('[data-icon]')) {
      node.insertAdjacentHTML('afterbegin', icon(node.dataset.icon, Number(node.dataset.iconSize) || 18));
    }
    els = {
      scroller: $('scroller'),
      inner: $('inner'),
      tracks: $('tracks'),
      ruler: $('ruler'),
      playhead: $('playhead'),
      snapline: $('snapline'),
      marquee: $('marquee'),
      addRow: $('add-row'),
      empty: $('empty'),
      clock: $('clock-time'),
      clockTotal: $('clock-total'),
      play: $('btn-play'),
      rec: $('btn-rec'),
      undo: $('btn-undo'),
      redo: $('btn-redo'),
      snap: $('btn-snap'),
      master: $('master-vol'),
      masterOut: $('master-val'),
      meter: $('master-meter'),
      clipLed: $('clip-led'),
      projectName: $('project-name'),
      banner: $('demo-banner'),
      loading: $('loading'),
    };
    UI.init();
    TL.init(els);
    Store.state = Store.emptyState();
    Store.subscribe(onChange);
    bindToolbar();
    bindKeyboard();
    bindDrop();
    bindEnvironment();
    Download.init();
    if (!Recorder.supported() || Download.inArtifact) els.rec.hidden = true;

    await Persist.open();
    let restored = false;
    try {
      restored = await restoreSaved();
    } catch (e) {
      console.error(e);
    }
    if (!restored) {
      try {
        await loadDemo();
      } catch (e) {
        console.error(e);
        Store.load(Store.emptyState());
      }
    }
    els.loading.hidden = true;
    requestAnimationFrame(frame);
  };

  async function restoreSaved() {
    const saved = await Persist.loadProject();
    if (!saved || !saved.state) return false;
    const state = saved.state;
    const ids = Store.usedSourceIds(state);
    const missing = [];
    for (const id of ids) {
      const rec = await Persist.getSource(id);
      if (!rec) {
        missing.push(id);
        continue;
      }
      try {
        await App.addSource({ ...rec, persist: false });
      } catch (e) {
        missing.push(id);
      }
    }
    const ui = saved.ui || {};
    Store.isDemo = !!ui.isDemo;
    Store.playhead = ui.playhead || 0;
    if (ui.zoom) TL.zoom = U.clamp(ui.zoom, TL.MIN_ZOOM, TL.MAX_ZOOM);
    if (typeof ui.snap === 'boolean') TL.snap = ui.snap;
    Store.load(state);
    if (ui.scrollLeft) els.scroller.scrollLeft = ui.scrollLeft;
    Persist.pruneSources(ids).catch(() => {});
    if (missing.length) {
      UI.toast(`${missing.length} son(s) du projet n’ont pas pu être rechargés. Les morceaux concernés apparaissent vides.`, { kind: 'error' });
    }
    return true;
  }

  async function loadDemo() {
    Store.state = Store.emptyState();
    const state = await MA.Demo.build(async (buffer, name) => {
      const id = U.uid();
      await App.addSource({ id, name, mime: 'audio/wav', data: Wav.fromAudioBuffer(buffer), buffer });
      return id;
    });
    Store.isDemo = true;
    Store.playhead = 0;
    Store.load(state);
    TL.zoomFit();
    autosave();
  }

  // Enregistre un fichier son (décodage, forme d'onde, sauvegarde locale).
  App.addSource = async ({ id, name, mime, data, buffer, persist = true }) => {
    if (!buffer) buffer = await Engine.decode(data);
    const peaks = Peaks.compute(buffer);
    Store.sources.set(id, { id, name, mime, data, buffer, peaks });
    if (persist) {
      Persist.putSource({ id, name, mime, data }).catch(() => warnStorage());
    }
    return id;
  };

  function warnStorage() {
    if (storageWarned) return;
    storageWarned = true;
    UI.toast('Le navigateur manque de place pour garder vos sons automatiquement. Pensez à enregistrer votre projet (bouton Enregistrer).', { kind: 'error' });
  }

  /* ---------- Réactions aux changements ---------- */
  const autosave = U.debounce(() => {
    if (!Store.state) return;
    Persist.saveProject(Store.state, {
      zoom: TL.zoom,
      playhead: Store.playhead,
      isDemo: Store.isDemo,
      snap: TL.snap,
      scrollLeft: els.scroller.scrollLeft,
    }).catch(() => warnStorage());
  }, 600);
  App.autosave = autosave;

  function onChange(kind, opts) {
    if (kind === 'all') {
      syncMaster();
      els.banner.hidden = !Store.isDemo;
      TL.invalidateWaves();
    }
    if (document.activeElement !== els.projectName) els.projectName.value = Store.state.name;
    TL.render();
    UI.renderInspector();
    updateHistoryButtons();
    updateClock();
    if (opts.live) {
      if (kind === 'mix') Engine.applyMix();
      return;
    }
    if (kind === 'mix') {
      Engine.applyMix();
      if (Store.state.tracks.some((t) => t.duck)) Engine.restart();
    } else if (kind === 'clips' || kind === 'all') {
      if (!Recorder.active) Engine.restart();
    }
    autosave();
  }

  App.selectionChanged = () => {
    TL.renderClips();
    UI.renderInspector();
  };

  App.selectTrack = (id, { silent } = {}) => {
    if (Store.selectedTrackId === id) return;
    Store.selectedTrackId = id;
    for (const [tid, refs] of TL.rows) refs.el.classList.toggle('selected', tid === id);
    if (!silent) UI.renderInspector();
  };

  App.onZoom = () => autosave();

  function updateHistoryButtons() {
    const u = Store.undoStack[Store.undoStack.length - 1];
    const r = Store.redoStack[Store.redoStack.length - 1];
    els.undo.disabled = !u;
    els.redo.disabled = !r;
    els.undo.title = u ? `Annuler : ${u.label} (${U.modLabel}+Z)` : 'Rien à annuler';
    els.redo.title = r ? `Rétablir : ${r.label} (${U.modLabel}+Maj+Z)` : 'Rien à rétablir';
  }

  function updateClock(pos) {
    if (pos == null) pos = Engine.playing ? Engine.position() : Store.playhead;
    els.clock.textContent = U.formatTime(pos);
    els.clockTotal.textContent = U.formatTime(Store.projectEnd());
  }

  function syncMaster() {
    els.master.value = U.dbToFader(Store.state.master) * 1000;
    els.masterOut.textContent = U.formatDb(Store.state.master);
  }

  /* ---------- Lecture ---------- */
  App.play = () => {
    if (!Store.state.clips.length) {
      UI.toast('Le montage est vide : importez d’abord un son.');
      return;
    }
    let from = Store.playhead;
    if (from >= Store.projectEnd() - 0.05) from = 0;
    App.playStart = from;
    Engine.play(from);
    updateTransport();
  };

  App.pause = () => {
    if (!Engine.playing) return;
    Store.playhead = Engine.position();
    Engine.stop();
    updateTransport();
    TL.updatePlayhead();
    autosave();
  };

  App.togglePlay = () => {
    if (Recorder.active) return App.toggleRecord();
    if (Engine.playing) App.pause();
    else App.play();
  };

  // Stop : revient là où la lecture a commencé ; un second appui ramène au début.
  App.stop = () => {
    if (Recorder.active) return App.toggleRecord();
    if (Engine.playing) {
      Engine.stop();
      Store.playhead = App.playStart;
    } else {
      Store.playhead = 0;
    }
    updateTransport();
    TL.updatePlayhead();
    TL.scrollToTime(Store.playhead);
    updateClock();
  };

  App.seek = (t, { keepPlaying = true } = {}) => {
    t = Math.max(0, t);
    Store.playhead = t;
    if (Engine.playing && keepPlaying) {
      App.playStart = t;
      Engine.play(t);
    }
    TL.updatePlayhead();
    updateClock();
  };

  function updateTransport() {
    const playing = Engine.playing && !Recorder.active;
    els.play.innerHTML = icon(playing ? 'pause' : 'play', 22);
    els.play.setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
    els.play.title = playing ? 'Pause (Espace)' : 'Lecture (Espace)';
    els.play.classList.toggle('active', playing);
    els.rec.classList.toggle('active', Recorder.active);
    els.rec.setAttribute('aria-pressed', String(Recorder.active));
    document.body.classList.toggle('is-recording', Recorder.active);
  }

  /* ---------- Boucle d'affichage : tête de lecture et vu-mètres ---------- */
  const meterState = { l: 0, r: 0, holdL: 0, holdR: 0, holdT: 0, tracks: new Map(), clipUntil: 0 };

  function frame() {
    const now = performance.now();
    if (Engine.playing) {
      const pos = Engine.position();
      if (!Recorder.active && pos >= Store.projectEnd() + 0.2) {
        Engine.stop();
        Store.playhead = App.playStart;
        updateTransport();
        TL.updatePlayhead();
        TL.scrollToTime(Store.playhead);
        updateClock();
      } else {
        TL.updatePlayhead(pos);
        TL.follow(pos);
        updateClock(pos);
        if (Recorder.active) TL.showRecording(Recorder.trackId, Recorder.startPos, Recorder.elapsed());
      }
    }
    updateMeters(now);
    requestAnimationFrame(frame);
  }

  function updateMeters(now) {
    const live = Engine.playing && Engine.meters;
    let l = live ? Engine.peakOf(Engine.meters.left) : 0;
    let r = live ? Engine.peakOf(Engine.meters.right) : 0;
    const decay = 0.88;
    const fall = (v) => (v < 1e-4 ? 0 : v * decay);
    meterState.l = Math.max(l, fall(meterState.l));
    meterState.r = Math.max(r, fall(meterState.r));
    if (l >= 0.999 || r >= 0.999) {
      meterState.clipUntil = now + 2500;
      els.clipLed.classList.add('on');
    } else if (now > meterState.clipUntil) {
      els.clipLed.classList.remove('on');
    }
    if (Math.max(l, r) > Math.max(meterState.holdL, meterState.holdR) || now - meterState.holdT > 1200) {
      meterState.holdL = meterState.l;
      meterState.holdR = meterState.r;
      meterState.holdT = now;
    }
    const key = [meterState.l, meterState.r, meterState.holdL, meterState.holdR].map((v) => v.toFixed(4)).join();
    if (key !== meterState.drawn) {
      meterState.drawn = key;
      drawMasterMeter();
    }

    const levels = new Map();
    let any = false;
    for (const t of Store.state.tracks) {
      let p = 0;
      if (live && Engine.graph) {
        const tn = Engine.graph.tracks.get(t.id);
        if (tn) p = Engine.peakOf(tn.analyser);
      }
      if (Recorder.active && t.id === Recorder.trackId) p = Engine.peakOf(Recorder.analyser);
      const v = Math.max(p, fall(meterState.tracks.get(t.id) || 0));
      if (v > 0.0005) any = true;
      levels.set(t.id, v < 0.0005 ? 0 : v);
    }
    meterState.tracks = levels;
    if (any || meterState.wasActive) TL.updateMeters(levels);
    meterState.wasActive = any;
  }

  function drawMasterMeter() {
    const c = els.meter;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
    if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const { ok: colOk, warn: colWarn, danger: colBad, meterBg: colBg } = TL.colors;
    const frac = (v) => U.clamp((U.gainToDb(v) + 48) / 51, 0, 1);
    const barH = (h - 2) / 2;
    const segs = 30;
    const segW = w / segs;
    [meterState.l, meterState.r].forEach((v, i) => {
      const y = i * (barH + 2);
      const lit = frac(v) * segs;
      const hold = Math.floor(frac(i ? meterState.holdR : meterState.holdL) * segs);
      for (let s = 0; s < segs; s++) {
        const pos = (s + 1) / segs;
        const on = s < lit || (s === hold - 1 && hold > 1);
        const col = pos > 0.94 ? colBad : pos > 0.8 ? colWarn : colOk;
        g.fillStyle = on ? col : colBg;
        g.globalAlpha = on ? 1 : 0.55;
        g.fillRect(s * segW + 0.5, y, segW - 1.5, barH);
      }
    });
    g.globalAlpha = 1;
  }

  /* ---------- Morceaux : couper, supprimer, dupliquer, copier, coller ---------- */
  const playPos = () => (Engine.playing ? Engine.position() : Store.playhead);

  App.split = () => {
    const t = playPos();
    let targets = Store.selectedClips().filter((c) => t > c.start && t < Clip.end(c));
    if (!targets.length && !Store.selection.size && Store.selectedTrackId) {
      targets = Store.clipsOf(Store.selectedTrackId).filter((c) => t > c.start && t < Clip.end(c));
    }
    if (!targets.length) {
      UI.toast('Placez la tête de lecture au milieu d’un morceau (et sélectionnez-le) pour le couper.');
      return;
    }
    Store.transact('Couper', () => {
      const right = [];
      for (const c of targets) {
        const r = Store.splitClip(c, t);
        if (r) right.push(r.id);
      }
      Store.selection = new Set(right);
    });
  };

  App.deleteSelection = ({ ripple = false } = {}) => {
    const sel = Store.selectedClips();
    if (!sel.length) {
      UI.toast('Sélectionnez d’abord un morceau en cliquant dessus.');
      return;
    }
    Store.transact(ripple ? 'Supprimer et rapprocher' : 'Supprimer', () => {
      const ids = new Set(sel.map((c) => c.id));
      if (ripple) {
        const ordered = [...sel].sort((a, b) => b.start - a.start);
        for (const r of ordered) {
          const end = Clip.end(r);
          for (const c of Store.state.clips) {
            if (c.trackId === r.trackId && !ids.has(c.id) && c.start >= end - 1e-6) c.start = Math.max(0, c.start - r.duration);
          }
        }
      }
      Store.removeClips([...ids]);
    });
    UI.toast(sel.length > 1 ? `${sel.length} morceaux supprimés` : 'Morceau supprimé', { action: { label: 'Annuler', fn: App.undo } });
  };

  App.duplicate = () => {
    const sel = Store.selectedClips();
    if (!sel.length) {
      UI.toast('Sélectionnez d’abord un morceau à dupliquer.');
      return;
    }
    const minStart = Math.min(...sel.map((c) => c.start));
    const maxEnd = Math.max(...sel.map((c) => Clip.end(c)));
    const span = maxEnd - minStart;
    Store.transact('Dupliquer', () => {
      const ids = [];
      for (const c of sel) {
        const copy = Store.cloneClip(c, { start: c.start + span });
        Store.state.clips.push(copy);
        ids.push(copy.id);
      }
      Store.selection = new Set(ids);
    });
    TL.scrollToTime(maxEnd + span * 0.5);
  };

  App.copy = () => {
    const sel = Store.selectedClips();
    if (!sel.length) return;
    const minStart = Math.min(...sel.map((c) => c.start));
    const minIdx = Math.min(...sel.map((c) => Store.trackIndex(c.trackId)));
    Store.clipboard = sel.map((c) => ({ clip: JSON.parse(JSON.stringify(c)), dt: c.start - minStart, dTrack: Store.trackIndex(c.trackId) - minIdx }));
    UI.toast(sel.length > 1 ? `${sel.length} morceaux copiés` : 'Morceau copié');
  };

  App.paste = (trackId, time) => {
    if (!Store.clipboard) return;
    const t = time != null ? Math.max(0, time) : playPos();
    let baseIdx = Store.trackIndex(trackId || Store.selectedTrackId);
    if (baseIdx < 0) baseIdx = 0;
    Store.transact('Coller', () => {
      const ids = [];
      for (const item of Store.clipboard) {
        if (!Store.source(item.clip.sourceId)) continue;
        const idx = baseIdx + item.dTrack;
        while (Store.state.tracks.length <= idx) Store.addTrack();
        const copy = Store.cloneClip(item.clip, { start: t + item.dt, trackId: Store.state.tracks[idx].id });
        Store.state.clips.push(copy);
        ids.push(copy.id);
      }
      Store.selection = new Set(ids);
    });
  };

  App.selectAll = () => {
    Store.selection = new Set(Store.state.clips.map((c) => c.id));
    App.selectionChanged();
  };

  App.clearEnvelope = () => {
    const sel = Store.selectedClips().filter((c) => c.envelope && c.envelope.length);
    if (!sel.length) return;
    Store.transact('Effacer la courbe de volume', () => sel.forEach((c) => (c.envelope = [])));
  };

  App.clearFades = () => {
    const sel = Store.selectedClips();
    if (!sel.length) return;
    Store.transact('Retirer les fondus', () =>
      sel.forEach((c) => {
        c.fadeIn = 0;
        c.fadeOut = 0;
      })
    );
  };

  function clipStats(c) {
    const src = Store.source(c.sourceId);
    if (!src || !src.peaks) return null;
    return Peaks.stats(src.peaks, c.offset, c.offset + c.duration);
  }

  // Règle le volume de chaque morceau pour que son passage le plus fort atteigne -1 dB.
  App.normalize = () => {
    const sel = Store.selectedClips();
    if (!sel.length) {
      UI.toast('Sélectionnez d’abord un ou plusieurs morceaux.');
      return;
    }
    const changes = [];
    for (const c of sel) {
      const s = clipStats(c);
      if (!s || s.peak <= 0.0001) continue;
      changes.push([c, U.clamp(Math.round((-1 - s.peakDb) * 10) / 10, -24, 24)]);
    }
    if (!changes.length) {
      UI.toast('Ces morceaux sont silencieux : rien à ajuster.');
      return;
    }
    Store.transact('Ajuster le volume', () => changes.forEach(([c, g]) => (c.gain = g)));
    UI.toast(changes.length === 1 ? `Volume du morceau réglé à ${U.formatDb(changes[0][1])}` : `${changes.length} morceaux ajustés`);
  };

  // Donne à tous les morceaux sélectionnés le même volume perçu, sans saturer.
  App.matchLoudness = () => {
    const sel = Store.selectedClips();
    if (sel.length < 2) {
      UI.toast('Sélectionnez au moins deux morceaux (Maj + clic) pour harmoniser leurs volumes.');
      return;
    }
    const items = sel.map((c) => ({ c, s: clipStats(c) })).filter((x) => x.s && isFinite(x.s.loudness));
    if (items.length < 2) return;
    const target = items.reduce((a, x) => a + x.s.loudness, 0) / items.length;
    let gains = items.map((x) => target - x.s.loudness);
    const over = Math.max(...items.map((x, i) => x.s.peakDb + gains[i])) + 1;
    if (over > 0) gains = gains.map((g) => g - over);
    Store.transact('Harmoniser les volumes', () =>
      items.forEach((x, i) => (x.c.gain = U.clamp(Math.round(gains[i] * 10) / 10, -24, 24)))
    );
    UI.toast(`Volumes de ${items.length} morceaux harmonisés`);
  };

  /* ---------- Pistes ---------- */
  App.addTrack = () => {
    const t = Store.transact('Ajouter une piste', () => Store.addTrack(), 'clips');
    Store.selectedTrackId = t.id;
    TL.render();
    requestAnimationFrame(() => {
      const refs = TL.rows.get(t.id);
      if (refs) refs.el.scrollIntoView({ block: 'nearest' });
    });
  };

  App.deleteTrack = (id) => {
    const t = Store.track(id);
    if (!t) return;
    Store.transact('Supprimer la piste', () => Store.removeTrack(id));
    UI.toast(`Piste « ${t.name} » supprimée`, { action: { label: 'Annuler', fn: App.undo } });
  };

  App.moveTrack = (id, dir) => {
    const i = Store.trackIndex(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= Store.state.tracks.length) return;
    Store.transact('Déplacer la piste', () => {
      const arr = Store.state.tracks;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    });
  };

  App.duplicateTrack = (id) => {
    const t = Store.track(id);
    if (!t) return;
    Store.transact('Dupliquer la piste', () => {
      const copy = Store.addTrack({ ...JSON.parse(JSON.stringify(t)), id: U.uid(), name: t.name + ' (copie)', color: Store.nextColor(), solo: false }, Store.trackIndex(id) + 1);
      for (const c of Store.clipsOf(id)) Store.state.clips.push(Store.cloneClip(c, { trackId: copy.id }));
    });
  };

  App.focusTrackName = (id) => {
    const refs = TL.rows.get(id);
    if (refs) {
      refs.name.focus();
      refs.name.select();
    }
  };

  /* ---------- Annuler / rétablir ---------- */
  App.undo = () => {
    if (Recorder.active) return;
    const label = Store.undo();
    if (label) UI.toast(`Annulé : ${label}`, { timeout: 1800 });
  };
  App.redo = () => {
    if (Recorder.active) return;
    const label = Store.redo();
    if (label) UI.toast(`Rétabli : ${label}`, { timeout: 1800 });
  };

  /* ---------- Import ---------- */
  const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|opus|flac|m4a|aac|mp4|m4v|mov|webm|weba|aif|aiff|caf|3gp|amr)$/i;
  const PROJECT_EXT = /\.(montage|zip)$/i;
  let importTarget = null;

  App.openImport = (target) => {
    importTarget = target || null;
    $('file-import').value = '';
    $('file-import').click();
  };

  App.importFiles = async (fileList, target = {}) => {
    const files = [...fileList].filter((f) => (f.type && /^(audio|video)\//.test(f.type)) || AUDIO_EXT.test(f.name));
    const skipped = fileList.length - files.length;
    if (!files.length) {
      UI.toast('Aucun fichier son reconnu. Formats acceptés : MP3, WAV, M4A, OGG, FLAC, et le son des vidéos MP4.', { kind: 'error' });
      return;
    }
    if (Store.isDemo && !target.trackId) {
      const fresh = await askLeaveDemo();
      if (fresh == null) return;
      if (fresh) startEmpty();
    }
    Engine.ensureContext();
    const closeProgress = UI.toast(files.length > 1 ? `Import de ${files.length} fichiers…` : `Import de « ${files[0].name} »…`, { timeout: 120000 });
    const loaded = [];
    const failed = [];
    for (const f of files) {
      try {
        const data = await f.arrayBuffer();
        const id = U.uid();
        await App.addSource({ id, name: f.name, mime: f.type, data });
        loaded.push({ id, name: U.baseName(f.name), duration: Store.sourceDuration(id) });
      } catch (e) {
        failed.push(f.name);
      }
    }
    closeProgress();
    if (loaded.length) {
      const wasEmpty = !Store.state.clips.length;
      let at = target.time != null ? Math.max(0, target.time) : Store.playhead;
      Store.transact(loaded.length > 1 ? 'Importer des sons' : 'Importer un son', () => {
        const ids = [];
        for (const item of loaded) {
          let trackId = target.trackId;
          if (!trackId) trackId = Store.addTrack({ name: item.name }).id;
          const c = Store.addClip({ trackId, sourceId: item.id, name: item.name, start: at, duration: item.duration });
          ids.push(c.id);
          // Sur une piste choisie, les fichiers se suivent ; sinon chacun a sa piste.
          if (target.trackId) at += item.duration;
        }
        Store.selection = new Set(ids);
        Store.selectedTrackId = Store.clip(ids[0]).trackId;
      });
      if (wasEmpty) TL.zoomFit();
      else TL.scrollToTime(at);
      UI.toast(loaded.length > 1 ? `${loaded.length} sons importés` : `« ${loaded[0].name} » importé (${U.formatSeconds(loaded[0].duration)})`);
    }
    if (failed.length) {
      UI.toast(`Impossible de lire ${failed.map((n) => '« ' + n + ' »').join(', ')} : ce format n’est pas reconnu par votre navigateur. Essayez en MP3 ou WAV.`, { kind: 'error' });
    }
    if (skipped > 0 && loaded.length) UI.toast(`${skipped} fichier(s) ignoré(s) : ce ne sont pas des sons.`);
  };

  // Renvoie true (nouveau projet), false (ajouter à l'exemple) ou null (abandon).
  function askLeaveDemo() {
    return new Promise((resolve) => {
      let done = false;
      const answer = (v) => {
        done = true;
        resolve(v);
      };
      UI.dialog({
        title: 'Commencer votre montage ?',
        body: U.el('p', { class: 'dialog-text', text: 'Vous êtes dans le projet d’exemple. Voulez-vous repartir d’un projet vide avec vos sons, ou les ajouter à l’exemple ?' }),
        buttons: [
          { label: 'Ajouter à l’exemple', kind: 'ghost', action: () => answer(false) },
          { label: 'Nouveau projet avec mes sons', kind: 'primary', action: () => answer(true) },
        ],
        onClose: () => {
          if (!done) resolve(null);
        },
      });
    });
  }

  function startEmpty() {
    if (Recorder.active) App.toggleRecord();
    Engine.stop();
    Store.checkpoint('Nouveau projet');
    Store.isDemo = false;
    Store.playhead = 0;
    Store.state = Store.emptyState();
    Store.selection.clear();
    Store.selectedTrackId = null;
    Store.emit('all');
    updateTransport();
  }

  App.newProject = async () => {
    if (Store.state.clips.length && !Store.isDemo) {
      const ok = await UI.confirm(
        'Nouveau projet',
        'Le montage actuel sera remplacé par un projet vide. Pour le garder, enregistrez-le d’abord. (Vous pourrez encore revenir en arrière avec Annuler tant que la page reste ouverte.)',
        'Commencer un projet vide'
      );
      if (!ok) return;
    }
    startEmpty();
    UI.toast('Nouveau projet : importez vos sons pour commencer.');
  };

  /* ---------- Fichier projet ---------- */
  App.saveProject = async () => {
    if (!Store.state.clips.length) {
      UI.toast('Le montage est vide : il n’y a rien à enregistrer.');
      return;
    }
    try {
      const blob = Persist.buildProjectFile(Store.state, Store.sources);
      const res = await Download.save(blob, U.safeFileName(Store.state.name) + '.montage', { isZip: true });
      if (res.declined) return;
      UI.toast(`Projet enregistré : « ${res.filename} » (${U.formatBytes(blob.size)}, sons compris). Rouvrez-le avec le bouton Ouvrir.`, { timeout: 7000 });
    } catch (e) {
      UI.toast(e.message || 'L’enregistrement a échoué.', { kind: 'error' });
    }
  };

  App.openProject = () => {
    $('file-open').value = '';
    $('file-open').click();
  };

  App.openProjectFile = async (file) => {
    if (Store.state.clips.length && !Store.isDemo) {
      const ok = await UI.confirm('Ouvrir un projet', `Le montage actuel sera remplacé par « ${file.name} ». Pensez à l’enregistrer d’abord si besoin.`, 'Ouvrir');
      if (!ok) return;
    }
    const close = UI.toast(`Ouverture de « ${file.name} »…`, { timeout: 120000 });
    try {
      const { state, sources } = await Persist.readProjectFile(await file.arrayBuffer());
      for (const s of sources) {
        if (!Store.sources.has(s.id)) await App.addSource(s);
      }
      if (Recorder.active) App.toggleRecord();
      Engine.stop();
      Store.isDemo = false;
      Store.playhead = 0;
      Store.load(state);
      updateTransport();
      TL.zoomFit();
      close();
      UI.toast(`Projet « ${state.name} » ouvert`);
    } catch (e) {
      close();
      UI.toast(e.message || 'Impossible d’ouvrir ce fichier.', { kind: 'error' });
    }
  };

  /* ---------- Export ---------- */
  App.openExport = () => {
    if (!Store.state.clips.length) {
      UI.toast('Le montage est vide : importez d’abord des sons.');
      return;
    }
    if (Engine.playing) App.pause();
    const duration = Store.projectEnd();
    const hasMp3 = !!Mp3.available();
    let format = hasMp3 ? 'mp3' : 'wav';

    const nameInput = U.el('input', { type: 'text', id: 'export-name', class: 'text-input', spellcheck: 'false' });
    nameInput.value = U.safeFileName(Store.state.name);
    const mkChoice = (value, title, desc) => {
      const input = U.el('input', { type: 'radio', name: 'export-format', value, id: 'fmt-' + value });
      input.checked = value === format;
      input.disabled = value === 'mp3' && !hasMp3;
      input.addEventListener('change', () => {
        format = value;
        refresh();
      });
      return U.el('label', { class: 'choice', for: 'fmt-' + value }, [input, U.el('span', { class: 'choice-title', text: title }), U.el('span', { class: 'choice-desc', text: desc })]);
    };
    const quality = U.el('select', { id: 'export-quality', class: 'text-input' }, [
      U.el('option', { value: '128', text: 'Standard — 128 kbit/s' }),
      U.el('option', { value: '192', text: 'Bonne — 192 kbit/s (recommandé)' }),
      U.el('option', { value: '256', text: 'Très bonne — 256 kbit/s' }),
      U.el('option', { value: '320', text: 'Maximale — 320 kbit/s' }),
    ]);
    quality.value = '192';
    quality.addEventListener('change', refresh);
    const qualityRow = U.el('div', { class: 'form-row' }, [U.el('label', { for: 'export-quality', text: 'Qualité' }), quality]);
    const normalize = U.el('input', { type: 'checkbox', id: 'export-normalize' });
    normalize.checked = true;
    const info = U.el('p', { class: 'export-info' });
    const progress = U.el('div', { class: 'progress', hidden: true }, [U.el('div', { class: 'progress-bar' }), U.el('span', { class: 'progress-text' })]);
    const note = Download.inArtifact
      ? U.el('p', { class: 'export-note', text: 'Dans cette page en ligne, le fichier vous est remis dans une archive .zip : ouvrez-la pour récupérer votre son.' })
      : null;

    function refresh() {
      qualityRow.hidden = format !== 'mp3';
      const bytes = format === 'mp3' ? (Number(quality.value) * 1000 * duration) / 8 : 44100 * 4 * duration;
      info.textContent = `Durée ${U.formatTime(duration)} · environ ${U.formatBytes(bytes)} · stéréo 44,1 kHz`;
    }

    const body = U.el('div', { class: 'export-form' }, [
      U.el('div', { class: 'form-row' }, [U.el('label', { for: 'export-name', text: 'Nom du fichier' }), nameInput]),
      U.el('div', { class: 'choices', role: 'radiogroup', 'aria-label': 'Format' }, [
        mkChoice('mp3', 'MP3', hasMp3 ? 'Léger, se lit partout. Idéal pour partager ou envoyer.' : 'Indisponible : l’encodeur MP3 n’a pas pu être chargé.'),
        mkChoice('wav', 'WAV', 'Qualité maximale, fichier beaucoup plus lourd.'),
      ]),
      qualityRow,
      U.el('label', { class: 'check', for: 'export-normalize' }, [
        normalize,
        U.el('span', {}, [U.el('strong', { text: 'Ajuster le volume final' }), U.el('small', { text: ' (recommandé) — amène le passage le plus fort juste sous la limite de saturation.' })]),
      ]),
      info,
      note,
      progress,
    ]);
    refresh();

    let busy = false;
    const dlg = UI.dialog({
      title: 'Exporter le montage',
      body,
      canClose: () => !busy,
      buttons: [
        { label: 'Annuler', kind: 'ghost', action: () => !busy },
        {
          label: 'Exporter',
          kind: 'primary',
          icon: 'export',
          action: async (btn) => {
            if (busy) return false;
            busy = true;
            btn.disabled = true;
            progress.hidden = false;
            const bar = progress.querySelector('.progress-bar');
            const txt = progress.querySelector('.progress-text');
            const step = (frac, label) => {
              bar.style.transform = `scaleX(${frac})`;
              txt.textContent = label;
            };
            try {
              step(0.02, 'Mélange des pistes…');
              await U.sleep(30);
              const rendered = await Engine.render({ onProgress: (p) => step(p * 0.5, 'Mélange des pistes…') });
              const chans = [rendered.getChannelData(0), rendered.getChannelData(1)];
              let peak = 0;
              for (const ch of chans) for (let i = 0; i < ch.length; i++) {
                const a = Math.abs(ch[i]);
                if (a > peak) peak = a;
              }
              if (normalize.checked && peak > 0.0001) {
                const k = U.dbToGain(-1) / peak;
                for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= k;
              }
              const base = U.safeFileName(nameInput.value || Store.state.name);
              let blob;
              let filename;
              if (format === 'mp3') {
                step(0.5, 'Encodage MP3…');
                blob = await Mp3.encode(chans, rendered.sampleRate, Number(quality.value), (p) => step(0.5 + p * 0.48, `Encodage MP3… ${Math.round(p * 100)} %`));
                filename = base + '.mp3';
              } else {
                step(0.8, 'Création du fichier WAV…');
                await U.sleep(20);
                blob = new Blob([Wav.encode(chans, rendered.sampleRate)], { type: 'audio/wav' });
                filename = base + '.wav';
              }
              step(1, 'Terminé');
              const res = await Download.save(blob, filename);
              if (!res.declined) {
                UI.toast(res.wrapped ? `« ${filename} » est prêt, dans l’archive « ${res.filename} ».` : `« ${filename} » est prêt (${U.formatBytes(blob.size)}).`, { timeout: 6000 });
                if (!normalize.checked && peak > 1) UI.toast('Attention : certains passages saturent. Baissez un peu les volumes ou cochez « Ajuster le volume final ».', { kind: 'error' });
              }
              return true;
            } catch (e) {
              console.error(e);
              UI.toast(e.message || 'L’export a échoué.', { kind: 'error' });
              busy = false;
              btn.disabled = false;
              progress.hidden = true;
              return false;
            }
          },
        },
      ],
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') dlg.buttons[1].el.click();
    });
  };

  /* ---------- Enregistrement au micro ---------- */
  App.toggleRecord = async () => {
    if (Recorder.active) {
      const buffer = Recorder.stop();
      TL.hideRecording();
      updateTransport();
      const trackId = Recorder.trackId;
      if (!buffer) {
        // Rien de capté : on retire la piste créée pour l'occasion
        Store.undo();
        Store.redoStack.pop();
        UI.toast('Enregistrement trop court : rien n’a été gardé.');
        return;
      }
      const track = Store.track(trackId);
      const id = U.uid();
      const name = track ? track.name : 'Voix';
      await App.addSource({ id, name: name + '.wav', mime: 'audio/wav', data: Wav.fromAudioBuffer(buffer), buffer });
      const c = Store.addClip({ trackId, sourceId: id, name, start: Recorder.startPos, duration: buffer.duration });
      Store.selection = new Set([c.id]);
      Store.playhead = Recorder.startPos;
      Store.emit('clips');
      TL.updatePlayhead();
      UI.toast(`Enregistrement ajouté (${U.formatSeconds(buffer.duration)})`);
      return;
    }
    if (Engine.playing) App.pause();
    const n = Store.state.tracks.filter((t) => /^Voix \d+$/.test(t.name)).length + 1;
    const track = Store.transact('Enregistrer au micro', () => Store.addTrack({ name: `Voix ${n}` }, 0), 'meta');
    Recorder.trackId = track.id;
    Store.selectedTrackId = track.id;
    TL.render();
    try {
      await Recorder.start(Store.playhead);
      updateTransport();
      UI.toast('Enregistrement en cours… Appuyez sur Espace ou sur le bouton rouge pour arrêter. Conseil : utilisez un casque pour que la musique ne soit pas captée.', { timeout: 6000 });
    } catch (e) {
      Store.undo();
      Store.redoStack.pop();
      UI.toast(e.message, { kind: 'error' });
    }
  };

  /* ---------- Barre d'outils ---------- */
  function bindToolbar() {
    const on = (id, fn) => $(id).addEventListener('click', fn);
    on('btn-new', () => App.newProject());
    on('btn-open', () => App.openProject());
    on('btn-save', () => App.saveProject());
    on('btn-import', () => App.openImport());
    on('btn-import-empty', () => App.openImport());
    on('btn-demo-empty', () => {
      if (Store.isDemo || !Store.state.clips.length) reloadDemo();
    });
    on('btn-export', () => App.openExport());
    on('btn-help', () => UI.showHelp());
    on('btn-undo', () => App.undo());
    on('btn-redo', () => App.redo());
    on('btn-home', () => {
      App.seek(0);
      TL.scrollToTime(0);
    });
    on('btn-play', () => App.togglePlay());
    on('btn-stop', () => App.stop());
    on('btn-rec', () => App.toggleRecord());
    on('btn-split', () => App.split());
    on('btn-delete', () => App.deleteSelection());
    on('btn-zoom-in', () => TL.setZoom(TL.zoom * 1.5));
    on('btn-zoom-out', () => TL.setZoom(TL.zoom / 1.5));
    on('btn-zoom-fit', () => TL.zoomFit());
    on('btn-add-track', () => App.addTrack());
    on('btn-add-track-2', () => App.addTrack());
    on('btn-banner-new', () => {
      startEmpty();
      UI.toast('Projet vide : importez vos sons pour commencer.');
    });
    on('btn-banner-keep', () => {
      Store.isDemo = false;
      els.banner.hidden = true;
      autosave();
    });
    els.snap.addEventListener('click', () => {
      TL.snap = !TL.snap;
      els.snap.setAttribute('aria-pressed', String(TL.snap));
      autosave();
    });
    els.snap.setAttribute('aria-pressed', String(TL.snap));

    UI.bindSlider(els.master, {
      label: 'Volume général',
      read: () => U.dbToFader(Store.state.master) * 1000,
      write: (v) => {
        const db = U.faderToDb(v / 1000);
        Store.state.master = isFinite(db) ? Math.round(db * 10) / 10 : -100;
      },
      reset: () => (Store.state.master = 0),
      kind: 'mix',
      out: () => (els.masterOut.textContent = U.formatDb(Store.state.master)),
    });
    els.clipLed.addEventListener('click', () => {
      meterState.clipUntil = 0;
      els.clipLed.classList.remove('on');
    });

    els.projectName.addEventListener('change', () => {
      const v = els.projectName.value.trim() || 'Mon montage';
      Store.transact('Renommer le projet', () => (Store.state.name = v), 'meta');
    });
    els.projectName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') els.projectName.blur();
    });

    $('file-import').addEventListener('change', (e) => {
      const files = [...e.target.files];
      const target = importTarget || {};
      importTarget = null;
      if (files.length) App.importFiles(files, target);
    });
    $('file-open').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) App.openProjectFile(f);
    });
  }

  async function reloadDemo() {
    Engine.stop();
    Store.checkpoint('Charger l’exemple');
    const keep = { undo: Store.undoStack, redo: Store.redoStack };
    await loadDemo();
    Store.undoStack = keep.undo;
    Store.redoStack = [];
    updateHistoryButtons();
    updateTransport();
  }

  /* ---------- Clavier ---------- */
  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (UI.dialogOpen()) {
        if (e.key === 'Escape') UI.closeMenu();
        return;
      }
      const typing = U.isTextInput(e.target);
      const mod = U.modKey(e);
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      if (mod && !e.altKey) {
        if (key === 's') {
          e.preventDefault();
          App.saveProject();
          return;
        }
        if (key === 'o') {
          e.preventDefault();
          App.openProject();
          return;
        }
        if (typing) return;
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) App.redo();
          else App.undo();
        } else if (key === 'y') {
          e.preventDefault();
          App.redo();
        } else if (key === 'c') {
          App.copy();
        } else if (key === 'x') {
          App.copy();
          App.deleteSelection();
        } else if (key === 'v') {
          e.preventDefault();
          App.paste();
        } else if (key === 'd') {
          e.preventDefault();
          App.duplicate();
        } else if (key === 'a') {
          e.preventDefault();
          App.selectAll();
        } else if (key === 'e') {
          e.preventDefault();
          App.openExport();
        }
        return;
      }
      if (typing) return;
      const onRange = e.target && e.target.type === 'range';
      switch (key) {
        case ' ':
          e.preventDefault();
          App.togglePlay();
          break;
        case 'Home':
          e.preventDefault();
          App.seek(0);
          TL.scrollToTime(0);
          break;
        case 'End':
          e.preventDefault();
          App.seek(Store.projectEnd());
          TL.scrollToTime(Store.projectEnd());
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
          if (onRange) return;
          e.preventDefault();
          App.seek(playPos() + (key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1));
          TL.scrollToTime(Store.playhead);
          break;
        case 's':
          App.split();
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          App.deleteSelection();
          break;
        case '+':
        case '=':
          TL.setZoom(TL.zoom * 1.5);
          break;
        case '-':
        case '_':
          TL.setZoom(TL.zoom / 1.5);
          break;
        case 'r':
          if (!els.rec.hidden) App.toggleRecord();
          break;
        case 'Escape':
          UI.closeMenu();
          if (Store.selection.size) {
            Store.selection.clear();
            App.selectionChanged();
          }
          break;
        default:
      }
    });
  }

  /* ---------- Glisser-déposer de fichiers ---------- */
  function bindDrop() {
    let depth = 0;
    let hoverLane = null;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const clearHover = () => {
      if (hoverLane) hoverLane.classList.remove('drop-hover');
      hoverLane = null;
      els.addRow.classList.remove('drop-target');
    };
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth++;
      document.body.classList.add('dragging-files');
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) {
        document.body.classList.remove('dragging-files');
        clearHover();
      }
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const lane = e.target.closest && e.target.closest('.lane');
      if (lane !== hoverLane) {
        clearHover();
        hoverLane = lane;
        if (lane) lane.classList.add('drop-hover');
      }
      els.addRow.classList.toggle('drop-target', !!(e.target.closest && e.target.closest('#add-row')));
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging-files');
      const lane = e.target.closest && e.target.closest('.lane');
      const inEditor = e.target.closest && e.target.closest('#scroller');
      clearHover();
      const files = [...e.dataTransfer.files];
      if (files.length === 1 && PROJECT_EXT.test(files[0].name)) {
        App.openProjectFile(files[0]);
        return;
      }
      if (lane) App.importFiles(files, { trackId: lane.dataset.trackId, time: Math.max(0, TL.timeAt(e.clientX)) });
      else if (inEditor && Store.state.clips.length) App.importFiles(files, { time: Math.max(0, TL.timeAt(e.clientX)) });
      else App.importFiles(files);
    });
  }

  /* ---------- Fenêtre, thème, fermeture ---------- */
  function bindEnvironment() {
    const relayout = U.debounce(() => {
      meterState.drawn = null;
      TL.readMetrics();
      TL.render();
      TL.invalidateWaves();
    }, 60);
    window.addEventListener('resize', relayout);
    if (window.ResizeObserver) new ResizeObserver(relayout).observe(els.scroller);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const retheme = () => {
      meterState.drawn = null;
      TL.readMetrics();
      TL.invalidateWaves();
      TL.queueRuler();
    };
    if (mq.addEventListener) mq.addEventListener('change', retheme);
    new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    const flush = () => autosave.flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    els.scroller.addEventListener('scroll', U.debounce(() => autosave(), 400));
  }

  MA.App = App;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => App.start());
  else App.start();
})((window.MA = window.MA || {}));
