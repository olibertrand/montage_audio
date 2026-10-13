// Charge les scripts de l'application dans Node (sans navigateur) pour tester la logique pure.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

globalThis.window = globalThis;

function load(...files) {
  for (const f of files) {
    const file = path.join(__dirname, '..', 'js', f);
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  }
  return globalThis.MA;
}

// Imitation minimale d'un AudioBuffer.
function fakeBuffer(channels, sampleRate) {
  return {
    sampleRate,
    length: channels[0].length,
    duration: channels[0].length / sampleRate,
    numberOfChannels: channels.length,
    getChannelData: (c) => channels[c],
  };
}

module.exports = { load, fakeBuffer };
