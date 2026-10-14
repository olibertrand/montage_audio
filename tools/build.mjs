// Assemble l'application en un seul fichier HTML autonome.
//   node tools/build.mjs                      -> dist/montage-audio.html (fonctionne hors connexion)
//   node tools/build.mjs --artifact <sortie>  -> fragment pour une page publiée sur claude.ai
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const LAME_CDN = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';

// Les polices sont intégrées au fichier (data: URI) : aucun fichier à côté, aucune requête extérieure.
const embedFonts = (css) =>
  css.replace(/url\('\.\.\/(fonts\/[^']+\.woff2)'\)/g, (_, f) => `url(data:font/woff2;base64,${fs.readFileSync(path.join(root, f)).toString('base64')})`);

function inline(html, { artifact }) {
  html = html.replace(/<link rel="stylesheet" href="(css\/[^"]+)">/g, (_, f) => `<style>\n${embedFonts(read(f))}</style>`);
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, f) => {
    if (artifact && f.startsWith('vendor/lame')) return `<script src="${LAME_CDN}"></script>`;
    const code = read(f).replace(/<\/script/gi, '<\\/script');
    return `<script>\n${code}</script>`;
  });
  return html;
}

function between(html, start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a < 0 || b < 0) throw new Error(`Repère introuvable : ${start}`);
  return html.slice(a + start.length, b).trim();
}

const source = read('index.html');
const args = process.argv.slice(2);

if (args[0] === '--artifact') {
  // La page publiée reçoit son propre squelette (doctype, head, body) : on n'envoie que le contenu.
  const out = args[1] || path.join(root, 'dist', 'artifact.html');
  const html = inline(source, { artifact: true });
  const page = between(html, '<!-- page:head -->', '<!-- /page:head -->') + '\n' + between(html, '<!-- page:body -->', '<!-- /page:body -->') + '\n';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, page);
  console.log(`${out} (${Math.round(page.length / 1024)} Ko)`);
} else {
  const out = path.join(root, 'dist', 'montage-audio.html');
  const html = inline(source, { artifact: false });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`${out} (${Math.round(html.length / 1024)} Ko)`);
}
