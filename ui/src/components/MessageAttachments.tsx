import { useRef, useState } from "react";
import { Download, ExternalLink, FileText, Film, ImageIcon, LoaderCircle, Play } from "lucide-react";
import { toast } from "sonner";
import { ImageViewer } from "@/components/ImageViewer";
import { openExternal } from "@/desktop";
import { cn } from "@/lib/utils";
import type { Result } from "@/api";
import type { FileLink, ReceivedFile, ReceivedImage } from "@/types";

type LinkFile = (url: string) => Promise<Result<{ link: FileLink }>>;

/** Pièces jointes reçues dans un message : images (aperçu, agrandi au clic), vidéos (lues
 *  ici, ou téléchargées) et fichiers (ouverts dans le navigateur par leur lien
 *  SharePoint/OneDrive, sinon dans Teams). */
export function MessageAttachments({
  files = [],
  images = [],
  sender,
  onOpenTeams,
  onFileLink,
}: {
  files?: ReceivedFile[];
  images?: ReceivedImage[];
  sender: string;
  onOpenTeams: () => void;
  /** Résout le lien de partage d'un fichier en téléchargement direct (vidéos). */
  onFileLink?: LinkFile;
}) {
  const [zoom, setZoom] = useState<ReceivedImage | null>(null);
  if (!files.length && !images.length) return null;
  return (
    <div className="flex flex-col gap-1.5 whitespace-normal">
      {images.map((img, i) =>
        img.data ? (
          <button
            key={i}
            type="button"
            className="block w-fit max-w-full overflow-hidden rounded-lg border bg-background/40"
            title="Agrandir l'image"
            onClick={() => setZoom(img)}
          >
            <img
              src={img.data}
              alt={`Image envoyée par ${sender}`}
              width={img.width || undefined}
              height={img.height || undefined}
              className="max-h-64 w-auto max-w-full object-contain"
            />
          </button>
        ) : (
          <AttachmentChip key={i} icon={<ImageIcon className="size-4" />} label="Image" hint="Voir dans Teams" onClick={onOpenTeams} />
        )
      )}
      {files.map((f, i) =>
        f.kind === "video" && f.url && onFileLink ? (
          <VideoAttachment key={`${f.name}-${i}`} file={f} sender={sender} onFileLink={onFileLink} />
        ) : (
          <AttachmentChip
            key={`${f.name}-${i}`}
            icon={<FileText className="size-4" />}
            label={f.name}
            hint={f.url ? "Ouvrir dans le navigateur" : "Ouvrir dans Teams"}
            onClick={() => (f.url ? openExternal(f.url) : onOpenTeams())}
          />
        )
      )}
      <ImageViewer
        open={zoom !== null}
        onOpenChange={(open) => !open && setZoom(null)}
        src={zoom?.data ?? null}
        width={zoom?.width ?? 0}
        height={zoom?.height ?? 0}
        alt={`Image envoyée par ${sender}`}
      />
    </div>
  );
}

function AttachmentChip({ icon, label, hint, onClick }: { icon: React.ReactNode; label: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={cn(
        "flex max-w-full items-center gap-2 rounded-lg border bg-background/60 px-2.5 py-1.5 text-left text-sm",
        "hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      )}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
      <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-label={hint} />
    </button>
  );
}

// SharePoint signe le téléchargement pour environ une heure : au-delà, on le redemande.
const LINK_TTL_MS = 50 * 60 * 1000;

/** Vidéo reçue : lue dans Trame (lecteur intégré) ou téléchargée directement, sans passer
 *  par la page SharePoint. Le lien de partage est résolu à la demande, jamais d'office. */
function VideoAttachment({ file, sender, onFileLink }: { file: ReceivedFile; sender: string; onFileLink: LinkFile }) {
  const cached = useRef<{ link: FileLink; at: number } | null>(null);
  const [busy, setBusy] = useState<"play" | "download" | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (): Promise<FileLink | null> => {
    if (cached.current && Date.now() - cached.current.at < LINK_TTL_MS) return cached.current.link;
    const res = await onFileLink(file.url);
    if (!res.ok) {
      setError(res.error);
      return null;
    }
    cached.current = { link: res.link, at: Date.now() };
    return res.link;
  };
  const play = async () => {
    setBusy("play");
    setError(null);
    const link = await resolve();
    setBusy(null);
    if (link) setSrc(link.url);
  };
  const download = async () => {
    setBusy("download");
    setError(null);
    const link = await resolve();
    setBusy(null);
    if (!link) return;
    // L'adresse signée sert le fichier en pièce jointe : le navigateur l'enregistre tout de suite.
    await openExternal(link.url);
    toast.success("Téléchargement lancé", { description: `${file.name} s'enregistre dans le dossier Téléchargements de ton navigateur.` });
  };

  return (
    <div className="flex max-w-full flex-col gap-1.5 rounded-lg border bg-background/60 p-2 text-sm" data-testid="video-attachment">
      {src ? (
        <video
          src={src}
          controls
          autoPlay
          preload="metadata"
          aria-label={`Vidéo ${file.name} envoyée par ${sender}`}
          className="max-h-80 w-full max-w-xl rounded-md bg-black"
          onError={() => {
            setSrc(null);
            cached.current = null;
            setError("Lecture impossible ici : télécharge la vidéo ou ouvre-la dans le navigateur.");
          }}
        />
      ) : (
        <button
          type="button"
          onClick={play}
          disabled={busy !== null}
          title="Lire la vidéo dans Trame"
          className={cn(
            "group/video relative flex aspect-video w-full max-w-xl items-center justify-center rounded-md bg-black/80 text-white",
            "hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait"
          )}
        >
          <span className="flex size-12 items-center justify-center rounded-full bg-white/15 transition-transform group-hover/video:scale-105">
            {busy === "play" ? <LoaderCircle className="size-6 animate-spin" aria-hidden /> : <Play className="size-6 translate-x-0.5" aria-hidden />}
          </span>
          <span className="sr-only">Lire {file.name}</span>
        </button>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <Film className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{file.name}</span>
        <button
          type="button"
          onClick={download}
          disabled={busy !== null}
          title="Télécharger la vidéo"
          aria-label={`Télécharger ${file.name}`}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait"
        >
          {busy === "download" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
        </button>
        <button
          type="button"
          onClick={() => openExternal(file.url)}
          title="Ouvrir dans le navigateur"
          aria-label={`Ouvrir ${file.name} dans le navigateur`}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ExternalLink className="size-4" aria-hidden />
        </button>
      </div>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}
