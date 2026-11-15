/* ============================================================
   SHORTIFY · data.js
   Demo source + auto-detection heuristics + export presets
   ============================================================ */
(function () {
  const SHORTIFY = (window.SHORTIFY = window.SHORTIFY || {});

  /* ---------- demo source (open license) ---------- */
  SHORTIFY.DEMO = {
    id: 'aqz-KE-bpKQ',
    url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    title: 'Big Buck Bunny — 4K Master Demo Reel',
    channel: 'Blender Foundation',
    duration: 120,             // 120s HD slice bundled locally
    sourceDuration: 635,       // full film
    sourceHeight: 1080,        // real master height used by the renderer
    thumb: 'media/poster.jpg',
    storyboard: 'media/storyboard.jpg',
    file: 'media/demo.mp4',    // 720p web preview
    renderFile: 'media/source1080.mp4',
    license: 'CC-BY 3.0 · Blender Foundation'
  };

  /* tiny stable hash → seeded pseudo-random (deterministic per link) */
  SHORTIFY.hash = function (str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0);
  };
  SHORTIFY.rng = function (seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };
  SHORTIFY.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  SHORTIFY.fmt = function (t, withH = false) {
    t = Math.max(0, t);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const ss = s < 10 ? '0' + s.toFixed(1) : s.toFixed(1);
    if (h || withH) return h + ':' + String(m).padStart(2, '0') + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  };
  SHORTIFY.fmtTC = function (t) {
    t = Math.max(0, t);
    const m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.floor((t * 100) % 100);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(f).padStart(2, '0');
  };

  /* ---------- captions pool (word-timed later) ---------- */
  SHORTIFY.HOOKS = [
    'Wait for the twist…',
    'This changes everything',
    'I was NOT ready for this',
    'Watch till the end 👀',
    'The bunny strikes back',
    'POV: you made a giant mad',
    'How it started → how it’s going',
    'Nobody talks about this part',
    'He should NOT have done that',
    'This took 3 days to animate'
  ];

  SHORTIFY.CAPTIONS = [
    'big buck bunny woke up and chose chaos',
    'the giant butterfly had no idea what was coming',
    'this whole meadow is about to get personal',
    'step one: look harmless. step two: absolutely not',
    'the squirrel never saw the catapult coming',
    'he built the trap himself and it shows',
    'nature said no and he said watch me',
    'that grin means someone is in trouble',
    'three birds, one very suspicious bunny',
    'the punchline lands at second twelve',
    'every frame of this is hand animated chaos',
    'pause at the end and look at his face',
    'this is why you never trust a quiet bunny',
    'the trap snaps and the whole forest reacts',
    'turns out the bully picked the wrong rodent'
  ];

  SHORTIFY.SUBLINES = [
    'auto-cut · word-timed captions',
    'hook in the first 0.8s',
    '9:16 conversation starter',
    'moment score 90+'
  ];

  /* ---------- moment detection (deterministic from the link) ---------- */
  SHORTIFY.buildMoments = function (duration, seedStr) {
    const rand = SHORTIFY.rng(SHORTIFY.hash(seedStr || 'shortify'));
    const moments = [];
    const count = 4;
    const minLen = 14, maxLen = Math.min(30, Math.max(18, duration / 5));
    const floor = Math.min(12, duration * 0.08);          // skip intros / title cards
    let cursor = floor + rand() * 2;
    const usedHooks = [];
    const usedCaps = [];
    function pickUnique(pool, used, salt) {
      let idx = (salt * 3 + Math.floor(rand() * pool.length)) % pool.length;
      let guard = 0;
      while (used.includes(idx) && guard++ < pool.length) idx = (idx + 1) % pool.length;
      used.push(idx);
      return pool[idx];
    }
    for (let i = 0; i < count; i++) {
      const len = Math.round(minLen + rand() * (maxLen - minLen));
      let start = cursor + rand() * 6;
      if (start + len > duration - 2) start = Math.max(0, duration - len - 2);
      const score = Math.round(76 + rand() * 22);
      const hook = pickUnique(SHORTIFY.HOOKS, usedHooks, i);
      const cap = pickUnique(SHORTIFY.CAPTIONS, usedCaps, i + 2);
      moments.push({
        id: 'm' + i,
        start: Math.round(start * 10) / 10,
        end: Math.round((start + len) * 10) / 10,
        score,
        hook,
        caption: cap,
        tag: ['HOOK', 'PAYOFF', 'BEAT', 'TWIST'][i % 4],
        tagCls: ['', 'b', 'p', ''][i % 4]
      });
      cursor = start + len + 3 + rand() * 4;
    }
    return moments;
  };

  /* energy curve for the bundled clip (same math as the analyzer) */
  SHORTIFY.energyAt = function (t) {
    const w =
      0.42 * Math.abs(Math.sin(t * 0.9 + 1.3)) +
      0.33 * Math.abs(Math.sin(t * 0.23 + 0.4)) +
      0.25 * Math.abs(Math.sin(t * 2.7 + 2.1));
    return Math.min(1, Math.max(0.06, w));
  };
  /* audio peaks are injected by the build script into assets/peaks.json and
     loaded at boot; this keeps the waveform visible even from file:// */
  SHORTIFY.PEAKS = SHORTIFY.PEAKS || null;

  /* beat markers at 96 BPM */
  SHORTIFY.beatsIn = function (start, end, bpm) {
    bpm = bpm || 96;
    const step = 60 / bpm;
    const out = [];
    for (let t = Math.ceil(start / step) * step; t < end; t += step) out.push(Math.round(t * 1000) / 1000);
    return out;
  };

  /* ---------- looks ---------- */
  SHORTIFY.LOOKS = [
    { id: 'none', name: 'Original', sw: 'linear-gradient(135deg,#5c7a55,#8fae7a)', css: 'none', ff: '' },
    { id: 'vivid', name: 'Vivid', sw: 'linear-gradient(135deg,#ff7a59,#ffd166,#06d6a0)', css: 'saturate(1.45) contrast(1.12)', ff: 'eq=saturation=1.45:contrast=1.12' },
    { id: 'cinema', name: 'Cinema', sw: 'linear-gradient(135deg,#1b2a4a,#4a6fa5,#c9d6e3)', css: 'contrast(1.18) saturate(.82) brightness(.94)', ff: 'eq=contrast=1.18:saturation=0.82:brightness=-0.06' },
    { id: 'noir', name: 'Noir', sw: 'linear-gradient(135deg,#111,#555,#ddd)', css: 'grayscale(1) contrast(1.22)', ff: 'hue=s=0,eq=contrast=1.22' },
    { id: 'sunset', name: 'Sunset', sw: 'linear-gradient(135deg,#ff9f45,#ff5d8f,#7c5cff)', css: 'sepia(.28) saturate(1.35) contrast(1.06) hue-rotate(-8deg)', ff: 'eq=saturation=1.35:contrast=1.06,colorbalance=rs=.12:bs=-.08' },
    { id: 'neon', name: 'Neon', sw: 'linear-gradient(135deg,#00f5d4,#7c5cff,#f15bb5)', css: 'saturate(1.6) contrast(1.15) hue-rotate(12deg)', ff: 'eq=saturation=1.6:contrast=1.15,hue=h=12' }
  ];

  /* ---------- effects registry ---------- */
  SHORTIFY.EFFECTS = [
    {
      id: 'punch', name: 'Punch-in', desc: 'Snap zoom on every cut & beat',
      icon: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'
    },
    {
      id: 'shake', name: 'Camera shake', desc: 'Impact wobble on beats',
      icon: '<path d="M3 12h3l2-6 3 12 3-9 2 5 2-3h3"/>'
    },
    {
      id: 'whip', name: 'Whip blur', desc: 'Fast swipe transition blur',
      icon: '<path d="M2 12h20M6 7l-4 5 4 5M18 7l4 5-4 5"/>'
    },
    {
      id: 'pulse', name: 'Beat pulse', desc: 'Brightness & scale on 96 BPM',
      icon: '<path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="3"/>'
    },
    {
      id: 'glitch', name: 'Glitch bars', desc: 'Digital tearing & slices',
      icon: '<path d="M3 6h18M3 12h11M3 18h15M17 9l3 3-3 3"/>'
    },
    {
      id: 'rgb', name: 'RGB split', desc: 'Chromatic aberration edges',
      icon: '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>'
    },
    {
      id: 'vhs', name: 'VHS wash', desc: 'Scanlines, jitter & warm noise',
      icon: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h10M7 14h6"/>'
    },
    {
      id: 'kenburns', name: 'Ken Burns', desc: 'Slow drifting push across the cut',
      icon: '<path d="M4 20L20 4M4 20h16V4"/>'
    },
    {
      id: 'flash', name: 'White flash', desc: 'Cut-in flash frames',
      icon: '<path d="M13 2L4.5 13.5H11L9.5 22 19 10h-6.5L13 2z"/>'
    },
    {
      id: 'squeeze', name: 'Squeeze', desc: 'Horizontal squash on the beat',
      icon: '<rect x="4" y="6" width="16" height="12" rx="3"/><path d="M9 12h6M12 9v6"/>'
    }
  ];

  /* ---------- export presets ---------- */
  SHORTIFY.PRESETS = {
    '9:16': { w: 1080, h: 1920 },
    '1:1': { w: 1080, h: 1080 },
    '4:5': { w: 1080, h: 1350 }
  };
})();
