/* ============================================================
   SHORTIFY · engine.js
   Live FX renderer: transforms on <video>, overlay canvas FX,
   captions, beat grid. Everything previews in real time.
   ============================================================ */
(function () {
  const S = window.SHORTIFY || (window.SHORTIFY = {});

  /* ---------------- Beat grid ---------------- */
  const Beat = {
    on: true,
    bpm: 96,
    css(now) {
      if (!this.on) return 0;
      const step = 60 / this.bpm;
      const ph = ((now % step) + step) % step;
      return 1 - ph / step;                 // 1 at beat → 0 between
    },
    phase(now) {
      const step = 60 / this.bpm;
      return ((now % step) + step) % step;
    }
  };
  S.Beat = Beat;

  /* ---------------- FX overlay (canvas) ---------------- */
  const FX = {
    layers: [],
    intensity: 0.6,
    isOn(id) { return this.layers.some(l => l.id === id && l.on); },
    setLayers(layers) { this.layers = layers.map(l => ({ ...l })); },
    get(id) { return this.layers.find(l => l.id === id); },
    seekFor(fx) {
      /* deterministic pseudo random per FX id + time bucket */
      let h = 2166136261 ^ Math.floor(fx.t * 97) * 2654435761;
      h ^= (fx.id.charCodeAt(0) + fx.id.length) * 2246822519;
      return ((h >>> 0) % 10000) / 10000;
    },
    render(ctx, W, H, fx) {
      const I = this.intensity;
      if (!I || !ctx) return;
      ctx.clearRect(0, 0, W, H);
      const beat = Beat.css(fx.t);
      const t = fx.t;

      this.layers.forEach(L => {
        if (!L.on) return;
        switch (L.id) {
          case 'glitch': {
            const rand = Math.random;
            const bars = 2 + Math.floor(I * 5);
            for (let i = 0; i < bars; i++) {
              if (rand() < 0.55 - I * 0.25) continue;
              const y = rand() * H;
              const h = (0.006 + rand() * 0.03) * H * I;
              const dx = (rand() * 2 - 1) * 0.06 * W * I;
              ctx.fillStyle = rand() < 0.5
                ? 'rgba(87,242,198,' + (0.10 + I * 0.18) + ')'
                : 'rgba(124,92,255,' + (0.10 + I * 0.18) + ')';
              ctx.fillRect(dx, y, W, h);
              if (rand() < I * 0.5) {
                ctx.fillStyle = 'rgba(255,93,143,' + (0.06 + I * 0.12) + ')';
                ctx.fillRect(-dx * 1.4, y + h, W, h * 0.5);
              }
            }
            break;
          }
          case 'rgb': {
            const off = (0.004 + I * 0.012) * W * (0.6 + beat * 0.8);
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = 'rgba(255,60,90,' + (0.05 + I * 0.07) + ')';
            ctx.fillRect(-off, 0, W, H);
            ctx.fillStyle = 'rgba(60,200,255,' + (0.05 + I * 0.07) + ')';
            ctx.fillRect(off, 0, W, H);
            ctx.globalCompositeOperation = 'source-over';
            break;
          }
          case 'vhs': {
            const lh = Math.max(2, Math.round(H / (90 + (1 - I) * 140)));
            ctx.fillStyle = 'rgba(0,0,0,' + (0.05 + I * 0.10) + ')';
            for (let y = 0; y < H; y += lh * 2) ctx.fillRect(0, y, W, lh);
            const jy = (Math.sin(t * 7.3) * 0.5 + Math.sin(t * 3.1) * 0.5) * 0.01 * H * I;
            ctx.fillStyle = 'rgba(255,255,255,' + (0.025 + I * 0.04) + ')';
            ctx.fillRect(0, H * 0.5 + jy, W, H * 0.006);
            const g = ctx.createLinearGradient(0, 0, 0, H);
            g.addColorStop(0, 'rgba(255,120,200,' + (0.04 * I) + ')');
            g.addColorStop(1, 'rgba(80,220,255,' + (0.05 * I) + ')');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);
            break;
          }
          case 'flash': {
            const step = 60 / Beat.bpm;
            const ph = Beat.phase(t);
            const onCut = Math.min(ph, step - ph) < 0.06;
            if (onCut) {
              ctx.fillStyle = 'rgba(255,255,255,' + (0.22 + I * 0.4) * (1 - Math.min(ph, step - ph) / 0.06) + ')';
              ctx.fillRect(0, 0, W, H);
            }
            break;
          }
          case 'pulse': {
            /* handled by transform layer, plus a soft radial glow here */
            const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.75);
            g.addColorStop(0, 'rgba(255,255,255,0)');
            g.addColorStop(1, 'rgba(124,92,255,' + (beat * 0.16 * I) + ')');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);
            break;
          }
          default: break;
        }
      });
    }
  };
  S.FX = FX;

  /* ---------------- Transform math ---------------- */
  /* returns {scale, x, y, rot} for the video element */
  S.transformFor = function (fx) {
    const I = FX.intensity, t = fx.t;
    const beat = Beat.css(t);
    const cutAge = Math.min(1, (t - fx.cutT0) * 6);           // ramp right after a cut
    const punch = FX.get('punch');
    const shake = FX.get('shake');
    const pulse = FX.get('pulse');
    const whip = FX.get('whip');
    const squeeze = FX.get('squeeze');
    const kb = FX.get('kenburns');

    let zoom = 1;
    if (punch && punch.on) {
      const cutKick = 1 - Math.min(1, Math.max(0, (t - fx.cutT0) / 0.45));
      zoom += (0.055 + I * 0.06) * cutKick;
    }

    /* fit zoom so vertical crop covers (9:16 from 16:9 needs ~1.78) */
    zoom += fx.fitZoom || 0;
    /* punch-in amount from style panel */
    zoom += (fx.zoomAmt || 0) / 100 * 0.30;

    if (pulse && pulse.on) zoom += beat * I * 0.045;

    if (kb && kb.on && fx.cutLen > 0) {
      const p = (t - fx.cutT0) / Math.max(0.001, fx.cutLen);
      zoom += (0.04 + I * 0.075) * (0.5 - Math.abs(p - 0.5)) / 0.5;
    }

    let x = 0, y = 0, rot = 0;
    if (shake && shake.on) {
      const a = I * 14 * (0.35 + beat * 1.65);
      x = Math.sin(t * 41.3) * a + Math.sin(t * 17.7) * a * 0.5;
      y = Math.cos(t * 37.1) * a * 0.8 + Math.cos(t * 23.3) * a * 0.35;
      rot = Math.sin(t * 29.7) * I * 0.7;
    }
    if (squeeze && squeeze.on) {
      zoom *= 1 + beat * I * 0.05;
    }
    if (whip && whip.on) {
      /* blur & nudge for ~160ms after every cut */
      const age = t - fx.cutT0;
      if (age >= 0 && age < 0.16) {
        const k = 1 - age / 0.16;
        x += k * (fx.whipDir || 1) * I * 90;
      }
    }
    return { scale: zoom, x, y, rot };
  };

  S.filterFor = function (state, beat) {
    const look = (S.LOOKS || []).find(l => l.id === state.look) || { css: 'none' };
    let f = look.css === 'none' ? '' : look.css;
    const I = FX.intensity;
    const beatVal = beat == null ? Beat.css(performance.now() / 1000) : beat;
    if (state.effects) {
      const gl = state.effects.find(e => e.id === 'glitch' && e.on);
      if (gl) {
        /* subtle synchronous wobble instead of patching the filter every frame */
        f += ' hue-rotate(' + (Math.sin(performance.now() / 90) * 6 * I).toFixed(1) + 'deg) saturate(' + (1 + I * 0.2).toFixed(2) + ')';
      }
      const vhs = state.effects.find(e => e.id === 'vhs' && e.on);
      if (vhs) f += ' contrast(1.04) sepia(' + (0.08 + 0.10 * I).toFixed(2) + ')';
      const pulse = state.effects.find(e => e.id === 'pulse' && e.on);
      if (pulse) f += ' brightness(' + (1 + beatVal * I * 0.16).toFixed(3) + ')';
    }
    return f.trim();
  };

  /* ---------------- Captions ---------------- */
  const Caption = {
    words: [],
    build(text) {
      const raw = (text || '').trim().split(/\s+/).filter(Boolean).slice(0, 16);
      this.words = raw;
      return raw;
    },
    /* short phrases (1–2 words) → the classic Shorts karaoke cadence */
    phrases(words) {
      const out = [];
      let cur = [];
      words.forEach(w => {
        const next = cur.concat(w).join(' ');
        if ((cur.length >= 2 || next.length > 15) && cur.length) { out.push({ words: cur.slice(), text: cur.join(' ') }); cur = [w]; }
        else cur.push(w);
      });
      if (cur.length) out.push({ words: cur.slice(), text: cur.join(' ') });
      return out.length ? out : [{ words: ['your caption'], text: 'your caption' }];
    },
    activeIndex(p, n) {
      if (!n) return -1;
      return Math.min(n - 1, Math.floor(p * n));
    }
  };
  S.Caption = Caption;

  /* ---------------- Render plan (export) ---------------- */
  S.buildFilterGraph = function (state, videoFile) {
    const look = (S.LOOKS || []).find(l => l.id === state.look);
    const fx = state.effects || [];
    const on = id => !!fx.find(e => e.id === id && e.on);
    const W = state.outW, H = state.outH;
    const I = (state.intensity == null ? 60 : state.intensity) / 100;
    const parts = [];

    /* cover-crop 16:9 → target AR */
    parts.push('crop=ih*' + (W / H) + ':ih');

    /* beat-synced zoom: zoompan expects per-frame */
    const fps = state.fps || 30;
    const bps = (state.bpm || 96) / 60;
    if (on('punch') || on('pulse') || on('kenburns') || (state.zoomAmt || 0) > 0) {
      const cutLen = state.cutEnd - state.cutStart;
      let z = '1.12';
      if (on('pulse')) z = '1.12+' + (0.05 * I) + '*abs(sin(PI*' + bps.toFixed(4) + '*on/' + fps + '))';
      parts.push(
        'zoompan=z=\'' + z + '\':x=\'iw/2-(iw/zoom/2)+sin(on/' + fps + '*41)*' + (on('shake') ? 6 * I : 0) + '\':' +
        'y=\'ih/2-(ih/zoom/2)+cos(on/' + fps + '*37)*' + (on('shake') ? 5 * I : 0) + '\':d=1:s=' + W + 'x' + H + ':fps=' + fps
      );
    } else {
      parts.push('scale=' + W + ':' + H);
    }

    if (look && look.ff) parts.push(look.ff);
    if (on('glitch')) parts.push('eq=saturation=' + (1 + I * 0.3));
    if (on('rgb')) {
      const px = Math.round(2 + I * 8);
      parts.push('[rgb]');
      parts[parts.length - 1] = 'split=3[r1][r2][r3]';
      parts.push('[r1]lutrgb=r=val:g=0:b=0[r_a]');
      parts.push('[r2]lutrgb=r=0:g=val:b=0[r_b]');
      parts.push('[r3]lutrgb=r=0:g=0:b=val[r_c]');
      parts.push('[r_a][r_b][r_c]blend=all_mode=screen:all_opacity=' + (0.25 + I * 0.4) + ':x=' + px + ':y=0');
    }
    if (on('vhs')) {
      parts.push('noise=alls=' + Math.round(6 + I * 14) + ':allf=t+u');
      parts.push('curves=preset=vintage');
    }
    if (on('flash')) {
      parts.push('fade=t=in:st=0:d=0.08:color=white');
    }
    if (state.letterbox) {
      const bar = Math.round(H * 0.055);
      parts.push('drawbox=x=0:y=0:w=' + W + ':h=' + bar + ':color=black@1:t=fill');
      parts.push('drawbox=x=0:y=' + (H - bar) + ':w=' + W + ':h=' + bar + ':color=black@1:t=fill');
    }

    /* captions block (top card + karaoke line approximated with drawtext) */
    const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
    if (state.cardOn && state.cardText) {
      parts.push(
        "drawtext=text='" + esc(state.cardText) + "':fontcolor=white:fontsize=" + Math.round(H * 0.045) +
        ':x=(w-text_w)/2:y=' + Math.round(H * 0.085) + ':box=1:boxcolor=black@0.35:boxborderw=' + Math.round(H * 0.014)
      );
    }
    if ((state.capText || '').trim()) {
      parts.push(
        "drawtext=text='" + esc(state.capText) + "':fontcolor=white:fontsize=" + Math.round(H * (state.capSize || 64) / 1080) +
        ':x=(w-text_w)/2:y=h-text_h-' + Math.round(H * 0.16) + ':box=1:boxcolor=black@0.25:boxborderw=' + Math.round(H * 0.01)
      );
    }

    return {
      ffmpeg: [
        'ffmpeg -y -ss ' + state.cutStart.toFixed(2) + ' -to ' + state.cutEnd.toFixed(2) + ' -i ' + videoFile,
        '-vf "' + parts.join(',') + '"',
        '-r ' + fps + ' -c:v libx264 -preset medium -crf 19 -pix_fmt yuv420p',
        '-c:a aac -b:a 160k -movflags +faststart',
        'out_' + state.aspect.replace(':', 'x') + '.mp4'
      ].join(' \\\n  ')
    };
  };
})();
