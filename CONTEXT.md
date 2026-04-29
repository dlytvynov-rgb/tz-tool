# Doc Nexus — Project Context

> Для нового розробника або AI. Оновлюється після кожної сесії.
> Останнє оновлення: 30.04.2026

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
| Головний файл | `src/App.jsx` (~3700+ рядків) |
| AI | Claude Sonnet 4.6 (основний) + Claude Haiku 4.5 (pre-extraction) |
| PDF | pdfjs-dist |
| DWG/DXF | @mlightcad/libredwg-web 0.7.1 → SVG → PNG |
| Excel/CSV | SheetJS |
| DOCX | mammoth |
| PDF генерація | pdf-lib (image packing) |
| FBX | Three.js FBXLoader — об'єкти, розміри, матеріали |
| OCR | Tesseract.js — для сканованих PDF (eng + ukr, lazy load) |
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
Файли від користувача (PDF / DWG / зображення / Excel / DOCX)
        ↓
1. Парсинг і класифікація файлів
        ↓
2. Image packing: > 6 image-файлів → contact-sheet PDF (2×2 grid, pdf-lib)
        ↓
3. preProcessLargeFiles: PDF > 15 стор. → Haiku pre-extraction (по 12 стор.)
   !! packed PDF з _skipPreExtract: true → минає Haiku, летить напряму до Sonnet
        ↓
4. filesToParts(): збірка промпту (XML обгортки + SOW шаблон + ЗАВДАННЯ 1–8)
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

### `_skipPreExtract: true` на packed PDF
**Проблема:** packed contact-sheet PDF мав 18 сторінок > PDF_DIRECT_LIMIT (15) → йшов в Haiku → Haiku намагався витягти текст з сітки мініатюр → timeout.  
**Рішення:** прапор `_skipPreExtract: true` на packed PDF в `parseTz()`, перевірка в `preProcessLargeFiles()`.

### Image packing (> 6 зображень)
Claude має ліміт на кількість image частин в одному запиті. При > 6 файлів-зображень вони пакуються в один PDF 2×2, що значно зменшує кількість частин і покращує контекст для AI.

### Elevation extraction — precise vs schematic
PM часто завантажує і точний DWG і схематичну розвертку з брифу (без масштабу, просто "що куди"). Claude розрізняє:
- `PRECISE` (є розміри, масштаб) → витягує прорізи, висоти, розміри
- `SCHEMATIC` (ескіз, намір) → витягує намір: "ТВ по центру", "ніша на 1200мм", "підсвітка зліва"
- Якщо є обидва для однієї стіни → крос-референс + виносить конфлікти якщо DWG і схема суперечать

### Two-pass TASK 4
Claude отримує явний чеклист `[cat] item` і шукає кожен пункт у файлах (Pass1: шаблон→бриф, Pass2: бриф→шаблон). Без цього AI пропускав пункти або вигадував категорії.

### JSON parsing з jsonrepair fallback
Claude іноді повертає неповний або broken JSON (обрізаний при великому контексті). `extractJson()`: code fence → brace counting → `JSON.parse` → `jsonrepair` → retry API call.

### delivery_spec normalization client-side
Claude повертає тільки `source:"brief"` пункти. Клієнтський код доповнює шаблон: дефолти і `source:"unclear"`. Так SPEC завжди містить повний список пунктів для даного типу проекту.

### Claude Structured Outputs
Замість "RESPOND ONLY WITH JSON:" в промпті — передаємо `TZ_TOOL_SCHEMA` через `tools` + `tool_choice: { type: "tool" }`. Claude гарантовано повертає `tool_use` блок з валідним JSON. Усуває всі JSON parse failures для основного запиту. `callAPIStructured()` — окрема функція, Haiku-виклики не змінились.

### Tesseract.js OCR
`pdfToPages()` рендерить canvas для кожної сторінки. Якщо після pdf.js витягнуто < 30 символів → `runOcr(canvas)` через Tesseract (eng + ukr). Worker ініціалізується lazy singleton — тільки при першому скані. Динамічний `import("tesseract.js")` → не потрапляє в початковий бандл.

### FBX парсинг
Three.js FBXLoader в браузері. Витягує: назви мешів, bounding box розміри (X×Y×Z), назви матеріалів. Output — текст для Claude щоб крос-референсити з кресленнями і брифом.

### Попередження для великих файлів
Файли > 30MB обробляються нормально, але показується помаранчевий бейдж з назвою і розміром. `_size` зберігається в об'єкті файлу при завантаженні.

### Прямий браузерний запит до API
Немає бекенду. API ключ в localStorage, запити з браузера. Спрощує деплой (статичний хостинг), але означає що ключ видно в DevTools.

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
| **MIQ** | `sow_missing` / `sow_unclear` / `conflicts` + TP/FP оцінки + F1 Score |

Приховані вкладки (код збережений, UI прихований): Кімнати, Стадії, Таблиця, PM-звіт.

---

## MIQ Evaluation

На кожному пункті MIQ — кнопки **[TP]** / **[FP]** + comment input. FN — вручну додані пропущені питання.

```
Precision = TP / (TP + FP)
Recall    = TP / (TP + FN)
F1        = 2·TP / (2·TP + FP + FN)
```

**Важливо:** Recall 100% — не означає що AI нічого не пропустив. Означає що PM не заповнив FN секцію. Recall вимірює тільки людський judgment.

Стан зберігається в localStorage, скидається при новому аналізі.

---

## Що залишилось

| Пріоритет | Задача |
|-----------|--------|
| Високий | Тестування ПМами на реальних брифах з 70+ картинками |
| Середній | Panorama vs Perspective в SPEC (окремі рядки) |
| Середній | Markdown повний експорт |
| Низький | PM Report (код збережений, UI прихований) |
| Низький | Drag-and-drop з браузера Archivizer |
| Низький | HEIC / IFC формати |

---

## Важливі константи в src/App.jsx

```js
PDF_DIRECT_LIMIT = 15   // стор. — нижче цього: напряму до Sonnet
PDF_CHUNK_SIZE   = 12   // стор. в одному чанку для Haiku
IMAGE_PACK_THRESHOLD = 6  // > N image-файлів → packImagesToPdf()
```

---

*Детальніша технічна документація → Obsidian: Doc Nexus — Architecture*  
*Історія змін → Obsidian: Doc Nexus — Dev Log*
