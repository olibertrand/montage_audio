/* Enregistrement au micro sur une nouvelle piste, pendant que les autres pistes jouent. */
(function (MA) {
  'use strict';
  const { Engine } = MA;

  const Rec = {
    active: false,
    trackId: null,
    startPos: 0,
    analyser: null,
  };
  let ctxStart = 0;
  let stream = null;
  let nodes = [];
  let chunks = [];

  Rec.supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext !== false;

  Rec.elapsed = () => (Rec.active ? Math.max(0, Engine.ctx.currentTime - ctxStart) : 0);

  // Démarre la capture. `startPos` : position de départ sur la ligne de temps.
  Rec.start = async (startPos) => {
    const ctx = Engine.ensureContext();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      throw new Error(
        denied
          ? 'Le micro est bloqué. Autorisez-le dans votre navigateur (icône à gauche de l’adresse), puis réessayez.'
          : 'Aucun micro n’a été trouvé. Branchez un micro ou un casque-micro, puis réessayez.'
      );
    }
    if (ctx.state === 'suspended') await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    src.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);
    nodes = [src, proc, sink, analyser];
    chunks = [];
    proc.onaudioprocess = (e) => {
      if (!Rec.active) return;
      const input = e.inputBuffer;
      chunks.push({ t: ctx.currentTime - input.duration, data: new Float32Array(input.getChannelData(0)) });
    };
    Rec.analyser = analyser;
    Rec.startPos = startPos;
    ctxStart = ctx.currentTime + 0.1;
    Engine.play(startPos, ctxStart);
    Rec.active = true;
  };

  // Arrête la capture et renvoie un AudioBuffer mono calé sur la ligne de temps (ou null).
  Rec.stop = () => {
    if (!Rec.active) return null;
    Rec.active = false;
    const ctx = Engine.ctx;
    Engine.stop();
    for (const n of nodes) n.disconnect();
    nodes = [];
    if (stream) for (const tr of stream.getTracks()) tr.stop();
    stream = null;
    Rec.analyser = null;

    // On garde ce qui a été capté après le début réel de la lecture, en tenant compte
    // du délai de sortie du son (ce que la personne entendait au moment de jouer).
    const sr = ctx.sampleRate;
    const from = ctxStart + (ctx.outputLatency || ctx.baseLatency || 0);
    const parts = [];
    let total = 0;
    for (const ch of chunks) {
      const skip = Math.max(0, Math.round((from - ch.t) * sr));
      if (skip >= ch.data.length) continue;
      const part = skip ? ch.data.subarray(skip) : ch.data;
      parts.push(part);
      total += part.length;
    }
    chunks = [];
    if (total < sr * 0.2) return null;
    const buffer = ctx.createBuffer(1, total, sr);
    const out = buffer.getChannelData(0);
    let k = 0;
    for (const p of parts) {
      out.set(p, k);
      k += p.length;
    }
    return buffer;
  };

  MA.Recorder = Rec;
})((window.MA = window.MA || {}));
