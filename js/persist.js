/* Sauvegarde automatique (IndexedDB du navigateur), fichiers projet et téléchargements. */
(function (MA) {
  'use strict';
  const U = MA.U;
  const Zip = MA.Zip;

  const DB_NAME = 'montage-audio';
  const DB_VERSION = 1;

  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  const Persist = { db: null, ok: false };

  Persist.open = async () => {
    try {
      if (!window.indexedDB) return false;
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      Persist.db = await req(r);
      Persist.ok = true;
    } catch (e) {
      Persist.ok = false;
    }
    return Persist.ok;
  };

  function store(name, mode) {
    return Persist.db.transaction(name, mode).objectStore(name);
  }

  Persist.putSource = async (src) => {
    if (!Persist.ok) return;
    await req(store('sources', 'readwrite').put({ id: src.id, name: src.name, mime: src.mime, data: src.data }));
  };

  Persist.getSource = async (id) => {
    if (!Persist.ok) return null;
    return req(store('sources', 'readonly').get(id));
  };

  // Supprime les fichiers qui ne servent plus à aucun morceau.
  Persist.pruneSources = async (keepIds) => {
    if (!Persist.ok) return;
    const keys = await req(store('sources', 'readonly').getAllKeys());
    const st = store('sources', 'readwrite');
    for (const k of keys) if (!keepIds.has(k)) st.delete(k);
  };

  Persist.saveProject = async (state, ui) => {
    if (!Persist.ok) return;
    await req(store('kv', 'readwrite').put({ state, ui, savedAt: Date.now() }, 'project'));
  };

  Persist.loadProject = async () => {
    if (!Persist.ok) return null;
    try {
      return await req(store('kv', 'readonly').get('project'));
    } catch (e) {
      return null;
    }
  };

  Persist.getPref = async (key) => {
    if (!Persist.ok) return null;
    try {
      return await req(store('kv', 'readonly').get('pref:' + key));
    } catch (e) {
      return null;
    }
  };

  Persist.setPref = async (key, value) => {
    if (!Persist.ok) return;
    try {
      await req(store('kv', 'readwrite').put(value, 'pref:' + key));
    } catch (e) {
      /* sans importance */
    }
  };

  /* ---------- Fichier projet (.montage = archive ZIP) ---------- */
  const extOf = (name) => {
    const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
    return m ? m[1].toLowerCase() : 'bin';
  };

  Persist.buildProjectFile = (state, sources) => {
    const used = MA.Store.usedSourceIds(state);
    const files = [];
    const list = [];
    for (const id of used) {
      const s = sources.get(id);
      if (!s || !s.data) continue;
      const path = `sons/${id}-${U.safeFileName(U.baseName(s.name)).slice(0, 40)}.${extOf(s.name)}`;
      list.push({ id, name: s.name, mime: s.mime || '', file: path });
      files.push({ name: path, data: new Uint8Array(s.data) });
    }
    const manifest = { app: 'montage-audio', version: 1, state, sources: list };
    files.unshift({ name: 'projet.json', data: JSON.stringify(manifest, null, 1) });
    return Zip.create(files);
  };

  Persist.readProjectFile = async (arrayBuffer) => {
    const entries = await Zip.read(arrayBuffer);
    const json = entries.get('projet.json');
    if (!json) throw new Error('Ce fichier n’est pas un projet Montage Audio.');
    const manifest = JSON.parse(Zip.text(json));
    if (manifest.app !== 'montage-audio' || !manifest.state) throw new Error('Ce fichier n’est pas un projet Montage Audio.');
    const sources = [];
    for (const s of manifest.sources || []) {
      const bytes = entries.get(s.file);
      if (!bytes) continue;
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      sources.push({ id: s.id, name: s.name, mime: s.mime, data });
    }
    return { state: manifest.state, sources };
  };

  /* ---------- Téléchargements ----------
     Dans un navigateur : lien de téléchargement classique.
     Publiée sur claude.ai, la page passe par la capacité « downloads », qui n'accepte
     que certains formats : les sons sont alors livrés dans une archive .zip. */
  const Download = {
    inArtifact: !!(window.claude && typeof window.claude.use === 'function'),
    api: null,
    ready: null,
  };

  Download.init = () => {
    if (!Download.inArtifact) {
      Download.ready = Promise.resolve(null);
      return Download.ready;
    }
    Download.ready = window.claude
      .use('downloads')
      .then((api) => {
        Download.api = api;
        return api;
      })
      .catch(() => null);
    return Download.ready;
  };

  const ARTIFACT_EXT = ['zip', 'webm', 'json', 'txt', 'mp4'];

  // Renvoie {filename, wrapped} : le nom réellement proposé et si le fichier a été mis dans un .zip.
  Download.save = async (blob, filename, { isZip = false } = {}) => {
    if (Download.inArtifact) {
      const api = await Download.ready;
      if (!api) throw new Error('Le téléchargement n’est pas disponible dans cette page. Ouvrez l’application depuis son fichier index.html pour enregistrer vos fichiers.');
      let name = filename;
      let data = blob;
      let wrapped = false;
      const ext = extOf(filename);
      if (!ARTIFACT_EXT.includes(ext)) {
        if (isZip) {
          name = filename.replace(/\.[^.]+$/, '') + '.zip';
        } else {
          const inner = new Uint8Array(await blob.arrayBuffer());
          data = Zip.create([{ name: filename, data: inner }]);
          name = filename.replace(/\.[^.]+$/, '') + '.zip';
          wrapped = true;
        }
      }
      try {
        await api.save({ filename: name, data });
      } catch (e) {
        if (e && e.code === 'declined') return { filename: name, wrapped, declined: true };
        throw new Error('Le téléchargement a échoué' + (e && e.message ? ' : ' + e.message : '.'));
      }
      return { filename: name, wrapped };
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { filename, wrapped: false };
  };

  MA.Persist = Persist;
  MA.Download = Download;
})((window.MA = window.MA || {}));
