// OneBook 客製化：Application → Cookies 可以修改、新增 cookie
//
// chobitsu 只實作 Network.getCookies 和 deleteCookies，沒有 Network.setCookie，
// DevTools 改值或新增時會收到 unimplemented 錯誤，表格跳回原本的值。
// 而且 chobitsu 的 getCookies 只回傳名稱和值，DevTools 存檔時要讀 cookie 的 domain，
// 沒有 domain 會在送出 setCookie 之前就出錯；值也先做了 decodeURIComponent，改完寫回去會變成另一個值。
//
// 這裡在訊息交給 chobitsu 之前先攔下：
//   Network.getCookies：回傳原始的值，並補上 domain、path、到期時間等欄位
//   Network.setCookie：用 document.cookie 寫入，寫完確認瀏覽器真的收下
// 刪除照舊交給 chobitsu。
//
// 限制：
// - JS 碰不到 HttpOnly cookie：列表看不到，也不能設定成 HttpOnly
// - document.cookie 只有名稱和值。瀏覽器的 Cookie Store API 有給 domain、path、到期時間時照實顯示；
//   沒給的就當作目前網域、path 是 /、session cookie。這時改值會變成 session cookie，
//   原本的 domain 或 path 不是這樣的話，會多出一個同名的 cookie

type Send = (message: string) => void;

// CDP 的 Network.Cookie
interface ProtocolCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
  priority: string;
}

// CDP 的 Network.setCookie 參數（DevTools 實際會送的部分）
interface SetCookieParams {
  name?: string;
  value?: string;
  url?: string;
  // 以 . 開頭的 domain cookie 才會有；只給目前網域的 cookie 改用 url 表示
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  // 秒；session cookie 沒有
  expires?: number;
}

// Cookie Store API 的 cookie。Chrome 會給 domain、path、expires 等欄位，有些瀏覽器只給名稱和值
interface StoreCookie {
  name: string;
  value: string;
  domain?: string | null;
  path?: string;
  expires?: number | null;
  secure?: boolean;
  sameSite?: string;
}

const SAME_SITE: { [value: string]: string } = { strict: 'Strict', lax: 'Lax', none: 'None' };

// document.cookie 裡的 cookie，值保持原樣，不做 decodeURIComponent
function readDocumentCookies(): StoreCookie[] {
  const cookies: StoreCookie[] = [];
  const entries = document.cookie ? document.cookie.split(';') : [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i].replace(/^\s+/, '');
    if (!entry) continue;
    const index = entry.indexOf('=');
    // 沒有 = 的是沒有名稱的 cookie
    cookies.push(index < 0 ? { name: '', value: entry } : { name: entry.slice(0, index), value: entry.slice(index + 1) });
  }
  return cookies;
}

function toProtocolCookie(cookie: StoreCookie): ProtocolCookie {
  const expires = cookie.expires ? cookie.expires / 1000 : undefined;
  return {
    name: cookie.name,
    value: cookie.value,
    // CDP 的 domain cookie 以 . 開頭；Cookie Store API 的 domain 是 null 代表只給目前網域
    domain: cookie.domain ? '.' + cookie.domain.replace(/^\./, '') : location.hostname,
    path: cookie.path || '/',
    expires,
    size: cookie.name.length + cookie.value.length,
    httpOnly: false,
    secure: !!cookie.secure,
    session: !expires,
    sameSite: cookie.sameSite ? SAME_SITE[cookie.sameSite.toLowerCase()] : undefined,
    priority: 'Medium',
  };
}

function getCookies(): Promise<ProtocolCookie[]> {
  const fromDocument = () => readDocumentCookies().map(toProtocolCookie);
  // Cookie Store API 只在 https、localhost 這類安全環境才有
  const store = (window as any).cookieStore;
  if (store && typeof store.getAll === 'function') {
    return store.getAll().then((cookies: StoreCookie[]) => cookies.map(toProtocolCookie), fromDocument);
  }
  return Promise.resolve(fromDocument());
}

// 目前頁面的網址在不在這個 cookie 的 path 底下（在的話 document.cookie 才看得到它）
function isPathMatched(cookiePath: string) {
  const path = location.pathname || '/';
  if (path === cookiePath) return true;
  if (path.indexOf(cookiePath) !== 0) return false;
  return cookiePath.charAt(cookiePath.length - 1) === '/' || path.charAt(cookiePath.length) === '/';
}

// 寫入 cookie，成功回傳空字串，失敗回傳原因
function setCookie(params: SetCookieParams): string {
  const name = params.name || '';
  const value = params.value || '';
  if (params.httpOnly) return 'HttpOnly cookie 不能用 JS 設定';
  if (!name) return '要填名稱';
  if (/[;=\s]/.test(name) || /[;\r\n]/.test(value)) return '名稱不能有分號、等號或空白，值不能有分號或換行';

  let cookie = `${name}=${value}`;
  const domain = (params.domain || '').replace(/^\./, '');
  if (domain) {
    cookie += `; domain=${domain}`;
  } else if (params.url) {
    let host = '';
    try {
      host = new URL(params.url).hostname;
    } catch {
      return `網址 ${params.url} 不正確`;
    }
    if (host.toLowerCase() !== location.hostname.toLowerCase()) {
      return `Domain 只能填目前網域 ${location.hostname}，或以 . 開頭的上層網域`;
    }
  }
  const path = params.path || '/';
  cookie += `; path=${path}`;
  if (params.expires) cookie += `; expires=${new Date(params.expires * 1000).toUTCString()}`;
  if (params.secure) cookie += '; secure';
  if (params.sameSite) cookie += `; samesite=${params.sameSite}`;

  document.cookie = cookie;

  // 瀏覽器不收時不會報錯（例如 domain 不對、SameSite=None 沒勾 Secure），只能寫完再讀回來確認；
  // path 不含目前頁面或已經過期的 cookie 本來就讀不到，就不檢查
  const expired = !!params.expires && params.expires * 1000 <= Date.now();
  if (!expired && isPathMatched(path)) {
    const saved = readDocumentCookies().some(item => item.name === name && item.value === value);
    if (!saved) return '瀏覽器沒有收下這個 cookie，請檢查 Domain、Path、Secure、SameSite';
  }
  return '';
}

export default function createEditableCookies(send: Send) {
  // 回傳 true 代表訊息已在這裡處理，不要再交給 chobitsu
  return function handleMessage(rawMessage: string): boolean {
    // getCookies / setCookie 都含 Cookie，其他訊息直接略過
    if (rawMessage.indexOf('Cookie') < 0) return false;

    let message: { id: number; method: string; params?: any };
    try {
      message = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    switch (message.method) {
      case 'Network.getCookies':
        getCookies().then(cookies => send(JSON.stringify({ id: message.id, result: { cookies } })));
        return true;
      case 'Network.setCookie': {
        const params: SetCookieParams = message.params || {};
        const error = setCookie(params);
        if (error) {
          // DevTools 只會把那一列標成沒存成功，原因印在 Console
          console.warn(`[chii] 無法設定 cookie ${params.name || ''}：${error}`);
          send(JSON.stringify({ id: message.id, error: { code: -32000, message: error } }));
        } else {
          send(JSON.stringify({ id: message.id, result: { success: true } }));
        }
        return true;
      }
    }
    return false;
  };
}
