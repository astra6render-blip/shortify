/* ============================================================
   SHORTIFY · editor.js
   Studio controller: timeline, playback, captions, panels, undo
   ============================================================ */
(function () {
  const S = window.SHORTIFY;
  const $ = (id) => document.getElementById(id);
  const clamp = S.clamp;
  const DPR = () => Math.min(2, window.devicePixelRatio || 1);

  const St = {
    source: null,
    moments: [],
    current: 0,
    cut: { start: 0, end: 30 },
    aspect: '9:16',
    look: 'vivid',
    effects: S.EFFECTS.map(e => ({ id: e.id, on: false })),
    intensity: 60,
    zoomAmt: 12,
    bpm: 96,
    beatOn: true,
    beatPattern: [true, true, true, true, true, true, true, true],
    capText: '',
    capAnim: 'karaoke',
    capPos: 'low',
    capSize: 96,
    capHi: '#ffe14d',
    capBg: true,
    capStroke: true,
    cardOn: true,
    cardText: '',
    safeOn: false,
    letterbox: false,
    fps: 30,
    smooth: false,
    preset: '1080',
    quality: 'high',
    splits: [],
    pxPerSec: 9,
    playing: false
  };
  let undoStack = [], redoStack = [];
  let video, vctx, fxCanvas, fxctx, tlInner, cutRange, playhead;
  let dur = 150;
  let raf = null, wordState = -1, capKey = '', capPhrases = [], capPhraseIdx = -1;
  let draggable = null;
  let pendingSeek = null;
  let storyboardImg = null;
  let heroTimer = null;

  function requestSeek(t) {
    t = clamp(t, 0, Math.max(0, dur - 0.05));
    updateTransport(t);
    /* if the element can't seek yet, park the request until canplay */
    if (!video || video.readyState < 1) {
      pendingSeek = t;
      return;
    }
    try { video.currentTime = t; } catch (e) { pendingSeek = t; }
    updateStage(t);
  }

  /* ------------------------------------------------------------
     init
     ------------------------------------------------------------ */
  S.Editor = {
    init(project) {
      St.source = project.source;
      St.moments = project.moments || [];
      St.current = 0;
      video = $('editorVideo');
      fxCanvas = $('fxCanvas');
      fxctx = fxCanvas.getContext('2d');
      tlInner = $('tlInner');
      cutRange = $('cutRange');
      playhead = $('playhead');
      dur = St.source.duration || 150;
      undoStack = []; redoStack = [];

      loadStoryboard();
      applyMoment(0, true);
      buildMoments();
      buildEffects();
      buildLooks();
      buildBeatRow();
      bindSource();
      bindPanels();
      bindTransport();
      bindTimeline();
      bindKeys();
      bindExport();
      syncAll();
      startLoop();
      onResize();
      setTimeout(() => { sizeCanvas(); drawTimeline(); }, 60);
    },
    teardown() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      if (heroTimer) clearInterval(heroTimer);
      if (video) { try { video.pause(); } catch (e) {} }
    },
    get state() { return St; }
  };

  /* ------------------------------------------------------------
     project helpers
     ------------------------------------------------------------ */
  function loadStoryboard() {
    if (!storyboardImg) {
      storyboardImg = new Image();
      storyboardImg.src = St.source.storyboard || 'media/storyboard.jpg';
    }
  }
  function applyMoment(i, silent) {
    if (!St.moments.length) {
      St.cut = { start: 0, end: Math.min(30, dur) };
      return;
    }
    i = clamp(i, 0, St.moments.length - 1);
    St.current = i;
    const m = St.moments[i];
    St.cut = { start: m.start, end: m.end };
    St.capText = m.caption;
    St.cardText = m.hook;
    St.splits = [];
    if (!silent) {
      undo('switch moment');
      seekTo(m.start);
      syncAll();
      toast('Cut ready', '“' + m.hook + '” · ' + (m.end - m.start).toFixed(1) + 's', 'ok');
    }
    highlightMoment();
  }

  function buildMoments() {
    const list = $('momentList');
    list.innerHTML = '';
    St.moments.forEach((m, i) => {
      const btn = document.createElement('button');
      btn.className = 'moment-item' + (i === St.current ? ' on' : '');
      btn.dataset.i = i;
      const thumbIdx = clamp(Math.round((m.start / dur) * 9), 0, 9);
      const tagCls = m.tagCls || '';
      btn.innerHTML =
        '<img src="media/thumbs/t' + thumbIdx + '.jpg" alt="" onerror="this.src=\'media/poster.jpg\'">' +
        '<span class="mi-body">' +
        '<span class="mi-title">' + esc(m.hook) + '</span>' +
        '<span class="mi-meta"><span class="mi-tag ' + tagCls + '">' + m.tag + '</span>' +
        S.fmt(m.start) + '–' + S.fmt(m.end) + ' · ' + (m.end - m.start).toFixed(0) + 's</span>' +
        '</span>' +
        '<span class="score-ring" style="--p:' + m.score + '"><b>' + m.score + '</b></span>';
      btn.addEventListener('click', () => applyMoment(i));
      list.appendChild(btn);
    });
  }
  function highlightMoment() {
    document.querySelectorAll('.moment-item').forEach(el => {
      el.classList.toggle('on', +el.dataset.i === St.current);
    });
  }
  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ------------------------------------------------------------
     panels
     ------------------------------------------------------------ */
  function bindPanels() {
    /* left tabs */
    $('leftTabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      [...$('leftTabs').children].forEach(x => x.classList.toggle('on', x === b));
      $('tabMoments').hidden = b.dataset.tab !== 'moments';
      $('tabSource').hidden = b.dataset.tab !== 'source';
    });
    /* right tabs */
    $('rightTabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      switchTab(b.dataset.tab);
    });
    /* format */
    $('formatTabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-ar]');
      if (!b) return;
      [...$('formatTabs').children].forEach(x => x.classList.toggle('on', x === b));
      St.aspect = b.dataset.ar;
      const pc = $('phoneCanvas');
      pc.classList.remove('ar-1-1', 'ar-4-5');
      if (St.aspect === '1:1') pc.classList.add('ar-1-1');
      if (St.aspect === '4:5') pc.classList.add('ar-4-5');
      pc.classList.toggle('lb', St.letterbox);
      updateFrameNote();
      renderExportSummary();
      sizeCanvas();
      drawTimeline();
      toast('Frame set', St.aspect + ' canvas', 'ok');
    });
    /* captions */
    $('capText').addEventListener('input', e => {
      St.capText = e.target.value;
      buildCaptionDOM(true);
      drawCaptionsTrack();
      renderExportSummary();
    });
    $('capAnim').addEventListener('change', e => { St.capAnim = e.target.value; buildCaptionDOM(true); });
    $('capPos').addEventListener('change', e => {
      St.capPos = e.target.value;
      const l = $('captionLayer');
      l.classList.remove('mid', 'high');
      if (St.capPos === 'mid') l.classList.add('mid');
      if (St.capPos === 'high') l.classList.add('high');
    });
    $('capSize').addEventListener('input', e => {
      St.capSize = +e.target.value;
      $('capSizeOut').textContent = St.capSize;
      updateCapSize();
    });
    $('capHiSwatches').addEventListener('click', e => {
      const b = e.target.closest('.sw');
      if (!b) return;
      St.capHi = b.dataset.c;
      [...$('capHiSwatches').children].forEach(x => x.classList.toggle('on', x === b));
      document.documentElement.style.setProperty('--hi', St.capHi);
      renderCaptionsBlock();
    });
    $('cardOn').addEventListener('change', e => { St.cardOn = e.target.checked; renderCaptionsBlock(); renderExportSummary(); });
    $('cardText').addEventListener('input', e => { St.cardText = e.target.value; renderCaptionsBlock(); });
    $('capBg').addEventListener('change', e => { St.capBg = e.target.checked; updateCapClasses(); });
    $('capStroke').addEventListener('change', e => { St.capStroke = e.target.checked; updateCapClasses(); });

    /* effects list */
    $('fxList').addEventListener('click', e => {
      const item = e.target.closest('.fx-item');
      if (!item) return;
      const id = item.dataset.id;
      const fx = St.effects.find(f => f.id === id);
      fx.on = !fx.on;
      item.classList.toggle('on', fx.on);
      undo('toggle effect');
      if (fx.on) toast('Effect on', label(id), 'ok'); 
      updateStickers();
      renderExportSummary();
    });
    $('fxIntensity').addEventListener('input', e => {
      St.intensity = +e.target.value;
      $('fxIntOut').textContent = St.intensity;
      S.FX.intensity = St.intensity / 100;
      renderExportSummary();
    });

    /* looks */
    $('lookGrid').addEventListener('click', e => {
      const c = e.target.closest('.look-card');
      if (!c) return;
      St.look = c.dataset.id;
      [...$('lookGrid').children].forEach(x => x.classList.toggle('on', x === c));
      undo('look');
    });
    $('zoomAmt').addEventListener('input', e => {
      St.zoomAmt = +e.target.value;
      $('zoomOut').textContent = St.zoomAmt;
      renderExportSummary();
    });
    $('bpmOut').addEventListener('click', () => {
      const seq = [90, 96, 110, 120, 128, 140];
      St.bpm = seq[(seq.indexOf(St.bpm) + 1) % seq.length];
      S.Beat.bpm = St.bpm;
      $('bpmOut').textContent = St.bpm + ' BPM';
      buildBeatRow();
      renderExportSummary();
      toast('Tempo', St.bpm + ' BPM — effects re-sync', 'ok');
    });
    $('beatOn').addEventListener('change', e => { St.beatOn = e.target.checked; S.Beat.on = St.beatOn; });
    $('safeOn').addEventListener('change', e => { St.safeOn = e.target.checked; $('safeAreas').hidden = !St.safeOn; });
    $('letterbox').addEventListener('change', e => { St.letterbox = e.target.checked; updateLetterbox(); });

    /* source load */
    $('srcLoad').addEventListener('click', () => {
      const url = $('srcUrl').value.trim();
      if (!url) return;
      window.ShortifyApp.loadSource(url);
    });
    /* top bar */
    $('autoRecutBtn').addEventListener('click', () => {
      const seed = St.source.id + ':' + Date.now();
      St.moments = S.buildMoments(dur, seed);
      St.current = 0;
      buildMoments();
      applyMoment(0, true);
      undo('re-detect');
      renderMarks();
      toast('Re-detected', '4 fresh moments ranked by hook score', 'ok');
    });
    $('undoBtn').addEventListener('click', undoPop);
    $('redoBtn').addEventListener('click', redoPop);
    $('exportBtn').addEventListener('click', () => switchTab('export'));
  }

  function switchTab(name) {
    [...$('rightTabs').children].forEach(x => x.classList.toggle('on', x.dataset.tab === name));
    ['caption', 'effects', 'style', 'export'].forEach(t => {
      const el = $('tab' + t.charAt(0).toUpperCase() + t.slice(1));
      if (el) el.hidden = t !== name;
    });
    if (name === 'export') renderExportSummary();
  }

  function label(id) {
    const e = S.EFFECTS.find(x => x.id === id);
    return e ? e.name : id;
  }

  function buildEffects() {
    const wrap = $('fxList');
    wrap.innerHTML = '';
    S.EFFECTS.forEach(e => {
      const item = document.createElement('button');
      const on = St.effects.find(f => f.id === e.id)?.on;
      item.className = 'fx-item' + (on ? ' on' : '');
      item.dataset.id = e.id;
      item.innerHTML =
        '<span class="fx-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + e.icon + '</svg></span>' +
        '<span class="fx-info"><span class="fx-name">' + e.name + '</span><span class="fx-desc">' + e.desc + '</span></span>' +
        '<span class="fx-pill"></span>';
      wrap.appendChild(item);
    });
  }

  function buildLooks() {
    const g = $('lookGrid');
    g.innerHTML = '';
    S.LOOKS.forEach(l => {
      const c = document.createElement('button');
      c.className = 'look-card' + (l.id === St.look ? ' on' : '');
      c.dataset.id = l.id;
      c.innerHTML = '<span class="look-swatch" style="background:' + l.sw + '"></span><span class="look-name">' + l.name + '</span>';
      g.appendChild(c);
    });
  }

  function buildBeatRow() {
    const row = $('beatRow');
    if (!row) return;
    row.innerHTML = '';
    for (let i = 0; i < 8; i++) {
      const b = document.createElement('button');
      b.className = 'beat-tick' + (St.beatPattern[i] ? ' on' : '');
      b.dataset.i = i;
      b.title = 'Beat ' + (i + 1) + ' — click to gate effects';
      b.addEventListener('click', () => {
        St.beatPattern[i] = !St.beatPattern[i];
        b.classList.toggle('on', St.beatPattern[i]);
        S.Beat.pattern = St.beatPattern;
      });
      row.appendChild(b);
    }
    S.Beat.pattern = St.beatPattern;
    $('bpmOut').textContent = St.bpm + ' BPM';
  }

  /* ------------------------------------------------------------
     source panel
     ------------------------------------------------------------ */
  function bindSource() {
    const s = St.source;
    $('srcThumb').src = s.thumb || 'media/poster.jpg';
    $('srcTitle').textContent = s.title;
    $('srcChan').textContent = s.channel;
    $('srcDur').textContent = S.fmt(s.sourceDuration || s.duration, true) + ' source · editing ' + S.fmt(dur) +
      (s.sourceHeight ? ' · ' + s.sourceHeight + 'p master' : '');
    $('srcUrl').value = s.url;
    $('srcMode').textContent = s.isDemo ? 'Demo reel' : 'Link preview';
    $('stSource').textContent = s.channel + ' · YouTube';
    $('stProject').textContent = s.title;
  }

  /* ------------------------------------------------------------
     transport
     ------------------------------------------------------------ */
  function bindTransport() {
    $('btnPlay').addEventListener('click', togglePlay);
    $('btnToStart').addEventListener('click', () => { seekTo(St.cut.start); });
    $('btnToEnd').addEventListener('click', () => { seekTo(St.cut.end - 0.05); });
    $('volRange').addEventListener('input', e => {
      video.volume = +e.target.value;
      video.muted = +e.target.value === 0;
    });
    $('stage').addEventListener('click', (e) => {
      if (e.target.closest('.stage-top') || e.target.closest('.transport')) return;
      togglePlay();
    });
    const onMeta = () => {
      dur = Math.min(video.duration || dur, St.source.duration || video.duration || 150);
      clampCut();
      drawTimeline();
      renderMarks();
      /* park the playhead on the cut so the canvas never shows a black intro frame */
      requestSeek(St.cut.start + 0.15);
    };
    video.addEventListener('loadedmetadata', onMeta);
    if (video.readyState >= 1) onMeta();      /* assets can be cached before init */
    video.addEventListener('seeked', () => {
      updateStage(video.currentTime);
      const ph = $('playHint');
      if (ph) ph.classList.remove('show');
    });
    video.addEventListener('canplay', () => {
      if (pendingSeek != null) {
        const t = pendingSeek;
        pendingSeek = null;
        if (Math.abs(video.currentTime - t) > 0.15) video.currentTime = t;
      }
    });
    video.addEventListener('play', () => { St.playing = true; setPlayIcon(true); $('playHint').classList.remove('show'); });
    video.addEventListener('pause', () => { St.playing = false; setPlayIcon(false); });
  }
  function setPlayIcon(playing) {
    $('playIco').innerHTML = playing
      ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'
      : '<path d="M7 4.5v15l13-7.5z"/>';
  }
  function togglePlay() {
    if (video.paused) {
      video.muted = +$('volRange').value === 0;
      video.volume = +$('volRange').value;
      let t = video.currentTime;
      if (t < St.cut.start - 0.02 || t >= St.cut.end - 0.05) {
        t = St.cut.start;
        video.currentTime = t;
      }
      video.play().catch(() => {
        $('playHint').textContent = 'tap again to play';
        $('playHint').classList.add('show');
        setTimeout(() => $('playHint').classList.remove('show'), 1600);
      });
    } else {
      video.pause();
    }
  }
  function seekTo(t) {
    t = clamp(t, 0, dur - 0.05);
    video.currentTime = t;
    updateTransport(t);
    updateStage(t);
    drawCaptionsTrack();
  }

  /* ------------------------------------------------------------
     keyboard
     ------------------------------------------------------------ */
  function bindKeys() {
    document.addEventListener('keydown', e => {
      if (document.body.dataset.page !== 'studio') return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); togglePlay(); }
      else if (k === 'i') { setIn(); }
      else if (k === 'o') { setOut(); }
      else if (k === 'backspace' || k === 'delete') { e.preventDefault(); deleteSide(); }
      else if (k === 'arrowleft') { e.preventDefault(); seekTo(video.currentTime - (e.shiftKey ? 5 : 1)); }
      else if (k === 'arrowright') { e.preventDefault(); seekTo(video.currentTime + (e.shiftKey ? 5 : 1)); }
      else if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redoPop() : undoPop(); }
      else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redoPop(); }
    });
  }

  /* ------------------------------------------------------------
     undo / redo
     ------------------------------------------------------------ */
  function serialize() {
    return JSON.stringify({
      aspect: St.aspect, look: St.look,
      effects: St.effects.map(e => ({ id: e.id, on: e.on })),
      intensity: St.intensity, zoomAmt: St.zoomAmt, bpm: St.bpm,
      beatOn: St.beatOn, beatPattern: St.beatPattern,
      capText: St.capText, capAnim: St.capAnim, capPos: St.capPos,
      capSize: St.capSize, capHi: St.capHi, capBg: St.capBg, capStroke: St.capStroke,
      cardOn: St.cardOn, cardText: St.cardText, safeOn: St.safeOn, letterbox: St.letterbox,
      cut: { ...St.cut }, splits: [...St.splits], current: St.current
    });
  }
  function undo(tag) {
    tag2 = tag || 'change';
    undoStack.push(serialize());
    if (undoStack.length > 60) undoStack.shift();
    redoStack = [];
  }
  function undoPop() {
    if (!undoStack.length) return toast('Nothing to undo', '', 'warn');
    redoStack.push(serialize());
    applySnap(undoStack.pop());
    toast('Undone', tag2, 'ok');
  }
  function redoPop() {
    if (!redoStack.length) return toast('Nothing to redo', '', 'warn');
    undoStack.push(serialize());
    applySnap(redoStack.pop());
    toast('Redone', tag2, 'ok');
  }
  let tag2 = '';
  function applySnap(json) {
    const s = JSON.parse(json);
    Object.assign(St, {
      aspect: s.aspect, look: s.look, intensity: s.intensity, zoomAmt: s.zoomAmt,
      bpm: s.bpm, beatOn: s.beatOn, beatPattern: s.beatPattern,
      capText: s.capText, capAnim: s.capAnim, capPos: s.capPos, capSize: s.capSize,
      capHi: s.capHi, capBg: s.capBg, capStroke: s.capStroke,
      cardOn: s.cardOn, cardText: s.cardText, safeOn: s.safeOn, letterbox: s.letterbox,
      cut: s.cut, splits: s.splits, current: s.current
    });
    St.effects = St.effects.map(e => {
      const f = s.effects.find(x => x.id === e.id);
      return { id: e.id, on: !!(f && f.on) };
    });
    syncAll();
  }

  /* ------------------------------------------------------------
     sync all UI from state
     ------------------------------------------------------------ */
  function syncAll() {
    /* format */
    [...$('formatTabs').children].forEach(x => x.classList.toggle('on', x.dataset.ar === St.aspect));
    const pc = $('phoneCanvas');
    pc.classList.remove('ar-1-1', 'ar-4-5');
    if (St.aspect === '1:1') pc.classList.add('ar-1-1');
    if (St.aspect === '4:5') pc.classList.add('ar-4-5');

    /* caption controls */
    $('capText').value = St.capText;
    $('capAnim').value = St.capAnim;
    $('capPos').value = St.capPos;
    $('capSize').value = St.capSize;
    $('capSizeOut').textContent = St.capSize;
    $('cardOn').checked = St.cardOn;
    $('cardText').value = St.cardText;
    $('capBg').checked = St.capBg;
    $('capStroke').checked = St.capStroke;
    [...$('capHiSwatches').children].forEach(x => x.classList.toggle('on', x.dataset.c === St.capHi));
    document.documentElement.style.setProperty('--hi', St.capHi);

    /* effects */
    document.querySelectorAll('.fx-item').forEach(el => {
      const f = St.effects.find(x => x.id === el.dataset.id);
      el.classList.toggle('on', !!(f && f.on));
    });
    $('fxIntensity').value = St.intensity;
    $('fxIntOut').textContent = St.intensity;
    S.FX.intensity = St.intensity / 100;

    /* export preset */
    document.querySelectorAll('.res-card').forEach(c => c.classList.toggle('on', c.dataset.preset === St.preset));
    $('expFps').value = String(St.fps);
    $('expQuality').value = St.quality;
    if ($('smoothOn')) $('smoothOn').checked = !!St.smooth;

    /* style */
    [...$('lookGrid').children].forEach(x => x.classList.toggle('on', x.dataset.id === St.look));
    $('zoomAmt').value = St.zoomAmt;
    $('zoomOut').textContent = St.zoomAmt;
    $('bpmOut').textContent = St.bpm + ' BPM';
    $('beatOn').checked = St.beatOn;
    S.Beat.on = St.beatOn; S.Beat.bpm = St.bpm; S.Beat.pattern = St.beatPattern;
    $('safeOn').checked = St.safeOn; $('safeAreas').hidden = !St.safeOn;
    $('letterbox').checked = St.letterbox;

    const lay = $('captionLayer');
    lay.classList.remove('mid', 'high');
    if (St.capPos === 'mid') lay.classList.add('mid');
    if (St.capPos === 'high') lay.classList.add('high');

    buildCaptionDOM(true);
    renderCaptionsBlock();
    renderMarks();
    layoutCut();
    drawCaptionsTrack();
    renderCutHead();
    updateFrameNote();
    updateCapSize();
    updateStickers();
    updateLetterbox();
    renderExportSummary();
  }

  function renderCutHead() {
    const m = St.moments[St.current];
    $('cutLabel').textContent = m ? ('Auto-cut ' + String(St.current + 1).padStart(2, '0') + ' · ' + m.hook) : 'Custom cut';
    $('cutMeta').textContent = S.fmt(St.cut.start) + ' → ' + S.fmt(St.cut.end) + '  ·  ' +
      (St.cut.end - St.cut.start).toFixed(1) + 's' + (m ? '  ·  score ' + m.score : '');
  }
  function updateFrameNote() {
    const d = presetDims();
    $('frameNote').textContent = St.aspect + ' · ' + d.w + '×' + d.h +
      (St.preset === '4k' ? ' · 4K' : St.preset === '1440' ? ' · 1440p' : '');
    if ($('res1080')) {
      const f = St.aspect === '9:16' ? null : d;
      $('res1080').textContent = '1080×' + (St.aspect === '9:16' ? 1920 : St.aspect === '1:1' ? 1080 : 1350);
      $('res1440').textContent = '1440×' + (St.aspect === '9:16' ? 2560 : St.aspect === '1:1' ? 1440 : 1800);
      $('res4k').textContent = '2160×' + (St.aspect === '9:16' ? 3840 : St.aspect === '1:1' ? 2160 : 2700);
    }
  }

  /* ------------------------------------------------------------
     stage rendering
     ------------------------------------------------------------ */
  function sizeCanvas() {
    if (!fxCanvas) return;
    const pc = $('phoneCanvas');
    const r = pc.getBoundingClientRect();
    const d = DPR();
    fxCanvas.width = Math.max(2, Math.round(r.width * d));
    fxCanvas.height = Math.max(2, Math.round(r.height * d));
  }
  window.addEventListener('resize', onResize);
  function onResize() { sizeCanvas(); drawTimeline(); layoutCut(); }

  function updateStage(t) {
    if (!video) return;
    const tr = S.transformFor({
      t: t,
      cutT0: St.cut.start,
      cutLen: Math.max(0.01, St.cut.end - St.cut.start),
      zoomAmt: St.zoomAmt,
      fitZoom: 0,
      whipDir: 1
    });
    /* whip blur */
    let extra = '';
    const whip = St.effects.find(e => e.id === 'whip' && e.on);
    if (whip) {
      const age = t - St.cut.start;
      if (age >= 0 && age < 0.18) extra = ' blur(' + (10 * (1 - age / 0.18) * (St.intensity / 100)).toFixed(1) + 'px)';
    }
    video.style.transform = 'translate(' + tr.x.toFixed(2) + 'px,' + tr.y.toFixed(2) + 'px) scale(' + tr.scale.toFixed(4) + ') rotate(' + tr.rot.toFixed(3) + 'deg)';
    const f = S.filterFor({ look: St.look, effects: St.effects });
    video.style.filter = f + extra;

    /* overlay canvas */
    const W = fxCanvas.width, H = fxCanvas.height;
    S.FX.render(fxctx, W, H, {
      t: t, g: Math.floor(t * 10), node: video, baseFilter: f,
      cutT0: St.cut.start
    });

    /* captions highlight */
    updateCaptionHighlight(t);
    /* vhs sticker timecode */
    const vhs = St.effects.find(e => e.id === 'vhs' && e.on);
    if (vhs) {
      const el = document.getElementById('vhsSticker');
      if (el) el.textContent = '▶ PLAY  SP  ' + S.fmtTC(t);
    }
    /* beat ticks visual */
    const step = 60 / St.bpm;
    const idx = Math.floor((t - St.cut.start) / step);
    if (idx !== wordState) { /* reuse var only for ticks */ }
    const ticks = $('beatRow').children;
    if (ticks.length) {
      const active = ((idx % 8) + 8) % 8;
      for (let i = 0; i < ticks.length; i++) ticks[i].classList.toggle('beatlit', i === active && St.beatOn);
    }
  }

  function buildCaptionDOM(force) {
    const el = $('capWord');
    const words = S.Caption.build(St.capText);
    const key = St.capText + '|' + St.capAnim;
    if (!force && key === capKey) return;
    capKey = key;
    el.dataset.anim = St.capAnim;
    capPhrases = S.Caption.phrases(words);
    capPhraseIdx = -1;
    renderCapPhrase(0, -1);
    updateCapClasses();
    updateCapSize();
  }
  function renderCapPhrase(idx, activeWord) {
    const el = $('capWord');
    const ph = capPhrases[idx] || capPhrases[0];
    if (!ph) return;
    el.innerHTML = ph.words.map((w, i) =>
      '<span class="w' + (i === activeWord ? ' hl' : '') + '">' + esc(w) + '</span>'
    ).join(' ');
    capPhraseIdx = idx;
    fitCapFont();
  }
  /* shrink the caption until the phrase fits the canvas width */
  function fitCapFont() {
    const el = $('capWord');
    const pc = $('phoneCanvas');
    if (!el || !pc) return;
    const avail = $('captionLayer').clientWidth;
    const desired = (St.capSize / 768) * pc.getBoundingClientRect().height;
    el.style.fontSize = desired.toFixed(1) + 'px';
    const w = el.scrollWidth;
    if (avail && w > avail) {
      el.style.fontSize = Math.max(12, desired * (avail / w) * 0.97).toFixed(1) + 'px';
    }
  }
  function updateCapClasses() {
    const el = $('capWord');
    el.classList.toggle('bg', St.capBg);
    el.classList.toggle('stroke', St.capStroke);
  }
  function updateCapSize() {
    const pc = $('phoneCanvas');
    if (!pc) return;
    const h = pc.getBoundingClientRect().height || 480;
    /* 96 on the slider = 12.5% of canvas height; then fit-to-width kicks in */
    $('captionsBlock').style.fontSize = (St.capSize * 0.52 / 768 * h).toFixed(1) + 'px';
    fitCapFont();
  }
  function updateCaptionHighlight(t) {
    if (!capPhrases.length) return;
    const p = clamp((t - St.cut.start) / Math.max(0.001, St.cut.end - St.cut.start), 0, 1);
    const n = capPhrases.length;
    const pi = Math.min(n - 1, Math.floor(p * n));
    const ph = capPhrases[pi];
    const local = clamp(p * n - pi, 0, 0.9999);
    const wi = Math.min(ph.words.length - 1, Math.floor(local * ph.words.length));
    if (pi !== capPhraseIdx) {
      renderCapPhrase(pi, wi);
      return;
    }
    if (wi === wordState) return;
    wordState = wi;
    const spans = $('capWord').querySelectorAll('.w');
    spans.forEach((el, k) => {
      if (el.classList.contains('hl') !== (k === wi)) el.classList.toggle('hl', k === wi);
    });
  }
  function renderCaptionsBlock() {
    const el = $('captionsBlock');
    if (!St.cardOn) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML =
      '<span class="cb-line"><b>' + esc(St.cardText || 'your hook here') + '</b></span>' +
      '<span class="cb-sub">' + S.SUBLINES[St.current % S.SUBLINES.length] + '</span>';
  }
  function updateStickers() {
    const layer = $('stickersLayer');
    layer.innerHTML = '';
    const vhs = St.effects.find(e => e.id === 'vhs' && e.on);
    const glitch = St.effects.find(e => e.id === 'glitch' && e.on);
    if (vhs) {
      const d = document.createElement('div');
      d.className = 'sticker';
      d.id = 'vhsSticker';
      d.style.cssText = 'left:12px;bottom:12px;font-family:var(--mono);font-size:9px;letter-spacing:.08em;color:#fff;background:rgba(0,0,0,.5);padding:3px 7px;border-radius:3px;';
      d.textContent = '▶ PLAY  SP  00:00.00';
      layer.appendChild(d);
    }
    if (glitch) {
      const d = document.createElement('div');
      d.className = 'sticker';
      d.style.cssText = 'right:12px;top:12px;font-family:var(--mono);font-size:10px;color:#57f2c6;opacity:.85;--rot:2deg';
      d.textContent = 'ERR//SIGNAL';
      layer.appendChild(d);
    }
  }
  function updateLetterbox() {
    /* letterbox = contain the whole 16:9 frame, bars handled by object-fit */
    $('phoneCanvas').classList.toggle('lb', St.letterbox);
  }

  /* ------------------------------------------------------------
     main loop
     ------------------------------------------------------------ */
  function startLoop() {
    if (raf) cancelAnimationFrame(raf);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (document.body.dataset.page !== 'studio' || !video) return;
      const t = video.currentTime;
      if (St.playing) {
        if (t >= St.cut.end - 0.03) {
          video.currentTime = St.cut.start;
          return;
        }
        if (t < St.cut.start - 0.25) video.currentTime = St.cut.start;
      }
      if (!document.hidden) updateStage(t);
      updateTransport(t);
      autoScroll(t);
    };
    raf = requestAnimationFrame(loop);
  }
  function updateTransport(t) {
    $('tcNow').textContent = S.fmtTC(t);
    $('tcDur').textContent = S.fmtTC(dur);
    const px = t * St.pxPerSec;
    playhead.style.left = px + 'px';
    seekLineHighlight(px);
  }
  function seekLineHighlight(px) {
    /* shift cut-range center time label */
    const lbl = cutRange.querySelector('.cut-time');
    if (!lbl) {
      const d = document.createElement('span');
      d.className = 'cut-time';
      cutRange.appendChild(d);
    }
    cutRange.querySelector('.cut-time').textContent =
      (St.cut.end - St.cut.start).toFixed(1) + 's';
  }
  function autoScroll(t) {
    const vp = $('tlViewport');
    const px = t * St.pxPerSec;
    const left = vp.scrollLeft, w = vp.clientWidth;
    if (St.playing && (px < left + 40 || px > left + w - 60)) {
      vp.scrollLeft = Math.max(0, px - w * 0.4);
    }
  }

  /* ------------------------------------------------------------
     timeline
     ------------------------------------------------------------ */
  function bindTimeline() {
    drawTimeline();
    $('zoomInBtn').addEventListener('click', () => zoomTl(1.5));
    $('zoomOutBtn').addEventListener('click', () => zoomTl(1 / 1.5));
    $('btnMarkSplit').addEventListener('click', () => {
      const t = video.currentTime;
      if (t <= St.cut.start + 0.5 || t >= St.cut.end - 0.5) return toast('Move the playhead inside the cut', 'then press Split', 'warn');
      if (St.splits.some(s => Math.abs(s - t) < 0.4)) return toast('Already split here', '', 'warn');
      St.splits.push(Math.round(t * 100) / 100);
      St.splits.sort((a, b) => a - b);
      undo('split');
      drawTimeline();
      renderExportSummary();
      toast('Split added', 'Export plan now has ' + (St.splits.length + 1) + ' segments', 'ok');
    });
    $('btnTrimRight').addEventListener('click', setIn);
    $('btnTrimEnd').addEventListener('click', setOut);
    $('btnFull30').addEventListener('click', () => {
      undo('reset cut');
      const m = St.moments[St.current];
      St.cut = m ? { start: m.start, end: m.end } : { start: 0, end: Math.min(30, dur) };
      St.splits = [];
      skipCutIfOut();
      drawTimeline(); renderCutHead(); renderExportSummary();
      toast('Cut reset', 'Back to the auto-detected window', 'ok');
    });

    /* seeking & dragging via pointer events on tlInner */
    tlInner.addEventListener('pointerdown', e => {
      if (e.target.closest('.cut-range')) return;
      const r = tlInner.getBoundingClientRect();
      const x = clamp(e.clientX - r.left, 0, r.width);
      seekTo(x / St.pxPerSec);
      video.pause();
    });
    cutRange.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      const r = tlInner.getBoundingClientRect();
      const handle = e.target.closest('.handle');
      const mode = handle ? (handle.classList.contains('hl') ? 'in' : 'out') : 'move';
      undo('trim');
      const startX = e.clientX;
      const orig = { ...St.cut };
      cutRange.setPointerCapture(e.pointerId);
      const move = ev => {
        const dt = (ev.clientX - startX) / St.pxPerSec;
        if (mode === 'in') St.cut.start = clamp(orig.start + dt, 0, orig.end - 2);
        else if (mode === 'out') St.cut.end = clamp(orig.end + dt, orig.start + 2, dur);
        else {
          const len = orig.end - orig.start;
          let s = clamp(orig.start + dt, 0, dur - len);
          St.cut.start = Math.round(s * 10) / 10;
          St.cut.end = Math.round((s + len) * 10) / 10;
        }
        St.cut.start = Math.round(St.cut.start * 10) / 10;
        St.cut.end = Math.round(St.cut.end * 10) / 10;
        St.cut.start = clamp(St.cut.start, 0, St.cut.end - 2);
        layoutCut(); renderCutHead(); drawCaptionsTrack(); renderExportSummary();
        /* keep playhead inside cut */
        if (video.currentTime < St.cut.start) video.currentTime = St.cut.start;
        if (video.currentTime > St.cut.end) video.currentTime = St.cut.end - 0.05;
        updateTransport(video.currentTime);
      };
      const up = () => {
        cutRange.removeEventListener('pointermove', move);
        cutRange.removeEventListener('pointerup', up);
        cutRange.removeEventListener('pointercancel', up);
      };
      cutRange.addEventListener('pointermove', move);
      cutRange.addEventListener('pointerup', up);
      cutRange.addEventListener('pointercancel', up);
    });
    cutRange.addEventListener('dblclick', () => {
      skipCutIfOut();
      toast('Cut preview', 'Playhead snapped into the cut', 'ok');
    });
  }
  function skipCutIfOut() {
    if (video.currentTime < St.cut.start || video.currentTime > St.cut.end) seekTo(St.cut.start);
    drawTimeline();
  }
  function zoomTl(mult) {
    const vp = $('tlViewport');
    const centerT = (vp.scrollLeft + vp.clientWidth / 2) / St.pxPerSec;
    St.pxPerSec = clamp(St.pxPerSec * mult, 4, 60);
    drawTimeline();
    vp.scrollLeft = Math.max(0, centerT * St.pxPerSec - vp.clientWidth / 2);
  }
  function setIn() {
    undo('mark in');
    St.cut.start = Math.round(video.currentTime * 10) / 10;
    if (St.cut.end - St.cut.start < 2) St.cut.end = Math.min(dur, St.cut.start + 2);
    layoutCut(); renderCutHead(); drawCaptionsTrack();
    toast('In point set', S.fmt(St.cut.start), 'ok');
  }
  function setOut() {
    undo('mark out');
    St.cut.end = Math.round(video.currentTime * 10) / 10;
    if (St.cut.end - St.cut.start < 2) St.cut.start = Math.max(0, St.cut.end - 2);
    layoutCut(); renderCutHead(); drawCaptionsTrack();
    toast('Out point set', S.fmt(St.cut.end), 'ok');
  }
  function deleteSide() {
    const t = video.currentTime;
    if (t <= St.cut.start || t >= St.cut.end) return toast('Playhead is outside the cut', '', 'warn');
    undo('delete side');
    const mid = (St.cut.start + St.cut.end) / 2;
    if (t < mid) St.cut.start = Math.round(t * 10) / 10;
    else St.cut.end = Math.round(t * 10) / 10;
    layoutCut(); renderCutHead(); drawCaptionsTrack();
    toast('Trimmed', 'Removed the shorter side of the cut', 'ok');
  }
  function clampCut() {
    St.cut.start = clamp(St.cut.start, 0, Math.max(0, dur - 2));
    St.cut.end = clamp(St.cut.end, St.cut.start + 2, dur);
  }

  function drawTimeline() {
    if (!tlInner) return;
    const vp = $('tlViewport');
    const width = Math.max(vp.clientWidth - 32, dur * St.pxPerSec);
    tlInner.style.width = width + 'px';
    drawRuler(width);
    drawFilmstrip(width);
    drawWave(width);
    layoutCut();
    renderMarks();
    drawCaptionsTrack();
  }
  function drawRuler(width) {
    const r = $('tlRuler');
    let html = '';
    const step = St.pxPerSec >= 24 ? 1 : St.pxPerSec >= 10 ? 5 : 10;
    const labelEvery = St.pxPerSec >= 24 ? 5 : St.pxPerSec >= 10 ? 2 : 1;
    for (let t = 0, i = 0; t <= dur; t += step, i++) {
      const x = t * St.pxPerSec;
      const major = i % labelEvery === 0;
      html += '<i class="tick' + (major ? ' major' : '') + '" style="left:' + x + 'px"></i>';
      if (major) html += '<span class="lbl" style="left:' + x + 'px">' + S.fmt(t).replace(/\.0$/, '') + '</span>';
    }
    r.innerHTML = html;
  }
  function drawFilmstrip(width) {
    const c = $('filmstrip');
    const h = 56, d = DPR();
    c.width = Math.max(2, Math.round(width * d));
    c.height = Math.round(h * d);
    c.style.width = width + 'px'; c.style.height = h + 'px';
    const ctx = c.getContext('2d');
    ctx.scale(d, d);
    ctx.fillStyle = '#0d0a18'; ctx.fillRect(0, 0, width, h);
    const img = storyboardImg;
    const frames = 12;
    if (!img || !img.complete || !img.naturalWidth) {
      /* placeholder gradient while loading */
      const g = ctx.createLinearGradient(0, 0, width, 0);
      g.addColorStop(0, '#1a1430'); g.addColorStop(1, '#0f2a26');
      ctx.fillStyle = g; ctx.fillRect(0, 0, width, h);
    } else {
      const cellW = 100;
      const n = Math.ceil(width / cellW);
      const fw = img.naturalWidth / frames, fh = img.naturalHeight;
      for (let i = 0; i < n; i++) {
        const t = (i * cellW) / St.pxPerSec;
        const fi = Math.min(frames - 1, Math.floor((t / dur) * frames));
        try { ctx.drawImage(img, fi * fw, 0, fw, fh, i * cellW, 0, cellW, h); } catch (e) {}
      }
    }
    /* dim outside cut */
    const s = St.cut.start * St.pxPerSec, e = St.cut.end * St.pxPerSec;
    ctx.fillStyle = 'rgba(5,4,10,.62)';
    ctx.fillRect(0, 0, s, h);
    ctx.fillRect(e, 0, width - e, h);
    /* split markers */
    St.splits.forEach(sp => {
      const x = sp * St.pxPerSec;
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.fillRect(x - 1, 0, 2, h);
      ctx.fillStyle = 'rgba(255,93,143,.95)';
      ctx.beginPath();
      ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 5);
      ctx.closePath(); ctx.fill();
    });
  }
  function drawWave(width) {
    const c = $('waveCanvas');
    const h = 38, d = DPR();
    c.width = Math.max(2, Math.round(width * d));
    c.height = Math.round(h * d);
    c.style.width = width + 'px'; c.style.height = h + 'px';
    const ctx = c.getContext('2d');
    ctx.scale(d, d);
    ctx.clearRect(0, 0, width, h);
    const peaks = S.PEAKS || Array.from({ length: 300 }, (_, i) => 0.2 + 0.8 * Math.abs(Math.sin(i * 0.7)));
    const s = St.cut.start * St.pxPerSec, e = St.cut.end * St.pxPerSec;
    const n = peaks.length;
    const bw = Math.max(1.4, width / n);
    for (let i = 0; i < n; i++) {
      const x = (i / n) * width;
      const amp = Math.max(0.04, peaks[i]);
      const bh = amp * (h - 8);
      const inside = x >= s && x <= e;
      ctx.fillStyle = inside
        ? 'rgba(167,139,250,.9)'
        : 'rgba(255,255,255,.16)';
      ctx.fillRect(x, (h - bh) / 2, Math.max(1, bw - 1), bh);
    }
  }
  function layoutCut() {
    if (!cutRange) return;
    const s = St.cut.start * St.pxPerSec;
    const w = Math.max(8, (St.cut.end - St.cut.start) * St.pxPerSec);
    cutRange.style.left = s + 'px';
    cutRange.style.width = w + 'px';
    drawCaptionsTrack();
  }
  function renderMarks() {
    const wrap = $('momentMarks');
    wrap.innerHTML = '';
    St.moments.forEach(m => {
      const d = document.createElement('i');
      d.className = 'moment-tick';
      d.style.left = (m.start * St.pxPerSec) + 'px';
      d.dataset.tip = m.hook + ' · ' + m.score;
      d.addEventListener('click', ev => {
        ev.stopPropagation();
        applyMoment(St.moments.indexOf(m));
      });
      wrap.appendChild(d);
    });
  }
  function drawCaptionsTrack() {
    const tr = $('tlCaptions');
    if (!tr) return;
    tr.innerHTML = '<span class="tl-cap-hint">CAPTIONS</span>';
    const words = (St.capText || '').trim().split(/\s+/).filter(Boolean);
    const segments = [St.cut.start, ...St.splits, St.cut.end];
    for (let i = 0; i < segments.length - 1; i++) {
      const a = segments[i], b = segments[i + 1];
      if (b - a < 0.3) continue;
      const chip = document.createElement('span');
      chip.className = 'tl-cap-chip';
      chip.style.left = a * St.pxPerSec + 'px';
      chip.style.width = Math.max(18, (b - a) * St.pxPerSec - 2) + 'px';
      chip.style.setProperty('--hi', St.capHi);
      const part = words.slice(
        Math.floor((i / (segments.length - 1)) * words.length),
        Math.floor(((i + 1) / (segments.length - 1)) * words.length)
      ).join(' ');
      chip.textContent = part || (St.capText || 'caption');
      tr.appendChild(chip);
    }
  }

  /* ------------------------------------------------------------
     export
     ------------------------------------------------------------ */
  let SERVER_CAPS = null;
  let SERVER_MEM = null;

  async function loadCaps() {
    try {
      const r = await fetch('/api/health');
      const h = await r.json();
      SERVER_CAPS = h.capabilities || null;
      SERVER_MEM = h.memory || null;
      paintCaps();
    } catch (e) { /* offline / static hosting → no badges */ }
  }

  function comboOk() {
    if (!SERVER_CAPS) return true;
    const key = St.preset + ':' + St.fps + ':' + (St.smooth && St.fps >= 60 ? 'i' : 'd');
    return SERVER_CAPS[key] !== false;
  }

  function paintCaps() {
    const ok = comboOk();
    const btn = $('doExport');
    if (!btn) return;
    btn.textContent = ok ? 'Render MP4' : 'Not supported on this server';
    btn.disabled = !ok;
    btn.classList.toggle('warn-state', !ok);
    const hint = $('smoothHint');
    if (hint) {
      const free = SERVER_MEM && SERVER_MEM.available_mb != null ? SERVER_MEM.available_mb : null;
      hint.textContent = ok
        ? 'This combination is supported by the server' + (free ? ' · ' + free + ' MB RAM free right now' : '') + '.'
        : 'This server does not have enough RAM for ' + St.preset + ' @ ' + St.fps +
          ' fps' + (St.smooth && St.fps >= 60 ? ' with interpolation' : '') +
          '. Try a lower preset/frame rate, or deploy to a bigger host.';
      hint.classList.toggle('warn', !ok);
    }
  }

  function bindExport() {
    loadCaps();
    $('resGrid').addEventListener('click', e => {
      const card = e.target.closest('.res-card');
      if (!card) return;
      St.preset = card.dataset.preset;
      [...$('resGrid').children].forEach(c => c.classList.toggle('on', c === card));
      updateFrameNote();
      renderExportSummary();
      const dims = presetDims();
      paintCaps();
      toast('Output set', dims.w + '×' + dims.h + (St.preset === '4k' ? ' · 4K UHD' : ''), 'ok');
    });
    $('expFps').addEventListener('change', e => {
      St.fps = +e.target.value;
      renderExportSummary();
      paintCaps();
      if (St.fps === 120 && !St.smooth) toast('120 fps selected', 'Turn on true motion for interpolated frames', 'warn');
    });
    $('expQuality').addEventListener('change', e => { St.quality = e.target.value; renderExportSummary(); });
    $('smoothOn').addEventListener('change', e => {
      St.smooth = e.target.checked;
      if (St.smooth && St.fps < 60) {
        St.fps = 60;
        $('expFps').value = '60';
      }
      renderExportSummary();
      paintCaps();
      toast(St.smooth ? 'True motion on' : 'True motion off',
            St.smooth ? 'ffmpeg will interpolate in-between frames' : 'Frames duplicated to the target rate', 'ok');
    });
    $('doExport').addEventListener('click', renderCut);
  }

  const PRESET_DIMS = { '1080': [1080, 1920], '1440': [1440, 2560], '4k': [2160, 3840] };
  function presetDims() {
    const [w0, h0] = PRESET_DIMS[St.preset] || PRESET_DIMS['1080'];
    if (St.aspect === '9:16') return { w: w0, h: h0 };
    if (St.aspect === '1:1') return { w: w0, h: w0 };
    return { w: w0, h: Math.round((w0 / 0.8) / 2) * 2 };
  }
  function exportState() {
    const d = presetDims();
    return {
      aspect: St.aspect,
      outW: d.w,
      outH: d.h,
      preset: St.preset,
      quality: St.quality,
      fps: St.fps,
      look: St.look,
      effects: St.effects,
      intensity: St.intensity,
      zoomAmt: St.zoomAmt,
      bpm: St.bpm,
      cutStart: St.cut.start,
      cutEnd: St.cut.end,
      cardOn: St.cardOn,
      cardText: St.cardText,
      capText: St.capText,
      capSize: St.capSize,
      letterbox: St.letterbox
    };
  }
  function renderExportSummary() {
    const el = $('exportSummary');
    if (!el) return;
    const st = exportState();
    const fxOn = St.effects.filter(e => e.on).length;
    const segs = St.splits.length + 1;
    const presetName = St.preset === '4k' ? '4K UHD' : St.preset + 'p';
    el.innerHTML =
      row('Format', St.aspect + ' · ' + st.outW + '×' + st.outH + ' · ' + presetName) +
      row('Frame rate', St.fps + ' fps · ' + (St.smooth && St.fps >= 60 ? 'interpolated' : 'duplicated')) +
      row('Source', St.source && !St.source.isDemo ? 'YouTube link (download on render)' : 'Bundled 1080p master') +
      row('Duration', (St.cut.end - St.cut.start).toFixed(1) + 's · ' + segs + ' segment' + (segs > 1 ? 's' : '')) +
      row('Effects', fxOn ? fxOn + ' active · intensity ' + St.intensity + '%' : 'none') +
      row('Look', (S.LOOKS.find(l => l.id === St.look) || {}).name || 'Original') +
      row('Captions', (St.capText || '').trim() ? 'word-timed · ' + (St.capText.trim().split(/\s+/).length) + ' words' : 'off') +
      row('Source', (St.source && St.source.sourceHeight ? St.source.sourceHeight + 'p master' : '1080p master') +
        (St.preset === '1080' ? ' · native' : ' · Lanczos upscale')) +
      row('Audio', 'AAC 160k · ' + (St.letterbox ? 'letterboxed' : 'full frame'));
    function row(a, b) { return '<div class="es-row"><span>' + a + '</span><b>' + b + '</b></div>'; }
  }
  /* ------------------------------------------------------------
     real render: POST /api/render → poll → preview + download
     ------------------------------------------------------------ */
  function payload() {
    const st = exportState();
    return payload_last = {
      preset: St.preset,
      aspect: St.aspect,
      fps: st.fps,
      smooth: !!St.smooth,
      source: St.source ? { id: St.source.id, demo: !!St.source.isDemo } : null,
      quality: St.quality,
      start: +St.cut.start.toFixed(2),
      end: +St.cut.end.toFixed(2),
      look: St.look,
      effects: St.effects.map(e => ({ id: e.id, on: !!e.on })),
      intensity: St.intensity,
      zoom: St.zoomAmt,
      bpm: St.bpm,
      letterbox: St.letterbox,
      caption: St.capText,
      card: St.cardText,
      cardOn: St.cardOn,
      capSize: St.capSize,
      capHi: St.capHi
    };
  }
  let payload_last = null;

  async function renderCut() {
    const btn = $('doExport');
    const prog = $('renderProgress');
    const log = $('exportLog');
    const result = $('renderResult');
    const bar = $('rpBar');
    const pct = $('rpPct');
    const meta = $('rpMeta');
    const label = $('rpLabel');

    btn.disabled = true;
    result.hidden = true;
    log.hidden = true;
    prog.hidden = false;
    bar.style.background = '';
    bar.style.width = '2%';
    pct.textContent = '0%';
    label.textContent = 'Queued on server…';
    const dims = presetDims();
    const dur = St.cut.end - St.cut.start;
    meta.textContent = dims.w + '×' + dims.h + ' · ' + St.fps + 'fps · ' + dur.toFixed(1) + 's';
    if (St.preset === '4k' && dur > 20) {
      meta.textContent += ' · long 4K cut, this takes a while';
    }

    // pre-flight: ask the server whether this exact combo fits in RAM right now
    try {
      const hres = await fetch('/api/health');
      const health = await hres.json();
      const key = St.preset + ':' + St.fps + ':' + (St.smooth && St.fps >= 60 ? 'i' : 'd');
      const okCombo = health.capabilities ? health.capabilities[key] : true;
      const freeMb = health.memory ? health.memory.available_mb : null;
      if (okCombo === false || (freeMb != null && freeMb < 700)) {
        btn.disabled = false;
        prog.hidden = true;
        const why = okCombo === false
          ? 'This server has ' + (health.machine ? (health.machine.mem_mb / 1024).toFixed(1) + ' GB RAM' : 'limited RAM') +
            ' — that combination needs more. Pick 1080p/1440p, or 30–120 fps without interpolation.'
          : 'Only ' + freeMb + ' MB RAM is free right now. Close other tabs and try again.';
        toast('Not enough memory for this render', why, 'warn');
        return;
      }
    } catch (e) { /* health check is advisory only */ }

    const started = performance.now();
    let jobId = null;
    try {
      const res = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload())
      });
      if (!res.ok) throw new Error('server ' + res.status + ' — is the Shortify server running?');
      const j = await res.json();
      jobId = j.job;
    } catch (err) {
      finishWithError(err);
      return;
    }

    label.textContent = 'Rendering with ffmpeg…';
    const SPEED = { '1080': 0.55, '1440': 0.95, '4k': 1.65 };   // render s per cut s @30fps
    const fpsMul = St.fps === 120 ? 2.6 : St.fps === 60 ? 1.4 : 1;
    const motionMul = (St.smooth && St.fps >= 60) ? 2.4 : 1;
    const est = Math.max(4, dur * (SPEED[St.preset] || 1) * fpsMul * motionMul);
    const tick = setInterval(() => {
      const elapsed = (performance.now() - started) / 1000;
      const p = Math.min(96, Math.round((elapsed / est) * 100));
      bar.style.width = p + '%';
      pct.textContent = p + '%';
      meta.textContent = dims.w + '×' + dims.h + ' · ' + St.fps + 'fps · ' + elapsed.toFixed(1) + 's elapsed';
    }, 400);

    const poll = async () => {
      try {
        const r = await fetch('/api/render/' + jobId);
        const j = await r.json();
        if (j.status === 'done') {
          clearInterval(tick);
          bar.style.width = '100%';
          pct.textContent = '100%';
          label.textContent = 'Render complete';
          meta.textContent = (j.width + '×' + j.height) + ' · ' + (j.bytes / 1048576).toFixed(1) + ' MB · ' +
            j.duration.toFixed(1) + 's · ffmpeg ' + j.render_seconds + 's';
          showResult(j);
          btn.disabled = false;
          toast('Render ready', j.width + '×' + j.height + ' MP4 · ' + (j.bytes / 1048576).toFixed(1) + ' MB', 'ok');
          return;
        }
        if (j.status === 'error') {
          clearInterval(tick);
          finishWithError(new Error(j.error || 'render failed'));
          return;
        }
        setTimeout(poll, 900);
      } catch (err) {
        clearInterval(tick);
        finishWithError(err);
      }
    };
    setTimeout(poll, 900);

    function showResult(j) {
      result.hidden = false;
      const v = $('resultVideo');
      v.src = j.url;
      v.load();
      $('downloadBtn').href = j.url;
      $('downloadBtn').setAttribute('download', j.file);
      $('openTabBtn').href = j.url;
      $('rrMeta').innerHTML =
        '<b>' + j.width + '×' + j.height + '</b> · ' + j.fps + 'fps' + (j.smooth ? ' (interpolated)' : '') + ' · ' +
        (j.bytes / 1048576).toFixed(1) + ' MB · ' + j.duration.toFixed(1) + 's ' +
        '<span class="upscale-badge">' + (j.preset === '4k' ? '4K UHD' : j.preset) + '</span>';
      result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function finishWithError(err) {
      btn.disabled = false;
      label.textContent = 'Render failed';
      pct.textContent = '!';
      bar.style.width = '100%';
      bar.style.background = 'linear-gradient(90deg,#ff5d8f,#ff9f45)';
      meta.textContent = String(err.message || err).slice(0, 160);
      toast('Render failed', 'Check that server.py is running with ffmpeg installed', 'err');
    }
  }

  /* ------------------------------------------------------------
     toasts
     ------------------------------------------------------------ */
  function toast(title, sub, type) {
    const wrap = $('toasts');
    if (!wrap) return;
    const d = document.createElement('div');
    d.className = 'toast ' + (type || '');
    const ic = type === 'err' ? '✕' : type === 'warn' ? '!' : '✓';
    d.innerHTML = '<span class="t-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="' +
      (type === 'warn' ? 'M12 6v8M12 18v.5' : type === 'err' ? 'M6 6l12 12M18 6L6 18' : 'M4 12.5l5 5L20 6.5') +
      '"/></svg></span><span>' + esc(title) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>';
    wrap.appendChild(d);
    setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 320); }, 2600);
    while (wrap.children.length > 3) wrap.firstChild.remove();
  }
  S.toast = toast;
})();
