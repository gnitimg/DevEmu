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
    const idx = options.findIndex((o) => o.id === value);
    const el = btnRefs.current[idx ?? 0];
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth, ready: true });
  }, [value, options]);

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
          onClick={() => onChange(o.id)}
          role="tab"
          aria-selected={value === o.id}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
