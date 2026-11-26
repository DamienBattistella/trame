import { useState } from "react";
import { ExternalLink, FileText, ImageIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { openExternal } from "@/desktop";
import { cn } from "@/lib/utils";
import type { ReceivedFile, ReceivedImage } from "@/types";

/** Pièces jointes reçues dans un message : images (aperçu, agrandi au clic) et fichiers
 *  (ouverts dans le navigateur par leur lien SharePoint/OneDrive, sinon dans Teams). */
export function MessageAttachments({
  files = [],
  images = [],
  sender,
  onOpenTeams,
}: {
  files?: ReceivedFile[];
  images?: ReceivedImage[];
  sender: string;
  onOpenTeams: () => void;
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
            className="block overflow-hidden rounded-lg border bg-background/40"
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
      {files.map((f, i) => (
        <AttachmentChip
          key={`${f.name}-${i}`}
          icon={<FileText className="size-4" />}
          label={f.name}
          hint={f.url ? "Ouvrir dans le navigateur" : "Ouvrir dans Teams"}
          onClick={() => (f.url ? openExternal(f.url) : onOpenTeams())}
        />
      ))}
      <Dialog open={zoom !== null} onOpenChange={(open) => !open && setZoom(null)}>
        <DialogContent className="w-auto max-w-[90vw] p-3 sm:max-w-[min(90vw,1100px)]">
          <DialogTitle className="sr-only">Image envoyée par {sender}</DialogTitle>
          <DialogDescription className="sr-only">Aperçu de l'image reçue dans Teams.</DialogDescription>
          {zoom?.data && <img src={zoom.data} alt={`Image envoyée par ${sender}`} className="max-h-[80vh] w-full rounded-md object-contain" />}
        </DialogContent>
      </Dialog>
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
