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

/** 轻量 Markdown 渲染：标题 / 列表 / 分隔线 / 段落 / 表格（按行文本呈现） */
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

  for (const raw of lines) {
    const line = raw.trimEnd();
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
      out.push(
        <p key={`tb${key++}`} className="md-table-line">
          {inline(line.trim(), `tb${key}`)}
        </p>,
      );
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
