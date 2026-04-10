import { useState, useRef, useCallback } from "react";

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
  const { lib, database, handler } = await dwgLoadDatabase(file);
  try {
    const mBlock = database.mBlock;
    if (!mBlock) throw new Error("mBlock not found");
    const entities = mBlock.entities;
    const ET = lib.DRW_ETYPE;

    // Collect points for bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const expand = (x, y) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    };

    const n = entities.size();
    for (let i = 0; i < n; i++) {
      const e = entities.get(i);
      const t = e.eType.value;
      if (t === ET.LINE.value || t === ET.ARC.value || t === ET.CIRCLE.value) {
        expand(e.basePoint.x, e.basePoint.y);
        if (t === ET.LINE.value) expand(e.secPoint.x, e.secPoint.y);
        if (t === ET.CIRCLE.value || t === ET.ARC.value) {
          expand(e.basePoint.x - e.radius, e.basePoint.y - e.radius);
          expand(e.basePoint.x + e.radius, e.basePoint.y + e.radius);
        }
      } else if (t === ET.LWPOLYLINE.value) {
        const vl = e.getVertexList();
        for (let j = 0; j < vl.size(); j++) { const v = vl.get(j); expand(v.x, v.y); }
      } else if (t === ET.POLYLINE.value) {
        const vl = e.getVertexList();
        for (let j = 0; j < vl.size(); j++) { const v = vl.get(j); expand(v.basePoint.x, v.basePoint.y); }
      }
    }

    if (!isFinite(minX)) throw new Error("No renderable geometry");
    const W = 1024, H = 1024, PAD = 32;
    const dw = maxX - minX || 1, dh = maxY - minY || 1;
    const scale = Math.min((W - PAD * 2) / dw, (H - PAD * 2) / dh);
    const tx = x => PAD + (x - minX) * scale;
    const ty = y => H - PAD - (y - minY) * scale; // flip Y

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 1;

    for (let i = 0; i < n; i++) {
      const e = entities.get(i);
      const t = e.eType.value;
      ctx.beginPath();
      if (t === ET.LINE.value) {
        ctx.moveTo(tx(e.basePoint.x), ty(e.basePoint.y));
        ctx.lineTo(tx(e.secPoint.x), ty(e.secPoint.y));
        ctx.stroke();
      } else if (t === ET.CIRCLE.value) {
        ctx.arc(tx(e.basePoint.x), ty(e.basePoint.y), e.radius * scale, 0, Math.PI * 2);
        ctx.stroke();
      } else if (t === ET.ARC.value) {
        // DXF arcs: CCW, Y-flipped so angles negate
        const cx = tx(e.basePoint.x), cy = ty(e.basePoint.y), r = e.radius * scale;
        const sa = -e.startAngle * Math.PI / 180;
        const ea = -e.endAngle * Math.PI / 180;
        ctx.arc(cx, cy, r, sa, ea, true);
        ctx.stroke();
      } else if (t === ET.LWPOLYLINE.value) {
        const vl = e.getVertexList(); const sz = vl.size();
        if (sz === 0) continue;
        const closed = (e.flags & 1) !== 0;
        ctx.moveTo(tx(vl.get(0).x), ty(vl.get(0).y));
        for (let j = 0; j < sz; j++) {
          const v = vl.get(j);
          const vn = vl.get((j + 1) % sz);
          if (!vn || (!closed && j === sz - 1)) continue;
          if (v.bulge !== 0) {
            // Bulge → arc
            const x1 = tx(v.x), y1 = ty(v.y), x2 = tx(vn.x), y2 = ty(vn.y);
            const b = v.bulge, d = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
            const r = Math.abs(d * (b * b + 1) / (4 * Math.abs(b)));
            const a = Math.atan2(y2 - y1, x2 - x1) - Math.PI / 2 * Math.sign(b);
            const mx = (x1 + x2) / 2 + (r - d * Math.abs(b) / 2) * Math.cos(a) * Math.sign(b);
            const my = (y1 + y2) / 2 + (r - d * Math.abs(b) / 2) * Math.sin(a) * Math.sign(b);
            const ang1 = Math.atan2(y1 - my, x1 - mx);
            const ang2 = Math.atan2(y2 - my, x2 - mx);
            ctx.arc(mx, my, r, ang1, ang2, b < 0);
          } else {
            ctx.lineTo(tx(vn.x), ty(vn.y));
          }
        }
        if (closed) ctx.closePath();
        ctx.stroke();
      } else if (t === ET.POLYLINE.value) {
        const vl = e.getVertexList(); const sz = vl.size();
        if (sz === 0) continue;
        ctx.moveTo(tx(vl.get(0).basePoint.x), ty(vl.get(0).basePoint.y));
        for (let j = 1; j < sz; j++) ctx.lineTo(tx(vl.get(j).basePoint.x), ty(vl.get(j).basePoint.y));
        if (e.flags & 1) ctx.closePath();
        ctx.stroke();
      }
    }

    return canvas.toDataURL("image/jpeg", 0.85);
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
    return `=== DWG ФАЙЛ: ${file.name} ===\n⚠️ Конвертація не вдалась: ${e.message}\nРекомендація: збережіть як DXF з AutoCAD.`;
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
            {filtered.map((pg, rawIdx) => {
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
  const ico = { pdf: "📄", dwg: "⚠️", dxf: "📐", excel: "📊", text: "📝", image: "🖼️", other: "📎" };
  return (
    <div>
      {label && <div style={{ fontSize: 10, letterSpacing: "0.14em", color: "#888", marginBottom: note ? 2 : 5, fontFamily: "monospace" }}>{label}</div>}
      {note && <div style={{ fontSize: 9, color: "#bbb", fontFamily: "monospace", marginBottom: 5 }}>{note}</div>}
      <div onDragEnter={e => { e.preventDefault(); ctr.current++; setDrag(true); }} onDragLeave={e => { e.preventDefault(); if (--ctr.current === 0) setDrag(false); }} onDragOver={e => e.preventDefault()} onDrop={onDrop}
        style={{ border: `2px dashed ${drag ? color : "#ddd"}`, borderRadius: 10, padding: 8, background: drag ? color + "11" : "#fafafa", minHeight: 90, display: "flex", flexDirection: "column", justifyContent: files.length === 0 ? "center" : "flex-start" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", justifyContent: files.length === 0 ? "center" : "flex-start" }}>
          {files.map((f, i) => {
            const prev = f.preview || f.pages?.[0]?.preview;
            return (
              <div key={f._id || i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, flexShrink: 0 }}>
                <div draggable={!f._loading && f._done} onDragStart={() => { _dragging = { file: f, remove: () => onRemove(i) }; }} onDragEnd={() => { _dragging = null; }}
                  style={{ position: "relative", width: 70, height: 70, cursor: (!f._loading && f._done) ? "grab" : "default" }}>
                  {prev && f.type !== "excel"
                    ? <img src={prev} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 5, border: `1px solid ${f._error ? "#e74c3c" : f._done ? color : "#ddd"}`, filter: f._loading ? "brightness(0.4)" : "none" }} />
                    : <div style={{ width: "100%", height: "100%", borderRadius: 5, border: `1px solid ${f._error ? "#e74c3c" : f._done ? color : "#ddd"}`, background: f._error ? "#3a1a1a" : f.type === "dwg" ? "#0a1929" : f.type === "excel" ? "#0d2b0d" : "#f0eeea", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2 }}>
                        <div style={{ fontSize: 18 }}>{f._error ? "⚠️" : ico[f.type] || ico.other}</div>
                        <div style={{ fontSize: 7, color: f._error ? "#ff8888" : "#888", fontFamily: "monospace", textAlign: "center", padding: "0 3px", wordBreak: "break-all", lineHeight: 1.2 }}>{f._error ? "ERR" : (f.ext || f.type?.toUpperCase() || "...")}</div>
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
                  {!f._loading && f._done && <div style={{ position: "absolute", top: -5, left: -5, width: 15, height: 15, background: color, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "#fff" }}>✓</div>}
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
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 16000, messages: [{ role: "user", content: parts }] })
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
  "Інтер'єр житловий":    ["Планування з розмірами","Стиль / атмосфера / референси","Матеріали підлоги","Матеріали стін","Оздоблення стелі","Освітлення (тип та схема)","Меблі та декор","Час доби та сезон","Ракурси / кількість зображень","Формат та дедлайн"],
  "Інтер'єр комерційний": ["Планування з зонуванням","Концепція бренду / фірмові кольори","Матеріали та оздоблення","Обладнання та меблі","Освітлення","Наявність людей на рендері","Логотип та написи","Ракурси / кількість зображень","Формат та дедлайн"],
  "Екстер'єр / фасад":    ["Фасадні креслення","Матеріали оздоблення","Ландшафт та оточення","Час доби та пора року","Погодні умови","Ракурси","Формат та дедлайн"],
  "Мастерплан":           ["Генплан з масштабом","Типологія будівель","Озеленення та ландшафт","Дороги та інфраструктура","Час доби та сезон","Стиль подачі","Формат та дедлайн"],
  "Продуктова візуалізація": ["Модель / технічні креслення","Матеріали та покриття","Тло та оточення","Освітлення","Ракурси","Формат та дедлайн"],
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

function TzItem({ item, onEdit, onRemove, onOpenRef }) {
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
          {!ref && item.imgRefLabel && <span style={{ fontSize: 9, color: "#e67e22", fontFamily: "monospace" }} title={`Claude вказав: ${item.imgRefLabel}`}>⚠ реф не знайдено</span>}
          {item.link && <a href={item.link} target="_blank" rel="noreferrer" style={{ fontSize: 9, color: "#3498db", fontFamily: "monospace", textDecoration: "none" }}>🔗 {item.link.replace(/^https?:\/\//, "").slice(0, 40)}</a>}
        </div>
      </div>
      <button onClick={() => onRemove(item.id)} style={{ background: "none", border: "none", color: "#ddd", cursor: "pointer", fontSize: 14, flexShrink: 0, lineHeight: 1, padding: "2px 4px" }} title="Видалити">×</button>
    </div>
  );
}

function TzReviewStep({ projectType, rooms, tzByRoom, sowMissing, sowUnclear, clientComments, annotation, onEdit, onRemove, onBack }) {
  const allRooms = rooms?.length ? ["Загальне", ...rooms.filter(r => r !== "Загальне")] : ["Загальне"];
  const [viewMode, setViewMode] = useState("rooms"); // "rooms" | "stages"
  const [activeRoom, setActiveRoom] = useState(allRooms[0]);
  const [activeStage, setActiveStage] = useState(PRODUCTION_STAGES[0]);
  const [lightbox, setLightbox] = useState(null); // { imgRef, itemText }

  const allItems = Object.values(tzByRoom || {}).flatMap(r => Object.values(r)).flat();

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

  return (
    <div style={{ minHeight: "100vh", background: "#f5f4f1", display: "flex", flexDirection: "column" }}>
      {lightbox && <ImageLightbox imgRef={lightbox.imgRef} itemText={lightbox.itemText} onClose={() => setLightbox(null)} />}
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
        <button onClick={() => window.print()} style={{ fontSize: 9, fontFamily: "monospace", background: "none", border: "1px solid #333", color: "#666", padding: "3px 10px", borderRadius: 4, cursor: "pointer" }}>PDF</button>
        <button onClick={copyMd} style={{ fontSize: 9, fontFamily: "monospace", background: "none", border: "1px solid #333", color: "#666", padding: "3px 10px", borderRadius: 4, cursor: "pointer" }}>MD</button>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
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
          <div style={{ display: "flex", padding: "8px 14px", gap: 4, borderBottom: "1px solid #f0eeea" }}>
            <button onClick={() => setViewMode("rooms")} style={{ flex: 1, fontSize: 8, fontFamily: "monospace", padding: "4px 0", border: "none", borderRadius: 3, cursor: "pointer", background: viewMode === "rooms" ? "#1a1a1a" : "#f0eeea", color: viewMode === "rooms" ? "#fff" : "#888", fontWeight: viewMode === "rooms" ? 700 : 400 }}>КІМНАТИ</button>
            <button onClick={() => setViewMode("stages")} style={{ flex: 1, fontSize: 8, fontFamily: "monospace", padding: "4px 0", border: "none", borderRadius: 3, cursor: "pointer", background: viewMode === "stages" ? "#1a1a1a" : "#f0eeea", color: viewMode === "stages" ? "#fff" : "#888", fontWeight: viewMode === "stages" ? 700 : 400 }}>СТАДІЇ</button>
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
                          {items.map(item => <TzItem key={item.id} item={item} onEdit={onEdit} onRemove={onRemove} onOpenRef={(imgRef, itemText) => setLightbox({ imgRef, itemText })} />)}
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
                        {items.map(item => <TzItem key={item.id} item={item} onEdit={onEdit} onRemove={onRemove} onOpenRef={(imgRef, itemText) => setLightbox({ imgRef, itemText })} />)}
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

  const allFilesList = useFileList();

  const saveKey = k => { setApiKey(k); try { localStorage.setItem("anthropic_api_key", k); } catch { /* ignore */ } };

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

  // Resolve img_ref label from Claude against the index with fuzzy fallback
  const resolveImgRef = (label, idx) => {
    if (!label) return null;
    // Normalize: strip [brackets], collapse spaces
    const norm = s => s.replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const key = norm(label);
    if (idx[key]) return idx[key];
    // Without trailing " 1", " 2", etc. (Claude may omit the counter)
    const noNum = key.replace(/\s+\d+(\s+стор\.\d+)?$/, '$1').replace(/^\s+|\s+$/g, '');
    if (idx[noNum]) return idx[noNum];
    // Partial prefix match
    const found = Object.keys(idx).find(k => k.startsWith(noNum) || noNum.startsWith(k));
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
    const parts = [{ type: "text", text: `Ти — AI-асистент для структурування ТЗ на 3D-візуалізацію.

ВАЖЛИВО: для кожної сторінки надано "витягнутий текст" — це точний машинний текст зі сторінки. Використовуй його як першочергове джерело для розмірів, назв матеріалів, специфікацій та будь-яких чисел. Зображення доповнює текст — не навпаки.

ВХІДНІ ФАЙЛИ:
${manifest || "(немає файлів)"}

ТЗ ТЕКСТ:
${briefText.trim() || "(дивись прикріплені матеріали)"}

ЗАВДАННЯ 1 — project_type:
Один варіант: ${sowTypes}

ЗАВДАННЯ 2 — project_annotation:
Стислий опис (3-5 речень): тип простору, площа/кількість приміщень, стиль, ключові матеріали, що надано.

ЗАВДАННЯ 3 — rooms:
Масив приміщень/зон. Загальні вимоги (стиль, освітлення, камери, дедлайн) — у "Загальне". Якщо приміщення не визначені — тільки ["Загальне"].

ЗАВДАННЯ 4 — tz_by_room:
КРИТИЧНО: знайди ВСІ вимоги, розбий по приміщеннях та категоріях.
Структура: { "Приміщення": { "Категорія": [ {id, text, quote, stage, source, img_ref, link} ] } }
- text = ПОВНИЙ опис: назва + матеріал + колір + відділка + розмір + марка
- quote = дослівна цитата з вхідних матеріалів (copy-paste речення або фрази), або null якщо не процитовано
- stage = виробнича стадія: "Моделінг" | "Текстуринг" | "Світло" | "Камери" | "Пост-продакшн" | "Видача"
- img_ref: мітка файлу (напр. "СТИЛЬ / МУДБОРД 1 стор.2") або null
- source: назва категорії вхідного файлу
- Категорії: "Матеріали та текстури", "Меблі та моделі", "Сезон / атмосфера", "Тип освітлення", "Креслення та планування", "Логотип / написи", "Вимоги клієнта", "Специфічні запити"

ЗАВДАННЯ 5 — sow_missing та sow_unclear:
Порівняй з SOW-шаблоном для визначеного типу проекту.
- sow_missing: що повністю відсутнє. Формат кожного рядка: "Назва пункту — що саме потрібно надати клієнту"
  Приклад: "Час доби — вкажіть ранок/день/вечір/ніч для кожного з ракурсів"
- sow_unclear: що є але неповно або суперечливо. Формат кожного рядка: "Назва пункту — знайдено: [що саме є в матеріалах]. Неясно: [конкретне питання до клієнта]"
  Приклад: "Camera change — знайдено: 'змінити камеру в спальні'. Неясно: не вказано новий ракурс — потрібен кут огляду, висота камери або референс"
  Приклад: "Колір стін — знайдено: 'замінити зелений колір'. Неясно: не вказано на який саме колір — потрібен RAL/HEX або візуальний референс"

ЗАВДАННЯ 6 — client_comments:
ВСІ коментарі клієнта — в рамках, нотатках, стрілках.
{ page: "мітка файлу", text: "дослівно" }

ВІДПОВІДАЙ ТІЛЬКИ JSON:
{"project_type":"...","project_annotation":"...","rooms":["Загальне","Вітальня"],"tz_by_room":{"Загальне":{"Тип освітлення":[{"id":"tz1","text":"Тепле освітлення 2700K, торшер біля дивану","quote":"тепле освітлення, торшер біля дивану","stage":"Світло","source":"ТЗ ТЕКСТОМ","img_ref":null,"link":null}]},"Вітальня":{"Матеріали та текстури":[{"id":"tz2","text":"Підлога — дубовий паркет, відтінок натуральний, матовий лак","quote":"дубовий паркет натуральний матовий","stage":"Текстуринг","source":"МАТЕРІАЛИ 1","img_ref":"МАТЕРІАЛИ 1 стор.2","link":null}]}},"sow_missing":["Час доби — вкажіть ранок/день/вечір для кожного ракурсу"],"sow_unclear":["Camera change — знайдено: 'змінити камеру'. Неясно: не вказано новий ракурс"],"client_comments":[{"page":"ТЗ ТЕКСТОМ 1","text":"..."}]}` }];

    parts.push(...filesToParts(labeledFiles, "ФАЙЛ"));

    try {
      const result = await callAPI(parts, 2, apiKey);
      let counter = 1;
      // Normalize tz_by_room: attach imgPreview and ensure ids
      const byRoom = {};
      Object.entries(result.tz_by_room || {}).forEach(([room, cats]) => {
        byRoom[room] = {};
        Object.entries(cats || {}).forEach(([cat, items]) => {
          byRoom[room][cat] = (items || []).map(item => ({
            id: item.id || `tz${counter++}`,
            category: cat,
            room,
            text: item.text || "",
            quote: item.quote || null,
            stage: PRODUCTION_STAGES.includes(item.stage) ? item.stage : null,
            source: item.source || "",
            imgRef: item.img_ref ? resolveImgRef(item.img_ref, imgIndex) : null,
            imgRefLabel: item.img_ref || null,
            link: item.link || null,
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
      saveSession({ savedAt: new Date().toISOString(), projectType: result.project_type || "", rooms, tzByRoom: byRoom, tzAnnotation: result.project_annotation || "", clientComments: result.client_comments || [], sowMissing: result.sow_missing || [], sowUnclear: result.sow_unclear || [] });
      setStage("review");
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
        onEdit={handleEditItem}
        onRemove={handleRemoveItem}
        onBack={() => setStage("upload")}
      />
    );
  }

  // ── Onboarding screen ──────────────────────────────────────────────────────
  if (!apiKey) {
    return (
      <div style={{ minHeight: "100vh", background: "#0f0f0f", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ width: "100%", maxWidth: 420 }}>
          {/* Logo */}
          <div style={{ fontFamily: "monospace", fontSize: 10, letterSpacing: "0.2em", color: "#444", marginBottom: 12 }}>ТЗ TOOL</div>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: "#f2f0ec", lineHeight: 1.25, marginBottom: 10 }}>
            Розбір ТЗ для<br />3D-візуалізації
          </h1>
          <p style={{ fontSize: 13, color: "#666", lineHeight: 1.6, marginBottom: 32 }}>
            Завантажуєш файли клієнта — отримуєш структуроване ТЗ по кімнатах і виробничих стадіях.<br />
            Для роботи потрібен ключ Anthropic API.
          </p>

          {/* Key input */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontFamily: "monospace", color: "#555", letterSpacing: "0.12em", marginBottom: 8 }}>ANTHROPIC API KEY</div>
            <input
              autoFocus
              type="password"
              placeholder="sk-ant-api03-..."
              style={{ width: "100%", background: "#1a1a1a", border: "1px solid #2a2a2a", color: "#f2f0ec", fontSize: 13, fontFamily: "monospace", padding: "12px 14px", borderRadius: 8, outline: "none", letterSpacing: "0.04em" }}
              onKeyDown={e => { if (e.key === "Enter" && e.target.value.trim()) saveKey(e.target.value.trim()); }}
              onChange={e => { if (e.target.value.trim().startsWith("sk-ant")) saveKey(e.target.value.trim()); }}
            />
          </div>
          <button
            style={{ width: "100%", background: "#f2f0ec", color: "#1a1a1a", border: "none", borderRadius: 8, padding: "13px", fontSize: 12, fontFamily: "monospace", fontWeight: 700, letterSpacing: "0.12em", cursor: "pointer", marginBottom: 20 }}
            onClick={e => { const inp = e.target.closest("div").previousSibling?.querySelector("input"); if (inp?.value.trim()) saveKey(inp.value.trim()); }}
          >
            ПОЧАТИ →
          </button>

          {/* Help */}
          <div style={{ fontSize: 11, color: "#444", lineHeight: 1.7 }}>
            <div>Де взяти ключ: <span style={{ color: "#666", fontFamily: "monospace" }}>console.anthropic.com → API Keys</span></div>
            <div style={{ marginTop: 4 }}>Ключ зберігається тільки локально у браузері.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f5f4f1" }}>
      {/* Header */}
      <div style={{ background: "#1a1a1a", padding: "10px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#f2f0ec", fontFamily: "monospace", letterSpacing: "0.1em" }}>ТЗ TOOL</span>
        <span style={{ fontSize: 9, color: "#666", fontFamily: "monospace" }}>v0.1 — розбір ТЗ для 3D-візуалізації</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 9, color: "#555", fontFamily: "monospace" }}>API KEY</span>
          <input
            value={apiKey}
            onChange={e => saveKey(e.target.value)}
            type="password"
            placeholder="sk-ant-..."
            style={{ background: "#2a2a2a", border: "1px solid #333", color: "#aaa", fontSize: 10, fontFamily: "monospace", padding: "4px 8px", borderRadius: 4, width: 180, outline: "none" }}
          />
          <button onClick={() => saveKey("")} style={{ fontSize: 9, fontFamily: "monospace", background: "none", border: "none", color: "#444", cursor: "pointer", padding: "0 2px" }} title="Вийти / змінити ключ">×</button>
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

        {/* Last session */}
        {lastSession && (
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
