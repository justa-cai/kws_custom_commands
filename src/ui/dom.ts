/**
 * 极简 DOM 构造器。
 *
 * 这个项目的 UI 是"一堆表单 + 一个日志流"，上框架的收益远小于负担：
 * 没有列表重排的性能问题，没有跨组件的状态同步，只有"改一下 DOM"。
 * 所以原生 DOM + 一个 30 行的 el() 就够了。
 *
 * 注意：只有 `text` 没有 `html`——所有用户输入（词条文本、文件名、
 * 错误信息）都走 textContent，不给 XSS 留口子。
 */

export type Child = Node | string | number | null | undefined | false;

export interface ElAttrs {
  class?: string;
  text?: string | number;
  title?: string;
  id?: string;
  type?: string;
  value?: string | number;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  rows?: string | number;
  style?: Partial<CSSStyleDeclaration>;
  [key: string]: unknown;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElAttrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key in node && typeof value !== 'string') {
      // checked / disabled / value 这类反射属性
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child,
    );
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`找不到元素: ${selector}`);
  return found;
}

/** 表单行：左标签右控件 */
export function field(label: string, ...controls: Child[]): HTMLElement {
  return el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), ...controls);
}

export function button(label: string, onClick: () => void, attrs: ElAttrs = {}): HTMLButtonElement {
  return el('button', { ...attrs, type: 'button', text: label, onClick });
}

export function iconButton(label: string, title: string, onClick: () => void, attrs: ElAttrs = {}): HTMLButtonElement {
  return el('button', { ...attrs, type: 'button', class: 'icon-btn', text: label, title, onClick });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 造一个单 path 的图标。`fill` 用 `currentColor`，所以颜色跟着文字走，
 * hover 时不用额外写一条 CSS 规则。
 *
 * @param pathD 16×16 viewBox 下的 path 数据
 */
export function svgIcon(pathD: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathD);
  svg.appendChild(path);
  return svg;
}
