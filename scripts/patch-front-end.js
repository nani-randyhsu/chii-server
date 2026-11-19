// OneBook 客製化：修補從 npm 套件 chii-prebuilt 複製來的 DevTools 前端
//
// DevTools 前端要用 Chromium 工具鏈才能從原始碼 build，所以直接改 build 好的檔案。
// 由 npm run build:front_end 在複製完之後執行，只能對剛複製好的檔案跑一次。
// 每一項修補都要剛好找到一處原本的程式碼，找不到就讓 build 失敗，
// 同步上游換版本、程式碼變了時才不會悄悄失效（處理方式見 README「同步上游」）。
const fs = require('fs');
const path = require('path');

const FRONT_END = path.join(__dirname, '..', 'chii', 'public', 'front_end');

const PATCHES = [
  {
    // Chii 在 Network 面板只留 Fetch/XHR 和 WS 兩個類型 filter，因為原本 chobitsu 只記錄得到這兩種請求。
    // target.js 已補上 JS、CSS、圖片等靜態資源（chii/src/target/resourceTiming.ts），恢復成跟 Chrome 一樣的完整 filter。
    // 原本的程式碼（變數名稱是壓縮過的，可能隨版本改變）：
    //   globalThis.chii&&(l=l.filter((e=>"Fetch/XHR"===e.label()||"WS"===e.label())))
    name: 'Network 面板恢復完整的資源類型 filter',
    file: 'panels/network/network.js',
    find: /globalThis\.chii&&\((\w+)=\1\.filter\(\(\(?(\w+)\)?=>"Fetch\/XHR"===\2\.label\(\)\|\|"WS"===\2\.label\(\)\)\)\)/g,
    replace: 'void 0',
  },
];

let failed = false;

PATCHES.forEach(patch => {
  const file = path.join(FRONT_END, patch.file);
  const content = fs.readFileSync(file, 'utf8');
  const count = (content.match(patch.find) || []).length;
  if (count !== 1) {
    console.error(`[patch-front-end] ✗ ${patch.name}：${patch.file} 預期找到 1 處，實際找到 ${count} 處`);
    failed = true;
    return;
  }
  fs.writeFileSync(file, content.replace(patch.find, patch.replace));
  console.log(`[patch-front-end] ✓ ${patch.name}`);
});

if (failed) process.exit(1);
