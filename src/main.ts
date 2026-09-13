/**
 * 入口。
 *
 * 这里只做三件事：挂上 App、装一个兜底错误提示、处理环境不支持的提示。
 * 页面上所有的状态都在 App 里，main 不持有任何东西。
 */

import './ui/styles.css';
import { App } from './ui/App';

const root = document.getElementById('app');
if (!root) {
  throw new Error('页面结构不对：找不到 #app');
}

const app = new App(root);

// 这类页面最常见的翻车方式是"点了没反应"而用户看不到报错，
// 所以任何未捕获的异常都直接贴到页面上，别只留给 console。
const banner = document.createElement('div');
banner.className = 'notice error';
banner.style.display = 'none';
root.prepend(banner);

function showFatal(message: string): void {
  banner.textContent = message;
  banner.style.display = '';
}

window.addEventListener('error', (ev) => {
  if (ev.message?.includes('ResizeObserver')) return; // 无关紧要的浏览器噪音
  showFatal(`出错了：${ev.message}`);
});

window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev.reason as Error | undefined;
  showFatal(`出错了：${reason?.message ?? String(ev.reason)}`);
});

if (!('audioWorklet' in AudioContext.prototype)) {
  showFatal(
    '这个浏览器不支持 AudioWorklet，采集不了麦克风。请用较新的 Chrome / Edge / Firefox / Safari。',
  );
}

window.addEventListener('beforeunload', () => app.dispose());
