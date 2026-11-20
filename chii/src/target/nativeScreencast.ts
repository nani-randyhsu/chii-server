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
//
// iOS 的截圖（takeSnapshot，試過 drawHierarchy 也一樣）截不到 <video> 的畫面，例如生字的筆順動畫，
// 所以 iOS 收到截圖後，再把畫面上每個 <video> 目前的畫格畫到截圖上（見 drawVideosOnFrame）。
// Android 的 PixelCopy 是複製螢幕上的實際像素，影片本來就在截圖裡，不用補。

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

interface Bridge {
  capture: (request: CaptureRequest) => void;
  // App 的截圖沒有影片畫面，要自己補畫
  drawVideos: boolean;
}

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
    return { capture: request => iosHandler.postMessage(request), drawVideos: true };
  }
  const androidBridge = win.ChiiScreencast;
  if (androidBridge && typeof androidBridge.postMessage === 'function') {
    return { capture: request => androidBridge.postMessage(JSON.stringify(request)), drawVideos: false };
  }
  return null;
}

// 畫面上看得到、而且已經有畫格的 <video>
function getVisibleVideos(): HTMLVideoElement[] {
  const videos = document.getElementsByTagName('video');
  const visible: HTMLVideoElement[] = [];
  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    // readyState 2（HAVE_CURRENT_DATA）以上才有目前的畫格可以畫
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) continue;
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) continue;
    if (getComputedStyle(video).visibility === 'hidden') continue;
    visible.push(video);
  }
  return visible;
}

// 照 <video> 在畫面上的位置和 object-fit，把目前的畫格畫到截圖上；scale 是截圖像素 / CSS px
function drawVideo(context: CanvasRenderingContext2D, video: HTMLVideoElement, scale: number) {
  const rect = video.getBoundingClientRect();
  const style = getComputedStyle(video);
  const px = (value: string) => parseFloat(value) || 0;
  // 影片畫在 content box 裡，要扣掉 border 和 padding
  const left = rect.left + px(style.borderLeftWidth) + px(style.paddingLeft);
  const top = rect.top + px(style.borderTopWidth) + px(style.paddingTop);
  const width = rect.right - px(style.borderRightWidth) - px(style.paddingRight) - left;
  const height = rect.bottom - px(style.borderBottomWidth) - px(style.paddingBottom) - top;
  if (width <= 0 || height <= 0) return;

  let drawWidth = width;
  let drawHeight = height;
  if (style.objectFit !== 'fill') {
    const containScale = Math.min(width / video.videoWidth, height / video.videoHeight);
    let videoScale = containScale; // contain 是 <video> 的預設值
    if (style.objectFit === 'cover') videoScale = Math.max(width / video.videoWidth, height / video.videoHeight);
    if (style.objectFit === 'none') videoScale = 1;
    if (style.objectFit === 'scale-down') videoScale = Math.min(1, containScale);
    drawWidth = video.videoWidth * videoScale;
    drawHeight = video.videoHeight * videoScale;
  }

  // object-position 一律當作置中（預設值），超出 content box 的部分裁掉
  context.save();
  context.beginPath();
  context.rect(left * scale, top * scale, width * scale, height * scale);
  context.clip();
  context.drawImage(
    video,
    (left + (width - drawWidth) / 2) * scale,
    (top + (height - drawHeight) / 2) * scale,
    drawWidth * scale,
    drawHeight * scale
  );
  context.restore();
}

// 把畫面上的 <video> 補畫到 App 的截圖上，畫完交給 done；沒有影片就直接交回原本的截圖。
// 限制：疊在影片上面的元素會被影片蓋掉；CSS 旋轉、圓角不處理；iframe 裡的影片不處理。
// 跨網域又沒開 CORS 的影片畫上去之後 canvas 不能輸出，這時呼叫 onError，照原本的截圖送出。
function drawVideosOnFrame(
  frame: CaptureResult,
  quality: number,
  onError: (reason: string) => void,
  done: (frame: CaptureResult) => void
) {
  const videos = getVisibleVideos();
  if (!videos.length) {
    done(frame);
    return;
  }

  const image = new Image();
  image.onload = () => {
    let result = frame;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas 2d context is not available');
      context.drawImage(image, 0, 0);
      // 截圖的寬度對應整個畫面寬度（innerWidth），App 可能縮小過
      const scale = image.width / window.innerWidth;
      videos.forEach(video => drawVideo(context, video, scale));
      result = {
        data: canvas.toDataURL('image/jpeg', quality).replace(/^data:image\/jpeg;base64,/, ''),
        width: image.width,
        height: image.height,
      };
    } catch (e) {
      onError((e as Error).message);
    }
    done(result);
  };
  image.onerror = () => {
    onError('cannot decode the native frame');
    done(frame);
  };
  image.src = 'data:image/jpeg;base64,' + frame.data;
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
  let hasWarnedVideo = false;
  // 每次停止預覽就加 1，補畫影片途中停止過的那張不送出
  let generation = 0;

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
      bridge.capture({
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
    if (!casting || !bridge) return;

    if (!bridge.drawVideos) {
      sendFrame(id, result);
      return;
    }
    const frameGeneration = generation;
    drawVideosOnFrame(result, quality, onDrawVideosFailed, frame => {
      if (casting && frameGeneration === generation) sendFrame(id, frame);
    });
  }

  function onDrawVideosFailed(reason: string) {
    if (hasWarnedVideo) return;
    hasWarnedVideo = true;
    console.warn(`[chii] cannot draw videos on the native screencast frame: ${reason}`);
  }

  function sendFrame(id: number, result: CaptureResult) {
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
    hasWarnedVideo = false;
    if (casting) return;
    casting = true;
    waitingAck = false;
    schedule(0);
  }

  function stop() {
    casting = false;
    generation++;
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
