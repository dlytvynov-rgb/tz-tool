import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { LibreDwg, Dwg_File_Type } from "@mlightcad/libredwg-web";
import { jsonrepair } from "jsonrepair";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

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

    // ── Text + annotations extraction (parallel) ──
    let pageText = null;
    let isTextRich = false;
    let hasFormFields = false;
    let hasEmbeddedImages = false;
    try {
      const [tc, annotations, opList] = await Promise.all([
        page.getTextContent(),
        page.getAnnotations().catch(() => []),
        page.getOperatorList().catch(() => null),
      ]);

      // Detect embedded raster images on page
      if (opList) {
        const IMAGE_OPS = new Set([82, 83, 84]); // paintImageXObject, paintInlineImageXObject, paintImageMaskXObject
        hasEmbeddedImages = opList.fnArray.some(op => IMAGE_OPS.has(op));
      }

      // Text layer reconstruction
      if (tc.items.length > 0) {
        const LINE_TOL = 4;
        const buckets = new Map();
        for (const item of tc.items) {
          if (!item.str) continue;
          const yKey = Math.round(item.transform[5] / LINE_TOL);
          if (!buckets.has(yKey)) buckets.set(yKey, []);
          buckets.get(yKey).push({ x: item.transform[4], str: item.str });
        }
        const sortedLines = [...buckets.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([, items]) => { items.sort((a, b) => a.x - b.x); return items.map(it => it.str).join("").replace(/\s{2,}/g, " ").trim(); })
          .filter(l => l.length > 0);
        const reconstructed = sortedLines.join("\n");
        if (reconstructed.length > 20) {
          pageText = reconstructed.slice(0, 8000);
          isTextRich = reconstructed.length > 150;
        }
      }

      // Annotations: form fields (checkboxes, inputs) + comments
      const annotLines = [];
      for (const ann of annotations) {
        if (ann.subtype === "Widget") {
          const val = ann.fieldValue;
          const name = ann.alternativeText || ann.fieldName || "";
          if (ann.checkBox || ann.radioButton) {
            const checked = val && val !== "Off" && val !== "";
            if (checked) { annotLines.push(`☑ ${name}: ${val}`); hasFormFields = true; }
          } else if (ann.fieldType === "Tx" && val) {
            annotLines.push(`[FIELD] ${name}: ${val}`); hasFormFields = true;
          } else if (ann.fieldType === "Ch" && val) {
            annotLines.push(`[SELECT] ${name}: ${val}`); hasFormFields = true;
          }
        } else if ((ann.subtype === "Text" || ann.subtype === "FreeText") && ann.contents) {
          annotLines.push(`[COMMENT] ${ann.contents}`);
        }
      }
      if (annotLines.length > 0) {
        pageText = (pageText ? pageText + "\n\n" : "") + "FORM DATA:\n" + annotLines.join("\n");
      }
    } catch { /* ignore */ }

    // ── Image rendering ──
    // Pure text pages (no embedded images): small JPEG — only for layout context
    // Pages with embedded images (moodboards, annotated refs): high-res PNG/JPEG
    // Scans (no text at all): high-res PNG lossless
    const needsHighRes = !isTextRich || hasEmbeddedImages;
    const imgMaxDim = needsHighRes ? MAX_DIM : 900;
    const vp0 = page.getViewport({ scale: 1 });
    const sc = Math.min(imgMaxDim / vp0.width, imgMaxDim / vp0.height, 2.0);
    const vp = page.getViewport({ scale: sc });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    let b64, mediaType;
    if (!isTextRich) {
      // Scan / drawing — lossless PNG
      const pngB64 = canvas.toDataURL("image/png").split(",")[1];
      if (pngB64 && pngB64.length * 0.75 <= 4e6) {
        b64 = pngB64; mediaType = "image/png";
      } else {
        let q = 0.88;
        b64 = canvas.toDataURL("image/jpeg", q).split(",")[1];
        while (b64 && b64.length * 0.75 > 4e6 && q > 0.25) { q -= 0.07; b64 = canvas.toDataURL("image/jpeg", q).split(",")[1]; }
        mediaType = "image/jpeg";
      }
    } else {
      // Text page — JPEG, quality depends on whether it also has embedded images
      let q = hasEmbeddedImages ? 0.78 : 0.6;
      b64 = canvas.toDataURL("image/jpeg", q).split(",")[1];
      while (b64 && b64.length * 0.75 > 4e6 && q > 0.25) { q -= 0.07; b64 = canvas.toDataURL("image/jpeg", q).split(",")[1]; }
      mediaType = "image/jpeg";
    }

    const previewCanvas = document.createElement("canvas");
    const pr = Math.min(400 / canvas.width, 300 / canvas.height, 1);
    previewCanvas.width = Math.round(canvas.width * pr); previewCanvas.height = Math.round(canvas.height * pr);
    previewCanvas.getContext("2d").drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
    const preview = previewCanvas.toDataURL("image/jpeg", 0.7);

    pages.push({ b64, preview, mediaType, text: pageText, _textRich: isTextRich, _hasImages: hasEmbeddedImages, _hasFormFields: hasFormFields, pageNum: i });
    onProg?.(Math.round(i / n * 100));
  }
  return { pages, type: "pdf", filename: file.name, ext: "PDF" };
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
          while (b64 && b64.length * 0.75 > 2.5e6 && qq > 0.3) { qq -= 0.1; b64 = canvas.toDataURL("image/jpeg", qq).split(",")[1]; }
          const preview = canvas.toDataURL("image/jpeg", 0.75);
          onProg?.(100);
          res({ b64, preview, type: "image", filename: file.name, ext: file.name.split(".").pop().toUpperCase(), pages: [{ b64, preview }] });
        } catch (err) { rej(err); }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ─── DWG parsing via @mlightcad/libredwg-web ──────────────────────────────────
let _libredwgPromise = null;
async function loadLibreDwg() {
  if (_libredwgPromise) return _libredwgPromise;
  _libredwgPromise = LibreDwg.create("");
  return _libredwgPromise;
}

function renderDwgToCanvas(entities) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const expand = (x, y) => {
    if (isFinite(x) && isFinite(y)) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  };
  for (const e of entities) {
    try {
      if (e.type === "LINE") { expand(e.startPoint.x, e.startPoint.y); expand(e.endPoint.x, e.endPoint.y); }
      else if (e.type === "ARC" || e.type === "CIRCLE") { expand(e.center.x - e.radius, e.center.y - e.radius); expand(e.center.x + e.radius, e.center.y + e.radius); }
      else if (e.type === "LWPOLYLINE") { e.vertices?.forEach(v => expand(v.x, v.y)); }
      else if (e.type === "TEXT") { expand(e.startPoint?.x, e.startPoint?.y); }
      else if (e.type === "MTEXT") { expand(e.insertionPoint?.x, e.insertionPoint?.y); }
    } catch {}
  }
  if (!isFinite(minX)) return null;

  const W = 2048, H = 2048, PAD = 56;
  const scale = Math.min((W - PAD * 2) / (maxX - minX || 1), (H - PAD * 2) / (maxY - minY || 1));
  const tx = x => PAD + (x - minX) * scale;
  const ty = y => H - PAD - (y - minY) * scale;

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0a1929"; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#7ec8e3"; ctx.lineWidth = 1.2; ctx.lineCap = "round";

  for (const e of entities) {
    try {
      ctx.beginPath();
      if (e.type === "LINE") {
        ctx.moveTo(tx(e.startPoint.x), ty(e.startPoint.y));
        ctx.lineTo(tx(e.endPoint.x), ty(e.endPoint.y));
        ctx.stroke();
      } else if (e.type === "CIRCLE") {
        ctx.arc(tx(e.center.x), ty(e.center.y), Math.abs(e.radius * scale), 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.type === "ARC") {
        ctx.arc(tx(e.center.x), ty(e.center.y), Math.abs(e.radius * scale),
          -e.endAngle * Math.PI / 180, -e.startAngle * Math.PI / 180, false);
        ctx.stroke();
      } else if (e.type === "LWPOLYLINE" && e.vertices?.length > 0) {
        ctx.moveTo(tx(e.vertices[0].x), ty(e.vertices[0].y));
        for (let j = 1; j < e.vertices.length; j++) ctx.lineTo(tx(e.vertices[j].x), ty(e.vertices[j].y));
        if (e.flag & 1) ctx.closePath();
        ctx.stroke();
      } else if (e.type === "TEXT" && e.text) {
        ctx.fillStyle = "#fff";
        ctx.font = `${Math.max(8, Math.min((e.textHeight || 1) * scale * 0.8, 24))}px monospace`;
        ctx.fillText(e.text.slice(0, 60), tx(e.startPoint?.x || 0), ty(e.startPoint?.y || 0));
      } else if (e.type === "MTEXT" && e.text) {
        const clean = e.text.replace(/\\[a-zA-Z0-9.;|]+;?/g, "").replace(/[{}]/g, "").trim();
        if (clean) {
          ctx.fillStyle = "#ffeb80";
          ctx.font = `${Math.max(8, Math.min((e.textHeight || 1) * scale * 0.8, 24))}px monospace`;
          ctx.fillText(clean.slice(0, 60), tx(e.insertionPoint?.x || 0), ty(e.insertionPoint?.y || 0));
        }
      }
    } catch {}
  }
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function parseDWG(file) {
  try {
    const libredwg = await loadLibreDwg();
    const buf = await file.arrayBuffer();
    const dwg = libredwg.dwg_read_data(buf, Dwg_File_Type.DWG);
    const db = libredwg.convert(dwg);
    libredwg.dwg_free(dwg);

    const entities = db.entities || [];
    const texts = [], layers = new Set(), entityCounts = {};

    for (const e of entities) {
      entityCounts[e.type] = (entityCounts[e.type] || 0) + 1;
      if (e.layer) layers.add(e.layer);
      if (e.type === "TEXT" && e.text?.trim()) {
        texts.push(e.text.trim());
      } else if (e.type === "MTEXT" && e.text) {
        const clean = e.text.replace(/\\[a-zA-Z0-9.;|]+;?/g, "").replace(/[{}]/g, "").trim();
        if (clean) texts.push(clean);
      } else if (e.type === "ATTDEF" && e.text?.trim()) {
        texts.push(e.text.trim());
      }
    }

    const uniqueTexts = [...new Set(texts)].slice(0, 120);
    const layerList = [...layers].filter(l => l && l !== "0").slice(0, 40);

    let textContent = `=== DWG: ${file.name} ===\n`;
    if (layerList.length) textContent += `LAYERS: ${layerList.join(", ")}\n`;
    if (Object.keys(entityCounts).length) textContent += `ENTITIES: ${Object.entries(entityCounts).map(([k, v]) => `${k}×${v}`).join(", ")}\n`;
    if (uniqueTexts.length) textContent += `LABELS:\n${uniqueTexts.map(t => "  • " + t).join("\n")}\n`;

    const preview = renderDwgToCanvas(entities);
    const pages = preview ? [{ b64: preview.split(",")[1], preview }] : [];
    return { pages, type: "dwg", filename: file.name, ext: "DWG", textContent };
  } catch (e) {
    console.warn(`[DWG] ${file.name}:`, e);
    return { pages: [], type: "dwg", filename: file.name, ext: "DWG", textContent: `[DWG read error: ${e.message}]` };
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
  let out = "=== DXF DRAWING ===\n";
  if (layers.length) out += "LAYERS (" + layers.length + "): " + layers.join(", ") + "\n";
  if (Object.keys(entityCounts).length) out += "ENTITIES: " + Object.entries(entityCounts).map(e => e[0] + "x" + e[1]).join(", ") + "\n";
  if (uniqueDims.length) out += "DIMENSIONS (mm): " + uniqueDims.join(", ") + "\n";
  if (uniqueTexts.length) out += "LABELS:\n" + uniqueTexts.map(t => "  • " + t).join("\n") + "\n";
  return out || "[DXF empty]";
}

// ─── JSZip loader ─────────────────────────────────────────────────────────────
async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
  return window.JSZip;
}

const SUPPORTED_EXTS = [".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif",
  ".dxf", ".dwg", ".xlsx", ".xls", ".csv", ".docx", ".txt", ".md", ".fbx"];

async function parseFBX(file) {
  try {
    const buf = await file.arrayBuffer();
    const loader = new FBXLoader();
    const group = loader.parse(buf, "");

    const objects = [];
    const materials = new Set();

    group.traverse(obj => {
      if (obj.isMesh) {
        const box = new THREE.Box3().setFromObject(obj);
        const size = new THREE.Vector3();
        box.getSize(size);
        const entry = { name: obj.name || obj.uuid.slice(0, 8) };
        if (size.x > 0) entry.size = `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)}`;
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach(m => { if (m.name) materials.add(m.name); entry.material = mats.map(m => m.name || "unnamed").join(", "); });
        }
        objects.push(entry);
      }
    });

    const lines = [`FBX MODEL: ${file.name}`, `Objects (${objects.length}):`];
    objects.forEach(o => {
      let line = `  • ${o.name}`;
      if (o.size) line += ` — size: ${o.size}`;
      if (o.material) line += ` — material: ${o.material}`;
      lines.push(line);
    });
    if (materials.size > 0) lines.push(`\nMaterials: ${[...materials].join(", ")}`);

    return { pages: [], type: "fbx", filename: file.name, ext: "FBX", textContent: lines.join("\n").slice(0, 12000) };
  } catch (e) {
    return { pages: [], type: "fbx", filename: file.name, ext: "FBX", textContent: `[FBX read error: ${e.message}]` };
  }
}

// Pack image files into a contact-sheet PDF (2×2 grid, filename caption under each image)
async function packImagesToPdf(imageFiles) {
  const PAGE_W = 1200, PAGE_H = 1600;
  const COLS = 2, ROWS = 2, PER_PAGE = COLS * ROWS;
  const PAD = 30, CAPTION_H = 28, GAP = 20;
  const cellW = (PAGE_W - PAD * 2 - GAP * (COLS - 1)) / COLS;
  const cellH = (PAGE_H - PAD * 2 - GAP * (ROWS - 1) - CAPTION_H * ROWS) / ROWS;

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < imageFiles.length; i += PER_PAGE) {
    const batch = imageFiles.slice(i, i + PER_PAGE);
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

    for (let j = 0; j < batch.length; j++) {
      const { filename, b64, mediaType } = batch[j];
      const col = j % COLS, row = Math.floor(j / COLS);
      const x = PAD + col * (cellW + GAP);
      const y = PAGE_H - PAD - (row + 1) * (cellH + CAPTION_H + GAP) + GAP;

      try {
        const imgBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const img = mediaType === "image/png"
          ? await pdfDoc.embedPng(imgBytes)
          : await pdfDoc.embedJpg(imgBytes);
        const { width, height } = img;
        const scale = Math.min(cellW / width, cellH / height);
        const dw = width * scale, dh = height * scale;
        const ox = x + (cellW - dw) / 2, oy = y + CAPTION_H + (cellH - dh) / 2;
        page.drawImage(img, { x: ox, y: oy, width: dw, height: dh });
      } catch { /* skip unembeddable image */ }

      const name = (filename || "").replace(/\.[^.]+$/, "");
      const maxChars = Math.floor(cellW / 7);
      const caption = name.length > maxChars ? name.slice(0, maxChars - 1) + "…" : name;
      page.drawText(caption, { x, y: y + 4, size: 11, font, color: rgb(0.3, 0.3, 0.3), maxWidth: cellW });
    }
  }

  const pdfBytes = await pdfDoc.save();
  return new File([pdfBytes], "_references_packed.pdf", { type: "application/pdf" });
}

// ─── Universal file processor ─────────────────────────────────────────────────
async function processFile(file, onProg, sig) {
  if (!file) return null;
  const nm = file.name.toLowerCase();
  if (nm.endsWith(".dxf")) {
    onProg?.(30);
    try { const text = await file.text(); onProg?.(80); const parsed = parseDXF(text); onProg?.(100); return { pages: [], type: "dxf", filename: file.name, ext: "DXF", textContent: parsed }; }
    catch { onProg?.(100); return { pages: [], type: "dxf", filename: file.name, ext: "DXF", textContent: "[DXF read error]" }; }
  }
  if (nm.endsWith(".dwg")) {
    onProg?.(10);
    const result = await parseDWG(file);
    onProg?.(100);
    return result;
  }
  if (nm.endsWith(".xlsx") || nm.endsWith(".xls") || nm.endsWith(".csv")) {
    onProg?.(30);
    try { const text = nm.endsWith(".csv") ? await file.text() : await excelToText(file); onProg?.(100); return { pages: [], type: "excel", filename: file.name, ext: nm.endsWith(".csv") ? "CSV" : "XLSX", textContent: text.slice(0, 12000) }; }
    catch { onProg?.(100); return { pages: [], type: "excel", filename: file.name, ext: "XLSX", textContent: "[read error]" }; }
  }
  if (nm.endsWith(".rtf")) {
    onProg?.(30);
    try {
      const raw = await file.text();
      const text = raw.replace(/\{\*\\[^{}]*\}/g, "").replace(/\\bin\d+ ?/g, "").replace(/\\'[0-9a-fA-F]{2}/g, "").replace(/\\[a-z]+[-]?\d* ?/g, "").replace(/[{}\\]/g, "").replace(/\r?\n{3,}/g, "\n\n").trim();
      onProg?.(100); return { pages: [], type: "text", filename: file.name, ext: "RTF", textContent: (text || "[RTF empty]").slice(0, 12000) };
    } catch { onProg?.(100); return { pages: [], type: "text", filename: file.name, ext: "RTF", textContent: "[RTF read error]" }; }
  }
  if (nm.endsWith(".txt") || nm.endsWith(".md")) {
    onProg?.(30);
    try { const text = await file.text(); onProg?.(100); return { pages: [], type: "text", filename: file.name, ext: nm.split(".").pop().toUpperCase(), textContent: text.slice(0, 12000) }; }
    catch { onProg?.(100); return { pages: [], type: "text", filename: file.name, ext: "TXT", textContent: "[read error]" }; }
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
    } catch { onProg?.(100); return { pages: [], type: "other", filename: file.name, ext: "DOCX", textContent: "[DOCX read error]" }; }
  }
  if (nm.endsWith(".fbx")) { onProg?.(10); const result = await parseFBX(file); onProg?.(100); return result; }
  if (nm.endsWith(".pdf")) return pdfToPages(file, onProg, sig);
  if (file.type.startsWith("image/")) return imageToB64(file, onProg, sig);
  onProg?.(100);
  return { pages: [], type: "other", filename: file.name, ext: file.name.split(".").pop().toUpperCase() };
}

// ─── AI File Classification ───────────────────────────────────────────────────
const FILE_CATEGORIES = ["Floor Plan", "Elevation / Section", "Style / Moodboard", "Materials & Finishes", "Furniture & Objects", "Brief (Text)", "Tech Requirements"];
const CATEGORY_COLOR = {
  "Floor Plan": "#2980b9", "Elevation / Section": "#e67e22", "Style / Moodboard": "#8e44ad",
  "Materials & Finishes": "#27ae60", "Furniture & Objects": "#16a085",
  "Brief (Text)": "#2c3e50", "Tech Requirements": "#7f8c8d", "Unclassified": "#bbb",
};
const CATEGORY_SHORT = {
  "Floor Plan": "PLAN", "Elevation / Section": "ELEV.", "Style / Moodboard": "STYLE",
  "Materials & Finishes": "MAT.", "Furniture & Objects": "FURN.",
  "Brief (Text)": "BRIEF", "Tech Requirements": "TECH", "Unclassified": "?",
};

const PAGE_CATEGORIES = ["Floor Plan", "Elevation / Section", "Specification", "Detail", "Legend", "Title / TOC", "Other"];
const PAGE_CAT_COLOR = {
  "Floor Plan": "#2980b9", "Elevation / Section": "#e67e22", "Specification": "#27ae60",
  "Detail": "#8e44ad", "Legend": "#16a085",
  "Title / TOC": "#7f8c8d", "Other": "#bbb",
};
const PAGE_CAT_SHORT = {
  "Floor Plan": "PLAN", "Elevation / Section": "ELEV.", "Specification": "SPEC.",
  "Detail": "DETAIL", "Legend": "LEGEND",
  "Title / TOC": "TITLE", "Other": "OTHER",
};

async function classifyPageWithAI(b64, pageNum, filename, apiKey) {
  if (!apiKey) return "Other";
  const cats = PAGE_CATEGORIES.join(", ");
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true", "x-api-key": apiKey },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 60, messages: [{ role: "user", content: [
        { type: "text", text: `Classify page ${pageNum} from file "${filename}" for a 3D visualization project.\nCategories: ${cats}.\nReply ONLY with JSON: {"category":"..."}` },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
      ] }] }),
    });
    const data = await resp.json();
    const raw = (data.content || []).map(b => b.text || "").join("");
    const p = extractJson(raw);
    if (p) return PAGE_CATEGORIES.includes(p.category) ? p.category : "Other";
  } catch { /* ignore */ }
  return "Other";
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
  if (!apiKey) return { category: "Unclassified", confidence: "low" };
  const cats = FILE_CATEGORIES.join(", ");
  const parts = [];
  parts.push({ type: "text", text: `You are a file classifier for a 3D interior/exterior visualization project.\nCategories: ${cats}.\nFile: ${processedFile.filename}${processedFile.textContent ? `\nContent (excerpt):\n${processedFile.textContent.slice(0, 1500)}` : ""}\nReply ONLY with JSON, no explanation: {"category":"one of the categories above","confidence":"high|medium|low"}` });
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
    const p = extractJson(raw);
    if (p) return { category: FILE_CATEGORIES.includes(p.category) ? p.category : "Unclassified", confidence: p.confidence || "low" };
  } catch { /* ignore */ }
  return { category: "Unclassified", confidence: "low" };
}

// ─── File list hook ───────────────────────────────────────────────────────────
function useFileList() {
  const ref = useRef([]);
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick(t => t + 1), []);
  const add = useCallback(async (file) => {
    // ZIP: extract and add each file inside recursively
    if (file.name.toLowerCase().endsWith(".zip")) {
      try {
        const JSZip = await loadJSZip();
        const zip = await JSZip.loadAsync(await file.arrayBuffer());
        const entries = Object.values(zip.files).filter(f => !f.dir);
        const supported = entries.filter(f => SUPPORTED_EXTS.some(ext => f.name.toLowerCase().endsWith(ext)));
        if (supported.length === 0) return; // nothing to process
        for (const entry of supported) {
          const buf = await entry.async("arraybuffer");
          const name = entry.name.split("/").pop(); // strip folder path
          const innerFile = new File([buf], name);
          add(innerFile);
        }
      } catch {
        // silently skip unreadable ZIP
      }
      return;
    }

    const id = "f" + Date.now() + "_" + Math.random().toString(36).slice(2);
    const ctrl = new AbortController();
    ref.current = [...ref.current, { _id: id, _loading: true, _progress: 0, _ctrl: ctrl, filename: file.name, _size: file.size, preview: null, pages: [], type: null }];
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
        ref.current = ref.current.map(x => x._id === id ? { ...x, _category: "Unclassified", _classifying: false } : x);
        bump();
      });

      // Classify individual pages in background (for multi-page files)
      if (pagesWithMeta.length > 1) {
        classifyPagesWithAI(id, pagesWithMeta, d.filename, (fileId, pageIdx, patch) => {
          ref.current = ref.current.map(x => x._id === fileId
            ? { ...x, pages: x.pages.map((pg, i) => i === pageIdx ? { ...pg, ...patch } : pg) }
            : x);
          bump();
        }).catch(() => {});
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
  const clearAll = useCallback(() => { ref.current = []; bump(); }, [bump]);
  return { files: ref.current, ref, add, remove, updateById, clearAll };
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
            <span>{pages.length} pages · {selectedCount} selected</span>
            {textCount > 0 && <span style={{ color: "#2ecc71" }}>T {textCount} with text</span>}
            {textCount === 0 && <span style={{ color: "#e67e22" }}>scan — images only</span>}
          </div>
        </div>
        {/* Filter buttons */}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <button onClick={() => setFilter("all")} style={{ fontSize: 8, fontFamily: "monospace", padding: "3px 8px", borderRadius: 3, border: "none", cursor: "pointer", background: filter === "all" ? "#fff" : "#333", color: filter === "all" ? "#000" : "#aaa" }}>ALL</button>
          {categories.map(cat => (
            <button key={cat} onClick={() => setFilter(cat)} style={{ fontSize: 8, fontFamily: "monospace", padding: "3px 8px", borderRadius: 3, border: "none", cursor: "pointer", background: filter === cat ? (PAGE_CAT_COLOR[cat] || "#555") : "#333", color: "#fff" }}>
              {PAGE_CAT_SHORT[cat] || cat}
            </button>
          ))}
        </div>
        {/* Select/deselect all */}
        <button onClick={() => pages.forEach((_, i) => onTogglePage(i, true))} style={{ fontSize: 9, fontFamily: "monospace", padding: "4px 10px", background: "#2ecc71", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}>All ✓</button>
        <button onClick={() => pages.forEach((_, i) => onTogglePage(i, false))} style={{ fontSize: 9, fontFamily: "monospace", padding: "4px 10px", background: "#444", color: "#aaa", border: "none", borderRadius: 4, cursor: "pointer" }}>Deselect all</button>
        <button onClick={() => {
          pages.forEach((pg, i) => onTogglePage(i, pg._category !== "Title / TOC" && pg._category !== "Other"));
        }} style={{ fontSize: 9, fontFamily: "monospace", padding: "4px 10px", background: "#2980b9", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}>Auto-select</button>
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
                      title="View extracted text"
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
                    ? <div style={{ fontSize: 8, color: "#bbb", fontFamily: "monospace", animation: "pulse 1s infinite" }}>classifying…</div>
                    : <>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: catColor, flexShrink: 0 }} />
                        <select
                          value={cat || "Other"}
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
              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#f39c12", fontWeight: 700 }}>TEXT</span>
              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#555" }}>p. {textPage + 1}</span>
              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#444", flex: 1, textAlign: "right" }}>
                {pages[textPage].text ? `${pages[textPage].text.length} chars` : ""}
              </span>
              <button onClick={() => setTextPage(null)} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
              {pages[textPage].text
                ? <pre style={{ fontSize: 10, color: "#bbb", fontFamily: "monospace", whiteSpace: "pre-wrap", lineHeight: 1.7, margin: 0 }}>{pages[textPage].text}</pre>
                : <div style={{ fontSize: 10, color: "#555", fontFamily: "monospace" }}>No text layer — page is a scan or image.</div>
              }
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ background: "#1a1a1a", padding: "10px 20px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <div style={{ fontSize: 10, color: "#888", fontFamily: "monospace", flex: 1 }}>
          <strong style={{ color: "#f2f0ec" }}>{selectedCount}</strong> of {pages.length} pages selected for Claude
          {textCount > 0 && <span style={{ color: "#2ecc71", marginLeft: 8 }}>· {textCount} with text</span>}
        </div>
        <button onClick={onClose} style={{ fontSize: 11, fontFamily: "monospace", padding: "8px 20px", background: "#f2f0ec", color: "#1a1a1a", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 700 }}>
          Confirm selection →
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
            const textFailed = f.textContent?.includes("read error") || f.textContent?.includes("DWG read error");
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
                {/* File format badge — not shown for PDF (has its own X/Y badge) */}
                {f.ext && f.type !== "pdf" && (
                  <div style={{ fontSize: 7, fontFamily: "monospace", fontWeight: 700,
                    color: f._error ? "#fff" : f._done ? "#fff" : "#555",
                    background: f._error ? "#e74c3c" : f._done ? "#27ae60" : "#eee",
                    padding: "2px 5px", borderRadius: 3, letterSpacing: "0.08em", maxWidth: 70, textAlign: "center" }}>
                    {f.ext}
                  </div>
                )}
                {!f._loading && f.type === "pdf" && f.pages?.length > 0 && (() => {
                  const textPages = f.pages.filter(p => p.text).length;
                  const total = f.pages.length;
                  const isScan = textPages === 0;
                  return (
                    <div style={{ fontSize: 7, fontFamily: "monospace", fontWeight: 700,
                      color: "#fff", background: "#27ae60",
                      padding: "2px 5px", borderRadius: 3, letterSpacing: "0.08em", maxWidth: 70, textAlign: "center" }}
                      title={isScan ? `Scanned PDF — processed as images (${total} pages)` : `Text PDF — ${textPages} of ${total} pages have text`}>
                      {`PDF ${total}`}
                    </div>
                  );
                })()}
              </div>
            );
          })}
          <div onClick={() => inputRef.current.click()} style={{ width: 70, height: 70, border: `2px dashed ${color}`, borderRadius: 8, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
            <div style={{ fontSize: 20, color }}>+</div>
            <div style={{ fontSize: 8, color: "#bbb", fontFamily: "monospace" }}>add</div>
          </div>
        </div>
        {!drag && <div style={{ fontSize: 8, color: "#ccc", fontFamily: "monospace", textAlign: "center", marginTop: 4 }}>↑ or drop here</div>}
      </div>
      {files.length > 0 && (
        <div style={{ marginTop: 8, borderRadius: 6, border: "1px solid #e8e8e8", overflow: "hidden", fontSize: 10, fontFamily: "monospace" }}>
          {files.map((f, i) => {
            const isLoading = f._loading;
            const isError = !isLoading && f._error;
            const isPdfScan = !isLoading && !isError && f.type === "pdf" && f.pages?.length > 0 && f.pages.filter(p => p.text).length === 0;
            const isOk = !isLoading && !isError && f._done;
            const bg = isError ? "#fff5f5" : isOk ? "#f5fff8" : "#fafafa";
            const dot = isLoading ? "⏳" : isError ? "✕" : isOk ? "✓" : "·";
            const dotColor = isError ? "#e74c3c" : isOk ? "#27ae60" : "#aaa";
            let msg = "";
            if (isLoading) msg = "processing...";
            else if (isError) msg = f._error.length > 60 ? f._error.slice(0, 60) + "…" : f._error;
            else if (isPdfScan) msg = "ready for analysis";
            else if (isOk) msg = "ready for analysis";
            const shortName = f.filename?.length > 30 ? f.filename.slice(0, 28) + "…" : f.filename;
            return (
              <div key={f._id || i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", background: bg, borderBottom: i < files.length - 1 ? "1px solid #f0f0f0" : "none" }}>
                <span style={{ color: dotColor, fontWeight: 700, fontSize: 11, width: 12, textAlign: "center", flexShrink: 0 }}>{dot}</span>
                <span style={{ color: "#444", flex: "0 0 auto", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortName}</span>
                <span style={{ color: isError || isPdfScan ? "#e74c3c" : isOk ? "#27ae60" : "#aaa", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{msg}</span>
              </div>
            );
          })}
        </div>
      )}
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

// Extracts and parses JSON from a raw Claude response string.
// Tries: code fence → brace-balanced scan → jsonrepair fallback.
function extractJson(raw) {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  let candidate = fence ? fence[1].trim() : null;

  if (!candidate) {
    const start = raw.indexOf('{');
    if (start !== -1) {
      let depth = 0, end = -1;
      for (let i = start; i < raw.length; i++) {
        if (raw[i] === '{') depth++;
        else if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end !== -1) candidate = raw.slice(start, end + 1);
    }
  }

  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch {}
  try { return JSON.parse(jsonrepair(candidate)); } catch {}
  return null;
}

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
      if (!raw.trim()) throw new Error("Empty response");
      const result = extractJson(raw);
      if (result) return result;
      if (attempt < retries) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw new Error("JSON parse failed after all repair attempts");
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

const MAX_PAYLOAD_B64 = 24_000_000; // ~24MB base64 — safe buffer under 32MB API limit

function filesToParts(files, fallbackLabel) {
  const parts = [];
  let totalB64 = 0;
  (files || []).forEach((f, fi) => {
    const fileLabel = f._label || `${fallbackLabel} ${fi + 1}`;
    const fullLabel = `${fileLabel} [${f.ext || f.type?.toUpperCase() || "FILE"}: ${f.filename}]`;
    // XML wrapper — helps Claude clearly separate sources and avoid cross-contamination
    parts.push({ type: "text", text: `<document>\n<source>${fileLabel}</source>\n<type>${f.ext || f.type?.toUpperCase() || "FILE"}</type>\n<filename>${f.filename}</filename>` });
    if (f.textContent) {
      parts.push({ type: "text", text: `<content>\n${f.textContent}\n</content>` });
    }
    (f.pages || []).filter(p => p.b64 && p._selected !== false).forEach((pg, pi) => {
      if (pg.text) parts.push({ type: "text", text: `<page num="${pg.pageNum || pi + 1}">\n${pg.text}\n</page>` });
      // Skip image only for pure text pages with no embedded images and no form fields
      // All other pages: send image so Claude sees visual context, annotations, and spatial references
      const skipImage = pg._textRich && !pg._hasImages && !pg._hasFormFields;
      if (skipImage) return;
      const imgSize = pg.b64.length;
      if (totalB64 + imgSize > MAX_PAYLOAD_B64) {
        parts.push({ type: "text", text: `<page num="${pg.pageNum || pi + 1}">[Image skipped — payload limit reached; rely on extracted text above.]</page>` });
        return;
      }
      totalB64 += imgSize;
      if (!f.textContent || f.type === "dwg") {
        parts.push({ type: "text", text: `<page num="${pg.pageNum || pi + 1}">` });
      }
      parts.push({ type: "image", source: { type: "base64", media_type: pg.mediaType || "image/jpeg", data: pg.b64 } });
    });
    parts.push({ type: "text", text: `</document>` });
  });
  return parts;
}

// ─── PDF chunked pre-extraction ───────────────────────────────────────────────
const MAX_BATCH_B64 = 20_000_000; // ~20MB base64 per Haiku batch — safe under 32MB API limit
const PDF_DIRECT_LIMIT = 15;

async function preExtractPageBatch(pages, fileLabel, apiKey) {
  const parts = [{ type: "text", text:
    `You are analyzing pages of PDF "${fileLabel}" for a 3D visualization project.\n` +
    `Extract EVERYTHING on each page: furniture, materials, colors, dimensions, style, URLs, client comments, technical requirements, drawing annotations.\n` +
    `Format: one finding per line with page number: "[p.N] finding".\n` +
    `Miss nothing. No JSON, no preamble.`
  }];
  for (const pg of pages) {
    parts.push({ type: "text", text: `=== PAGE ${pg.pageNum} ===` });
    if (pg.text) parts.push({ type: "text", text: pg.text });
    if (pg.b64) parts.push({ type: "image", source: { type: "base64", media_type: pg.mediaType || "image/jpeg", data: pg.b64 } });
  }
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true", "x-api-key": apiKey },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 3000, temperature: 0, messages: [{ role: "user", content: parts }] })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Haiku ${resp.status}: ${data?.error?.message || ""}`);
  return (data.content || []).map(b => b.text || "").join("");
}

async function preProcessLargeFiles(files, apiKey, onStatus) {
  const result = [];
  for (const f of files) {
    const activePgs = (f.pages || []).filter(p => p.b64 && p._selected !== false);
    if (activePgs.length <= PDF_DIRECT_LIMIT || f._skipPreExtract) { result.push(f); continue; }

    const label = f._label || f.filename;
    const chunks = [];
    for (let i = 0; i < activePgs.length; i += PDF_CHUNK_SIZE)
      chunks.push(activePgs.slice(i, i + PDF_CHUNK_SIZE));

    const extractedParts = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const first = chunks[ci][0].pageNum;
      const last = chunks[ci][chunks[ci].length - 1].pageNum;
      onStatus?.(`"${f.filename}" — batch ${ci + 1}/${chunks.length} (p. ${first}–${last})…`);
      const text = await preExtractPageBatch(chunks[ci], label, apiKey);
      extractedParts.push(text);
    }

    // 3 sample pages: first, middle, last
    const n = activePgs.length;
    const sampleIdxs = [...new Set([0, Math.floor(n / 2), n - 1])];
    const samplePages = sampleIdxs.map(i => activePgs[i]);

    const extractedText = `=== Extracted content "${label}" (${n} pages) ===\n` + extractedParts.join("\n");
    result.push({ ...f, textContent: (f.textContent ? f.textContent + "\n\n" : "") + extractedText, pages: samplePages, _preExtracted: true, _totalPages: n });
  }
  return result;
}

// ─── SOW Templates ────────────────────────────────────────────────────────────
const SOW_TEMPLATES = {
  "Residential Interior": {
    items: [
      { text: "Type of buildings", cat: "Client Requirements" },
      { text: "Type of project", cat: "Client Requirements" },
      { text: "Required Rooms", cat: "Client Requirements" },
      { text: "Type of renderings", cat: "Technical Requirements" },
      { text: "Purpose", cat: "Technical Requirements" },
      { text: "Number of images", cat: "Technical Requirements" },
      { text: "Aspect ratio", cat: "Technical Requirements" },
      { text: "Resolution", cat: "Technical Requirements" },
      { text: "DPI", cat: "Technical Requirements" },
      { text: "File Format", cat: "Technical Requirements" },
      { text: "Naming", cat: "Technical Requirements" },
      { text: "Render elements", cat: "Technical Requirements" },
      { text: "Additional services", cat: "Technical Requirements" },
      { text: "File Delivery", cat: "Technical Requirements" },
      { text: "Any additional info", cat: "Client Requirements" },
      { text: "Camera angle preferences", cat: "Client Requirements" },
      { text: "Drawings", cat: "Drawings" },
      { text: "Model", cat: "Furniture & Objects" },
      { text: "Furniture Details", cat: "Furniture & Objects" },
      { text: "3D Model Selection", cat: "Furniture & Objects" },
      { text: "Furniture/lighting brands", cat: "Furniture & Objects" },
      { text: "Geolocation", cat: "References" },
      { text: "Views from Window", cat: "References" },
      { text: "Type of view", cat: "References" },
      { text: "People", cat: "Client Requirements" },
      { text: "Clothing", cat: "Client Requirements" },
      { text: "Number of people", cat: "Client Requirements" },
      { text: "Lighting Setup", cat: "References" },
      { text: "Artificial Lighting", cat: "References" },
      { text: "Shadows", cat: "References" },
      { text: "Furniture Placement", cat: "Furniture & Objects" },
      { text: "Materials", cat: "Materials & Finishes" },
      { text: "Decor and Accessories", cat: "Furniture & Objects" },
      { text: "Use of Colors", cat: "Materials & Finishes" },
    ],
    defaults: {
      "Type of buildings": "Residential",
      "Type of project": "Clear instructions",
      "Type of renderings": "Still images",
      "Purpose": "For marketing",
      "Aspect ratio": "16x9",
      "Resolution": "4K - 3840 x 2160",
      "DPI": "72",
      "File Format": "JPEG",
      "Naming": "Default naming",
      "Render elements": "None",
      "Additional services": "None",
      "File Delivery": "Only final renders",
      "Model": "We do not have a model",
      "Furniture Details": "We will provide links, brands information, and dimensions",
      "3D Model Selection": "Use similar from library",
      "Geolocation": "We have no geolocation details available",
      "Views from Window": "Use stock or generic backgrounds",
      "Type of view": "Garden",
      "People": "None",
      "Lighting Setup": "Adaptive light setting",
      "Artificial Lighting": "Adaptive light setting",
      "Shadows": "Adaptive light setting",
      "Furniture Placement": "Modify for better composition",
      "Materials": "References or specifications",
      "Decor and Accessories": "Client provides references",
      "Use of Colors": "Adjust saturation and brightness",
    },
  },
  "Commercial Interior": {
    items: [
      { text: "Type of buildings", cat: "Client Requirements" },
      { text: "Type of project", cat: "Client Requirements" },
      { text: "Required Rooms", cat: "Client Requirements" },
      { text: "Type of renderings", cat: "Technical Requirements" },
      { text: "Purpose", cat: "Technical Requirements" },
      { text: "Number of images", cat: "Technical Requirements" },
      { text: "Aspect ratio", cat: "Technical Requirements" },
      { text: "Resolution", cat: "Technical Requirements" },
      { text: "DPI", cat: "Technical Requirements" },
      { text: "File Format", cat: "Technical Requirements" },
      { text: "Naming", cat: "Technical Requirements" },
      { text: "Render elements", cat: "Technical Requirements" },
      { text: "Additional services", cat: "Technical Requirements" },
      { text: "File Delivery", cat: "Technical Requirements" },
      { text: "Any additional info", cat: "Client Requirements" },
      { text: "Camera angle preferences", cat: "Client Requirements" },
      { text: "Drawings", cat: "Drawings" },
      { text: "Model", cat: "Furniture & Objects" },
      { text: "Furniture Details", cat: "Furniture & Objects" },
      { text: "3D Model Selection", cat: "Furniture & Objects" },
      { text: "Furniture/lighting brands", cat: "Furniture & Objects" },
      { text: "Geolocation", cat: "References" },
      { text: "Views from Window", cat: "References" },
      { text: "Type of view", cat: "References" },
      { text: "People", cat: "Client Requirements" },
      { text: "Clothing", cat: "Client Requirements" },
      { text: "Number of people", cat: "Client Requirements" },
      { text: "Lighting Setup", cat: "References" },
      { text: "Artificial Lighting", cat: "References" },
      { text: "Shadows", cat: "References" },
      { text: "Furniture Placement", cat: "Furniture & Objects" },
      { text: "Materials", cat: "Materials & Finishes" },
      { text: "Decor and Accessories", cat: "Furniture & Objects" },
      { text: "Use of Colors", cat: "Materials & Finishes" },
    ],
    defaults: {
      "Type of buildings": "Commercial",
      "Type of project": "Clear instructions",
      "Type of renderings": "Still images",
      "Purpose": "For marketing",
      "Aspect ratio": "16x9",
      "Resolution": "4K - 3840 x 2160",
      "DPI": "72",
      "File Format": "JPEG",
      "Naming": "Default naming",
      "Render elements": "None",
      "Additional services": "None",
      "File Delivery": "Only final renders",
      "Model": "We do not have a model",
      "Furniture Details": "We will provide links, brands information, and dimensions",
      "3D Model Selection": "Use similar from library",
      "Geolocation": "We have no geolocation details available",
      "Views from Window": "Use stock or generic backgrounds",
      "Type of view": "Garden",
      "People": "None",
      "Lighting Setup": "Adaptive light setting",
      "Artificial Lighting": "Adaptive light setting",
      "Shadows": "Adaptive light setting",
      "Furniture Placement": "Modify for better composition",
      "Materials": "References or specifications",
      "Decor and Accessories": "Client provides references",
      "Use of Colors": "Adjust saturation and brightness",
    },
  },
  "Exterior": {
    items: [
      { text: "Type of buildings", cat: "Client Requirements" },
      { text: "Type of project", cat: "Client Requirements" },
      { text: "Purpose", cat: "Technical Requirements" },
      { text: "Aspect ratio", cat: "Technical Requirements" },
      { text: "Resolution", cat: "Technical Requirements" },
      { text: "DPI", cat: "Technical Requirements" },
      { text: "File Format", cat: "Technical Requirements" },
      { text: "Neighboring buildings", cat: "References" },
      { text: "Camera angles 1", cat: "Client Requirements" },
      { text: "Camera angles 2", cat: "Client Requirements" },
      { text: "Landscape plan", cat: "Drawings" },
      { text: "Materials", cat: "Materials & Finishes" },
      { text: "Unique elements", cat: "Client Requirements" },
      { text: "Season", cat: "References" },
      { text: "Time", cat: "References" },
      { text: "Sky", cat: "References" },
      { text: "Inside house", cat: "Client Requirements" },
      { text: "Glass", cat: "Client Requirements" },
      { text: "Artificial Lighting", cat: "References" },
      { text: "People", cat: "Client Requirements" },
      { text: "Cars", cat: "Client Requirements" },
    ],
    defaults: {
      "Type of buildings": "Residential",
      "Type of project": "Clear instructions",
      "Purpose": "For marketing",
      "Aspect ratio": "16x9",
      "Resolution": "4K - 3840 x 2160",
      "DPI": "72",
      "File Format": "JPEG",
      "Neighboring buildings": "Greenery without buildings",
      "Camera angles 1": "Front",
      "Camera angles 2": "Hero view Eye-level",
      "Landscape plan": "We will provide a reference to follow",
      "Materials": "General reference at discretion",
      "Unique elements": "No",
      "Season": "Summer",
      "Time": "Day",
      "Sky": "Without clouds",
      "Inside house": "Curtains",
      "Glass": "Transparent",
      "Artificial Lighting": "No artificial light sources",
      "People": "None",
      "Cars": "No",
    },
  },
  "Lifestyle": {
    items: [
      { text: "Scene Type", cat: "Scene" },
      { text: "Reference usage", cat: "Scene" },
      { text: "Purpose", cat: "Technical Requirements" },
      { text: "Aspect ratio", cat: "Technical Requirements" },
      { text: "Resolution", cat: "Technical Requirements" },
      { text: "DPI", cat: "Technical Requirements" },
      { text: "File Format", cat: "Technical Requirements" },
      { text: "Views Per Scene", cat: "Technical Requirements" },
      { text: "Naming", cat: "Technical Requirements" },
      { text: "File Delivery", cat: "Technical Requirements" },
      { text: "Render Elements", cat: "Technical Requirements" },
      { text: "Geolocation", cat: "Scene" },
      { text: "View from Window", cat: "Scene" },
      { text: "Type of view", cat: "Scene" },
      { text: "Model", cat: "Product" },
      { text: "Furniture Layout", cat: "Product" },
      { text: "Furniture Details", cat: "Product" },
      { text: "3D Model Selection", cat: "Product" },
      { text: "People", cat: "Scene" },
      { text: "Lighting", cat: "Scene" },
      { text: "Artificial", cat: "Scene" },
      { text: "Shadows", cat: "Scene" },
      { text: "Furniture Placement", cat: "Product" },
      { text: "Materials", cat: "Materials & Textures" },
      { text: "Decor", cat: "Product" },
      { text: "Colors", cat: "Materials & Textures" },
      { text: "Season", cat: "Scene" },
      { text: "Time", cat: "Scene" },
      { text: "Sky", cat: "Scene" },
    ],
    defaults: {
      "Scene Type": "Exterior + Interior + Residential",
      "Reference usage": "Client References with Studio Adaptation",
      "Purpose": "For marketing",
      "Aspect ratio": "16x9",
      "Resolution": "4K",
      "DPI": "72",
      "File Format": "JPEG",
      "Views Per Scene": "1 angle",
      "Naming": "Default",
      "File Delivery": "Only final renders",
      "Render Elements": "None",
      "Geolocation": "No geolocation",
      "View from Window": "Use stock/generic",
      "Type of view": "Garden",
      "Model": "No model/Custom modelling required",
      "Furniture Layout": "Use pre-existing layout from reference",
      "Furniture Details": "Alternative from 3D library",
      "3D Model Selection": "Use similar from library",
      "People": "None",
      "Lighting": "Adaptive",
      "Artificial": "Adaptive",
      "Shadows": "Adaptive",
      "Furniture Placement": "Modify",
      "Materials": "General material preferences",
      "Decor": "General guidelines",
      "Colors": "Adjust saturation",
      "Season": "Summer",
      "Time": "Sunset",
      "Sky": "Sunset",
    },
  },
  "Silo": {
    items: [
      { text: "Purpose", cat: "Technical Requirements" },
      { text: "Model", cat: "Product" },
      { text: "Additional visualization services", cat: "Technical Requirements" },
      { text: "Camera angles", cat: "Angles & Delivery" },
      { text: "Background Fill", cat: "Angles & Delivery" },
      { text: "Image Framing", cat: "Angles & Delivery" },
      { text: "Shadow Position", cat: "Angles & Delivery" },
      { text: "Decor", cat: "Angles & Delivery" },
      { text: "Resolution", cat: "Technical Requirements" },
      { text: "DPI", cat: "Technical Requirements" },
      { text: "File Format", cat: "Technical Requirements" },
      { text: "File size", cat: "Technical Requirements" },
      { text: "Aspect ratio", cat: "Technical Requirements" },
      { text: "Crop", cat: "Technical Requirements" },
      { text: "Naming", cat: "Technical Requirements" },
      { text: "Render elements", cat: "Technical Requirements" },
    ],
    defaults: {
      "Purpose": "Website + Digital catalog",
      "Model": "Needs Modeling",
      "Additional visualization services": "None",
      "Camera angles": "Corner ¾ + Side + Front",
      "Background Fill": "Transparent",
      "Image Framing": "20%",
      "Shadow Position": "Under the object",
      "Decor": "Do not add",
      "Resolution": "4K",
      "DPI": "300",
      "File Format": "JPEG",
      "File size": "No, any size",
      "Aspect ratio": "1x1",
      "Crop": "I don't plan to",
      "Naming": "Default",
      "Render elements": "None",
    },
  },
  "3D Modeling": {
    items: [
      { text: "Model Purpose", cat: "Modeling Parameters" },
      { text: "Polycount Limit", cat: "Modeling Parameters" },
      { text: "Output File Format", cat: "Modeling Parameters" },
      { text: "UV Mapping Method", cat: "Modeling Parameters" },
      { text: "Level of Details", cat: "Modeling Parameters" },
      { text: "Modeling of Internal Parts", cat: "Modeling Parameters" },
      { text: "Would you like weld seams", cat: "Modeling Parameters" },
      { text: "How should the product be designed", cat: "Modeling Parameters" },
      { text: "Render Engine", cat: "Modeling Parameters" },
      { text: "3D Scene Units", cat: "Modeling Parameters" },
      { text: "File Size Limit (for AR)", cat: "AR Specification" },
      { text: "Output Files for AR", cat: "AR Specification" },
      { text: "Texture Resolution for AR", cat: "AR Specification" },
      { text: "Dimensions", cat: "Product Reference" },
      { text: "General Views from Every Side", cat: "Product Reference" },
      { text: "Close-Up Views for Details", cat: "Product Reference" },
      { text: "Material in High Resolution", cat: "Materials & Textures" },
      { text: "Hex Color Code if Applicable", cat: "Materials & Textures" },
      { text: "Could you confirm photos and drawings match", cat: "Product Reference" },
    ],
    defaults: {
      "Model Purpose": "3D rendering (white background, lifestyle, exterior)",
      "Polycount Limit": "No limit",
      "Output File Format": "MAX",
      "UV Mapping Method": "Real world scale",
      "Level of Details": "High",
      "Modeling of Internal Parts": "Closed model only",
      "Would you like weld seams": "No",
      "How should the product be designed": "The reference provided is accurate; replicate it as shown",
      "Render Engine": "Corona Renderer",
      "3D Scene Units": "Centimeters",
      "File Size Limit (for AR)": "Up to 10 MB",
      "Output Files for AR": "USDZ + glTF/GLB",
      "Texture Resolution for AR": "2048x2048 (2K)",
      "General Views from Every Side": "Corner View (3/4 angle)",
    },
  },
  "AR Rendering": {
    items: [
      { text: "Output Files", cat: "AR Specification" },
      { text: "File Size Limit", cat: "AR Specification" },
      { text: "Texture Resolution", cat: "AR Specification" },
      { text: "Texture Format", cat: "AR Specification" },
      { text: "Number of Texture Sets", cat: "AR Specification" },
      { text: "Fine Details Method", cat: "AR Specification" },
      { text: "AO Map Usage", cat: "AR Specification" },
      { text: "UV Mapping Method", cat: "AR Specification" },
      { text: "Polygon Count Limit", cat: "AR Specification" },
      { text: "Units of Measurement", cat: "AR Specification" },
      { text: "General Views from Every Side", cat: "Product Reference" },
      { text: "Close-Up Views for Details", cat: "Product Reference" },
      { text: "Material in High Resolution", cat: "Materials & Textures" },
      { text: "Hex Color Code if Applicable", cat: "Materials & Textures" },
      { text: "Existing 3D Files (STP, STL, FBX, OBJ etc.)", cat: "Product Reference" },
      { text: "Photos and Drawings Match Confirmation", cat: "Product Reference" },
    ],
    defaults: {
      "Output Files": "USDZ + GLB",
      "File Size Limit": "Up to 10 MB",
      "Texture Resolution": "2048x2048",
      "Texture Format": "JPEG",
      "Number of Texture Sets": "1",
      "Fine Details Method": "Normal map",
      "AO Map Usage": "Use separately in PBR shader",
      "UV Mapping Method": "Atlas UV",
      "Polygon Count Limit": "Mid-poly (15K–50K)",
      "Units of Measurement": "Centimeters",
    },
  },
  "Floorplan": {
    items: [
      { text: "Type of project", cat: "Client Requirements" },
      { text: "Purpose of floorplan", cat: "Technical Requirements" },
      { text: "Type of plan", cat: "Client Requirements" },
      { text: "Number of images", cat: "Technical Requirements" },
      { text: "Angles for the floorplan", cat: "Client Requirements" },
      { text: "Level of detail", cat: "Technical Requirements" },
      { text: "Provided materials", cat: "Drawings" },
      { text: "Furniture Placement", cat: "Furniture & Objects" },
      { text: "Materials", cat: "Materials & Finishes" },
      { text: "Decor and Accessories", cat: "Furniture & Objects" },
      { text: "Resolution", cat: "Technical Requirements" },
      { text: "DPI", cat: "Technical Requirements" },
      { text: "File Format", cat: "Technical Requirements" },
      { text: "Render elements", cat: "Technical Requirements" },
      { text: "Color of background", cat: "Client Requirements" },
      { text: "Naming", cat: "Technical Requirements" },
      { text: "Lighting options", cat: "References" },
      { text: "Style preference", cat: "Client Requirements" },
      { text: "Orientation / Scale", cat: "Client Requirements" },
      { text: "Additional services", cat: "Technical Requirements" },
      { text: "File Delivery", cat: "Technical Requirements" },
    ],
    defaults: {
      "Type of project": "Residential",
      "Purpose of floorplan": "Marketing",
      "Type of plan": "3D Floorplan (Perspective)",
      "Number of images": "1",
      "Angles for the floorplan": "Top-down perspective",
      "Level of detail": "High (furnitures, decors)",
      "Provided materials": "CAD / DWG",
      "Furniture Placement": "Replicate exact arrangement",
      "Materials": "All provided by client",
      "Decor and Accessories": "All provided",
      "Resolution": "Full HD",
      "DPI": "72",
      "File Format": "PNG",
      "Render elements": "None",
      "Color of background": "White",
      "Naming": "Default naming",
      "Lighting options": "Sunlight highlights on the floor",
      "Style preference": "Realistic 3D floor",
      "Orientation / Scale": "North direction marked",
      "Additional services": "3D axonometric version",
      "File Delivery": "Only final images",
    },
  },
  "Aerial": {
    items: [
      { text: "Project type", cat: "Client Requirements" },
      { text: "Purpose", cat: "Technical Requirements" },
      { text: "Number of images", cat: "Technical Requirements" },
      { text: "Aspect ratio", cat: "Technical Requirements" },
      { text: "Resolution", cat: "Technical Requirements" },
      { text: "DPI", cat: "Technical Requirements" },
      { text: "File format", cat: "Technical Requirements" },
      { text: "Site photos", cat: "Drawings" },
      { text: "Project location/coordinates", cat: "Client Requirements" },
      { text: "Neighboring buildings", cat: "References" },
      { text: "Camera angle preferences", cat: "Client Requirements" },
      { text: "Camera angles and height", cat: "Client Requirements" },
      { text: "Drawings", cat: "Drawings" },
      { text: "Model", cat: "Furniture & Objects" },
      { text: "Landscape plan", cat: "Drawings" },
      { text: "Materials", cat: "Materials & Finishes" },
      { text: "Unique elements", cat: "Client Requirements" },
      { text: "Season", cat: "References" },
      { text: "Time", cat: "References" },
      { text: "Sky", cat: "References" },
      { text: "Inside house", cat: "Client Requirements" },
      { text: "Glass", cat: "Client Requirements" },
      { text: "Artificial lighting", cat: "References" },
      { text: "Cars", cat: "Client Requirements" },
      { text: "People", cat: "Client Requirements" },
      { text: "Additional elements", cat: "Client Requirements" },
    ],
    defaults: {
      "Project type": "Detailed project visualization",
      "Purpose": "Presentation + Tender",
      "Aspect ratio": "16x9",
      "Resolution": "FullHD - 1920 x 1080",
      "DPI": "300",
      "File format": "JPEG",
      "Neighboring buildings": "Greenery + Similar-looking",
      "Camera angles and height": "Aerial",
      "Model": "The final version will be provided",
      "Landscape plan": "General visual reference",
      "Materials": "References and photos of specific materials",
      "Unique elements": "No",
      "Season": "Summer",
      "Time": "Afternoon",
      "Sky": "With clouds",
      "Inside house": "Curtains",
      "Glass": "Transparent",
      "Artificial lighting": "No artificial light sources",
      "Cars": "Yes, static",
      "People": "None",
    },
  },
  "Design Interior": {
    items: [
      { text: "Style", cat: "Client Requirements" },
      { text: "References", cat: "References" },
      { text: "Furniture Placement", cat: "Furniture & Objects" },
      { text: "Furniture Details", cat: "Furniture & Objects" },
      { text: "3D Model", cat: "Furniture & Objects" },
      { text: "Materials", cat: "Materials & Finishes" },
      { text: "Decor", cat: "Furniture & Objects" },
      { text: "Colors", cat: "Materials & Finishes" },
      { text: "Functions", cat: "Client Requirements" },
      { text: "Detailing", cat: "Client Requirements" },
      { text: "Income", cat: "Client Requirements" },
      { text: "Target user", cat: "Client Requirements" },
      { text: "Architectural highlight", cat: "Client Requirements" },
      { text: "Key areas", cat: "Client Requirements" },
      { text: "Custom elements", cat: "Client Requirements" },
      { text: "Must-have", cat: "Client Requirements" },
      { text: "Plants", cat: "Client Requirements" },
      { text: "Cultural influences", cat: "Client Requirements" },
      { text: "Things to avoid", cat: "Client Requirements" },
      { text: "Type of buildings", cat: "Client Requirements" },
      { text: "Type of project", cat: "Client Requirements" },
      { text: "Required rooms", cat: "Client Requirements" },
      { text: "Type renderings", cat: "Technical Requirements" },
      { text: "Purpose", cat: "Technical Requirements" },
      { text: "Number", cat: "Technical Requirements" },
      { text: "Aspect ratio", cat: "Technical Requirements" },
      { text: "Resolution", cat: "Technical Requirements" },
      { text: "DPI", cat: "Technical Requirements" },
      { text: "Format", cat: "Technical Requirements" },
      { text: "Naming", cat: "Technical Requirements" },
      { text: "Render elements", cat: "Technical Requirements" },
      { text: "Additional services", cat: "Technical Requirements" },
      { text: "Delivery", cat: "Technical Requirements" },
      { text: "Camera preferences", cat: "Client Requirements" },
      { text: "Drawings", cat: "Drawings" },
      { text: "Model", cat: "Furniture & Objects" },
      { text: "Views from Window", cat: "References" },
      { text: "Type of view", cat: "References" },
      { text: "Geolocation", cat: "References" },
      { text: "People", cat: "Client Requirements" },
    ],
    defaults: {
      "Style": "Modern",
      "References": "Overall atmosphere",
      "Furniture Placement": "Modify",
      "Furniture Details": "Use similar from reference",
      "3D Model": "Use similar from library",
      "Materials": "References or specifications",
      "Decor": "Creative freedom",
      "Colors": "Color scheme based on references",
      "Functions": "Relaxation",
      "Detailing": "Minimal",
      "Income": "Mid-range",
      "Type of buildings": "Residential",
      "Type of project": "Concept",
      "Type renderings": "Still images",
      "Purpose": "For marketing",
      "Aspect ratio": "16x9",
      "Resolution": "FullHD - 1920 x 1080",
      "DPI": "72",
      "Format": "JPEG",
      "Naming": "Default",
      "Render elements": "None",
      "Delivery": "Only final renders",
      "Model": "We do not have",
      "Views from Window": "Stock/generic",
      "Type of view": "Skyline views",
      "People": "None",
    },
  },
  "Floor Rendering": {
    items: [
      { text: "Product type", cat: "Surface Specification" },
      { text: "Scene type", cat: "Scene" },
      { text: "Additional services", cat: "Technical Requirements" },
      { text: "Purpose", cat: "Technical Requirements" },
      { text: "Workflow", cat: "Scene" },
      { text: "Camera view", cat: "Scene" },
      { text: "Geolocation", cat: "Scene" },
      { text: "View from window", cat: "Scene" },
      { text: "Background view", cat: "Scene" },
      { text: "Furniture layout", cat: "Scene" },
      { text: "Props", cat: "Scene" },
      { text: "Talents", cat: "Scene" },
      { text: "Surface type", cat: "Surface Specification" },
      { text: "Floor pattern", cat: "Surface Specification" },
      { text: "Tile size length", cat: "Surface Specification" },
      { text: "Tile size width", cat: "Surface Specification" },
      { text: "Seam", cat: "Surface Specification" },
      { text: "Grout depth", cat: "Surface Specification" },
      { text: "Grout color", cat: "Surface Specification" },
      { text: "Resolution", cat: "Technical Requirements" },
      { text: "DPI", cat: "Technical Requirements" },
      { text: "File format", cat: "Technical Requirements" },
      { text: "Size", cat: "Technical Requirements" },
      { text: "Crop", cat: "Technical Requirements" },
      { text: "Naming", cat: "Technical Requirements" },
      { text: "Delivery", cat: "Technical Requirements" },
      { text: "Render elements", cat: "Technical Requirements" },
      { text: "Daytime", cat: "Scene" },
      { text: "Artificial", cat: "Scene" },
      { text: "Shadows", cat: "Scene" },
      { text: "Reference purpose", cat: "Scene" },
      { text: "Decor", cat: "Scene" },
      { text: "Colors", cat: "Scene" },
    ],
    defaults: {
      "Product type": "Floor",
      "Scene type": "Residential",
      "Additional services": "None",
      "Purpose": "For marketing",
      "Workflow": "Custom lifestyle",
      "Camera view": "Front View + Close-up View",
      "Geolocation": "No details",
      "View from window": "Use stock/generic",
      "Background view": "Garden",
      "Furniture layout": "Pre-existing layout",
      "Props": "Similar from 3D library",
      "Talents": "None",
      "Surface type": "By reference",
      "Floor pattern": "By reference",
      "Tile size length": "Constant",
      "Tile size width": "Constant",
      "Seam": "By reference",
      "Grout depth": "By reference",
      "Grout color": "By reference",
      "Resolution": "4K",
      "DPI": "300 DPI",
      "File format": "JPG",
      "Size": "No limit",
      "Crop": "I don't plan to",
      "Naming": "Default",
      "Delivery": "Only final renders",
      "Render elements": "None",
      "Daytime": "Adaptive",
      "Artificial": "Adaptive",
      "Shadows": "Adaptive",
      "Reference purpose": "Overall atmosphere",
      "Decor": "General guidelines",
      "Colors": "Adjust saturation",
    },
  },
  "Mattress Rendering": {
    items: [
      { text: "Type of Work", cat: "Product" },
      { text: "Model", cat: "Product" },
      { text: "Purpose", cat: "Technical Requirements" },
      { text: "Silo — Views", cat: "Silo" },
      { text: "Silo — Background", cat: "Silo" },
      { text: "Silo — Shadow", cat: "Silo" },
      { text: "Lifestyle — Workflow", cat: "Lifestyle" },
      { text: "Lifestyle — Views", cat: "Lifestyle" },
      { text: "Lifestyle — Background", cat: "Lifestyle" },
      { text: "Lifestyle — Furniture", cat: "Lifestyle" },
      { text: "Lifestyle — Props", cat: "Lifestyle" },
      { text: "Lifestyle — Talents", cat: "Lifestyle" },
      { text: "People", cat: "Lifestyle" },
      { text: "Pets", cat: "Lifestyle" },
      { text: "Resolution", cat: "Technical Requirements" },
      { text: "DPI", cat: "Technical Requirements" },
      { text: "Format", cat: "Technical Requirements" },
      { text: "Size", cat: "Technical Requirements" },
      { text: "Aspect", cat: "Technical Requirements" },
      { text: "Crop", cat: "Technical Requirements" },
      { text: "Naming", cat: "Technical Requirements" },
      { text: "Delivery", cat: "Technical Requirements" },
      { text: "Render elements", cat: "Technical Requirements" },
      { text: "Daytime", cat: "Lifestyle" },
      { text: "Artificial", cat: "Lifestyle" },
      { text: "Shadows", cat: "Lifestyle" },
      { text: "Reference", cat: "Lifestyle" },
      { text: "Bedding", cat: "Materials & Textures" },
      { text: "Silo image", cat: "Silo" },
      { text: "Materials", cat: "Materials & Textures" },
      { text: "Colors", cat: "Materials & Textures" },
      { text: "Photos of Product", cat: "Product" },
      { text: "Mattress Components", cat: "Product" },
      { text: "Texture for Mattress", cat: "Materials & Textures" },
      { text: "Mattress Build", cat: "Product" },
    ],
    defaults: {
      "Type of Work": "Silo + Lifestyle + Modeling",
      "Model": "Needs Modeling",
      "Purpose": "For marketing + For retailer",
      "Silo — Views": "3/4 view + Close-up view",
      "Silo — Background": "White",
      "Silo — Shadow": "No shadow",
      "Lifestyle — Workflow": "Custom lifestyle",
      "Lifestyle — Views": "3/4 + Front view",
      "Lifestyle — Background": "Garden",
      "Lifestyle — Furniture": "Pre-existing",
      "Lifestyle — Props": "Similar from library",
      "Lifestyle — Talents": "No",
      "People": "None",
      "Pets": "None",
      "Resolution": "4K",
      "DPI": "300",
      "Format": "JPG",
      "Size": "No limit",
      "Aspect": "16:9",
      "Crop": "No plan",
      "Naming": "Default",
      "Delivery": "Only final",
      "Render elements": "None",
      "Daytime": "Day lighting default",
      "Artificial": "No artificial sources",
      "Shadows": "High contrast soft shadows",
      "Reference": "Overall atmosphere",
      "Bedding": "Pillows",
      "Silo image": "Without anything",
      "Materials": "Creation of textures from client photos",
      "Colors": "Adjust saturation",
    },
  },
  "Rugs Rendering": {
    items: [
      { text: "Purpose", cat: "Technical Requirements" },
      { text: "Additional services", cat: "Angles & Delivery" },
      { text: "Resolution", cat: "Technical Requirements" },
      { text: "Output Format", cat: "Technical Requirements" },
      { text: "Aspect ratio", cat: "Technical Requirements" },
      { text: "Crop", cat: "Technical Requirements" },
      { text: "DPI", cat: "Technical Requirements" },
      { text: "Decor", cat: "Angles & Delivery" },
      { text: "Naming", cat: "Technical Requirements" },
      { text: "Delivery", cat: "Technical Requirements" },
    ],
    defaults: {
      "Purpose": "Website",
      "Additional services": "Top view (dimensions)",
      "Resolution": "4K",
      "Output Format": "PNG",
      "Aspect ratio": "1:1",
      "Crop": "I don't plan to",
      "DPI": "72",
      "Decor": "Do not add",
      "Naming": "Default",
      "Delivery": "Only final renders",
    },
  },
  "Real Estate": {
    items: [
      { text: "Property type", cat: "Client Requirements" },
      { text: "Market segment", cat: "Client Requirements" },
      { text: "Google maps location", cat: "References" },
      { text: "Layout/Plan", cat: "Drawings" },
      { text: "Style direction", cat: "Client Requirements" },
      { text: "Furniture/materials", cat: "Furniture & Objects" },
      { text: "Additional resources", cat: "Furniture & Objects" },
      { text: "Spaces", cat: "Client Requirements" },
      { text: "Images per space", cat: "Technical Requirements" },
      { text: "Camera", cat: "Client Requirements" },
      { text: "Resolution", cat: "Technical Requirements" },
      { text: "DPI", cat: "Technical Requirements" },
      { text: "Format", cat: "Technical Requirements" },
      { text: "Aspect ratio", cat: "Technical Requirements" },
      { text: "Additional services", cat: "Technical Requirements" },
      { text: "Delivery", cat: "Technical Requirements" },
      { text: "Lighting", cat: "References" },
      { text: "Artificial", cat: "References" },
      { text: "Shadows", cat: "References" },
    ],
    defaults: {
      "Google maps location": "Location unavailable – use generic",
      "Layout/Plan": "2D layout",
      "Style direction": "3D studio sends references",
      "Furniture/materials": "Exact list will be supplied",
      "Additional resources": "None – rely on plans",
      "Images per space": "1",
      "Camera": "Choose best angles",
      "Resolution": "4K",
      "DPI": "Studio selects",
      "Format": "JPEG",
      "Aspect ratio": "Studio selects",
      "Additional services": "None",
      "Delivery": "Only final renders",
      "Lighting": "Adaptive",
      "Artificial": "Adaptive",
      "Shadows": "Adaptive",
    },
  },
};

const TYPE_DESCRIPTIONS = {
  "Residential Interior": "Photorealistic visualization of residential interiors based on technical DWG drawings. Apartments, private homes. Requires floor plans, furniture and material specs.",
  "Commercial Interior": "Visualization of commercial spaces: offices, restaurants, hotels, showrooms, retail. Requires DWG plans, brand guidelines, logo and equipment specs.",
  "Exterior": "Building exterior render from facade drawings with surroundings, landscape and sky. Optional: aerial drone angle. Requires plans, facades and sections.",
  "Lifestyle": "Advertising product scene in interior or outdoors. Three workflows: Our Vision (studio creates), Your Vision (your reference), Template (library scene).",
  "Silo": "Clean product shots on neutral background (white / transparent / black). Standard for e-commerce, catalogs and marketplaces.",
  "3D Modeling": "3D model creation from drawings or photos, no rendering. Output: .max / .fbx / .obj. Includes AR preparation (GLB/USDZ).",
  "AR Rendering": "Optimized 3D model for AR/VR apps and web configurators. Output: GLB/USDZ. Requires polygon budget, texture resolution, UV mapping and file size specs.",
  "Floorplan": "Architectural floor plan from above in 3D or schematic style. For real estate sales, developer websites and presentations.",
  "Aerial": "Aerial drone view: choice of height (30–100m), angle, season and atmosphere. Separate project without facade render. Requires coordinates or address.",
  "Design Interior": "Conceptual visualization without technical drawings — from a style direction. Studio selects furniture and materials independently. For portfolio or competition projects.",
  "Floor Rendering": "Product shots of floor or wall tiles, parquet, laminate: silo on white + lifestyle scene. For catalogs and material manufacturer websites.",
  "Mattress Rendering": "Product shots of mattresses: silo + lifestyle with bedroom. Includes bedding, texture close-ups and structural cross-section.",
  "Rugs Rendering": "Product shots of rugs: top view with dimensions, pile close-up, lifestyle in living room or bedroom. For catalogs and manufacturer websites.",
  "Real Estate": "Interior visualization for real estate sales with a simplified brief. Starts from a 2D sketch without detailed DWG. Studio selects style and furniture independently based on market segment.",
};

const CAT_COLOR = {
  // Interior / Exterior / Aerial / Real Estate / Design / Floorplan
  "References": "#27ae60",
  "Materials & Finishes": "#8e44ad",
  "Furniture & Objects": "#2980b9",
  "Drawings": "#e67e22",
  "Technical Requirements": "#16a085",
  "Client Requirements": "#c0392b",
  // Silo
  "Product": "#2980b9",
  "Angles & Delivery": "#e67e22",
  // Lifestyle
  "Materials & Textures": "#8e44ad",
  "Scene": "#27ae60",
  // Floor Rendering
  "Surface Specification": "#d35400",
  // Mattress Rendering
  "Silo": "#2c3e50",
  "Lifestyle": "#c0392b",
  // 3D Modeling
  "Modeling Parameters": "#16a085",
  "AR Specification": "#3498db",
  "Product Reference": "#7f8c8d",
};

const PRODUCTION_STAGES = ["Modeling", "Texturing", "Lighting", "Cameras", "Post-production", "Delivery"];
const STAGE_COLOR = {
  "Modeling": "#e67e22", "Texturing": "#8e44ad", "Lighting": "#f39c12",
  "Cameras": "#2980b9", "Post-production": "#16a085", "Delivery": "#7f8c8d",
};
const STAGE_HINT = {
  "Modeling": "geometry, layout, dimensions",
  "Texturing": "materials, brands, RAL/SKU",
  "Lighting": "time of day, season, sources",
  "Cameras": "angles, eye height, landmarks",
  "Post-production": "processing style, people in frame",
  "Delivery": "format, resolution, deadline",
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
          <div style={{ fontSize: 10, fontFamily: "monospace", color: "#888", marginBottom: 2 }}>{imgRef.fileLabel} · p. {imgRef.pageNum}</div>
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
          <span style={{ fontSize: 9, fontFamily: "monospace", color: "#555", marginRight: 8 }}>ITEM:</span>
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
          <div style={{ fontSize: 9, fontFamily: "monospace", color: "#555" }}>{total} page{total === 1 ? "" : "s"}</div>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#666", fontSize: 22, cursor: "pointer", lineHeight: 1 }}>✕</button>
      </div>

      {/* Image */}
      <div onClick={e => e.stopPropagation()}
        style={{ width: "min(94vw,1040px)", maxHeight: "72vh", overflow: "hidden", borderRadius: 8, background: "#111", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
        {b64
          ? <img src={b64} alt={`p. ${page}`} style={{ maxWidth: "100%", maxHeight: "72vh", objectFit: "contain", display: "block" }} />
          : <div style={{ color: "#555", fontFamily: "monospace", fontSize: 11 }}>Image unavailable</div>}
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
          <span style={{ fontSize: 9, fontFamily: "monospace", color: "#555", marginRight: 8 }}>ITEM:</span>
          <span style={{ fontSize: 11, color: "#bbb" }}>{itemText}</span>
        </div>
      )}
    </div>
  );
}

function TzItem({ item, onEdit, onRemove, onOpenRef, onOpenDoc }) {
  const [editing, setEditing] = useState(false);
  const ref = item.imgRef;
  const borderColor = CAT_COLOR[item.category] || "#ddd";
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", borderBottom: "1px solid #f0ede8", borderLeft: `3px solid ${borderColor}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing
          ? <textarea autoFocus value={item.text} onChange={e => onEdit(item.id, e.target.value)} onBlur={() => setEditing(false)}
              rows={Math.max(2, Math.ceil(item.text.length / 80))}
              style={{ width: "100%", border: "1px solid #e0ddd8", borderRadius: 4, fontSize: 13, color: "#222", lineHeight: 1.5, fontFamily: "inherit", padding: "3px 6px", outline: "none", background: "#fafafa", resize: "vertical" }} />
          : <>
              <div onClick={() => setEditing(true)} style={{ fontSize: 13, color: "#1a1a1a", fontStyle: item.quote ? "italic" : "normal", lineHeight: 1.55, cursor: "text", marginBottom: item.quote ? 5 : 0 }}>
                {item.quote || item.text}
              </div>
              {item.quote && (
                <div style={{ fontSize: 11, color: "#666", lineHeight: 1.5, marginBottom: 5 }}>{item.text}</div>
              )}
            </>
        }
        <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
          {item.source && <span style={{ fontSize: 9, color: "#bbb", fontFamily: "monospace" }}>{item.source}</span>}
          {ref && <span onClick={() => onOpenRef(ref, item.text)} style={{ fontSize: 9, color: "#3498db", fontFamily: "monospace", cursor: "pointer", textDecoration: "underline dotted" }} title="Open source">↗ {ref.fileLabel}{ref.pageNum > 1 ? ` p.${ref.pageNum}` : ""}</span>}
          {!ref && item.imgRefLabel && <span onClick={() => onOpenDoc?.(item.imgRefLabel, item.text)} style={{ fontSize: 9, color: "#e67e22", fontFamily: "monospace", cursor: onOpenDoc ? "pointer" : "default", textDecoration: onOpenDoc ? "underline dotted" : "none" }} title={`Open: ${item.imgRefLabel}`}>⚠ {item.imgRefLabel}</span>}
          {(item.links || []).map((lk, li) => (
            <a key={li} href={lk.url} target="_blank" rel="noreferrer"
              title={lk.url}
              onClick={e => { e.preventDefault(); e.stopPropagation(); if (window.__TAURI__) { window.__TAURI__.opener?.openUrl(lk.url); } else { window.open(lk.url, "_blank", "noopener,noreferrer"); } }}
              style={{ fontSize: 9, color: "#3498db", fontFamily: "monospace", textDecoration: "none", background: "#f0f7ff", border: "1px solid #d0e8fb", borderRadius: 3, padding: "1px 5px" }}>
              🔗 {lk.label || lk.url.replace(/^https?:\/\//, "").slice(0, 35)}
            </a>
          ))}
        </div>
      </div>
      {ref?.preview && (
        <div onClick={() => onOpenRef(ref, item.text)} title={`${ref.fileLabel} · p. ${ref.pageNum}`}
          style={{ width: 56, height: 42, flexShrink: 0, cursor: "pointer", borderRadius: 3, overflow: "hidden", border: "1px solid #e0ddd8", position: "relative" }}>
          <img src={ref.preview} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0)", transition: "background 0.15s" }}
            onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.25)"}
            onMouseLeave={e => e.currentTarget.style.background = "rgba(0,0,0,0)"}>
            <div style={{ position: "absolute", bottom: 2, right: 2, fontSize: 7, fontFamily: "monospace", color: "#fff", background: "rgba(0,0,0,0.5)", padding: "0 2px", borderRadius: 1 }}>
              p.{ref.pageNum}
            </div>
          </div>
        </div>
      )}
      <button onClick={() => onRemove(item.id)} style={{ background: "none", border: "none", color: "#ddd", cursor: "pointer", fontSize: 14, flexShrink: 0, lineHeight: 1, padding: "2px 4px" }} title="Delete">×</button>
    </div>
  );
}

const SOURCE_TYPE_LABELS = {
  furniture: "Furniture", material: "Materials", lighting: "Lighting",
  style_ref: "Style", time_of_day: "Time of day", weather: "Weather / Season",
  render_quality: "Render quality", camera: "Camera angle", dimensions: "Dimensions",
  logo: "Logo", comment: "Comment", other: "Other",
};
const SOURCE_TYPE_COLOR = {
  furniture: "#2980b9", material: "#8e44ad", lighting: "#f39c12",
  style_ref: "#27ae60", time_of_day: "#e67e22", weather: "#16a085",
  render_quality: "#7f8c8d", camera: "#2471a3", dimensions: "#e67e22",
  logo: "#c0392b", comment: "#95a5a6", other: "#bdc3c7",
};
const SOURCE_FILE_ICO = { pdf: "📄", dwg: "📐", dxf: "📐", excel: "📊", text: "📝", image: "🖼️" };

function TzReviewStep({ projectType, rooms, tzByRoom, sowMissing, sowUnclear, deliverySpec, sowCoverage, buildingCoverage, clientComments, annotation, conflicts, roadmap, sources, files, sourceTags, onSourceTag, onEdit, onRemove, onBack, clientTranslation, buildingClientTranslation, onBuildClientTranslation, miqEval, onMiqRate, onMiqComment, miqFnItems, onMiqFnAdd, onMiqFnRemove }) {
  const allRooms = rooms?.length ? ["General", ...rooms.filter(r => r !== "General")] : ["General"];
  const [activeRoom, setActiveRoom] = useState(allRooms[0]);
  const [activeStage, setActiveStage] = useState(PRODUCTION_STAGES[0]);
  const [sowPage, setSowPage] = useState("sowa"); // "sowa" | "niq"
  const [lightbox, setLightbox] = useState(null); // { imgRef, itemText }
  const [docViewer, setDocViewer] = useState(null); // { source, pageNum }
  const [tableFilter, setTableFilter] = useState({ type: "", room: "", stage: "", search: "" });
  const [tableSort, setTableSort] = useState({ col: "room", dir: "asc" });
  const [miqFnInput, setMiqFnInput] = useState("");
  const [showF1, setShowF1] = useState(false);

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

  // Open DocViewer by imgRefLabel (e.g. "CUTSHEET p.4") — fuzzy match against filenames
  const openDocByLabel = (label, itemText) => {
    if (!label || !(files || []).length) return;
    const norm = s => s.replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const raw = norm(label);
    // Extract page number from "p.N" or "p. N"
    const pageMatch = raw.match(/p[.\s]+(\d+)/);
    const pageNum = pageMatch ? parseInt(pageMatch[1]) : 1;
    const baseName = raw.replace(/p[.\s]+\d+/g, '').replace(/\s+\d+$/, '').trim();
    // Find file whose filename (without ext) contains baseName or vice versa
    const found = (files || []).find(f => {
      const fn = f.filename.replace(/\.[^.]+$/, '').toLowerCase();
      return fn.includes(baseName) || baseName.includes(fn);
    });
    if (found) setDocViewer({ source: found, pageNum, itemText });
  };

  const CAT_TO_TYPE = {
    "Materials & Textures": "material",
    "Furniture & Objects": "todo",
    "References": "style",
    "Drawings": "dimension",
    "Client Requirements": "todo",
    "Technical Requirements": "comment",
  };

  const tableRows = useMemo(() => {
    const rows = [];
    allItems.forEach(it => {
      const type = it.imgRef ? "image" : (CAT_TO_TYPE[it.category] || "todo");
      rows.push({ id: it.id, type, text: it.text, quote: it.quote, room: it.room || "—", category: it.category || "—", stage: it.stage || "—", source: it.source || "—", img_ref: it.imgRef || null, _item: it });
    });
    (conflicts || []).forEach((c, i) => rows.push({ id: `conflict-${i}`, type: "conflict", text: c, quote: null, room: "—", category: "Conflict", stage: "—", source: "—", img_ref: null, _item: null }));
    (sowMissing || []).forEach((m, i) => rows.push({ id: `missing-${i}`, type: "missing", text: m, quote: null, room: "—", category: "SOW Missing", stage: "—", source: "—", img_ref: null, _item: null }));
    (sowUnclear || []).forEach((u, i) => rows.push({ id: `unclear-${i}`, type: "unclear", text: u, quote: null, room: "—", category: "SOW Unclear", stage: "—", source: "—", img_ref: null, _item: null }));
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
    todo:      { label: "TODO",     color: "#2980b9", bg: "#eaf4fb" },
    material:  { label: "MATERIAL", color: "#8e44ad", bg: "#f5eefb" },
    style:     { label: "STYLE",    color: "#27ae60", bg: "#e8f8ee" },
    dimension: { label: "SIZE",     color: "#e67e22", bg: "#fef5e7" },
    image:     { label: "IMAGE",    color: "#16a085", bg: "#e8f8f5" },
    comment:   { label: "COMMENT",  color: "#7f8c8d", bg: "#f4f6f7" },
    conflict:  { label: "CONFLICT", color: "#e74c3c", bg: "#fde8e8" },
    missing:   { label: "MISSING",  color: "#c0392b", bg: "#fde8e8" },
    unclear:   { label: "UNCLEAR",  color: "#e67e22", bg: "#fff8ec" },
  };

  const roomData = tzByRoom?.[activeRoom] || {};
  const totalItems = Object.values(tzByRoom || {}).flatMap(r => Object.values(r)).flat().length;

  const copyClientRequest = () => {
    const lines = ["Additional information needed to complete the brief:\n"];
    if (sowMissing?.length > 0) {
      lines.push("Missing information:");
      sowMissing.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
      lines.push("");
    }
    if (sowUnclear?.length > 0) {
      lines.push("Needs clarification:");
      sowUnclear.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    }
    navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
  };

  const copyMd = () => {
    const lines = [];
    (rooms || ["General"]).forEach(room => {
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
      "Type":     row.type,
      "Item":     row.text,
      "Quote":    row.quote || "",
      "Category": row.category,
      "Room":     row.room,
      "Stage":    row.stage,
      "Source":   row.source + (row.img_ref?.pageNum > 1 ? ` p.${row.img_ref.pageNum}` : ""),
      "Links":    (row._item?.links || []).map(l => l.url).join(", "),
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    // Column widths
    ws["!cols"] = [8, 60, 40, 20, 20, 16, 20, 40].map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Brief");
    XLSX.writeFile(wb, `tz-${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  const exportPdf = () => {
    const prev = document.title;
    document.title = `Brief — ${projectType || "project"} — ${new Date().toLocaleDateString("en-US")}`;
    window.print();
    document.title = prev;
  };

  const exportMiqEval = async () => {
    const XLSX = await loadXLSX();
    const rows = [];
    let n = 1;
    (sowMissing || []).forEach((m, i) => {
      const e = (miqEval || {})[`missing_${i}`] || {};
      rows.push({ "#": n++, Type: "Missing", Question: m, "PM Rating": e.rating || "", Comment: e.comment || "" });
    });
    (sowUnclear || []).forEach((u, i) => {
      const e = (miqEval || {})[`unclear_${i}`] || {};
      rows.push({ "#": n++, Type: "Unclear", Question: u, "PM Rating": e.rating || "", Comment: e.comment || "" });
    });
    (conflicts || []).forEach((c, i) => {
      const text = typeof c === "string" ? c : (c.description || c.text || "");
      const e = (miqEval || {})[`conflict_${i}`] || {};
      rows.push({ "#": n++, Type: "Conflict", Question: text, "PM Rating": e.rating || "", Comment: e.comment || "" });
    });
    (miqFnItems || []).forEach(item => {
      rows.push({ "#": n++, Type: "FN (missed)", Question: item, "PM Rating": "FN", Comment: "" });
    });
    const tp = Object.values(miqEval || {}).filter(e => e.rating === "TP").length;
    const fp = Object.values(miqEval || {}).filter(e => e.rating === "FP").length;
    const fn = (miqFnItems || []).length;
    const precision = tp + fp > 0 ? Math.round(tp / (tp + fp) * 100) : 0;
    const recall = tp + fn > 0 ? Math.round(tp / (tp + fn) * 100) : 0;
    const f1 = 2 * tp + fp + fn > 0 ? Math.round(2 * tp / (2 * tp + fp + fn) * 100) : 0;
    rows.push({});
    rows.push({ "#": "", Type: "", Question: "Precision", "PM Rating": `${tp}/${tp + fp}`, Comment: `${precision}%` });
    rows.push({ "#": "", Type: "", Question: "Recall", "PM Rating": `${tp}/${tp + fn}`, Comment: `${recall}%` });
    rows.push({ "#": "", Type: "", Question: "F1 Score", "PM Rating": "", Comment: `${f1}%` });
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [5, 12, 80, 12, 40].map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "MIQ Evaluation");
    XLSX.writeFile(wb, `miq-eval-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const exportReportExcel = async (isClient) => {
    const XLSX = await loadXLSX();
    const wb = XLSX.utils.book_new();
    const date = new Date().toISOString().slice(0, 10);

    if (deliverySpec?.length) {
      const rows = isClient
        ? deliverySpec.map(i => ({ "Parameter": i.key, "Value": i.value || "—", "Status": i.source === "unclear" ? "⚠ to clarify" : "" }))
        : deliverySpec.map(i => ({ "Parameter": i.key, "Value": i.value || "—", "Source": i.source === "brief" ? "✓ from brief" : i.source === "default" ? "default" : "⚠ to clarify" }));
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [30, 30, 16].map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, isClient ? "Delivery Spec" : "Tech Spec");
    }

    if (!isClient && sowCoverage?.length) {
      const rows = sowCoverage.map(r => ({ "SOW Item": r.item, "Status": r.status === "found" ? "✅ found" : r.status === "partial" ? "⚠️ partial" : "❌ missing", "Found": r.found || "—", "Source": r.source || "—" }));
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [40, 16, 40, 24].map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, "SOW Coverage");
    }

    if (!isClient && conflicts?.length) {
      const rows = conflicts.map((c, i) => ({ "#": i + 1, "Conflict": typeof c === "string" ? c : (c.description || c.text || "") }));
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [4, 80].map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, "Conflicts");
    }

    const missing = sowMissing || [];
    const unclear = sowUnclear || [];
    if (missing.length || unclear.length) {
      const rows = [
        ...missing.map(s => ({ "Type": isClient ? "Missing" : "Missing", "Question": s })),
        ...unclear.map(s => ({ "Type": isClient ? "Incomplete" : "Unclear",  "Question": s })),
      ];
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [14, 80].map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, isClient ? "Open Questions" : "Questions");
    }

    XLSX.writeFile(wb, `report-${isClient ? "client" : "pm"}-${date}.xlsx`);
  };

  const exportReportPdf = (isClient) => {
    const date = new Date().toLocaleDateString(isClient ? "en-US" : "uk-UA");
    const specRows = (deliverySpec || []).map((item, i) => `
      <tr style="background:${i%2===0?"#fafafa":"#fff"}">
        <td>${item.key}</td><td>${item.value || "—"}</td>
        ${isClient ? `<td style="color:${item.source==="unclear"?"#e67e22":"#aaa"}">${item.source==="unclear"?"⚠ to clarify":""}</td>` : `<td style="color:${item.source==="brief"?"#27ae60":item.source==="unclear"?"#e67e22":"#aaa"}">${item.source==="brief"?"✓ from brief":item.source==="unclear"?"⚠ to clarify":"default"}</td>`}
      </tr>`).join("");
    const coverageRows = (!isClient && sowCoverage?.length) ? sowCoverage.map((row, i) => `
      <tr style="background:${i%2===0?"#fafafa":"#fff"}">
        <td>${row.item}</td>
        <td style="color:${row.status==="found"?"#27ae60":row.status==="partial"?"#e67e22":"#e74c3c"}">${row.status==="found"?"✅":row.status==="partial"?"⚠️":"❌"}</td>
        <td>${row.found||"—"}</td><td style="color:#888">${row.source||"—"}</td>
      </tr>`).join("") : "";
    const conflictRows = (!isClient && conflicts?.length) ? conflicts.map(c => `<div style="padding:8px 12px;border-left:3px solid #e74c3c;margin-bottom:6px;font-size:11px">⚡ ${typeof c==="string"?c:(c.description||c.text||"")}</div>`).join("") : "";
    const allQ = [...(sowMissing||[]).map(s=>`<div style="padding:8px 12px;border-left:3px solid #e74c3c;margin-bottom:6px;font-size:11px">❌ ${s}</div>`), ...(sowUnclear||[]).map(s=>`<div style="padding:8px 12px;border-left:3px solid #e67e22;margin-bottom:6px;font-size:11px">⚠️ ${s}</div>`)].join("");
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${isClient?"Client Report":"PM Report"} — ${projectType} — ${date}</title>
    <style>body{font-family:monospace;font-size:11px;color:#222;padding:32px;max-width:900px;margin:0 auto}h2{font-size:13px;font-weight:700;margin:24px 0 8px;letter-spacing:.08em;color:#555}table{width:100%;border-collapse:collapse;margin-bottom:8px}th{background:#f0eeea;padding:5px 10px;text-align:left;font-size:9px;letter-spacing:.08em;color:#888}td{padding:6px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top}@media print{body{padding:16px}}</style>
    </head><body>
    <div style="font-size:10px;color:#bbb;margin-bottom:4px">${isClient?"CLIENT REPORT":"PM REPORT"}</div>
    <div style="font-size:16px;font-weight:700;margin-bottom:4px">${projectType||""}</div>
    <div style="font-size:10px;color:#aaa;margin-bottom:24px">${date}</div>
    ${specRows?`<h2>${isClient?"DELIVERY SPECIFICATION":"TECHNICAL SPECIFICATION"}</h2><table><thead><tr><th>Parameter</th><th>Value</th><th>${isClient?"Status":"Source"}</th></tr></thead><tbody>${specRows}</tbody></table>`:""}
    ${coverageRows?`<h2>SOW COVERAGE</h2><table><thead><tr><th>SOW Item</th><th>Status</th><th>Found</th><th>Source</th></tr></thead><tbody>${coverageRows}</tbody></table>`:""}
    ${conflictRows?`<h2>FILE CONFLICTS</h2>${conflictRows}`:""}
    ${allQ?`<h2>${isClient?"OPEN QUESTIONS":"CLIENT QUESTIONS"}</h2>${allQ}`:""}
    </body></html>`;
    const w = window.open("", "_blank");
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#f5f4f1", display: "flex", flexDirection: "column" }}>
      {lightbox && <ImageLightbox imgRef={lightbox.imgRef} itemText={lightbox.itemText} onClose={() => setLightbox(null)} />}
      {docViewer && <DocViewer key={`${docViewer.source?.filename}-${docViewer.pageNum}`} source={docViewer.source} initialPage={docViewer.pageNum} itemText={docViewer.itemText} onClose={() => setDocViewer(null)} />}
      {/* Top bar */}
      <div style={{ background: "#1a1a1a", padding: "0 20px", display: "flex", alignItems: "center", gap: 12, height: 44, flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 16, padding: 0 }}>←</button>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#f2f0ec", fontFamily: "monospace", letterSpacing: "0.1em" }}>DOC NEXUS</span>
        {projectType && <span style={{ fontSize: 9, color: "#fff", background: "#2980b9", fontFamily: "monospace", padding: "2px 8px", borderRadius: 10 }}>{projectType}</span>}
        <span style={{ fontSize: 9, color: "#555", fontFamily: "monospace", marginLeft: "auto" }}>{totalItems} items</span>
        {(sowMissing?.length > 0 || sowUnclear?.length > 0) && (
          <button onClick={copyClientRequest} title="Copy client questions"
            style={{ fontSize: 9, fontFamily: "monospace", background: "#e67e22", border: "none", color: "#fff", padding: "3px 10px", borderRadius: 4, cursor: "pointer", fontWeight: 700 }}>
            Request ({(sowMissing?.length || 0) + (sowUnclear?.length || 0)})
          </button>
        )}
        <button onClick={exportPdf} style={{ fontSize: 9, fontFamily: "monospace", background: "none", border: "1px solid #333", color: "#666", padding: "3px 10px", borderRadius: 4, cursor: "pointer" }}>PDF</button>
        <button onClick={exportExcel} style={{ fontSize: 9, fontFamily: "monospace", background: "none", border: "1px solid #2ecc71", color: "#2ecc71", padding: "3px 10px", borderRadius: 4, cursor: "pointer" }}>XLS</button>
        <button onClick={copyMd} style={{ fontSize: 9, fontFamily: "monospace", background: "none", border: "1px solid #333", color: "#666", padding: "3px 10px", borderRadius: 4, cursor: "pointer" }}>MD</button>
      </div>



      {/* ── SOWa / MIQ tabs ── */}
      <div style={{ background: "#fff", borderBottom: "1px solid #e8e6e1", display: "flex", padding: "0 20px", flexShrink: 0 }}>
        {[["sowa", `SOWa · ${totalItems}`], ["spec", `SOWa + BT · ${deliverySpec?.length || 0}`], ["niq", `MIQ · ${(sowMissing?.length || 0) + (sowUnclear?.length || 0) + (conflicts?.length || 0)}`]].map(([id, label]) => (
          <button key={id} onClick={() => setSowPage(id)} style={{ fontSize: 10, fontFamily: "monospace", fontWeight: 700, letterSpacing: "0.08em", padding: "10px 18px", border: "none", borderBottom: sowPage === id ? "2px solid #1a1a1a" : "2px solid transparent", background: "transparent", cursor: "pointer", color: sowPage === id ? "#1a1a1a" : "#aaa" }}>{label}</button>
        ))}
      </div>

      {/* ── Main scrollable area ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", background: "#f5f4f1" }}>

        {/* ── SOWa ── */}
        {sowPage === "sowa" && (() => {
          const CATS = ["References", "Materials & Finishes", "Furniture & Objects", "Drawings", "Technical Requirements", "Client Requirements"];
          const byCategory = {};
          allItems.forEach(item => { const cat = item.category || "Other"; if (!byCategory[cat]) byCategory[cat] = []; byCategory[cat].push(item); });
          const sortedCats = [...CATS.filter(c => byCategory[c]), ...Object.keys(byCategory).filter(c => !CATS.includes(c) && byCategory[c])];
          if (!sortedCats.length) return <div style={{ color: "#bbb", fontFamily: "monospace", fontSize: 11, padding: "24px 0" }}>SOWa not built yet — run analysis</div>;
          return (
            <>
              {annotation && <div style={{ fontSize: 10, color: "#666", marginBottom: 18, padding: "10px 14px", background: "#fff", borderRadius: 6, border: "1px solid #e8e6e1", lineHeight: 1.55 }}>{annotation}</div>}
              {sortedCats.map(cat => {
                const items = byCategory[cat] || [];
                return (
                  <div key={cat} style={{ marginBottom: 24 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: CAT_COLOR[cat] || "#bbb", flexShrink: 0 }} />
                      <span style={{ fontSize: 9, fontWeight: 700, fontFamily: "monospace", color: "#888", letterSpacing: "0.12em" }}>{cat.toUpperCase()}</span>
                      <span style={{ fontSize: 9, color: "#ccc", fontFamily: "monospace" }}>{items.length}</span>
                    </div>
                    <div style={{ background: "#fff", borderRadius: 6, border: "1px solid #e8e6e1", padding: "2px 12px" }}>
                      {items.map(item => <TzItem key={item.id} item={item} onEdit={onEdit} onRemove={onRemove}
                        onOpenRef={(imgRef, itemText) => { const f = imgRef?.filename ? filesByName[imgRef.filename] : null; if (f) openDocViewer(f.filename, imgRef.pageNum, itemText); else setLightbox({ imgRef, itemText }); }}
                        onOpenDoc={(label, itemText) => openDocByLabel(label, itemText)} />)}
                    </div>
                  </div>
                );
              })}
            </>
          );
        })()}

        {/* ── MIQ ── */}
        {sowPage === "niq" && (() => {
          const niqEmpty = !sowMissing?.length && !sowUnclear?.length && !conflicts?.length;
          const tp = Object.values(miqEval || {}).filter(e => e.rating === "TP").length;
          const fp = Object.values(miqEval || {}).filter(e => e.rating === "FP").length;
          const fn = (miqFnItems || []).length;
          const hasEval = tp + fp + fn > 0;
          const precision = tp + fp > 0 ? Math.round(tp / (tp + fp) * 100) : 0;
          const recall = tp + fn > 0 ? Math.round(tp / (tp + fn) * 100) : 0;
          const f1 = 2 * tp + fp + fn > 0 ? Math.round(2 * tp / (2 * tp + fp + fn) * 100) : 0;
          const rateBtn = (key, val, current, colorActive, colorBg) => (
            <button onClick={() => onMiqRate(key, current === val ? null : val)} style={{ fontSize: 9, fontFamily: "monospace", fontWeight: 700, padding: "2px 6px", border: `1px solid ${current === val ? colorActive : "#ddd"}`, borderRadius: 3, cursor: "pointer", background: current === val ? colorBg : "#fff", color: current === val ? colorActive : "#bbb", flexShrink: 0 }}>{val}</button>
          );
          const renderRow = (text, key, icon, iconColor, borderColor, isLast) => {
            const dashIdx = text.indexOf(" — ");
            const label = dashIdx > -1 ? text.slice(0, dashIdx) : null;
            const rest = dashIdx > -1 ? text.slice(dashIdx + 3) : text;
            const e = (miqEval || {})[key] || {};
            return (
              <div key={key} style={{ padding: "9px 0", borderBottom: isLast ? "none" : `1px solid ${borderColor}`, display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{ color: iconColor, fontFamily: "monospace", fontSize: 12, flexShrink: 0, marginTop: 1 }}>{icon}</span>
                <span style={{ fontSize: 11, color: "#333", lineHeight: 1.55, flex: 1 }}>{label && <strong>{label}</strong>}{label ? " — " : ""}{rest}</span>
                {rateBtn(key, "TP", e.rating, "#27ae60", "#eafaf1")}
                {rateBtn(key, "FP", e.rating, "#e74c3c", "#fdf2f2")}
                {e.rating && <input value={e.comment || ""} onChange={ev => onMiqComment(key, ev.target.value)} placeholder="comment..." style={{ fontSize: 10, fontFamily: "monospace", border: "1px solid #eee", borderRadius: 3, padding: "2px 6px", width: 110, flexShrink: 0, marginTop: 1 }} />}
              </div>
            );
          };
          if (niqEmpty && !fn) return <div style={{ color: "#27ae60", fontFamily: "monospace", fontSize: 11, padding: "24px 0" }}>✓ No issues — brief is complete</div>;
          return (
            <>
              {sowMissing?.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, fontFamily: "monospace", color: "#e74c3c", letterSpacing: "0.12em", marginBottom: 8 }}>MISSING ({sowMissing.length})</div>
                  <div style={{ background: "#fff", borderRadius: 6, border: "1px solid #fde8e8", padding: "2px 14px" }}>
                    {sowMissing.map((m, i) => renderRow(m, `missing_${i}`, "?", "#e74c3c", "#fde8e8", i === sowMissing.length - 1))}
                  </div>
                </div>
              )}
              {sowUnclear?.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, fontFamily: "monospace", color: "#e67e22", letterSpacing: "0.12em", marginBottom: 8 }}>UNCLEAR ({sowUnclear.length})</div>
                  <div style={{ background: "#fff", borderRadius: 6, border: "1px solid #fff3e0", padding: "2px 14px" }}>
                    {sowUnclear.map((u, i) => renderRow(u, `unclear_${i}`, "⚠", "#e67e22", "#fff3e0", i === sowUnclear.length - 1))}
                  </div>
                </div>
              )}
              {conflicts?.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, fontFamily: "monospace", color: "#c0392b", letterSpacing: "0.12em", marginBottom: 8 }}>CONFLICTS ({conflicts.length})</div>
                  <div style={{ background: "#fff", borderRadius: 6, border: "1px solid #fde8e8", padding: "2px 14px" }}>
                    {conflicts.map((c, i) => {
                      const text = typeof c === "string" ? c : (c.description || c.text || "");
                      return renderRow(text, `conflict_${i}`, "⚡", "#e74c3c", "#fde8e8", i === conflicts.length - 1);
                    })}
                  </div>
                </div>
              )}

              {/* FN — manually added missed questions */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 9, fontWeight: 700, fontFamily: "monospace", color: "#8e44ad", letterSpacing: "0.12em", marginBottom: 8 }}>FN — MISSED BY AI{fn > 0 ? ` (${fn})` : ""}</div>
                {fn > 0 && (
                  <div style={{ background: "#fff", borderRadius: 6, border: "1px solid #f0e6f9", padding: "2px 14px", marginBottom: 8 }}>
                    {(miqFnItems || []).map((item, i) => (
                      <div key={i} style={{ padding: "9px 0", borderBottom: i < fn - 1 ? "1px solid #f0e6f9" : "none", display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ color: "#8e44ad", fontFamily: "monospace", fontSize: 9, fontWeight: 700, flexShrink: 0 }}>FN</span>
                        <span style={{ fontSize: 11, color: "#333", flex: 1, lineHeight: 1.55 }}>{item}</span>
                        <button onClick={() => onMiqFnRemove(i)} style={{ fontSize: 11, background: "none", border: "none", color: "#ccc", cursor: "pointer", padding: "0 4px" }}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6 }}>
                  <input value={miqFnInput} onChange={e => setMiqFnInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && miqFnInput.trim()) { onMiqFnAdd(miqFnInput.trim()); setMiqFnInput(""); } }} placeholder="AI missed: describe the question..." style={{ flex: 1, fontSize: 11, fontFamily: "monospace", border: "1px solid #e0d6f0", borderRadius: 4, padding: "5px 10px" }} />
                  <button onClick={() => { if (miqFnInput.trim()) { onMiqFnAdd(miqFnInput.trim()); setMiqFnInput(""); } }} style={{ fontSize: 10, fontFamily: "monospace", background: "#8e44ad", border: "none", color: "#fff", padding: "4px 12px", borderRadius: 4, cursor: "pointer", fontWeight: 700 }}>+ Add</button>
                </div>
              </div>

              {/* F1 evaluation panel */}
              {hasEval && (
                <div style={{ marginBottom: 16, padding: "12px 16px", background: "#f8f8f8", borderRadius: 8, border: "1px solid #e8e6e1" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: showF1 ? 12 : 0 }}>
                    <span style={{ fontSize: 10, fontFamily: "monospace", color: "#777" }}>TP: {tp} · FP: {fp} · FN: {fn}</span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => setShowF1(v => !v)} style={{ fontSize: 9, fontFamily: "monospace", background: "#1a1a1a", border: "none", color: "#fff", padding: "4px 12px", borderRadius: 4, cursor: "pointer", fontWeight: 700 }}>{showF1 ? "Hide" : "F1 Score →"}</button>
                      <button onClick={exportMiqEval} style={{ fontSize: 9, fontFamily: "monospace", background: "none", border: "1px solid #27ae60", color: "#27ae60", padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontWeight: 700 }}>↓ XLS</button>
                    </div>
                  </div>
                  {showF1 && (
                    <div style={{ display: "flex", gap: 24, marginTop: 4 }}>
                      <div><div style={{ fontSize: 9, fontFamily: "monospace", color: "#aaa", marginBottom: 2 }}>PRECISION</div><div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace" }}>{precision}%</div><div style={{ fontSize: 9, fontFamily: "monospace", color: "#aaa" }}>{tp}/{tp + fp}</div></div>
                      <div><div style={{ fontSize: 9, fontFamily: "monospace", color: "#aaa", marginBottom: 2 }}>RECALL</div><div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace" }}>{recall}%</div><div style={{ fontSize: 9, fontFamily: "monospace", color: "#aaa" }}>{tp}/{tp + fn}</div></div>
                      <div style={{ borderLeft: "1px solid #e8e6e1", paddingLeft: 24 }}><div style={{ fontSize: 9, fontFamily: "monospace", color: "#aaa", marginBottom: 2 }}>F1 SCORE</div><div style={{ fontSize: 22, fontWeight: 700, fontFamily: "monospace", color: f1 >= 80 ? "#27ae60" : f1 >= 60 ? "#e67e22" : "#e74c3c" }}>{f1}%</div></div>
                    </div>
                  )}
                </div>
              )}
            </>
          );
        })()}

        {/* ── SPEC ── */}
        {sowPage === "spec" && (() => {
          if (!deliverySpec?.length) return <div style={{ color: "#bbb", fontFamily: "monospace", fontSize: 11, padding: "24px 0" }}>SPEC not built yet — run analysis</div>;
          return (
            <div style={{ background: "#fff", borderRadius: 6, border: "1px solid #e8e6e1", overflow: "hidden" }}>
              {deliverySpec.map((item, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", padding: "8px 14px", background: i % 2 === 0 ? "#fafafa" : "#fff", borderBottom: i < deliverySpec.length - 1 ? "1px solid #f0f0f0" : "none", opacity: item.source === "unclear" ? 0.5 : 1 }}>
                  <span style={{ fontSize: 11, color: item.source === "brief" ? "#27ae60" : item.source === "unclear" ? "#e67e22" : "#aaa", fontFamily: "monospace", width: 14, flexShrink: 0, fontWeight: 700 }}>
                    {item.source === "brief" ? "✓" : item.source === "unclear" ? "⚠" : "·"}
                  </span>
                  <span style={{ fontSize: 11, color: "#555", fontFamily: "monospace", width: 220, flexShrink: 0, paddingLeft: 6 }}>{item.key}</span>
                  <span style={{ fontSize: 12, color: item.source === "unclear" ? "#bbb" : "#1a1a1a", flex: 1, textAlign: "center" }}>{item.value || "—"}</span>
                  <span style={{ fontSize: 9, fontFamily: "monospace", whiteSpace: "nowrap", color: item.source === "brief" ? "#27ae60" : item.source === "unclear" ? "#e67e22" : "#bbb" }}>
                    {item.source === "brief" ? "from brief" : item.source === "default" ? "default" : "to clarify"}
                  </span>
                </div>
              ))}
            </div>
          );
        })()}
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
  const [parseStatus, setParseStatus] = useState("");
  const [err, setErr] = useState("");
  const [stage, setStage] = useState("upload"); // "upload" | "review"

  const [tzProjectType, setTzProjectType] = useState("");
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [hoveredType, setHoveredType] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [tzRooms, setTzRooms] = useState([]);
  const [tzByRoom, setTzByRoom] = useState({});
  const [tzAnnotation, setTzAnnotation] = useState("");
  const [tzClientComments, setTzClientComments] = useState([]);
  const [tzSowMissing, setTzSowMissing] = useState([]);
  const [tzSowUnclear, setTzSowUnclear] = useState([]);
  const [tzDeliverySpec, setTzDeliverySpec] = useState([]);
  const [tzSowCoverage, setTzSowCoverage] = useState([]);
  const [buildingCoverage, setBuildingCoverage] = useState(false);
  const [tzClientTranslation, setTzClientTranslation] = useState(null); // { deliverySpec, questions, conflicts }
  const [buildingClientTranslation, setBuildingClientTranslation] = useState(false);
  const [tzConflicts, setTzConflicts] = useState([]);
  const [miqEval, setMiqEval] = useState({});
  const [miqFnItems, setMiqFnItems] = useState([]);
  const [tzRoadmap, setTzRoadmap] = useState([]);
  const [tzSources, setTzSources] = useState([]);
  const [tzSourceTags, setTzSourceTags] = useState({}); // { srcId: "furniture" | ... }

  const allFilesList = useFileList();

  // Open external links in the system browser (fixes blank window in Tauri)
  useEffect(() => {
    const handler = e => {
      const a = e.target.closest("a[href]");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (window.__TAURI__) {
        e.preventDefault();
        window.__TAURI__.opener
          ? window.__TAURI__.opener.openUrl(href)
          : window.__TAURI__.shell?.open(href);
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  const saveKey = k => { setApiKey(k); try { localStorage.setItem("anthropic_api_key", k); } catch { /* ignore */ } };

  async function buildSowCoverage(projectType, byRoom, key) {
    const template = SOW_TEMPLATES[projectType];
    if (!template) return;
    const items = template.items.filter(i => typeof i === "string" ? !i.startsWith("---") : true);
    if (!items.length) return;

    // Format tz_by_room as readable text (no images)
    const tzText = Object.entries(byRoom || {}).flatMap(([room, cats]) =>
      Object.entries(cats || {}).flatMap(([cat, its]) =>
        (its || []).map(it => `${room} / ${cat}: ${it.text}${it.source ? ` [${it.source}]` : ""}`)
      )
    ).join("\n");

    const prompt = `You are an assistant checking SOW checklist coverage against parsed project requirements.

Project type: ${projectType}

SOW checklist (${items.length} items):
${items.map((item, i) => `${i + 1}. ${typeof item === "string" ? item : item.text}`).join("\n")}

Parsed project requirements:
${tzText || "(no data)"}

For EACH checklist item determine:
- status: "found" — information is present and sufficient
- status: "partial" — information is present but incomplete or partial
- status: "missing" — information is completely absent
- found: brief description of what was found (1 line), or "" if absent
- source: "filename p.N" or "" if unknown

RESPOND ONLY WITH JSON (array of exactly ${items.length} elements, one per checklist item):
{"sow_coverage":[{"item":"...","status":"found","found":"...","source":"..."}]}`;

    setBuildingCoverage(true);
    try {
      const result = await callAPI([{ type: "text", text: prompt }], 2, key);
      setTzSowCoverage(result.sow_coverage || []);
    } catch { /* silent — coverage tab will simply be empty */ }
    setBuildingCoverage(false);
  }

  async function buildClientTranslation() {
    if (tzClientTranslation || buildingClientTranslation) return;
    const hasContent = tzDeliverySpec?.length || tzSowMissing?.length || tzSowUnclear?.length || tzConflicts?.length;
    if (!hasContent || !apiKey?.trim()) return;

    const payload = {
      delivery_spec: (tzDeliverySpec || []).map(i => ({ key: i.key, value: i.value || "" })),
      questions: [...(tzSowMissing || []), ...(tzSowUnclear || [])],
      conflicts: (tzConflicts || []).map(c => typeof c === "string" ? c : (c.description || c.text || "")),
    };

    const prompt = `Translate the following project brief data from Ukrainian to English. Keep technical values as-is (e.g. "4K", "72 dpi", "JPEG", numbers, proper nouns). Translate only human-readable labels and sentences.

Input JSON:
${JSON.stringify(payload, null, 2)}

Return ONLY valid JSON in exactly the same structure with translated values:
{"delivery_spec":[{"key":"...","value":"..."}],"questions":["..."],"conflicts":["..."]}`;

    setBuildingClientTranslation(true);
    try {
      const result = await callAPI([{ type: "text", text: prompt }], 2, apiKey);
      setTzClientTranslation({
        deliverySpec: (result.delivery_spec || []).map((t, i) => ({ ...tzDeliverySpec[i], key: t.key, value: t.value })),
        questions: result.questions || [],
        conflicts: result.conflicts || [],
      });
    } catch { /* silent */ }
    setBuildingClientTranslation(false);
  }

  const readyFiles = fl => (fl.files || []).filter(f => !f._loading && !f._error && f._done);

  // Build index for img_ref: { preview, full, filename, pageNum, fileLabel }
  const buildImgIndex = () => {
    const idx = {};
    const catCounters = {};
    readyFiles(allFilesList).forEach((f) => {
      const cat = f._category || "File";
      catCounters[cat] = (catCounters[cat] || 0) + 1;
      const fileLabel = cat === "Unclassified"
        ? f.filename.replace(/\.[^.]+$/, "")
        : `${cat} ${catCounters[cat]}`;
      (f.pages || []).filter(p => p._selected !== false).forEach((pg, pi) => {
        if (pg.preview || pg.b64) {
          const entry = { preview: pg.preview, full: pg.b64 ? `data:image/jpeg;base64,${pg.b64}` : pg.preview, filename: f.filename, pageNum: pi + 1, fileLabel, category: cat };
          const key = pi === 0 ? fileLabel.toLowerCase() : `${fileLabel.toLowerCase()} p.${pi + 1}`;
          idx[key] = entry;
          // Also index without trailing number (e.g. "edison vanity" → first page of that category)
          const keyNoNum = cat.toLowerCase();
          if (!idx[keyNoNum]) idx[keyNoNum] = entry;
          if (pi > 0) {
            // "cat p.N" without the counter number
            const keyNoNumPage = `${cat.toLowerCase()} p.${pi + 1}`;
            if (!idx[keyNoNumPage]) idx[keyNoNumPage] = entry;
          }
        }
      });
    });
    return idx;
  };

  // Resolve img_ref from Claude against the index
  // New format: { file: "STYLE / MOODBOARD 1", page: 2 }
  // Legacy fallback: plain string "STYLE / MOODBOARD 1 p.2"
  const resolveImgRef = (imgRef, idx) => {
    if (!imgRef) return null;
    const norm = s => s.replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

    let fileKey, page;
    if (typeof imgRef === 'object' && imgRef.file) {
      fileKey = norm(imgRef.file);
      page = imgRef.page || 1;
    } else {
      // Legacy: parse "FILE p.N" string
      const s = norm(String(imgRef));
      const m = s.match(/^(.*?)\s+p\.(\d+)$/);
      fileKey = m ? m[1] : s;
      page = m ? parseInt(m[2]) : 1;
    }

    // Build exact key
    const key = page > 1 ? `${fileKey} p.${page}` : fileKey;
    if (idx[key]) return idx[key];

    // Fuzzy: find index entry whose file part matches fileKey
    const found = Object.keys(idx).find(k => {
      const kFile = k.replace(/\s+p\.\d+$/, '');
      return kFile === fileKey || kFile.startsWith(fileKey) || fileKey.startsWith(kFile);
    });
    return found ? idx[found] : null;
  };

  async function parseTz() {
    if (!apiKey.trim()) { setErr("Enter Anthropic API key"); return; }
    const allFiles = readyFiles(allFilesList);
    if (!briefText.trim() && allFiles.length === 0) { setErr("Upload files or enter brief text"); return; }

    // Warn if some files are still loading
    const stillLoading = (allFilesList.files || []).filter(f => f._loading);
    if (stillLoading.length > 0) {
      setErr(`Please wait — still processing ${stillLoading.length} file${stillLoading.length > 1 ? "s" : ""}: ${stillLoading.map(f => f.filename).join(", ")}`);
      return;
    }

    setErr(""); setParseStatus(""); setParsing(true);

    // Number files within each category
    const catCounters = {};
    const labeledFiles = allFiles.map(f => {
      const cat = f._category || "File";
      catCounters[cat] = (catCounters[cat] || 0) + 1;
      const label = cat === "Unclassified"
        ? f.filename.replace(/\.[^.]+$/, "")
        : `${cat.toUpperCase()} ${catCounters[cat]}`;
      return { ...f, _label: label };
    });

    // Pack standalone image files into a contact-sheet PDF when there are many
    let filesToProcess = labeledFiles;
    const imgOnlyFiles = labeledFiles.filter(f => f.type === "image");
    if (imgOnlyFiles.length > 6) {
      setParseStatus(`Packing ${imgOnlyFiles.length} reference images…`);
      try {
        const packInput = imgOnlyFiles.map(f => ({ filename: f.filename, b64: f.b64, mediaType: "image/jpeg" }));
        const packedPdfFile = await packImagesToPdf(packInput);
        const packedData = await processFile(packedPdfFile);
        if (packedData) {
          filesToProcess = [
            ...labeledFiles.filter(f => f.type !== "image"),
            { ...packedData, _label: "REFERENCES", _category: "References", _skipPreExtract: true },
          ];
        }
      } catch (e) {
        console.warn("Image packing failed, sending originals:", e);
      }
    }

    // Pre-process large PDFs: chunk into Haiku batches, extract text per page
    let processedFiles;
    try {
      processedFiles = await preProcessLargeFiles(filesToProcess, apiKey, setParseStatus);
    } catch (e) {
      setErr(`Pre-processing error: ${e.message}`);
      setParsing(false); setParseStatus("");
      return;
    }

    setParseStatus("Sending to Claude…");

    // File manifest for the prompt
    const manifest = processedFiles.map(f => `  • ${f._label} [${f.ext || f.type?.toUpperCase()}]: ${f.filename}${f._preExtracted ? ` (${f._totalPages} pages, pre-extracted)` : ""}${f._confidence === "low" ? " (?)" : ""}`).join("\n");

    const imgIndex = buildImgIndex();

    const sowTypes = Object.keys(SOW_TEMPLATES).join(" | ");
    const activeTemplateEntries = selectedTypes.length > 0
      ? Object.entries(SOW_TEMPLATES).filter(([t]) => selectedTypes.includes(t))
      : Object.entries(SOW_TEMPLATES);
    const sowTemplatesText = activeTemplateEntries
      .map(([type, { items, defaults }]) => {
        let text = `${type}:\n${items.map(i => typeof i === "string" ? `  ${i}` : `  - [${i.cat}] ${i.text}`).join("\n")}`;
        if (defaults && Object.keys(defaults).length > 0) {
          text += `\n  Defaults (if client did not specify):\n${Object.entries(defaults).map(([k, v]) => `    • ${k}: ${v}`).join("\n")}`;
        }
        return text;
      })
      .join("\n\n");
    const taskFourItemsList = activeTemplateEntries
      .map(([type, { items }]) => {
        const itemLines = items
          .filter(i => typeof i === "object" && i.text)
          .map(i => `  [${i.cat}] ${i.text}`)
          .join("\n");
        return `${type}:\n${itemLines}`;
      })
      .join("\n\n");
    const parts = [{ type: "text", text: `You are an experienced 3D artist and PM analyzing incoming brief materials BEFORE project start. Your goal is not just to extract requirements, but to prepare a complete roadmap and delivery checklist so the team (visualizer + AD + PM) can verify the result against what the client requested.

LANGUAGE: input materials may be in any language — Ukrainian, Russian, English, mixed. Recognize requirements regardless of language. Always respond ONLY in English.

WORKING PRINCIPLES:
1. Extract EVERYTHING explicitly stated in the provided documents — miss nothing. Do NOT add knowledge from outside the files (no assumptions, no guesses). If a requirement is in the files but not in the SOW template — still extract it under "Client Requirements". If a value is absent from all files — mark as missing.
2. Read ALL files together — cross-reference brief with drawings, references with comments, specs with each other. Each <document> tag is a separate source — track which source each finding comes from.
3. Think like an artist: "what do I need to do to start this project without rework?"
4. Extract ALL links (URLs) from any source — furniture, catalogs, Pinterest, Behance, brands, colors, maps — and attach to the specific requirement
5. Flag contradictions between files — if the brief conflicts with a drawing, or a reference doesn't match the text description

PDF FORMS: Pages from Archivizer "Master Direction" forms include a "FORM DATA:" section with pre-extracted field values (☑ = checked checkbox, [FIELD] = typed text, [COMMENT] = annotation). Treat all FORM DATA entries as source: "brief" — confirmed client selections, not defaults.

DWG/DXF DRAWINGS: if DWG or DXF is present — mandatory:
- Extract room names from "LABELS" and "LAYERS" — they form the rooms list
- Extract dimensions — add to "Drawings" category with img_ref pointing to this file
- Cross-check with brief: discrepancies → conflicts and sow_unclear
- Rooms in drawing with no requirements → sow_missing

INPUT FILES:
${manifest || "(no files)"}

BRIEF TEXT:
${briefText.trim() || "(see attached materials)"}

IMPORTANT: for each page, "extracted text" is provided — use it as the primary source for dimensions, names, specs and numbers. The image supplements the text.

TASK 1 — project_type:
${selectedTypes.length > 0
  ? `Type(s) already selected by PM: ${selectedTypes.join(", ")}. Use exactly these types — do not change. If multiple selected, return the first as project_type.`
  : `Determine one option: ${sowTypes}`}

TASK 2 — project_annotation:
Brief description (3-5 sentences): space type, area/number of rooms, style, key materials, what was provided.

TASK 3 — rooms:
Array of rooms/zones. General requirements (style, lighting, cameras, deadline) — put in "General". If rooms are not defined — only ["General"].

TASK 4 — tz_by_room:
Two-pass extraction:

Pass 1 — Template → Brief: go through each template item listed below. Search for it in the provided files. If found — add to tz_by_room. If not found — skip (it will appear in sow_missing via TASK 6).
Pass 2 — Brief → Template: scan ALL files again for any client requirements NOT already captured in Pass 1. Classify extras into the appropriate template category. Anything that doesn't fit → "Client Requirements".

SOW template items for this project type:
${taskFourItemsList}

Rules for each extracted item:
- Place it under the correct room ("General" if not room-specific) and the EXACT category from the template — do not rename or merge categories
- text = FULL description: name + material + color + finish + size + brand/model
- ATOMICITY: one item = one requirement. If a sentence contains multiple objects ("sofa + armchair + table") — split into separate items
- quote = verbatim quote from input materials, or null
- stage = "Modeling" | "Texturing" | "Lighting" | "Cameras" | "Post-production" | "Delivery"
- img_ref: { "file": "file label", "page": N } or null
- source: input file category label
- links: [ { url, label, type } ] where type: "furniture"|"material"|"reference"|"color"|"catalog"|"product"|"map"|"other". If no links — []
- MATERIAL SPECIFICITY: always write the exact brand/model/article number. "LVT Katanga Oxford" not "vinyl". "Minotti Lawrence" not "sofa". If catalog/article number is visible — include it. Never generalize.
- REFERENCES: for EACH reference image, extract the SPECIFIC ASPECT to adopt. Not just "style reference" — write what exactly to take: "Reference — warm golden-hour lighting, soft shadows" or "Reference — composition: sofa facing window, low camera angle" or "Reference — matte concrete wall finish". State color palette / lighting type / mood / proportions / material finish — whichever is visible and relevant.
- FLOOR PLAN CAMERAS: if a DWG/floor plan is present, numbered camera markers (triangles, arrows, numbered circles) = camera positions. Extract EACH as a separate item in the "Client Requirements" category: "Camera [N] — position: [location, e.g. 'facing North from living room entrance']". Use img_ref pointing to the drawing page.
- WINDOW & DOOR SCHEDULES: if a window schedule or door schedule is found in drawings → place in the "Drawings" category with img_ref pointing to that drawing page.
- ELEVATIONS: wall elevations, cabinet/kitchen elevations, section drawings → place in "Drawings" category with img_ref pointing to the drawing page.
  - Identify drawing type: PRECISE (has dimensions, scale bar, measurements) or SCHEMATIC (intent-only sketch, no scale).
  - From PRECISE elevation: extract opening sizes, heights, shelf positions, dimensions shown.
  - From SCHEMATIC elevation: extract INTENT — what client wants where ("TV unit centered", "shelf niche at 1200mm height", "backlit panel left side", "mirror above console"). Do not skip schematic elevations even if no dimensions.
  - If BOTH a DWG/precise drawing AND a schematic PDF elevation exist for the same wall or room — cross-reference them: note what the schematic intends and what dimensions/structure the DWG provides.
  - Each element shown on an elevation (fixture, niche, panel, opening, finish zone) → extract as a separate item with img_ref.
Structure: { "Room": { "Category": [ {id, text, quote, stage, source, img_ref, links} ] } }

TASK 5 — conflicts:
Contradictions between input files. Each entry: "Conflict: [what contradicts what]. Source A: [file/quote]. Source B: [file/quote]. Question: [what needs clarification]"
Example: "Conflict: living room wall color. Source A: brief — 'walls dark grey'. Source B: moodboard p.2 — reference with light walls. Question: which version is priority?"
- DRAWING vs BRIEF: if a schematic elevation shows an element (built-in wardrobe, niche, shelf) but the DWG shows a structural element (door, column, beam) in the same wall position — flag as conflict.
- ELEVATION vs TEXT: if an elevation drawing shows one finish or material but the brief text states another — flag as conflict.
- PRECISE vs SCHEMATIC: if DWG dimensions and schematic elevation intent are incompatible (e.g. schematic shows wide unit but DWG wall is too narrow) — flag as conflict.

// TASK 6 (roadmap) — disabled, UI hidden. Re-enable when roadmap view is restored.

TASK 6 — sow_missing and sow_unclear:
Cross-check input materials against the full SOW template for the determined project type (project_type from Task 1).
Templates by type:
${sowTemplatesText}

- sow_missing: template items that are COMPLETELY absent from input materials.
  - If the item has a default in the template → DO NOT ask the client. Format: "Item name — not specified. Will use: [default]. Confirm or send replacement"
  - If no default → format: "Item name — what the client needs to provide"
  - Never add to sow_missing if the value can be inferred from context (e.g. geolocation provided → no need to ask about regional electrical standards)
- sow_unclear: template items that are present but incomplete or unclear.
  - Format: "Item name — found: [what exists]. Ask client: '[question phrased directly to the client, as if writing to them]'"
  - One question per item — specific, not generic. Bad: "What materials?" Good: "Please specify RAL/HEX code for the living room accent wall"
  - Do NOT ask if the answer is obvious from context or can be resolved with the template default

TASK 7 — delivery_spec:
For each SOW template item where you found a concrete value in the client materials, report:
{ "key": "exact item text", "value": "short value (1-2 words or phrase)", "source": "brief" }
IMPORTANT: key must exactly match the template item text — do not shorten or rephrase, no [category] prefix.
Only include items with source "brief" — skip everything else. Defaults and unclear states are handled automatically.

TASK 8 — sources:
Page-by-page source log — what was found in each file/page.
Structure: [ { file: "file label", page: N, found: [ { id, type, description } ] } ]
- file: file label (e.g. "MOODBOARD 1", "DRAWINGS", "BRIEF TEXT")
- page: page number (1 if single page)
- found: list of what was found on this page
- type: "furniture" | "material" | "lighting" | "style_ref" | "time_of_day" | "weather" | "render_quality" | "camera" | "dimensions" | "logo" | "comment" | "elevation_precise" | "elevation_schematic" | "section" | "other"
- description: brief description of what exactly (product name, brand, description)
Include EVERYTHING on the page — furniture, materials, style references, time of day, weather, render quality, angles, dimensions.

// TASK 10 (client_comments) — disabled, UI hidden. Re-enable when comments view is restored.

RESPOND ONLY WITH JSON:
{"project_type":"...","project_annotation":"...","rooms":["General","Living Room"],"tz_by_room":{"General":{"References":[{"id":"tz1","text":"Scandinavian style, natural materials, muted tones","quote":"scandinavian style, natural materials","stage":"Texturing","source":"MOODBOARD 1","img_ref":{"file":"MOODBOARD 1","page":1},"links":[]}]},"Living Room":{"Furniture & Objects":[{"id":"tz2","text":"Sofa — Minotti Lawrence, grey velvet","quote":"sofa Minotti Lawrence grey","stage":"Modeling","source":"MATERIALS 1","img_ref":{"file":"MATERIALS 1","page":2},"links":[{"url":"https://minotti.com/...","label":"Minotti Lawrence","type":"furniture"}]}]}},"conflicts":["Conflict: living room wall color. Source A: brief — 'dark grey walls'. Source B: moodboard p.2 — light interior. Question: which version is priority?"],"sources":[{"file":"MOODBOARD 1","page":2,"found":[{"id":"src1","type":"furniture","description":"Sofa Minotti Lawrence, grey velvet"},{"id":"src2","type":"style_ref","description":"Scandinavian style, natural materials"}]},{"file":"DRAWINGS","page":1,"found":[{"id":"src3","type":"dimensions","description":"Living room 6×4m, bedroom 4×3.5m"}]}],"sow_missing":["Time of day — not specified. Will use: day. Confirm or send replacement","Furniture — links or brand required for each item"],"sow_unclear":["Wall color — found: 'replace green'. Unclear: what color — need RAL/HEX"],"delivery_spec":[{"key":"Resolution","value":"4K","source":"brief"},{"key":"Time of day","value":"evening","source":"brief"}]}` }];

    parts.push(...filesToParts(processedFiles, "FILE"));

    try {
      const result = await callAPI(parts, 2, apiKey);

      // Validate top-level structure
      if (!result || typeof result !== 'object') throw new Error("Response is not an object");
      if (!result.tz_by_room || typeof result.tz_by_room !== 'object' || Array.isArray(result.tz_by_room))
        throw new Error("tz_by_room is missing or has wrong type");

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
                  ? `${item.img_ref.file}${item.img_ref.page > 1 ? ` p.${item.img_ref.page}` : ''}`
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
      // Filter sow_missing: items with a default ("Will use:") stay visible for PM awareness
      // but items that have defaults AND are confirmed by brief go to delivery_spec, not missing
      const detectedTypeForFilter = result.project_type || "";
      const filterTemplate = SOW_TEMPLATES[detectedTypeForFilter];
      const templateDefaults = filterTemplate?.defaults || {};
      const rawMissing = result.sow_missing || [];
      // Keep all missing items — PM needs to see defaults applied. Filter only truly redundant duplicates.
      const filteredMissing = rawMissing.filter((m, i, arr) => arr.indexOf(m) === i); // dedupe only
      setTzSowMissing(filteredMissing);
      setTzSowUnclear(result.sow_unclear || []);
      // Build delivery_spec strictly from template — 1:1 with SOW_TEMPLATES items, no more no less
      const detectedType = result.project_type || "";
      const specTemplate = SOW_TEMPLATES[detectedType];
      const claudeSpec = result.delivery_spec || [];
      const normalizedSpec = specTemplate
        ? specTemplate.items
            .filter(i => typeof i === "object" && i.text && !i.text.startsWith("---"))
            .map(i => {
              const fromClaude = claudeSpec.find(s => s.key === i.text);
              if (fromClaude && fromClaude.source === "brief") return fromClaude;
              if (specTemplate.defaults[i.text]) return { key: i.text, value: specTemplate.defaults[i.text], source: "default" };
              return { key: i.text, value: "—", source: "unclear" };
            })
        : claudeSpec;
      setTzDeliverySpec(normalizedSpec);
      setTzConflicts(result.conflicts || []);
      setTzRoadmap(result.roadmap || []);
      setTzSources(result.sources || []);
      setTzSourceTags({});
      setTzClientTranslation(null);
      setMiqEval({});
      setMiqFnItems([]);
      saveSession({ savedAt: new Date().toISOString(), projectType: result.project_type || "", rooms, tzByRoom: stripImgRefs(byRoom), tzAnnotation: result.project_annotation || "", clientComments: result.client_comments || [], sowMissing: result.sow_missing || [], sowUnclear: result.sow_unclear || [], deliverySpec: normalizedSpec, sowCoverage: [], conflicts: result.conflicts || [], roadmap: result.roadmap || [], sources: result.sources || [], miqEval: {}, miqFnItems: [] });
      setStage("review");
      buildSowCoverage(result.project_type || "", byRoom, apiKey);
    } catch (e) {
      setErr(`Error: ${e.message}`);
    }
    setParsing(false); setParseStatus("");
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

  // Load previous session
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
        deliverySpec={tzDeliverySpec}
        sowCoverage={tzSowCoverage}
        buildingCoverage={buildingCoverage}
        conflicts={tzConflicts}
        roadmap={tzRoadmap}
        sources={tzSources}
        files={readyFiles(allFilesList)}
        sourceTags={tzSourceTags}
        onSourceTag={(id, tag) => setTzSourceTags(prev => ({ ...prev, [id]: tag }))}
        onEdit={handleEditItem}
        onRemove={handleRemoveItem}
        onBack={() => setStage("upload")}
        clientTranslation={tzClientTranslation}
        buildingClientTranslation={buildingClientTranslation}
        onBuildClientTranslation={buildClientTranslation}
        miqEval={miqEval}
        onMiqRate={(key, rating) => setMiqEval(prev => ({ ...prev, [key]: { ...(prev[key] || {}), rating } }))}
        onMiqComment={(key, comment) => setMiqEval(prev => ({ ...prev, [key]: { ...(prev[key] || {}), comment } }))}
        miqFnItems={miqFnItems}
        onMiqFnAdd={item => setMiqFnItems(prev => [...prev, item])}
        onMiqFnRemove={i => setMiqFnItems(prev => prev.filter((_, idx) => idx !== i))}
      />
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f5f4f1" }}>
      {/* Header */}
      <div style={{ background: "#1a1a1a", padding: "10px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#f2f0ec", fontFamily: "monospace", letterSpacing: "0.1em" }}>DOC NEXUS</span>
        <span style={{ fontSize: 9, color: "#666", fontFamily: "monospace" }}>v0.2 — 3D visualization brief analyzer</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 9, color: "#555", fontFamily: "monospace" }}>ANTHROPIC</span>
            <input
              value={apiKey}
              onChange={e => saveKey(e.target.value)}
              type="password"
              placeholder="sk-ant-..."
              style={{ background: "#2a2a2a", border: "1px solid #333", color: "#aaa", fontSize: 10, fontFamily: "monospace", padding: "4px 8px", borderRadius: 4, width: 160, outline: "none" }}
            />
            <button onClick={() => saveKey("")} style={{ fontSize: 9, fontFamily: "monospace", background: "none", border: "none", color: "#444", cursor: "pointer", padding: "0 2px" }} title="Sign out / change key">×</button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px" }}>

        {/* Upload zone */}
        <div style={{ marginBottom: 20 }}>
          <UploadBox label="PROJECT FILES" files={allFilesList.files} onAdd={allFilesList.add} onRemove={allFilesList.remove} onUpdateFile={allFilesList.updateById} color="#1a1a1a" note="PDF, DOCX, TXT, images, DWG, DXF, Excel, CSV — any files" />
        </div>

        {/* Brief text */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.14em", color: "#888", marginBottom: 5, fontFamily: "monospace" }}>BRIEF TEXT (optional)</div>
          <textarea
            value={briefText}
            onChange={e => setBriefText(e.target.value)}
            rows={4}
            placeholder="Describe the project: space type, style / atmosphere, key materials, number of angles, final file format, deadline. Or just upload files above — text is optional."
            style={{ width: "100%", border: "1px solid #e0ddd8", borderRadius: 8, padding: "10px 12px", fontSize: 12, fontFamily: "inherit", resize: "vertical", outline: "none", background: "#fff", color: "#333", lineHeight: 1.6 }}
          />
        </div>

        {err && <div style={{ background: "#fff5f5", border: "1px solid #e74c3c44", borderRadius: 8, padding: "10px 14px", fontSize: 11, color: "#e74c3c", fontFamily: "monospace", marginBottom: 12 }}>{err}</div>}

        {/* Pre-parse stats */}
        {(() => {
          const ready = readyFiles(allFilesList);
          const loading = (allFilesList.files || []).filter(f => f._loading);
          const imgFiles = ready.filter(f => f.type === "image");
          const nonImgFiles = ready.filter(f => f.type !== "image");
          const willPack = imgFiles.length > 6;
          const imgPages = willPack ? Math.ceil(imgFiles.length / 4) : imgFiles.length;
          const nonImgPages = nonImgFiles.reduce((sum, f) => sum + (f.pages || []).filter(p => p._selected !== false && p.b64).length, 0);
          const totalPages = imgPages + nonImgPages;
          const tooMany = totalPages > 80;
          const largeFiles = [...ready, ...loading].filter(f => f._size > 30 * 1024 * 1024);
          if (!ready.length && !loading.length) return null;
          return (
            <div style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {loading.length > 0 && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#e67e22", background: "#fff8f0", border: "1px solid #f0c060", padding: "3px 8px", borderRadius: 4 }}>⏳ processing: {loading.length} file{loading.length > 1 ? "s" : ""}</span>}
              {largeFiles.length > 0 && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#e67e22", background: "#fff8f0", border: "1px solid #f0c060", padding: "3px 8px", borderRadius: 4 }}>
                ⚠ large file{largeFiles.length > 1 ? "s" : ""}: {largeFiles.map(f => `${f.filename} (${(f._size / 1024 / 1024).toFixed(0)}MB)`).join(", ")} — may slow down processing
              </span>}
              {willPack && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#2980b9", background: "#f0f6fc", border: "1px solid #acd", padding: "3px 8px", borderRadius: 4 }}>
                {imgFiles.length} images → packed into PDF ({imgPages} pages)
              </span>}
              {totalPages > 0 && <span style={{ fontSize: 10, fontFamily: "monospace", color: tooMany ? "#e74c3c" : "#555", background: tooMany ? "#fff5f5" : "#f5f4f1", border: `1px solid ${tooMany ? "#e74c3c44" : "#ddd"}`, padding: "3px 8px", borderRadius: 4 }}>
                {tooMany ? "⚠ " : ""}{totalPages} pages to API{tooMany ? " — too many, reduce selection" : ""}
              </span>}
              {ready.length > 0 && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#888", background: "#f5f4f1", border: "1px solid #ddd", padding: "3px 8px", borderRadius: 4 }}>{ready.length} file{ready.length > 1 ? "s" : ""} ready</span>}
            </div>
          );
        })()}

        {/* Project type selector */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 9, fontFamily: "monospace", color: "#888", letterSpacing: "0.1em", marginBottom: 6 }}>
            SELECT PROJECT TYPE
            {selectedTypes.length === 0 && <span style={{ color: "#ccc", fontWeight: 400, letterSpacing: 0 }}> — if unknown, AI will detect automatically</span>}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {Object.keys(SOW_TEMPLATES).map(t => {
              const active = selectedTypes.includes(t);
              return (
                <button key={t}
                  onClick={() => setSelectedTypes(prev => active ? prev.filter(x => x !== t) : [...prev, t])}
                  onMouseEnter={e => { setHoveredType(t); const r = e.currentTarget.getBoundingClientRect(); setTooltipPos({ x: r.left, y: r.bottom + 6 }); }}
                  onMouseLeave={() => setHoveredType(null)}
                  style={{ fontSize: 10, fontFamily: "monospace", padding: "4px 10px", borderRadius: 20, border: `1px solid ${active ? "#1a1a1a" : "#ddd"}`, background: active ? "#1a1a1a" : "#fff", color: active ? "#fff" : "#666", cursor: "pointer", transition: "all 0.1s" }}>
                  {t}
                </button>
              );
            })}
          </div>
          {hoveredType && (
            <div style={{ position: "fixed", top: tooltipPos.y, left: tooltipPos.x, zIndex: 9999, fontSize: 11, color: "#555", lineHeight: 1.5, background: "#faf9f6", border: "1px solid #e0ddd8", borderRadius: 6, padding: "8px 12px", maxWidth: 340, boxShadow: "0 4px 12px rgba(0,0,0,0.10)", pointerEvents: "none" }}>
              <div style={{ fontFamily: "monospace", fontSize: 10, color: "#aaa", marginBottom: 3 }}>{hoveredType}</div>
              {TYPE_DESCRIPTIONS[hoveredType]}
            </div>
          )}
        </div>

        {/* CTA */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={parseTz}
            disabled={parsing}
            style={{ flex: 1, background: parsing ? "#444" : "#1a1a1a", color: "#f2f0ec", border: "none", padding: "16px", fontSize: 13, letterSpacing: "0.14em", fontFamily: "monospace", cursor: parsing ? "not-allowed" : "pointer", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}
          >
            {parsing
              ? <><div style={{ width: 14, height: 14, border: "2px solid #666", borderTop: "2px solid #fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} /><span style={{ fontSize: 11, letterSpacing: "0.05em", maxWidth: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{parseStatus || "ANALYZING BRIEF…"}</span></>
              : "CREATE SOWa →"
            }
          </button>
          {(allFilesList.files.length > 0 || briefText.trim() || selectedTypes.length > 0) && !parsing && (
            <button
              onClick={() => { allFilesList.clearAll(); setBriefText(""); setSelectedTypes([]); setErr(""); }}
              style={{ background: "#fff", border: "1px solid #ddd", color: "#999", padding: "16px 18px", fontSize: 11, letterSpacing: "0.1em", fontFamily: "monospace", cursor: "pointer", borderRadius: 8, whiteSpace: "nowrap" }}
            >
              CLEAR ALL
            </button>
          )}
        </div>

        {/* Return to active session */}
        {tzRooms.length > 0 && (
          <div style={{ marginTop: 16, padding: "10px 14px", background: "#f0f7ff", border: "1px solid #b3d4f5", borderRadius: 8, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 10, color: "#2980b9", fontFamily: "monospace", flex: 1 }}>
              {tzProjectType || "Session"}
            </span>
            <button
              onClick={() => setStage("review")}
              style={{ fontSize: 10, fontFamily: "monospace", background: "#2980b9", border: "none", color: "#fff", padding: "4px 12px", borderRadius: 4, cursor: "pointer", fontWeight: 700 }}
            >
              Return →
            </button>
          </div>
        )}

        {/* Last session */}
        {lastSession && tzRooms.length === 0 && (
          <div style={{ marginTop: 16, padding: "10px 14px", background: "#fff", border: "1px solid #e8e6e1", borderRadius: 8, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 10, color: "#888", fontFamily: "monospace", flex: 1 }}>
              Last session: {new Date(lastSession.savedAt).toLocaleString()}
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
                setTzDeliverySpec(lastSession.deliverySpec || []);
                setTzSowCoverage(lastSession.sowCoverage || []);
                setTzConflicts(lastSession.conflicts || []);
                setMiqEval(lastSession.miqEval || {});
                setMiqFnItems(lastSession.miqFnItems || []);
                setTzRoadmap(lastSession.roadmap || []);
                setTzSources(lastSession.sources || []);
                setTzSourceTags({});
                setStage("review");
              }}
              style={{ fontSize: 10, fontFamily: "monospace", background: "transparent", border: "1px solid #ddd", color: "#555", padding: "4px 10px", borderRadius: 4, cursor: "pointer" }}
            >
              Restore
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
