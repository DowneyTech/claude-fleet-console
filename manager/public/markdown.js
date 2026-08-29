'use strict';

/**
 * 最小の Markdown → DOM レンダラ。
 *
 * 方針:
 *  - innerHTML を一切使わず DOM を組み立てる。Claude の出力に HTML やスクリプトが
 *    混ざっていても、そのまま文字として表示されるだけで実行されない。
 *  - 外部ライブラリを足さない。manager は CDN に到達できない環境でも動く必要があり、
 *    ログ表示に必要な記法（見出し / コード / リスト / 表 / 強調 / リンク）は限られる。
 *
 * 意図的に対応しない記法:
 *  - `_italic_`（single underscore）。snake_case や __init__ を壊すため。`*italic*` は対応する。
 *  - 参照リンク、脚注、HTML ブロック。
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/;
const ORDERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;
const TABLE_ROW = /\|/;
const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

// インライン記法をまとめて左から走査する。順番が優先度になる（コード span が最優先）。
//
// パターンは source のまま持ち、使う直前に毎回 RegExp を作る。inline() は
// 強調の中身を解析するため再帰するので、g フラグ付きの正規表現を使い回すと
// 内側の走査が lastIndex を巻き戻し、外側が先頭から読み直して無限ループになる。
const INLINE_SOURCE = [
  '(`+)([\\s\\S]*?)\\1', // 1,2: code span
  // 強調は区切り記号の内側が空白でないことを要求する。そうしないと
  // `2 * 3 * 4` のような掛け算が斜体になってしまう。
  '\\*\\*(?![\\s*])([\\s\\S]+?)(?<![\\s*])\\*\\*', // 3: bold
  '~~([\\s\\S]+?)~~', // 4: strike
  '\\*(?![\\s*])([^*\\n]*?[^\\s*])\\*', // 5: italic
  '!?\\[([^\\]]*)\\]\\(([^)\\s]+)(?:[ \\t]+"[^"]*")?\\)', // 6,7: link
  '(https?://[^\\s<>()\\[\\]]+)', // 8: autolink
].join('|');

const indentOf = (text) => text.replace(/\t/g, '    ').match(/^ */)[0].length;
const isBlank = (line) => !line.trim();

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** http/https 以外はリンクにしない（javascript: や data: を弾く）。 */
function safeHref(raw) {
  try {
    const url = new URL(raw, window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** url が使えない場合は fallback（元の記法）をそのまま文字として出す。 */
function anchor(href, label, fallback) {
  const url = safeHref(href);
  if (!url) return document.createTextNode(fallback ?? label);
  const node = element('a');
  node.href = url;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  node.textContent = label;
  return node;
}

/** インライン記法を解析して、テキストノードと要素の並びを親へ流し込む。 */
function inline(text, parent) {
  const pattern = new RegExp(INLINE_SOURCE, 'g');
  let cursor = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    // 空マッチが起きても必ず前進させる（無限ループの保険）。
    if (match[0] === '') {
      pattern.lastIndex += 1;
      continue;
    }

    if (match.index > cursor) {
      parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    }
    cursor = match.index + match[0].length;

    if (match[2] !== undefined) {
      const code = element('code', 'md-inline-code');
      code.textContent = match[2].trim();
      parent.appendChild(code);
    } else if (match[3] !== undefined) {
      const strong = element('strong');
      inline(match[3], strong);
      parent.appendChild(strong);
    } else if (match[4] !== undefined) {
      const del = element('del');
      inline(match[4], del);
      parent.appendChild(del);
    } else if (match[5] !== undefined) {
      const em = element('em');
      inline(match[5], em);
      parent.appendChild(em);
    } else if (match[7] !== undefined) {
      parent.appendChild(anchor(match[7], match[6] || match[7], match[0]));
    } else if (match[8] !== undefined) {
      parent.appendChild(anchor(match[8], match[8], match[0]));
    }
  }

  if (cursor < text.length) {
    parent.appendChild(document.createTextNode(text.slice(cursor)));
  }
}

/** 段落内の改行は <br> にする（ログ表示では原文の折り返しを保ちたい）。 */
function inlineLines(lines, parent) {
  lines.forEach((line, index) => {
    if (index > 0) parent.appendChild(element('br'));
    inline(line, parent);
  });
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function alignmentsOf(sep) {
  return splitRow(sep).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return left ? 'left' : '';
  });
}

function blockStarts(line) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

/** 行がリスト項目なら、深さ・種類・本文に分解する。 */
function itemAt(line) {
  const bullet = line.match(BULLET);
  if (bullet) return { indent: indentOf(bullet[1]), ordered: false, text: bullet[3] };
  const numbered = line.match(ORDERED);
  if (numbered) return { indent: indentOf(numbered[1]), ordered: true, text: numbered[3] };
  return null;
}

/**
 * リスト項目を集める。インデントで入れ子を組み立て、より深い継続行は
 * 直前の項目の本文として扱う。
 *
 * 同じ深さで種類（箇条書き / 番号）が変わったらそこでリストを切る。
 * これをしないと「箇条書きの直後に番号リスト」が 1 つの ul に潰れる。
 */
function collectList(lines, start) {
  const first = itemAt(lines[start]);
  const baseIndent = first.indent;
  const ordered = first.ordered;

  const items = []; // { indent, ordered, lines }
  let i = start;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      // 空行を挟んでも、深いか、同じ深さで同じ種類なら同一リストとして続ける。
      const next = i + 1 < lines.length ? itemAt(lines[i + 1]) : null;
      if (next && next.indent >= baseIndent && (next.indent > baseIndent || next.ordered === ordered)) {
        i += 1;
        continue;
      }
      break;
    }

    const item = itemAt(line);
    if (item && item.indent >= baseIndent) {
      if (item.indent === baseIndent && item.ordered !== ordered) break;
      items.push({ indent: item.indent, ordered: item.ordered, lines: [item.text] });
      i += 1;
      continue;
    }

    // 継続行。項目より深く字下げされている場合のみ取り込む。
    if (items.length > 0 && indentOf(line) > baseIndent && !blockStarts(line.trimStart())) {
      items[items.length - 1].lines.push(line.trim());
      i += 1;
      continue;
    }

    break;
  }

  return { items, end: i };
}

function buildList(items) {
  const level = items[0].indent;
  const list = element(items[0].ordered ? 'ol' : 'ul', 'md-list');

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.indent > level) continue; // 入れ子側で処理済み

    const li = element('li');
    inlineLines(item.lines, li);

    // 直後に続くより深い項目をまとめて子リストにする。
    const nested = [];
    let j = i + 1;
    while (j < items.length && items[j].indent > item.indent) {
      nested.push(items[j]);
      j += 1;
    }
    if (nested.length > 0) {
      li.appendChild(buildList(nested));
      i = j - 1;
    }

    list.appendChild(li);
  }

  return list;
}

function parseBlocks(lines) {
  const frag = document.createDocumentFragment();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1][0];
      const minLength = fence[1].length;
      const buffer = [];
      i += 1;
      while (i < lines.length) {
        const closing = lines[i].match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
        if (closing && closing[1][0] === marker && closing[1].length >= minLength) break;
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1; // 閉じフェンス（無ければ範囲外で止まるだけ）

      const pre = element('pre', 'md-code');
      const code = element('code');
      if (fence[2]) {
        pre.dataset.lang = fence[2];
        code.className = `language-${fence[2]}`;
      }
      code.textContent = buffer.join('\n');
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    if (HR.test(line)) {
      frag.appendChild(element('hr', 'md-hr'));
      i += 1;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const node = element(`h${heading[1].length}`, 'md-h');
      inline(heading[2], node);
      frag.appendChild(node);
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push(lines[i].match(QUOTE)[1]);
        i += 1;
      }
      const quote = element('blockquote', 'md-quote');
      quote.appendChild(parseBlocks(inner));
      frag.appendChild(quote);
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const { items, end } = collectList(lines, i);
      if (items.length > 0) frag.appendChild(buildList(items));
      i = Math.max(end, i + 1); // 保険。end が進まないと無限ループになる。
      continue;
    }

    // 表: ヘッダ行の次が区切り行になっているときだけ表として扱う。
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const headers = splitRow(line);
      const aligns = alignmentsOf(lines[i + 1]);
      i += 2;

      const table = element('table', 'md-table');
      const thead = element('thead');
      const headRow = element('tr');
      headers.forEach((text, index) => {
        const th = element('th');
        if (aligns[index]) th.style.textAlign = aligns[index];
        inline(text, th);
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = element('tbody');
      while (i < lines.length && !isBlank(lines[i]) && TABLE_ROW.test(lines[i])) {
        const row = element('tr');
        splitRow(lines[i]).forEach((text, index) => {
          const td = element('td');
          if (aligns[index]) td.style.textAlign = aligns[index];
          inline(text, td);
          row.appendChild(td);
        });
        tbody.appendChild(row);
        i += 1;
      }
      table.appendChild(tbody);

      // 横に長い表でページ全体が横スクロールしないよう、表だけを包む。
      const wrap = element('div', 'md-table-wrap');
      wrap.appendChild(table);
      frag.appendChild(wrap);
      continue;
    }

    // 段落。空行か次のブロック開始まで。
    const paragraph = [];
    while (i < lines.length && !isBlank(lines[i]) && !blockStarts(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    if (paragraph.length > 0) {
      const p = element('p', 'md-p');
      inlineLines(paragraph, p);
      frag.appendChild(p);
      continue;
    }

    // どの分岐にも入らなかった場合の保険。無限ループを避ける。
    i += 1;
  }

  return frag;
}

/** Markdown 文字列を DocumentFragment に変換する。 */
export function renderMarkdown(text) {
  if (typeof text !== 'string' || !text.trim()) return document.createDocumentFragment();
  return parseBlocks(text.replace(/\r\n?/g, '\n').split('\n'));
}

/** `.md` クラス付きの入れ物に入れて返す（スタイルの適用範囲を限定するため）。 */
export function markdownBlock(text, className = 'md') {
  const wrap = element('div', className);
  wrap.appendChild(renderMarkdown(text));
  return wrap;
}
