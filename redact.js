/* Bridges.directory: certificate blackout tool.
 *
 * window.BridgesRedact.open(file, { coverQR: true })  ->  Promise<Blob | null>
 *   Shows the certificate, puts black bars on it, and returns a flattened image (PNG) with the bars
 *   burned into the pixels. Returns null if the person cancels or the file cannot be used.
 *   Nothing is uploaded here. Everything happens in the browser.
 *
 * Open question from the chats: Aman said volunteers scan the QR to check the name, while the
 * schedule says QR codes must be covered. This tool follows the schedule. To change that, pass
 * { coverQR: false } or change COVER_QR_DEFAULT below (one line).
 */
(function () {
  'use strict';

  var COVER_QR_DEFAULT = true;

  // Standard bars, as fractions of the picture (x, y, width, height from the top-left).
  // Taken from the sketch Aman sent: a middle bar and two horizontal bands. There is no real sample
  // certificate yet, so change these numbers when there is one. The applicant always reviews them.
  var DEFAULT_BARS = [
    { x: 0.00, y: 0.20, w: 1.00, h: 0.06, label: 'Top band' },
    { x: 0.00, y: 0.64, w: 1.00, h: 0.06, label: 'Lower band' },
    { x: 0.46, y: 0.00, w: 0.08, h: 1.00, label: 'Middle bar' }
  ];

  var LIMITS = {
    maxFileBytes: 10 * 1024 * 1024,   // what the person may choose
    maxLongSide: 2000,                // the saved picture is shrunk to this
    maxOutputBytes: 6 * 1024 * 1024,  // the saved picture is never bigger than this
    minBarPx: 8,
    qrPadding: 0.08,                  // extra margin around a found QR code
    maxQr: 6
  };

  var TEXT = {
    title: 'Hide private details',
    intro: 'Black bars are put on your certificate on your own device, before anything is sent. Move or resize them so only the details volunteers must check stay visible.',
    introQR: ' QR codes are covered for you.',
    help: 'Drag a bar to move it. Drag its corners or edges to resize it. With the keyboard: arrow keys move the selected bar, Shift plus arrow keys resize it, Delete removes it.',
    add: 'Add bar', del: 'Delete bar', reset: 'Reset bars', cancel: 'Cancel', apply: 'Use this file',
    coverIt: 'Cover it for me',
    scanning: 'Checking for QR codes…',
    noQr: 'No QR code found.',
    noBars: 'Add at least one bar before you continue.',
    preparing: 'Getting your file ready…',
    tooBig: 'That file is over 10 MB. Please choose a smaller one.',
    badType: 'Please choose a JPG, PNG, WebP or PDF file.',
    notReal: 'That file does not look like a real picture or PDF. Please choose another one.',
    cantOpen: 'We could not open that file. Try a clearer photo or scan.',
    password: 'This PDF needs a password. Remove the password and try again.',
    onlyFirst: 'Only the first page of the PDF is used.',
    scanFailed: 'We could not check for QR codes, so we cannot continue. Please try again.',
    stillReadable: 'A QR code can still be read. Move a bar over it so it is fully covered.',
    close: 'Close'
  };

  var BASE = (function () {
    var s = document.currentScript;
    return s && s.src ? s.src.replace(/[^/?#]*([?#].*)?$/, '') : '';
  })();

  // ---------------------------------------------------------------- small helpers
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  var loaded = {};
  function loadScript(rel) {
    if (loaded[rel]) return loaded[rel];
    loaded[rel] = new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = BASE + rel; s.async = true;
      s.onload = function () { ok(); };
      s.onerror = function () { delete loaded[rel]; bad(new Error('load ' + rel)); };
      document.head.appendChild(s);
    });
    return loaded[rel];
  }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  // ---------------------------------------------------------------- file checks
  function sniff(file) {
    return file.slice(0, 12).arrayBuffer().then(function (buf) {
      var b = new Uint8Array(buf);
      var at = function (s, o) { for (var i = 0; i < s.length; i++) if (b[(o || 0) + i] !== s.charCodeAt(i)) return false; return true; };
      if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
      if (b[0] === 0x89 && at('PNG', 1)) return 'png';
      if (at('RIFF') && at('WEBP', 8)) return 'webp';
      if (at('%PDF')) return 'pdf';
      return null;
    });
  }
  // resolves { ok, kind, message }
  function check(file) {
    if (!file || typeof file.size !== 'number') return Promise.resolve({ ok: false, message: TEXT.cantOpen });
    if (file.size > LIMITS.maxFileBytes) return Promise.resolve({ ok: false, message: TEXT.tooBig });
    var okType = /^(image\/(jpeg|png|webp)|application\/pdf)$/i.test(file.type || '');
    var okExt = /\.(jpe?g|png|webp|pdf)$/i.test(file.name || '');
    if (!okType && !okExt) return Promise.resolve({ ok: false, message: TEXT.badType });
    return sniff(file).then(function (kind) {
      if (!kind) return { ok: false, message: TEXT.notReal };
      return { ok: true, kind: kind };
    });
  }

  // ---------------------------------------------------------------- loading the picture
  function toWorkCanvas(source, w, h) {
    var s = Math.min(1, LIMITS.maxLongSide / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
    var c = document.createElement('canvas'); c.width = cw; c.height = ch;
    var x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#fff'; x.fillRect(0, 0, cw, ch);       // flatten transparency
    x.imageSmoothingQuality = 'high';
    x.drawImage(source, 0, 0, cw, ch);
    return c;
  }
  function decodeImage(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file).then(function (bmp) {
        var c = toWorkCanvas(bmp, bmp.width, bmp.height); if (bmp.close) bmp.close(); return c;
      });
    }
    return new Promise(function (ok, bad) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { var c = toWorkCanvas(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(url); ok(c); };
      img.onerror = function () { URL.revokeObjectURL(url); bad(new Error('decode')); };
      img.src = url;
    });
  }
  function decodePdf(file) {
    return loadScript('vendor/pdf.min.js').then(function () {
      var lib = window.pdfjsLib;
      lib.GlobalWorkerOptions.workerSrc = BASE + 'vendor/pdf.worker.min.js';
      return file.arrayBuffer().then(function (buf) { return lib.getDocument({ data: new Uint8Array(buf) }).promise; });
    }).then(function (pdf) {
      var pages = pdf.numPages;
      return pdf.getPage(1).then(function (page) {
        var base = page.getViewport({ scale: 1 });
        var scale = clamp(LIMITS.maxLongSide / Math.max(base.width, base.height), 1, 4);
        var vp = page.getViewport({ scale: scale });
        var c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        var x = c.getContext('2d', { willReadFrequently: true });
        return page.render({ canvasContext: x, viewport: vp, background: '#ffffff' }).promise.then(function () {
          var out = toWorkCanvas(c, c.width, c.height);
          return { canvas: out, pages: pages };
        });
      });
    });
  }

  // ---------------------------------------------------------------- QR finding
  // jsQR finds one code per call, so we find one, blank it on a copy, and look again.
  function findQRs(canvas) {
    var w = canvas.width, h = canvas.height;
    var data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
    var found = [];
    function scanOnce(img, iw, ih, factor) {
      var res = [];
      for (var i = 0; i < LIMITS.maxQr; i++) {
        var r = window.jsQR(img.data, iw, ih, { inversionAttempts: 'attemptBoth' });
        if (!r) break;
        var L = r.location, xs = [], ys = [];
        ['topLeftCorner', 'topRightCorner', 'bottomLeftCorner', 'bottomRightCorner',
         'topRightFinderPattern', 'topLeftFinderPattern', 'bottomLeftFinderPattern', 'bottomRightAlignmentPattern'].forEach(function (k) {
          if (L[k]) { xs.push(L[k].x); ys.push(L[k].y); }
        });
        var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
        var bw = x1 - x0, bh = y1 - y0, pad = Math.max(4, Math.max(bw, bh) * 0.06);
        var px0 = clamp(Math.floor(x0 - pad), 0, iw), py0 = clamp(Math.floor(y0 - pad), 0, ih);
        var px1 = clamp(Math.ceil(x1 + pad), 0, iw), py1 = clamp(Math.ceil(y1 + pad), 0, ih);
        res.push({ x: px0 * factor, y: py0 * factor, w: (px1 - px0) * factor, h: (py1 - py0) * factor });
        // blank this code on the working copy so the next call can find another one
        for (var yy = py0; yy < py1; yy++) for (var xx = px0; xx < px1; xx++) {
          var o = (yy * iw + xx) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = 255; img.data[o + 3] = 255;
        }
      }
      return res;
    }
    found = scanOnce(new ImageData(new Uint8ClampedArray(data.data), w, h), w, h, 1);
    // Dense or tiny codes are sometimes missed at full size: look again on smaller copies.
    [0.5, 0.35].forEach(function (f) {
      if (found.length) return;
      var sw = Math.max(1, Math.round(w * f)), sh = Math.max(1, Math.round(h * f));
      var c2 = document.createElement('canvas'); c2.width = sw; c2.height = sh;
      var x2 = c2.getContext('2d', { willReadFrequently: true });
      x2.imageSmoothingQuality = 'high'; x2.drawImage(canvas, 0, 0, sw, sh);
      found = scanOnce(x2.getImageData(0, 0, sw, sh), sw, sh, 1 / f);
    });
    return found;
  }

  // is every pixel of rect r covered by the bars?
  function covered(r, bars, W, H) {
    var m = document.createElement('canvas'); m.width = W; m.height = H;
    var x = m.getContext('2d', { willReadFrequently: true });
    bars.forEach(function (b) { fillBar(x, b); });
    var x0 = clamp(Math.floor(r.x), 0, W), y0 = clamp(Math.floor(r.y), 0, H);
    var x1 = clamp(Math.ceil(r.x + r.w), 0, W), y1 = clamp(Math.ceil(r.y + r.h), 0, H);
    if (x1 <= x0 || y1 <= y0) return true;
    var d = x.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    for (var i = 3; i < d.length; i += 4) if (d[i] < 255) return false;
    return true;
  }
  function fillBar(ctx, b) {
    var x0 = Math.floor(b.x), y0 = Math.floor(b.y), x1 = Math.ceil(b.x + b.w), y1 = Math.ceil(b.y + b.h);
    ctx.fillStyle = '#000';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  // ---------------------------------------------------------------- styles
  function injectCss() {
    if (document.getElementById('brx-css')) return;
    var css = [
      '.brx{position:fixed;inset:0;z-index:90;background:rgba(10,8,4,.55);display:grid;place-items:center;padding:12px}',
      '.brx *{box-sizing:border-box}',
      '.brx-box{width:min(980px,100%);max-height:calc(100svh - 24px);display:flex;flex-direction:column;gap:12px;padding:16px;background:var(--surface,#fff);color:var(--ink,#16150f);border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.35);font-family:var(--sans,system-ui,sans-serif);overflow:hidden}',
      '.brx-box:focus{outline:none}',
      '.brx h2{margin:0;font:600 1.125rem/1.3 var(--sans,system-ui,sans-serif)}',
      '.brx p{margin:0;font-size:.875rem;line-height:1.45;color:var(--ink-2,#3b3932)}',
      '.brx .brx-help{font-size:.8125rem;color:var(--muted,#6b685f)}',
      '.brx-tools{display:flex;flex-wrap:wrap;gap:8px}',
      '.brx-btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 16px;border:0;border-radius:9px;font:500 .875rem/1 var(--sans,system-ui,sans-serif);cursor:pointer;background:var(--fill,#e8e6e0);color:var(--ink,#16150f);white-space:nowrap}',
      '.brx-btn:hover{background:var(--fill-2,#dedbd3)}',
      '.brx-btn.primary{background:var(--btn,#16150f);color:var(--btn-fg,#fff)}',
      '.brx-btn.primary:hover{background:var(--btn-h,#2e2c26)}',
      '.brx-btn.ghost{background:transparent;color:var(--ink-2,#3b3932)}',
      '.brx-btn.ghost:hover{background:var(--fill,#e8e6e0)}',
      '.brx-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.brx-btn:focus-visible,.brx-bar:focus-visible,.brx-h:focus-visible{outline:3px solid var(--ring,rgba(22,21,15,.45));outline-offset:2px}',
      '.brx-stage{flex:1 1 auto;min-height:120px;overflow:auto;display:grid;place-items:center;padding:8px;background:var(--fill,#e8e6e0);border-radius:12px}',
      '.brx-wrap{position:relative;display:inline-block;max-width:100%;line-height:0;touch-action:pan-x pan-y;user-select:none;-webkit-user-select:none}',
      '.brx-wrap canvas{display:block;max-width:100%;max-height:52svh;width:auto;height:auto;background:#fff}',
      '.brx-bars{position:absolute;inset:0}',
      '.brx-bar{position:absolute;background:#000;touch-action:none;cursor:move;outline:1px solid rgba(255,255,255,.35)}',
      '.brx-bar span{position:absolute;left:4px;top:3px;font:600 10px/1 var(--sans,system-ui,sans-serif);color:#fff;opacity:.8;pointer-events:none;white-space:nowrap}',
      '.brx-bar.sel{outline:3px solid #2f7bff;z-index:2}',
      '.brx-h{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;touch-action:none;display:none;z-index:3}',
      '.brx-h::after{content:"";position:absolute;left:8px;top:8px;width:10px;height:10px;background:#fff;border:2px solid #2f7bff;border-radius:3px}',
      '.brx-bar.sel .brx-h{display:block}',
      '.brx-h[data-h=nw]{left:0;top:0;cursor:nwse-resize}.brx-h[data-h=ne]{left:100%;top:0;cursor:nesw-resize}',
      '.brx-h[data-h=sw]{left:0;top:100%;cursor:nesw-resize}.brx-h[data-h=se]{left:100%;top:100%;cursor:nwse-resize}',
      '.brx-h[data-h=n]{left:50%;top:0;cursor:ns-resize}.brx-h[data-h=s]{left:50%;top:100%;cursor:ns-resize}',
      '.brx-h[data-h=w]{left:0;top:50%;cursor:ew-resize}.brx-h[data-h=e]{left:100%;top:50%;cursor:ew-resize}',
      '.brx-qrbox{position:absolute;border:3px dashed #ff3b30;background:rgba(255,59,48,.18);pointer-events:none;z-index:1}',
      '.brx-status{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-height:24px;font-size:.875rem;color:var(--ink-2,#3b3932)}',
      '.brx-status.warn{color:var(--warn-fg,#892300)}',
      '.brx-status.bad{color:var(--neg-fg,#bd002a)}',
      '.brx-status.good{color:var(--pos-fg,#00550c)}',
      '.brx-foot{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}',
      '@media (max-width:560px){.brx{padding:0;place-items:end stretch}.brx-box{border-radius:16px 16px 0 0;max-height:100svh}.brx-foot .brx-btn{flex:1}}'
    ].join('\n');
    document.head.appendChild(el('style', { id: 'brx-css', text: css }));
  }

  // ---------------------------------------------------------------- modal shell
  function shell(titleText) {
    injectCss();
    var back = el('div', { class: 'brx', role: 'presentation' });
    var box = el('div', { class: 'brx-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'brx-t', tabindex: '-1' });
    box.appendChild(el('h2', { id: 'brx-t', text: titleText }));
    back.appendChild(box);
    var prevFocus = document.activeElement, prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.appendChild(back);
    box.focus();
    function trap(e) {
      if (e.key !== 'Tab') return;
      var f = [].slice.call(box.querySelectorAll('button:not([disabled]),[tabindex="0"]')).filter(function (n) { return n.offsetParent !== null; });
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    back.addEventListener('keydown', trap);
    return {
      back: back, box: box,
      close: function () {
        back.remove(); document.documentElement.style.overflow = prevOverflow;
        if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) {}
      }
    };
  }

  function showError(message) {
    return new Promise(function (done) {
      var sh = shell(TEXT.title);
      var msg = el('p', { text: message, role: 'alert' });
      var btn = el('button', { class: 'brx-btn primary', type: 'button', text: TEXT.close });
      sh.box.appendChild(msg);
      sh.box.appendChild(el('div', { class: 'brx-foot' }, [btn]));
      function end() { sh.close(); done(null); }
      btn.addEventListener('click', end);
      sh.back.addEventListener('keydown', function (e) { if (e.key === 'Escape') end(); });
      btn.focus();
    });
  }

  // ---------------------------------------------------------------- the editor
  function editor(work, opts, note) {
    return new Promise(function (resolve) {
      var W = work.width, H = work.height;
      var coverQR = opts.coverQR;
      var sh = shell(TEXT.title);
      var bars = [], seq = 0, selected = null, qrs = [], scanDone = !coverQR, scanError = false, busy = false, refused = false;

      var intro = el('p', { text: TEXT.intro + (coverQR ? TEXT.introQR : '') + (note ? ' ' + note : '') });
      var help = el('p', { class: 'brx-help', id: 'brx-help', text: TEXT.help });
      var bAdd = el('button', { class: 'brx-btn', type: 'button', text: TEXT.add });
      var bDel = el('button', { class: 'brx-btn', type: 'button', text: TEXT.del });
      var bReset = el('button', { class: 'brx-btn', type: 'button', text: TEXT.reset });
      var tools = el('div', { class: 'brx-tools', role: 'group', 'aria-label': 'Bar tools' }, [bAdd, bDel, bReset]);

      var cv = work; // the picture itself is shown on the working canvas
      var layer = el('div', { class: 'brx-bars' });
      var wrap = el('div', { class: 'brx-wrap' }, [cv, layer]);
      var stage = el('div', { class: 'brx-stage' }, [wrap]);
      var status = el('div', { class: 'brx-status', role: 'status', 'aria-live': 'polite' });
      var bCancel = el('button', { class: 'brx-btn ghost', type: 'button', text: TEXT.cancel });
      var bApply = el('button', { class: 'brx-btn primary', type: 'button', text: TEXT.apply });
      var foot = el('div', { class: 'brx-foot' }, [bCancel, bApply]);
      [intro, help, tools, stage, status, foot].forEach(function (n) { sh.box.appendChild(n); });

      // ---- bars
      function pct(v, total) { return (v / total * 100) + '%'; }
      function newBar(x, y, w, h, label, isQr) {
        var b = { id: ++seq, x: x, y: y, w: w, h: h, label: label, qr: !!isQr };
        b.node = el('div', { class: 'brx-bar', tabindex: '0', role: 'group', 'aria-label': label + '. ' + TEXT.help.split('.')[0], 'aria-describedby': 'brx-help' });
        b.tag = el('span', { text: label });
        b.node.appendChild(b.tag);
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (h2) {
          var hd = el('div', { class: 'brx-h', 'data-h': h2, 'aria-hidden': 'true' });
          b.node.appendChild(hd);
        });
        layer.appendChild(b.node);
        bars.push(b);
        place(b);
        return b;
      }
      function place(b) {
        var s = b.node.style;
        s.left = pct(b.x, W); s.top = pct(b.y, H); s.width = pct(b.w, W); s.height = pct(b.h, H);
      }
      function select(b) {
        selected = b;
        bars.forEach(function (x) { x.node.classList.toggle('sel', x === b); });
        bDel.disabled = !b;
      }
      function remove(b) {
        var i = bars.indexOf(b); if (i < 0) return;
        bars.splice(i, 1); b.node.remove();
        select(null); refresh();
      }
      function fit(b) {
        b.w = clamp(b.w, LIMITS.minBarPx, W); b.h = clamp(b.h, LIMITS.minBarPx, H);
        b.x = clamp(b.x, 0, W - b.w); b.y = clamp(b.y, 0, H - b.h);
      }
      function loadDefaults() {
        bars.slice().forEach(function (b) { b.node.remove(); }); bars = []; select(null);
        DEFAULT_BARS.forEach(function (d) { newBar(d.x * W, d.y * H, d.w * W, d.h * H, d.label, false); });
        coverUncovered();
      }
      function coverUncovered() {
        if (!coverQR) return;
        qrs.forEach(function (q) {
          if (covered(q, bars, W, H)) return;
          newBar(q.x, q.y, q.w, q.h, 'QR cover', true);
        });
        refresh();
      }

      // ---- dragging
      var drag = null;
      layer.addEventListener('pointerdown', function (e) {
        var barNode = e.target.closest('.brx-bar'); if (!barNode) { select(null); return; }
        var b = bars.filter(function (x) { return x.node === barNode; })[0]; if (!b) return;
        select(b);
        var hd = e.target.closest('.brx-h');
        var rect = cv.getBoundingClientRect();
        drag = { b: b, mode: hd ? hd.getAttribute('data-h') : 'move', sx: e.clientX, sy: e.clientY,
                 kx: W / rect.width, ky: H / rect.height, o: { x: b.x, y: b.y, w: b.w, h: b.h } };
        try { barNode.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
      });
      layer.addEventListener('pointermove', function (e) {
        if (!drag) return;
        var dx = (e.clientX - drag.sx) * drag.kx, dy = (e.clientY - drag.sy) * drag.ky, o = drag.o, b = drag.b, m = drag.mode;
        if (m === 'move') { b.x = clamp(o.x + dx, 0, W - o.w); b.y = clamp(o.y + dy, 0, H - o.h); }
        else {
          var x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
          if (m.indexOf('w') >= 0) x0 = clamp(o.x + dx, 0, x1 - LIMITS.minBarPx);
          if (m.indexOf('e') >= 0) x1 = clamp(o.x + o.w + dx, x0 + LIMITS.minBarPx, W);
          if (m.indexOf('n') >= 0) y0 = clamp(o.y + dy, 0, y1 - LIMITS.minBarPx);
          if (m.indexOf('s') >= 0) y1 = clamp(o.y + o.h + dy, y0 + LIMITS.minBarPx, H);
          b.x = x0; b.y = y0; b.w = x1 - x0; b.h = y1 - y0;
        }
        place(b); schedule();
      });
      function endDrag() { if (drag) { drag = null; refresh(); } }
      layer.addEventListener('pointerup', endDrag);
      layer.addEventListener('pointercancel', endDrag);

      // ---- keyboard
      layer.addEventListener('keydown', function (e) {
        var barNode = e.target.closest && e.target.closest('.brx-bar'); if (!barNode) return;
        var b = bars.filter(function (x) { return x.node === barNode; })[0]; if (!b) return;
        var stepX = Math.max(1, W * 0.01), stepY = Math.max(1, H * 0.01), used = true;
        if (e.key === 'Delete' || e.key === 'Backspace') { remove(b); bAdd.focus(); }
        else if (e.key.indexOf('Arrow') === 0) {
          var dx = e.key === 'ArrowLeft' ? -stepX : e.key === 'ArrowRight' ? stepX : 0;
          var dy = e.key === 'ArrowUp' ? -stepY : e.key === 'ArrowDown' ? stepY : 0;
          if (e.shiftKey) { b.w += dx; b.h += dy; } else { b.x += dx; b.y += dy; }
          fit(b); place(b); schedule();
        } else used = false;
        if (used) e.preventDefault();
      });
      layer.addEventListener('focusin', function (e) {
        var barNode = e.target.closest && e.target.closest('.brx-bar'); if (!barNode) return;
        var b = bars.filter(function (x) { return x.node === barNode; })[0]; if (b && b !== selected) select(b);
      });

      // ---- status
      var raf = 0;
      function schedule() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; refresh(); }); }
      var qrBoxes = [];
      function refresh() {
        qrBoxes.forEach(function (n) { n.remove(); }); qrBoxes = [];
        var uncovered = [];
        if (coverQR && scanDone) uncovered = qrs.filter(function (q) { return !covered(q, bars, W, H); });
        uncovered.forEach(function (q) {
          var n = el('div', { class: 'brx-qrbox', 'aria-hidden': 'true' });
          n.style.left = pct(q.x, W); n.style.top = pct(q.y, H); n.style.width = pct(q.w, W); n.style.height = pct(q.h, H);
          layer.appendChild(n); qrBoxes.push(n);
        });
        status.textContent = ''; status.className = 'brx-status';
        var msg = '', cls = '';
        if (busy) msg = TEXT.preparing;
        else if (scanError) { msg = TEXT.scanFailed; cls = 'bad'; }
        else if (coverQR && !scanDone) msg = TEXT.scanning;
        else if (refused) { msg = TEXT.stillReadable; cls = 'bad'; }
        else if (uncovered.length) { msg = uncovered.length + (uncovered.length === 1 ? ' QR code is' : ' QR codes are') + ' not covered yet. Move a bar over it.'; cls = 'warn'; }
        else if (!bars.length) { msg = TEXT.noBars; cls = 'warn'; }
        else if (coverQR && qrs.length) { msg = qrs.length + (qrs.length === 1 ? ' QR code found and covered.' : ' QR codes found and covered.'); cls = 'good'; }
        else if (coverQR) { msg = TEXT.noQr; }
        else msg = bars.length + (bars.length === 1 ? ' bar added.' : ' bars added.');
        status.appendChild(el('span', { text: msg }));
        status.classList.add.apply(status.classList, cls ? [cls] : []);
        if (uncovered.length) {
          var fix = el('button', { class: 'brx-btn', type: 'button', text: TEXT.coverIt });
          fix.addEventListener('click', function () { refused = false; coverUncovered(); });
          status.appendChild(fix);
        }
        var ready = !busy && !scanError && scanDone && bars.length > 0 && uncovered.length === 0;
        bApply.disabled = !ready;
        bAdd.disabled = bReset.disabled = busy;
        bDel.disabled = busy || !selected;
      }

      // ---- buttons
      bAdd.addEventListener('click', function () {
        var w = W * 0.3, h = H * 0.08;
        var b = newBar((W - w) / 2, (H - h) / 2, w, h, 'Bar ' + (bars.length + 1), false);
        select(b); b.node.focus(); refresh();
      });
      bDel.addEventListener('click', function () { if (selected) { remove(selected); bAdd.focus(); } });
      bReset.addEventListener('click', function () { refused = false; loadDefaults(); });
      function finish(v) { sh.close(); resolve(v); }
      bCancel.addEventListener('click', function () { finish(null); });
      sh.back.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !busy) finish(null); });

      bApply.addEventListener('click', function () {
        if (bApply.disabled) return;
        busy = true; refused = false; refresh();
        tick().then(function () { return render(work, bars, coverQR); }).then(function (res) {
          if (res.stillReadable) {
            busy = false; refused = true;
            qrs = qrs.concat(res.found.filter(function (f) { return !qrs.some(function (q) { return Math.abs(q.x - f.x) < 6 && Math.abs(q.y - f.y) < 6; }); }));
            refresh(); return;
          }
          BridgesRedact._last = { bars: bars.map(function (b) { return { x: b.x, y: b.y, w: b.w, h: b.h, qr: b.qr }; }), width: res.width, height: res.height, scale: res.scale };
          finish(res.blob);
        }).catch(function () { busy = false; scanError = true; refresh(); });
      });

      // ---- start
      loadDefaults(); select(null); refresh();
      bApply.disabled = true;
      if (coverQR) {
        loadScript('vendor/jsqr.js').then(tick).then(function () {
          qrs = findQRs(work); scanDone = true; coverUncovered(); refresh();
        }).catch(function () { scanError = true; scanDone = true; refresh(); });
      }
      (bAdd.focus.bind(bAdd))();
      BridgesRedact._state = function () { return { bars: bars, qrs: qrs, W: W, H: H, scanDone: scanDone, apply: bApply, add: bAdd, del: bDel, reset: bReset, cancel: bCancel, status: status, layer: layer, canvas: cv }; };
    });
  }

  // ---------------------------------------------------------------- burning the bars in
  function encode(canvas, type, q) {
    return new Promise(function (ok) { canvas.toBlob(ok, type, q); });
  }
  function render(work, bars, coverQR) {
    var W = work.width, H = work.height;
    var out = document.createElement('canvas'); out.width = W; out.height = H;
    var x = out.getContext('2d', { willReadFrequently: true, alpha: false });
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
    x.drawImage(work, 0, 0);
    bars.forEach(function (b) { fillBar(x, b); });
    var found = coverQR ? findQRs(out) : [];
    if (found.length) return Promise.resolve({ stillReadable: true, found: found });
    // PNG keeps the black bars perfectly black. If it is too big, shrink step by step.
    var scale = 1;
    function attempt() {
      var c = out;
      if (scale < 1) {
        c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(W * scale)); c.height = Math.max(1, Math.round(H * scale));
        var cx = c.getContext('2d', { alpha: false }); cx.imageSmoothingQuality = 'high'; cx.drawImage(out, 0, 0, c.width, c.height);
      }
      return encode(c, 'image/png').then(function (blob) {
        if (!blob) throw new Error('encode');
        if (blob.size <= LIMITS.maxOutputBytes) return { blob: blob, width: c.width, height: c.height, scale: scale };
        if (scale < 0.3) { return encode(c, 'image/jpeg', 0.85).then(function (j) { if (!j || j.size > LIMITS.maxOutputBytes) throw new Error('too big'); return { blob: j, width: c.width, height: c.height, scale: scale }; }); }
        scale *= 0.8; return tick().then(attempt);
      });
    }
    return attempt().then(function (r) {
      // look again on the finished picture (it may have been shrunk)
      if (coverQR) {
        var again = document.createElement('canvas'); again.width = r.width; again.height = r.height;
        var ax = again.getContext('2d', { willReadFrequently: true });
        return createImageBitmap(r.blob).then(function (bmp) {
          ax.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
          var f2 = findQRs(again);
          if (f2.length) return { stillReadable: true, found: f2.map(function (q) { var k = W / r.width; return { x: q.x * k, y: q.y * k, w: q.w * k, h: q.h * k }; }) };
          return r;
        });
      }
      return r;
    });
  }

  // ---------------------------------------------------------------- public
  var busyOpen = false;
  function open(file, options) {
    var opts = { coverQR: COVER_QR_DEFAULT };
    if (options && typeof options.coverQR === 'boolean') opts.coverQR = options.coverQR;
    if (busyOpen) return Promise.resolve(null);
    busyOpen = true;
    BridgesRedact.lastError = null;
    function fail(msg) { BridgesRedact.lastError = msg; return showError(msg); }
    return check(file).then(function (c) {
      if (!c.ok) return fail(c.message);
      var loading = c.kind === 'pdf' ? decodePdf(file) : decodeImage(file).then(function (cv) { return { canvas: cv, pages: 1 }; });
      return loading.then(function (r) {
        return editor(r.canvas, opts, r.pages > 1 ? TEXT.onlyFirst : '');
      }, function (e) {
        var pw = e && (e.name === 'PasswordException' || /password/i.test(e.message || ''));
        return fail(pw ? TEXT.password : TEXT.cantOpen);
      });
    }).then(function (res) { busyOpen = false; return res; }, function (e) { busyOpen = false; throw e; });
  }

  var BridgesRedact = {
    open: open,
    check: check,
    defaultBars: DEFAULT_BARS,
    limits: LIMITS,
    lastError: null,
    _findQRs: findQRs,
    _last: null
  };
  window.BridgesRedact = BridgesRedact;
})();
