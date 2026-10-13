/* Moteur audio : décodage des fichiers, lecture en direct et rendu final (export). */
(function (MA) {
  'use strict';
  const U = MA.U;
  const Clip = MA.Clip;
  const Store = MA.Store;

  // Programme une suite de points {t, v} (temps de la ligne de temps) sur un AudioParam.
  // `fromT` est l'instant de la ligne de temps qui correspond à `ctxT0` dans le contexte audio.
  function schedule(param, points, fromT, ctxT0) {
    if (!points.length) return;
    param.setValueAtTime(Clip.interpolate(points, fromT), ctxT0);
    for (const p of points) {
      if (p.t > fromT) param.linearRampToValueAtTime(p.v, ctxT0 + (p.t - fromT));
    }
  }

  // Construit le graphe de mixage : morceaux -> pistes -> sortie `dest`.
  // Sert à la fois pour l'écoute et pour l'export (OfflineAudioContext).
  function buildGraph(ctx, dest, state, sources, fromT, ctxT0, withMeters) {
    const anySolo = state.tracks.some((t) => t.solo);
    const tracks = new Map();
    const nodes = [];

    for (const tr of state.tracks) {
      // Entrée de piste en stéréo : un fichier mono est copié à gauche et à droite,
      // il garde donc le même niveau qu'un fichier stéréo.
      const input = ctx.createGain();
      input.channelCount = 2;
      input.channelCountMode = 'explicit';
      input.channelInterpretation = 'speakers';
      const duck = ctx.createGain();
      const gain = ctx.createGain();
      gain.gain.value = Store.effectiveTrackGain(tr, anySolo);
      input.connect(duck);
      duck.connect(gain);
      let out = gain;
      let pan = null;
      if (ctx.createStereoPanner) {
        pan = ctx.createStereoPanner();
        pan.pan.value = tr.pan || 0;
        gain.connect(pan);
        out = pan;
      }
      out.connect(dest);
      let analyser = null;
      if (withMeters) {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        out.connect(analyser);
      }
      if (tr.duck) schedule(duck.gain, Clip.duckBreakpoints(state, tr), fromT, ctxT0);
      tracks.set(tr.id, { input, duck, gain, pan, analyser });
      nodes.push(input, duck, gain);
      if (pan) nodes.push(pan);
      if (analyser) nodes.push(analyser);
    }

    const voices = [];
    for (const c of state.clips) {
      const tn = tracks.get(c.trackId);
      const src = sources.get(c.sourceId);
      if (!tn || !src || !src.buffer) continue;
      const end = Clip.end(c);
      if (end <= fromT + 1e-4) continue;
      const skip = Math.max(0, fromT - c.start);
      const when = ctxT0 + Math.max(0, c.start - fromT);
      const node = ctx.createBufferSource();
      node.buffer = src.buffer;
      const env = ctx.createGain();
      const fade = ctx.createGain();
      schedule(env.gain, Clip.envelopeBreakpoints(c), fromT, ctxT0);
      schedule(fade.gain, Clip.fadeBreakpoints(c), fromT, ctxT0);
      node.connect(env);
      env.connect(fade);
      fade.connect(tn.input);
      node.start(when, c.offset + skip, Math.max(0, c.duration - skip));
      voices.push(node);
      nodes.push(env, fade);
    }
    return { tracks, voices, nodes };
  }

  const Engine = {
    ctx: null,
    master: null,
    meters: null, // {left, right} AnalyserNode
    graph: null,
    playing: false,
    startCtx: 0,
    startPos: 0,
    onEnded: null,
  };

  Engine.ensureContext = () => {
    if (!Engine.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Votre navigateur ne gère pas l’audio (Web Audio). Essayez Chrome, Edge ou Firefox.');
      const ctx = new AC({ latencyHint: 'interactive' });
      const master = ctx.createGain();
      master.gain.value = U.dbToGain(Store.state ? Store.state.master : 0);
      master.connect(ctx.destination);
      const split = ctx.createChannelSplitter(2);
      master.connect(split);
      const left = ctx.createAnalyser();
      const right = ctx.createAnalyser();
      left.fftSize = right.fftSize = 1024;
      split.connect(left, 0);
      split.connect(right, 1);
      Engine.ctx = ctx;
      Engine.master = master;
      Engine.meters = { left, right };
    }
    if (Engine.ctx.state === 'suspended') Engine.ctx.resume().catch(() => {});
    return Engine.ctx;
  };

  // Décode un fichier (ArrayBuffer) en AudioBuffer. Le tampon d'origine est conservé intact.
  Engine.decode = async (arrayBuffer) => {
    const ctx = Engine.ensureContext();
    const copy = arrayBuffer.slice(0);
    return new Promise((resolve, reject) => {
      let done = false;
      const ok = (b) => {
        if (!done) {
          done = true;
          resolve(b);
        }
      };
      const ko = (e) => {
        if (!done) {
          done = true;
          reject(e || new Error('decode'));
        }
      };
      try {
        const p = ctx.decodeAudioData(copy, ok, ko);
        if (p && p.then) p.then(ok, ko);
      } catch (e) {
        ko(e);
      }
    });
  };

  Engine.position = () => {
    if (!Engine.playing) return Store.playhead;
    const ctx = Engine.ctx;
    const latency = ctx.outputLatency || 0;
    return Engine.startPos + Math.max(0, ctx.currentTime - Engine.startCtx - latency);
  };

  Engine.play = (from, ctxStart) => {
    const ctx = Engine.ensureContext();
    Engine.stopVoices();
    const t0 = ctxStart != null ? ctxStart : ctx.currentTime + 0.05;
    Engine.graph = buildGraph(ctx, Engine.master, Store.state, Store.sources, from, t0, true);
    Engine.startCtx = t0;
    Engine.startPos = from;
    Engine.playing = true;
  };

  Engine.stopVoices = () => {
    const g = Engine.graph;
    if (!g) return;
    for (const v of g.voices) {
      try {
        v.stop();
      } catch (e) {
        /* déjà arrêté */
      }
      v.disconnect();
    }
    for (const n of g.nodes) n.disconnect();
    Engine.graph = null;
  };

  Engine.stop = () => {
    Engine.stopVoices();
    Engine.playing = false;
  };

  // Relance la lecture à la position courante (après une modification du montage).
  Engine.restart = () => {
    if (!Engine.playing) return;
    const pos = Engine.position();
    Engine.play(pos);
  };

  // Applique en direct volumes, balance, muet/solo et volume général.
  Engine.applyMix = () => {
    if (!Engine.ctx) return;
    const now = Engine.ctx.currentTime;
    Engine.master.gain.setTargetAtTime(U.dbToGain(Store.state.master), now, 0.015);
    const g = Engine.graph;
    if (!g) return;
    const anySolo = Store.state.tracks.some((t) => t.solo);
    for (const tr of Store.state.tracks) {
      const tn = g.tracks.get(tr.id);
      if (!tn) continue;
      tn.gain.gain.setTargetAtTime(Store.effectiveTrackGain(tr, anySolo), now, 0.015);
      if (tn.pan) tn.pan.pan.setTargetAtTime(tr.pan || 0, now, 0.015);
    }
  };

  // Niveau crête (0..1+) lu sur un analyseur.
  const meterBuf = new Float32Array(1024);
  Engine.peakOf = (analyser) => {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(meterBuf);
    let peak = 0;
    for (let i = 0; i < meterBuf.length; i++) {
      const a = Math.abs(meterBuf[i]);
      if (a > peak) peak = a;
    }
    return peak;
  };

  // Rendu complet du montage dans un AudioBuffer stéréo.
  Engine.render = async ({ sampleRate = 44100, onProgress } = {}) => {
    const state = Store.state;
    const duration = Store.projectEnd();
    if (duration <= 0) throw new Error('Le montage est vide.');
    const length = Math.ceil((duration + 0.05) * sampleRate);
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(2, length, sampleRate);
    const master = ctx.createGain();
    master.gain.value = U.dbToGain(state.master);
    master.connect(ctx.destination);
    buildGraph(ctx, master, state, Store.sources, 0, 0, false);
    if (onProgress && typeof ctx.suspend === 'function') {
      const steps = 20;
      try {
        for (let i = 1; i < steps; i++) {
          const at = (duration * i) / steps;
          ctx
            .suspend(at)
            .then(() => {
              onProgress(i / steps);
              ctx.resume();
            })
            .catch(() => {});
        }
      } catch (e) {
        /* suspend() non géré : pas de progression détaillée */
      }
    }
    return ctx.startRendering();
  };

  Engine._schedule = schedule;
  Engine._buildGraph = buildGraph;
  MA.Engine = Engine;
})((window.MA = window.MA || {}));
