import { useState, useRef, useCallback, useMemo } from "react";

// ─── SheetJS (Excel) ──────────────────────────────────────────────────────────
async function loadXLSX() {
  if (window.XLSX) return window.XLSX;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
  return window.XLSX;
}
async function excelToText(file) {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
  const lines = [];
  wb.SheetNames.forEach(name => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { skipHidden: true });
    if (csv.replace(/,/g, "").trim()) { lines.push(`=== ${name} ===`); lines.push(csv.slice(0, 6000)); }
  });
  return lines.join("\n");
}

// ─── PDF.js ───────────────────────────────────────────────────────────────────
async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return window.pdfjsLib;
}
async function pdfToPages(file, onProg, sig) {
  const lib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  if (sig?.aborted) throw new DOMException("Aborted", "AbortError");
  const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
  const n = pdf.numPages;
  const MAX_DIM = 2000;
  const pages = [];
  for (let i = 1; i <= n; i++) {
    if (sig?.aborted) throw new DOMException("Aborted", "AbortError");
    const page = await pdf.getPage(i);

    // ── Text extraction with layout reconstruction ──
    let pageText = null;
    let isTextRich = false;
    try {
      const tc = await page.getTextContent();
      if (tc.items.length > 0) {
        // Group items into lines by Y coordinate (PDF coordinate system: Y increases upward)
        const LINE_TOL = 4;
        const buckets = new Map();
        for (const item of tc.items) {
          if (!item.str) continue;
          const yKey = Math.round(item.transform[5] / LINE_TOL);
          if (!buckets.has(yKey)) buckets.set(yKey, []);
          buckets.get(yKey).push({ x: item.transform[4], str: item.str });
        }
        // Sort lines top-to-bottom (higher Y = higher on page in PDF coords)
        const sortedLines = [...buckets.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([, items]) => {
            items.sort((a, b) => a.x - b.x);
            return items.map(it => it.str).join("").replace(/\s{2,}/g, " ").trim();
          })
          .filter(l => l.length > 0);
        const reconstructed = sortedLines.join("\n");
        if (reconstructed.length > 20) {
          pageText = reconstructed.slice(0, 8000);
          isTextRich = reconstructed.length > 150;
        }
      }
    } catch { /* ignore */ }

    // ── Image rendering ──
    // Scans (no text layer) get higher quality; text-rich pages rely more on text
    const vp0 = page.getViewport({ scale: 1 });
    const sc = Math.min(MAX_DIM / vp0.width, MAX_DIM / vp0.height, 2.0);
    const vp = page.getViewport({ scale: sc });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    // Scans / technical drawings (no text layer) → PNG lossless to preserve dimensions & small numbers
    // Text-rich pages → JPEG is fine, text layer carries the precision
    let b64, mediaType;
    if (!isTextRich) {
      const pngB64 = canvas.toDataURL("image/png").split(",")[1];
      if (pngB64.length * 0.75 <= 4e6) {
        b64 = pngB64; mediaType = "image/png";
      } else {
        // PNG too large — fallback to high-quality JPEG
        let q = 0.88;
        b64 = canvas.toDataURL("image/jpeg", q).split(",")[1];
        while (b64.length * 0.75 > 4e6 && q > 0.25) { q -= 0.07; b64 = canvas.toDataURL("image/jpeg", q).split(",")[1]; }
        mediaType = "image/jpeg";
      }
    } else {
      let q = 0.78;
      b64 = canvas.toDataURL("image/jpeg", q).split(",")[1];
      while (b64.length * 0.75 > 4e6 && q > 0.25) { q -= 0.07; b64 = canvas.toDataURL("image/jpeg", q).split(",")[1]; }
      mediaType = "image/jpeg";
    }

    const previewCanvas = document.createElement("canvas");
    const pr = Math.min(400 / canvas.width, 300 / canvas.height, 1);
    previewCanvas.width = Math.round(canvas.width * pr); previewCanvas.height = Math.round(canvas.height * pr);
    previewCanvas.getContext("2d").drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
    const preview = previewCanvas.toDataURL("image/jpeg", 0.7);

    pages.push({ b64, preview, mediaType, text: pageText, _textRich: isTextRich });
    onProg?.(Math.round(i / n * 100));
  }
  return { pages, type: "pdf", filename: file.name };
}

async function imageToB64(file, onProg, sig) {
  return new Promise((res, rej) => {
    if (sig?.aborted) { rej(new DOMException("Aborted", "AbortError")); return; }
    sig?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")), { once: true });
    const reader = new FileReader();
    reader.onerror = () => rej(new Error("read"));
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => rej(new Error("decode"));
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          let { width: w, height: h } = img; const max = 1024;
          if (w > max || h > max) { const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          let qq = 0.72, b64 = canvas.toDataURL("image/jpeg", qq).split(",")[1];
          while (b64.length * 0.75 > 2.5e6 && qq > 0.3) { qq -= 0.1; b64 = canvas.toDataURL("image/jpeg", qq).split(",")[1]; }
          const preview = canvas.toDataURL("image/jpeg", 0.75);
          onProg?.(100);
          res({ b64, preview, type: "image", filename: file.name, pages: [{ b64, preview }] });
        } catch (err) { rej(err); }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ─── DWG → DXF via libdxfrw WASM ─────────────────────────────────────────────
let _libdxfrwPromise = null;
async function loadLibdxfrw() {
  if (_libdxfrwPromise) return _libdxfrwPromise;
  _libdxfrwPromise = (async () => {
    if (!window.createModule) {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "/libdxfrw.js";
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    return window.createModule({ locateFile: (f) => "/" + f });
  })();
  return _libdxfrwPromise;
}

async function dwgLoadDatabase(file) {
  const lib = await loadLibdxfrw();
  const buf = await file.arrayBuffer();
  const database = new lib.DRW_Database();
  const handler = new lib.DRW_FileHandler();
  handler.database = database;
  const ok = handler.fileImport(buf, database, false, false);
  if (!ok) { database.delete(); handler.delete(); throw new Error("libdxfrw: не вдалось прочитати DWG"); }
  return { lib, database, handler };
}

async function dwgToDxfText(file) {
  const { lib, database, handler } = await dwgLoadDatabase(file);
  const dxf = handler.fileExport(lib.DRW_Version.AC1021, false, database, false);
  database.delete();
  handler.delete();
  return dxf;
}

async function dwgRenderToCanvas(file) {
  const { lib, database, handler } = await dwgLoadDatabase(file).catch(e => { console.warn(`[DWG render load] ${file.name}: ${e.message}`, e); throw e; });
  try {
    const mBlock = database.mBlock;
    if (!mBlock) throw new Error("mBlock not found");
    const entities = mBlock.entities;
    const ET = lib.DRW_ETYPE;

    // Safe enum values for entity types that may not exist in all builds
    const EV = {
      LINE:       ET.LINE?.value       ?? -1,
      ARC:        ET.ARC?.value        ?? -2,
      CIRCLE:     ET.CIRCLE?.value     ?? -3,
      LWPOLYLINE: ET.LWPOLYLINE?.value ?? -4,
      POLYLINE:   ET.POLYLINE?.value   ?? -5,
      SPLINE:     ET.SPLINE?.value     ?? -6,
      TEXT:       ET.TEXT?.value       ?? -7,
      MTEXT:      ET.MTEXT?.value      ?? -8,
      DIMENSION:  ET.DIMENSION?.value  ?? -9,
    };

    // Layer → color heuristic
    const layerColor = name => {
      const n = (name || "").toLowerCase();
      if (/wall|стін|перег|кімн|кімната|room/.test(n)) return "#111";
      if (/dim|розмір|размер|measure|quote/.test(n)) return "#2471a3";
      if (/furn|мебл|мебель|меблі/.test(n)) return "#7d3c98";
      if (/door|двер|окн|вікн|window/.test(n)) return "#555";
      if (/text|надп|label|annot/.test(n)) return "#333";
      if (/axis|вісь|ось|grid/.test(n)) return "#aaa";
      return "#222";
    };

    const n = entities.size();

    // Bounding box — include all entity types
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const expand = (x, y) => {
      if (isFinite(x) && isFinite(y)) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    };
    for (let i = 0; i < n; i++) {
      try {
        const e = entities.get(i); const t = e.eType.value;
        if (t === EV.LINE) { expand(e.basePoint.x, e.basePoint.y); expand(e.secPoint.x, e.secPoint.y); }
        else if (t === EV.ARC || t === EV.CIRCLE) { expand(e.basePoint.x - e.radius, e.basePoint.y - e.radius); expand(e.basePoint.x + e.radius, e.basePoint.y + e.radius); }
        else if (t === EV.LWPOLYLINE) { const vl = e.getVertexList(); for (let j = 0; j < vl.size(); j++) { const v = vl.get(j); expand(v.x, v.y); } }
        else if (t === EV.POLYLINE) { const vl = e.getVertexList(); for (let j = 0; j < vl.size(); j++) { expand(vl.get(j).basePoint.x, vl.get(j).basePoint.y); } }
        else if (t === EV.SPLINE) { try { const cp = e.getControlList(); for (let j = 0; j < cp.size(); j++) { expand(cp.get(j).x, cp.get(j).y); } } catch {} }
        else if (t === EV.TEXT || t === EV.MTEXT) { try { expand(e.basePoint.x, e.basePoint.y); } catch {} }
        else if (t === EV.DIMENSION) { try { expand(e.basePoint.x, e.basePoint.y); try { expand(e.defPoint.x, e.defPoint.y); } catch {} try { expand(e.textPoint.x, e.textPoint.y); } catch {} } catch {} }
      } catch {}
    }

    if (!isFinite(minX)) throw new Error("No renderable geometry");

    const W = 2048, H = 2048, PAD = 56;
    const dw = maxX - minX || 1, dh = maxY - minY || 1;
    const scale = Math.min((W - PAD * 2) / dw, (H - PAD * 2) / dh);
    const tx = x => PAD + (x - minX) * scale;
    const ty = y => H - PAD - (y - minY) * scale;

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, W, H);

    // Draw pass 1 — geometry (lines, arcs, polylines, splines)
    for (let i = 0; i < n; i++) {
      try {
        const e = entities.get(i); const t = e.eType.value;
        let layer = ""; try { layer = e.layer || ""; } catch {}
        ctx.strokeStyle = layerColor(layer);
        ctx.lineWidth = /wall|стін|перег/.test((layer || "").toLowerCase()) ? 2 : 1;
        ctx.beginPath();

        if (t === EV.LINE) {
          ctx.moveTo(tx(e.basePoint.x), ty(e.basePoint.y));
          ctx.lineTo(tx(e.secPoint.x), ty(e.secPoint.y));
          ctx.stroke();
        } else if (t === EV.CIRCLE) {
          ctx.arc(tx(e.basePoint.x), ty(e.basePoint.y), e.radius * scale, 0, Math.PI * 2);
          ctx.stroke();
        } else if (t === EV.ARC) {
          const cx = tx(e.basePoint.x), cy = ty(e.basePoint.y), r = e.radius * scale;
          ctx.arc(cx, cy, r, -e.startAngle * Math.PI / 180, -e.endAngle * Math.PI / 180, true);
          ctx.stroke();
        } else if (t === EV.LWPOLYLINE) {
          const vl = e.getVertexList(); const sz = vl.size();
          if (sz === 0) continue;
          const closed = (e.flags & 1) !== 0;
          ctx.moveTo(tx(vl.get(0).x), ty(vl.get(0).y));
          for (let j = 0; j < sz; j++) {
            const v = vl.get(j), vn = vl.get((j + 1) % sz);
            if (!vn || (!closed && j === sz - 1)) continue;
            if (v.bulge !== 0) {
              const x1 = tx(v.x), y1 = ty(v.y), x2 = tx(vn.x), y2 = ty(vn.y);
              const b = v.bulge, d = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
              const r = Math.abs(d * (b * b + 1) / (4 * Math.abs(b)));
              const a = Math.atan2(y2 - y1, x2 - x1) - Math.PI / 2 * Math.sign(b);
              const mx = (x1 + x2) / 2 + (r - d * Math.abs(b) / 2) * Math.cos(a) * Math.sign(b);
              const my = (y1 + y2) / 2 + (r - d * Math.abs(b) / 2) * Math.sin(a) * Math.sign(b);
              ctx.arc(mx, my, r, Math.atan2(y1 - my, x1 - mx), Math.atan2(y2 - my, x2 - mx), b < 0);
            } else { ctx.lineTo(tx(vn.x), ty(vn.y)); }
          }
          if (closed) ctx.closePath();
          ctx.stroke();
        } else if (t === EV.POLYLINE) {
          const vl = e.getVertexList(); const sz = vl.size();
          if (sz === 0) continue;
          ctx.moveTo(tx(vl.get(0).basePoint.x), ty(vl.get(0).basePoint.y));
          for (let j = 1; j < sz; j++) ctx.lineTo(tx(vl.get(j).basePoint.x), ty(vl.get(j).basePoint.y));
          if (e.flags & 1) ctx.closePath();
          ctx.stroke();
        } else if (t === EV.SPLINE) {
          try {
            const cp = e.getControlList(); const sz = cp.size();
            if (sz >= 2) {
              ctx.moveTo(tx(cp.get(0).x), ty(cp.get(0).y));
              for (let j = 1; j < sz; j++) ctx.lineTo(tx(cp.get(j).x), ty(cp.get(j).y));
              ctx.stroke();
            }
          } catch {}
        } else if (t === EV.DIMENSION) {
          try {
            ctx.strokeStyle = "#2471a3";
            ctx.lineWidth = 1;
            // dimension line: basePoint → defPoint
            const bx = tx(e.basePoint.x), by = ty(e.basePoint.y);
            let dx = bx, dy = by;
            try { dx = tx(e.defPoint.x); dy = ty(e.defPoint.y); } catch {}
            ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(dx, dy); ctx.stroke();
            // arrows at endpoints
            const drawArrow = (x1, y1, x2, y2) => {
              const angle = Math.atan2(y2 - y1, x2 - x1);
              const aLen = 8;
              ctx.beginPath();
              ctx.moveTo(x1, y1);
              ctx.lineTo(x1 + aLen * Math.cos(angle + 2.8), y1 + aLen * Math.sin(angle + 2.8));
              ctx.moveTo(x1, y1);
              ctx.lineTo(x1 + aLen * Math.cos(angle - 2.8), y1 + aLen * Math.sin(angle - 2.8));
              ctx.stroke();
            };
            drawArrow(bx, by, dx, dy);
            drawArrow(dx, dy, bx, by);
          } catch {}
        }
      } catch {}
    }

    // Draw pass 2 — text labels and dimension values on top
    for (let i = 0; i < n; i++) {
      try {
        const e = entities.get(i); const t = e.eType.value;
        if (t === EV.TEXT || t === EV.MTEXT) {
          const px = tx(e.basePoint.x), py = ty(e.basePoint.y);
          let txt = ""; try { txt = (e.text || "").replace(/\\[^;]+;/g, "").trim(); } catch {}
          if (!txt) continue;
          const fh = Math.max(9, Math.min((e.height || 200) * scale, 28));
          ctx.font = `${fh}px sans-serif`;
          ctx.fillStyle = "#1a1a1a";
          ctx.fillText(txt.slice(0, 60), px, py);
        } else if (t === EV.DIMENSION) {
          try {
            let txt = ""; try { txt = (e.text || "").replace(/\\[^;]+;/g, "").trim(); } catch {}
            // textPoint is where the dimension value sits; fallback to midpoint of dim line
            let tpx, tpy;
            try { tpx = tx(e.textPoint.x); tpy = ty(e.textPoint.y); } catch {
              tpx = (tx(e.basePoint.x) + (e.defPoint ? tx(e.defPoint.x) : tx(e.basePoint.x))) / 2;
              tpy = (ty(e.basePoint.y) + (e.defPoint ? ty(e.defPoint.y) : ty(e.basePoint.y))) / 2 - 6;
            }
            if (txt) {
              ctx.font = "10px sans-serif";
              ctx.fillStyle = "#2471a3";
              const tw = ctx.measureText(txt).width;
              ctx.fillStyle = "rgba(250,250,250,0.75)";
              ctx.fillRect(tpx - tw / 2 - 2, tpy - 10, tw + 4, 13);
              ctx.fillStyle = "#2471a3";
              ctx.fillText(txt.slice(0, 20), tpx - tw / 2, tpy);
            }
          } catch {}
        }
      } catch {}
    }

    return canvas.toDataURL("image/jpeg", 0.88);
  } finally {
    database.delete();
    handler.delete();
  }
}

async function parseDWGBinary(file) {
  try {
    const dxfText = await dwgToDxfText(file);
    const parsed = parseDXF(dxfText);
    return `=== DWG→DXF: ${file.name} ===\n${parsed}`;
  } catch (e) {
    console.warn(`[DWG text] ${file.name}: ${e.message}`, e);
    const isFormatErr = e.message?.includes("не вдалось прочитати") || e.message?.includes("format");
    const hint = isFormatErr
      ? "Формат DWG не підтримується браузерним парсером. Відкрийте файл в AutoCAD/BricsCAD та збережіть як DXF."
      : `Помилка: ${e.message}`;
    return `=== DWG ФАЙЛ: ${file.name} ===\n⚠️ ${hint}`;
  }
}

function parseDXF(text) {
  const lines = text.split(/\r?\n/);
  const sections = { texts: [], dimensions: [], layers: new Set(), entities: [] };
  let i = 0;
  while (i < lines.length - 1) {
    const code = parseInt((lines[i] || "").trim(), 10);
    const val = (lines[i + 1] || "").trim();
    i += 2;
    if (isNaN(code)) continue;
    if (code === 8) sections.layers.add(val);
    if (code === 1 && val && !val.startsWith("{") && val.length > 1) sections.texts.push(val);
    if (code === 3 && val && val.length > 2) sections.texts.push(val);
    if (code === 42 && parseFloat(val) > 0) sections.dimensions.push(parseFloat(val).toFixed(0));
    if (code === 0 && ["LINE","ARC","CIRCLE","LWPOLYLINE","POLYLINE","SPLINE","INSERT","DIMENSION","TEXT","MTEXT","HATCH"].includes(val)) sections.entities.push(val);
  }
  const entityCounts = {};
  sections.entities.forEach(e => { entityCounts[e] = (entityCounts[e] || 0) + 1; });
  const uniqueTexts = [...new Set(sections.texts)].filter(t => t.trim().length > 0).slice(0, 120);
  const uniqueDims = [...new Set(sections.dimensions)].slice(0, 60);
  const layers = [...sections.layers].filter(l => l && l !== "0").slice(0, 40);
  let out = "=== DXF КРЕСЛЕННЯ ===\n";
  if (layers.length) out += "ШАРИ (" + layers.length + "): " + layers.join(", ") + "\n";
  if (Object.keys(entityCounts).length) out += "ЕЛЕМЕНТИ: " + Object.entries(entityCounts).map(e => e[0] + "x" + e[1]).join(", ") + "\n";
  if (uniqueDims.length) out += "РОЗМІРИ (мм): " + uniqueDims.join(", ") + "\n";
  if (uniqueTexts.length) out += "ПІДПИСИ:\n" + uniqueTexts.map(t => "  • " + t).join("\n") + "\n";
  return out || "[DXF порожній]";
}

// ─── Universal file processor ─────────────────────────────────────────────────
async function processFile(file, onProg, sig) {
  if (!file) return null;
  const nm = file.name.toLowerCase();
  if (nm.endsWith(".dxf")) {
    onProg?.(30);
    try { const text = await file.text(); onProg?.(80); const parsed = parseDXF(text); onProg?.(100); return { pages: [], type: "dxf", filename: file.name, ext: "DXF", textContent: parsed }; }
    catch { onProg?.(100); return { pages: [], type: "dxf", filename: file.name, ext: "DXF", textContent: "[помилка читання DXF]" }; }
  }
  if (nm.endsWith(".dwg")) {
    onProg?.(10);
    const [textResult, canvasResult] = await Promise.allSettled([
      parseDWGBinary(file),
      dwgRenderToCanvas(file),
    ]);
    onProg?.(100);
    const textContent = textResult.status === "fulfilled" ? textResult.value : "[помилка читання DWG]";
    const b64 = canvasResult.status === "fulfilled" ? canvasResult.value?.split(",")[1] : null;
    const pages = b64 ? [{ b64, preview: canvasResult.value }] : [];
    return { pages, type: "dwg", filename: file.name, ext: "DWG", textContent };
  }
  if (nm.endsWith(".xlsx") || nm.endsWith(".xls") || nm.endsWith(".csv")) {
    onProg?.(30);
    try { const text = nm.endsWith(".csv") ? await file.text() : await excelToText(file); onProg?.(100); return { pages: [], type: "excel", filename: file.name, ext: nm.endsWith(".csv") ? "CSV" : "XLSX", textContent: text.slice(0, 12000) }; }
    catch { onProg?.(100); return { pages: [], type: "excel", filename: file.name, ext: "XLSX", textContent: "[помилка читання]" }; }
  }
  if (nm.endsWith(".rtf")) {
    onProg?.(30);
    try {
      const raw = await file.text();
      const text = raw.replace(/\{\*\\[^{}]*\}/g, "").replace(/\\bin\d+ ?/g, "").replace(/\\'[0-9a-fA-F]{2}/g, "").replace(/\\[a-z]+[-]?\d* ?/g, "").replace(/[{}\\]/g, "").replace(/\r?\n{3,}/g, "\n\n").trim();
      onProg?.(100); return { pages: [], type: "text", filename: file.name, ext: "RTF", textContent: (text || "[RTF порожній]").slice(0, 12000) };
    } catch { onProg?.(100); return { pages: [], type: "text", filename: file.name, ext: "RTF", textContent: "[помилка читання RTF]" }; }
  }
  if (nm.endsWith(".txt") || nm.endsWith(".md")) {
    onProg?.(30);
    try { const text = await file.text(); onProg?.(100); return { pages: [], type: "text", filename: file.name, ext: nm.split(".").pop().toUpperCase(), textContent: text.slice(0, 12000) }; }
    catch { onProg?.(100); return { pages: [], type: "text", filename: file.name, ext: "TXT", textContent: "[помилка читання]" }; }
  }
  if (nm.endsWith(".docx") || nm.endsWith(".doc")) {
    onProg?.(20);
    try {
      if (!window.mammoth) {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js";
          s.onload = res; s.onerror = rej; document.head.appendChild(s);
        });
      }
      onProg?.(50);
      const buf = await file.arrayBuffer();
      const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
      onProg?.(100); return { pages: [], type: "text", filename: file.name, ext: "DOCX", textContent: result.value.slice(0, 12000) };
    } catch { onProg?.(100); return { pages: [], type: "other", filename: file.name, ext: "DOCX", textContent: "[не вдалось прочитати DOCX]" }; }
  }
  if (nm.endsWith(".pdf")) return pdfToPages(file, onProg, sig);
  if (file.type.startsWith("image/")) return imageToB64(file, onProg, sig);
  onProg?.(100);
  return { pages: [], type: "other", filename: file.name, ext: file.name.split(".").pop().toUpperCase() };
}

// ─── AI File Classification ───────────────────────────────────────────────────
const FILE_CATEGORIES = ["Планування", "Фасад / розріз", "Стиль / мудборд", "Матеріали та оздоблення", "Меблі та предмети", "ТЗ текстом", "Техвимоги"];
const CATEGORY_COLOR = {
  "Планування": "#2980b9", "Фасад / розріз": "#e67e22", "Стиль / мудборд": "#8e44ad",
  "Матеріали та оздоблення": "#27ae60", "Меблі та предмети": "#16a085",
  "ТЗ текстом": "#2c3e50", "Техвимоги": "#7f8c8d", "Невизначено": "#bbb",
};
const CATEGORY_SHORT = {
  "Планування": "ПЛАН", "Фасад / розріз": "ФАСАД", "Стиль / мудборд": "СТИЛЬ",
  "Матеріали та оздоблення": "МАТЕР.", "Меблі та предмети": "МЕБЛІ",
  "ТЗ текстом": "ТЗ", "Техвимоги": "ТЕХН.", "Невизначено": "?",
};

const PAGE_CATEGORIES = ["Планування", "Фасад / розріз", "Специфікація", "Деталізація", "Легенда / умовні позначення", "Титул / зміст", "Інше"];
const PAGE_CAT_COLOR = {
  "Планування": "#2980b9", "Фасад / розріз": "#e67e22", "Специфікація": "#27ae60",
  "Деталізація": "#8e44ad", "Легенда / умовні позначення": "#16a085",
  "Титул / зміст": "#7f8c8d", "Інше": "#bbb",
};
const PAGE_CAT_SHORT = {
  "Планування": "ПЛАН", "Фасад / розріз": "ФАСАД", "Специфікація": "СПЕЦИФ.",
  "Деталізація": "ДЕТАЛЬ", "Легенда / умовні позначення": "ЛЕГЕНДА",
  "Титул / зміст": "ТИТУЛ", "Інше": "ІНШЕ",
};

async function classifyPageWithAI(b64, pageNum, filename, apiKey) {
  if (!apiKey) return "Інше";
  const cats = PAGE_CATEGORIES.join(", ");
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true", "x-api-key": apiKey },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 60, messages: [{ role: "user", content: [
        { type: "text", text: `Класифікуй сторінку ${pageNum} з файлу "${filename}" для проекту 3D-візуалізації.\nКатегорії: ${cats}.\nВідповідай ТІЛЬКИ JSON: {"category":"..."}` },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
      ] }] }),
    });
    const data = await resp.json();
    const raw = (data.content || []).map(b => b.text || "").join("");
    const m = raw.match(/\{[\s\S]*?\}/);
    if (m) { const p = JSON.parse(m[0]); return PAGE_CATEGORIES.includes(p.category) ? p.category : "Інше"; }
  } catch { /* ignore */ }
  return "Інше";
}

async function classifyPagesWithAI(fileId, pages, filename, updateFn) {
  const apiKey = (() => { try { return localStorage.getItem("anthropic_api_key") || ""; } catch { return ""; } })();
  if (!apiKey || !pages?.length) return;
  const CONCURRENCY = 3;
  const queue = pages.map((pg, i) => ({ pg, i }));
  const run = async ({ pg, i }) => {
    if (!pg.b64) return;
    const category = await classifyPageWithAI(pg.b64, i + 1, filename, apiKey);
    updateFn(fileId, i, { _category: category, _classifying: false });
  };
  // process in parallel with concurrency limit
  for (let s = 0; s < queue.length; s += CONCURRENCY) {
    await Promise.all(queue.slice(s, s + CONCURRENCY).map(run));
  }
}

async function classifyFileWithAI(processedFile) {
  const apiKey = (() => { try { return localStorage.getItem("anthropic_api_key") || ""; } catch { return ""; } })();
  if (!apiKey) return { category: "Невизначено", confidence: "low" };
  const cats = FILE_CATEGORIES.join(", ");
  const parts = [];
  parts.push({ type: "text", text: `Ти класифікатор файлів для проекту 3D-візуалізації інтер'єру/екстер'єру.\nКатегорії: ${cats}.\nФайл: ${processedFile.filename}${processedFile.textContent ? `\nЗміст (уривок):\n${processedFile.textContent.slice(0, 1500)}` : ""}\nВідповідай ТІЛЬКИ JSON без пояснень: {"category":"одна з категорій вище","confidence":"high|medium|low"}` });
  if (processedFile.pages?.[0]?.b64) {
    parts.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: processedFile.pages[0].b64 } });
  }
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true", "x-api-key": apiKey },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 80, messages: [{ role: "user", content: parts }] }),
    });
    const data = await resp.json();
    const raw = (data.content || []).map(b => b.text || "").join("");
    const m = raw.match(/\{[\s\S]*?\}/);
    if (m) { const p = JSON.parse(m[0]); return { category: FILE_CATEGORIES.includes(p.category) ? p.category : "Невизначено", confidence: p.confidence || "low" }; }
  } catch { /* ignore */ }
  return { category: "Невизначено", confidence: "low" };
}

// ─── File list hook ───────────────────────────────────────────────────────────
function useFileList() {
  const ref = useRef([]);
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick(t => t + 1), []);
  const add = useCallback(async (file) => {
    const id = "f" + Date.now() + "_" + Math.random().toString(36).slice(2);
    const ctrl = new AbortController();
    ref.current = [...ref.current, { _id: id, _loading: true, _progress: 0, _ctrl: ctrl, filename: file.name, preview: null, pages: [], type: null }];
    bump();
    try {
      const buf = await file.arrayBuffer();
      const fileCopy = new File([buf], file.name, { type: file.type });
      const d = await processFile(fileCopy, pct => { ref.current = ref.current.map(x => x._id === id ? { ...x, _progress: pct } : x); bump(); }, ctrl.signal);
      // Mark pages as selected by default, add _classifying flag to each page
      const pagesWithMeta = (d.pages || []).map(pg => ({ ...pg, _selected: true, _classifying: true, _category: null }));
      const fileWithMeta = { ...d, pages: pagesWithMeta, _id: id, _loading: false, _done: true, _classifying: true };
      ref.current = ref.current.map(x => x._id === id ? fileWithMeta : x);
      bump();

      // Classify file in background
      classifyFileWithAI(d).then(({ category, confidence }) => {
        ref.current = ref.current.map(x => x._id === id ? { ...x, _category: category, _confidence: confidence, _classifying: false } : x);
        bump();
      }).catch(() => {
        ref.current = ref.current.map(x => x._id === id ? { ...x, _category: "Невизначено", _classifying: false } : x);
        bump();
      });

      // Classify individual pages in background (for multi-page files)
      if (pagesWithMeta.length > 1) {
        classifyPagesWithAI(id, pagesWithMeta, d.filename, (fileId, pageIdx, patch) => {
          ref.current = ref.current.map(x => x._id === fileId
            ? { ...x, pages: x.pages.map((pg, i) => i === pageIdx ? { ...pg, ...patch } : pg) }
            : x);
          bump();
        });
      } else if (pagesWithMeta.length === 1) {
        // single page — no need for per-page classification, remove _classifying
        ref.current = ref.current.map(x => x._id === id
          ? { ...x, pages: x.pages.map(pg => ({ ...pg, _classifying: false })) }
          : x);
        bump();
      }
    } catch (e) {
      if (e.name === "AbortError") ref.current = ref.current.filter(x => x._id !== id);
      else ref.current = ref.current.map(x => x._id === id ? { ...x, _loading: false, _error: true } : x);
    }
    bump();
  }, [bump]);
  const remove = useCallback((idx) => { ref.current = ref.current.filter((_, i) => i !== idx); bump(); }, [bump]);
  const updateById = useCallback((id, patch) => { ref.current = ref.current.map(x => x._id === id ? { ...x, ...patch } : x); bump(); }, [bump]);
  return { files: ref.current, ref, add, remove, updateById };
}

// ─── Page Gallery ─────────────────────────────────────────────────────────────
function PageGallery({ file, onClose, onTogglePage, onSetPageCategory }) {
  const [filter, setFilter] = useState("all");
  const [textPage, setTextPage] = useState(null); // index of page whose text to show
  const pages = file.pages || [];
  const selectedCount = pages.filter(p => p._selected !== false).length;
  const textCount = pages.filter(p => p.text).length;
  const categories = [...new Set(pages.map(p => p._category).filter(Boolean))];

  const filtered = filter === "all" ? pages : pages.filter(p => p._category === filter);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 1000, display: "flex", flexDirection: "column" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      {/* Header */}
      <div style={{ background: "#1a1a1a", padding: "12px 20px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#f2f0ec", fontFamily: "monospace", letterSpacing: "0.1em" }}>{file.filename}</div>
          <div style={{ fontSize: 9, color: "#666", fontFamily: "monospace", display: "flex", gap: 10 }}>
            <span>{pages.length} сторінок · {selectedCount} вибрано</span>
            {textCount > 0 && <span style={{ color: "#2ecc71" }}>T {textCount} з текстом</span>}
            {textCount === 0 && <span style={{ color: "#e67e22" }}>скан — тільки зображення</span>}
          </div>
        </div>
        {/* Filter buttons */}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <button onClick={() => setFilter("all")} style={{ fontSize: 8, fontFamily: "monospace", padding: "3px 8px", borderRadius: 3, border: "none", cursor: "pointer", background: filter === "all" ? "#fff" : "#333", color: filter === "all" ? "#000" : "#aaa" }}>ВСІ</button>
          {categories.map(cat => (
            <button key={cat} onClick={() => setFilter(cat)} style={{ fontSize: 8, fontFamily: "monospace", padding: "3px 8px", borderRadius: 3, border: "none", cursor: "pointer", background: filter === cat ? (PAGE_CAT_COLOR[cat] || "#555") : "#333", color: "#fff" }}>
              {PAGE_CAT_SHORT[cat] || cat}
            </button>
          ))}
        </div>
        {/* Select/deselect all */}
        <button onClick={() => pages.forEach((_, i) => onTogglePage(i, true))} style={{ fontSize: 9, fontFamily: "monospace", padding: "4px 10px", background: "#2ecc71", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}>Всі ✓</button>
        <button onClick={() => pages.forEach((_, i) => onTogglePage(i, false))} style={{ fontSize: 9, fontFamily: "monospace", padding: "4px 10px", background: "#444", color: "#aaa", border: "none", borderRadius: 4, cursor: "pointer" }}>Зняти всі</button>
        <button onClick={() => {
          pages.forEach((pg, i) => onTogglePage(i, pg._category !== "Титул / зміст" && pg._category !== "Інше"));
        }} style={{ fontSize: 9, fontFamily: "monospace", padding: "4px 10px", background: "#2980b9", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}>Авто-вибір</button>
        <button onClick={onClose} style={{ fontSize: 14, background: "transparent", border: "none", color: "#888", cursor: "pointer", padding: "0 4px" }}>✕</button>
      </div>

      {/* Content: grid + optional text panel */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
            {filtered.map((pg) => {
            const globalIdx = pages.indexOf(pg);
            const selected = pg._selected !== false;
            const cat = pg._category;
            const catColor = PAGE_CAT_COLOR[cat] || "#555";
            const isTextActive = textPage === globalIdx;
            return (
              <div key={globalIdx} onClick={() => onTogglePage(globalIdx, !selected)}
                style={{ cursor: "pointer", borderRadius: 8, overflow: "hidden", border: `2px solid ${isTextActive ? "#f39c12" : selected ? catColor : "#333"}`, background: selected ? "#fff" : "#1a1a1a", transition: "border-color 0.15s", position: "relative" }}>
                {/* Page image */}
                <div style={{ position: "relative", paddingBottom: "141%", background: "#f0f0f0" }}>
                  {pg.preview
                    ? <img src={pg.preview} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#fff" }} />
                    : <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, color: "#ccc" }}>📄</div>
                  }
                  {/* Selection checkbox */}
                  <div style={{ position: "absolute", top: 6, right: 6, width: 18, height: 18, borderRadius: 4, background: selected ? catColor : "rgba(0,0,0,0.4)", border: `2px solid ${selected ? catColor : "#888"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff" }}>
                    {selected ? "✓" : ""}
                  </div>
                  {/* Text layer indicator */}
                  {pg.text && (
                    <button onClick={e => { e.stopPropagation(); setTextPage(isTextActive ? null : globalIdx); }}
                      title="Переглянути витягнутий текст"
                      style={{ position: "absolute", top: 6, left: 6, background: isTextActive ? "#f39c12" : "rgba(0,0,0,0.55)", border: "none", borderRadius: 3, color: "#fff", fontSize: 8, fontFamily: "monospace", fontWeight: 700, padding: "2px 5px", cursor: "pointer", letterSpacing: "0.05em" }}>
                      T
                    </button>
                  )}
                  {/* Page number */}
                  <div style={{ position: "absolute", bottom: 4, left: 6, fontSize: 9, fontFamily: "monospace", color: "#fff", background: "rgba(0,0,0,0.5)", padding: "1px 4px", borderRadius: 2 }}>
                    {globalIdx + 1}
                  </div>
                </div>
                {/* Category badge */}
                <div style={{ padding: "5px 8px", display: "flex", alignItems: "center", gap: 4, background: selected ? "#fafafa" : "#222" }}>
                  {pg._classifying
                    ? <div style={{ fontSize: 8, color: "#bbb", fontFamily: "monospace", animation: "pulse 1s infinite" }}>класифікую…</div>
                    : <>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: catColor, flexShrink: 0 }} />
                        <select
                          value={cat || "Інше"}
                          onChange={e => { e.stopPropagation(); onSetPageCategory(globalIdx, e.target.value); }}
                          onClick={e => e.stopPropagation()}
                          style={{ fontSize: 8, fontFamily: "monospace", border: "none", background: "transparent", color: selected ? "#333" : "#aaa", cursor: "pointer", flex: 1, outline: "none" }}>
                          {PAGE_CATEGORIES.map(c => <option key={c} value={c}>{PAGE_CAT_SHORT[c] || c}</option>)}
                        </select>
                      </>
                  }
                </div>
              </div>
            );
          })}
          </div>
        </div>

        {/* Text preview panel */}
        {textPage !== null && pages[textPage] && (
          <div style={{ width: 320, background: "#0f0f0f", borderLeft: "1px solid #2a2a2a", display: "flex", flexDirection: "column", flexShrink: 0 }}>
            <div style={{ padding: "10px 14px", borderBottom: "1px solid #222", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#f39c12", fontWeight: 700 }}>ТЕКСТ</span>
              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#555" }}>стор. {textPage + 1}</span>
              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#444", flex: 1, textAlign: "right" }}>
                {pages[textPage].text ? `${pages[textPage].text.length} симв.` : ""}
              </span>
              <button onClick={() => setTextPage(null)} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
              {pages[textPage].text
                ? <pre style={{ fontSize: 10, color: "#bbb", fontFamily: "monospace", whiteSpace: "pre-wrap", lineHeight: 1.7, margin: 0 }}>{pages[textPage].text}</pre>
                : <div style={{ fontSize: 10, color: "#555", fontFamily: "monospace" }}>Текстовий шар відсутній — сторінка є скан або зображення.</div>
              }
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ background: "#1a1a1a", padding: "10px 20px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <div style={{ fontSize: 10, color: "#888", fontFamily: "monospace", flex: 1 }}>
          Вибрано <strong style={{ color: "#f2f0ec" }}>{selectedCount}</strong> з {pages.length} сторінок для відправки Claude
          {textCount > 0 && <span style={{ color: "#2ecc71", marginLeft: 8 }}>· {textCount} з текстом</span>}
        </div>
        <button onClick={onClose} style={{ fontSize: 11, fontFamily: "monospace", padding: "8px 20px", background: "#f2f0ec", color: "#1a1a1a", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 700 }}>
          Підтвердити вибір →
        </button>
      </div>
    </div>
  );
}

let _dragging = null;

// ─── Upload Box ───────────────────────────────────────────────────────────────
function UploadBox({ label, files, onAdd, onRemove, onUpdateFile, color = "#888", note }) {
  const inputRef = useRef(); const [drag, setDrag] = useState(false); const ctr = useRef(0);
  const [galleryFile, setGalleryFile] = useState(null);
  const onDrop = e => {
    e.preventDefault(); setDrag(false); ctr.current = 0;
    if (_dragging) { _dragging.remove(); _dragging = null; }
    else { Array.from(e.dataTransfer.files).forEach(onAdd); }
  };
  const ico = { pdf: "📄", dwg: "📐", dxf: "📐", excel: "📊", text: "📝", image: "🖼️", other: "📎" };
  return (
    <div>
      {label && <div style={{ fontSize: 10, letterSpacing: "0.14em", color: "#888", marginBottom: note ? 2 : 5, fontFamily: "monospace" }}>{label}</div>}
      {note && <div style={{ fontSize: 9, color: "#bbb", fontFamily: "monospace", marginBottom: 5 }}>{note}</div>}
      <div onDragEnter={e => { e.preventDefault(); ctr.current++; setDrag(true); }} onDragLeave={e => { e.preventDefault(); if (--ctr.current === 0) setDrag(false); }} onDragOver={e => e.preventDefault()} onDrop={onDrop}
        style={{ border: `2px dashed ${drag ? color : "#ddd"}`, borderRadius: 10, padding: 8, background: drag ? color + "11" : "#fafafa", minHeight: 90, display: "flex", flexDirection: "column", justifyContent: files.length === 0 ? "center" : "flex-start" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", justifyContent: files.length === 0 ? "center" : "flex-start" }}>
          {files.map((f, i) => {
            const prev = f.preview || f.pages?.[0]?.preview;
            const textFailed = f.textContent?.includes("не вдалась") || f.textContent?.includes("помилка читання");
            const hasWarning = f._done && !f._error && textFailed && !f.pages?.length;
            const statusColor = f._error ? "#e74c3c" : hasWarning ? "#e67e22" : f._done ? "#27ae60" : "#ddd";
            return (
              <div key={f._id || i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, flexShrink: 0 }}>
                <div draggable={!f._loading && f._done} onDragStart={() => { _dragging = { file: f, remove: () => onRemove(i) }; }} onDragEnd={() => { _dragging = null; }}
                  style={{ position: "relative", width: 70, height: 70, cursor: (!f._loading && f._done) ? "grab" : "default" }}>
                  {prev && f.type !== "excel"
                    ? <img src={prev} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 5, border: `1px solid ${statusColor}`, filter: f._loading ? "brightness(0.4)" : "none" }} />
                    : <div style={{ width: "100%", height: "100%", borderRadius: 5, border: `1px solid ${statusColor}`, background: f._error ? "#3a1a1a" : f.type === "dwg" ? "#0a1929" : f.type === "excel" ? "#0d2b0d" : "#f0eeea", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2 }}>
                        <div style={{ fontSize: 18 }}>{f._error ? "⚠️" : hasWarning ? "⚠️" : ico[f.type] || ico.other}</div>
                        <div style={{ fontSize: 7, color: f._error ? "#ff8888" : hasWarning ? "#e67e22" : "#888", fontFamily: "monospace", textAlign: "center", padding: "0 3px", wordBreak: "break-all", lineHeight: 1.2 }}>{f._error ? "ERR" : hasWarning ? "→DXF" : (f.ext || f.type?.toUpperCase() || "...")}</div>
                      </div>}
                  {f._loading && (
                    <div style={{ position: "absolute", inset: 0, borderRadius: 5, background: "rgba(0,0,0,0.7)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                      <svg width="30" height="30" style={{ transform: "rotate(-90deg)" }}>
                        <circle cx="15" cy="15" r="11" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="2.5" />
                        <circle cx="15" cy="15" r="11" fill="none" stroke="#fff" strokeWidth="2.5" strokeDasharray={`${2 * Math.PI * 11}`} strokeDashoffset={`${2 * Math.PI * 11 * (1 - (f._progress || 0) / 100)}`} strokeLinecap="round" />
                      </svg>
                      <div style={{ fontSize: 8, color: "#fff", fontFamily: "monospace" }}>{f._progress || 0}%</div>
                      <button onPointerDown={e => { e.stopPropagation(); f._ctrl?.abort(); }} style={{ marginTop: 2, background: "#e74c3c", border: "none", borderRadius: 3, color: "#fff", fontSize: 8, padding: "2px 5px", cursor: "pointer" }}>✕</button>
                    </div>
                  )}
                  {!f._loading && f._done && <div style={{ position: "absolute", top: -5, left: -5, width: 15, height: 15, background: statusColor, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "#fff" }}>{f._error || hasWarning ? "!" : "✓"}</div>}
                  {!f._loading && f.pages?.length > 1 && (() => {
                    const sel = f.pages.filter(p => p._selected !== false).length;
                    const total = f.pages.length;
                    return (
                      <div onClick={e => { e.stopPropagation(); setGalleryFile(f); }}
                        style={{ position: "absolute", bottom: 2, left: 2, background: sel < total ? "#e67e22" : "#333", color: "#fff", fontSize: 7, fontFamily: "monospace", padding: "1px 4px", borderRadius: 2, cursor: "pointer" }}>
                        {sel}/{total}с
                      </div>
                    );
                  })()}
                  {!f._loading && <button onClick={() => onRemove(i)} style={{ position: "absolute", top: -5, right: -5, width: 16, height: 16, background: "#e74c3c", color: "#fff", border: "none", borderRadius: "50%", cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>}
                </div>
                {/* Category badge */}
                {f._classifying && <div style={{ fontSize: 7, color: "#bbb", fontFamily: "monospace", animation: "pulse 1s infinite" }}>…</div>}
                {!f._classifying && f._category && (
                  <div style={{ fontSize: 7, fontFamily: "monospace", fontWeight: 700, color: "#fff", background: CATEGORY_COLOR[f._category] || "#999", padding: "2px 5px", borderRadius: 3, letterSpacing: "0.05em", maxWidth: 70, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={f._category}>
                    {CATEGORY_SHORT[f._category] || f._category}
                    {f._confidence === "low" && <span style={{ opacity: 0.6 }}>?</span>}
                  </div>
                )}
                {!f._loading && f.type === "pdf" && f.pages?.length > 0 && (() => {
                  const textPages = f.pages.filter(p => p.text).length;
                  const total = f.pages.length;
                  return (
                    <div style={{ fontSize: 7, fontFamily: "monospace", color: textPages > 0 ? "#27ae60" : "#e67e22", background: textPages > 0 ? "#f0fff4" : "#fff8f0", border: `1px solid ${textPages > 0 ? "#2ecc7144" : "#e67e2244"}`, padding: "1px 4px", borderRadius: 2 }}
                      title={textPages > 0 ? `${textPages} з ${total} сторінок мають текстовий шар` : "Скан — тільки зображення"}>
                      {textPages > 0 ? `T ${textPages}/${total}` : "скан"}
                    </div>
                  );
                })()}
              </div>
            );
          })}
          <div onClick={() => inputRef.current.click()} style={{ width: 70, height: 70, border: `2px dashed ${color}`, borderRadius: 8, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
            <div style={{ fontSize: 20, color }}>+</div>
            <div style={{ fontSize: 8, color: "#bbb", fontFamily: "monospace" }}>додати</div>
          </div>
        </div>
        {!drag && <div style={{ fontSize: 8, color: "#ccc", fontFamily: "monospace", textAlign: "center", marginTop: 4 }}>↑ або перетягніть</div>}
      </div>
      <input ref={inputRef} type="file" accept="*/*" multiple style={{ display: "none" }} onChange={e => { Array.from(e.target.files).forEach(onAdd); e.target.value = ""; }} />
      {galleryFile && onUpdateFile && (
        <PageGallery
          file={galleryFile}
          onClose={() => setGalleryFile(null)}
          onTogglePage={(pageIdx, selected) => {
            const updated = { ...galleryFile, pages: galleryFile.pages.map((pg, i) => i === pageIdx ? { ...pg, _selected: selected } : pg) };
            setGalleryFile(updated);
            onUpdateFile(galleryFile._id, { pages: updated.pages });
          }}
          onSetPageCategory={(pageIdx, category) => {
            const updated = { ...galleryFile, pages: galleryFile.pages.map((pg, i) => i === pageIdx ? { ...pg, _category: category } : pg) };
            setGalleryFile(updated);
            onUpdateFile(galleryFile._id, { pages: updated.pages });
          }}
        />
      )}
    </div>
  );
}

// ─── Claude API ───────────────────────────────────────────────────────────────
async function callAPI(parts, retries = 2, apiKey = "") {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 64000, temperature: 0, messages: [{ role: "user", content: parts }] })
      });
      let data; try { data = await resp.json(); } catch { throw new Error(`HTTP ${resp.status}`); }
      if (!resp.ok) {
        if ((resp.status === 502 || resp.status === 503 || resp.status === 529) && attempt < retries) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue;
        }
        throw new Error(`API ${resp.status}: ${data?.error?.message || ""}`);
      }
      const raw = (data.content || []).map(b => b.text || "").join("");
      if (!raw.trim()) throw new Error("Порожня відповідь");
      const m = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/```\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
      if (!m) throw new Error("JSON не знайдено");
      try { return JSON.parse(m[1]); }
      catch (parseErr) {
        if (attempt < retries) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
        throw new Error(`JSON parse failed: ${parseErr.message}`);
      }
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

function filesToParts(files, fallbackLabel) {
  const parts = [];
  (files || []).forEach((f, fi) => {
    const fileLabel = f._label || `${fallbackLabel} ${fi + 1}`;
    const fullLabel = `${fileLabel} [${f.ext || f.type?.toUpperCase() || "FILE"}: ${f.filename}]`;
    if (f.textContent) {
      parts.push({ type: "text", text: `${fullLabel}:\n${f.textContent}` });
    }
    (f.pages || []).filter(p => p.b64 && p._selected !== false).forEach((pg, pi) => {
      const pageLabel = `${fullLabel}${pi > 0 ? ` стор.${pi + 1}` : ""}`;
      if (pg.text) parts.push({ type: "text", text: `${pageLabel} — витягнутий текст (використовуй для точних розмірів, матеріалів та специфікацій):\n${pg.text}` });
      // Text-rich pages (e.g. TZ docs, specs): skip image — text layer is sufficient
      // Visual pages (scans, moodboards, drawings): always send image
      if (pg._textRich) return;
      if (!f.textContent || f.type === "dwg") {
        parts.push({ type: "text", text: `${pageLabel}:` });
      }
      parts.push({ type: "image", source: { type: "base64", media_type: pg.mediaType || "image/jpeg", data: pg.b64 } });
    });
  });
  return parts;
}

// ─── SOW Templates ────────────────────────────────────────────────────────────
const SOW_TEMPLATES = {
  "Інтер'єр житловий":    [
    "Тип простору (житловий)",
    "Креслення плану з розміщенням меблів (DWG або PDF) — обов'язково",
    "Відбивний план / схема освітлення (RCP)",
    "Настінні розгортки (для просторів з нішами або складним оздобленням)",
    "Ракурси камер / переваги кутів зйомки",
    "Меблі та декор — посилання, бренди, розміри для кожної позиції",
    "Оздоблення підлоги — посилання або фото у хорошій якості",
    "Оздоблення стін — посилання або фото у хорошій якості",
    "Оздоблення стелі — посилання або фото у хорошій якості",
    "Предмети / аксесуари — фото або посилання",
    "Вид з вікна / фон (за замовчуванням обирається за локацією проекту)",
    "Настрій / час доби (день за замовчуванням; вечір або ніч — за запитом)",
    "Референси стилю та атмосфери",
    "Роздільність: 4K / 5K / 8K",
    "Формат файлу: JPEG / PNG / TIFF",
    "DPI: 72 (онлайн) / 300 (друк)",
    "Співвідношення сторін: 16x9 / 9x16 / 4x3",
    "Кількість зображень",
    "Призначення: сайт / соцмережі / презентація / друк",
    "Дедлайн"
  ],
  "Інтер'єр комерційний": [
    "Тип простору (комерційний)",
    "Креслення плану з зонуванням та розміщенням обладнання (DWG або PDF) — обов'язково",
    "Відбивний план / схема освітлення (RCP)",
    "Настінні розгортки (для просторів з нішами або складним оздобленням)",
    "Ракурси камер / переваги кутів зйомки",
    "Концепція бренду / фірмові кольори / гайдлайн",
    "Логотип та написи (вектор або PNG з прозорим фоном)",
    "Меблі та обладнання — посилання, бренди, розміри",
    "Оздоблення підлоги, стін, стелі — посилання або фото",
    "Предмети / аксесуари — фото або посилання",
    "Наявність людей на рендері",
    "Вид з вікна / фон",
    "Настрій / час доби (день за замовчуванням)",
    "Референси стилю та атмосфери",
    "Роздільність: 4K / 5K / 8K",
    "Формат файлу: JPEG / PNG / TIFF",
    "DPI: 72 (онлайн) / 300 (друк)",
    "Співвідношення сторін: 16x9 / 9x16 / 4x3",
    "Кількість зображень",
    "Призначення: сайт / соцмережі / презентація / друк",
    "Дедлайн"
  ],
  "Екстер'єр / фасад":    [
    "Тип об'єкту (житловий / комерційний)",
    "Креслення: плани, фасади, розрізи (DWG або PDF) — обов'язково",
    "CAD-модель (опційно): RVT, SKP, FBX — прискорює проект і знижує вартість",
    "Фото ділянки / фото існуючого об'єкту",
    "Локація проекту (для підбору оточення та неба)",
    "Переваги кутів камер",
    "Матеріали оздоблення фасаду — специфікація або фото з прикладами",
    "Ландшафтний план: тверде покриття, рослинність, розміщення",
    "Настрій / освітлення / сезон (за замовчуванням: літо, день)",
    "Референси з коментарями — що саме взяти з кожного (небо, вода, дорога, трава, люди, матеріали)",
    "Погодні умови та атмосфера",
    "Наявність людей / транспорту на рендері",
    "Роздільність: 4K / 5K / 8K",
    "Формат файлу: JPEG / PNG / TIFF",
    "DPI: 72 (онлайн) / 300 (друк)",
    "Співвідношення сторін: 16x9 / 9x16 / 4x3 / 3x2",
    "Кількість зображень",
    "Призначення: сайт / соцмережі / презентація",
    "Дедлайн"
  ],
  "Лайфстайл рендеринг":  [
    "Тип сцени (інтер'єр / вулиця)",
    "Тип workflow: Our Vision / Your Vision / Template",
    "--- OUR VISION (спрощений бриф) ---",
    "Специфікація 3D-моделей — посилання, бренд, розміри, текстури",
    "Загальні побажання та референси стилю з коментарями що саме взяти",
    "--- YOUR VISION (стандартний бриф) ---",
    "Специфікація 3D-моделей — посилання, бренд, розміри, текстури",
    "Схема розміщення меблів з позначеннями",
    "Специфікація оздоблення: колір стін, шпалери, панелі — посилання",
    "Референс базового зображення з коментарями що додати / прибрати",
    "Декорування: подушки, рослини, аксесуари — посилання або з бібліотеки",
    "--- TEMPLATE (шаблонна сцена) ---",
    "Специфікація 3D-моделей — посилання, бренд, розміри",
    "Вибір шаблонної сцени з бібліотеки",
    "Опис змін до шаблону (до 30%)",
    "--- ЗАГАЛЬНЕ ---",
    "3D-модель продукту: надає клієнт (.3ds) або моделюємо з нуля",
    "Якщо модель від клієнта: відповідність референсам, відсутність дефектів геометрії",
    "Текстури та кольори: фото продукту з усіх сторін + деталі крупним планом",
    "Якщо продукту немає: посилання на матеріали (від 2000x2000px) + HEX-коди",
    "Настрій / час доби (день за замовчуванням; ранок або вечір — за запитом)",
    "Роздільність: 4K / 5K",
    "Формат: JPG / PNG / TIFF",
    "DPI: 72 / 300",
    "Співвідношення сторін: 16x9 / 9x16 / 4x3 / 1x1",
    "Кількість зображень",
    "Дедлайн"
  ],
  "Silo рендеринг":       [
    "3D-модель продукту: надає клієнт (.3ds) або моделюємо з нуля",
    "Якщо модель від клієнта: відповідність референсам, відсутність дефектів геометрії",
    "Текстури та кольори: фото продукту з усіх сторін + деталі крупним планом",
    "Якщо продукту немає: посилання на матеріали (від 2000x2000px) + HEX-коди",
    "Кути зйомки: Front / Side / Top / Back / Corner ¾ / Hero Shot / Close-up / Feature Callout / Component View / Dimension Image / Product Set / Size & Proportion",
    "Тінь: без тіні (за замовчуванням) / під об'єктом / праворуч / ліворуч",
    "Фон: білий (за замовчуванням) / чорний / прозорий / інший (HEX-код)",
    "Роздільність: 2K / 4K / 5K",
    "Формат файлу: JPEG / PNG / TIF / PSD",
    "DPI: 72 (онлайн) / 300 (друк)",
    "Співвідношення сторін: 16x9 / 9x16 / 4x3 / 1x1",
    "Найменування файлів: стандартне (ID задачі + кут) / інше",
    "Призначення: сайт / презентація / каталог",
    "Дедлайн"
  ],
  "Мастерплан":           ["Генплан з масштабом","Типологія будівель","Озеленення та ландшафт","Дороги та інфраструктура","Час доби та сезон","Стиль подачі","Формат та дедлайн"],
  "Продуктова візуалізація": [
    "3D-модель продукту: надає клієнт (.3ds / .fbx / .obj) або моделюємо з нуля",
    "Якщо модель від клієнта: відповідність референсам, відсутність дефектів геометрії",
    "Технічні креслення або CAD-файл (DWG, PDF, wireframe) — якщо моделюємо",
    "Якщо креслень немає: габарити продукту (висота / ширина / глибина) + одиниці виміру",
    "Фото продукту: вигляд спереду, збоку, ззаду, кут 3/4",
    "Фото деталей крупним планом",
    "Матеріали та покриття: фото або посилання на референси матеріалів",
    "Якщо матеріалу немає: посилання на матеріали (від 2000x2000px) + HEX-коди",
    "Тло та оточення: студійний фон / інтер'єр / вулиця / інше",
    "Якщо студійний фон: колір або градієнт (HEX)",
    "Якщо сцена: опис або референс оточення",
    "Освітлення: студійне (за замовчуванням) / природне / декоративне / мішане",
    "Настрій / час доби (за замовчуванням: день)",
    "Ракурси / кути камери: Front / Side / Hero Shot / Close-up / 3/4 / інше",
    "Кількість ракурсів",
    "Референси стилю подачі з коментарями — що саме взяти",
    "Роздільність: 2K / 4K / 5K",
    "Формат файлу: JPEG / PNG / TIFF / PSD",
    "DPI: 72 (онлайн) / 300 (друк)",
    "Співвідношення сторін: 16x9 / 1x1 / 4x3 / інше",
    "Кількість фінальних зображень",
    "Призначення: сайт / каталог / презентація / соцмережі / друк",
    "Дедлайн"
  ],
  "3D Моделювання продукту": [
    "Призначення моделі: рендеринг / AR / VR / анімація / 3D-друк",
    "Ліміт полігонів: без ліміту / до [X]",
    "Вихідний формат файлу: .max / .fbx / .obj",
    "Метод UV-розгортки: Tiling / RealWorld",
    "Тип матеріалу: Corona / V-Ray / інше",
    "Формат сітки: трикутники / прямокутники",
    "Рівень деталізації: Low / Medium / High",
    "Креслення або CAD-модель (DWG, PDF, wireframe)",
    "Якщо креслень немає: габарити продукту (висота / ширина / глибина) + одиниці виміру (мм / см / дюйми)",
    "Розміри кожної частини продукту окремо",
    "Фото продукту: вигляд спереду, збоку, ззаду, кут 3/4",
    "Фото деталей крупним планом",
    "Текстури та кольори: фото продукту в потрібному матеріалі",
    "Якщо матеріалу немає: посилання на матеріали (від 2000x2000px) + HEX-коди",
    "Дедлайн"
  ],
};

const CAT_COLOR = {
  "Матеріали та текстури": "#8e44ad", "Меблі та моделі": "#2980b9",
  "Сезон / атмосфера": "#27ae60",    "Тип освітлення": "#f39c12",
  "Креслення та планування": "#e67e22","Логотип / написи": "#16a085",
  "Вимоги клієнта": "#c0392b",        "Специфічні запити": "#7f8c8d",
};

const PRODUCTION_STAGES = ["Моделінг", "Текстуринг", "Світло", "Камери", "Пост-продакшн", "Видача"];
const STAGE_COLOR = {
  "Моделінг": "#e67e22", "Текстуринг": "#8e44ad", "Світло": "#f39c12",
  "Камери": "#2980b9",   "Пост-продакшн": "#16a085", "Видача": "#7f8c8d",
};
const STAGE_HINT = {
  "Моделінг": "геометрія, планування, розміри",
  "Текстуринг": "матеріали, бренди, RAL/артикули",
  "Світло": "час доби, сезон, джерела",
  "Камери": "ракурси, висота ока, орієнтири",
  "Пост-продакшн": "стиль обробки, люди в кадрі",
  "Видача": "формат, розширення, дедлайн",
};

// ─── TZ Review ────────────────────────────────────────────────────────────────
// ─── Image Lightbox ───────────────────────────────────────────────────────────
function ImageLightbox({ imgRef, itemText, onClose }) {
  if (!imgRef) return null;
  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", zIndex: 2000, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      {/* Header */}
      <div onClick={e => e.stopPropagation()}
        style={{ width: "min(92vw,960px)", display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, fontFamily: "monospace", color: "#888", marginBottom: 2 }}>{imgRef.fileLabel} · стор. {imgRef.pageNum}</div>
          <div style={{ fontSize: 11, color: "#ccc", fontFamily: "monospace" }}>{imgRef.filename}</div>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#666", fontSize: 22, cursor: "pointer", lineHeight: 1 }}>✕</button>
      </div>
      {/* Image */}
      <div onClick={e => e.stopPropagation()}
        style={{ width: "min(92vw,960px)", maxHeight: "78vh", overflow: "hidden", borderRadius: 8, background: "#111", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <img src={imgRef.full || imgRef.preview} alt={imgRef.fileLabel}
          style={{ maxWidth: "100%", maxHeight: "78vh", objectFit: "contain", display: "block" }} />
      </div>
      {/* Footer — item context */}
      {itemText && (
        <div onClick={e => e.stopPropagation()}
          style={{ width: "min(92vw,960px)", marginTop: 8, padding: "8px 12px", background: "rgba(255,255,255,0.06)", borderRadius: 6 }}>
          <span style={{ fontSize: 9, fontFamily: "monospace", color: "#555", marginRight: 8 }}>ВИМОГА:</span>
          <span style={{ fontSize: 11, color: "#bbb" }}>{itemText}</span>
        </div>
      )}
    </div>
  );
}

function DocViewer({ source, initialPage, itemText, onClose }) {
  const [page, setPage] = useState(initialPage || 1);
  useEffect(() => { setPage(initialPage || 1); }, [initialPage, source]);
  const pages = source?.pages || [];
  const total = pages.length;
  const cur = pages[page - 1];
  const b64 = cur?.b64 ? `data:image/jpeg;base64,${cur.b64}` : null;

  if (!b64 && !total) return null;

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.92)", zIndex: 2000, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      {/* Header */}
      <div onClick={e => e.stopPropagation()}
        style={{ width: "min(94vw,1040px)", display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, fontFamily: "monospace", color: "#888", marginBottom: 2 }}>{source.name || source.filename}</div>
          <div style={{ fontSize: 9, fontFamily: "monospace", color: "#555" }}>{total} сторін{total === 1 ? "ка" : total < 5 ? "ки" : "ок"}</div>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#666", fontSize: 22, cursor: "pointer", lineHeight: 1 }}>✕</button>
      </div>

      {/* Image */}
      <div onClick={e => e.stopPropagation()}
        style={{ width: "min(94vw,1040px)", maxHeight: "72vh", overflow: "hidden", borderRadius: 8, background: "#111", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
        {b64
          ? <img src={b64} alt={`стор. ${page}`} style={{ maxWidth: "100%", maxHeight: "72vh", objectFit: "contain", display: "block" }} />
          : <div style={{ color: "#555", fontFamily: "monospace", fontSize: 11 }}>Зображення недоступне</div>}
        {/* Prev / Next overlays */}
        {page > 1 && (
          <button onClick={() => setPage(p => p - 1)}
            style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "15%", background: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "flex-start", paddingLeft: 12 }}>
            <span style={{ fontSize: 28, color: "rgba(255,255,255,0.4)" }}>‹</span>
          </button>
        )}
        {page < total && (
          <button onClick={() => setPage(p => p + 1)}
            style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "15%", background: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 12 }}>
            <span style={{ fontSize: 28, color: "rgba(255,255,255,0.4)" }}>›</span>
          </button>
        )}
      </div>

      {/* Pagination + thumbnails */}
      <div onClick={e => e.stopPropagation()}
        style={{ width: "min(94vw,1040px)", marginTop: 8, display: "flex", alignItems: "center", gap: 8, overflowX: "auto" }}>
        <span style={{ fontSize: 10, fontFamily: "monospace", color: "#666", flexShrink: 0 }}>{page} / {total}</span>
        <div style={{ display: "flex", gap: 4, flex: 1, overflowX: "auto" }}>
          {pages.map((pg, i) => {
            const thumb = pg.preview || (pg.b64 ? `data:image/jpeg;base64,${pg.b64}` : null);
            const isActive = i + 1 === page;
            return (
              <div key={i} onClick={() => setPage(i + 1)}
                style={{ flexShrink: 0, width: 44, height: 33, borderRadius: 3, overflow: "hidden", cursor: "pointer", border: isActive ? "2px solid #2980b9" : "2px solid transparent", opacity: isActive ? 1 : 0.5, transition: "opacity 0.15s, border-color 0.15s" }}>
                {thumb
                  ? <img src={thumb} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : <div style={{ width: "100%", height: "100%", background: "#333", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 7, color: "#888", fontFamily: "monospace" }}>{i + 1}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Item context */}
      {itemText && (
        <div onClick={e => e.stopPropagation()}
          style={{ width: "min(94vw,1040px)", marginTop: 6, padding: "8px 12px", background: "rgba(255,255,255,0.06)", borderRadius: 6 }}>
          <span style={{ fontSize: 9, fontFamily: "monospace", color: "#555", marginRight: 8 }}>ВИМОГА:</span>
          <span style={{ fontSize: 11, color: "#bbb" }}>{itemText}</span>
        </div>
      )}
    </div>
  );
}

function TzItem({ item, onEdit, onRemove, onOpenRef, onOpenDoc }) {
  const [editing, setEditing] = useState(false);
  const ref = item.imgRef;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 0", borderBottom: "1px solid #f2f0ec" }}>
      <div style={{ width: 4, height: 4, borderRadius: "50%", background: CAT_COLOR[item.category] || "#ccc", flexShrink: 0, marginTop: 7 }} />
      {/* Ref thumbnail */}
      {ref?.preview && (
        <div onClick={() => onOpenRef(ref, item.text)} title={`${ref.fileLabel} · стор. ${ref.pageNum}`}
          style={{ width: 44, height: 33, flexShrink: 0, cursor: "pointer", borderRadius: 3, overflow: "hidden", border: "1px solid #e0ddd8", position: "relative", marginTop: 1 }}>
          <img src={ref.preview} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0)", transition: "background 0.15s" }}
            onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.25)"}
            onMouseLeave={e => e.currentTarget.style.background = "rgba(0,0,0,0)"}>
            <div style={{ position: "absolute", bottom: 2, right: 2, fontSize: 7, fontFamily: "monospace", color: "#fff", background: "rgba(0,0,0,0.5)", padding: "0 2px", borderRadius: 1 }}>
              с.{ref.pageNum}
            </div>
          </div>
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing
          ? <textarea autoFocus value={item.text} onChange={e => onEdit(item.id, e.target.value)} onBlur={() => setEditing(false)}
              rows={Math.max(2, Math.ceil(item.text.length / 80))}
              style={{ width: "100%", border: "1px solid #e0ddd8", borderRadius: 4, fontSize: 12, color: "#222", lineHeight: 1.5, fontFamily: "inherit", padding: "3px 6px", outline: "none", background: "#fafafa", resize: "vertical" }} />
          : <div onClick={() => setEditing(true)} style={{ fontSize: 12, color: "#222", lineHeight: 1.55, cursor: "text", padding: "1px 0" }}>{item.text}</div>
        }
        {item.quote && (
          <div style={{ fontSize: 10, color: "#999", fontStyle: "italic", borderLeft: "2px solid #e8e6e1", paddingLeft: 7, marginTop: 4, lineHeight: 1.55 }}>
            "{item.quote}"
          </div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
          {item.stage && <span style={{ fontSize: 8, fontFamily: "monospace", color: STAGE_COLOR[item.stage] || "#888", border: `1px solid ${STAGE_COLOR[item.stage] || "#888"}`, padding: "1px 5px", borderRadius: 3 }}>{item.stage}</span>}
          {item.source && <span style={{ fontSize: 9, color: "#bbb", fontFamily: "monospace" }}>{item.source}</span>}
          {ref && <span onClick={() => onOpenRef(ref, item.text)} style={{ fontSize: 9, color: "#3498db", fontFamily: "monospace", cursor: "pointer", textDecoration: "underline dotted" }} title="Відкрити джерело">↗ {ref.fileLabel}{ref.pageNum > 1 ? ` стор.${ref.pageNum}` : ""}</span>}
          {!ref && item.imgRefLabel && <span onClick={() => onOpenDoc?.(item.imgRefLabel, item.text)} style={{ fontSize: 9, color: "#e67e22", fontFamily: "monospace", cursor: onOpenDoc ? "pointer" : "default", textDecoration: onOpenDoc ? "underline dotted" : "none" }} title={`Відкрити: ${item.imgRefLabel}`}>⚠ {item.imgRefLabel}</span>}
          {(item.links || []).map((lk, li) => (
            <a key={li} href={lk.url} target="_blank" rel="noreferrer"
              title={lk.url}
              style={{ fontSize: 9, color: "#3498db", fontFamily: "monospace", textDecoration: "none", background: "#f0f7ff", border: "1px solid #d0e8fb", borderRadius: 3, padding: "1px 5px" }}>
              🔗 {lk.label || lk.url.replace(/^https?:\/\//, "").slice(0, 35)}
            </a>
          ))}
        </div>
      </div>
      <button onClick={() => onRemove(item.id)} style={{ background: "none", border: "none", color: "#ddd", cursor: "pointer", fontSize: 14, flexShrink: 0, lineHeight: 1, padding: "2px 4px" }} title="Видалити">×</button>
    </div>
  );
}

const SOURCE_TYPE_LABELS = {
  furniture: "Меблі", material: "Матеріали", lighting: "Освітлення",
  style_ref: "Стиль", time_of_day: "Час доби", weather: "Погода/сезон",
  render_quality: "Якість рендеру", camera: "Ракурс", dimensions: "Розміри",
  logo: "Логотип", comment: "Коментар", other: "Інше",
};
const SOURCE_TYPE_COLOR = {
  furniture: "#2980b9", material: "#8e44ad", lighting: "#f39c12",
  style_ref: "#27ae60", time_of_day: "#e67e22", weather: "#16a085",
  render_quality: "#7f8c8d", camera: "#2471a3", dimensions: "#e67e22",
  logo: "#c0392b", comment: "#95a5a6", other: "#bdc3c7",
};
const SOURCE_FILE_ICO = { pdf: "📄", dwg: "📐", dxf: "📐", excel: "📊", text: "📝", image: "🖼️" };

function TzReviewStep({ projectType, rooms, tzByRoom, sowMissing, sowUnclear, clientComments, annotation, conflicts, roadmap, sources, files, sourceTags, onSourceTag, onEdit, onRemove, onBack, onSearchLinks, searchingLinks, linkSearchProgress }) {
  const allRooms = rooms?.length ? ["Загальне", ...rooms.filter(r => r !== "Загальне")] : ["Загальне"];
  const [viewMode, setViewMode] = useState("rooms"); // "rooms" | "stages" | "table"
  const [activeRoom, setActiveRoom] = useState(allRooms[0]);
  const [activeStage, setActiveStage] = useState(PRODUCTION_STAGES[0]);
  const [lightbox, setLightbox] = useState(null); // { imgRef, itemText }
  const [docViewer, setDocViewer] = useState(null); // { source, pageNum }
  const [tableFilter, setTableFilter] = useState({ type: "", room: "", stage: "", search: "" });
  const [tableSort, setTableSort] = useState({ col: "room", dir: "asc" });

  const allItems = Object.values(tzByRoom || {}).flatMap(r => Object.values(r)).flat();

  // Map filename → file object (with pages) for DocViewer
  const filesByName = useMemo(() => {
    const m = {};
    (files || []).forEach(f => { m[f.filename] = f; });
    return m;
  }, [files]);

  // Open DocViewer by known filename + page
  const openDocViewer = (filename, pageNum, itemText) => {
    const file = filesByName[filename];
    if (!file) return;
    setDocViewer({ source: file, pageNum: pageNum || 1, itemText });
  };

  // Open DocViewer by imgRefLabel (e.g. "CUTSHEET стор.4") — fuzzy match against filenames
  const openDocByLabel = (label, itemText) => {
    if (!label || !(files || []).length) return;
    const norm = s => s.replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const raw = norm(label);
    // Extract page number from "стор.N" or "стор. N"
    const pageMatch = raw.match(/стор[.\s]+(\d+)/);
    const pageNum = pageMatch ? parseInt(pageMatch[1]) : 1;
    const baseName = raw.replace(/стор[.\s]+\d+/g, '').replace(/\s+\d+$/, '').trim();
    // Find file whose filename (without ext) contains baseName or vice versa
    const found = (files || []).find(f => {
      const fn = f.filename.replace(/\.[^.]+$/, '').toLowerCase();
      return fn.includes(baseName) || baseName.includes(fn);
    });
    if (found) setDocViewer({ source: found, pageNum, itemText });
  };

  const CAT_TO_TYPE = {
    "Матеріали та текстури": "material",
    "Меблі та моделі": "todo",
    "Сезон / атмосфера": "style",
    "Тип освітлення": "style",
    "Креслення та планування": "dimension",
    "Логотип / написи": "todo",
    "Вимоги клієнта": "todo",
    "Специфічні запити": "comment",
  };

  const tableRows = useMemo(() => {
    const rows = [];
    allItems.forEach(it => {
      const type = it.imgRef ? "image" : (CAT_TO_TYPE[it.category] || "todo");
      rows.push({ id: it.id, type, text: it.text, quote: it.quote, room: it.room || "—", category: it.category || "—", stage: it.stage || "—", source: it.source || "—", img_ref: it.imgRef || null, _item: it });
    });
    (conflicts || []).forEach((c, i) => rows.push({ id: `conflict-${i}`, type: "conflict", text: c, quote: null, room: "—", category: "Конфлікт", stage: "—", source: "—", img_ref: null, _item: null }));
    (sowMissing || []).forEach((m, i) => rows.push({ id: `missing-${i}`, type: "missing", text: m, quote: null, room: "—", category: "SOW відсутнє", stage: "—", source: "—", img_ref: null, _item: null }));
    (sowUnclear || []).forEach((u, i) => rows.push({ id: `unclear-${i}`, type: "unclear", text: u, quote: null, room: "—", category: "SOW неповно", stage: "—", source: "—", img_ref: null, _item: null }));
    return rows;
  }, [allItems, conflicts, sowMissing, sowUnclear]);

  const filteredRows = useMemo(() => {
    let r = tableRows;
    if (tableFilter.type) r = r.filter(x => x.type === tableFilter.type);
    if (tableFilter.room) r = r.filter(x => x.room === tableFilter.room);
    if (tableFilter.stage) r = r.filter(x => x.stage === tableFilter.stage);
    if (tableFilter.search) { const q = tableFilter.search.toLowerCase(); r = r.filter(x => x.text?.toLowerCase().includes(q) || x.category?.toLowerCase().includes(q)); }
    return [...r].sort((a, b) => {
      const av = a[tableSort.col] || ""; const bv = b[tableSort.col] || "";
      return tableSort.dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }, [tableRows, tableFilter, tableSort]);

  const toggleSort = col => setTableSort(s => ({ col, dir: s.col === col && s.dir === "asc" ? "desc" : "asc" }));

  const TYPE_META = {
    todo:      { label: "TODO",      color: "#2980b9", bg: "#eaf4fb" },
    material:  { label: "МАТЕРІАЛ",  color: "#8e44ad", bg: "#f5eefb" },
    style:     { label: "СТИЛЬ",     color: "#27ae60", bg: "#e8f8ee" },
    dimension: { label: "РОЗМІР",    color: "#e67e22", bg: "#fef5e7" },
    image:     { label: "ЗОБРАЖЕННЯ",color: "#16a085", bg: "#e8f8f5" },
    comment:   { label: "КОМЕНТАР",  color: "#7f8c8d", bg: "#f4f6f7" },
    conflict:  { label: "КОНФЛІКТ",  color: "#e74c3c", bg: "#fde8e8" },
    missing:   { label: "ВІДСУТНЄ",  color: "#c0392b", bg: "#fde8e8" },
    unclear:   { label: "НЕПОВНО",   color: "#e67e22", bg: "#fff8ec" },
  };

  const roomData = tzByRoom?.[activeRoom] || {};
  const totalItems = Object.values(tzByRoom || {}).flatMap(r => Object.values(r)).flat().length;

  const copyClientRequest = () => {
    const lines = ["Для завершення ТЗ потрібна додаткова інформація:\n"];
    if (sowMissing?.length > 0) {
      lines.push("Відсутня інформація:");
      sowMissing.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
      lines.push("");
    }
    if (sowUnclear?.length > 0) {
      lines.push("Потребує уточнення:");
      sowUnclear.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    }
    navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
  };

  const copyMd = () => {
    const lines = [];
    (rooms || ["Загальне"]).forEach(room => {
      const rd = tzByRoom?.[room] || {};
      if (!Object.keys(rd).length) return;
      lines.push(`\n## ${room}`);
      Object.entries(rd).forEach(([cat, items]) => {
        lines.push(`\n### ${cat}`);
        items.forEach(it => lines.push(`- ${it.text}`));
      });
    });
    navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
  };

  const exportExcel = async () => {
    const XLSX = await loadXLSX();
    const data = filteredRows.map(row => ({
      "Тип":      row.type,
      "Вимога":   row.text,
      "Цитата":   row.quote || "",
      "Категорія": row.category,
      "Приміщення": row.room,
      "Стадія":   row.stage,
      "Джерело":  row.source + (row.img_ref?.pageNum > 1 ? ` стор.${row.img_ref.pageNum}` : ""),
      "Посилання": (row._item?.links || []).map(l => l.url).join(", "),
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    // Column widths
    ws["!cols"] = [8, 60, 40, 20, 20, 16, 20, 40].map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "ТЗ");
    XLSX.writeFile(wb, `tz-${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  const exportPdf = () => {
    const prev = document.title;
    document.title = `ТЗ — ${projectType || "проект"} — ${new Date().toLocaleDateString("uk-UA")}`;
    window.print();
    document.title = prev;
  };

  return (
    <div style={{ minHeight: "100vh", background: "#f5f4f1", display: "flex", flexDirection: "column" }}>
      {lightbox && <ImageLightbox imgRef={lightbox.imgRef} itemText={lightbox.itemText} onClose={() => setLightbox(null)} />}
      {docViewer && <DocViewer key={`${docViewer.source?.filename}-${docViewer.pageNum}`} source={docViewer.source} initialPage={docViewer.pageNum} itemText={docViewer.itemText} onClose={() => setDocViewer(null)} />}
      {/* Топ-бар */}
      <div style={{ background: "#1a1a1a", padding: "0 20px", display: "flex", alignItems: "center", gap: 12, height: 44, flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 16, padding: 0 }}>←</button>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#f2f0ec", fontFamily: "monospace", letterSpacing: "0.1em" }}>ТЗ TOOL</span>
        {projectType && <span style={{ fontSize: 9, color: "#fff", background: "#2980b9", fontFamily: "monospace", padding: "2px 8px", borderRadius: 10 }}>{projectType}</span>}
        <span style={{ fontSize: 9, color: "#555", fontFamily: "monospace", marginLeft: "auto" }}>{totalItems} вимог</span>
        {(sowMissing?.length > 0 || sowUnclear?.length > 0) && (
          <button onClick={copyClientRequest} title="Скопіювати список питань для клієнта"
            style={{ fontSize: 9, fontFamily: "monospace", background: "#e67e22", border: "none", color: "#fff", padding: "3px 10px", borderRadius: 4, cursor: "pointer", fontWeight: 700 }}>
            Запит ({(sowMissing?.length || 0) + (sowUnclear?.length || 0)})
          </button>
        )}
        {onSearchLinks && (
          <button onClick={onSearchLinks} disabled={searchingLinks}
            style={{ fontSize: 9, fontFamily: "monospace", background: searchingLinks ? "#1a3a1a" : "#1a2a1a", border: `1px solid ${searchingLinks ? "#27ae60" : "#27ae60"}`, color: "#27ae60", padding: "3px 10px", borderRadius: 4, cursor: searchingLinks ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 5 }}>
            {searchingLinks
              ? <>⏳ {linkSearchProgress.done}/{linkSearchProgress.total}</>
              : <>🔗 Посилання</>}
          </button>
        )}
        <button onClick={exportPdf} style={{ fontSize: 9, fontFamily: "monospace", background: "none", border: "1px solid #333", color: "#666", padding: "3px 10px", borderRadius: 4, cursor: "pointer" }}>PDF</button>
        <button onClick={exportExcel} style={{ fontSize: 9, fontFamily: "monospace", background: "none", border: "1px solid #2ecc71", color: "#2ecc71", padding: "3px 10px", borderRadius: 4, cursor: "pointer" }}>XLS</button>
        <button onClick={copyMd} style={{ fontSize: 9, fontFamily: "monospace", background: "none", border: "1px solid #333", color: "#666", padding: "3px 10px", borderRadius: 4, cursor: "pointer" }}>MD</button>
      </div>

      {viewMode === "table" && (
        <div style={{ flex: 1, overflow: "auto", padding: "16px 20px", background: "#f5f4f1" }}>
          {/* Filter bar */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            <input
              placeholder="Пошук..."
              value={tableFilter.search}
              onChange={e => setTableFilter(f => ({ ...f, search: e.target.value }))}
              style={{ fontSize: 11, fontFamily: "monospace", padding: "5px 10px", border: "1px solid #ddd", borderRadius: 4, background: "#fff", width: 180 }}
            />
            <select value={tableFilter.type} onChange={e => setTableFilter(f => ({ ...f, type: e.target.value }))}
              style={{ fontSize: 11, fontFamily: "monospace", padding: "5px 8px", border: "1px solid #ddd", borderRadius: 4, background: "#fff" }}>
              <option value="">Всі типи</option>
              {Object.entries(TYPE_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select value={tableFilter.room} onChange={e => setTableFilter(f => ({ ...f, room: e.target.value }))}
              style={{ fontSize: 11, fontFamily: "monospace", padding: "5px 8px", border: "1px solid #ddd", borderRadius: 4, background: "#fff" }}>
              <option value="">Всі кімнати</option>
              {allRooms.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <select value={tableFilter.stage} onChange={e => setTableFilter(f => ({ ...f, stage: e.target.value }))}
              style={{ fontSize: 11, fontFamily: "monospace", padding: "5px 8px", border: "1px solid #ddd", borderRadius: 4, background: "#fff" }}>
              <option value="">Всі стадії</option>
              {PRODUCTION_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button onClick={() => setViewMode("rooms")}
              style={{ fontSize: 9, fontFamily: "monospace", background: "none", border: "1px solid #ddd", color: "#888", padding: "4px 10px", borderRadius: 4, cursor: "pointer" }}>← назад</button>
            <span style={{ fontSize: 10, fontFamily: "monospace", color: "#aaa", marginLeft: "auto" }}>{filteredRows.length} рядків</span>
            {(tableFilter.type || tableFilter.room || tableFilter.stage || tableFilter.search) && (
              <button onClick={() => setTableFilter({ type: "", room: "", stage: "", search: "" })}
                style={{ fontSize: 9, fontFamily: "monospace", padding: "4px 10px", border: "1px solid #ddd", borderRadius: 4, background: "#fff", cursor: "pointer", color: "#e74c3c" }}>✕ скинути</button>
            )}
          </div>
          {/* Table */}
          <div style={{ background: "#fff", borderRadius: 6, border: "1px solid #e5e5e5", overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ background: "#f8f7f5", borderBottom: "2px solid #e5e5e5" }}>
                  {[
                    { key: "type", label: "ТИП" },
                    { key: "text", label: "ЗМІСТ" },
                    { key: "category", label: "КАТЕГОРІЯ" },
                    { key: "room", label: "КІМНАТА" },
                    { key: "stage", label: "СТАДІЯ" },
                    { key: "source", label: "ДЖЕРЕЛО" },
                  ].map(col => (
                    <th key={col.key} onClick={() => toggleSort(col.key)}
                      style={{ padding: "8px 12px", textAlign: "left", fontSize: 8, fontFamily: "monospace", letterSpacing: "0.1em", color: tableSort.col === col.key ? "#1a1a1a" : "#aaa", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
                      {col.label} {tableSort.col === col.key ? (tableSort.dir === "asc" ? "↑" : "↓") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row, i) => {
                  const meta = TYPE_META[row.type] || TYPE_META.todo;
                  // Find the actual file with pages: prefer by img_ref filename, fallback fuzzy by source name
                  const srcFile = row.img_ref?.filename
                    ? filesByName[row.img_ref.filename]
                    : (files || []).find(f => f.filename.toLowerCase().includes((row.source || "").toLowerCase()) || (row.source || "").toLowerCase().includes(f.filename.replace(/\.[^.]+$/, '').toLowerCase()));
                  return (
                    <tr key={row.id} style={{ borderBottom: "1px solid #f0eeea", background: i % 2 === 0 ? "#fff" : "#fafaf9" }}
                      onMouseEnter={e => e.currentTarget.style.background = "#f0f8ff"}
                      onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? "#fff" : "#fafaf9"}>
                      {/* Type */}
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                        <span style={{ fontSize: 8, fontWeight: 700, fontFamily: "monospace", letterSpacing: "0.08em", color: meta.color, background: meta.bg, padding: "2px 7px", borderRadius: 3 }}>{meta.label}</span>
                      </td>
                      {/* Content */}
                      <td style={{ padding: "8px 12px", maxWidth: 400 }}>
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                          {row.img_ref && (
                            <img src={row.img_ref.preview} alt="" onClick={() => setLightbox({ imgRef: row.img_ref, itemText: row.text })}
                              style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 3, cursor: "pointer", flexShrink: 0, border: "1px solid #e5e5e5" }} />
                          )}
                          <div>
                            <div style={{ fontSize: 11, color: "#1a1a1a", lineHeight: 1.4 }}>{row.text}</div>
                            {row.quote && <div style={{ fontSize: 9, color: "#aaa", fontStyle: "italic", marginTop: 2, fontFamily: "monospace" }}>"{row.quote}"</div>}
                          </div>
                        </div>
                      </td>
                      {/* Category */}
                      <td style={{ padding: "8px 12px", fontSize: 10, color: "#888", whiteSpace: "nowrap" }}>{row.category}</td>
                      {/* Room */}
                      <td style={{ padding: "8px 12px", fontSize: 10, color: "#555", whiteSpace: "nowrap" }}>{row.room}</td>
                      {/* Stage */}
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                        {row.stage && row.stage !== "—" ? (
                          <span style={{ fontSize: 8, fontFamily: "monospace", color: STAGE_COLOR[row.stage] || "#aaa", background: "#f8f7f5", padding: "2px 6px", borderRadius: 3 }}>{row.stage}</span>
                        ) : <span style={{ color: "#ddd" }}>—</span>}
                      </td>
                      {/* Source */}
                      <td style={{ padding: "8px 12px" }}>
                        {srcFile ? (
                          <button onClick={() => openDocViewer(srcFile.filename, row.img_ref?.pageNum || 1, row.text)}
                            style={{ fontSize: 9, fontFamily: "monospace", color: "#2980b9", background: "none", border: "1px solid #c5dff0", borderRadius: 3, padding: "2px 8px", cursor: "pointer" }}>
                            {row.source}{row.img_ref?.pageNum > 1 ? ` стор.${row.img_ref.pageNum}` : ""}
                          </button>
                        ) : row.source && row.source !== "—" ? (
                          <span onClick={() => openDocByLabel(row.source, row.text)}
                            style={{ fontSize: 9, fontFamily: "monospace", color: "#e67e22", cursor: "pointer", textDecoration: "underline dotted" }} title="Спробувати знайти документ">
                            {row.source}
                          </span>
                        ) : (
                          <span style={{ fontSize: 9, fontFamily: "monospace", color: "#ccc" }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {filteredRows.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: "32px", textAlign: "center", fontSize: 11, color: "#bbb", fontFamily: "monospace" }}>Нічого не знайдено</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden", display: viewMode === "table" ? "none" : "flex" }}>
        {/* Ліва панель */}
        <div style={{ width: 190, background: "#fff", borderRight: "1px solid #ece9e4", flexShrink: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {/* Annotation */}
          {annotation && (
            <div style={{ padding: "12px 14px", borderBottom: "1px solid #f0eeea" }}>
              <div style={{ fontSize: 8, fontFamily: "monospace", color: "#bbb", letterSpacing: "0.1em", marginBottom: 4 }}>ПРОЕКТ</div>
              <div style={{ fontSize: 10, color: "#555", lineHeight: 1.5 }}>{annotation}</div>
            </div>
          )}
          {/* View toggle */}
          <div style={{ display: "flex", padding: "8px 14px", gap: 4, borderBottom: "1px solid #f0eeea", flexWrap: "wrap" }}>
            <button onClick={() => setViewMode("rooms")} style={{ flex: 1, fontSize: 8, fontFamily: "monospace", padding: "4px 0", border: "none", borderRadius: 3, cursor: "pointer", background: viewMode === "rooms" ? "#1a1a1a" : "#f0eeea", color: viewMode === "rooms" ? "#fff" : "#888", fontWeight: viewMode === "rooms" ? 700 : 400 }}>КІМНАТИ</button>
            <button onClick={() => setViewMode("stages")} style={{ flex: 1, fontSize: 8, fontFamily: "monospace", padding: "4px 0", border: "none", borderRadius: 3, cursor: "pointer", background: viewMode === "stages" ? "#1a1a1a" : "#f0eeea", color: viewMode === "stages" ? "#fff" : "#888", fontWeight: viewMode === "stages" ? 700 : 400 }}>СТАДІЇ</button>
            <button onClick={() => setViewMode("table")} style={{ flex: 1, fontSize: 8, fontFamily: "monospace", padding: "4px 0", border: "none", borderRadius: 3, cursor: "pointer", background: viewMode === "table" ? "#2980b9" : "#f0eeea", color: viewMode === "table" ? "#fff" : "#888", fontWeight: viewMode === "table" ? 700 : 400 }}>ТАБЛИЦЯ</button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
            {viewMode === "rooms" ? (
              <>
                {allRooms.map(room => {
                  const cnt = Object.values(tzByRoom?.[room] || {}).flat().length;
                  return (
                    <div key={room} onClick={() => setActiveRoom(room)}
                      style={{ padding: "7px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", background: activeRoom === room ? "#f5f4f1" : "transparent", borderLeft: `3px solid ${activeRoom === room ? "#1a1a1a" : "transparent"}` }}>
                      <span style={{ fontSize: 11, color: activeRoom === room ? "#1a1a1a" : "#666" }}>{room}</span>
                      {cnt > 0 && <span style={{ fontSize: 9, fontFamily: "monospace", color: "#bbb" }}>{cnt}</span>}
                    </div>
                  );
                })}
                {clientComments?.length > 0 && (
                  <div onClick={() => setActiveRoom("__comments__")}
                    style={{ padding: "7px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", background: activeRoom === "__comments__" ? "#f5f4f1" : "transparent", borderLeft: `3px solid ${activeRoom === "__comments__" ? "#1a1a1a" : "transparent"}`, marginTop: 8, borderTop: "1px solid #f0eeea" }}>
                    <span style={{ fontSize: 11, color: "#666" }}>Коментарі</span>
                    <span style={{ fontSize: 9, fontFamily: "monospace", color: "#bbb" }}>{clientComments.length}</span>
                  </div>
                )}
                {(sowMissing?.length > 0 || sowUnclear?.length > 0) && (
                  <div onClick={() => setActiveRoom("__sow__")}
                    style={{ padding: "7px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", background: activeRoom === "__sow__" ? "#fff9f0" : "transparent", borderLeft: `3px solid ${activeRoom === "__sow__" ? "#e67e22" : "transparent"}`, marginTop: 4 }}>
                    <span style={{ fontSize: 11, color: "#e67e22" }}>⚠ SOW</span>
                    <span style={{ fontSize: 9, fontFamily: "monospace", color: "#e67e22" }}>{(sowMissing?.length || 0) + (sowUnclear?.length || 0)}</span>
                  </div>
                )}
                {conflicts?.length > 0 && (
                  <div onClick={() => setActiveRoom("__conflicts__")}
                    style={{ padding: "7px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", background: activeRoom === "__conflicts__" ? "#fff5f5" : "transparent", borderLeft: `3px solid ${activeRoom === "__conflicts__" ? "#e74c3c" : "transparent"}`, marginTop: 4 }}>
                    <span style={{ fontSize: 11, color: "#e74c3c" }}>⚡ Конфлікти</span>
                    <span style={{ fontSize: 9, fontFamily: "monospace", color: "#e74c3c" }}>{conflicts.length}</span>
                  </div>
                )}
                {roadmap?.length > 0 && (
                  <div onClick={() => setActiveRoom("__roadmap__")}
                    style={{ padding: "7px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", background: activeRoom === "__roadmap__" ? "#f0fff4" : "transparent", borderLeft: `3px solid ${activeRoom === "__roadmap__" ? "#27ae60" : "transparent"}`, marginTop: 4 }}>
                    <span style={{ fontSize: 11, color: "#27ae60" }}>▶ Роадмап</span>
                    <span style={{ fontSize: 9, fontFamily: "monospace", color: "#27ae60" }}>{roadmap.length}</span>
                  </div>
                )}
                {allItems.length > 0 && (
                  <div onClick={() => setActiveRoom("__checklist__")}
                    style={{ padding: "7px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", background: activeRoom === "__checklist__" ? "#f5f0ff" : "transparent", borderLeft: `3px solid ${activeRoom === "__checklist__" ? "#8e44ad" : "transparent"}`, marginTop: 4 }}>
                    <span style={{ fontSize: 11, color: "#8e44ad" }}>✓ Чеклист</span>
                    <span style={{ fontSize: 9, fontFamily: "monospace", color: "#8e44ad" }}>{allItems.length}</span>
                  </div>
                )}
                {sources?.length > 0 && (
                  <div onClick={() => setActiveRoom("__sources__")}
                    style={{ padding: "7px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", background: activeRoom === "__sources__" ? "#f0f9ff" : "transparent", borderLeft: `3px solid ${activeRoom === "__sources__" ? "#2980b9" : "transparent"}`, marginTop: 4 }}>
                    <span style={{ fontSize: 11, color: "#2980b9" }}>📋 Джерела</span>
                    <span style={{ fontSize: 9, fontFamily: "monospace", color: "#2980b9" }}>{sources.length}</span>
                  </div>
                )}
              </>
            ) : (
              <>
                {PRODUCTION_STAGES.map(stage => {
                  const cnt = allItems.filter(it => it.stage === stage).length;
                  const color = STAGE_COLOR[stage];
                  return (
                    <div key={stage} onClick={() => setActiveStage(stage)}
                      style={{ padding: "7px 14px", cursor: "pointer", borderLeft: `3px solid ${activeStage === stage ? color : "transparent"}`, background: activeStage === stage ? "#f5f4f1" : "transparent" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 11, color: activeStage === stage ? color : "#666", fontWeight: activeStage === stage ? 600 : 400 }}>{stage}</span>
                        {cnt > 0 && <span style={{ fontSize: 9, fontFamily: "monospace", color: "#bbb" }}>{cnt}</span>}
                      </div>
                      <div style={{ fontSize: 8, color: "#bbb", fontFamily: "monospace", marginTop: 1 }}>{STAGE_HINT[stage]}</div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        {/* Права панель — контент */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
          {viewMode === "stages" ? (
            (() => {
              const stageItems = allItems.filter(it => it.stage === activeStage);
              const byRoom = stageItems.reduce((acc, it) => { (acc[it.room] = acc[it.room] || []).push(it); return acc; }, {});
              const color = STAGE_COLOR[activeStage];
              return (
                <div style={{ maxWidth: 720 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color }}>{activeStage}</div>
                    <div style={{ fontSize: 10, color: "#bbb", fontFamily: "monospace" }}>{stageItems.length} вимог</div>
                  </div>
                  <div style={{ fontSize: 10, color: "#aaa", fontFamily: "monospace", marginBottom: 20 }}>{STAGE_HINT[activeStage]}</div>
                  {stageItems.length === 0
                    ? <div style={{ fontSize: 12, color: "#bbb", fontFamily: "monospace" }}>Немає вимог для цієї стадії</div>
                    : Object.entries(byRoom).map(([room, items]) => (
                        <div key={room} style={{ marginBottom: 20 }}>
                          <div style={{ fontSize: 9, fontWeight: 700, fontFamily: "monospace", color: "#aaa", letterSpacing: "0.1em", marginBottom: 6, borderBottom: "1px solid #ece9e4", paddingBottom: 4 }}>{room.toUpperCase()}</div>
                          {items.map(item => <TzItem key={item.id} item={item} onEdit={onEdit} onRemove={onRemove} onOpenRef={(imgRef, itemText) => setLightbox({ imgRef, itemText })} onOpenDoc={(label, itemText) => openDocByLabel(label, itemText)} />)}
                        </div>
                      ))
                  }
                </div>
              );
            })()
          ) : activeRoom === "__sow__" ? (
            <div style={{ maxWidth: 720 }}>
              <div style={{ fontSize: 10, fontFamily: "monospace", color: "#bbb", letterSpacing: "0.1em", marginBottom: 12 }}>SOW ВАЛІДАЦІЯ</div>
              {sowMissing?.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#e74c3c", fontFamily: "monospace", marginBottom: 8 }}>НЕ ВИСТАЧАЄ</div>
                  {sowMissing.map((s, i) => <div key={i} style={{ fontSize: 12, color: "#444", padding: "5px 0 5px 12px", borderLeft: "3px solid #e74c3c", marginBottom: 4 }}>{s}</div>)}
                </div>
              )}
              {sowUnclear?.length > 0 && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#e67e22", fontFamily: "monospace", marginBottom: 8 }}>НЕЗРОЗУМІЛО / НЕПОВНО</div>
                  {sowUnclear.map((s, i) => <div key={i} style={{ fontSize: 12, color: "#444", padding: "5px 0 5px 12px", borderLeft: "3px solid #e67e22", marginBottom: 4 }}>{s}</div>)}
                </div>
              )}
            </div>
          ) : activeRoom === "__sources__" ? (
            <div style={{ maxWidth: 720 }}>
              <div style={{ fontSize: 10, fontFamily: "monospace", color: "#bbb", letterSpacing: "0.1em", marginBottom: 4 }}>ДЖЕРЕЛА — ЩО ЗНАЙДЕНО В ФАЙЛАХ</div>
              <div style={{ fontSize: 10, color: "#bbb", fontFamily: "monospace", marginBottom: 16 }}>Виберіть призначення кожного референсу</div>
              {(sources || []).map((src, si) => (
                <div key={si} style={{ marginBottom: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid #ece9e4" }}>
                    <span style={{ fontSize: 13 }}>{SOURCE_FILE_ICO[src.fileType] || "📄"}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#1a1a1a" }}>{src.file}</span>
                    {src.page > 1 && <span style={{ fontSize: 9, fontFamily: "monospace", color: "#bbb" }}>стор. {src.page}</span>}
                  </div>
                  {(src.found || []).map((item, ii) => {
                    const currentTag = sourceTags?.[item.id] || item.type;
                    const tagColor = SOURCE_TYPE_COLOR[currentTag] || "#bbb";
                    return (
                      <div key={ii} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", borderBottom: "1px solid #f5f4f1" }}>
                        <div style={{ width: 6, height: 6, borderRadius: "50%", background: tagColor, flexShrink: 0 }} />
                        <span style={{ fontSize: 11, color: "#333", flex: 1, lineHeight: 1.4 }}>{item.description}</span>
                        <select
                          value={currentTag}
                          onChange={e => onSourceTag(item.id, e.target.value)}
                          style={{ fontSize: 9, fontFamily: "monospace", border: `1px solid ${tagColor}`, borderRadius: 4, color: tagColor, background: "#fff", padding: "2px 6px", cursor: "pointer", outline: "none" }}>
                          {Object.entries(SOURCE_TYPE_LABELS).map(([val, label]) => (
                            <option key={val} value={val}>{label}</option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : activeRoom === "__checklist__" ? (
            <div style={{ maxWidth: 720 }}>
              <div style={{ fontSize: 10, fontFamily: "monospace", color: "#bbb", letterSpacing: "0.1em", marginBottom: 4 }}>ЧЕКЛИСТ ЗДАЧІ</div>
              <div style={{ fontSize: 10, color: "#bbb", fontFamily: "monospace", marginBottom: 16 }}>Всі вимоги клієнта — для звірки результату перед здачею</div>
              {PRODUCTION_STAGES.map(stage => {
                const stageItems = allItems.filter(it => it.stage === stage);
                if (!stageItems.length) return null;
                return (
                  <div key={stage} style={{ marginBottom: 18 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, fontFamily: "monospace", color: STAGE_COLOR[stage], letterSpacing: "0.1em", marginBottom: 8, borderBottom: `1px solid ${STAGE_COLOR[stage]}33`, paddingBottom: 4 }}>{stage.toUpperCase()}</div>
                    {stageItems.map((item) => (
                      <div key={item.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "5px 0", borderBottom: "1px solid #f2f0ec" }}>
                        <div style={{ width: 14, height: 14, borderRadius: 3, border: `1.5px solid #ccc`, flexShrink: 0, marginTop: 2 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, color: "#222", lineHeight: 1.5 }}>{item.text}</div>
                          <div style={{ display: "flex", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 8, fontFamily: "monospace", color: "#bbb" }}>{item.room}</span>
                            <span style={{ fontSize: 8, fontFamily: "monospace", color: "#ddd" }}>·</span>
                            <span style={{ fontSize: 8, fontFamily: "monospace", color: "#bbb" }}>{item.category}</span>
                            {(item.links || []).map((lk, li) => (
                              <a key={li} href={lk.url} target="_blank" rel="noreferrer"
                                style={{ fontSize: 8, color: "#3498db", fontFamily: "monospace", textDecoration: "none" }}>
                                🔗 {lk.label || lk.type}
                              </a>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
              {allItems.filter(it => !it.stage).length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, fontFamily: "monospace", color: "#bbb", letterSpacing: "0.1em", marginBottom: 8, borderBottom: "1px solid #eee", paddingBottom: 4 }}>БЕЗ СТАДІЇ</div>
                  {allItems.filter(it => !it.stage).map(item => (
                    <div key={item.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "5px 0", borderBottom: "1px solid #f2f0ec" }}>
                      <div style={{ width: 14, height: 14, borderRadius: 3, border: "1.5px solid #ccc", flexShrink: 0, marginTop: 2 }} />
                      <div style={{ fontSize: 11, color: "#222", lineHeight: 1.5 }}>{item.text}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : activeRoom === "__conflicts__" ? (
            <div style={{ maxWidth: 720 }}>
              <div style={{ fontSize: 10, fontFamily: "monospace", color: "#bbb", letterSpacing: "0.1em", marginBottom: 12 }}>КОНФЛІКТИ МІЖ ФАЙЛАМИ</div>
              {(conflicts || []).map((c, i) => (
                <div key={i} style={{ marginBottom: 10, padding: "10px 14px", background: "#fff5f5", border: "1px solid #f5c6c6", borderLeft: "3px solid #e74c3c", borderRadius: 6 }}>
                  <div style={{ fontSize: 12, color: "#333", lineHeight: 1.6 }}>{c}</div>
                </div>
              ))}
            </div>
          ) : activeRoom === "__roadmap__" ? (
            <div style={{ maxWidth: 720 }}>
              <div style={{ fontSize: 10, fontFamily: "monospace", color: "#bbb", letterSpacing: "0.1em", marginBottom: 16 }}>РОАДМАП ПРОЕКТУ</div>
              {(roadmap || []).sort((a, b) => (a.order || 0) - (b.order || 0)).map((step, i) => (
                <div key={i} style={{ marginBottom: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <div style={{ width: 22, height: 22, borderRadius: "50%", background: STAGE_COLOR[step.stage] || "#888", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#fff", fontFamily: "monospace", fontWeight: 700, flexShrink: 0 }}>{step.order || i + 1}</div>
                    <span style={{ fontSize: 13, fontWeight: 700, color: STAGE_COLOR[step.stage] || "#333" }}>{step.stage}</span>
                  </div>
                  {step.notes && (
                    <div style={{ fontSize: 11, color: "#888", fontStyle: "italic", marginBottom: 8, paddingLeft: 32, lineHeight: 1.5 }}>{step.notes}</div>
                  )}
                  <div style={{ paddingLeft: 32 }}>
                    {(step.tasks || []).map((task, j) => (
                      <div key={j} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0", borderBottom: "1px solid #f0eeea" }}>
                        <span style={{ fontSize: 10, color: STAGE_COLOR[step.stage] || "#888", fontFamily: "monospace", marginTop: 2, flexShrink: 0 }}>→</span>
                        <span style={{ fontSize: 12, color: "#333", lineHeight: 1.5 }}>{task}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : activeRoom === "__comments__" ? (
            <div style={{ maxWidth: 720 }}>
              <div style={{ fontSize: 10, fontFamily: "monospace", color: "#bbb", letterSpacing: "0.1em", marginBottom: 12 }}>КОМЕНТАРІ КЛІЄНТА</div>
              {Object.entries((clientComments || []).reduce((acc, c) => { (acc[c.page] = acc[c.page] || []).push(c.text); return acc; }, {})).map(([page, texts], i) => (
                <div key={i} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 9, fontFamily: "monospace", color: "#bbb", marginBottom: 4 }}>{page}</div>
                  {texts.map((t, j) => <div key={j} style={{ fontSize: 12, color: "#333", padding: "4px 0 4px 12px", borderLeft: "2px solid #e0ddd8", marginBottom: 3 }}>{t}</div>)}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ maxWidth: 720 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a1a", marginBottom: 16 }}>{activeRoom}</div>
              {Object.keys(roomData).length === 0
                ? <div style={{ fontSize: 12, color: "#bbb", fontFamily: "monospace" }}>Немає вимог для цього приміщення</div>
                : Object.entries(roomData).map(([cat, items]) => (
                    <div key={cat} style={{ marginBottom: 16 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                        <div style={{ width: 8, height: 8, borderRadius: 2, background: CAT_COLOR[cat] || "#ccc" }} />
                        <span style={{ fontSize: 9, fontWeight: 700, fontFamily: "monospace", color: "#888", letterSpacing: "0.1em" }}>{cat.toUpperCase()}</span>
                        <span style={{ fontSize: 9, color: "#ccc", fontFamily: "monospace" }}>{items.length}</span>
                      </div>
                      <div style={{ paddingLeft: 14 }}>
                        {items.map(item => <TzItem key={item.id} item={item} onEdit={onEdit} onRemove={onRemove} onOpenRef={(imgRef, itemText) => setLightbox({ imgRef, itemText })} onOpenDoc={(label, itemText) => openDocByLabel(label, itemText)} />)}
                      </div>
                    </div>
                  ))
              }
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Session ─────────────────────────────────────────────────────────────────
const SESSION_KEY = "tz_tool_session";
// Strip imgRef (contains base64) before persisting — only keep imgRefLabel string
function stripImgRefs(byRoom) {
  const out = {};
  Object.entries(byRoom || {}).forEach(([room, cats]) => {
    out[room] = {};
    Object.entries(cats || {}).forEach(([cat, items]) => {
      out[room][cat] = (items || []).map(({ imgRef, ...rest }) => rest);
    });
  });
  return out;
}
function saveSession(data) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch { /* ignore */ } }
function loadSession() { try { const s = localStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null; } catch { return null; } }

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey] = useState(() => { try { return localStorage.getItem("anthropic_api_key") || ""; } catch { return ""; } });
  const [briefText, setBriefText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [err, setErr] = useState("");
  const [stage, setStage] = useState("upload"); // "upload" | "review"

  const [tzProjectType, setTzProjectType] = useState("");
  const [tzRooms, setTzRooms] = useState([]);
  const [tzByRoom, setTzByRoom] = useState({});
  const [tzAnnotation, setTzAnnotation] = useState("");
  const [tzClientComments, setTzClientComments] = useState([]);
  const [tzSowMissing, setTzSowMissing] = useState([]);
  const [tzSowUnclear, setTzSowUnclear] = useState([]);
  const [tzConflicts, setTzConflicts] = useState([]);
  const [tzRoadmap, setTzRoadmap] = useState([]);
  const [tzSources, setTzSources] = useState([]);
  const [tzSourceTags, setTzSourceTags] = useState({}); // { srcId: "furniture" | ... }
  const [tavilyKey, setTavilyKey] = useState(() => { try { return localStorage.getItem("tavily_api_key") || ""; } catch { return ""; } });
  const [searchingLinks, setSearchingLinks] = useState(false);
  const [linkSearchProgress, setLinkSearchProgress] = useState({ done: 0, total: 0 });

  const allFilesList = useFileList();

  const saveKey = k => { setApiKey(k); try { localStorage.setItem("anthropic_api_key", k); } catch { /* ignore */ } };
  const saveTavilyKey = k => { setTavilyKey(k); try { localStorage.setItem("tavily_api_key", k); } catch { /* ignore */ } };

  async function searchLinksWithTavily(byRoomOverride) {
    if (!tavilyKey.trim()) return;
    const SEARCH_CATS = ["Меблі та моделі", "Матеріали та текстури", "Логотип / написи"];
    const source = byRoomOverride || tzByRoom;
    const items = Object.values(source).flatMap(cats => Object.entries(cats)
      .filter(([cat]) => SEARCH_CATS.includes(cat))
      .flatMap(([, items]) => items)
    ).filter(it => !it.links?.length && it.text?.length > 8);

    if (!items.length) return;
    setSearchingLinks(true);
    setLinkSearchProgress({ done: 0, total: items.length });

    const getSearchQuery = async (item) => {
      // If item has an image reference — use Claude Haiku to identify product from image
      if (item.imgRef?.full || item.imgRef?.preview) {
        try {
          const imgData = (item.imgRef.full || item.imgRef.preview).split(",")[1];
          const mediaType = item.imgRef.full?.startsWith("data:image/png") ? "image/png" : "image/jpeg";
          const resp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true", "x-api-key": apiKey },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 40,
              messages: [{ role: "user", content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: imgData } },
                { type: "text", text: `Context: "${item.text}". Identify the specific product. Return ONLY a short search query: brand + model + type, max 7 words, in English. Example: "Minotti Lawrence sofa" or "Flos Aim pendant light"` }
              ]}]
            })
          });
          if (resp.ok) {
            const data = await resp.json();
            const q = data.content?.[0]?.text?.trim();
            if (q && q.length > 3) return q;
          }
        } catch { /* fallback to text */ }
      }
      // No image — extract key terms from text (brand + product, skip generic descriptors)
      const text = item.text;
      const brandMatch = text.match(/[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g);
      const brandQuery = brandMatch?.slice(0, 3).join(" ");
      const catKeyword = {
        "Меблі та моделі": "furniture",
        "Матеріали та текстури": "material",
        "Логотип / написи": "logo brand",
      }[item.category] || "";
      return [brandQuery || text.slice(0, 60), catKeyword].filter(Boolean).join(" ");
    };

    let done = 0;
    await Promise.all(items.map(async item => {
      try {
        const query = await getSearchQuery(item);
        const resp = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${tavilyKey}` },
          body: JSON.stringify({ query, search_depth: "basic", max_results: 3 }),
        });
        if (resp.ok) {
          const data = await resp.json();
          const links = (data.results || []).slice(0, 3).map(r => ({
            url: r.url,
            label: r.title?.slice(0, 50) || r.url.replace(/^https?:\/\//, "").slice(0, 40),
            type: "product",
            query,
          }));
          if (links.length) {
            setTzByRoom(prev => {
              const next = {};
              Object.entries(prev).forEach(([room, cats]) => {
                next[room] = {};
                Object.entries(cats).forEach(([cat, catItems]) => {
                  next[room][cat] = catItems.map(it => it.id === item.id ? { ...it, links } : it);
                });
              });
              return next;
            });
          }
        }
      } catch { /* skip */ }
      setLinkSearchProgress({ done: ++done, total: items.length });
    }));
    setSearchingLinks(false);
  }

  const readyFiles = fl => (fl.files || []).filter(f => !f._loading && !f._error && f._done);

  // Збираємо індекс для img_ref: { preview, full, filename, pageNum, fileLabel }
  const buildImgIndex = () => {
    const idx = {};
    const catCounters = {};
    readyFiles(allFilesList).forEach((f) => {
      const cat = f._category || "Файл";
      catCounters[cat] = (catCounters[cat] || 0) + 1;
      const fileLabel = `${cat} ${catCounters[cat]}`;
      (f.pages || []).filter(p => p._selected !== false).forEach((pg, pi) => {
        if (pg.preview || pg.b64) {
          const entry = { preview: pg.preview, full: pg.b64 ? `data:image/jpeg;base64,${pg.b64}` : pg.preview, filename: f.filename, pageNum: pi + 1, fileLabel, category: cat };
          const key = pi === 0 ? fileLabel.toLowerCase() : `${fileLabel.toLowerCase()} стор.${pi + 1}`;
          idx[key] = entry;
          // Also index without trailing number (e.g. "edison vanity" → first page of that category)
          const keyNoNum = cat.toLowerCase();
          if (!idx[keyNoNum]) idx[keyNoNum] = entry;
          if (pi > 0) {
            // "cat стор.N" without the counter number
            const keyNoNumPage = `${cat.toLowerCase()} стор.${pi + 1}`;
            if (!idx[keyNoNumPage]) idx[keyNoNumPage] = entry;
          }
        }
      });
    });
    return idx;
  };

  // Resolve img_ref from Claude against the index
  // New format: { file: "СТИЛЬ / МУДБОРД 1", page: 2 }
  // Legacy fallback: plain string "СТИЛЬ / МУДБОРД 1 стор.2"
  const resolveImgRef = (imgRef, idx) => {
    if (!imgRef) return null;
    const norm = s => s.replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

    let fileKey, page;
    if (typeof imgRef === 'object' && imgRef.file) {
      fileKey = norm(imgRef.file);
      page = imgRef.page || 1;
    } else {
      // Legacy: parse "FILE стор.N" string
      const s = norm(String(imgRef));
      const m = s.match(/^(.*?)\s+стор\.(\d+)$/);
      fileKey = m ? m[1] : s;
      page = m ? parseInt(m[2]) : 1;
    }

    // Build exact key
    const key = page > 1 ? `${fileKey} стор.${page}` : fileKey;
    if (idx[key]) return idx[key];

    // Fuzzy: find index entry whose file part matches fileKey
    const found = Object.keys(idx).find(k => {
      const kFile = k.replace(/\s+стор\.\d+$/, '');
      return kFile === fileKey || kFile.startsWith(fileKey) || fileKey.startsWith(kFile);
    });
    return found ? idx[found] : null;
  };

  async function parseTz() {
    if (!apiKey.trim()) { setErr("Введіть API ключ Anthropic"); return; }
    const allFiles = readyFiles(allFilesList);
    if (!briefText.trim() && allFiles.length === 0) { setErr("Завантажте матеріали або введіть текст ТЗ"); return; }

    // Check total page count before sending
    const totalSelectedPages = allFiles.reduce((sum, f) => sum + (f.pages || []).filter(p => p._selected !== false && p.b64).length, 0);
    if (totalSelectedPages > 80) {
      setErr(`Забагато сторінок (${totalSelectedPages}). Поверни в галерею та зніми відмітку з частини сторінок — рекомендовано не більше 60.`);
      return;
    }

    // Warn if some files are still loading
    const stillLoading = (allFilesList.files || []).filter(f => f._loading);
    if (stillLoading.length > 0) {
      setErr(`Почекайте — ще обробляється ${stillLoading.length} файл${stillLoading.length > 1 ? "и" : ""}: ${stillLoading.map(f => f.filename).join(", ")}`);
      return;
    }

    setErr(""); setParsing(true);

    // Number files within each category
    const catCounters = {};
    const labeledFiles = allFiles.map(f => {
      const cat = f._category || "Файл";
      catCounters[cat] = (catCounters[cat] || 0) + 1;
      return { ...f, _label: `${cat.toUpperCase()} ${catCounters[cat]}` };
    });

    // File manifest for the prompt
    const manifest = labeledFiles.map(f => `  • ${f._label} [${f.ext || f.type?.toUpperCase()}]: ${f.filename}${f._confidence === "low" ? " (?)" : ""}`).join("\n");

    const imgIndex = buildImgIndex();

    const sowTypes = Object.keys(SOW_TEMPLATES).join(" | ");
    const sowTemplatesText = Object.entries(SOW_TEMPLATES)
      .map(([type, items]) => `${type}:\n${items.map(i => `  - ${i}`).join("\n")}`)
      .join("\n\n");
    const parts = [{ type: "text", text: `Ти — досвідчений 3D-художник і ПМ, який аналізує вхідні матеріали ПЕРЕД стартом проекту. Твоя ціль — не просто витягнути вимоги, а підготувати повний роадмап і чеклист здачі: щоб команда (візуалізатор + АД + ПМ) могла звірити результат з тим що просив клієнт.

МОВА: вхідні матеріали можуть бути будь-якою мовою — українська, російська, суржик, англійська, змішана. Розпізнавай вимоги незалежно від мови. Відповідай завжди ТІЛЬКИ українською.

ПРИНЦИП РОБОТИ:
1. Читай ВСІ файли разом, не по черзі — зіставляй бриф з кресленнями, референси з коментарями, специфікації між собою
2. Думай як художник: "що мені треба зробити щоб запустити цей проект і не переробляти?"
3. Витягуй ВСІ посилання (URL) з будь-яких джерел — меблі, каталоги, Pinterest, Behance, бренди, кольори, мапи — і прив'язуй до конкретної вимоги
4. Фіксуй суперечності між файлами — якщо бриф суперечить кресленню або референс не відповідає текстовому опису

DWG/DXF КРЕСЛЕННЯ: якщо є DWG або DXF — обов'язково:
- Витягни назви приміщень з "ПІДПИСИ" та "ШАРИ" — вони формують список rooms
- Витягни розміри — додавай у "Креслення та планування" з img_ref на цей файл
- Зіставляй з брифом: розбіжності → conflicts та sow_unclear
- Приміщення на кресленні без вимог → sow_missing

ВХІДНІ ФАЙЛИ:
${manifest || "(немає файлів)"}

ТЗ ТЕКСТ:
${briefText.trim() || "(дивись прикріплені матеріали)"}

ВАЖЛИВО: для кожної сторінки надано "витягнутий текст" — використовуй його як першочергове джерело для розмірів, назв, специфікацій та чисел. Зображення доповнює текст.

ЗАВДАННЯ 1 — project_type:
Один варіант: ${sowTypes}

ЗАВДАННЯ 2 — project_annotation:
Стислий опис (3-5 речень): тип простору, площа/кількість приміщень, стиль, ключові матеріали, що надано.

ЗАВДАННЯ 3 — rooms:
Масив приміщень/зон. Загальні вимоги (стиль, освітлення, камери, дедлайн) — у "Загальне". Якщо приміщення не визначені — тільки ["Загальне"].

ЗАВДАННЯ 4 — tz_by_room:
КРИТИЧНО: знайди ВСІ вимоги, розбий по приміщеннях та категоріях.
Структура: { "Приміщення": { "Категорія": [ {id, text, quote, stage, source, img_ref, links} ] } }
- text = ПОВНИЙ опис: назва + матеріал + колір + відділка + розмір + марка
- АТОМАРНІСТЬ: один item = одна вимога. Якщо речення містить кілька об'єктів ("диван + крісло + стіл") — розбивай на окремі items
- quote = дослівна цитата з вхідних матеріалів, або null
- stage = "Моделінг" | "Текстуринг" | "Світло" | "Камери" | "Пост-продакшн" | "Видача"
- img_ref: { "file": "мітка файлу", "page": N } або null  (напр. {"file":"СТИЛЬ / МУДБОРД 1","page":2}; page=1 якщо перша сторінка)
- source: назва категорії вхідного файлу
- links: масив всіх URL пов'язаних з цією вимогою — [ { url, label, type } ] де type: "furniture"|"material"|"reference"|"color"|"catalog"|"product"|"map"|"other". Якщо посилань немає — []
- Категорії: "Матеріали та текстури", "Меблі та моделі", "Сезон / атмосфера", "Тип освітлення", "Креслення та планування", "Логотип / написи", "Вимоги клієнта", "Специфічні запити"

ЗАВДАННЯ 5 — conflicts:
Суперечності між вхідними файлами. Кожен рядок: "Конфлікт: [що суперечить чому]. Джерело A: [файл/цитата]. Джерело B: [файл/цитата]. Питання: [що треба уточнити]"
Приклад: "Конфлікт: колір стін вітальні. Джерело A: бриф — 'стіни темно-сірі'. Джерело B: мудборд стор.2 — референс зі світлими стінами. Питання: який варіант пріоритетний?"

ЗАВДАННЯ 6 — roadmap:
Впорядкований план роботи по виробничих стадіях. Для кожної стадії — конкретні задачі в порядку виконання з урахуванням залежностей між ними.
Структура: [ { stage, order, notes, tasks: ["задача 1", "задача 2"] } ]
- stage = одна з: "Моделінг" | "Текстуринг" | "Світло" | "Камери" | "Пост-продакшн" | "Видача"
- order = порядковий номер (1, 2, 3...)
- notes = важливий коментар для цієї стадії (залежності, ризики, що треба уточнити до початку)
- tasks = конкретні дії для виконання

ЗАВДАННЯ 7 — sow_missing та sow_unclear:
Звір вхідні матеріали з повним SOW-шаблоном для визначеного типу проекту (project_type з Завдання 1).
Шаблони по типах:
${sowTemplatesText}

- sow_missing: пункти шаблону яких ПОВНІСТЮ немає у вхідних матеріалах. Формат: "Назва пункту — що саме потрібно надати клієнту"
- sow_unclear: пункти шаблону які є але неповні або незрозумілі. Формат: "Назва пункту — знайдено: [що є]. Неясно: [конкретне питання]"
- Для кожного відсутнього пункту вказуй дефолтне значення якщо воно є в шаблоні (напр. "Час доби — відсутнє. Дефолт: день")

ЗАВДАННЯ 8 — sources:
Посторінковий журнал джерел — що знайдено в кожному файлі/сторінці.
Структура: [ { file: "мітка файлу", page: N, found: [ { id, type, description } ] } ]
- file: мітка файлу (напр. "МУДБОРД 1", "КРЕСЛЕННЯ", "ТЗ ТЕКСТОМ")
- page: номер сторінки (1 якщо одна)
- found: список знайденого на цій сторінці
- type: "furniture" | "material" | "lighting" | "style_ref" | "time_of_day" | "weather" | "render_quality" | "camera" | "dimensions" | "logo" | "comment" | "other"
- description: коротко що саме (назва продукту, бренд, опис)
Включай ВСЕ що є на сторінці — меблі, матеріали, референси стилю, час доби, погоду, якість рендеру, ракурси, розміри.

ЗАВДАННЯ 9 — client_comments:
ВСІ коментарі клієнта — в рамках, нотатках, стрілках.
{ page: "мітка файлу", text: "дослівно" }

ВІДПОВІДАЙ ТІЛЬКИ JSON:
{"project_type":"...","project_annotation":"...","rooms":["Загальне","Вітальня"],"tz_by_room":{"Загальне":{"Тип освітлення":[{"id":"tz1","text":"Тепле освітлення 2700K, торшер біля дивану","quote":"тепле освітлення, торшер біля дивану","stage":"Світло","source":"ТЗ ТЕКСТОМ","img_ref":null,"links":[]}]},"Вітальня":{"Меблі та моделі":[{"id":"tz2","text":"Диван — Minotti Lawrence, сірий велюр","quote":"диван Minotti Lawrence сірий","stage":"Моделінг","source":"МАТЕРІАЛИ 1","img_ref":{"file":"МАТЕРІАЛИ 1","page":2},"links":[{"url":"https://minotti.com/...","label":"Minotti Lawrence","type":"furniture"}]}]}},"conflicts":["Конфлікт: колір стін вітальні. Джерело A: бриф — 'темно-сірі стіни'. Джерело B: мудборд стор.2 — світлий інтер'єр. Питання: який варіант пріоритетний?"],"roadmap":[{"stage":"Моделінг","order":1,"notes":"Перед стартом уточнити план у клієнта — є розбіжність між кресленням і брифом","tasks":["Змоделювати планування за DWG","Базові меблі по референсах"]}],"sources":[{"file":"МУДБОРД 1","page":2,"found":[{"id":"src1","type":"furniture","description":"Диван Minotti Lawrence, сірий велюр"},{"id":"src2","type":"style_ref","description":"Скандинавський стиль, натуральні матеріали"},{"id":"src3","type":"lighting","description":"Торшер Flos IC F підлоговий"}]},{"file":"КРЕСЛЕННЯ","page":1,"found":[{"id":"src4","type":"dimensions","description":"Вітальня 6×4м, спальня 4×3.5м"},{"id":"src5","type":"camera","description":"Ракурс з кута вітальні на зону відпочинку"}]}],"sow_missing":["Час доби — вкажіть ранок/день/вечір для кожного ракурсу"],"sow_unclear":["Колір стін — знайдено: 'замінити зелений'. Неясно: на який колір — потрібен RAL/HEX"],"client_comments":[{"page":"ТЗ ТЕКСТОМ 1","text":"..."}]}` }];

    parts.push(...filesToParts(labeledFiles, "ФАЙЛ"));

    try {
      const result = await callAPI(parts, 2, apiKey);

      // Validate top-level structure
      if (!result || typeof result !== 'object') throw new Error("Відповідь не є об'єктом");
      if (!result.tz_by_room || typeof result.tz_by_room !== 'object' || Array.isArray(result.tz_by_room))
        throw new Error("tz_by_room відсутній або має невірний тип");

      let counter = 1;
      // Normalize tz_by_room: attach imgPreview and ensure ids
      const byRoom = {};
      Object.entries(result.tz_by_room || {}).forEach(([room, cats]) => {
        byRoom[room] = {};
        const catsObj = Array.isArray(cats) ? {} : (cats || {});
        Object.entries(catsObj).forEach(([cat, items]) => {
          const safeItems = Array.isArray(items) ? items : [];
          byRoom[room][cat] = safeItems.map(item => ({
            id: item.id || `tz${counter++}`,
            category: cat,
            room,
            text: item.text || "",
            quote: item.quote || null,
            stage: PRODUCTION_STAGES.includes(item.stage) ? item.stage : null,
            source: item.source || "",
            imgRef: item.img_ref ? resolveImgRef(item.img_ref, imgIndex) : null,
            imgRefLabel: item.img_ref
              ? (typeof item.img_ref === 'object' && item.img_ref.file
                  ? `${item.img_ref.file}${item.img_ref.page > 1 ? ` стор.${item.img_ref.page}` : ''}`
                  : String(item.img_ref))
              : null,
            links: Array.isArray(item.links) ? item.links : (item.link ? [{ url: item.link, label: item.link, type: "other" }] : []),
          }));
        });
      });
      const rooms = result.rooms?.length ? result.rooms : Object.keys(byRoom);
      setTzProjectType(result.project_type || "");
      setTzRooms(rooms);
      setTzByRoom(byRoom);
      setTzAnnotation(result.project_annotation || "");
      setTzClientComments(result.client_comments || []);
      setTzSowMissing(result.sow_missing || []);
      setTzSowUnclear(result.sow_unclear || []);
      setTzConflicts(result.conflicts || []);
      setTzRoadmap(result.roadmap || []);
      setTzSources(result.sources || []);
      setTzSourceTags({});
      saveSession({ savedAt: new Date().toISOString(), projectType: result.project_type || "", rooms, tzByRoom: stripImgRefs(byRoom), tzAnnotation: result.project_annotation || "", clientComments: result.client_comments || [], sowMissing: result.sow_missing || [], sowUnclear: result.sow_unclear || [], conflicts: result.conflicts || [], roadmap: result.roadmap || [], sources: result.sources || [] });
      setStage("review");
      if (tavilyKey.trim()) searchLinksWithTavily(byRoom);
    } catch (e) {
      setErr(`Помилка: ${e.message}`);
    }
    setParsing(false);
  }

  const handleEditItem = (id, text) => setTzByRoom(prev => {
    const next = {};
    Object.entries(prev).forEach(([room, cats]) => {
      next[room] = {};
      Object.entries(cats).forEach(([cat, items]) => { next[room][cat] = items.map(it => it.id === id ? { ...it, text } : it); });
    });
    return next;
  });
  const handleRemoveItem = (id) => setTzByRoom(prev => {
    const next = {};
    Object.entries(prev).forEach(([room, cats]) => {
      next[room] = {};
      Object.entries(cats).forEach(([cat, items]) => { const f = items.filter(it => it.id !== id); if (f.length) next[room][cat] = f; });
      if (!Object.keys(next[room]).length) delete next[room];
    });
    return next;
  });

  // Загрузка попередньої сесії
  const lastSession = loadSession();

  if (stage === "review") {
    return (
      <TzReviewStep
        projectType={tzProjectType}
        rooms={tzRooms}
        tzByRoom={tzByRoom}
        annotation={tzAnnotation}
        clientComments={tzClientComments}
        sowMissing={tzSowMissing}
        sowUnclear={tzSowUnclear}
        conflicts={tzConflicts}
        roadmap={tzRoadmap}
        sources={tzSources}
        files={readyFiles(allFilesList)}
        sourceTags={tzSourceTags}
        onSourceTag={(id, tag) => setTzSourceTags(prev => ({ ...prev, [id]: tag }))}
        onEdit={handleEditItem}
        onRemove={handleRemoveItem}
        onBack={() => setStage("upload")}
        onSearchLinks={tavilyKey ? searchLinksWithTavily : null}
        searchingLinks={searchingLinks}
        linkSearchProgress={linkSearchProgress}
      />
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f5f4f1" }}>
      {/* Header */}
      <div style={{ background: "#1a1a1a", padding: "10px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#f2f0ec", fontFamily: "monospace", letterSpacing: "0.1em" }}>ТЗ TOOL</span>
        <span style={{ fontSize: 9, color: "#666", fontFamily: "monospace" }}>v0.2 — розбір ТЗ для 3D-візуалізації</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 9, color: "#555", fontFamily: "monospace" }}>TAVILY</span>
            <input
              value={tavilyKey}
              onChange={e => saveTavilyKey(e.target.value)}
              type="password"
              placeholder="tvly-..."
              style={{ background: "#2a2a2a", border: `1px solid ${tavilyKey ? "#27ae60" : "#333"}`, color: "#aaa", fontSize: 10, fontFamily: "monospace", padding: "4px 8px", borderRadius: 4, width: 140, outline: "none" }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 9, color: "#555", fontFamily: "monospace" }}>ANTHROPIC</span>
            <input
              value={apiKey}
              onChange={e => saveKey(e.target.value)}
              type="password"
              placeholder="sk-ant-..."
              style={{ background: "#2a2a2a", border: "1px solid #333", color: "#aaa", fontSize: 10, fontFamily: "monospace", padding: "4px 8px", borderRadius: 4, width: 160, outline: "none" }}
            />
            <button onClick={() => saveKey("")} style={{ fontSize: 9, fontFamily: "monospace", background: "none", border: "none", color: "#444", cursor: "pointer", padding: "0 2px" }} title="Вийти / змінити ключ">×</button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px" }}>
        {/* Pipeline badge */}
        <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
          {["1. Прийом файлів", "2. Класифікація", "3. Валідація", "4. Запит доп.", "5. Парсинг по стадіях", "6. Markdown", "7. Фінальне ТЗ", "8. Звіт"].map((s, i) => (
            <div key={i} style={{ fontSize: 9, fontFamily: "monospace", color: i < 2 ? "#1a1a1a" : "#bbb", background: i < 2 ? "#e8e6e1" : "#f0eeea", padding: "3px 8px", borderRadius: 4, border: i < 2 ? "1px solid #ccc" : "1px solid #e8e6e1" }}>{s}</div>
          ))}
        </div>

        {/* Upload zone */}
        <div style={{ marginBottom: 20 }}>
          <UploadBox label="МАТЕРІАЛИ ПРОЕКТУ" files={allFilesList.files} onAdd={allFilesList.add} onRemove={allFilesList.remove} onUpdateFile={allFilesList.updateById} color="#1a1a1a" note="PDF, DOCX, TXT, зображення, DWG, DXF, Excel, CSV — будь-які файли" />
        </div>

        {/* Brief text */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.14em", color: "#888", marginBottom: 5, fontFamily: "monospace" }}>ТЕКСТ БРИФУ (опціонально)</div>
          <textarea
            value={briefText}
            onChange={e => setBriefText(e.target.value)}
            rows={4}
            placeholder="Опишіть проект: тип простору, стиль / атмосфера, ключові матеріали, кількість ракурсів, формат фінальних файлів, дедлайн. Або просто завантажте файли вище — текст необов'язковий."
            style={{ width: "100%", border: "1px solid #e0ddd8", borderRadius: 8, padding: "10px 12px", fontSize: 12, fontFamily: "inherit", resize: "vertical", outline: "none", background: "#fff", color: "#333", lineHeight: 1.6 }}
          />
        </div>

        {err && <div style={{ background: "#fff5f5", border: "1px solid #e74c3c44", borderRadius: 8, padding: "10px 14px", fontSize: 11, color: "#e74c3c", fontFamily: "monospace", marginBottom: 12 }}>{err}</div>}

        {/* Pre-parse stats */}
        {(() => {
          const ready = readyFiles(allFilesList);
          const loading = (allFilesList.files || []).filter(f => f._loading);
          const totalPages = ready.reduce((sum, f) => sum + (f.pages || []).filter(p => p._selected !== false && p.b64).length, 0);
          const tooMany = totalPages > 80;
          if (!ready.length && !loading.length) return null;
          return (
            <div style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {loading.length > 0 && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#e67e22", background: "#fff8f0", border: "1px solid #f0c060", padding: "3px 8px", borderRadius: 4 }}>⏳ обробляється: {loading.length} файл{loading.length > 1 ? "и" : ""}</span>}
              {totalPages > 0 && <span style={{ fontSize: 10, fontFamily: "monospace", color: tooMany ? "#e74c3c" : "#555", background: tooMany ? "#fff5f5" : "#f5f4f1", border: `1px solid ${tooMany ? "#e74c3c44" : "#ddd"}`, padding: "3px 8px", borderRadius: 4 }}>
                {tooMany ? "⚠ " : ""}{totalPages} стор. до API{tooMany ? " — забагато, зменш вибір" : ""}
              </span>}
              {ready.length > 0 && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#888", background: "#f5f4f1", border: "1px solid #ddd", padding: "3px 8px", borderRadius: 4 }}>{ready.length} файл{ready.length > 1 ? "и" : ""} готові</span>}
            </div>
          );
        })()}

        {/* CTA */}
        <button
          onClick={parseTz}
          disabled={parsing}
          style={{ width: "100%", background: parsing ? "#444" : "#1a1a1a", color: "#f2f0ec", border: "none", padding: "16px", fontSize: 13, letterSpacing: "0.14em", fontFamily: "monospace", cursor: parsing ? "not-allowed" : "pointer", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}
        >
          {parsing
            ? <><div style={{ width: 14, height: 14, border: "2px solid #666", borderTop: "2px solid #fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />РОЗБИРАЮ ТЗ…</>
            : "РОЗІБРАТИ ТЗ →"
          }
        </button>

        {/* Return to active session */}
        {tzRooms.length > 0 && (
          <div style={{ marginTop: 16, padding: "10px 14px", background: "#f0f7ff", border: "1px solid #b3d4f5", borderRadius: 8, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 10, color: "#2980b9", fontFamily: "monospace", flex: 1 }}>
              {tzProjectType || "Сесія"} · {tzRooms.length} кімн.
            </span>
            <button
              onClick={() => setStage("review")}
              style={{ fontSize: 10, fontFamily: "monospace", background: "#2980b9", border: "none", color: "#fff", padding: "4px 12px", borderRadius: 4, cursor: "pointer", fontWeight: 700 }}
            >
              Повернутися →
            </button>
          </div>
        )}

        {/* Last session */}
        {lastSession && tzRooms.length === 0 && (
          <div style={{ marginTop: 16, padding: "10px 14px", background: "#fff", border: "1px solid #e8e6e1", borderRadius: 8, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 10, color: "#888", fontFamily: "monospace", flex: 1 }}>
              Остання сесія: {new Date(lastSession.savedAt).toLocaleString()}
            </span>
            <button
              onClick={() => {
                setTzProjectType(lastSession.projectType || "");
                setTzRooms(lastSession.rooms || []);
                setTzByRoom(lastSession.tzByRoom || {});
                setTzAnnotation(lastSession.tzAnnotation || "");
                setTzClientComments(lastSession.clientComments || []);
                setTzSowMissing(lastSession.sowMissing || []);
                setTzSowUnclear(lastSession.sowUnclear || []);
                setTzConflicts(lastSession.conflicts || []);
                setTzRoadmap(lastSession.roadmap || []);
                setTzSources(lastSession.sources || []);
                setTzSourceTags({});
                setStage("review");
              }}
              style={{ fontSize: 10, fontFamily: "monospace", background: "transparent", border: "1px solid #ddd", color: "#555", padding: "4px 10px", borderRadius: 4, cursor: "pointer" }}
            >
              Відновити
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
