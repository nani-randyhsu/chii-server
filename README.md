# chii-server

OneBook App（iOS / Android）書本頁和登入頁 WebView 遠端除錯用的 [Chii](https://github.com/liriliri/chii) server。
電腦瀏覽器用 Chrome DevTools 介面，就能看到手機 App 裡網頁的 DOM、Console、Network 和 storage。

- 工單：[OBAPP-625](https://team-oneclass.atlassian.net/browse/OBAPP-625)，調研過程和工具比較記在工單留言（摘要見「為什麼選 Chii」）
- 部署：[Render 後台](https://dashboard.render.com/)的 `chii-server` 服務，網址 `https://chii-server.onrender.com`

## 目錄結構

server 本體是上游 [liriliri/chii](https://github.com/liriliri/chii) 的原始碼，用 git subtree 放在 `chii/`，可以直接客製化（見「客製化與同步上游」）。

```
chii-server/
├── chii/               # 上游 Chii 原始碼（git subtree）
│   ├── server/         #   server：target 列表頁、WebSocket 轉送
│   ├── src/            #   target.js 與列表頁前端（TypeScript，webpack build）
│   ├── bin/chii.js     #   CLI 入口，npm start 就是執行它
│   └── public/         #   build 產物，不進 git：target.js、index.js、front_end/
├── scripts/
│   └── patch-front-end.js  # 修補複製來的 DevTools 前端（見「客製化與同步上游」）
├── package.json        # npm workspaces 設定與 build / start 指令
├── package-lock.json   # 鎖定相依套件版本（含 chii/ 的相依套件）
├── render.yaml         # Render Blueprint 設定（服務名稱、方案、區域、build / start 指令、health check）
├── .gitignore          # 排除 node_modules
└── README.md
```

`package.json` 用 npm workspaces 把 `chii/` 當成本地套件，指令如下：

| 指令 | 做什麼 |
| --- | --- |
| `npm run build` | 依序執行下面兩個 build |
| `npm run build:target` | 在 `chii/` 用 webpack 把 `src/` build 成 `chii/public/target.js`、`index.js` |
| `npm run build:front_end` | 把 npm 套件 `chii-prebuilt`（即 `chii@1.15.5`）裡 build 好的 DevTools 前端複製到 `chii/public/front_end`，再用 `scripts/patch-front-end.js` 修補 |
| `npm start` | `node chii/bin/chii.js start -p ${PORT:-8080} -d ${RENDER_EXTERNAL_HOSTNAME:-localhost:${PORT:-8080}}` |

- DevTools 前端要用 Chromium 的 depot_tools（`gclient` / `gn` / `autoninja`）才能 build，所以先沿用 npm 套件裡 build 好的版本，需要的小修改由 `scripts/patch-front-end.js` 直接改 build 好的檔案
- `node_modules/.bin/chii` 指向的是 `chii-prebuilt`，不是 `chii/`，啟動一律用 `npm start`，不要用 `npx chii`
- 本機：沒有 `PORT`、`RENDER_EXTERNAL_HOSTNAME`，預設開在 `8080`，對外網域是 `localhost:8080`
- Render：`PORT` 和 `RENDER_EXTERNAL_HOSTNAME` 由 Render 自動帶入

## 使用方式

有兩種用法：

- **方式一：Mac 本機執行**：自己一個人除錯、需要接手機或模擬器時用
- **方式二：部署到 Render**：團隊共用，手機不用接電腦（目前 App 預設連這個）

### 方式一：Mac 本機執行

#### 1. 啟動 server

```bash
npm install
npm run build
npm start          # http://localhost:8080
```

要換 port 可以用 `PORT=9000 npm start`，下面 App 設定裡的 `8080` 也要跟著改。

#### 2. iOS 專案設定（app-onebook_ios）

打開 `eBook/ChiiRemoteDebug.swift`，把 `ChiiRemoteDebug.serverUrl` 改成（書本頁和登入頁共用）：

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

- 本機 server 是 http，登入頁（https）建議用方式二除錯：
  - Android 的 `CHII_SERVER_URL` 不是 https 時，登入頁直接不注入，Logcat 會出現 `Chii: 登入頁是 https，CHII_SERVER_URL 也要是 https://host[:port]`
  - iOS 沒有這個檢查，但 https 頁面載入 http 的 target.js 可能被當成 mixed content 擋掉

> 上面 App 端的網址修改只是本機除錯用，**不要 commit**，共用設定維持連 Render。

### 方式二：部署到 Render

#### 1. 部署 server

用 Blueprint 部署：[Render 後台](https://dashboard.render.com/) → New → Blueprint → 選這個 repo，會讀 `render.yaml` 自動建立服務。

| 設定 | 值 |
| --- | --- |
| 服務名稱 | `chii-server` |
| 方案 / 區域 | free / singapore |
| Build | `npm ci --include=dev && npm run build` |
| Start | `npm start`（`node chii/bin/chii.js start -p $PORT -d $RENDER_EXTERNAL_HOSTNAME`） |
| 自動部署 | `autoDeployTrigger: commit`，push 到連結的分支就部署 |
| Health check | `/timestamp` |

- Build 要用到 webpack 等開發用套件，加 `--include=dev` 是避免環境變數 `NODE_ENV=production` 時被 npm 略過
- 部署後網址是 `https://chii-server.onrender.com`（服務名稱被占用時 Render 會加後綴，以 Render 後台顯示的為準）
- `-d` 一定要帶對外網域：Chii 首頁的 `index.js` 和 DevTools 連線網址都用這個值產生，沒帶會變成 `localhost:<port>`，在 Render 上打不開
- 免費方案閒置 15 分鐘會休眠，第一次打開要等約 1 分鐘叫醒
- 之後 push 到連結的分支，Render 會自動重新部署。沒有自動部署的話，到服務的 Settings 確認 repo 是透過 GitHub 帳號連線（直接貼公開 repo 網址建立的服務只能手動部署），再用 Deploys → Manual Deploy → Deploy latest commit 補部署

#### 2. iOS / Android 專案設定

兩邊目前已經設好連 Render，Render 網址有變才需要改：

| 專案 | 位置 | 值 |
| --- | --- | --- |
| iOS | `eBook/ChiiRemoteDebug.swift` 的 `ChiiRemoteDebug.serverUrl` | `https://chii-server.onrender.com` |
| Android | `app/build.gradle` 的 `debug` buildType 的 `CHII_SERVER_URL` | `"https://chii-server.onrender.com"` |

- 走 https，不需要額外調整 iOS ATS 或 Android network security config
- 會注入的 build：iOS 是 Debug 系列 configuration，Android 是 debug / dev / uat；Release 都不會
- Android 書本頁會等 target.js 載完才執行書本的程式（見「App 怎麼注入 target.js」），Render 休眠時開書會卡住約 1 分鐘，先用電腦瀏覽器叫醒 server

#### 3. 開始除錯

1. 電腦瀏覽器打開 `https://chii-server.onrender.com`（先叫醒 server）
2. 用上述 build 的 App 打開書本，或按「開始登入」進登入頁，App 會自動載入 `https://chii-server.onrender.com/target.js`
3. 回到瀏覽器，點對應的 target 開始除錯：
   - 書本頁：`OneBook iOS - <書本 id>` / `OneBook Android - <書本 id>`
   - 登入頁：`OneBook iOS - Login` / `OneBook Android - Login`

## 客製化與同步上游

### 改了哪裡要重新做什麼

| 改的地方 | 之後要做 |
| --- | --- |
| `chii/server/`（列表頁、WebSocket 轉送） | 重新 `npm start` |
| `chii/src/`（target.js、列表頁前端） | `npm run build:target` 後重新 `npm start` |
| DevTools 前端 | 小修改寫在 `scripts/patch-front-end.js`，改完 `npm run build:front_end` 後重新 `npm start`；大改得另外準備 Chromium 工具鏈，參考上游 `package.json` 的 `init:front_end` / `build:front_end` |

盡量少改上游原本的檔案，新功能放在新檔案、原檔只留一小段接上的程式，之後同步上游比較不會衝突。

### 目前的客製化

#### 畫面預覽改用 App 原生截圖

Chii 內建的畫面預覽是 chobitsu 用 html2canvas 把 DOM 重畫一次，iframe、影片、`filter` 等 CSS 效果常常畫不出來。html2canvas 是用 JS 寫的排版引擎，照著 DOM 和 CSS 在 Canvas 上重畫，沒實作到的 CSS、讀不到的內容就會缺漏。網頁 JS 本身沒辦法真的截圖：瀏覽器基於安全不讓網頁讀螢幕像素（否則嵌在頁面裡的 iframe，例如銀行登入頁，內容就會被偷看），所以要看到真正畫出來的畫面，只能請 App 截。

客製後的 target.js 會先攔下 DevTools 的 `Page.startScreencast` / `stopScreencast` / `screencastFrameAck`，頁面上有 App 提供的截圖 bridge 時，改請 App 截取 WebView 的實際畫面；沒有 bridge 就照舊交給 chobitsu。

iOS 的截圖截不到 `<video>` 的畫面（例如生字的筆順動畫，那一塊會是空白），所以 iOS 收到截圖後，target.js 再把畫面上每個 `<video>` 目前的畫格畫到截圖上對應的位置。

| 位置 | 內容 |
| --- | --- |
| `chii/src/target/nativeScreencast.ts` | 新檔案，攔截 screencast 指令、跟 App 要截圖、iOS 補畫影片、送出 `Page.screencastFrame` |
| `chii/src/target/connectServer.ts` | 只加了把訊息先交給 `nativeScreencast` 的幾行 |

App 端要實作的 bridge：

| 方向 | iOS | Android |
| --- | --- | --- |
| 頁面 → App：要一張截圖 | `window.webkit.messageHandlers.chiiScreencast.postMessage({ action: 'capture', id, maxWidth, quality })` | `window.ChiiScreencast.postMessage('<同樣內容的 JSON 字串>')` |
| App → 頁面：交回截圖 | `window.__chiiScreencastFrame(id, { data, width, height })` | 同左 |

- `data` 是 JPEG 的 base64（不含 `data:` 前綴），`width` / `height` 是圖片像素；`maxWidth` 是 CSS px，App 截圖後縮到這個寬度、1 倍像素，減少經過 Render 的傳輸量；失敗時改傳 `{ error: '原因' }`
- 截圖的開始、停止和頻率都由 target.js 控制，App 只負責「收到一次請求就截一張」，不用處理 `stopScreencast`
- target.js 收到 DevTools 的 ack 後隔 0.5 秒才要下一張，所以大約每秒 1～2 張；頁面在背景或截圖失敗時改成每 2 秒重試
- 沒收到 ack 就不會要下一張：直接關掉 DevTools 分頁時不會送 `stopScreencast`，靠這點讓 App 停止截圖
- App 端實作位置：
  - iOS：`ChiiRemoteDebug.swift` 的 `ChiiScreencastHandler`，用 `WKWebView.takeSnapshot`（截不到 `<video>`，改用 `drawHierarchy` 也一樣，所以由 target.js 補畫影片）
  - Android：`util/ChiiScreencastBridge.kt`，API 26 以上用 `PixelCopy` 複製螢幕上的實際像素，影片也截得到；API 24、25 退回 `WebView.draw()`（影片、WebGL 可能是空白）
  - 兩邊都只截 WebView 那一塊，旁邊的原生元件（例如 iOS 左上角的關閉鍵）不在預覽上，預覽的座標才會跟網頁一致
  - Android 的 `PixelCopy` 截的是螢幕像素，疊在 WebView 上面的原生元件也會截進去，例如登入成功後蓋住 WebView 的 Loading 遮罩，這時預覽看到的是遮罩或開始頁
- iOS 補畫影片的限制：
  - 照 `<video>` 的位置、border、padding 和 `object-fit` 畫，`object-position` 一律當作置中，CSS 旋轉和圓角不處理
  - 疊在影片上面的元素會被影片蓋掉；iframe 裡的影片不會補
  - 跨網域又沒開 CORS 的影片畫上去後 canvas 不能輸出，這時照原本的截圖送出，Console 會出現一次 `[chii] cannot draw videos on the native screencast frame`
- 同時開多個 DevTools 預覽同一個 target 時共用同一組截圖，其中一個關掉預覽就會整個停止

#### 預覽上的滑鼠操作改模擬成手指觸控

chobitsu 收到預覽上的滑鼠操作時，只會對游標下的元素送出 JS 產生的 `mousedown` / `mousemove` / `mouseup`（`buttons` 固定是 0），放開時再補 `click`。所以點擊正常，但用 touch 或 pointer 事件寫的拖曳拖不動；滾輪則是 `scrollTop -= deltaY`，捲動方向相反。

客製後的 target.js 會先攔下 `Input.dispatchMouseEvent`，改送跟手機瀏覽器處理手指一樣的事件：

| 預覽上的操作 | 送到頁面的事件 |
| --- | --- |
| 按下左鍵 | `pointerdown` → `touchstart` |
| 按著移動 | `pointermove` → `touchmove`，送給按下時的元素（跟真的觸控一樣） |
| 放開 | `pointerup` → `touchend`；移動不超過 10px 而且沒被 `preventDefault` 時，再補 `mousedown` → `mouseup` → `click` |
| 沒按著移動 | 不送事件（手指沒有 hover） |
| 滾輪 | 先送 `wheel`，沒被 `preventDefault` 就照 `deltaY` 的方向捲動游標所在的可捲動區塊 |

| 位置 | 內容 |
| --- | --- |
| `chii/src/target/touchInput.ts` | 新檔案，攔截 `Input.dispatchMouseEvent` 並送出上表的事件 |
| `chii/src/target/connectServer.ts` | 只加了把訊息先交給 `touchInput` 的幾行 |

- pointer 事件的 `pointerType` 是 `touch`、`pointerId` 固定是 9527；對這個 `pointerId` 呼叫 `setPointerCapture` 不會丟例外，`pointermove` / `pointerup` 會改送給 capture 的元素
- 不能用建構子建立 `Touch` / `TouchEvent` 的環境（例如部分 iOS 版本），改用一般 `Event` 補上 `touches` / `changedTouches` 等屬性，前端讀法一樣，只是 `instanceof TouchEvent` 會是 `false`
- 仍然是 JS 產生的事件（`isTrusted` 為 `false`），瀏覽器不會因此原生捲動、選取文字或啟動 HTML5 拖放；要捲動頁面請用滾輪
- 右鍵等其他按鍵照舊交給 chobitsu

#### Network 面板補上靜態資源

chobitsu 的 Network 是靠換掉 `fetch`、XHR、`WebSocket` 記錄請求。`<script>`、`<link>`、`<img>`、CSS 的 `url()` 是瀏覽器自己下載的，不經過任何 JS 函式，所以原本 Network 面板看不到 JS、CSS、圖片、字型這些資源。

客製後的 target.js 改讀瀏覽器的資源載入紀錄（Resource Timing：`performance.getEntriesByType` 與 `PerformanceObserver`），再用 capture 階段的 `error` 事件判斷哪些載入失敗，轉成 Network 事件送給 DevTools：

| Network 面板上 | 來源 |
| --- | --- |
| 網址、類型、耗時、Timing 分頁的細部時間 | 資源載入紀錄 |
| 大小（快取命中時顯示 `(disk cache)`） | 資源載入紀錄的 `transferSize` / `decodedBodySize` |
| 狀態碼 | 資源載入紀錄的 `responseStatus`，瀏覽器不支援時顯示 `Finished` |
| `(failed) error 事件` | 頁面收到這個資源的 `error` 事件（例如連不上、圖片壞掉）；有 4xx / 5xx 狀態碼時直接顯示狀態碼 |

| 位置 | 內容 |
| --- | --- |
| `chii/src/target/resourceTiming.ts` | 新檔案，收集資源載入紀錄和 `error` 事件、轉成 Network 事件 |
| `chii/src/target/connectServer.ts` | 只加了讓 `resourceTiming` 看到 `Network.enable` 的幾行，訊息照樣交給 chobitsu |

- `fetch` / XHR 照舊由 chobitsu 記錄（有 header 和內容），這裡只補 target.js 載入前就發出的 `fetch` / XHR，Method 欄留白
- DevTools 每次打開都會重送目前為止的紀錄，晚開 DevTools 也看得到頁面一開始載了什麼；最多保留最新 1000 筆
- 資源載完才有紀錄，所以載完才出現在列表；沒有 header，也沒有內容可以預覽
- 狀態碼要 Android WebView 109 以後才有；iOS 是否支援要實測，不支援時 404 這類錯誤只有在 target.js 注入後發生、收到 `error` 事件才看得出來
- 跨網域資源（例如 Chii server 的 target.js）沒有 `Timing-Allow-Origin` header 時，大小和細部時間都是 0
- 同時開兩個 DevTools 時，先開的那個會再收到一份重送的紀錄

#### Network 面板恢復完整的資源類型 filter

Chii 的 DevTools 前端在 Chii 裡執行時（`globalThis.chii` 為 true），Network 面板的類型 filter 只留 Fetch/XHR 和 WS，因為原本 chobitsu 只記錄得到這兩種請求。補上靜態資源後，`scripts/patch-front-end.js` 拿掉這個限制，filter 恢復成跟 Chrome 一樣：All、Fetch/XHR、Doc、CSS、JS、Font、Img、Media、Manifest、WS、Wasm、Other。

| 位置 | 內容 |
| --- | --- |
| `scripts/patch-front-end.js` | 新檔案，修補 `chii/public/front_end/panels/network/network.js` 裡只留兩個 filter 的那段程式碼 |
| `package.json` | `build:front_end` 複製完 DevTools 前端後執行上面的 script |

- 改的是 build 好、壓縮過的檔案，script 用正規表示式比對原本的程式碼，找不到就讓 build 失敗
- Chii 隱藏的其他 Network 選項（隱藏 data URL、只看第三方請求、Preserve log 等）沒有恢復
- 前端檔案的快取是 2 小時，部署後要在 DevTools 分頁強制重新整理（Cmd + Shift + R）才會看到

#### Application 面板可以修改、新增 cookie

chobitsu 只實作讀取和刪除 cookie，沒有 `Network.setCookie`，在 Application → Cookies 改值或新增時，表格會跳回原本的值。而且 chobitsu 讀到的 cookie 只有名稱和值，DevTools 存檔時要用到 domain，連改值的指令都送不出去。

客製後的 target.js 先攔下這兩個指令，不交給 chobitsu：

| 指令 | 做法 |
| --- | --- |
| `Network.getCookies` | 回傳原始的值（chobitsu 會先 URL 解碼，改完寫回去就變了；要看解碼後的值可以勾表格下方的 Show URL-decoded），並補上 domain、path、到期時間 |
| `Network.setCookie` | 用 `document.cookie` 寫入，寫完再讀回來確認瀏覽器有收下 |

| 位置 | 內容 |
| --- | --- |
| `chii/src/target/editableCookies.ts` | 新檔案，處理上面兩個指令 |
| `chii/src/target/connectServer.ts` | 只加了把訊息先交給 `editableCookies` 的幾行 |

新增、修改、刪除最後都是寫一筆 `document.cookie`，瀏覽器用「名稱 + domain + path」判斷是不是同一筆：已經有就覆蓋（修改），沒有就新增，到期時間設成過去就是刪除。

- 刪除照舊交給 chobitsu（licia 的 `rmCookie`）：它只看名稱，不管 DevTools 給的 domain、path，先用頁面預設的 path 寫一筆過期的同名 cookie，名稱還在就換上層網域、各層 path 一組一組再試，直到名稱消失
- 在表格改了名稱、Domain 或 Path，DevTools 會當成另一筆 cookie：先刪掉舊的，再新增
- HttpOnly cookie 是 JS 碰不到的：列表上看不到，也不能把 cookie 設成 HttpOnly
- `document.cookie` 只有名稱和值。瀏覽器的 Cookie Store API 有提供時（Chrome、Android WebView，而且頁面要是 https 或 localhost；iOS 待實機確認），domain、path、到期時間照實顯示；沒有的話一律當作目前網域、path 是 `/`、session cookie，這時：
  - 改值會變成 session cookie，App 關掉就消失；要保留就在 Expires 欄填日期
  - 原本的 domain 或 path 不是這樣的話，會多出一個同名的 cookie，可以先刪掉舊的再新增
- Domain 只能填目前網域，或以 `.` 開頭的上層網域
- 名稱不能有分號、等號或空白，值不能有分號或換行
- 瀏覽器不收的 cookie（例如 `SameSite=None` 沒勾 Secure）那一列會維持沒存成功的樣子，原因會印在 Console：`[chii] 無法設定 cookie ...`

#### 首頁改成線上書城的風格

Chii 首頁（裝置列表）的配色、字型、頁首照[南一智慧電子書線上書城](https://reader.nani.com.tw/bookstore)調整，文案改成中文，並把使用步驟直接寫在列表上方，拿掉原本的 Help 按鈕和說明視窗。

| 位置 | 內容 |
| --- | --- |
| `chii/server/tpl/index.hbs` | 頁首（圖示、標題、版本）、使用步驟、裝置列表的樣式；列表和工具列是 luna 元件，用 CSS 變數和覆寫的樣式換顏色 |
| `chii/src/index.ts` | 拿掉 Help 按鈕和說明視窗 |

- 裝置列表每列高度由 luna-data-grid 固定 20px，只能改顏色、不能改高度
- 篩選欄位、裝置數量、欄位名稱和 inspect 是 `index.ts` 產生的，仍是英文
- 改 `index.hbs` 要重新 `npm start`（範本讀過一次就快取）；`index.js` 的快取是 2 小時，部署後要強制重新整理（Cmd + Shift + R），不然舊的 `index.js` 會留下一個點了沒反應的 Help

### 同步上游

第一次在這台電腦操作要先設定 remote（remote 不會跟著 push）：

```bash
git remote add upstream https://github.com/liriliri/chii.git
git config remote.upstream.tagOpt --no-tags
```

同步步驟：

```bash
# 1. 看上游最新版本
git ls-remote --tags --refs upstream | sed 's#.*refs/tags/##' | sort -V | tail -5

# 2. 開分支後把上游新版本 merge 進 chii/（每次都要加 --squash）
git subtree pull --prefix=chii upstream <tag 或 master> --squash -m "同步上游 chii <版本>"

# 3. 把 package.json 的 chii-prebuilt 改成同一版（"npm:chii@<版本>"），重新安裝並 build
npm install
npm run build
```

- 上游改了什麼可以看 `https://github.com/liriliri/chii/compare/<舊版>...<新版>`
- 有衝突就跟一般 merge 一樣解完再 commit，commit 訊息用 git 產生的就好
- `npm run build` 出現 `[patch-front-end] ✗` 代表新版 DevTools 前端的程式碼變了：到 `chii/public/front_end` 找出對應的新程式碼，更新 `scripts/patch-front-end.js` 的正規表示式；如果上游已經不再限制，就刪掉那一項
- 同步上游的 PR 用一般 merge 併回 `main`，不要 squash 或 rebase，否則 subtree 會找不到上次同步的位置

## 原理

### 為什麼選 Chii

電子書的主要功能都在 WebView 裡，所以先從 WebView 的遠端除錯著手，評估過 Chii 和 [PageSpy](https://github.com/HuolalaTech/page-spy-web)（試架的版本在 [nani-randyhsu/pagespy-server](https://github.com/nani-randyhsu/pagespy-server)），最後選 Chii：

- Chii 直接用 Chrome DevTools 的介面，Elements、Console、Application 都能即時操作，適合線上除錯
- PageSpy 的功能和管理介面比較齊全（例如 Network 看得到 sendBeacon、SSE，還有離線日誌回放），但是：
  - 有許多屬於該專案的說明和品牌頁面，要用得一一拿掉
  - Elements 面板只是一張快照，不能點選或操作，要改頁面得在 Console 下指令再重新整理面板
  - storage、cookie 只能看不能改
  - 除錯房間最長存在 1 小時；5 分鐘沒有資料往來，或手機和除錯介面都斷線超過 1 分鐘，房間就會被刪掉，之後要重新載入頁面才能再連上
- 兩者都是在頁面裡注入 JS 模擬出來的，不能設中斷點、看不到 Native log 這些限制一樣（見「限制」）

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

我們的客製都接在第 3 步：`chii/src/target/connectServer.ts` 收到 DevTools 的指令後，依序交給下面的模組，前面的模組處理完就直接回覆 DevTools，不再往後傳：

| 順序 | 模組 | 處理的指令 |
| --- | --- | --- |
| 1 | `nativeScreencast` | 畫面預覽（`Page.startScreencast` 等），頁面上有 App 截圖 bridge 時才接手 |
| 2 | `touchInput` | 預覽上的滑鼠左鍵和滾輪（`Input.dispatchMouseEvent`） |
| 3 | `editableCookies` | `Network.getCookies`、`Network.setCookie` |
| 4 | `resourceTiming` | 只旁聽 `Network.enable`，不攔 |
| 5 | chobitsu | 其他所有指令，包含 `Network.deleteCookies` |

### App 怎麼注入 target.js

書本頁和登入頁都會注入，做法一樣：先設好 target.js 會讀的全域變數 `window.ChiiServerUrl`、`window.ChiiTitle`，再在頁面插入一個 `<script src="<server>/target.js">`。用 `window.__onebookChiiInjected` 防止重複注入。

| 平台 | 頁面 | 位置 | 注入時機 |
| --- | --- | --- | --- |
| iOS | 書本、登入 | `ChiiRemoteDebug.swift` 的 `ChiiRemoteDebug.install`，由 `BookWebVC`、`LoginVC` 呼叫 | `WKUserScript`，`.atDocumentEnd`（DOM 解析完後）、`forMainFrameOnly: true` |
| Android | 書本 | `WebviewActivity.kt` 的 `interceptIndexHtmlForChii()` | `shouldInterceptRequest` 改寫本機 server 回的 `index.html`，在 `<head>` 最前面同步載入 target.js，比書本的程式先執行；改寫失敗才退回 `onPageFinished` 後用 `evaluateJavascript` 插入 |
| Android | 登入 | `LoginActivity.kt` 的 `injectChiiRemoteDebugIfNeeded()` | `onPageFinished` 後用 `evaluateJavascript` 執行 |

- iOS 的 `ChiiRemoteDebug.swift` 整個包在 `#if DEBUG`；Android 只在 debug / dev / uat build、而且 `CHII_SERVER_URL` 不是空字串時注入
- Android 書本頁同步載入 target.js 的代價是 Render 休眠時，開書要等 target.js 載完
- Android 書本頁還會先掛上一段紀錄 script，把啟動期間的 log 存起來（見「查 DevTools 連上前的紀錄」）

#### 登入頁

- 只注入 club 會員中心的頁面（iOS 比對 `CLUBLOGINURL` 的 host，Android 用 `UrlUtil.isClubLoginHost`），教育雲等第三方登入頁不注入
- club 的 CSP header 不允許載入外部 script、連到 Chii server 的 WebSocket，target.js 本身也會用到 `new Function`，直接注入會被擋。所以 App 會自己向 club 取回主頁 HTML，拿掉 `Content-Security-Policy` header 後再交給 WebView（iOS 用 `loadSimulatedRequest`，Android 用 `shouldInterceptRequest`）；不是 200 的 HTML（例如轉址）或取回失敗時照原本方式載入，這時 Chii 會被 CSP 擋掉
- 也就是說，會注入 Chii 的 build 不會套用 club 的 CSP，CSP 相關的問題要用 Release build 或電腦瀏覽器確認
- iOS 拿不掉寫在 `<meta http-equiv>` 裡的 CSP，club 目前只放在 header
- 登入頁是頁面解析完、載完才注入，會錯過 SPA 啟動階段

## 能做到的事

- **Elements**：查看、修改 DOM 和 CSS
- **Console**：看 log、在頁面裡執行 JS
- **Network**：看 XHR、fetch、WebSocket 請求，以及 JS、CSS、圖片、字型等靜態資源的載入結果（見「Network 面板補上靜態資源」）
- **Application**：看 localStorage、sessionStorage、cookie，cookie 可以修改、新增、刪除（HttpOnly 的除外，見「Application 面板可以修改、新增 cookie」）
- **畫面預覽**：看到 App 截的實際畫面，可以在預覽上點擊、拖曳、用滾輪捲動（見「畫面預覽改用 App 原生截圖」「預覽上的滑鼠操作改模擬成手指觸控」）
- **裝置資訊**：在 Console 請 App 印出裝置資訊（見下方「除錯小技巧」）

## 除錯小技巧

### 在 Console 印出裝置資訊

在書本頁的 Console 執行：

| 平台 | 指令 |
| --- | --- |
| iOS | `window.webkit.messageHandlers.onebook.postMessage({ event: "logDeviceInfo" })` |
| Android | `NaniBridge.postMessage(JSON.stringify({ event: "logDeviceInfo" }))` |

App 收集裝置資訊後，用 `console.log` 印回 Console，內容和書櫃的「裝置回報」一樣。

- 收集時會向 `api.ipify.org` 查公網 IP（最多等 5 秒），所以會晚幾秒才出現
- 只有書本頁有，登入頁沒有
- iOS 書本頁的 `console.log` 被換成轉給 App 的版本，這筆在 Chii 或 Xcode console（`LOG:` 開頭）看得到，Safari Web Inspector 看不到

### 查 DevTools 連上前的紀錄（Android 書本頁）

Android 書本頁在 target.js 之前會先掛上一段紀錄 script，把 console、未捕捉的錯誤、資源載入失敗、fetch、XHR 依序存進 `window.__onebookEarlyLogs`（只留前 1000 筆，`t` 是距離頁面開始的毫秒數）。DevTools 連上前發生的事，Chii 不一定會補送，可以在 Console 執行：

```js
console.table(__onebookEarlyLogs)
```

## 限制

這些功能都是 target.js 在頁面裡用 JS 模擬出來的，不是 WebView 原生的除錯介面，所以有以下限制：

- **不能設中斷點**（已調研，不可行）：JS 注入的除錯只能攔截頁面層級的 API（Console、Network、DOM），沒辦法 attach 到瀏覽器底層的 JS 引擎（V8 / JavaScriptCore）；JS 本身也不能暫停執行緒、控制 call stack，所以做不到中斷點和逐步執行，只能靠 Console 或加 log 追問題。
- **看不到注入前發生的事**：iOS（書本頁、登入頁）和 Android 登入頁都是頁面載入到一半之後才插進 target.js（時機見上方「App 怎麼注入 target.js」），插進去之後還要從 server 下載 target.js 並連線，所以頁面剛開始的 console log 不會出現，請求也只看得到網址和耗時（從資源載入紀錄補上），看不到 header 和內容。Android 書本頁改成在 `<head>` 最前面載入，比書本的程式先執行，DevTools 連上前的紀錄可以查 `window.__onebookEarlyLogs`。
- **Network 的靜態資源資訊較少**：JS、CSS、圖片、字型是從瀏覽器的資源載入紀錄補上的，載完才出現，沒有 header 和內容；只有 XHR、fetch、WebSocket 看得到完整內容。
- **只除錯得到主頁面**：兩邊都只在主頁面注入（iOS 設了 `forMainFrameOnly: true`，Android 只改寫主頁面的 HTML，`evaluateJavascript` 也只在主頁面執行），所以 iframe 裡的內容（例如書本中部分用 iframe 載入的元件）不會被除錯到。
- **看不到 Native log**：Swift / Kotlin 端的 log 不會出現在 DevTools。

## ⚠️ 安全注意

Chii 沒有任何登入驗證，知道網址的人都能看到連線中裝置的 DOM、storage 和 cookie（含登入 token），登入頁輸入的帳號密碼也看得到。

- 只讓 dev / uat build 連線，只用測試帳號
- 正式版 App 不可帶這個網址
- 不要把網址貼到公開的地方
