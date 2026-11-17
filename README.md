# chii-server

OneBook App（iOS / Android）書本 WebView 遠端除錯用的 [Chii](https://github.com/liriliri/chii) server，部署在 Render 免費方案。

## 使用方式

1. 電腦瀏覽器打開 Render 給的網址（例如 `https://chii-server-xxxx.onrender.com`）
   - 免費方案閒置 15 分鐘會休眠，第一次打開要等約 1 分鐘叫醒
2. 用 dev / uat 版 App 打開書本，App 會自動載入 `https://<網址>/target.js`
3. 回到瀏覽器，在 target 列表點對應的裝置（標題 `OneBook iOS - <bookid>`）開始除錯

## 部署（Render）

用 Blueprint 部署：Render → New → Blueprint → 選這個 repo，會讀 `render.yaml` 自動建立服務。

- Build：`npm install`
- Start：`npm start`（`chii start -p $PORT -d $RENDER_EXTERNAL_HOSTNAME`）
- `-d` 一定要帶對外網域：Chii 首頁的 `index.js` 和 DevTools 連線網址都用這個值產生，
  沒帶會變成 `localhost:<port>`，在 Render 上打不開

## 本機執行

```bash
npm install
npm start          # http://localhost:8080
```

## ⚠️ 安全注意

Chii 沒有任何登入驗證，知道網址的人都能看到連線中裝置的 DOM、storage 和 cookie（含登入 token）。

- 只讓 dev / uat build 連線，只用測試帳號
- 正式版 App 不可帶這個網址
- 不要把網址貼到公開的地方
