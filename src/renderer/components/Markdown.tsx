import type { ReactNode } from 'react';

/** 行内格式：**加粗** 与 `代码` */
function inline(text: string, keyBase: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={`${keyBase}-b${i}`}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={`${keyBase}-c${i}`}>{p.slice(1, -1)}</code>;
    return <span key={`${keyBase}-t${i}`}>{p}</span>;
  });
}

const SEP_CELL = /^:?-+:?$/;

/** 竖线行拆单元格；整行去除首尾竖线后按 | 分列 */
function cellsOf(row: string): string[] {
  return row
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** 轻量 Markdown 渲染：标题 / 列表 / 表格（含分隔行的竖线块）/ 分隔线 / 段落 */
export function Markdown({ src }: { src: string }) {
  const lines = src.split(/\r\n|\r|\n/);
  const out: ReactNode[] = [];
  let para: string[] = [];
  let key = 0;

  const flush = () => {
    if (para.length > 0) {
      out.push(<p key={`p${key++}`}>{inline(para.join(' '), `p${key}`)}</p>);
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      const Tag = (h[1].length === 1 ? 'h2' : h[1].length === 2 ? 'h3' : 'h4') as 'h2' | 'h3' | 'h4';
      out.push(<Tag key={`h${key++}`}>{inline(h[2]!, `h${key}`)}</Tag>);
      continue;
    }
    if (/^-{3,}$/.test(line.trim())) {
      flush();
      out.push(<hr key={`hr${key++}`} />);
      continue;
    }
    if (line.trim().startsWith('|')) {
      flush();
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        rows.push(lines[i]!.trim());
        i++;
      }
      i--;
      const cells = rows.map(cellsOf);
      if (cells.length >= 2 && cells[1]!.length > 0 && cells[1]!.every((c) => SEP_CELL.test(c))) {
        const [head, , ...body] = cells;
        out.push(
          <table key={`tb${key++}`}>
            <thead>
              <tr>{head!.map((c, ci) => <th key={ci}>{inline(c, `th${key}-${ci}`)}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri}>{row.map((c, ci) => <td key={ci}>{inline(c, `td${key}-${ri}-${ci}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>,
        );
      } else {
        // 不成表格的零散竖线行，维持按行内文本呈现
        for (const r of rows) {
          out.push(<p key={`tb${key++}`} className="md-table-line">{inline(r, `tb${key}`)}</p>);
        }
      }
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      flush();
      out.push(
        <li className="md-li" key={`li${key++}`}>
          {inline(ul[1]!, `li${key}`)}
        </li>,
      );
      continue;
    }
    const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
    if (ol) {
      flush();
      out.push(
        <li className="md-li md-ol" key={`ol${key++}`}>
          {inline(ol[1]!, `ol${key}`)}
        </li>,
      );
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return <div className="md">{out}</div>;
}
