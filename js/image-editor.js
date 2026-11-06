/*
 * BOYWO - Éditeur d'images (outils/image_editor.html)
 *
 * Visualisation + annotation + réglages d'images PNG / JPG / JPEG / SVG, 100 % dans le navigateur
 * (aucun fichier n'est envoyé nulle part).
 *
 * Architecture :
 *  - baseCanvas / srcData : pixels d'origine (jamais modifiés) ;
 *  - adjCanvas            : image d'origine + réglages (luminosité, éclairage, contraste, ombres, RGB),
 *                           calculée par tables de correspondance (LUT) ;
 *  - annotCanvas          : calque transparent des annotations, reconstruit depuis la liste `strokes` ;
 *  - l'affichage compose ces calques avec un zoom/déplacement (view) ;
 *  - l'historique (annuler/rétablir) mémorise { strokes, adj } à chaque action ;
 *  - l'export recompose tout à la taille réelle de l'image (aucun rééchantillonnage).
 */
(() => {
    'use strict';

    const $ = id => document.getElementById(id);
    const el = {
        file: $('iep-file'), importBtn: $('iep-import-btn'), emptyImport: $('iep-empty-import'),
        info: $('iep-file-info'), error: $('iep-error'), errorText: $('iep-error-text'), errorClose: $('iep-error-close'),
        restore: $('iep-restore'), restoreText: $('iep-restore-text'), restoreYes: $('iep-restore-yes'), restoreNo: $('iep-restore-no'),
        undo: $('iep-undo'), redo: $('iep-redo'), save: $('iep-save'), exportBtn: $('iep-export-btn'),
        toolgrid: $('iep-toolgrid'), swatches: $('iep-swatches'), color: $('iep-color'), colorHex: $('iep-color-hex'),
        size: $('iep-size'), sizeOut: $('iep-size-out'), clearAnnot: $('iep-clear-annot'),
        zoomIn: $('iep-zoom-in'), zoomOut: $('iep-zoom-out'), zoomFit: $('iep-zoom-fit'), zoom100: $('iep-zoom-100'), zoomVal: $('iep-zoom-val'),
        compareBtn: $('iep-compare-btn'), compareBar: $('iep-comparebar'), comparePos: $('iep-compare-pos'),
        work: $('iep-workspace'), canvas: $('iep-canvas'), empty: $('iep-empty'),
        resetAdj: $('iep-reset-adj'), toast: $('iep-toast'),
        dlg: $('iep-export-dialog'), exName: $('iep-export-name'), exFormat: $('iep-export-format'),
        exQualityField: $('iep-quality-field'), exQuality: $('iep-export-quality'), exQualityOut: $('iep-export-quality-out'),
        exAnnot: $('iep-export-annot'), exInfo: $('iep-export-info'), exCancel: $('iep-export-cancel'), exConfirm: $('iep-export-confirm')
    };
    const sliders = Array.from(document.querySelectorAll('input[data-adj]'));
    const ctx = el.canvas.getContext('2d');

    // ---------- Constantes ----------
    const MAX_FILE_BYTES = 60 * 1024 * 1024;
    const MAX_SIDE = 16384;            // limite d'un canvas dans Chrome
    const MAX_PIXELS = 80e6;           // garde-fou mémoire
    const ZOOM_MIN = 0.05, ZOOM_MAX = 32;
    const HISTORY_MAX = 150;
    const ADJ_DEFAULT = Object.freeze({ brightness: 0, lighting: 0, contrast: 0, shadows: 0, red: 0, green: 0, blue: 0 });
    const COLORS = ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e84393', '#ffffff', '#95a5a6', '#2d3436', '#000000'];
    const COLOR_NAMES = ['Rouge', 'Orange', 'Jaune', 'Vert', 'Turquoise', 'Bleu', 'Violet', 'Rose', 'Blanc', 'Gris', 'Anthracite', 'Noir'];
    const BRUSH_TOOLS = ['pen', 'highlighter', 'eraser'];
    const DB_NAME = 'BoywoImageEditor', DB_STORE = 'projects', DB_KEY = 'last';

    // ---------- État ----------
    let current = null;                // { file, name, w, h, isSvg }
    let hasImage = false;
    let baseCanvas = null, srcData = null, outData = null;
    let adjCanvas = null, adjCtx = null, annotCanvas = null, annotCtx = null;
    let strokes = [];
    let adj = { ...ADJ_DEFAULT };
    let history = [], hIndex = -1;
    let dirty = false;
    let tool = 'pen', color = '#e74c3c', size = 8;
    const view = { scale: 1, tx: 0, ty: 0 };
    let viewTouched = false;
    const compare = { on: false, pos: 0.5 };
    let cur = null, preview = null, hover = null;
    const pointers = new Map();
    let panning = null, pinch = null, suppressStroke = false, spaceDown = false;
    let rafRender = 0, rafAdjust = 0;
    let toastTimer = 0;
    let checker = null;

    // ---------- Utilitaires ----------
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const sameAdj = (a, b) => Object.keys(ADJ_DEFAULT).every(k => a[k] === b[k]);
    const isIdentity = a => sameAdj(a, ADJ_DEFAULT);

    function sanitizeName(raw) {
        return String(raw == null ? '' : raw)
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
            .replace(/\s+/g, ' ').trim()
            .replace(/\.(png|jpe?g|svg)$/i, '')
            .replace(/^\.+|\.+$/g, '').trim()
            .slice(0, 100);
    }

    // Dimensions d'un SVG (attributs width/height, sinon viewBox), ramenées à une taille de travail nette (1600 – 4096 px).
    function svgSize(text) {
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        const svg = doc.documentElement;
        if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('svg-invalid');
        const num = v => { const m = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(v || ''); return m ? parseFloat(m[1]) : 0; };
        let w = num(svg.getAttribute('width')), h = num(svg.getAttribute('height'));
        const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
        if ((!w || !h) && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
            const r = vb[2] / vb[3];
            if (w && !h) h = w / r; else if (h && !w) w = h * r; else { w = vb[2]; h = vb[3]; }
        }
        if (!w || !h) { w = 1024; h = 768; }
        const long = Math.max(w, h);
        let k = 1;
        if (long < 1600) k = 1600 / long;
        if (long * k > 4096) k = 4096 / long;
        return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
    }

    function loadImg(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('decode'));
            img.src = url;
        });
    }

    function showError(msg) { el.errorText.textContent = msg; el.error.hidden = false; }
    function hideError() { el.error.hidden = true; el.errorText.textContent = ''; }
    function toast(msg) {
        el.toast.textContent = msg;
        el.toast.classList.add('iep-toast-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.toast.classList.remove('iep-toast-show'), 2600);
    }

    // ---------- Réglages : tables de correspondance ----------
    // Ordre : éclairage (gamma) → luminosité → contraste → ombres → gain de canal (RGB).
    function buildLUTs(a) {
        const exp = Math.pow(2, -a.lighting / 60);
        const br = a.brightness * 1.27;
        const c = a.contrast * 1.5;
        const cf = (259 * (c + 255)) / (255 * (259 - c));
        const sh = (a.shadows / 100) * 80;
        return [a.red, a.green, a.blue].map(ch => {
            const gain = 1 + ch / 100;
            const lut = new Uint8ClampedArray(256);
            for (let i = 0; i < 256; i++) {
                let v = Math.pow(i / 255, exp) * 255 + br;
                v = cf * (v - 128) + 128;
                const t = 1 - clamp(v / 255, 0, 1);
                v += sh * t * t;
                lut[i] = v * gain;
            }
            return lut;
        });
    }

    function applyAdjustments() {
        if (!srcData) return;
        if (isIdentity(adj)) {
            adjCtx.clearRect(0, 0, adjCanvas.width, adjCanvas.height);
            adjCtx.drawImage(baseCanvas, 0, 0);
            return;
        }
        const [lr, lg, lb] = buildLUTs(adj);
        const s = srcData.data, o = outData.data;
        for (let i = 0; i < s.length; i += 4) {
            o[i] = lr[s[i]]; o[i + 1] = lg[s[i + 1]]; o[i + 2] = lb[s[i + 2]]; o[i + 3] = s[i + 3];
        }
        adjCtx.putImageData(outData, 0, 0);
    }

    function scheduleAdjust() {
        if (rafAdjust) return;
        rafAdjust = requestAnimationFrame(() => { rafAdjust = 0; applyAdjustments(); requestRender(); });
    }

    // ---------- Annotations ----------
    const strokeWidth = s => (s.tool === 'highlighter' ? s.size * 3 : s.tool === 'eraser' ? s.size * 2 : s.size);

    function setupStroke(c, s) {
        const lw = strokeWidth(s);
        c.lineCap = 'round'; c.lineJoin = 'round';
        c.lineWidth = lw; c.strokeStyle = s.color; c.fillStyle = s.color;
        if (s.tool === 'eraser') c.globalCompositeOperation = 'destination-out';
        if (s.tool === 'highlighter') c.globalAlpha = 0.38;
        return lw;
    }

    function drawStroke(c, s) {
        c.save();
        const lw = setupStroke(c, s);
        if (s.points) {
            const p = s.points;
            if (p.length === 1) {
                c.beginPath(); c.arc(p[0].x, p[0].y, lw / 2, 0, Math.PI * 2); c.fill();
            } else {
                c.beginPath(); c.moveTo(p[0].x, p[0].y);
                for (let i = 1; i < p.length; i++) c.lineTo(p[i].x, p[i].y);
                c.stroke();
            }
        } else if (s.tool === 'arrow') {
            const { p0, p1 } = s;
            const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
            const head = Math.max(lw * 3.5, 14);
            c.beginPath(); c.moveTo(p0.x, p0.y); c.lineTo(p1.x, p1.y);
            for (const d of [-0.5, 0.5]) {
                c.moveTo(p1.x, p1.y);
                c.lineTo(p1.x - head * Math.cos(ang + d), p1.y - head * Math.sin(ang + d));
            }
            c.stroke();
        } else if (s.tool === 'rect') {
            c.strokeRect(Math.min(s.p0.x, s.p1.x), Math.min(s.p0.y, s.p1.y), Math.abs(s.p1.x - s.p0.x), Math.abs(s.p1.y - s.p0.y));
        } else if (s.tool === 'ellipse') {
            c.beginPath();
            c.ellipse((s.p0.x + s.p1.x) / 2, (s.p0.y + s.p1.y) / 2, Math.max(0.5, Math.abs(s.p1.x - s.p0.x) / 2), Math.max(0.5, Math.abs(s.p1.y - s.p0.y) / 2), 0, 0, Math.PI * 2);
            c.stroke();
        }
        c.restore();
    }

    function drawSegment(c, s, a, b) {
        c.save();
        setupStroke(c, s);
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
        c.restore();
    }

    function rebuildAnnot() {
        if (!annotCtx) return;
        annotCtx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
        for (const s of strokes) drawStroke(annotCtx, s);
    }

    // ---------- Historique ----------
    const snapshot = () => ({ strokes: strokes.slice(), adj: { ...adj } });
    const sameSnap = (a, b) => a.strokes.length === b.strokes.length && a.strokes.every((s, i) => s === b.strokes[i]) && sameAdj(a.adj, b.adj);

    function commit(initial) {
        const snap = snapshot();
        if (!initial && hIndex >= 0 && sameSnap(history[hIndex], snap)) return;
        history.splice(hIndex + 1);
        history.push(snap);
        if (history.length > HISTORY_MAX) history.shift();
        hIndex = history.length - 1;
        if (!initial) dirty = true;
        updateUI();
    }

    function restoreTo(i) {
        if (i < 0 || i >= history.length) return;
        const snap = history[i];
        const strokesChanged = snap.strokes.length !== strokes.length || snap.strokes.some((s, k) => s !== strokes[k]);
        const adjChanged = !sameAdj(snap.adj, adj);
        hIndex = i;
        strokes = snap.strokes.slice();
        adj = { ...snap.adj };
        if (strokesChanged) rebuildAnnot();
        if (adjChanged) applyAdjustments();
        dirty = true;
        syncSliders();
        updateUI();
        requestRender();
    }
    const undo = () => { cancelStroke(); restoreTo(hIndex - 1); };
    const redo = () => { cancelStroke(); restoreTo(hIndex + 1); };

    // ---------- Interface ----------
    function syncSliders() {
        sliders.forEach(s => {
            const k = s.dataset.adj;
            s.value = adj[k];
            const out = document.querySelector(`output[data-out="${k}"]`);
            if (out) out.textContent = adj[k];
        });
    }

    function updateInfo() {
        if (!current) { el.info.textContent = 'Aucune image ouverte'; return; }
        el.info.textContent = `${current.name} · ${current.w} × ${current.h} px${dirty ? ' · modifications non enregistrées' : ''}`;
    }

    function updateUI() {
        const on = hasImage;
        el.undo.disabled = !on || hIndex <= 0;
        el.redo.disabled = !on || hIndex >= history.length - 1;
        el.save.disabled = !on;
        el.exportBtn.disabled = !on;
        el.clearAnnot.disabled = !on || strokes.length === 0;
        el.resetAdj.disabled = !on || isIdentity(adj);
        [el.zoomIn, el.zoomOut, el.zoomFit, el.zoom100, el.compareBtn].forEach(b => { b.disabled = !on; });
        sliders.forEach(s => { s.disabled = !on; });
        updateInfo();
    }

    function setTool(t) {
        tool = t;
        el.toolgrid.querySelectorAll('.iep-tool').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
        el.work.classList.toggle('iep-pan', t === 'hand' || compare.on);
        hover = null;
        requestRender();
    }

    function setColor(hex) {
        color = hex.toLowerCase();
        el.color.value = color;
        el.colorHex.textContent = color.toUpperCase();
        el.swatches.querySelectorAll('.iep-swatch').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === color)));
        try { localStorage.setItem('iep_color', color); } catch (_) { /* stockage indisponible */ }
    }

    function setSize(v) {
        size = clamp(Math.round(v), 1, +el.size.max);
        el.size.value = size;
        el.sizeOut.textContent = size;
    }

    function buildSwatches() {
        COLORS.forEach((hex, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'iep-swatch';
            b.dataset.color = hex;
            b.style.background = hex;
            b.title = `${COLOR_NAMES[i]} (${hex.toUpperCase()})`;
            b.setAttribute('aria-label', COLOR_NAMES[i]);
            b.setAttribute('aria-pressed', 'false');
            b.addEventListener('click', () => setColor(hex));
            el.swatches.appendChild(b);
        });
    }

    // ---------- Affichage (zoom / déplacement) ----------
    const toImage = (cx, cy) => {
        const r = el.canvas.getBoundingClientRect();
        return { x: (cx - r.left - view.tx) / view.scale, y: (cy - r.top - view.ty) / view.scale };
    };

    function sizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(el.work.clientWidth * dpr));
        const h = Math.max(1, Math.round(el.work.clientHeight * dpr));
        if (el.canvas.width !== w || el.canvas.height !== h) { el.canvas.width = w; el.canvas.height = h; }
    }

    function fitView(cap) {
        if (!current) return;
        const cw = el.work.clientWidth, ch = el.work.clientHeight, pad = 24;
        const s = clamp(Math.min((cw - pad * 2) / current.w, (ch - pad * 2) / current.h), ZOOM_MIN, cap);
        view.scale = s;
        view.tx = (cw - current.w * s) / 2;
        view.ty = (ch - current.h * s) / 2;
        viewTouched = false;
        requestRender();
    }

    function zoomAt(factor, cx, cy) {
        const s = clamp(view.scale * factor, ZOOM_MIN, ZOOM_MAX);
        const k = s / view.scale;
        view.tx = cx - (cx - view.tx) * k;
        view.ty = cy - (cy - view.ty) * k;
        view.scale = s;
        viewTouched = true;
        requestRender();
    }
    const zoomCenter = f => zoomAt(f, el.work.clientWidth / 2, el.work.clientHeight / 2);

    function makeChecker() {
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const x = c.getContext('2d');
        x.fillStyle = '#ffffff'; x.fillRect(0, 0, 16, 16);
        x.fillStyle = '#e3e8ea'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
        checker = ctx.createPattern(c, 'repeat');
    }

    function requestRender() { if (!rafRender) rafRender = requestAnimationFrame(render); }

    function chip(text, x, align, dpr) {
        const tw = ctx.measureText(text).width, pw = 10 * dpr, hh = 24 * dpr;
        const bx = align === 'left' ? x : x - tw - pw * 2;
        ctx.fillStyle = 'rgba(44,62,80,.78)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, 12 * dpr, tw + pw * 2, hh, 12 * dpr); else ctx.rect(bx, 12 * dpr, tw + pw * 2, hh);
        ctx.fill();
        ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(text, bx + pw, 12 * dpr + hh / 2);
    }

    function render() {
        rafRender = 0;
        sizeCanvas();
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
        if (!hasImage) return;
        const { w, h } = current, s = view.scale;
        el.zoomVal.textContent = `${Math.round(s * 100)} %`;

        // damier (transparence), dessiné en pixels écran
        const x0 = view.tx * dpr, y0 = view.ty * dpr, dw = w * s * dpr, dh = h * s * dpr;
        ctx.save();
        ctx.beginPath(); ctx.rect(x0, y0, dw, dh); ctx.clip();
        ctx.fillStyle = checker; ctx.fillRect(x0, y0, dw, dh);
        ctx.restore();

        ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * view.tx, dpr * view.ty);
        ctx.imageSmoothingEnabled = s < 2.5;
        ctx.imageSmoothingQuality = 'high';
        if (compare.on) {
            const cx = w * compare.pos;
            ctx.save(); ctx.beginPath(); ctx.rect(0, 0, cx, h); ctx.clip(); ctx.drawImage(baseCanvas, 0, 0); ctx.restore();
            ctx.save(); ctx.beginPath(); ctx.rect(cx, 0, w - cx, h); ctx.clip();
            ctx.drawImage(adjCanvas, 0, 0); ctx.drawImage(annotCanvas, 0, 0);
            ctx.restore();
        } else {
            ctx.drawImage(adjCanvas, 0, 0);
            ctx.drawImage(annotCanvas, 0, 0);
            if (preview) drawStroke(ctx, preview);
        }

        // surcouches en pixels écran
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (compare.on) {
            const sx = (view.tx + w * compare.pos * s) * dpr;
            ctx.save();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 6 * dpr;
            ctx.beginPath(); ctx.moveTo(sx, y0); ctx.lineTo(sx, y0 + dh); ctx.stroke();
            ctx.beginPath(); ctx.arc(sx, y0 + dh / 2, 9 * dpr, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
            ctx.restore();
            ctx.save();
            ctx.font = `600 ${12 * dpr}px Poppins, Arial, sans-serif`;
            chip('Original', 12 * dpr, 'left', dpr);
            chip('Modifiée', el.canvas.width - 12 * dpr, 'right', dpr);
            ctx.restore();
        } else if (hover && BRUSH_TOOLS.includes(tool) && !panning && !spaceDown) {
            const r = (strokeWidth({ tool, size }) * s * dpr) / 2;
            ctx.save();
            ctx.beginPath(); ctx.arc(hover.x * dpr, hover.y * dpr, Math.max(r, 1.5 * dpr), 0, Math.PI * 2);
            ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.stroke();
            ctx.lineWidth = 1.2 * dpr; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.stroke();
            ctx.restore();
        }
    }

    // ---------- Pointeur : dessin, déplacement, pincement ----------
    function cancelStroke() {
        if (!cur) return;
        const was = cur;
        cur = null; preview = null;
        if (was.tool === 'pen' || was.tool === 'eraser') rebuildAnnot();
        requestRender();
    }

    function beginStroke(e) {
        const p = toImage(e.clientX, e.clientY);
        if (BRUSH_TOOLS.includes(tool)) cur = { tool, color, size, points: [p] };
        else cur = { tool, color, size, p0: p, p1: p };
        if (tool === 'pen' || tool === 'eraser') drawStroke(annotCtx, cur); // le trait s'inscrit au fur et à mesure
        else preview = cur;                                                 // surligneur et formes : aperçu puis validation
        requestRender();
    }

    function extendStroke(e) {
        const events = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
        for (const ev of events) {
            const p = toImage(ev.clientX, ev.clientY);
            if (cur.points) {
                const last = cur.points[cur.points.length - 1];
                if (dist(last, p) < 0.6 / view.scale) continue;
                cur.points.push(p);
                if (cur.tool === 'pen' || cur.tool === 'eraser') drawSegment(annotCtx, cur, last, p);
            } else {
                cur.p1 = p;
            }
        }
        requestRender();
    }

    function endStroke() {
        if (!cur) return;
        const s = cur;
        cur = null; preview = null;
        if (!s.points && dist(s.p0, s.p1) < 3 / view.scale) { requestRender(); return; } // simple clic : pas de forme
        if (s.tool === 'highlighter' || !s.points) drawStroke(annotCtx, s);
        strokes.push(s);
        commit();
        requestRender();
    }

    const localPoint = e => { const r = el.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const pinchData = () => {
        const [a, b] = Array.from(pointers.values());
        const r = el.canvas.getBoundingClientRect();
        return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top };
    };

    el.canvas.addEventListener('pointerdown', e => {
        if (!hasImage) return;
        el.canvas.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
            cancelStroke(); panning = null; suppressStroke = true;
            const p = pinchData();
            pinch = { d0: p.d, scale0: view.scale, cx0: p.cx, cy0: p.cy, tx0: view.tx, ty0: view.ty };
            return;
        }
        if (pointers.size > 2 || suppressStroke) return;
        const panMode = tool === 'hand' || spaceDown || compare.on || e.button === 1;
        if (panMode) {
            panning = { sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty };
            el.work.classList.add('iep-panning');
            return;
        }
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        beginStroke(e);
    });

    el.canvas.addEventListener('pointermove', e => {
        if (!hasImage) return;
        const lp = localPoint(e);
        hover = e.pointerType === 'touch' ? null : lp;
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pointers.size >= 2) {
            const p = pinchData();
            const s = clamp(pinch.scale0 * p.d / pinch.d0, ZOOM_MIN, ZOOM_MAX);
            view.scale = s;
            view.tx = p.cx - (pinch.cx0 - pinch.tx0) * s / pinch.scale0;
            view.ty = p.cy - (pinch.cy0 - pinch.ty0) * s / pinch.scale0;
            viewTouched = true;
        } else if (panning) {
            view.tx = panning.tx + (e.clientX - panning.sx);
            view.ty = panning.ty + (e.clientY - panning.sy);
            viewTouched = true;
        } else if (cur) {
            extendStroke(e);
        }
        requestRender();
    });

    const pointerEnd = e => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = null;
        if (pointers.size === 0) suppressStroke = false;
        if (panning) { panning = null; el.work.classList.remove('iep-panning'); }
        endStroke();
    };
    el.canvas.addEventListener('pointerup', pointerEnd);
    el.canvas.addEventListener('pointercancel', e => { cancelStroke(); pointerEnd(e); });
    el.canvas.addEventListener('pointerleave', () => { hover = null; requestRender(); });
    el.canvas.addEventListener('contextmenu', e => e.preventDefault());
    el.canvas.addEventListener('wheel', e => {
        if (!hasImage) return;
        e.preventDefault();
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        const lp = localPoint(e);
        zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), lp.x, lp.y);
    }, { passive: false });

    // ---------- Chargement d'une image ----------
    async function loadFile(file, restoreData) {
        hideError();
        if (!file) return;
        const name = file.name || 'image';
        const ext = (name.split('.').pop() || '').toLowerCase();
        const isSvg = ext === 'svg' || file.type === 'image/svg+xml';
        const okType = isSvg || ['png', 'jpg', 'jpeg'].includes(ext) || ['image/png', 'image/jpeg'].includes(file.type);
        if (!okType) return showError(`Format non pris en charge pour « ${name} ». Utilisez un fichier PNG, JPG, JPEG ou SVG.`);
        if (!file.size) return showError(`Le fichier « ${name} » est vide.`);
        if (file.size > MAX_FILE_BYTES) return showError('Fichier trop volumineux (60 Mo maximum).');
        if (!restoreData && dirty && !confirm('Les modifications non enregistrées seront perdues. Ouvrir une autre image ?')) return;

        let url = '';
        try {
            let w = 0, h = 0, blob = file;
            if (isSvg) {
                const text = await file.text();
                ({ w, h } = svgSize(text));
                blob = new Blob([text], { type: 'image/svg+xml' });
            }
            url = URL.createObjectURL(blob);
            const img = await loadImg(url);
            if (!isSvg) { w = img.naturalWidth; h = img.naturalHeight; }
            if (!w || !h) throw new Error('decode');
            if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) throw new Error(`size:${w}×${h}`);

            const base = document.createElement('canvas');
            base.width = w; base.height = h;
            const bctx = base.getContext('2d', { willReadFrequently: true });
            bctx.drawImage(img, 0, 0, w, h);
            let data;
            try { data = bctx.getImageData(0, 0, w, h); } catch (_) { throw new Error('tainted'); }

            baseCanvas = base; srcData = data; outData = new ImageData(w, h);
            adjCanvas = document.createElement('canvas'); adjCanvas.width = w; adjCanvas.height = h;
            adjCtx = adjCanvas.getContext('2d');
            annotCanvas = document.createElement('canvas'); annotCanvas.width = w; annotCanvas.height = h;
            annotCtx = annotCanvas.getContext('2d');

            current = { file, name, w, h, isSvg };
            strokes = restoreData && Array.isArray(restoreData.strokes) ? restoreData.strokes : [];
            adj = { ...ADJ_DEFAULT, ...(restoreData && restoreData.adj ? restoreData.adj : {}) };
            rebuildAnnot();
            applyAdjustments();
            syncSliders();

            const longSide = Math.max(w, h);
            el.size.max = String(clamp(Math.round(longSide / 10), 30, 300));
            setSize(clamp(Math.round(longSide / 250), 2, 40));

            compare.on = false; el.compareBtn.setAttribute('aria-pressed', 'false'); el.compareBar.hidden = true;
            history = []; hIndex = -1; dirty = false;
            hasImage = true;
            commit(true);
            setTool(tool);
            el.empty.hidden = true;
            el.restore.hidden = true;
            fitView(1);
            toast(restoreData ? 'Projet repris' : 'Image importée');
        } catch (err) {
            const m = String(err && err.message || '');
            if (m === 'svg-invalid') showError(`Le fichier SVG « ${name} » est invalide ou illisible.`);
            else if (m.startsWith('size:')) showError(`Image trop grande (${m.slice(5)} px). Limites : ${MAX_SIDE} px par côté et ${Math.round(MAX_PIXELS / 1e6)} mégapixels.`);
            else if (m === 'tainted') showError('Cette image contient des éléments externes qui empêchent son édition. Essayez de l\'exporter en PNG depuis son logiciel d\'origine.');
            else showError(`Impossible de lire « ${name} » : le fichier est peut-être corrompu ou son contenu ne correspond pas à son extension.`);
        } finally {
            if (url) URL.revokeObjectURL(url);
        }
    }

    // ---------- Enregistrement du projet (IndexedDB) ----------
    function openDB() {
        return new Promise((resolve, reject) => {
            const r = indexedDB.open(DB_NAME, 1);
            r.onupgradeneeded = () => r.result.createObjectStore(DB_STORE);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    }
    async function dbRun(mode, fn) {
        const db = await openDB();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(DB_STORE, mode);
                const req = fn(tx.objectStore(DB_STORE));
                tx.oncomplete = () => resolve(req && req.result);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } finally { db.close(); }
    }

    async function saveProject() {
        if (!hasImage) return;
        try {
            await dbRun('readwrite', s => s.put({ name: current.name, type: current.file.type, blob: current.file, strokes, adj: { ...adj }, savedAt: Date.now() }, DB_KEY));
            dirty = false;
            updateInfo();
            toast('Projet enregistré dans ce navigateur');
        } catch (_) {
            showError('Impossible d\'enregistrer le projet (espace de stockage insuffisant ou indisponible). Utilisez plutôt « Exporter ».');
        }
    }

    async function checkSavedProject() {
        try {
            const rec = await dbRun('readonly', s => s.get(DB_KEY));
            if (!rec || !rec.blob) return;
            el.restoreText.textContent = `Projet enregistré : « ${rec.name} » (${new Date(rec.savedAt).toLocaleString('fr-FR')}).`;
            el.restore.hidden = false;
        } catch (_) { /* pas de projet ou stockage indisponible */ }
    }

    el.restoreYes.addEventListener('click', async () => {
        try {
            const rec = await dbRun('readonly', s => s.get(DB_KEY));
            if (!rec) { el.restore.hidden = true; return; }
            await loadFile(new File([rec.blob], rec.name, { type: rec.type }), rec);
        } catch (_) { showError('Impossible de reprendre le projet enregistré.'); }
    });
    el.restoreNo.addEventListener('click', async () => {
        try { await dbRun('readwrite', s => s.delete(DB_KEY)); } catch (_) { /* ignoré */ }
        el.restore.hidden = true;
        toast('Projet enregistré supprimé');
    });

    // ---------- Export ----------
    function updateExportDialog() {
        const jpeg = el.exFormat.value === 'jpeg';
        el.exQualityField.hidden = !jpeg;
        el.exInfo.textContent = `Dimensions : ${current.w} × ${current.h} px (taille d'origine conservée, sans rééchantillonnage). ` +
            (jpeg ? 'Le JPEG est compressé avec perte ; les zones transparentes deviennent blanches.' : 'Le PNG est sans perte et conserve la transparence.');
    }

    function openExport() {
        if (!hasImage) return;
        el.exName.value = `${sanitizeName(current.name) || 'image'}-modifie`;
        el.exFormat.value = /jpe?g/i.test(current.file.type) || /\.jpe?g$/i.test(current.name) ? 'jpeg' : 'png';
        updateExportDialog();
        if (typeof el.dlg.showModal === 'function') el.dlg.showModal(); else el.dlg.setAttribute('open', '');
        el.exName.focus(); el.exName.select();
    }

    async function doExport() {
        const jpeg = el.exFormat.value === 'jpeg';
        const base = sanitizeName(el.exName.value) || 'image-modifie';
        const filename = `${base}.${jpeg ? 'jpg' : 'png'}`;
        el.dlg.close();
        hideError();
        try {
            if (rafAdjust) { cancelAnimationFrame(rafAdjust); rafAdjust = 0; }
            applyAdjustments();
            const out = document.createElement('canvas');
            out.width = current.w; out.height = current.h;
            const o = out.getContext('2d');
            if (jpeg) { o.fillStyle = '#ffffff'; o.fillRect(0, 0, out.width, out.height); }
            o.drawImage(adjCanvas, 0, 0);
            if (el.exAnnot.checked) o.drawImage(annotCanvas, 0, 0);
            const blob = await new Promise((resolve, reject) => {
                try { out.toBlob(resolve, jpeg ? 'image/jpeg' : 'image/png', jpeg ? (+el.exQuality.value) / 100 : undefined); }
                catch (err) { reject(err); }
            });
            if (!blob) throw new Error('empty');
            const a = document.createElement('a');
            const href = URL.createObjectURL(blob);
            a.href = href; a.download = filename;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(href), 5000);
            toast(`« ${filename} » exporté (${(blob.size / 1048576).toFixed(2)} Mo)`);
        } catch (_) {
            showError('L\'export a échoué : l\'image est peut-être trop volumineuse pour le navigateur. Essayez le format JPG ou réduisez la taille de l\'image.');
        }
    }

    // ---------- Événements d'interface ----------
    const pickFile = () => el.file.click();
    el.importBtn.addEventListener('click', pickFile);
    el.emptyImport.addEventListener('click', pickFile);
    el.file.addEventListener('change', () => { const f = el.file.files && el.file.files[0]; el.file.value = ''; loadFile(f); });
    el.errorClose.addEventListener('click', hideError);

    el.toolgrid.addEventListener('click', e => { const b = e.target.closest('.iep-tool'); if (b) setTool(b.dataset.tool); });
    el.color.addEventListener('input', () => setColor(el.color.value));
    el.size.addEventListener('input', () => setSize(+el.size.value));
    el.clearAnnot.addEventListener('click', () => { if (!strokes.length) return; cancelStroke(); strokes = []; rebuildAnnot(); commit(); requestRender(); });

    el.undo.addEventListener('click', undo);
    el.redo.addEventListener('click', redo);
    el.save.addEventListener('click', saveProject);
    el.exportBtn.addEventListener('click', openExport);
    el.exCancel.addEventListener('click', () => el.dlg.close());
    el.exConfirm.addEventListener('click', doExport);
    el.exFormat.addEventListener('change', updateExportDialog);
    el.exQuality.addEventListener('input', () => { el.exQualityOut.textContent = el.exQuality.value; });
    el.exName.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doExport(); } });

    el.zoomIn.addEventListener('click', () => zoomCenter(1.25));
    el.zoomOut.addEventListener('click', () => zoomCenter(1 / 1.25));
    el.zoomFit.addEventListener('click', () => fitView(8));
    el.zoom100.addEventListener('click', () => zoomCenter(1 / view.scale));

    el.compareBtn.addEventListener('click', () => {
        compare.on = !compare.on;
        el.compareBtn.setAttribute('aria-pressed', String(compare.on));
        el.compareBar.hidden = !compare.on;
        if (compare.on) cancelStroke();
        el.work.classList.toggle('iep-pan', tool === 'hand' || compare.on);
        requestRender();
    });
    el.comparePos.addEventListener('input', () => { compare.pos = +el.comparePos.value / 100; requestRender(); });

    sliders.forEach(s => {
        const k = s.dataset.adj;
        const out = document.querySelector(`output[data-out="${k}"]`);
        s.addEventListener('input', () => { adj[k] = +s.value; if (out) out.textContent = s.value; el.resetAdj.disabled = isIdentity(adj); scheduleAdjust(); });
        s.addEventListener('change', () => commit());
        s.addEventListener('dblclick', () => {
            if (adj[k] === 0) return;
            adj[k] = 0; s.value = 0; if (out) out.textContent = '0';
            scheduleAdjust(); commit();
        });
    });
    el.resetAdj.addEventListener('click', () => { if (isIdentity(adj)) return; adj = { ...ADJ_DEFAULT }; syncSliders(); applyAdjustments(); commit(); requestRender(); });

    // Glisser-déposer d'un fichier n'importe où dans la page
    document.addEventListener('dragover', e => { e.preventDefault(); el.work.classList.add('iep-dragover'); });
    document.addEventListener('dragleave', e => { if (!e.relatedTarget) el.work.classList.remove('iep-dragover'); });
    document.addEventListener('drop', e => {
        e.preventDefault();
        el.work.classList.remove('iep-dragover');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) loadFile(f);
    });

    // Raccourcis clavier
    const toolKeys = { v: 'hand', p: 'pen', m: 'highlighter', e: 'eraser', a: 'arrow', r: 'rect', o: 'ellipse' };
    document.addEventListener('keydown', e => {
        if (el.dlg.open) return;
        const t = e.target;
        const typing = t && ((t.tagName === 'INPUT' && !['range', 'checkbox', 'color'].includes(t.type)) || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
        if (typing) return;
        const k = e.key.toLowerCase();
        if (e.ctrlKey || e.metaKey) {
            if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
            else if (k === 'y') { e.preventDefault(); redo(); }
            else if (k === 's') { e.preventDefault(); saveProject(); }
            return;
        }
        if (!hasImage) return;
        if (e.key === ' ') { if (t && t.tagName === 'BUTTON') return; spaceDown = true; el.work.classList.add('iep-pan'); e.preventDefault(); }
        else if (toolKeys[k]) setTool(toolKeys[k]);
        else if (k === '+' || k === '=') zoomCenter(1.25);
        else if (k === '-') zoomCenter(1 / 1.25);
        else if (k === '0') fitView(8);
        else if (k === '[') setSize(size - Math.max(1, Math.round(size * 0.15)));
        else if (k === ']') setSize(size + Math.max(1, Math.round(size * 0.15)));
    });
    document.addEventListener('keyup', e => {
        if (e.key === ' ' && spaceDown) { spaceDown = false; el.work.classList.toggle('iep-pan', tool === 'hand' || compare.on); }
    });

    window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => { if (hasImage && !viewTouched) fitView(1); else requestRender(); }).observe(el.work);
    } else {
        window.addEventListener('resize', requestRender);
    }

    // ---------- Initialisation ----------
    buildSwatches();
    makeChecker();
    let savedColor = '#e74c3c';
    try { savedColor = localStorage.getItem('iep_color') || savedColor; } catch (_) { /* ignoré */ }
    setColor(/^#[0-9a-f]{6}$/i.test(savedColor) ? savedColor : '#e74c3c');
    setSize(8);
    setTool('pen');
    updateUI();
    requestRender();
    checkSavedProject();
})();
