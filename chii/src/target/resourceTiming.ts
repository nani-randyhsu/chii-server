// OneBook 客製化：Network 面板補上 JS、CSS、圖片、字型等靜態資源
//
// chobitsu 的 Network 是靠換掉 fetch、XHR、WebSocket 記錄請求；<script>、<link>、<img>、CSS 的 url()
// 是瀏覽器自己下載的，不經過任何 JS 函式，所以 Network 面板看不到。
// 這裡改讀瀏覽器的資源載入紀錄（Resource Timing：performance.getEntriesByType 與 PerformanceObserver），
// 取得每個資源的網址、耗時、大小，再用 capture 階段的 error 事件判斷哪些載入失敗，轉成 Network 事件送給 DevTools。
//
// 跟 chobitsu 的分工：
//   - fetch / XHR 由 chobitsu 記錄（有 header 和內容），這裡略過；只補 target.js 載入前就發出的 fetch / XHR
//   - DevTools 每次送 Network.enable（打開或重新連上）都把目前為止的紀錄重送一次，晚開 DevTools 也看得到頁面一開始載了什麼
//
// 限制：
//   - 資源載完才有紀錄，所以載完才會出現在列表；沒有 header，也沒有內容可以預覽
//   - 狀態碼要瀏覽器支援 responseStatus（Android WebView 109 以後），不支援時狀態欄顯示 Finished
//   - target.js 注入前就載入失敗的資源收不到 error 事件；狀態碼拿得到才看得出 404 這類錯誤
//   - 跨網域資源沒有 Timing-Allow-Origin header 時，大小和細部耗時都是 0
//   - 同時開兩個 DevTools 時，先開的那個會再收到一份重送的紀錄

type Send = (message: string) => void;

interface Failure {
  url: string;
  tagName: string;
  time: number;
}

// 只保留最新的這麼多筆，避免長時間翻書時佔用太多記憶體
const MAX_RECORDS = 1000;
// 收到紀錄後等一下再送，讓同一個資源的 error 事件先到
const FLUSH_DELAY = 300;
// error 事件發生後這段時間內都沒有對應的紀錄（例如連不上 server），就單獨顯示成失敗
const FAILURE_WAIT = 2000;
const ID_PREFIX = 'resource-timing.';

// chobitsu 比這個模組早執行，從這之後發出的 fetch / XHR 都已經由 chobitsu 記錄
const INJECTED_AT = now();

const EXTENSION_TYPES: { [ext: string]: string } = {
  js: 'Script',
  mjs: 'Script',
  css: 'Stylesheet',
  png: 'Image',
  jpg: 'Image',
  jpeg: 'Image',
  gif: 'Image',
  webp: 'Image',
  avif: 'Image',
  svg: 'Image',
  ico: 'Image',
  bmp: 'Image',
  woff: 'Font',
  woff2: 'Font',
  ttf: 'Font',
  otf: 'Font',
  eot: 'Font',
  mp3: 'Media',
  mp4: 'Media',
  m4a: 'Media',
  aac: 'Media',
  wav: 'Media',
  ogg: 'Media',
  webm: 'Media',
  mov: 'Media',
  m3u8: 'Media',
  html: 'Document',
  htm: 'Document',
};

const INITIATOR_TYPES: { [initiatorType: string]: string } = {
  img: 'Image',
  image: 'Image',
  input: 'Image',
  script: 'Script',
  video: 'Media',
  audio: 'Media',
  track: 'TextTrack',
  iframe: 'Document',
  frame: 'Document',
};

const TAG_TYPES: { [tagName: string]: string } = {
  IMG: 'Image',
  IMAGE: 'Image',
  INPUT: 'Image',
  SCRIPT: 'Script',
  VIDEO: 'Media',
  AUDIO: 'Media',
  SOURCE: 'Media',
  TRACK: 'TextTrack',
  IFRAME: 'Document',
};

function now() {
  return window.performance && performance.now ? performance.now() : 0;
}

// performance.now() 的起點換成 epoch 毫秒；chobitsu 的 timestamp 也是 epoch 秒，兩邊的請求才能排在同一條時間軸上
function getTimeOrigin() {
  const perf = window.performance as any;
  if (perf.timeOrigin) return perf.timeOrigin as number;
  if (perf.timing && perf.timing.navigationStart) return perf.timing.navigationStart as number;
  return Date.now() - perf.now();
}

function getExtension(url: string) {
  const path = url.split(/[?#]/)[0].toLowerCase();
  const match = path.match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function getResourceType(entry: PerformanceResourceTiming) {
  if (entry.entryType === 'navigation') return 'Document';
  const initiatorType = entry.initiatorType;
  if (initiatorType === 'fetch') return 'Fetch';
  if (initiatorType === 'xmlhttprequest') return 'XHR';
  if (initiatorType === 'beacon') return 'Ping';
  return EXTENSION_TYPES[getExtension(entry.name)] || INITIATOR_TYPES[initiatorType] || 'Other';
}

function getFailureType(failure: Failure) {
  if (failure.tagName === 'LINK') return EXTENSION_TYPES[getExtension(failure.url)] || 'Stylesheet';
  return TAG_TYPES[failure.tagName] || EXTENSION_TYPES[getExtension(failure.url)] || 'Other';
}

function getMethod(type: string) {
  if (type === 'Ping') return 'POST';
  // Resource Timing 沒有 method，fetch / XHR 可能是 POST，留白不要猜
  if (type === 'Fetch' || type === 'XHR') return '';
  return 'GET';
}

function getStatus(entry: PerformanceResourceTiming): number {
  return (entry as any).responseStatus || 0;
}

function shouldReport(entry: PerformanceResourceTiming) {
  const url = entry.name;
  if (!url || url.indexOf('__chobitsu-hide__') !== -1) return false;
  const initiatorType = entry.initiatorType;
  if ((initiatorType === 'fetch' || initiatorType === 'xmlhttprequest') && entry.startTime >= INJECTED_AT) {
    return false;
  }
  return true;
}

function message(method: string, params: any) {
  return JSON.stringify({ method, params });
}

export default function createResourceTiming(send: Send) {
  const timeOrigin = getTimeOrigin();
  const toSeconds = (time: number) => (timeOrigin + time) / 1000;

  const records: string[][] = [];
  let pendingEntries: PerformanceResourceTiming[] = [];
  let failures: Failure[] = [];
  let enabled = false;
  let flushTimer = 0;
  let seq = 0;

  function addRecord(messages: string[]) {
    records.push(messages);
    if (records.length > MAX_RECORDS) records.shift();
    if (enabled) messages.forEach(send);
  }

  // 同一個網址、在這筆紀錄載完後不久發生的 error 事件，就是這筆載入失敗
  function takeFailure(entry: PerformanceResourceTiming) {
    for (let i = 0; i < failures.length; i++) {
      const failure = failures[i];
      if (failure.url !== entry.name) continue;
      const delay = failure.time - entry.responseEnd;
      if (delay > -50 && delay < FAILURE_WAIT) {
        failures.splice(i, 1);
        return failure;
      }
    }
    return null;
  }

  // CDP 的 timing 都是相對 requestTime 的毫秒，-1 代表沒有這個階段
  function getTiming(entry: PerformanceResourceTiming) {
    // 跨網域又沒有 Timing-Allow-Origin 時這些都是 0，只剩總耗時
    if (!(entry.requestStart > 0)) return undefined;
    const start = entry.startTime;
    const offset = (time: number) => (time > 0 ? time - start : -1);
    const range = (from: number, to: number) => (from > 0 && to > from ? [offset(from), offset(to)] : [-1, -1]);
    const dns = range(entry.domainLookupStart, entry.domainLookupEnd);
    const connect = range(entry.connectStart, entry.connectEnd);
    const ssl = range(entry.secureConnectionStart, entry.connectEnd);
    return {
      requestTime: toSeconds(start),
      proxyStart: -1,
      proxyEnd: -1,
      dnsStart: dns[0],
      dnsEnd: dns[1],
      connectStart: connect[0],
      connectEnd: connect[1],
      sslStart: ssl[0],
      sslEnd: ssl[1],
      workerStart: -1,
      workerReady: -1,
      workerFetchStart: -1,
      workerRespondWithSettled: -1,
      sendStart: offset(entry.requestStart),
      sendEnd: offset(entry.requestStart),
      pushStart: 0,
      pushEnd: 0,
      receiveHeadersStart: offset(entry.responseStart),
      receiveHeadersEnd: offset(entry.responseStart),
    };
  }

  function entryMessages(entry: PerformanceResourceTiming, failure: Failure | null) {
    const requestId = ID_PREFIX + ++seq;
    const type = getResourceType(entry);
    const url = entry.name;
    const status = getStatus(entry);
    const startTime = toSeconds(entry.startTime);
    const endTime = toSeconds(entry.responseEnd > 0 ? entry.responseEnd : entry.startTime + entry.duration);
    const headersTime = entry.responseStart > 0 ? toSeconds(entry.responseStart) : endTime;
    const transferSize = typeof entry.transferSize === 'number' ? entry.transferSize : -1;
    const bodySize = entry.decodedBodySize || 0;
    // 有 4xx / 5xx 狀態碼時直接顯示狀態碼就看得出錯誤；其他情況（例如回應 200 但圖片壞掉）才顯示成 (failed)
    const failed = !!failure && status < 400;

    const messages = [
      message('Network.requestWillBeSent', {
        requestId,
        loaderId: '',
        documentURL: location.href,
        request: { url, method: getMethod(type), headers: {} },
        timestamp: startTime,
        wallTime: startTime,
        initiator: { type: 'other' },
        type,
      }),
      message('Network.responseReceived', {
        requestId,
        loaderId: '',
        timestamp: headersTime,
        type,
        response: {
          url,
          // 有狀態碼時 DevTools 不會把失敗的列標成紅色，失敗時狀態碼改寫在 errorText
          status: failed ? 0 : status,
          statusText: '',
          headers: {},
          mimeType: (entry as any).contentType || '',
          // 有內容但傳輸量是 0：從快取拿的，Size 欄會顯示 (disk cache)
          fromDiskCache: transferSize === 0 && bodySize > 0,
          protocol: entry.nextHopProtocol || '',
          timing: getTiming(entry),
        },
      }),
    ];
    if (bodySize > 0) {
      messages.push(
        message('Network.dataReceived', { requestId, timestamp: endTime, dataLength: bodySize, encodedDataLength: 0 })
      );
    }
    if (failed) {
      messages.push(
        message('Network.loadingFailed', {
          requestId,
          timestamp: endTime,
          type,
          errorText: status ? `error 事件（HTTP ${status}）` : 'error 事件',
          canceled: false,
        })
      );
    } else {
      messages.push(
        message('Network.loadingFinished', {
          requestId,
          timestamp: endTime,
          encodedDataLength: transferSize > 0 ? transferSize : 0,
        })
      );
    }
    return messages;
  }

  // 有 error 事件卻沒有載入紀錄（例如連不上 server），只知道網址和失敗時間
  function failureMessages(failure: Failure) {
    const requestId = ID_PREFIX + ++seq;
    const type = getFailureType(failure);
    const time = toSeconds(failure.time);
    return [
      message('Network.requestWillBeSent', {
        requestId,
        loaderId: '',
        documentURL: location.href,
        request: { url: failure.url, method: 'GET', headers: {} },
        timestamp: time,
        wallTime: time,
        initiator: { type: 'other' },
        type,
      }),
      message('Network.loadingFailed', {
        requestId,
        timestamp: time,
        type,
        errorText: 'error 事件（沒有載入紀錄）',
        canceled: false,
      }),
    ];
  }

  function flush() {
    flushTimer = 0;
    const entries = pendingEntries;
    pendingEntries = [];
    entries.forEach(entry => addRecord(entryMessages(entry, takeFailure(entry))));

    const time = now();
    const waiting: Failure[] = [];
    failures.forEach(failure => {
      if (time - failure.time < FAILURE_WAIT) {
        waiting.push(failure);
      } else {
        addRecord(failureMessages(failure));
      }
    });
    failures = waiting;
    if (failures.length) scheduleFlush(FAILURE_WAIT);
  }

  function scheduleFlush(delay: number) {
    if (!flushTimer) flushTimer = window.setTimeout(flush, delay);
  }

  function addEntries(entries: PerformanceEntry[]) {
    entries.forEach(entry => {
      if (shouldReport(entry as PerformanceResourceTiming)) {
        pendingEntries.push(entry as PerformanceResourceTiming);
      }
    });
    if (pendingEntries.length) scheduleFlush(FLUSH_DELAY);
  }

  function onError(event: Event) {
    const element = event.target as any;
    if (!element || element === window || !element.tagName) return;
    const url = element.currentSrc || element.src || element.href;
    // SVG <image> 的 href 不是字串
    if (!url || typeof url !== 'string') return;
    failures.push({ url, tagName: String(element.tagName).toUpperCase(), time: now() });
    scheduleFlush(FAILURE_WAIT);
  }

  function start() {
    const perf = window.performance;
    if (!perf || typeof perf.getEntriesByType !== 'function') return;

    // 資源載入失敗的 error 事件不會冒泡，要在 capture 階段才收得到
    window.addEventListener('error', onError, true);

    // target.js 注入前已經載入的資源：從瀏覽器保留的紀錄補上（瀏覽器預設最多保留 250 筆）
    addEntries(perf.getEntriesByType('navigation').concat(perf.getEntriesByType('resource')));

    if (typeof PerformanceObserver === 'function') {
      try {
        new PerformanceObserver(list => addEntries(list.getEntries())).observe({ entryTypes: ['resource'] });
      } catch {
        // 不支援就只有注入前的紀錄
      }
    }
  }

  start();

  // DevTools 送來的訊息都會經過這裡；不攔截，訊息照樣交給 chobitsu
  return function handleMessage(rawMessage: string) {
    if (rawMessage.indexOf('"Network.enable"') === -1 && rawMessage.indexOf('"Network.disable"') === -1) return;

    let method = '';
    try {
      method = JSON.parse(rawMessage).method;
    } catch {
      return;
    }
    if (method === 'Network.disable') {
      enabled = false;
    } else if (method === 'Network.enable') {
      // 等 chobitsu 先回覆 Network.enable，再把目前為止的紀錄全部重送
      setTimeout(() => {
        enabled = true;
        records.forEach(messages => messages.forEach(send));
      }, 0);
    }
  };
}
