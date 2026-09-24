import { V2 } from "./theme";

// A small Markdown renderer for walkthroughs.
//
// Guides use a modest slice of Markdown — headings, lists, tables, code blocks
// for ASCII maps, emphasis, links — so this covers that slice rather than
// pulling a full CommonMark library into both builds. It builds React elements
// and never injects HTML: raw HTML in a guide shows as the text it is, so a
// file from the server cannot run anything.
//
// Headings carry data-sec like the text reader's, so the section list and
// left/right navigation work unchanged. Links to "#anchor" jump to the heading
// with that GitHub-style slug (how guides link their own table of contents);
// other links are shown but not followed, since the reader is not a browser.

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'code'; text: string }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: { blocks: Block[]; checked?: boolean }[] }
  | { t: 'table'; head: string[]; align: ('left' | 'center' | 'right' | undefined)[]; rows: string[][] }
  | { t: 'hr' };

const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const ATX = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(```+|~~~+)/;
const BULLET = /^( {0,3})([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  const blank = (l?: string) => l == null || !l.trim();
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    let m: RegExpExecArray | null;
    if ((m = FENCE.exec(line))) {
      const close = m[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++;
      out.push({ t: 'code', text: body.join('\n') });
      continue;
    }
    if ((m = ATX.exec(line))) { out.push({ t: 'h', level: m[1].length, text: m[2] }); i++; continue; }
    if (HR.test(line)) { out.push({ t: 'hr' }); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !blank(lines[i]) ) body.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      out.push({ t: 'quote', blocks: parseBlocks(body) });
      continue;
    }
    if (/^( {4}|\t)/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || blank(lines[i]))) body.push(lines[i++].replace(/^( {4}|\t)/, ''));
      while (body.length && blank(body[body.length - 1])) body.pop();
      out.push({ t: 'code', text: body.join('\n') });
      continue;
    }
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] || '') && lines[i + 1].includes('-')) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' as const : c.endsWith(':') ? 'right' as const : c.startsWith(':') ? 'left' as const : undefined);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) rows.push(cells(lines[i++]));
      out.push({ t: 'table', head, align, rows });
      continue;
    }
    if ((m = BULLET.exec(line))) {
      const ordered = /\d/.test(m[2]);
      const indent = m[1].length;
      const items: { blocks: Block[]; checked?: boolean }[] = [];
      while (i < lines.length) {
        const im = BULLET.exec(lines[i]);
        if (!im || im[1].length !== indent || /\d/.test(im[2]) !== ordered) break;
        const content = indent + im[2].length + 1;
        const body = [im[3]];
        i++;
        // The item's continuation: indented lines (nested lists, wrapped text)
        // and lazy paragraph lines, up to the next sibling marker.
        while (i < lines.length) {
          const l = lines[i];
          if (blank(l)) {
            if (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && lines[i + 1].search(/\S/) >= content) { body.push(''); i++; continue; }
            break;
          }
          const sib = BULLET.exec(l);
          if (sib && sib[1].length <= indent) break;
          if (!sib && l.search(/\S/) < content && (ATX.test(l) || HR.test(l) || FENCE.test(l))) break;
          body.push(l.search(/\S/) >= content ? l.slice(content) : l.trim());
          i++;
        }
        let checked: boolean | undefined;
        const task = /^\[([ xX])\]\s+/.exec(body[0]);
        if (task) { checked = task[1] !== ' '; body[0] = body[0].slice(task[0].length); }
        items.push({ blocks: parseBlocks(body), checked });
        while (i < lines.length && blank(lines[i]) && BULLET.exec(lines[i + 1] || '')?.[1].length === indent) i++;
      }
      out.push({ t: 'list', ordered, start: ordered ? parseInt(m[2], 10) : 1, items });
      continue;
    }
    // Paragraph, which a setext underline turns into a heading.
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i])) {
      const l = lines[i];
      if (para.length && (ATX.test(l) || FENCE.test(l) || /^ {0,3}>/.test(l) || BULLET.test(l))) break;
      if (para.length && /^ {0,3}(=+|-+)\s*$/.test(l)) {
        out.push({ t: 'h', level: l.trim()[0] === '=' ? 1 : 2, text: para.join(' ') });
        para.length = 0;
        i++;
        break;
      }
      if (!para.length && HR.test(l)) break;
      para.push(l);
      i++;
    }
    if (para.length) out.push({ t: 'p', text: para.join('\n') });
  }
  return out;
}

// GitHub's heading anchor: lowercase, punctuation dropped, spaces to dashes.
export function slug(text: string): string {
  return plain(text).toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

// A heading's text with its inline markup stripped, for the section list.
export function plain(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|\*|_|`)/g, '');
}

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(([^)\s]*)[^)]*\)|\[([^\]]+)\]\(([^)\s]*)[^)]*\)|<(https?:\/\/[^>\s]+)>|(\*\*|__)(?=\S)([\s\S]*?\S)\8|(\*|_)(?=\S)([\s\S]*?\S)\10(?![\p{L}\p{N}])|~~(?=\S)([\s\S]*?\S)~~|\\([\\`*_{}\[\]()#+\-.!|~>])|( {2,}|\\)\n/u;

type Ctx = { onAnchor: (slug: string) => void };

function inline(text: string, ctx: Ctx, key = 'i'): any[] {
  const out: any[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.push(rest); break; }
    if (m.index) out.push(rest.slice(0, m.index));
    const k = `${key}.${n++}`;
    if (m[1]) out.push(<code key={k} style={codeInline}>{m[2].replace(/^ (.*) $/, '$1')}</code>);
    else if (m[4] !== undefined && m[0].startsWith('!')) out.push(<span key={k} style={{ color: V2.fgMuted, fontStyle: 'italic' }}>[{m[3] || 'image'}]</span>);
    else if (m[5] !== undefined) {
      const href = m[6];
      const anchor = href.startsWith('#') ? decodeURIComponent(href.slice(1)) : null;
      out.push(
        <span key={k} title={anchor ? undefined : href}
          onClick={anchor ? (e) => { e.stopPropagation(); ctx.onAnchor(anchor); } : undefined}
          style={{
            color: V2.brandHover, cursor: anchor ? 'pointer' : 'default',
            textDecoration: anchor ? 'underline' : 'none', textDecorationColor: 'rgba(161,143,255,0.4)', textUnderlineOffset: '3px',
          }}>{inline(m[5], ctx, k)}</span>);
    }
    else if (m[7]) out.push(<span key={k} style={{ color: V2.brandHover }}>{m[7]}</span>);
    else if (m[8]) out.push(<strong key={k} style={{ color: V2.fg, fontWeight: 700 }}>{inline(m[9], ctx, k)}</strong>);
    else if (m[10]) out.push(<em key={k}>{inline(m[11], ctx, k)}</em>);
    else if (m[12] !== undefined) out.push(<s key={k} style={{ color: V2.fgMuted }}>{inline(m[12], ctx, k)}</s>);
    else if (m[13]) out.push(m[13]);
    else out.push(<br key={k} />);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const codeInline = {
  fontFamily: 'ui-monospace, "DejaVu Sans Mono", monospace', fontSize: '0.88em',
  background: 'rgba(255,255,255,0.08)', border: `1px solid ${V2.border}`,
  borderRadius: V2.radiusSm, padding: '0.1em 0.35em',
};

export function renderMarkdown(src: string, onAnchor: (sec: number) => void): { node: any; sections: string[] } {
  const blocks = parseBlocks(src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
  const sections: string[] = [];
  const slugs = new Map<string, number>();
  const ctx: Ctx = { onAnchor: (s) => { const i = slugs.get(s.toLowerCase()); if (i != null) onAnchor(i); } };

  // Number the headings first so a table of contents at the top can link to
  // headings further down.
  const seen = new Map<string, number>();
  const number = (bs: Block[]) => bs.forEach((b) => {
    if (b.t === 'h') {
      const base = slug(b.text);
      const c = seen.get(base) || 0;
      seen.set(base, c + 1);
      slugs.set(c ? `${base}-${c}` : base, sections.length);
      sections.push(plain(b.text).trim());
    }
  });
  number(blocks);

  let sec = 0;
  const render = (bs: Block[], key: string, top: boolean): any[] => bs.map((b, idx) => {
    const k = `${key}.${idx}`;
    switch (b.t) {
      case 'h': {
        const s = top ? sec++ : undefined;
        return (
          <div key={k} data-sec={s} style={{
            fontWeight: 700, color: V2.fg, letterSpacing: '-0.01em', lineHeight: 1.3,
            fontSize: `${[1.6, 1.35, 1.15, 1.05, 1, 0.95][b.level - 1]}em`,
            margin: `${b.level <= 2 ? 1.6 : 1.2}em 0 0.55em`,
            paddingLeft: b.level <= 2 ? '0.6em' : 0,
            borderLeft: b.level <= 2 ? `3px solid ${V2.brand}` : 'none',
          }}>{inline(b.text, ctx, k)}</div>
        );
      }
      case 'p': return <p key={k} style={{ margin: '0 0 0.9em' }}>{inline(b.text, ctx, k)}</p>;
      case 'hr': return <div key={k} style={{ height: '1px', background: V2.borderStrong, margin: '1.6em 0' }} />;
      case 'code': return (
        <pre key={k} style={{
          margin: '0 0 1em', padding: '0.8em 1em', overflowX: 'auto',
          fontFamily: 'ui-monospace, "DejaVu Sans Mono", monospace', fontSize: '0.88em', lineHeight: 1.45,
          background: 'rgba(255,255,255,0.045)', border: `1px solid ${V2.border}`, borderRadius: V2.radiusMd,
          color: V2.fg2,
        }}>{b.text}</pre>
      );
      case 'quote': return (
        <div key={k} style={{
          margin: '0 0 1em', padding: '0.7em 1em 0.1em', borderRadius: V2.radiusMd,
          background: 'rgba(139,116,232,0.10)', borderLeft: `3px solid ${V2.brand}`,
        }}>{render(b.blocks, k, false)}</div>
      );
      case 'list': {
        const Tag: any = b.ordered ? 'ol' : 'ul';
        return (
          <Tag key={k} start={b.ordered && b.start !== 1 ? b.start : undefined}
            style={{ margin: '0 0 0.9em', paddingLeft: '1.6em' }}>
            {b.items.map((it, j) => (
              <li key={j} style={{
                margin: '0.2em 0', listStyle: it.checked !== undefined ? 'none' : undefined,
                marginLeft: it.checked !== undefined ? '-1.3em' : undefined,
              }}>
                {it.checked !== undefined && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: '0.95em', height: '0.95em', marginRight: '0.45em', verticalAlign: '-0.12em',
                    borderRadius: '3px', fontSize: '0.75em', fontWeight: 700,
                    border: `1px solid ${it.checked ? V2.brand : V2.borderStrong}`,
                    background: it.checked ? V2.brand : 'transparent', color: '#fff',
                  }}>{it.checked ? '✓' : ''}</span>
                )}
                {/* A one-paragraph item renders inline, without paragraph spacing. */}
                {/* The item's first paragraph sits on the marker's line, without
                    paragraph spacing; anything after it (a nested list) follows. */}
                {it.blocks[0]?.t === 'p' && inline(it.blocks[0].text, ctx, `${k}.${j}`)}
                {render(it.blocks[0]?.t === 'p' ? it.blocks.slice(1) : it.blocks, `${k}.${j}`, false)}
              </li>
            ))}
          </Tag>
        );
      }
      case 'table': return (
        <div key={k} style={{ overflowX: 'auto', margin: '0 0 1.1em' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: '0.94em', border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusMd, overflow: 'hidden' }}>
            <thead>
              <tr>{b.head.map((c, j) => (
                <th key={j} style={{
                  textAlign: b.align[j] || 'left', padding: '0.5em 0.9em', color: V2.fg, fontWeight: 700,
                  background: 'rgba(255,255,255,0.06)', borderBottom: `1px solid ${V2.borderStrong}`,
                }}>{inline(c, ctx, `${k}.h${j}`)}</th>
              ))}</tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri} style={{ background: ri % 2 ? 'rgba(255,255,255,0.025)' : 'transparent' }}>
                  {b.head.map((_, j) => (
                    <td key={j} style={{
                      textAlign: b.align[j] || 'left', padding: '0.45em 0.9em', verticalAlign: 'top',
                      borderTop: ri ? `1px solid ${V2.border}` : 'none',
                    }}>{inline(r[j] ?? '', ctx, `${k}.${ri}.${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  });

  return { node: render(blocks, 'b', true), sections };
}
