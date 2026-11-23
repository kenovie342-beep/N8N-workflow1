'use strict';
// Shared sample job used by unit + integration tests.
const assets = [
  { id: 'presenter', type: 'video', role: 'presenter', uri: 'presenter.mp4' },
  { id: 'screen', type: 'video', role: 'screen_recording', uri: 'screen.mp4' },
  { id: 'stock', type: 'video', role: 'stock', uri: 'stock.mp4' },
  { id: 'narr', type: 'audio', role: 'narration', uri: 'narration.wav' },
  { id: 'music', type: 'audio', role: 'music', uri: 'music.mp3' },
  { id: 'whoosh', type: 'audio', role: 'sfx', uri: 'whoosh.wav' },
  { id: 'logo', type: 'image', role: 'image', uri: 'logo.png' },
];
const plan = {
  version: 1,
  scenes: [
    { id: 'hook', duration: 6, layers: [{ type: 'video', asset: 'presenter', trim: { start: 0, end: 6 } }, { type: 'text', text: 'Stop wasting time!', anchor: 'top', font_size: 0.07, start: 0.5, end: 5 }] },
    { id: 'demo', duration: 8, transition_in: { type: 'slideleft', duration: 0.8 }, layers: [{ type: 'video', asset: 'screen', fit: 'contain' }, { type: 'video', asset: 'presenter', trim: { start: 6 }, anchor: 'bottom-right', size: 0.25, border: { width: 4, color: '#FFFFFF' } }] },
    { id: 'broll', duration: 6, transition_in: { type: 'fade', duration: 0.6 }, layers: [{ type: 'video', asset: 'stock', speed: 1.5 }, { type: 'text', text: 'Subscribe for more', anchor: 'bottom', font_size: 0.06 }] },
  ],
  audio: { narration: { asset: 'narr', start: 0.3 }, music: { asset: 'music', volume: 0.2, fade_out: 2, duck: true }, sfx: [{ asset: 'whoosh', at: 5.4, volume: 0.8 }] },
  captions: { cues: { en: [{ start: 0.5, end: 3, text: 'Welcome to the tutorial' }, { start: 3.2, end: 8, text: 'Here is the demo' }, { start: 8.5, end: 18, text: 'Thanks for watching' }], fr: [{ start: 0.5, end: 3, text: 'Bienvenue dans le tutoriel' }, { start: 3.2, end: 8, text: 'Voici la démo' }, { start: 8.5, end: 18, text: 'Merci de votre attention' }] } },
  watermark: { asset: 'logo', anchor: 'top-right', size: 0.1, opacity: 0.8 },
};
module.exports = { assets, plan };
