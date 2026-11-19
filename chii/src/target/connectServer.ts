import Socket from 'licia/Socket';
import query from 'licia/query';
import chobitsu from 'chobitsu';
import { serverUrl, id } from './config';
import { getFavicon } from './util';
import createNativeScreencast from './nativeScreencast';
import createTouchInput from './touchInput';
import createResourceTiming from './resourceTiming';

let isInit = false;

export default function () {
  const proxy = `${serverUrl}proxy`;
  chobitsu.domain('Page').setProxy({
    proxy,
  });
  chobitsu.domain('Debugger').setProxy({
    proxy,
  });
  chobitsu.domain('CSS').setProxy({
    proxy,
  });

  const ws = new Socket(
    `${serverUrl.replace(/^http/, 'ws')}target/${id}?${query.stringify({
      url: location.href,
      title: (window as any).ChiiTitle || document.title,
      favicon: getFavicon(),
      '__chobitsu-hide__': true,
    })}`
  );

  // OneBook 客製化：有 App 截圖 bridge 時，畫面預覽改用原生截圖（見 nativeScreencast.ts）
  const handleNativeScreencast = createNativeScreencast(message => ws.send(message));
  // OneBook 客製化：預覽上的滑鼠操作改模擬成手指觸控，才能拖曳（見 touchInput.ts）
  const handleTouchInput = createTouchInput(message => ws.send(message));
  // OneBook 客製化：Network 面板補上 JS、CSS、圖片等靜態資源（見 resourceTiming.ts）
  const handleResourceTiming = createResourceTiming(message => ws.send(message));

  ws.on('open', () => {
    isInit = true;
    ws.on('message', event => {
      if (handleNativeScreencast(event.data)) return;
      if (handleTouchInput(event.data)) return;
      handleResourceTiming(event.data);
      chobitsu.sendRawMessage(event.data);
    });
  });

  chobitsu.setOnMessage((message: string) => {
    if (!isInit) return;
    ws.send(message);
  });
}
