# HIDDEN_CODE.md — Вирізаний код для відновлення

> Видалено в commit `f43a7f6` (30.04.2026). Відкат: `git checkout pre-hidden-cleanup`
> Тег збереження: `pre-hidden-cleanup`

---

## Як відновити конкретний блок

1. Знайди маркер `// RESTORE POINT` в поточному `App.jsx`
2. Вставити код з відповідного розділу нижче
3. Відновити state у функції `TzReviewStep` (розділ STATE нижче)

---

## STATE — вставити в TzReviewStep, після рядка `const [activeRoom, setActiveRoom]`

```jsx
const [viewMode, setViewMode] = useState("rooms"); // "rooms" | "stages" | "table" | "report"
const [reportMode, setReportMode] = useState("pm"); // "pm" | "client"
```

**Потрібно для:** блоків TABLE і LEGACY нижче.

---

## БЛОК 1 — TABLE VIEW (Таблиця)

**Що це:** вкладка-таблиця всіх екстрактів з фільтрацією по type/room/stage і пошуком. Export XLS.

**Де вставити в App.jsx:** після рядка що закінчується `</div> {/* toolbar */}` і перед `{/* ── SOWa / MIQ tabs ── */}`

**Маркер пошуку куди вставити:**
```
// RESTORE POINT: TABLE block goes here
```

**Залежності які вже є в коді:**
- `tableFilter`, `setTableFilter` — state вже є ✅
- `tableSort`, `setTableSort` — state вже є ✅
- `filteredRows` — useMemo вже є ✅
- `toggleSort` — функція вже є ✅

**Код блоку (118 рядків):**

```jsx
      {false && viewMode === "table" && (
        <div style={{ flex: 1, overflow: "auto", padding: "16px 20px", background: "#f5f4f1" }}>
          {/* Filter bar */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            <input
              placeholder="Search..."
              value={tableFilter.search}
              onChange={e => setTableFilter(f => ({ ...f, search: e.target.value }))}
              style={{ fontSize: 11, fontFamily: "monospace", padding: "5px 10px", border: "1px solid #ddd", borderRadius: 4, background: "#fff", width: 180 }}
            />
            <select value={tableFilter.type} onChange={e => setTableFilter(f => ({ ...f, type: e.target.value }))} style={{ fontSize: 11, fontFamily: "monospace", padding: "5px 8px", border: "1px solid #ddd", borderRadius: 4, background: "#fff" }}>
              <option value="">All types</option>
              {["image","todo","dimension","material","style","conflict","missing","default","comment","drawing"].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={tableFilter.room} onChange={e => setTableFilter(f => ({ ...f, room: e.target.value }))} style={{ fontSize: 11, fontFamily: "monospace", padding: "5px 8px", border: "1px solid #ddd", borderRadius: 4, background: "#fff" }}>
              <option value="">All rooms</option>
              {allRooms.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <select value={tableFilter.stage} onChange={e => setTableFilter(f => ({ ...f, stage: e.target.value }))} style={{ fontSize: 11, fontFamily: "monospace", padding: "5px 8px", border: "1px solid #ddd", borderRadius: 4, background: "#fff" }}>
              <option value="">All stages</option>
              {PRODUCTION_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {(tableFilter.type || tableFilter.room || tableFilter.stage || tableFilter.search) && (
              <button onClick={() => setTableFilter({ type: "", room: "", stage: "", search: "" })}
                style={{ fontSize: 10, fontFamily: "monospace", padding: "4px 10px", border: "1px solid #e74c3c", borderRadius: 4, cursor: "pointer", background: "#fff", color: "#e74c3c" }}>✕ clear</button>
            )}
            <span style={{ fontSize: 10, fontFamily: "monospace", color: "#aaa", marginLeft: "auto" }}>{filteredRows.length} rows</span>
          </div>
          {/* Table */}
          <div style={{ background: "#fff", borderRadius: 6, border: "1px solid #e5e5e5", overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ background: "#f8f8f8", borderBottom: "1px solid #e5e5e5" }}>
                  {[{ key: "type", label: "TYPE" }, { key: "text", label: "CONTENT" }, { key: "category", label: "CATEGORY" }, { key: "room", label: "ROOM" }, { key: "stage", label: "STAGE" }, { key: "source", label: "SOURCE" }].map(col => (
                    <th key={col.key} onClick={() => toggleSort(col.key)}
                      style={{ padding: "8px 12px", textAlign: "left", fontSize: 8, fontFamily: "monospace", letterSpacing: "0.1em", color: tableSort.col === col.key ? "#1a1a1a" : "#aaa", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
                      {col.label} {tableSort.col === col.key ? (tableSort.dir === "asc" ? "↑" : "↓") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row, i) => {
                  const isImg = row.type === "image";
                  return (
                    <tr key={row.id} style={{ borderBottom: "1px solid #f0f0f0", background: i % 2 === 0 ? "#fff" : "#fafafa" }}
                      onClick={() => row.img_ref && setLightbox({ imgRef: row.img_ref, itemText: row.text })}>
                      <td style={{ padding: "7px 12px", fontFamily: "monospace", fontSize: 9, color: "#888", whiteSpace: "nowrap" }}>{row.type}</td>
                      <td style={{ padding: "7px 12px", maxWidth: 320, color: "#333", cursor: isImg ? "pointer" : "default" }}>
                        {isImg && row.img_ref?.preview && <img src={row.img_ref.preview} style={{ width: 40, height: 30, objectFit: "cover", borderRadius: 2, marginRight: 8, verticalAlign: "middle" }} />}
                        <span style={{ fontSize: 11 }}>{row.text?.slice(0, 120)}{row.text?.length > 120 ? "…" : ""}</span>
                      </td>
                      <td style={{ padding: "7px 12px", fontSize: 10, color: "#555", whiteSpace: "nowrap" }}>{row.category}</td>
                      <td style={{ padding: "7px 12px", fontSize: 10, color: "#555", whiteSpace: "nowrap" }}>{row.room}</td>
                      <td style={{ padding: "7px 12px", fontSize: 10, color: "#555", whiteSpace: "nowrap" }}>{row.stage}</td>
                      <td style={{ padding: "7px 12px", fontSize: 10, color: "#888", whiteSpace: "nowrap", cursor: row.img_ref ? "pointer" : "default" }}
                        onClick={e => { e.stopPropagation(); row.img_ref && setDocViewer({ source: row.img_ref.file, pageNum: row.img_ref.page }); }}>
                        {row.source}{row.img_ref?.page > 1 ? ` p.${row.img_ref.page}` : ""}
                      </td>
                    </tr>
                  );
                })}
                {filteredRows.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: "24px", textAlign: "center", color: "#bbb", fontSize: 11, fontFamily: "monospace" }}>no results</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
```

---

## БЛОК 2 — PM REPORT (Звіт)

**Що це:** окрема вкладка-звіт для PM і клієнта. PM-режим: всі дані + конфлікти. Client-режим: delivery spec + питання (перекладені на англ. через окремий API call).

**Де вставити:** після блоку TABLE і перед `{/* ── SOWa / MIQ tabs ── */}`

**Залежності яких НЕ має в коді — треба відновити:**
- `reportMode`, `setReportMode` — state (з розділу STATE вище)
- `clientTranslation`, `buildingClientTranslation`, `onBuildClientTranslation` — передаються як props з батьківського компоненту (треба перевірити що props є)
- `exportReportExcel(isClient)` — функція є в коді ✅
- `exportReportPdf(isClient)` — функція є в коді ✅

**Код блоку (140 рядків):** збережено в git tag `pre-hidden-cleanup`

```
git show pre-hidden-cleanup:src/App.jsx | awk 'NR>=2444 && NR<=2583'
```

---

## БЛОК 3 — LEGACY PANEL (Кімнати / Стадії / Таблиця — старий layout)

**Що це:** повністю альтернативний layout — sidebar зліва з перемикачем Rooms/Stages/Table/Report, контент справа. Старіший UI ніж поточні вкладки SOWa/MIQ.

**Статус:** швидше за все НЕ потрібен — поточний UI (SOWa/MIQ tabs) його замінив повністю.

**Де вставити якщо потрібно:** перед закриваючим `</div>` компоненту TzReviewStep (останній `</div>` перед `);`)

**Залежності:**
- `viewMode`, `setViewMode` — state (з розділу STATE вище)
- `activeRoom`, `setActiveRoom` — є ✅
- `activeStage`, `setActiveStage` — є ✅

**Код блоку (297 рядків):** збережено в git tag `pre-hidden-cleanup`

```
git show pre-hidden-cleanup:src/App.jsx | awk 'NR>=2750 && NR<=3046'
```

---

## Швидкий відкат ВСЬОГО

```bash
git checkout pre-hidden-cleanup -- src/App.jsx
```

---

*Створено: 30.04.2026 після commit f43a7f6*
