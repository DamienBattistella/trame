import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Maximize, Minus, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Zoom maximal, en multiple de la taille réelle de l'image. */
const MAX_ZOOM = 8;
/** Une petite image ajustée à la fenêtre n'est pas agrandie au-delà (sinon elle n'est que floue). */
const MAX_FIT = 3;
const STEP = 1.25;
const MARGIN = 32;

type View = { scale: number; x: number; y: number };

/** Visionneuse plein écran d'une image reçue : ajustée à la fenêtre à l'ouverture (agrandie
 *  au besoin), zoom à la molette, au double-clic, aux boutons ou au clavier (+, −, 0, 1),
 *  déplacement en la faisant glisser. Échap ou un clic à côté la ferme. */
export function ImageViewer({
  src,
  alt,
  width,
  height,
  open,
  onOpenChange,
}: {
  src: string | null;
  alt: string;
  width: number;
  height: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: width, h: height });
  const [view, setView] = useState<View | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  useEffect(() => {
    setNatural({ w: width, h: height });
    setView(null);
  }, [src, width, height]);

  // Taille de la zone d'affichage, suivie quand la fenêtre change. Ref callback : le
  // portail du dialogue monte la zone après le rendu qui l'ouvre.
  const observer = useRef<ResizeObserver | null>(null);
  const stageRef = useCallback((el: HTMLDivElement | null) => {
    stage.current = el;
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, []);

  const ready = natural.w > 0 && natural.h > 0 && box.w > 0 && box.h > 0;
  const fit = ready ? Math.min((box.w - MARGIN * 2) / natural.w, (box.h - MARGIN * 2) / natural.h, MAX_FIT) : 1;
  const minZoom = Math.min(fit, 1);

  // Garde l'image dans la zone : centrée sur un axe où elle tient, bornée sinon.
  const clamp = useCallback(
    (v: View): View => {
      const scale = Math.min(MAX_ZOOM, Math.max(minZoom, v.scale));
      const axis = (size: number, room: number, d: number) => {
        const lim = (size * scale - room) / 2 + MARGIN;
        return lim <= 0 ? 0 : Math.min(lim, Math.max(-lim, d));
      };
      return { scale, x: axis(natural.w, box.w, v.x), y: axis(natural.h, box.h, v.y) };
    },
    [box, natural, minZoom]
  );

  const current: View = view ? clamp(view) : { scale: fit, x: 0, y: 0 };

  // Zoom en gardant fixe le point visé (par défaut le centre de la zone).
  const zoomTo = useCallback(
    (scale: number, at?: { x: number; y: number }) => {
      setView((v) => {
        const from = v ? clamp(v) : { scale: fit, x: 0, y: 0 };
        const next = Math.min(MAX_ZOOM, Math.max(minZoom, scale));
        const px = at ? at.x - box.w / 2 : 0;
        const py = at ? at.y - box.h / 2 : 0;
        const k = next / from.scale;
        return clamp({ scale: next, x: px - (px - from.x) * k, y: py - (py - from.y) * k });
      });
    },
    [box, clamp, fit, minZoom]
  );
  const point = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // La molette zoome (listener non passif pour bloquer le défilement de la page).
  useEffect(() => {
    const el = stage.current;
    if (!open || !el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      zoomTo(current.scale * factor, point(e));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") zoomTo(current.scale * STEP);
    else if (e.key === "-" || e.key === "_") zoomTo(current.scale / STEP);
    else if (e.key === "0") setView(null);
    else if (e.key === "1") zoomTo(1);
    else return;
    e.preventDefault();
  };

  const canPan = ready && (natural.w * current.scale > box.w - MARGIN * 2 || natural.h * current.scale > box.h - MARGIN * 2);
  const percent = Math.round(current.scale * 100);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col text-white outline-none"
          onKeyDown={onKeyDown}
          aria-describedby={undefined}
          data-testid="image-viewer"
        >
          <DialogPrimitive.Title className="sr-only">{alt}</DialogPrimitive.Title>
          <div
            ref={stageRef}
            className={cn("relative min-h-0 flex-1 touch-none overflow-hidden select-none", canPan ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in")}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              drag.current = { x: e.clientX, y: e.clientY, vx: current.x, vy: current.y, moved: false };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const dx = e.clientX - d.x;
              const dy = e.clientY - d.y;
              if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
              if (d.moved && canPan) setView(clamp({ scale: current.scale, x: d.vx + dx, y: d.vy + dy }));
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              drag.current = null;
              // Un clic simple à côté de l'image ferme la visionneuse ; sur l'image, rien.
              if (!d || d.moved) return;
              const p = point(e);
              const outX = Math.abs(p.x - box.w / 2 - current.x) > (natural.w * current.scale) / 2;
              const outY = Math.abs(p.y - box.h / 2 - current.y) > (natural.h * current.scale) / 2;
              if (outX || outY) onOpenChange(false);
            }}
            onDoubleClick={(e) => {
              const fitted = Math.abs(current.scale - fit) < 0.01;
              if (fitted) zoomTo(Math.max(fit * 2, 1), point(e));
              else setView(null);
            }}
          >
            {src && (
              <img
                src={src}
                alt={alt}
                draggable={false}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth && (img.naturalWidth !== natural.w || img.naturalHeight !== natural.h))
                    setNatural({ w: img.naturalWidth, h: img.naturalHeight });
                }}
                className="pointer-events-none absolute top-1/2 left-1/2 max-w-none rounded-sm shadow-2xl"
                style={{
                  width: natural.w || undefined,
                  height: natural.h || undefined,
                  transform: `translate(-50%, -50%) translate(${current.x}px, ${current.y}px) scale(${current.scale})`,
                  visibility: ready ? "visible" : "hidden",
                }}
              />
            )}
          </div>
          <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-end p-3">
            <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-black/60 p-1 shadow-lg ring-1 ring-white/10 backdrop-blur">
              <ToolButton label="Dézoomer (−)" onClick={() => zoomTo(current.scale / STEP)} disabled={current.scale <= minZoom + 0.001}>
                <Minus className="size-4" />
              </ToolButton>
              <button
                type="button"
                onClick={() => zoomTo(1)}
                title="Taille réelle (1)"
                className="min-w-14 rounded-full px-2 py-1 text-center text-xs tabular-nums hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:outline-none"
              >
                {percent} %
              </button>
              <ToolButton label="Zoomer (+)" onClick={() => zoomTo(current.scale * STEP)} disabled={current.scale >= MAX_ZOOM - 0.001}>
                <Plus className="size-4" />
              </ToolButton>
              <ToolButton label="Ajuster à la fenêtre (0)" onClick={() => setView(null)}>
                <Maximize className="size-4" />
              </ToolButton>
              <span className="mx-1 h-5 w-px bg-white/20" aria-hidden />
              <DialogPrimitive.Close asChild>
                <ToolButton label="Fermer (Échap)">
                  <X className="size-4" />
                </ToolButton>
              </DialogPrimitive.Close>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ToolButton({ label, children, ...props }: React.ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="inline-flex size-8 items-center justify-center rounded-full hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:outline-none disabled:opacity-40 disabled:hover:bg-transparent"
      {...props}
    >
      {children}
    </button>
  );
}
