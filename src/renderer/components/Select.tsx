import { useEffect, useRef, useState } from 'react';

export type SelectOption<T extends string> = { value: T; label: string; hint?: string };


/** 自绘下拉：与应用风格一致（原生 select 的弹出列表无法定制） */
export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder,
  disabled,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function openPop() {
    if (disabled) return;
    const r = btnRef.current!.getBoundingClientRect();
    const popH = Math.min(264, options.length * 31 + 10);
    const up = r.bottom + popH > window.innerHeight - 8 && r.top - popH > 8;
    setPos({ left: r.left, top: up ? r.top - popH - 5 : r.bottom + 5, width: r.width });
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }

  function pick(v: T) {
    setOpen(false);
    onChange(v);
  }

  function onKey(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        openPop();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = options[active];
      if (o) pick(o.value);
    }
  }

  return (
    <div className="sel" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className={`sel-btn${open ? ' open' : ''}`}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPop())}
        onKeyDown={onKey}
      >
        <span className={selected ? '' : 'sel-ph'}>{selected ? selected.label : (placeholder ?? '请选择')}</span>
        <svg className="sel-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 6l4.5 4.5L12.5 6" />
        </svg>
      </button>
      {open && pos && (
        <div className="sel-pop" style={{ left: pos.left, top: pos.top, width: pos.width }} ref={listRef}>
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              data-idx={i}
              className={`sel-item${o.value === value ? ' on' : ''}${i === active ? ' hover' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o.value)}
            >
              <span className="sel-label">{o.label}</span>
              {o.hint && <span className="sel-hint">{o.hint}</span>}
              {o.value === value && (
                <svg className="sel-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 8.5 6.5 12 13 4.5" />
                </svg>
              )}
            </button>
          ))}
          {options.length === 0 && <div className="sel-empty">无选项</div>}
        </div>
      )}
    </div>
  );
}
