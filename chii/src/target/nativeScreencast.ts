// OneBook 客製化：畫面預覽改用 App 原生截圖
//
// chobitsu 內建的 Page.startScreencast 是用 html2canvas 把 DOM 重畫一次，
// iframe、video、filter 等很多東西畫不出來。這裡在訊息交給 chobitsu 之前
// 先攔下 Page.startScreencast / stopScreencast / screencastFrameAck：
// 頁面上有 App 提供的截圖 bridge 時，改請 App 用原生 API 截取 WebView 實際畫面，
// 再以 Page.screencastFrame 送回 DevTools；沒有 bridge 就照舊交給 chobitsu。
//
// Bridge 介面（App 端要實作）：
//   頁面 → App：送出 { action: 'capture', id, maxWidth, quality }
//     iOS：window.webkit.messageHandlers.chiiScreencast.postMessage(物件)
//     Android：window.ChiiScreencast.postMessage(JSON 字串)
//   App → 頁面：截完呼叫 window.__chiiScreencastFrame(id, { data, width, height })
//     data 是不含 data: 前綴的 JPEG base64，width / height 是圖片像素；
//     失敗時改傳 { error: '原因' }。

type Send = (message: string) => void;

interface CaptureRequest {
  action: 'capture';
  id: number;
  // 圖片最大寬度（CSS px），App 依此縮圖以節省傳輸量
  maxWidth: number;
  // JPEG 品質 0～1
  quality: number;
}

interface CaptureResult {
  data?: string;
  width?: number;
  height?: number;
  error?: string;
}

type Bridge = (request: CaptureRequest) => void;

const FRAME_CALLBACK = '__chiiScreencastFrame';
// 收到 DevTools 的 ack 之後，隔多久再截下一張
const FRAME_INTERVAL = 500;
// 截圖失敗或頁面在背景時，隔多久再試
const RETRY_INTERVAL = 2000;
// App 太久沒回，就當作這張失敗，避免整個預覽停住
const CAPTURE_TIMEOUT = 5000;
const MAX_QUALITY = 70;

function getBridge(): Bridge | null {
  const win = window as any;
  const iosHandler = win.webkit && win.webkit.messageHandlers && win.webkit.messageHandlers.chiiScreencast;
  if (iosHandler) {
    return request => iosHandler.postMessage(request);
  }
  const androidBridge = win.ChiiScreencast;
  if (androidBridge && typeof androidBridge.postMessage === 'function') {
    return request => androidBridge.postMessage(JSON.stringify(request));
  }
  return null;
}

export default function createNativeScreencast(send: Send) {
  let bridge: Bridge | null = null;
  let casting = false;
  let maxWidth = 0;
  let quality = 0.6;
  let captureId = 0;
  let waitingCaptureId = 0;
  let waitingAck = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hasWarned = false;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delay: number) {
    clearTimer();
    timer = setTimeout(capture, delay);
  }

  function capture() {
    timer = null;
    if (!casting || !bridge) return;
    if (document.hidden) {
      schedule(RETRY_INTERVAL);
      return;
    }

    const id = ++captureId;
    waitingCaptureId = id;
    timer = setTimeout(() => onCaptureFailed(id, 'timeout'), CAPTURE_TIMEOUT);
    try {
      bridge({
        action: 'capture',
        id,
        maxWidth: maxWidth ? Math.min(maxWidth, window.innerWidth) : window.innerWidth,
        quality,
      });
    } catch (e) {
      onCaptureFailed(id, (e as Error).message);
    }
  }

  function onCaptureFailed(id: number, reason: string) {
    if (id !== waitingCaptureId) return;
    waitingCaptureId = 0;
    if (!hasWarned) {
      hasWarned = true;
      console.warn(`[chii] native screencast capture failed: ${reason}`);
    }
    if (casting) schedule(RETRY_INTERVAL);
  }

  function onFrame(id: number, result: CaptureResult | null) {
    if (id !== waitingCaptureId) return;
    if (!result || !result.data) {
      onCaptureFailed(id, (result && result.error) || 'empty frame');
      return;
    }
    waitingCaptureId = 0;
    clearTimer();
    if (!casting) return;

    const deviceWidth = window.innerWidth;
    // 用圖片比例算高度，App 截到的範圍（例如含 safe area）跟 innerHeight 不同時，整張圖都能完整顯示
    const deviceHeight =
      result.width && result.height ? Math.round((deviceWidth * result.height) / result.width) : window.innerHeight;

    send(
      JSON.stringify({
        method: 'Page.screencastFrame',
        params: {
          data: result.data,
          sessionId: id,
          metadata: {
            deviceWidth,
            deviceHeight,
            pageScaleFactor: 1,
            offsetTop: 0,
            scrollOffsetX: 0,
            scrollOffsetY: 0,
            timestamp: Date.now() / 1000,
          },
        },
      })
    );

    // 跟 chobitsu 一樣，收到 ack 才要下一張，不設逾時：
    // 直接關掉 DevTools 分頁時不會送 stopScreencast，server 也不會通知 target，
    // 沒有 ack 就停下來，App 才不會在沒人看的情況下一直截圖
    waitingAck = true;
  }

  function onAck() {
    if (!waitingAck) return;
    waitingAck = false;
    if (casting) schedule(FRAME_INTERVAL);
  }

  function start(params: { maxWidth?: number; quality?: number }) {
    maxWidth = params.maxWidth || 0;
    quality = Math.min(params.quality || MAX_QUALITY, MAX_QUALITY) / 100;
    hasWarned = false;
    if (casting) return;
    casting = true;
    waitingAck = false;
    schedule(0);
  }

  function stop() {
    casting = false;
    waitingCaptureId = 0;
    waitingAck = false;
    clearTimer();
  }

  (window as any)[FRAME_CALLBACK] = onFrame;

  function reply(id: number) {
    send(JSON.stringify({ id, result: {} }));
  }

  // 回傳 true 代表訊息已在這裡處理，不要再交給 chobitsu
  return function handleMessage(rawMessage: string): boolean {
    // startScreencast / stopScreencast / screencastFrameAck 都含 screencast，其他訊息直接略過
    if (!/screencast/i.test(rawMessage)) return false;

    let message: { id: number; method: string; params?: any };
    try {
      message = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    switch (message.method) {
      case 'Page.startScreencast':
        bridge = getBridge();
        if (!bridge) return false;
        start(message.params || {});
        reply(message.id);
        return true;
      case 'Page.stopScreencast':
        if (!bridge) return false;
        stop();
        reply(message.id);
        return true;
      case 'Page.screencastFrameAck':
        if (!bridge) return false;
        onAck();
        reply(message.id);
        return true;
    }
    return false;
  };
}
