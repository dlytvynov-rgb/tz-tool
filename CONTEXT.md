# Doc Nexus — Project Context

> Для нового розробника або AI. Оновлюється після кожної сесії.
> Останнє оновлення: 01.05.2026

---

## Що це

**Doc Nexus** — інструмент для PM-ів в архітектурно-візуалізаційній студії (Archivizer).

PM отримує від клієнта пакет файлів (бриф PDF, креслення DWG, референси зображення, Excel специфікація) і хоче за 30 секунд отримати:
1. **SOWa** — структуровані вимоги проекту по категоріях
2. **SOWa + BT** — delivery spec (що рендерити: кількість, формат, розміри)
3. **MIQ** — список питань клієнту: що відсутнє, що незрозуміле, які протиріччя

Інструмент аналізує файли через Claude API і видає структурований результат.

---

## Стек

| | |
|---|---|
| Frontend | React + Vite |
| Головний файл | `src/App.jsx` (~3800+ рядків) |
| AI | Claude Sonnet 4.6 (основний) + Claude Haiku 4.5 (pre-extraction) |
| PDF | pdfjs-dist |
| DWG/DXF | @mlightcad/libredwg-web 0.7.1 → SVG → PNG |
| Excel/CSV | SheetJS |
| DOCX | mammoth + JSZip (для embedded images) |
| PDF генерація | pdf-lib (image packing) |
| FBX | Three.js FBXLoader — об'єкти, розміри, матеріали |
| TIFF | utif — RGBA decode → canvas → JPEG |
| OCR | Tesseract.js — сканований PDF + embedded images в DOCX (eng + ukr, lazy load) |
| Excel експорт | xlsx |
| Desktop | Tauri → Mac .dmg + Windows .msi |
| Деплой | GitHub Pages (auto on push to master) |

**Репо:** https://github.com/dlytvynov-rgb/tz-tool  
**Web:** https://dlytvynov-rgb.github.io/tz-tool/

---

## Як запустити

```bash
npm install
npm run dev      # локально
npm run build    # продакшн білд
```

API ключ вводиться в UI і зберігається в localStorage. Запити йдуть напряму з браузера до `api.anthropic.com`.

---

## Pipeline (порядок виконання)

```
Файли від користувача (PDF / DWG / DXF / зображення / TIFF / Excel / DOCX / FBX / ZIP)
        ↓
1. Парсинг і класифікація файлів
   • PDF → pdfjs (текст + форми + OCR для сканів)
   • DOCX → mammoth + JSZip (текст + embedded image OCR через Tesseract)
   • TIFF → utif (RGBA → canvas → JPEG)
   • DWG → libredwg (тексти, шари, INSERT блоки: DOORS / WINDOWS / BLOCKS)
        ↓
2. Image packing: > 6 image-файлів → contact-sheet PDF (2×2 grid, pdf-lib)
        ↓
3. preProcessLargeFiles: PDF > 15 стор. → Haiku pre-extraction (по 8 стор./батч)
   !! packed PDF з _skipPreExtract: true → минає Haiku, летить напряму до Sonnet
        ↓
4. filesToParts(): збірка промпту (XML обгортки + scoring matrix + ЗАВДАННЯ 1–8)
        ↓
5. Один виклик Claude Sonnet 4.6 через callAPIStructured()
        ↓
6. tool_use відповідь → гарантований валідний JSON (без парсингу)
   !! Haiku pre-extraction — все ще використовує extractJson() + jsonrepair
        ↓
7. delivery_spec normalization (client-side, по шаблону типу проекту)
        ↓
8. UI: SOWa / SOWa+BT / MIQ вкладки
```

---

## Ключові технічні рішення (і чому)

### Scoring Matrix для TASK 1 (визначення типу проекту)
Раніше Claude вгадував тип проекту по загальному контексту — ~50-60% точність. Тепер в промпті — scoring matrix побудована з 15 реальних PDF-брифів Archivizer. Тільки вербатимні назви полів, жодних вигаданих параметрів.
- **Score 3** (11 кластерів): одне поле однозначно визначає тип. Напр: "Grout depth" → Floor Rendering, "Bedding: Pillows/Blanket" → Mattress Rendering
- **Score 2** (8 кластерів): сильний сигнал в парі з контекстом
- **Score 1** (6 кластерів): слабкий сигнал, лише в сумі
- 7 правил тай-брейку (DWG → Interior over Design, "Background Fill: Transparent" → Silo over Lifestyle, etc.)
- Оцінна точність: ~80-85%

### TIFF підтримка
Браузери не рендерять TIFF. Бібліотека `utif` декодує TIFF в RGBA пікселі → малюємо на canvas (max 1024px) → конвертуємо в JPEG для Claude. Стискання: починаємо з qq=0.72, зменшуємо до qq≥0.3 якщо b64 > 2.5MB.

### DOCX embedded image OCR
`mammoth.js` витягує тільки текст. DOCX — це ZIP архів: `extractDocxImagesOcr(buf)` відкриває його через JSZip, знаходить всі PNG/JPG в `word/media/`, запускає Tesseract OCR на кожному, дописує блок `--- EMBEDDED IMAGES (OCR) ---` до textContent. DOCX ліміт: 24k chars.

### DWG INSERT block detection
`parseDWG()` обходить всі INSERT entities і підраховує по імені блоку. Регекси:
- `DOOR_RE = /door|дверь|двер|a-door|dor[^e]/i`
- `WIN_RE = /window|glaz|окно|a-glaz|a-win|win-/i`
Виводить: `DOORS: A-DOOR-0900×5`, `WINDOWS: A-GLAZ-1200×3`, `BLOCKS: ...` (до 30 блоків).

### `_skipPreExtract: true` на packed PDF
**Проблема:** packed contact-sheet PDF мав 18 сторінок > PDF_DIRECT_LIMIT (15) → йшов в Haiku → timeout.  
**Рішення:** прапор `_skipPreExtract: true` на packed PDF в `parseTz()`, перевірка в `preProcessLargeFiles()`.

### MIQ — Silent defaults + питання з дефолтом
`SILENT_DEFAULT_KEYS` — константа з полями які ніколи не показуються в MISSING (People, Naming, Delivery, Render elements, Clothing, File size, Crop, Cars, Additional services). Тихо застосовуються, видно тільки в SOWa+BT.

Meaningful defaults (Resolution, DPI, File Format, Aspect ratio, Camera angles, Background Fill, Season, Time, Geolocation, Model) — показуються в MISSING як питання:
`"Field — not specified. Will use: [value] — confirm or provide alternative"`

### Prompt: AR filter
Для не-AR проектів Claude пропускає AR Specification пункти (GLB, USDZ, polygon count, UV mapping) якщо бриф явно не згадує AR/VR/web configurator. Усуває зайві питання типу "вкажіть polygon count" для residential interior.

### Prompt: conflict hierarchy
Source-of-truth: annotated model > brief > drawings > refs. Конфлікт піднімається тільки якщо два джерела **одного рівня** суперечать. Supplementary info (доповнення, а не протиріччя) — не конфлікт.

### Image packing (> 6 зображень)
Claude має ліміт на кількість image частин. При > 6 файлів-зображень вони пакуються в один PDF 2×2, що значно зменшує кількість частин.

### Elevation extraction — precise vs schematic
- `PRECISE` (є розміри, масштаб) → витягує прорізи, висоти, розміри
- `SCHEMATIC` (ескіз, намір) → витягує намір: "ТВ по центру", "ніша на 1200мм"
- Якщо є обидва для однієї стіни → крос-референс + конфлікти якщо суперечать

### Two-pass TASK 4
Claude отримує явний чеклист `[cat] item` і шукає кожен пункт у файлах (Pass1: шаблон→бриф, Pass2: бриф→шаблон). Без цього пропускав пункти або вигадував категорії.

### Claude Structured Outputs
Замість "RESPOND ONLY WITH JSON:" — передаємо `TZ_TOOL_SCHEMA` через `tools` + `tool_choice`. Claude гарантовано повертає `tool_use` блок з валідним JSON. `callAPIStructured()` — окрема функція. Haiku-виклики не змінились.

### Tesseract.js OCR
`pdfToPages()`: якщо після pdf.js < 30 символів → `runOcr(canvas)`. Worker ініціалізується lazy singleton. Динамічний `import("tesseract.js")` → не в початковому бандлі.

### FBX парсинг
Three.js FBXLoader в браузері. Витягує: назви мешів, bounding box розміри, назви матеріалів.

### Прямий браузерний запит до API
Немає бекенду. API ключ в localStorage, запити з браузера. Статичний хостинг, але ключ видно в DevTools.

---

## Ліміти тексту по типах файлів

| Тип файлу | Ліміт |
|-----------|-------|
| PDF per page | 8,000 chars |
| DOCX (total, incl. OCR) | 24,000 chars |
| XLSX per sheet | 10,000 chars |
| XLSX total | 24,000 chars |
| CSV | 10,000 chars |
| TXT / MD | 12,000 chars |
| RTF | 12,000 chars |
| FBX | 12,000 chars |
| DWG unique texts | 120, layers: 40, blocks: 30 |

---

## SOW Templates — 14 типів проектів

```
Residential Interior, Commercial Interior, Exterior, Aerial,
Silo, Lifestyle, Floor Rendering, Mattress Rendering, Rugs Rendering,
Real Estate, Design Interior, 3D Modeling, Floorplan, AR Rendering
```

Кожен тип має: `items[]` (чеклист для TASK 4) + `defaults{}` (значення якщо клієнт не вказав).

---

## UI — вкладки

| Вкладка | Що показує |
|---------|-----------|
| **SOWa** | `tz_by_room` — картки по категоріях BT шаблону |
| **SOWa + BT** | `delivery_spec` — таблиця brief/default/unclear |
| **MIQ** | `sow_missing` (тільки реальні питання) / Applied Defaults (завжди відкриті) / `sow_unclear` / `conflicts` + TP/FP оцінки + F1 Score |

Приховані вкладки (код збережений, UI прихований): Кімнати, Стадії, Таблиця, PM-звіт → `src/HIDDEN_CODE.md`

---

## MIQ Evaluation

На кожному пункті MIQ — кнопки **[TP]** / **[FP]** + comment input. FN — вручну додані пропущені питання.

```
Precision = TP / (TP + FP)
Recall    = TP / (TP + FN)
F1        = 2·TP / (2·TP + FP + FN)
```

**Важливо:** Recall 100% — не означає що AI нічого не пропустив. Означає що PM не заповнив FN.

Стан зберігається в localStorage, скидається при новому аналізі.

---

## Що залишилось

| Пріоритет | Задача |
|-----------|--------|
| Терміново | Закомітити `PDF_CHUNK_SIZE = 8` fix (локально є, не запушено) |
| Високий | Тестування ПМами на реальних брифах |
| Середній | MIQ Evaluation план: `.claude/plans/keen-discovering-pony.md` |
| Середній | Panorama vs Perspective в SPEC (окремі рядки) |
| Низький | Markdown повний експорт |
| Низький | PM Report (код збережений, UI прихований) |
| Низький | Drag-and-drop з браузера Archivizer |
| Низький | HEIC / IFC формати |
| Низький | FBX: позиції меблів (obj.position), вікна/двері (Y-position) |

---

## Важливі константи в src/App.jsx

```js
PDF_DIRECT_LIMIT = 15   // стор. — нижче цього: напряму до Sonnet
PDF_CHUNK_SIZE   = 8    // стор. в одному чанку для Haiku
IMAGE_PACK_THRESHOLD = 6  // > N image-файлів → packImagesToPdf()
MAX_PAYLOAD_B64  = 24_000_000  // ~24MB — ліміт зображень на запит
MAX_BATCH_B64    = 20_000_000  // ~20MB — ліміт на Haiku батч
```

---

*Детальніша технічна документація → Obsidian: Doc Nexus — Architecture*  
*Історія змін → Obsidian: Doc Nexus — Dev Log*
