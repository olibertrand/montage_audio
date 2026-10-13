/* Formats de fichiers : WAV, MP3 (via lamejs) et archives ZIP (projets). */
(function (MA) {
  'use strict';

  /* ---------- WAV 16 bits ---------- */
  const Wav = {};

  // channels : tableau de Float32Array (une par voie), même longueur.
  Wav.encode = (channels, sampleRate) => {
    const nc = channels.length;
    const len = channels[0].length;
    const bytesPerSample = 2;
    const dataSize = len * nc * bytesPerSample;
    const buf = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buf);
    const str = (o, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    str(0, 'RIFF');
    v.setUint32(4, 36 + dataSize, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, nc, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * nc * bytesPerSample, true);
    v.setUint16(32, nc * bytesPerSample, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, dataSize, true);
    const out = new Int16Array(buf, 44, len * nc);
    let k = 0;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < nc; c++) {
        out[k++] = Wav.toInt16(channels[c][i]);
      }
    }
    return buf;
  };

  Wav.toInt16 = (x) => {
    const s = x < -1 ? -1 : x > 1 ? 1 : x;
    return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  };

  Wav.fromAudioBuffer = (buffer) => {
    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    return Wav.encode(chans, buffer.sampleRate);
  };

  /* ---------- MP3 ---------- */
  const Mp3 = {};

  Mp3.available = () => typeof window.lamejs === 'function' || (window.lamejs && window.lamejs.Mp3Encoder);

  // Encode par tranches pour laisser l'interface respirer et afficher la progression.
  Mp3.encode = async (channels, sampleRate, kbps, onProgress) => {
    const lame = window.lamejs;
    const Encoder = lame.Mp3Encoder;
    const nc = Math.min(2, channels.length);
    const enc = new Encoder(nc, sampleRate, kbps);
    const len = channels[0].length;
    const block = 1152 * 20;
    const left = new Int16Array(block);
    const right = new Int16Array(block);
    const parts = [];
    let lastYield = performance.now();
    for (let i = 0; i < len; i += block) {
      const n = Math.min(block, len - i);
      const l = n === block ? left : new Int16Array(n);
      const r = n === block ? right : new Int16Array(n);
      const cl = channels[0];
      const cr = channels[nc - 1];
      for (let j = 0; j < n; j++) {
        l[j] = Wav.toInt16(cl[i + j]);
        r[j] = Wav.toInt16(cr[i + j]);
      }
      const out = nc === 2 ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
      if (out.length) parts.push(new Uint8Array(out));
      if (performance.now() - lastYield > 40) {
        if (onProgress) onProgress(i / len);
        await new Promise((res) => setTimeout(res, 0));
        lastYield = performance.now();
      }
    }
    const tail = enc.flush();
    if (tail.length) parts.push(new Uint8Array(tail));
    if (onProgress) onProgress(1);
    return new Blob(parts, { type: 'audio/mpeg' });
  };

  /* ---------- ZIP (sans compression) ---------- */
  const Zip = {};

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  Zip.crc32 = (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  // files : [{name, data: Uint8Array|ArrayBuffer|string}] -> Blob (application/zip)
  Zip.create = (files) => {
    const parts = [];
    const central = [];
    let offset = 0;
    const { time, date } = dosDateTime(new Date());
    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data =
        typeof f.data === 'string' ? enc.encode(f.data) : f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
      const crc = Zip.crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // noms en UTF-8
      local.setUint16(8, 0, true); // stockage simple
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      parts.push(local.buffer, nameBytes, data);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, time, true);
      cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, nameBytes.length, true);
      cen.setUint32(42, offset, true);
      central.push(cen.buffer, nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const centralSize = central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  };

  // Lit une archive ZIP (stockée ou compressée « deflate » si le navigateur sait la décompresser).
  // Renvoie Map nom -> Uint8Array.
  Zip.read = async (arrayBuffer) => {
    const bytes = new Uint8Array(arrayBuffer);
    const v = new DataView(arrayBuffer);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (v.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Ce fichier n’est pas un projet valide (archive illisible).');
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const out = new Map();
    for (let i = 0; i < count; i++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Archive endommagée.');
      const method = v.getUint16(p + 10, true);
      const csize = v.getUint32(p + 20, true);
      const nlen = v.getUint16(p + 28, true);
      const xlen = v.getUint16(p + 30, true);
      const clen = v.getUint16(p + 32, true);
      const localOff = v.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
      const lnlen = v.getUint16(localOff + 26, true);
      const lxlen = v.getUint16(localOff + 28, true);
      const start = localOff + 30 + lnlen + lxlen;
      const raw = bytes.subarray(start, start + csize);
      if (method === 0) out.set(name, raw);
      else if (method === 8 && typeof DecompressionStream === 'function') {
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        out.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
      } else {
        throw new Error('Format de compression non géré pour « ' + name + ' ».');
      }
      p += 46 + nlen + xlen + clen;
    }
    return out;
  };

  Zip.text = (bytes) => dec.decode(bytes);

  MA.Wav = Wav;
  MA.Mp3 = Mp3;
  MA.Zip = Zip;
})((window.MA = window.MA || {}));
