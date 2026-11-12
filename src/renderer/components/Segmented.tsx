import { useLayoutEffect, useRef, useState } from 'react';

/**
 * 自适应分段切换器：滑块通过测量按钮实际位置与宽度定位，
 * 文字长短不一时也能精确贴合居中
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  minWidth,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  minWidth?: number;
}) {
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pill, setPill] = useState({ left: 0, width: 0, ready: false });

  useLayoutEffect(() => {
    // findIndex 可能 -1（value 不在 options）：钳到 0，否则 pill 永不 ready
    const idx = Math.max(0, options.findIndex((o) => o.id === value));
    const el = btnRefs.current[idx];
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth, ready: true });
  }, [value, options]);

  const move = (key: string): void => {
    // tablist 惯例：方向键环绕移动并自动激活，焦点随选
    const cur = Math.max(0, options.findIndex((x) => x.id === value));
    let next = cur;
    if (key === 'ArrowLeft') next = (cur - 1 + options.length) % options.length;
    else if (key === 'ArrowRight') next = (cur + 1) % options.length;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = options.length - 1;
    else return;
    btnRefs.current[next]?.focus();
    onChange(options[next]!.id);
  };

  return (
    <div className="seg-track" role="tablist" style={minWidth ? { minWidth } : undefined}>
      <div
        className="seg-pill"
        style={{
          left: pill.left,
          width: pill.width,
          opacity: pill.ready ? 1 : 0,
        }}
      />
      {options.map((o, i) => (
        <button
          key={o.id}
          ref={(el) => {
            btnRefs.current[i] = el;
          }}
          className={`seg-btn${value === o.id ? ' on' : ''}`}
          tabIndex={value === o.id ? 0 : -1}
          onClick={() => onChange(o.id)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
              e.preventDefault();
              move(e.key);
            }
          }}
          role="tab"
          aria-selected={value === o.id}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
