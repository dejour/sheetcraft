import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function EditorMenu({ label, trigger, children, className = "", heading }: {
  label: string; trigger: ReactNode; children: ReactNode; className?: string; heading: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !panel.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const menu = panel.current.getBoundingClientRect();
    setPosition({
      left: Math.max(12, Math.min(rect.right - menu.width, window.innerWidth - menu.width - 12)),
      top: rect.bottom + menu.height + 8 < window.innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - menu.height - 8)
    });
    panel.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => { document.removeEventListener("pointerdown", dismiss); window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [open]);
  return <>
    <button ref={anchor} className={`editor-menu-trigger ${className}`} aria-label={label} aria-expanded={open} onClick={() => setOpen(value => !value)}>{trigger}</button>
    {open && createPortal(<div ref={panel} className="editor-menu-popover" role="group" aria-label={label} style={position}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); setOpen(false); anchor.current?.focus(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        }
      }} onClick={event => { if ((event.target as HTMLElement).closest("button:not(:disabled)")) { setOpen(false); anchor.current?.focus(); } }}>
      <div className="editor-menu-heading">{heading}</div>{children}
    </div>, document.body)}
  </>;
}
