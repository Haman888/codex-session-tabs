'use strict';

async function inspectTabIcons(port, output) {
  if (!output || typeof output.write !== 'function') throw new Error('Private integration output is required.');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(item => item.type === 'page' && /workbench/.test(item.url));
  if (!target) throw new Error('Test workbench debugger target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let next = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    const result = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: `(async () => {
      const tabs = [...document.querySelectorAll('.tabs-container .tab')].map(tab => {
        const images = new Set();
        for (const element of [tab, ...tab.querySelectorAll('*')]) for (const pseudo of [null, '::before', '::after']) {
          const style = getComputedStyle(element, pseudo);
          for (const value of [style.backgroundImage, style.maskImage]) {
            for (const match of value.matchAll(/url\\(["']?([^"')]+)["']?\\)/g)) images.add(match[1]);
          }
        }
        return { label: tab.getAttribute('aria-label'), text: tab.innerText, images: [...images] };
      });
      const assets = [];
      for (const url of new Set(tabs.flatMap(tab => tab.images))) {
        const loaded = await new Promise(resolve => {
          const image = new Image(); const timer = setTimeout(() => resolve(false), 2000);
          image.onload = () => { clearTimeout(timer); resolve(image.naturalWidth > 0); };
          image.onerror = () => { clearTimeout(timer); resolve(false); };
          image.src = url;
        });
        assets.push({ url, loaded });
      }
      return { tabs, assets, width: innerWidth };
    })()` });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    const info = result.result.value;
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: Math.min(info.width, 1400), height: 100, scale: 1 } });
    output.write('tab-icons.png', Buffer.from(shot.data, 'base64'));
    output.write('tab-icons.json', JSON.stringify(info, null, 2));
    return info;
  } finally { socket.close(); }
}

module.exports = { inspectTabIcons };
