import { useEffect, useState } from 'react';

export type ToastKind = 'err' | 'ok';
type Item = { id: number; msg: string; kind: ToastKind };

let seq = 1;
let push: ((t: Item) => void) | null = null;

/** 全局右上角弹窗提示（安装失败等异步结果） */
export function toast(msg: string, kind: ToastKind = 'err') {
  push?.({ id: seq++, msg, kind });
}

export function Toaster() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    push = (t) => {
      setItems((cur) => [...cur.slice(-4), t]);
      setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== t.id)), 5000);
    };
    return () => {
      push = null;
    };
  }, []);

  return (
    <div className="toaster">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast-item toast-${t.kind}`}
          onClick={() => setItems((cur) => cur.filter((x) => x.id !== t.id))}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}
