# 輔仁大學附設醫院 115年尾牙抽獎系統 — 專案文件

> 最後更新：2026-04-16

---

## 一、專案概述

為輔大醫院約 1,500 名員工舉辦的尾牙抽獎活動所開發的純前端系統。  
資料層使用 **Supabase**（PostgreSQL + Realtime），部署於 **GitHub Pages**（靜態頁面）。

**對外網址**：`https://wysii97.github.io/lottery2026/`  
**GitHub Repo**：`https://github.com/Wysii97/lottery2026`

---

## 二、技術架構

| 項目 | 內容 |
|------|------|
| 前端 | 純 HTML5 + Vanilla JavaScript（無任何框架） |
| 資料庫 | Supabase（PostgreSQL） |
| 即時同步 | Supabase Realtime（`postgres_changes`） |
| 部署 | GitHub Pages（main branch） |
| 字型 | Google Fonts — Noto Sans TC |
| 亂數 | `crypto.getRandomValues()`（密碼學安全） |

---

## 三、檔案結構

```
lottery2026/
├── index.html        入口頁（導向三個子頁面）
├── lottery.html      抽獎主畫面（投影幕用，需登入）
├── admin.html        後台管理（人員 / 獎品 / 紀錄）
├── results.html      中獎查詢（員工手機用，公開）
├── js/
│   ├── config.js     Supabase 連線設定（URL、ANON KEY、管理員 Email）
│   └── store.js      共用資料層（所有頁面引入）
└── docs/
    └── PROJECT.md    本文件
```

---

## 四、Supabase 資料表

### `participants`（抽獎人員）
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | uuid | PK |
| name | text | 姓名 |
| department | text | 部門 |
| employee_no | text | 員工編號（可空） |
| eligible | boolean | true = 可抽，false = 已中獎 |
| import_batch | text | CSV 匯入批次時間戳 |
| created_at | timestamptz | 建立時間 |

### `prizes`（獎品）
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | uuid | PK |
| name | text | 獎品名稱 |
| quantity | int | 總名額 |
| winners_drawn | int | 已抽出數量 |
| sort_order | int | 排序（小 → 先顯示） |
| active | boolean | false = 停用（有中獎紀錄時不能刪除） |

### `draw_results`（中獎紀錄）
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | uuid | PK |
| prize_id | uuid | FK → prizes |
| prize_name | text | 冗餘儲存（防止獎品被刪後無法顯示） |
| participant_id | uuid | FK → participants |
| participant_name | text | 冗餘儲存 |
| participant_dept | text | 冗餘儲存 |
| participant_employee_no | text | 冗餘儲存 |
| drawn_at | timestamptz | 抽出時間 |
| revoked | boolean | true = 已重抽 |
| revoked_at | timestamptz | 撤銷時間 |
| revoked_reason | text | 撤銷原因 |

### `logs`（操作日誌）
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | uuid | PK |
| action | text | DRAW / REVOKE / IMPORT / PRIZE_ADD … |
| detail | text | 文字說明 |
| created_at | timestamptz | 建立時間 |

---

## 五、js/store.js — 資料層 API

所有頁面透過 `<script src="js/store.js">` 引入，掛在 `window.Store`。

### 認證
```
Store.signIn(password)        → Supabase Email/Password 登入
Store.signOut()
Store.isAuthenticated()
```

### 人員管理
```
Store.getParticipants()       → 全部人員
Store.getEligible()           → eligible=true 的人員
Store.addParticipant(name, department, employeeNo)
Store.updateParticipant(id, updates)
Store.deleteParticipant(id)
Store.importParticipants(csvText)  → 解析 CSV，回傳 { added, skipped, errors }
```

### 獎品管理
```
Store.getPrizes()
Store.addPrize(name, quantity, sortOrder)
Store.updatePrize(id, updates)
Store.deletePrize(id)         → 有中獎紀錄時改為 active=false
Store.importPrizes(prizesData)
```

### 抽獎核心
```
Store.draw(prizeId)           → 抽一人，回傳 DrawResult 或 null
Store.revoke(resultId, reason)→ 撤銷中獎，還原 eligible=true
```

**`draw()` 使用樂觀鎖定**：  
`UPDATE participants SET eligible=false WHERE id=? AND eligible=true`  
若同時有兩台裝置抽到同一人，`maybeSingle()` 回傳 null → 自動重試（最多 5 次）。

### 查詢 / 匯出
```
Store.getResults()
Store.getResultsByPrize(prizeId)
Store.searchResults(keyword)
Store.getLogs()
Store.exportResultsCsv()      → 回傳 UTF-8 BOM CSV 字串
Store.clearAll()              → 清空所有資料（危險操作）
```

### Realtime 訂閱
```
Store.subscribeResults(callback)
Store.subscribePrizes(callback)
Store.subscribeParticipants(callback)
```

---

## 六、各頁面說明

### lottery.html — 抽獎主畫面

**使用場景**：活動現場，操作者在投影幕前使用。

**登入**：Supabase Email/Password 認證（密碼 = 管理員帳號密碼）。

**版面**：左側抽獎區 + 右側本場已抽出清單（雙欄 Grid）。

**抽獎流程**：
1. 選擇獎項（下拉選單，顯示剩餘名額）
2. 設定批次人數（預設 1，最大 = min(可抽人數, 剩餘名額)）
3. 點擊跑馬燈區塊 **或按 Enter** → 開始動畫
4. 動畫立即啟動，同時在背景呼叫 `Store.draw()`
5. 等待至少 1500ms 且 DB 回傳結果後進入緩速階段
6. 緩速 8 步後停止：單人停在**中獎者姓名**，批次停在隨機名字
7. 顯示中獎覆蓋畫面（單人：大字 + 部門；批次：依序彈出名片 + 每張 confetti）
8. 5 秒自動關閉，或點擊任意處手動關閉

**跑馬燈動畫細節**：
- 使用 Fisher-Yates shuffle 隨機排列人員名單，避免重複
- 整個名單跑完後重新洗牌再循環
- 動畫期間 `_isAnimating = true`，Realtime 更新暫停，避免名單提前出現
- 覆蓋畫面關閉後才呼叫 `loadAll()` 刷新資料

**狀態旗標**：
```js
_isDrawing    // 防止重複點擊
_isAnimating  // 抑制 Realtime 即時更新渲染
_batchAddActive // 批次卡片逐一出現時，若提早關閉可中止迴圈
```

**重抽**：右側清單每筆紀錄有「重抽」按鈕，輸入原因後呼叫 `Store.revoke()`，該員工恢復 eligible。

---

### admin.html — 後台管理

**登入**：同 lottery.html，Supabase 認證。

**三個頁籤**：

#### 頁籤 A：抽獎人管理
- 統計卡：總人數 / 可抽人數 / 已中獎人數
- CSV 批次匯入（支援 UTF-8 / UTF-8 BOM，欄位：姓名, 部門, 員工編號）
- 單筆新增表單
- 搜尋篩選（姓名 / 部門 / 員工編號）
- 表格內**直接 inline 編輯**（點「編輯」展開同列輸入框，不跳 popup）
- 刪除（已中獎者需確認）

#### 頁籤 B：獎品管理
- 獎品列表（含抽出進度）
- 新增 / inline 編輯（名稱、數量、排序）
- 刪除：無中獎紀錄 → 實際刪除；有紀錄 → 標記 `active=false`

#### 頁籤 C：中獎紀錄
- 完整紀錄（含已重抽，灰化加刪除線）
- 重抽操作（輸入原因）
- 匯出 CSV
- 最近 50 筆操作日誌

**安全防護**：所有渲染到 innerHTML 的使用者內容透過 `escHtml()` 跳脫，防止 XSS。

---

### results.html — 中獎查詢

**使用場景**：員工用手機掃 QR Code 查詢，RWD 設計。

**功能**：
- 依獎品 `sort_order` 排列，顯示各獎得獎者
- 尚未抽出的名額顯示「⏳ 尚未抽出」佔位
- 搜尋框：輸入姓名或員工編號，符合者高亮
- Realtime 訂閱：有新中獎紀錄時自動更新，不需重整頁面
- 新出現的名字顯示「NEW」標籤（5 秒後消失）
- 已重抽者顯示刪除線 + 「已重抽」標籤

---

## 七、色彩主題

```css
/* lottery.html（深色喜慶風） */
--gold:     #FFD700   /* 金色，主文字 */
--bg-dark:  #1a0a0a   /* 深紅黑背景 */

/* admin.html / results.html（淺色專業風） */
--primary:  #8B0000   /* 深紅，標題 / 按鈕 */
--bg-light: #FFF8F0   /* 暖白背景 */
```

---

## 八、已知設計決策

| 決策 | 原因 |
|------|------|
| 抽獎結果冗餘儲存於 `draw_results` | 獎品或人員被刪後，歷史紀錄仍可顯示完整資訊 |
| 動畫與 DB 並行，非序列 | 點擊後立即有視覺反應，不等 DB 才開始動畫 |
| `_isAnimating` 旗標暫停 Realtime 更新 | 避免中獎名單在動畫結束前出現，破壞揭曉感 |
| `draw()` 使用樂觀鎖定重試機制 | 支援多裝置同時操作而不重複抽到同一人 |
| `deletePrize` 改為停用而非刪除 | 保留歷史中獎紀錄的完整性 |
| Inline 編輯取代 Popup | 減少操作層級，編輯更直覺 |

---

## 九、潛在優化方向

### 功能面
- [ ] 抽獎頁支援「撤銷上一抽」快捷鍵（目前需去右側清單點重抽）
- [ ] results.html 加入姓名遮罩（第二字替換為「○」）保護個資
- [ ] 批次抽獎時每位中獎者也跑一次動畫（目前批次共用單次動畫）
- [ ] admin.html 增加整批刪除（依 import_batch 刪除）
- [ ] 匯出時加入時間區間篩選

### 技術面
- [ ] `setupRealtime()` 每次 `loadAll()` 都重新訂閱，可能累積多個 channel，改為只訂閱一次
- [ ] `admin.html` 目前 JS 超過 400 行，可拆分為多個模組檔案
- [ ] 加入 Service Worker 讓 results.html 可在弱網路下快取顯示
- [ ] 錯誤提示統一改用 toast，移除部分 `alert()`

### 安全面
- [ ] `js/config.js` 的 ANON KEY 已在前端暴露（Supabase 設計如此，但需確認 RLS Policy 正確設定）
- [ ] 管理員操作（draw / revoke）應在 Supabase RLS 層要求已登入身份

---

## 十、本地開發 / 測試

```bash
# 不需安裝任何套件，直接用 VS Code Live Server 或 Python 起靜態伺服器
python -m http.server 8080

# 開啟瀏覽器
http://localhost:8080/lottery.html   # 抽獎主畫面
http://localhost:8080/admin.html     # 後台
http://localhost:8080/results.html   # 中獎查詢
```

**測試資料初始化**（在 admin.html 的 DevTools console 執行）：
```js
// 新增測試人員
['王小明','李大華','張芳芳','陳志偉','林美玲','黃建國','吳淑芬','劉志明']
  .forEach((n,i) => Store.addParticipant(n, ['護理部','資訊室','藥劑部','放射科'][i%4], 'T'+String(i+1).padStart(3,'0')));

// 新增測試獎品
[['末獎 掃地機器人',5,1],['三獎 AirPods',3,2],['二獎 iPad',2,3],['頭獎 電視',1,4]]
  .forEach(([n,q,s]) => Store.addPrize(n, q, s));
```
