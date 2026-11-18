# chii-server

OneBook App（iOS / Android）書本 WebView 遠端除錯用的 [Chii](https://github.com/liriliri/chii) server。
電腦瀏覽器用 Chrome DevTools 介面，就能看到手機 App 裡書本頁面的 DOM、Console、Network 和 storage。

## 目錄結構

這個 repo 沒有自己的程式碼，server 本體就是 npm 套件 `chii`，repo 只放啟動與部署設定。

```
chii-server/
├── package.json        # 相依套件（chii 1.15.5）與 npm start 啟動指令
├── package-lock.json   # 鎖定相依套件版本
├── render.yaml         # Render Blueprint 設定（服務名稱、方案、區域、build / start 指令、health check）
├── .gitignore          # 排除 node_modules
└── README.md
```

`npm start` 實際執行的是：

```bash
chii start -p ${PORT:-8080} -d ${RENDER_EXTERNAL_HOSTNAME:-localhost:${PORT:-8080}}
```

- 本機：沒有這兩個環境變數，預設開在 `8080`，對外網域是 `localhost:8080`
- Render：`PORT` 和 `RENDER_EXTERNAL_HOSTNAME` 由 Render 自動帶入

## 使用方式

有兩種用法：

- **方式一：Mac 本機執行**：自己一個人除錯、需要接手機或模擬器時用
- **方式二：部署到 Render**：團隊共用，手機不用接電腦（目前 App 預設連這個）

### 方式一：Mac 本機執行

#### 1. 啟動 server

```bash
npm install
npm start          # http://localhost:8080
```

要換 port 可以用 `PORT=9000 npm start`，下面 App 設定裡的 `8080` 也要跟著改。

#### 2. iOS 專案設定（app-onebook_ios）

打開 `eBook/VC/BookWebVC.swift`，把 `injectChiiRemoteDebugIfNeeded()` 裡的 `serverUrl` 改成：

| 執行環境 | `serverUrl` |
| --- | --- |
| 模擬器 | `http://localhost:8080`（模擬器和 Mac 共用網路） |
| 實機 | `http://<Mac 區網 IP>:8080`，手機要和 Mac 在同一個網路。IP 可用 `ipconfig getifaddr en0` 查 |

- 從 Xcode 用 Debug 系列 configuration（Debug / Debug-dev / Debug-uat / Debug-prod）執行才會注入，Release 系列不會（`#if DEBUG`）
- `Info.plist` 已開 `NSAllowsArbitraryLoads`，用 http 不會被 ATS 擋
- App 內建的書本 server 用 3000–3002 port，不會和 8080 衝突
- 實機第一次連線如果跳出「尋找區域網路裝置」的權限詢問，要按允許

#### 3. Android 專案設定（app-onebook_android）

打開 `app/build.gradle`，把 `debug` buildType 的 `CHII_SERVER_URL` 改成：

```groovy
buildConfigField "String", "CHII_SERVER_URL", '"http://localhost:8090"'
```

`dev` / `uat` 是 `initWith debug`，會一起套用。接著讓裝置的 8090 轉到 Mac 的 8080：

```bash
adb reverse tcp:8090 tcp:8080   # 模擬器、USB、無線偵錯都適用
```

- 為什麼裝置端用 8090：App 自己在裝置上用 8080 跑書本 server（`res/values/integers.xml` 的 `port`），不能再拿來轉
- 為什麼一定要用 `localhost`：`res/xml/network_security_config.xml` 只允許 `localhost` 走 http，填區網 IP 會被擋，Logcat 會出現 `Chii: network_security_config 不允許以 http 連到 ...`
- 裝置重新連線或 adb 重啟後，`adb reverse` 要再執行一次
- 用 debug / dev / uat variant build；release 的 `CHII_SERVER_URL` 是空字串，不會注入

#### 4. 開始除錯

1. 用上面設定好的 App 打開書本
2. 電腦瀏覽器打開 `http://localhost:8080`
3. 點對應的 target 開始除錯，iOS 和 Android 會列在同一個頁面，標題分別是 `OneBook iOS - <書本 id>`、`OneBook Android - <書本 id>`

> 上面 App 端的網址修改只是本機除錯用，**不要 commit**，共用設定維持連 Render。

### 方式二：部署到 Render

#### 1. 部署 server

用 Blueprint 部署：Render → New → Blueprint → 選這個 repo，會讀 `render.yaml` 自動建立服務。

| 設定 | 值 |
| --- | --- |
| 服務名稱 | `chii-server` |
| 方案 / 區域 | free / singapore |
| Build | `npm install` |
| Start | `npm start`（`chii start -p $PORT -d $RENDER_EXTERNAL_HOSTNAME`） |
| Health check | `/timestamp` |

- 部署後網址是 `https://chii-server.onrender.com`（服務名稱被占用時 Render 會加後綴，以 Render 後台顯示的為準）
- `-d` 一定要帶對外網域：Chii 首頁的 `index.js` 和 DevTools 連線網址都用這個值產生，沒帶會變成 `localhost:<port>`，在 Render 上打不開
- 免費方案閒置 15 分鐘會休眠，第一次打開要等約 1 分鐘叫醒
- 之後 push 到連結的分支，Render 會自動重新部署

#### 2. iOS / Android 專案設定

兩邊目前已經設好連 Render，Render 網址有變才需要改：

| 專案 | 位置 | 值 |
| --- | --- | --- |
| iOS | `eBook/VC/BookWebVC.swift` 的 `injectChiiRemoteDebugIfNeeded()` 裡的 `serverUrl` | `https://chii-server.onrender.com` |
| Android | `app/build.gradle` 的 `debug` buildType 的 `CHII_SERVER_URL` | `"https://chii-server.onrender.com"` |

- 走 https，不需要額外調整 iOS ATS 或 Android network security config
- 會注入的 build：iOS 是 Debug 系列 configuration，Android 是 debug / dev / uat；Release 都不會

#### 3. 開始除錯

1. 電腦瀏覽器打開 `https://chii-server.onrender.com`（先叫醒 server）
2. 用上述 build 的 App 打開書本，App 會自動載入 `https://chii-server.onrender.com/target.js`
3. 回到瀏覽器，點對應的 target（`OneBook iOS - <書本 id>` / `OneBook Android - <書本 id>`）開始除錯

## 原理

### 為什麼需要 target.js

target.js 是放進被除錯網頁裡的除錯代理程式，負責和 Chii server 維持除錯用的長連線。

桌面版 Chrome 內建 Chrome DevTools Protocol（CDP），DevTools 可以直接連上去除錯。WKWebView 沒有對外開放 CDP，只能用 Mac 的 Safari Web Inspector，而且手機要接 Mac；Android WebView 雖然可以用 `chrome://inspect`，也一樣要透過 adb 連電腦。target.js 用純 JavaScript 在頁面裡模擬出一套 CDP，這樣不接線、遠端也能用 Chrome DevTools 除錯，iOS 和 Android 也能用同一套工具。

### 運作流程

```
 App WebView 裡的頁面           Chii server                 電腦瀏覽器
┌──────────────────┐          ┌───────────────┐          ┌───────────────┐
│ target.js        │◀── ws ──▶│ relay         │◀── ws ──▶│ Chrome        │
│  └ chobitsu      │          │ messages,     │          │ DevTools      │
│   (CDP in JS)    │          │ target list   │          │ frontend      │
└──────────────────┘          └───────────────┘          └───────────────┘
```

- **chobitsu**：target.js 裡用 JS 模擬 CDP 的部分
- **Chii server**：在兩邊之間轉送訊息，並管理 target 列表
- **電腦瀏覽器**：跑 Chrome DevTools 前端

以下路徑都在 [Chii 原始碼](https://github.com/liriliri/chii) 裡：

1. target.js 載入後，先決定 server 位址（`src/target/config.ts`）。
2. 依設定選一種連線方式（入口檔 `src/target.ts` 就只做這件事）：
   - 預設：用 WebSocket 連 Chii server（`connectServer`），我們用的是這種
   - `rtc="true"`：改用 WebRTC（`connectRtc`）
   - `embedded="true"`：不連 server，直接在頁面裡開一個 DevTools iframe（`connectIframe`）
3. 連上後，DevTools 送來的 CDP 指令（例如「給我 DOM 樹」）交給 chobitsu 處理，結果再傳回 DevTools。
4. 連線時會一併送出頁面網址和標題（我們設的 `ChiiTitle`），這些資訊就是 Chii 首頁列表上看到的 target。

### App 怎麼注入 target.js

兩邊做法一樣：先設好 target.js 會讀的全域變數 `window.ChiiServerUrl`、`window.ChiiTitle`，再在頁面插入一個 `<script src="<server>/target.js">`。用 `window.__onebookChiiInjected` 防止重複注入。

| 平台 | 位置 | 注入時機 |
| --- | --- | --- |
| iOS | `BookWebVC.swift` 的 `injectChiiRemoteDebugIfNeeded()` | `WKUserScript`，`.atDocumentEnd`（DOM 解析完後）、`forMainFrameOnly: true` |
| Android | `WebviewActivity.kt` 的 `injectChiiRemoteDebugIfNeeded()` | `onPageFinished` 後用 `evaluateJavascript` 執行 |

## 能做到的事

- **Elements**：查看、修改 DOM 和 CSS
- **Console**：看 log、在頁面裡執行 JS
- **Network**：看 XHR 和 fetch 請求
- **Application**：看 localStorage、sessionStorage、cookie

## 限制

這些功能都是 target.js 在頁面裡用 JS 模擬出來的，不是 WebView 原生的除錯介面，所以有以下限制：

- **不能設中斷點**：沒有真正的 JS 除錯器，沒辦法在 Sources 面板的某一行停下來逐步執行，只能靠 Console 或加 log 追問題。
- **看不到注入前發生的事**：target.js 是頁面載入到一半之後才插進去的（時機見上方「App 怎麼注入 target.js」）。插進去之後還要從 server 下載 target.js 並連線，所以頁面剛開始的 console log 和請求都不會出現。
- **Network 看不到靜態資源**：只攔得到 XHR 和 fetch，圖片、CSS、JS、字型這些靜態資源的載入不會顯示。
- **只除錯得到主頁面**：iOS 設了 `forMainFrameOnly: true`，Android 的 `evaluateJavascript` 也只在主頁面執行，所以 iframe 裡的內容（例如書本中部分用 iframe 載入的元件）不會被除錯到。
- **看不到 Native log**：Swift / Kotlin 端的 log 不會出現在 DevTools。

## ⚠️ 安全注意

Chii 沒有任何登入驗證，知道網址的人都能看到連線中裝置的 DOM、storage 和 cookie（含登入 token）。

- 只讓 dev / uat build 連線，只用測試帳號
- 正式版 App 不可帶這個網址
- 不要把網址貼到公開的地方
