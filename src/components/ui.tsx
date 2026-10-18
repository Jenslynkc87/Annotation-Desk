import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(onClose);
  // Dialogs with a footer hold something being entered (pasted text, choices): a stray click beside them doesn't discard it.
  return (
    <div className="overlay" onMouseDown={(e) => !footer && e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn ghost small close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * A number box you can type in freely (clear it, then type 3): the limits are applied when you leave it.
 * A box that corrects every keystroke turns a typed 3 into 10 or 8000 into 16000.
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  integer = true,
  ...rest
}: { value: number; onChange: (n: number) => void; min?: number; max?: number; integer?: boolean } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type' | 'min' | 'max'
>) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, integer ? Math.round(n) : n));
  const isNumber = (t: string) => t.trim() !== '' && Number.isFinite(Number(t));
  return (
    <input
      {...rest}
      type="number"
      min={min}
      max={max}
      value={draft ?? String(value)}
      onChange={(e) => {
        const t = e.target.value;
        setDraft(t);
        if (isNumber(t) && clamp(Number(t)) === Number(t)) onChange(Number(t));
      }}
      onBlur={(e) => {
        if (draft !== null && isNumber(draft)) onChange(clamp(Number(draft)));
        setDraft(null);
        rest.onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        rest.onKeyDown?.(e);
      }}
    />
  );
}

export function Drawer({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEscape(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <h3>{title}</h3>
          <div className="row" style={{ marginLeft: 'auto' }}>
            {actions}
            <button className="btn ghost small" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

export function useEscape(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && ref.current();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
}

export function Menu({ button, children, align = 'right' }: { button: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      {button(() => setOpen((o) => !o))}
      {open && <div className={`menu-pop ${align === 'left' ? 'left' : ''}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function Icon({ name, size = 16 }: { name: 'upload' | 'play' | 'download' | 'key' | 'check' | 'refresh' | 'plus' | 'trash' | 'flask' | 'stop' | 'chevron' | 'calculator'; size?: number }) {
  const p = {
    upload: 'M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
    play: 'M7 5v14l11-7z',
    download: 'M12 4v12m0 0-4.5-4.5M12 16l4.5-4.5M4 17v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1',
    key: 'M15 7a4 4 0 1 1-3.9 5H9v2H7v2H4v-3l6.1-6.1A4 4 0 0 1 15 7zm1 1.5h.01',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
    plus: 'M12 5v14M5 12h14',
    trash: 'M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12',
    flask: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3',
    stop: 'M7 7h10v10H7z',
    chevron: 'm6 9 6 6 6-6',
    calculator: 'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 7h8v3H8zM8.5 14h.01M12 14h.01M15.5 14h.01M8.5 17.5h.01M12 17.5h.01M15.5 17.5h.01',
  }[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={p} />
    </svg>
  );
}

export function Help({ children }: { children: ReactNode }) {
  return <div className="hint">{children}</div>;
}
