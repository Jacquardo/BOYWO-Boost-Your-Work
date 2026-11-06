/*
 * BOYWO - Smart Copy Tracker : export de l'historique (TXT, Excel .xlsx, PDF)
 * Aucune bibliothèque externe (interdit en Manifest V3) : les trois formats sont générés ici,
 * localement, puis téléchargés via un Blob. Chargé uniquement par outils/smart_copy_tracker.html.
 *
 * API : BOYWOSmartCopyExport.exportAs('txt' | 'xlsx' | 'pdf', clips, duplicateAnalysis)
 */
(function () {
    'use strict';

    const pad = n => String(n).padStart(2, '0');
    const fDate = ts => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
    const fTime = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
    const fStamp = ts => `${fDate(ts)} ${fTime(ts)}`;
    const catLabel = cat => (cat === 'upper' ? 'Tout en majuscules' : 'Majuscules et minuscules');
    const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

    // ---------- Modèle commun ----------
    function buildModel(clips, dup) {
        const sorted = clips.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
        const rows = sorted.map(c => {
            const i = dup.info.get(c.id) || { count: 1, rank: 1 };
            return {
                date: fDate(c.ts), time: fTime(c.ts), cat: catLabel(c.cat), text: c.text, host: c.host || '',
                count: i.count, rank: i.rank, edited: c.editedAt ? fStamp(c.editedAt) : ''
            };
        });
        const groups = dup.groups.map(g => ({
            text: g.clips[0].text, count: g.count,
            first: fStamp(g.clips[0].ts), last: fStamp(g.clips[g.count - 1].ts),
            dates: g.clips.map(c => fStamp(c.ts))
        }));
        return { rows, groups, exportedAt: Date.now(), total: clips.length, groupCount: dup.groupCount, extra: dup.extra };
    }

    // ---------- TXT ----------
    function buildTxt(m) {
        const bar = '='.repeat(60), thin = '-'.repeat(60);
        const out = [
            'SMART COPY TRACKER - Historique du presse-papiers',
            `Exporté le ${fStamp(m.exportedAt)} - ${plural(m.total, 'texte', 'textes')} - ${plural(m.groupCount, 'texte en double', 'textes en double')}`,
            bar, ''
        ];
        m.rows.forEach((r, i) => {
            const meta = [`${r.date} ${r.time}`, r.cat];
            if (r.host) meta.push(`depuis ${r.host}`);
            if (r.count > 1) meta.push(`DOUBLON x${r.count} (copie ${r.rank}/${r.count})`);
            if (r.edited) meta.push(`modifié le ${r.edited}`);
            out.push(`[${i + 1}] ${meta.join(' | ')}`, r.text, '', thin, '');
        });
        if (m.groups.length) {
            out.push('DOUBLONS', bar, '');
            m.groups.forEach(g => {
                out.push(`x${g.count} - ${g.text.length > 80 ? g.text.slice(0, 80).replace(/\s+/g, ' ') + '…' : g.text.replace(/\s+/g, ' ')}`);
                g.dates.forEach(d => out.push(`    - ${d}`));
                out.push('');
            });
        }
        return new TextEncoder().encode('\uFEFF' + out.join('\r\n'));
    }

    // ---------- ZIP minimal (méthode "stored", sans compression) ----------
    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();
    function crc32(u8) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }
    function zip(files) {
        const enc = new TextEncoder();
        const now = new Date();
        const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
        const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
        const chunks = [], central = [];
        let offset = 0;
        for (const f of files) {
            const name = enc.encode(f.name), data = f.data, crc = crc32(data);
            const lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, 0, true);
            lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
            lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
            chunks.push(new Uint8Array(lh.buffer), name, data);

            const ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0, true); ch.setUint16(10, 0, true);
            ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
            ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
            ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
            ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
            central.push(new Uint8Array(ch.buffer), name);
            offset += 30 + name.length + data.length;
        }
        const cdSize = central.reduce((n, u) => n + u.length, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
        end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
        return concat([...chunks, ...central, new Uint8Array(end.buffer)]);
    }
    function concat(parts) {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }

    // ---------- Excel (.xlsx) ----------
    const xmlEsc = s => String(s)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    function sheetXml(header, rows, widths) {
        const cell = (c, r, v, style) => {
            const ref = String.fromCharCode(65 + c) + r;
            if (typeof v === 'number') return `<c r="${ref}" s="3"><v>${v}</v></c>`;
            return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
        };
        let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
            '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
            '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols><sheetData>';
        x += '<row r="1">' + header.map((h, c) => cell(c, 1, h, 1)).join('') + '</row>';
        rows.forEach((row, i) => { x += `<row r="${i + 2}">` + row.map((v, c) => cell(c, i + 2, v, 2)).join('') + '</row>'; });
        return x + '</sheetData></worksheet>';
    }

    function buildXlsx(m) {
        const enc = new TextEncoder();
        const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
        const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
        const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

        const history = sheetXml(
            ['Date', 'Heure', 'Catégorie', 'Texte', 'Source', 'Occurrences', 'Modifié le'],
            m.rows.map(r => [r.date, r.time, r.cat, r.text, r.host, r.count, r.edited]),
            [12, 10, 24, 70, 24, 13, 20]);
        const dups = sheetXml(
            ['Texte', 'Occurrences', 'Première copie', 'Dernière copie', 'Toutes les dates'],
            m.groups.map(g => [g.text, g.count, g.first, g.last, g.dates.join('\n')]),
            [70, 13, 20, 20, 24]);

        const files = [
            ['[Content_Types].xml', head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
                '<Default Extension="xml" ContentType="application/xml"/>' +
                '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
                '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
                '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
                '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
            ['_rels/.rels', head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
            ['xl/workbook.xml', head + `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>` +
                '<sheet name="Historique" sheetId="1" r:id="rId1"/><sheet name="Doublons" sheetId="2" r:id="rId2"/></sheets></workbook>'],
            ['xl/_rels/workbook.xml.rels', head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
                `<Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>` +
                `<Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/></Relationships>`],
            ['xl/styles.xml', head + `<styleSheet xmlns="${NS}">` +
                '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
                '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
                '<fill><patternFill patternType="solid"><fgColor rgb="FF1ABC9C"/><bgColor indexed="64"/></patternFill></fill></fills>' +
                '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
                '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
                '<cellXfs count="4">' +
                '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
                '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
                '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
                '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>' +
                '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
            ['xl/worksheets/sheet1.xml', history],
            ['xl/worksheets/sheet2.xml', dups]
        ].map(([name, xml]) => ({ name, data: enc.encode(xml) }));
        return zip(files);
    }

    // ---------- PDF (Helvetica standard, encodage WinAnsi) ----------
    // Largeurs Helvetica (AFM) des caractères 32 à 126, en 1/1000 d'em.
    const HELV = [
        278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,   // espace ! " # $ % & ' ( ) * + , - . /
        556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,   // 0-9 : ; < = > ?
        1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,  // @ A-O
        667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,   // P-Z [ \ ] ^ _
        333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,   // ` a-o
        556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584         // p-z { | } ~
    ];
    const CP1252_EXTRA = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A,
        '‹': 0x8B, 'Œ': 0x8C, 'Ž': 0x8E, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98,
        '™': 0x99, 'š': 0x9A, '›': 0x9B, 'œ': 0x9C, 'ž': 0x9E, 'Ÿ': 0x9F };

    // Convertit en chaîne "octets" WinAnsi ; les caractères hors Latin-1/cp1252 (emoji, alphabets non latins) deviennent « ? ».
    function toWinAnsi(str) {
        let out = '';
        for (const ch of String(str)) {
            const code = ch.codePointAt(0);
            if (ch === '\n') out += '\n';
            else if (ch === '\t') out += '    ';
            else if (code < 32 || code === 127) out += ' ';
            else if (code < 127 || (code >= 0xA0 && code <= 0xFF)) out += String.fromCharCode(code);
            else if (CP1252_EXTRA[ch]) out += String.fromCharCode(CP1252_EXTRA[ch]);
            else out += '?';
        }
        return out;
    }
    function charW(c) {
        const code = c.charCodeAt(0);
        if (code >= 32 && code <= 126) return HELV[code - 32];
        return code >= 0xC0 && code <= 0xDF ? 667 : 556;
    }
    const textW = (s, size) => { let w = 0; for (let i = 0; i < s.length; i++) w += charW(s[i]); return w * size / 1000; };
    const pdfEsc = s => s.replace(/[\\()]/g, '\\$&');

    function wrapText(text, maxW, size) {
        const lines = [];
        for (const para of text.split('\n')) {
            if (para === '') { lines.push(''); continue; }
            let cur = '';
            for (const word of para.split(' ')) {
                const trial = cur === '' ? word : cur + ' ' + word;
                if (textW(trial, size) <= maxW) { cur = trial; continue; }
                if (cur !== '') { lines.push(cur); cur = ''; }
                if (textW(word, size) <= maxW) { cur = word; continue; }
                let chunk = '';
                for (const ch of word) {
                    if (textW(chunk + ch, size) > maxW) { lines.push(chunk); chunk = ch; } else chunk += ch;
                }
                cur = chunk;
            }
            lines.push(cur);
        }
        return lines;
    }

    function buildPdf(m) {
        const PW = 595.28, PH = 841.89, MARGIN = 42, W = PW - 2 * MARGIN;
        const pages = [[]];
        let y = PH - MARGIN;
        const page = () => pages[pages.length - 1];
        const newPage = () => { pages.push([]); y = PH - MARGIN; };
        const need = h => { if (y - h < MARGIN + 18) newPage(); };
        const put = (font, size, gray, str, x = MARGIN) =>
            page().push(`BT /${font} ${size} Tf ${gray} g ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfEsc(str)}) Tj ET`);
        const rule = (gray) => page().push(`${gray} G 0.5 w ${MARGIN} ${y.toFixed(2)} m ${(PW - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`);

        y -= 18; put('F2', 18, 0, toWinAnsi('Smart Copy Tracker'));
        y -= 15; put('F1', 9, 0.35, toWinAnsi(`Historique du presse-papiers - exporté le ${fStamp(m.exportedAt)}`));
        y -= 12; put('F1', 9, 0.35, toWinAnsi(`${plural(m.total, 'texte', 'textes')} - ${plural(m.groupCount, 'texte en double', 'textes en double')}`));
        y -= 10; rule(0.8); y -= 6;

        m.rows.forEach((r) => {
            const meta = [`${r.date} ${r.time}`, r.cat];
            if (r.host) meta.push(`depuis ${r.host}`);
            if (r.count > 1) meta.push(`DOUBLON x${r.count} (copie ${r.rank}/${r.count})`);
            if (r.edited) meta.push(`modifié le ${r.edited}`);
            const metaLines = wrapText(toWinAnsi(meta.join('  |  ')), W, 8.5);
            const lines = wrapText(toWinAnsi(r.text), W, 10);

            need(metaLines.length * 11 + 14 + 12);
            y -= 6;
            metaLines.forEach(l => { y -= 11; put('F2', 8.5, r.count > 1 ? 0.65 : 0.3, l); });
            y -= 2;
            lines.forEach(l => { need(13); y -= 13; put('F1', 10, 0, l); });
            y -= 8; need(2); rule(0.88);
        });

        if (m.groups.length) {
            need(60); y -= 22; put('F2', 13, 0, 'Doublons'); y -= 6;
            m.groups.forEach(g => {
                const head = wrapText(toWinAnsi(`x${g.count} - ${g.text.replace(/\s+/g, ' ')}`), W, 9.5).slice(0, 2);
                need(head.length * 12 + g.dates.length * 11 + 8);
                y -= 4;
                head.forEach(l => { y -= 12; put('F2', 9.5, 0, l); });
                g.dates.forEach(d => { need(11); y -= 11; put('F1', 8.5, 0.35, d, MARGIN + 12); });
            });
        }

        // Pied de page (numérotation)
        pages.forEach((ops, i) => {
            ops.push(`BT /F1 8 Tf 0.5 g ${(PW / 2 - 25).toFixed(2)} 24 Td (Page ${i + 1} / ${pages.length}) Tj ET`);
        });

        const objs = [];
        const n = pages.length;
        objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
        objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + 2 * i} 0 R`).join(' ')}] /Count ${n} >>`;
        objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
        objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
        pages.forEach((ops, i) => {
            const stream = ops.join('\n');
            objs[5 + 2 * i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`;
            objs[6 + 2 * i] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
        });

        let file = '%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n';
        const offsets = [];
        for (let i = 1; i < objs.length; i++) {
            offsets[i] = file.length;
            file += `${i} 0 obj\n${objs[i]}\nendobj\n`;
        }
        const xref = file.length;
        file += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
        for (let i = 1; i < objs.length; i++) file += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
        file += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

        const bytes = new Uint8Array(file.length);
        for (let i = 0; i < file.length; i++) bytes[i] = file.charCodeAt(i) & 255;
        return bytes;
    }

    // ---------- Téléchargement ----------
    const FORMATS = {
        txt: { ext: 'txt', mime: 'text/plain;charset=utf-8', build: buildTxt },
        xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', build: buildXlsx },
        pdf: { ext: 'pdf', mime: 'application/pdf', build: buildPdf }
    };

    function exportAs(format, clips, dup) {
        const f = FORMATS[format];
        if (!f) throw new Error('Format inconnu : ' + format);
        const model = buildModel(clips, dup);
        const bytes = f.build(model);
        const d = new Date();
        const name = `smart-copy-tracker-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.${f.ext}`;
        const url = URL.createObjectURL(new Blob([bytes], { type: f.mime }));
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return name;
    }

    window.BOYWOSmartCopyExport = { exportAs, _internals: { buildModel, buildTxt, buildXlsx, buildPdf, HELV_LEN: HELV.length } };
})();
