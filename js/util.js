/* Petits outils partagés : conversions de volume, format du temps, DOM. */
(function (MA) {
  'use strict';

  const U = {};

  U.clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  U.dbToGain = (db) => (db <= -96 ? 0 : Math.pow(10, db / 20));
  U.gainToDb = (g) => (g <= 0.0000158 ? -Infinity : 20 * Math.log10(g));

  // Loi des curseurs de volume des pistes : position 0..1 -> gain.
  // Courbe cubique : 0 dB vers 63 % de la course, +12 dB tout en haut.
  U.FADER_MAX_GAIN = 4;
  U.faderToGain = (p) => U.FADER_MAX_GAIN * p * p * p;
  U.gainToFader = (g) => Math.cbrt(Math.max(0, g) / U.FADER_MAX_GAIN);
  U.faderToDb = (p) => U.gainToDb(U.faderToGain(p));
  U.dbToFader = (db) => U.gainToFader(U.dbToGain(db));

  // Loi de la courbe de volume dessinée sur un morceau : hauteur 0..1 -> gain.
  // Le haut du morceau vaut +6 dB, le volume d'origine est à 71 % de la hauteur.
  U.ENV_MAX_GAIN = 2;
  U.envPosToGain = (p) => U.ENV_MAX_GAIN * p * p;
  U.envGainToPos = (g) => Math.sqrt(Math.max(0, g) / U.ENV_MAX_GAIN);

  const MINUS = '−';

  function frNumber(v, decimals) {
    return v.toFixed(decimals).replace('.', ',').replace('-', MINUS);
  }
  U.frNumber = frNumber;

  U.formatDb = (db, decimals = 1) => {
    if (!isFinite(db) || db <= -96) return MINUS + '∞ dB';
    const r = Math.abs(db) < 0.05 ? 0 : db;
    return (r > 0 ? '+' : '') + frNumber(r, decimals) + ' dB';
  };

  // 83.4 -> "1:23,4" ; 3725 -> "1:02:05,0"
  U.formatTime = (t, decimals = 1) => {
    if (!isFinite(t) || t < 0) t = 0;
    const factor = Math.pow(10, decimals);
    let total = Math.round(t * factor) / factor;
    const h = Math.floor(total / 3600);
    total -= h * 3600;
    const m = Math.floor(total / 60);
    const s = total - m * 60;
    let sec = decimals > 0 ? s.toFixed(decimals) : String(Math.round(s));
    if (s < 10) sec = '0' + sec;
    sec = sec.replace('.', ',');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };

  // Durée lisible pour un humain : "2,5 s", "1 min 05 s"
  U.formatSeconds = (t) => {
    if (t < 60) return frNumber(t, t < 10 ? 1 : 0) + ' s';
    const m = Math.floor(t / 60);
    const s = Math.round(t - m * 60);
    return `${m} min ${String(s).padStart(2, '0')} s`;
  };

  U.formatPan = (pan) => {
    const v = Math.round(pan * 100);
    if (v === 0) return 'Centre';
    return v < 0 ? `G ${-v}` : `D ${v}`;
  };

  U.formatBytes = (n) => {
    if (n < 1024 * 1024) return frNumber(n / 1024, 0) + ' Ko';
    return frNumber(n / (1024 * 1024), 1) + ' Mo';
  };

  let counter = 0;
  U.uid = () => Date.now().toString(36) + (counter++).toString(36) + Math.random().toString(36).slice(2, 6);

  U.baseName = (filename) => filename.replace(/\.[^.\\/]+$/, '');

  U.safeFileName = (name) =>
    (name || 'montage')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'montage';

  U.debounce = (fn, ms) => {
    let timer = null;
    const debounced = (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, ms);
    };
    debounced.flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        fn();
      }
    };
    return debounced;
  };

  // Création d'éléments : U.el('button', {class: 'btn', onclick: f}, ['Texte'])
  U.el = (tag, attrs, children) => {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c == null || c === false) continue;
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
      }
    }
    return node;
  };

  U.isTextInput = (el) => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    if (el.tagName !== 'INPUT') return false;
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'color', 'file'].includes(el.type);
  };

  U.isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  U.modKey = (e) => (U.isMac ? e.metaKey : e.ctrlKey);
  U.modLabel = U.isMac ? '⌘' : 'Ctrl';

  U.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  MA.U = U;
})((window.MA = window.MA || {}));
