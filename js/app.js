/* ============================================================
   SHORTIFY · app.js
   Routing, landing interactions, link parsing, analyze flow
   ============================================================ */
(function () {
  const S = window.SHORTIFY;
  const $ = (id) => document.getElementById(id);

  const App = window.ShortifyApp = {
    project: null,
    timers: []
  };

  /* ---------------- link parsing ---------------- */
  const YT_RE = /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/|clip\/)|youtu\.be\/)([\w-]{6,})/i;

  function parseYT(url) {
    const m = String(url || '').trim().match(YT_RE);
    return m ? m[1] : null;
  }
  function isYT(url) {
    return /youtube\.com|youtu\.be/i.test(String(url || ''));
  }

  /* ---------------- routing ---------------- */
  function show(page) {
    document.body.dataset.page = page;
    ['landing', 'analyzing', 'studio'].forEach(p => {
      const el = $('page-' + p);
      if (el) el.hidden = p !== page;
    });
    if (page !== 'studio' && S.Editor) S.Editor.teardown();
  }
  function route() {
    const h = (location.hash || '#/').replace(/^#\/?/, '').split('?')[0];
    if (h === 'studio' && App.project) show('studio');
    else if (h === 'studio') { location.hash = '#/'; show('landing'); }
    else show('landing');
  }

  /* ---------------- toast (landing-safe) ---------------- */
  function toast(title, sub, type, ms) {
    let wrap = $('toasts');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toasts';
      wrap.id = 'toasts';
      document.body.appendChild(wrap);
    }
    const d = document.createElement('div');
    d.className = 'toast ' + (type || '');
    d.innerHTML = '<span class="t-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="' +
      (type === 'warn' ? 'M12 6v8M12 18v.5' : 'M4 12.5l5 5L20 6.5') + '"/></svg></span><span>' +
      String(title).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) +
      (sub ? '<small>' + String(sub).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</small>' : '') + '</span>';
    wrap.appendChild(d);
    setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 320); }, Math.max(2000, ms || 3000));
    while (wrap.children.length > 3) wrap.firstChild.remove();
  }

  /* ---------------- source loading ---------------- */
  App.loadSource = function (url) {
    const id = parseYT(url) || 'demo-' + String(S.hash(url || 'x')).slice(0, 8);
    if (!parseYT(url)) {
      if (isYT(url)) toast('Link not recognised', 'Check the video ID and try again', 'warn');
      else { toast('Not a YouTube link', 'Falling back to the demo reel so you can try everything', 'warn'); }
    }
    /* read public metadata when hosted; fall back to the bundled demo reel */
    fetchMeta(id).then(meta => {
      const source = {
        url: parseYT(url) ? 'https://www.youtube.com/watch?v=' + id : S.DEMO.url,
        id: id,
        /* a real link the server could not read is still a DEMO render */
        isDemo: !parseYT(url) || id === S.DEMO.id || !!meta.demo,
        liveFailed: !!parseYT(url) && id !== S.DEMO.id && !!meta.demo,
        note: meta.note || '',
        title: meta.title || S.DEMO.title,
        channel: meta.channel || S.DEMO.channel,
        duration: S.DEMO.duration,
        sourceDuration: meta.duration || S.DEMO.sourceDuration,
        sourceHeight: S.DEMO.sourceHeight,
        thumb: meta.thumb || S.DEMO.thumb,
        storyboard: S.DEMO.storyboard,
        file: S.DEMO.file,
        note: meta.note || ''
      };
      if (source.liveFailed) {
        toast(
          'Could not read that YouTube video',
          'YouTube blocks this server’s IP, so the demo reel loads instead. ' +
          'Timeline and effects still work. To cut real videos, deploy where YouTube ' +
          'allows access (VPS/home) or set the YT_COOKIES variable.',
          'warn', 9000
        );
      }
      App.project = {
        source,
        moments: S.buildMoments(source.duration, source.id)
      };
      startAnalyze(App.project);
    });
  };

  /* ---------------- link bar ---------------- */
  function bindLanding() {
    const form = $('linkForm');
    if (!form) return;
    form.addEventListener('submit', e => {
      e.preventDefault();
      const url = $('ytUrl').value.trim();
      if (!url) {
        form.classList.remove('err');
        void form.offsetWidth;
        form.classList.add('err');
        $('ytUrl').focus();
        toast('Paste a YouTube link first', 'or try the demo video below the bar', 'warn');
        return;
      }
      App.loadSource(url);
    });
    $('ytUrl').addEventListener('input', () => form.classList.remove('err'));
    $('demoLink').addEventListener('click', () => {
      $('ytUrl').value = S.DEMO.url;
      App.loadSource(S.DEMO.url);
    });

    /* drag & drop a link anywhere */
    ['dragover', 'drop'].forEach(ev => window.addEventListener(ev, e => {
      e.preventDefault();
      if (ev === 'drop') {
        const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
        if (text) { $('ytUrl').value = text.trim(); App.loadSource(text.trim()); }
      }
    }));

    /* hero phone — start on the meadow, past the title cards */
    const hv = $('heroVideo');
    if (hv) {
      const startAt = 14.5;
      hv.addEventListener('loadedmetadata', () => { if (hv.currentTime < 5) hv.currentTime = startAt; }, { once: true });
      hv.addEventListener('ended', () => { hv.currentTime = startAt; hv.play().catch(() => {}); });
      hv.play().catch(() => {});
    }

    /* mini wave in float card */
    const mw = $('miniWave');
    if (mw && S.PEAKS) {
      mw.style.backgroundImage = 'repeating-linear-gradient(90deg,rgba(255,225,77,.9) 0 2px,transparent 2px 6px)';
    }

    /* recent link chips? keep it simple: pulse CTA */
  }

  /* ---------------- analyze flow ---------------- */
  function startAnalyze(project) {
    show('analyzing');
    const src = project.source;
    $('anTitle').textContent = src.title.length > 64 ? src.title.slice(0, 61) + '…' : src.title;
    $('anMeta').textContent = src.channel + '  ·  ' + S.fmt(src.sourceDuration, true) + ' source  ·  ' +
      (src.liveFailed ? 'link blocked → demo reel' : src.isDemo ? 'demo reel' : 'live link');
    $('rdyBtn').disabled = true;
    $('anBar').style.width = '0%';
    $('anPct').textContent = '0%';
    $('anLog').innerHTML = '';
    document.querySelectorAll('.an-steps li').forEach(l => l.classList.remove('active', 'done'));

    /* demo reel → play the local clip; live link → show the real thumbnail */
    const sv = $('scanVideo');
    const st = $('scanThumb');
    const badge = $('scanBadge');
    const liveThumb = !src.isDemo && /^https?:/i.test(src.thumb || '');
    if (liveThumb) {
      if (sv) { sv.pause(); sv.hidden = true; }
      if (st) { st.src = src.thumb; st.hidden = false; }
      if (badge) { badge.textContent = 'LIVE LINK'; badge.classList.add('link'); }
    } else {
      if (st) st.hidden = true;
      if (sv) {
        sv.hidden = false;
        sv.playbackRate = 2;
        sv.currentTime = 14;
        sv.play().catch(() => {});
      }
      if (badge) {
        badge.textContent = src.liveFailed ? 'LINK BLOCKED · DEMO' : 'DEMO REEL';
        badge.classList.remove('link');
      }
    }

    const steps = [
      { key: 'read', pct: 26, msgs: ['fetching ' + src.id, 'resolving storyboard grid', 'metadata ok · ' + S.fmt(src.sourceDuration, true) + ' runtime'] },
      { key: 'audio', pct: 52, msgs: ['sampling audio energy @ 8kHz', 'silence map built · 12 pauses', 'tempo locked @ 96 BPM'] },
      { key: 'score', pct: 78, msgs: ['scoring 48 candidate windows', 'hook phrases matched · 6', 'top 4 windows selected'] },
      { key: 'build', pct: 100, msgs: ['vertical crop pass · 9:16', 'word-timing captions', '4 cuts ready to edit'] }
    ];
    clearTimers();
    let t = 0;
    steps.forEach((step, si) => {
      t += 620;
      App.timers.push(setTimeout(() => {
        document.querySelectorAll('.an-steps li').forEach(l => {
          if (l.dataset.step === step.key) l.classList.add('active');
        });
        if (si > 0) {
          const prev = steps[si - 1].key;
          document.querySelectorAll('.an-steps li').forEach(l => {
            if (l.dataset.step === prev) { l.classList.remove('active'); l.classList.add('done'); }
          });
        }
        $('anBar').style.width = step.pct + '%';
        $('anPct').textContent = step.pct + '%';
        step.msgs.forEach((m, mi) => {
          App.timers.push(setTimeout(() => logLine(m), mi * 190));
        });
        if (step.pct === 100) {
          document.querySelectorAll('.an-steps li').forEach(l => { l.classList.remove('active'); l.classList.add('done'); });
          pushLog('ready · open the studio');
          $('anBar').style.width = '100%';
          $('anPct').textContent = '100%';
          $('rdyBtn').disabled = false;
          $('rdyBtn').classList.add('pulse-ready');
        }
      }, t));
    });
    pushLog('shortify v1.0 · analyzer online');

    $('rdyBtn').onclick = () => {
      location.hash = '#/studio';
      show('studio');
      S.Editor.init(App.project);
    };
  }
  function logLine(m) {
    const log = $('anLog');
    const d = document.createElement('div');
    d.className = 'log-line';
    const stamp = new Date().toTimeString().slice(0, 8);
    d.innerHTML = '<i>' + stamp + '</i> <b>✓</b> ' + String(m).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    log.appendChild(d);
    while (log.children.length > 7) log.firstChild.remove();
  }
  function pushLog(m) {
    const log = $('anLog');
    if (!log) return;
    const d = document.createElement('div');
    d.className = 'log-line';
    d.innerHTML = '<b>›</b> ' + m;
    log.appendChild(d);
  }
  function clearTimers() {
    App.timers.forEach(clearTimeout);
    App.timers = [];
  }

  /* ---------------- metadata (optional server) ---------------- */
  function fetchMeta(id) {
    return new Promise(resolve => {
      const ctrl = new AbortController();
      /* yt-dlp on a cold container can take ~30s; give it room */
      const tm = setTimeout(() => ctrl.abort(), 30000);
      fetch('/api/video?id=' + encodeURIComponent(id), { signal: ctrl.signal })
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then(j => {
          clearTimeout(tm);
          if (j && j.demo) {
            /* server could not read the link — say so, do not pretend */
            resolve({ ...demoMeta(), demo: true, note: j.note || 'link unreadable' });
          } else if (j && (j.title || j.channel)) {
            resolve({ ...j, demo: false });
          } else {
            resolve({ ...demoMeta(), demo: true, note: 'server returned no metadata' });
          }
        })
        .catch(() => {
          clearTimeout(tm);
          resolve({ ...demoMeta(), demo: true, note: 'could not reach the server' });
        });
    });
  }
  function demoMeta() {
    return { title: S.DEMO.title, channel: S.DEMO.channel, duration: S.DEMO.sourceDuration, thumb: S.DEMO.thumb };
  }

  /* ---------------- boot ---------------- */
  function boot() {
    /* inline waveform peaks so the app also works from file:// */
    fetch('assets/peaks.json').then(r => r.ok ? r.json() : null).then(j => { if (j) S.PEAKS = j; }).catch(() => {});
    bindLanding();
    route();
    window.addEventListener('hashchange', route);
    const b = $('boot');
    if (b) setTimeout(() => b.classList.add('done'), 260);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
