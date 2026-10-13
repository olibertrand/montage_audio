// Tests dans un vrai navigateur (Chromium via Playwright).
// Lancement : npm run test:browser   (nécessite « npm install playwright » et Chromium)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  /* Playwright absent : tests ignorés */
}

const APP = 'file://' + path.join(__dirname, '..', 'index.html');
const skip = !chromium && 'Playwright n’est pas installé';

async function openApp(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, ...opts });
  // Les polices en ligne ne sont pas utiles aux tests.
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loading', { state: 'hidden', timeout: 20000 });
  return { ctx, page, errors };
}

test('le mixage final respecte volumes, fondus, courbe et effacement', { skip }, async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await openApp(browser);
    const values = await page.evaluate(async () => {
      const { Store, Engine, Peaks, U } = MA;
      const sr = 44100;
      const mk = (seconds, channels) => {
        const b = new AudioBuffer({ length: seconds * sr, numberOfChannels: channels, sampleRate: sr });
        for (let c = 0; c < channels; c++) b.getChannelData(c).fill(0.5);
        return b;
      };
      const mono = mk(10, 1);
      const stereo = mk(10, 2);
      Store.sources.set('mono', { id: 'mono', name: 'mono', buffer: mono, peaks: Peaks.compute(mono) });
      Store.sources.set('stereo', { id: 'stereo', name: 'stereo', buffer: stereo, peaks: Peaks.compute(stereo) });
      const half = U.gainToDb(0.5);
      const state = Store.emptyState();
      state.tracks = [
        { id: 'A', name: 'A', color: '#000', volume: half, pan: 0, mute: false, solo: false, duck: false },
        { id: 'B', name: 'B', color: '#000', volume: 0, pan: 0, mute: false, solo: false, duck: true, duckDb: -12 },
      ];
      state.clips = [
        { id: 'a', trackId: 'A', sourceId: 'mono', start: 0, offset: 0, duration: 4, gain: half, fadeIn: 1, fadeOut: 0, envelope: [{ t: 2, g: 1 }, { t: 3, g: 0.5 }] },
        { id: 'a2', trackId: 'A', sourceId: 'mono', start: 6, offset: 0, duration: 1, gain: 0, fadeIn: 0, fadeOut: 0, envelope: [] },
        { id: 'b', trackId: 'B', sourceId: 'stereo', start: 0, offset: 0, duration: 10, gain: 0, fadeIn: 0, fadeOut: 0, envelope: [] },
      ];
      Store.state = state;
      const out = await Engine.render({ sampleRate: sr });
      const L = out.getChannelData(0);
      const R = out.getChannelData(1);
      const at = (t) => [L[Math.round(t * sr)], R[Math.round(t * sr)]];
      // Même graphe lancé à 0,5 s (lecture démarrée en cours de route)
      const off = new OfflineAudioContext(2, 8 * sr, sr);
      Engine._buildGraph(off, off.destination, state, Store.sources, 0.5, 0, false);
      const mid = (await off.startRendering()).getChannelData(0);
      return {
        t05: at(0.5), t15: at(1.5), t25: at(2.5), t35: at(3.5), t50: at(5), t65: at(6.5), t90: at(9),
        mid075: mid[Math.round(0.25 * sr)], full075: L[Math.round(0.75 * sr)],
      };
    });
    const low = 0.5 * Math.pow(10, -12 / 20);
    const expected = {
      t05: 0.125 * Math.SQRT1_2 + low,
      t15: 0.125 + low,
      t25: 0.125 * 0.75 + low,
      t35: 0.0625 + low,
      t50: 0.5,
      t65: 0.25 + low,
      t90: 0.5,
    };
    for (const [k, v] of Object.entries(expected)) {
      assert.ok(Math.abs(values[k][0] - v) < 0.002 && Math.abs(values[k][1] - v) < 0.002, `${k} : attendu ${v}, obtenu ${values[k]}`);
    }
    assert.ok(Math.abs(values.mid075 - values.full075) < 0.002, 'lecture démarrée en cours de route');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('importer, couper, exporter, retrouver le montage après rechargement', { skip }, async () => {
  const browser = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'montage-'));
  try {
    const { page, errors } = await openApp(browser);
    // Un petit fichier WAV fabriqué par l'application elle-même
    const wav = await page.evaluate(() => {
      const sr = 22050;
      const ch = new Float32Array(sr * 3).map((_, i) => 0.3 * Math.sin(i / 5));
      return Array.from(new Uint8Array(MA.Wav.encode([ch], sr)));
    });
    const wavPath = path.join(dir, 'essai.wav');
    fs.writeFileSync(wavPath, Buffer.from(wav));

    await page.click('#btn-banner-new');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btn-import')]);
    await chooser.setFiles(wavPath);
    await page.waitForFunction(() => MA.Store.state.clips.length === 1);
    await page.evaluate(() => {
      MA.Store.selection = new Set([MA.Store.state.clips[0].id]);
      MA.App.selectionChanged();
      MA.App.seek(1);
    });
    await page.keyboard.press('s');
    const clips = await page.evaluate(() => MA.Store.state.clips.map((c) => [c.start, +c.duration.toFixed(3), c.offset]));
    assert.deepEqual(clips, [[0, 1, 0], [1, 2, 1]]);

    await page.click('#btn-export');
    await page.check('#fmt-wav');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.dialog-foot .btn.primary')]);
    const out = path.join(dir, 'sortie.wav');
    await dl.saveAs(out);
    const head = fs.readFileSync(out).subarray(0, 4).toString();
    assert.equal(head, 'RIFF');
    assert.equal(dl.suggestedFilename(), 'Mon montage.wav');

    await page.waitForTimeout(800); // sauvegarde automatique
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loading', { state: 'hidden' });
    const restored = await page.evaluate(() => ({ clips: MA.Store.state.clips.length, demo: MA.Store.isDemo }));
    assert.deepEqual(restored, { clips: 2, demo: false });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
