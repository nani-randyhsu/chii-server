// OneBook 客製化：預覽上的滑鼠操作改模擬成手指觸控
//
// chobitsu 處理 DevTools 的 Input.dispatchMouseEvent 時，只對游標下的元素送出
// mousedown / mousemove / mouseup（buttons 固定是 0），放開時再補 click，
// 所以書本裡用 touch 或 pointer 事件寫的拖曳，在預覽上拖不動。
// 這裡在訊息交給 chobitsu 之前，先攔下左鍵的按下、移動、放開，改送跟手機瀏覽器處理手指一樣的事件：
//   按下：pointerdown → touchstart
//   移動：pointermove → touchmove（送給按下時的元素，跟真的觸控一樣）
//   放開：pointerup → touchend；沒有移動（點一下）而且沒被 preventDefault 時，再補 mousedown → mouseup → click
// 沒按著時的游標移動不送事件（手指沒有 hover），右鍵等其他按鍵照舊交給 chobitsu。
//
// 拖曳捲動：JS 產生的事件（isTrusted 為 false）不會讓瀏覽器原生捲動，例如 overflow-x: auto 的工具列拖不動。
// 所以這裡照手機瀏覽器的規則自己捲：移動超過 TAP_SLOP 時，touchstart 和這次的 touchmove 都沒被 preventDefault，
// 就從按下的元素往上找第一個這個方向捲得動的區塊（overflow 是 auto / scroll，而且還沒捲到底），
// 途中的 touch-action 也要允許這個方向（例如 touch-action: none 的畫布不會捲），之後跟著游標捲動。
// 開始捲動時跟手機一樣送 pointercancel，之後不再送 pointer 事件，touch 事件照送。
//
// 滾輪也在這裡處理：chobitsu 是 scrollTop -= deltaY，跟 DevTools 送來的 deltaY 方向相反，
// 在預覽上往下滾，頁面反而往上捲。這裡先送 wheel 事件，沒被 preventDefault 就照 deltaY 的方向捲動。
//
// 限制：仍然是 JS 產生的事件，瀏覽器不會因此選取文字或啟動 HTML5 拖放；拖曳捲動沒有放開後的慣性。

type Send = (message: string) => void;

interface MouseParams {
  type: string;
  x: number;
  y: number;
  button?: string;
  modifiers?: number;
  deltaX?: number;
  deltaY?: number;
}

interface TouchPoint {
  identifier: number;
  target: EventTarget;
  clientX: number;
  clientY: number;
  pageX: number;
  pageY: number;
  screenX: number;
  screenY: number;
  radiusX: number;
  radiusY: number;
  rotationAngle: number;
  force: number;
}

// 拖曳捲動中的區塊；allowX / allowY 是途中的 touch-action 允不允許這個方向
interface DragScroll {
  element: Element;
  allowX: boolean;
  allowY: boolean;
}

interface ActiveTouch {
  target: Element;
  startX: number;
  startY: number;
  // 上一次的位置，拖曳捲動時算移動量
  lastX: number;
  lastY: number;
  moved: boolean;
  // pointerdown 被 preventDefault：不補 mousedown / mouseup
  suppressMouse: boolean;
  // touchstart / touchend 被 preventDefault：不補任何 mouse 事件和 click
  suppressClick: boolean;
  // 拖曳捲動：還沒決定 / 不捲（頁面 preventDefault 或找不到捲得動的區塊）/ 正在捲的區塊
  scroll: 'pending' | 'none' | DragScroll;
}

// 模擬手指用的 pointerId，挑一個不會跟真實輸入撞到的值
const POINTER_ID = 9527;
// 移動超過這個距離（CSS px）就算拖曳，放開時不補 click
const TAP_SLOP = 10;

// 模擬的 pointer 不是瀏覽器裡真的存在的 pointer，對它呼叫 setPointerCapture 會丟例外，
// 所以替這個 pointerId 自己記錄 capture 的元素，讓用 pointer capture 的拖曳也能運作
let captureTarget: Element | null = null;

function setCaptureTarget(target: Element | null) {
  captureTarget = target;
}

function patchPointerCapture() {
  const proto = Element.prototype as any;
  if (!proto.setPointerCapture || proto.__chiiTouchInputPatched) return;
  proto.__chiiTouchInputPatched = true;

  const setCapture = proto.setPointerCapture;
  const releaseCapture = proto.releasePointerCapture;
  const hasCapture = proto.hasPointerCapture;
  proto.setPointerCapture = function (pointerId: number) {
    if (pointerId !== POINTER_ID) return setCapture.call(this, pointerId);
    setCaptureTarget(this);
  };
  proto.releasePointerCapture = function (pointerId: number) {
    if (pointerId !== POINTER_ID) return releaseCapture.call(this, pointerId);
    if (captureTarget === this) setCaptureTarget(null);
  };
  proto.hasPointerCapture = function (pointerId: number) {
    if (pointerId !== POINTER_ID) return hasCapture.call(this, pointerId);
    return captureTarget === this;
  };
}

function eventInit(params: MouseParams) {
  const modifiers = params.modifiers || 0;
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: params.x,
    clientY: params.y,
    screenX: params.x,
    screenY: params.y,
    altKey: !!(modifiers & 1),
    ctrlKey: !!(modifiers & 2),
    metaKey: !!(modifiers & 4),
    shiftKey: !!(modifiers & 8),
  };
}

// 回傳 false 代表事件被 preventDefault
function firePointer(type: string, target: Element, params: MouseParams, buttons: number) {
  if (typeof PointerEvent !== 'function') return true;
  const event = new PointerEvent(type, {
    ...eventInit(params),
    pointerId: POINTER_ID,
    pointerType: 'touch',
    isPrimary: true,
    width: 1,
    height: 1,
    pressure: buttons ? 0.5 : 0,
    button: type === 'pointermove' ? -1 : 0,
    buttons,
  });
  return target.dispatchEvent(event);
}

function fireMouse(type: string, target: Element, params: MouseParams, buttons: number) {
  return target.dispatchEvent(
    new MouseEvent(type, {
      ...eventInit(params),
      button: 0,
      buttons,
      detail: type === 'mousemove' ? 0 : 1,
    })
  );
}

function makeTouchPoint(target: Element, params: MouseParams): TouchPoint {
  return {
    identifier: 0,
    target,
    clientX: params.x,
    clientY: params.y,
    pageX: params.x + window.pageXOffset,
    pageY: params.y + window.pageYOffset,
    screenX: params.x,
    screenY: params.y,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
  };
}

function toTouchList(items: any[]) {
  const list: any = items.slice();
  list.item = (index: number) => list[index] || null;
  return list;
}

function createTouchEvent(type: string, point: TouchPoint, ended: boolean, params: MouseParams): Event {
  const init = eventInit(params);
  try {
    if (typeof Touch === 'function' && typeof TouchEvent === 'function') {
      const touch = new Touch(point);
      const touches = ended ? [] : [touch];
      const event = new TouchEvent(type, {
        ...init,
        touches,
        targetTouches: touches,
        changedTouches: [touch],
      });
      if (event.changedTouches && event.changedTouches.length === 1) return event;
    }
  } catch {
    // 不支援用建構子建立 Touch / TouchEvent，改用下面的做法
  }

  // 不能建立真正的 TouchEvent 時（例如部分 iOS 版本），用一般 Event 補上 touches 等屬性，讀法跟 TouchEvent 一樣
  const event = new Event(type, init);
  const touches = toTouchList(ended ? [] : [point]);
  const props: { [key: string]: any } = {
    touches,
    targetTouches: touches,
    changedTouches: toTouchList([point]),
    altKey: init.altKey,
    ctrlKey: init.ctrlKey,
    metaKey: init.metaKey,
    shiftKey: init.shiftKey,
  };
  Object.keys(props).forEach(key => Object.defineProperty(event, key, { value: props[key] }));
  return event;
}

function fireTouch(type: string, target: Element, params: MouseParams, ended: boolean) {
  return target.dispatchEvent(createTouchEvent(type, makeTouchPoint(target, params), ended, params));
}

function canScroll(element: Element, axis: 'x' | 'y') {
  const style = getComputedStyle(element);
  return axis === 'x'
    ? element.scrollWidth > element.clientWidth && style.overflowX !== 'hidden'
    : element.scrollHeight > element.clientHeight && style.overflowY !== 'hidden';
}

function wheel(params: MouseParams) {
  const deltaX = params.deltaX || 0;
  const deltaY = params.deltaY || 0;
  const target = document.elementFromPoint(params.x, params.y) || document.documentElement;
  const event = new WheelEvent('wheel', { ...eventInit(params), deltaX, deltaY, deltaMode: 0 });
  if (!target.dispatchEvent(event)) return;

  // 找游標所在位置往上第一個捲得動的元素，找不到就捲整頁（判斷方式同 chobitsu）
  let element: Element | null = target;
  while (element) {
    if ((deltaX && canScroll(element, 'x')) || (deltaY && canScroll(element, 'y'))) break;
    element = element.parentElement;
  }
  const scroller = element || document.scrollingElement || document.documentElement;
  scroller.scrollLeft += deltaX;
  scroller.scrollTop += deltaY;
}

// 依 touch-action 判斷手指能不能往這個方向平移（none、只有 pinch-zoom 等都不行）
function allowsPan(element: Element, axis: 'x' | 'y') {
  const value = getComputedStyle(element).touchAction || 'auto';
  if (value === 'auto' || value === 'manipulation') return true;
  return axis === 'x' ? /pan-(x|left|right)/.test(value) : /pan-(y|up|down)/.test(value);
}

// 整頁能不能用手指捲：<html> 或 <body> 的 overflow 是 hidden 時，手機上捲不動
function isPageScrollBlocked(axis: 'x' | 'y') {
  return [document.documentElement, document.body].some(element => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const overflow = axis === 'x' ? style.overflowX : style.overflowY;
    return overflow === 'hidden' || overflow === 'clip';
  });
}

// 這個元素能不能往這個方向捲；delta 是要捲的量，正數代表 scrollLeft / scrollTop 變大
function canDragScroll(element: Element, axis: 'x' | 'y', delta: number) {
  if (element === (document.scrollingElement || document.documentElement)) {
    if (isPageScrollBlocked(axis)) return false;
  } else {
    const style = getComputedStyle(element);
    const overflow = axis === 'x' ? style.overflowX : style.overflowY;
    if (overflow !== 'auto' && overflow !== 'scroll') return false;
  }
  const max = axis === 'x' ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
  const position = axis === 'x' ? element.scrollLeft : element.scrollTop;
  return delta > 0 ? position < max - 1 : position > 0;
}

// 從按下的元素往上找第一個這個方向捲得動的區塊，途中的 touch-action 不允許這個方向就不捲
function findDragScroll(target: Element, axis: 'x' | 'y', delta: number): DragScroll | null {
  let allowX = true;
  let allowY = true;
  let element: Element | null = target;
  while (element) {
    allowX = allowX && allowsPan(element, 'x');
    allowY = allowY && allowsPan(element, 'y');
    if (!(axis === 'x' ? allowX : allowY)) return null;
    if (canDragScroll(element, axis, delta)) return { element, allowX, allowY };
    element = element.parentElement;
  }
  return null;
}

export default function createTouchInput(send: Send) {
  let active: ActiveTouch | null = null;

  patchPointerCapture();

  function press(params: MouseParams) {
    const target = document.elementFromPoint(params.x, params.y) || document.documentElement;
    captureTarget = null;
    active = {
      target,
      startX: params.x,
      startY: params.y,
      lastX: params.x,
      lastY: params.y,
      moved: false,
      suppressMouse: false,
      suppressClick: false,
      scroll: 'pending',
    };
    if (!firePointer('pointerdown', target, params, 1)) active.suppressMouse = true;
    if (!fireTouch('touchstart', target, params, false)) {
      // touchstart 被 preventDefault，手機上這次觸控不會捲動
      active.suppressClick = true;
      active.scroll = 'none';
    }
  }

  // 移動超過 TAP_SLOP 時決定要不要捲、捲哪個區塊
  function startDragScroll(touch: ActiveTouch, params: MouseParams) {
    const deltaX = touch.startX - params.x;
    const deltaY = touch.startY - params.y;
    const axis = Math.abs(deltaX) >= Math.abs(deltaY) ? 'x' : 'y';
    const scroll = findDragScroll(touch.target, axis, axis === 'x' ? deltaX : deltaY);
    if (!scroll) {
      touch.scroll = 'none';
      return;
    }
    touch.scroll = scroll;
    // 手機開始捲動時會取消 pointer，之後不再送 pointer 事件
    firePointer('pointercancel', captureTarget || touch.target, params, 0);
    captureTarget = null;
    // 從按下的位置開始算，捲動量才會跟游標一致
    touch.lastX = touch.startX;
    touch.lastY = touch.startY;
  }

  function move(touch: ActiveTouch, params: MouseParams) {
    if (Math.abs(params.x - touch.startX) > TAP_SLOP || Math.abs(params.y - touch.startY) > TAP_SLOP) {
      touch.moved = true;
    }
    if (typeof touch.scroll !== 'object') {
      firePointer('pointermove', captureTarget || touch.target, params, 1);
    }
    const notPrevented = fireTouch('touchmove', touch.target, params, false);

    if (touch.scroll === 'pending') {
      // 開始捲動前的 touchmove 被 preventDefault（例如頁面自己處理拖曳），就不捲
      if (!notPrevented) touch.scroll = 'none';
      else if (touch.moved) startDragScroll(touch, params);
    }
    if (typeof touch.scroll === 'object') {
      const { element, allowX, allowY } = touch.scroll;
      if (allowX) element.scrollLeft += touch.lastX - params.x;
      if (allowY) element.scrollTop += touch.lastY - params.y;
    }
    touch.lastX = params.x;
    touch.lastY = params.y;
  }

  function release(touch: ActiveTouch, params: MouseParams) {
    // 已經開始捲動的話 pointer 早就取消了，不再送 pointerup
    if (typeof touch.scroll !== 'object') {
      firePointer('pointerup', captureTarget || touch.target, params, 0);
    }
    captureTarget = null;
    if (!fireTouch('touchend', touch.target, params, true)) touch.suppressClick = true;

    if (touch.moved || touch.suppressClick) return;
    if (!touch.suppressMouse) {
      fireMouse('mousedown', touch.target, params, 1);
      fireMouse('mouseup', touch.target, params, 0);
    }
    fireMouse('click', touch.target, params, 0);
  }

  // 回傳 true 代表訊息已在這裡處理，不要再交給 chobitsu
  return function handleMessage(rawMessage: string): boolean {
    if (
      rawMessage.indexOf('Input.dispatchMouseEvent') === -1 &&
      rawMessage.indexOf('Input.emulateTouchFromMouseEvent') === -1
    ) {
      return false;
    }

    let message: { id: number; method: string; params: MouseParams };
    try {
      message = JSON.parse(rawMessage);
    } catch {
      return false;
    }
    if (message.method !== 'Input.dispatchMouseEvent' && message.method !== 'Input.emulateTouchFromMouseEvent') {
      return false;
    }

    const params = message.params || ({} as MouseParams);
    switch (params.type) {
      case 'mousePressed':
        if (params.button && params.button !== 'left') return false;
        press(params);
        break;
      case 'mouseMoved':
        // 沒按著時不送事件：手指沒有 hover
        if (active) move(active, params);
        break;
      case 'mouseReleased':
        if (!active) return false;
        release(active, params);
        active = null;
        break;
      case 'mouseWheel':
        wheel(params);
        break;
      default:
        return false;
    }

    send(JSON.stringify({ id: message.id, result: {} }));
    return true;
  };
}
