import { useEffect, useState } from 'react';

type Fly = { id: number; x: number; y: number; dx: number; dy: number };

let push: ((f: Omit<Fly, 'id'>) => void) | null = null;
let seq = 0;

/** 从触发点把“包”装进文件夹并抛物线丢进侧栏下载管理胶囊 */
export function flyToDownloads(origin: DOMRect): void {
  const pill = document.querySelector('.side-dl');
  if (!pill || !push) return;
  const t = pill.getBoundingClientRect();
  const x = origin.left + origin.width / 2;
  const y = origin.top + origin.height / 2;
  push({ x, y, dx: t.left + t.width / 2 - x, dy: t.top + t.height / 2 - y });
}

export function FlyLayer() {
  const [items, setItems] = useState<Fly[]>([]);

  useEffect(() => {
    push = (f) => {
      const id = ++seq;
      setItems((c) => [...c.slice(-3), { ...f, id }]);
      setTimeout(() => {
        const pill = document.querySelector('.side-dl');
        pill?.classList.add('pill-pulse');
        setTimeout(() => pill?.classList.remove('pill-pulse'), 340);
      }, 860);
      setTimeout(() => setItems((c) => c.filter((x) => x.id !== id)), 1000);
    };
    return () => {
      push = null;
    };
  }, []);

  return (
    <>
      {items.map((f) => (
        <div key={f.id} className="fly-x" style={{ left: f.x, top: f.y, ['--dx' as string]: `${f.dx}px` }}>
          <div className="fly-y" style={{ ['--dy' as string]: `${f.dy}px` }}>
            <div className="fly-icon">
              <svg className="fly-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.4h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17v-9.5Z" />
              </svg>
              <svg className="fly-box" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3 4.5 7v10L12 21l7.5-4V7L12 3Z" />
                <path d="M4.5 7 12 11l7.5-4" />
                <path d="M12 11v10" />
              </svg>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
