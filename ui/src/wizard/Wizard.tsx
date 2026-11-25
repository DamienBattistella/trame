import { useState } from "react";
import { Check, PlayCircle, UploadCloud, GitBranch, Loader2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { BRAINS } from "@/brands";
import { cn } from "@/lib/utils";
import { mockConversations } from "@/mockData";
import { WatchEntity } from "@/types";

const TOTAL = 8;

function initials(name: string) {
  return name.replace(/[#]/g, "").split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
}

function GroupList({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full divide-y divide-border overflow-hidden rounded-2xl border bg-card text-left">
      {children}
    </div>
  );
}

function Segment({ value, onChange }: { value: "draft" | "auto"; onChange: (v: "draft" | "auto") => void }) {
  return (
    <div className="flex rounded-full bg-secondary p-0.5 text-xs font-medium">
      {(["draft", "auto"] as const).map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cn(
            "rounded-full px-3 py-1 transition-colors",
            value === v ? "bg-background shadow-sm" : "text-muted-foreground"
          )}
        >
          {v === "draft" ? "Brouillon" : "Auto"}
        </button>
      ))}
    </div>
  );
}

export function Wizard({ onFinish }: { onFinish: () => void }) {
  const [step, setStep] = useState(0);
  const [brain, setBrain] = useState<"claude" | "copilot">("claude");
  const [probe, setProbe] = useState<"idle" | "running" | "ok">("idle");
  const [convs, setConvs] = useState<WatchEntity[]>(mockConversations);
  const [github, setGithub] = useState(true);

  const watched = convs.filter((c) => c.watch);
  const toggleWatch = (id: string) =>
    setConvs((cs) => cs.map((c) => (c.threadId === id ? { ...c, watch: !c.watch } : c)));
  const setMode = (id: string, mode: "draft" | "auto") =>
    setConvs((cs) => cs.map((c) => (c.threadId === id ? { ...c, mode } : c)));

  const canContinue = step !== 2 || probe === "ok";
  const last = step === TOTAL - 1;

  const screens: { title: string; sub: string; body?: React.ReactNode }[] = [
    {
      title: "Bienvenue dans Trame",
      sub: "Ton assistant répond sur Teams, dans ta voix, en pilotant l'app — sans toucher à ta connexion.",
      body: (
        <div className="flex items-center gap-2 rounded-full bg-success/10 px-3 py-1.5 text-sm text-success">
          <Check className="size-4" /> Microsoft Teams détecté
        </div>
      ),
    },
    {
      title: "Choisis le cerveau",
      sub: "Qui rédige tes réponses. Modifiable à tout moment.",
      body: (
        <div className="grid w-full grid-cols-2 gap-3">
          {BRAINS.map(({ id: v, name, desc, Logo: BrandLogo }) => (
            <button
              key={v}
              onClick={() => setBrain(v)}
              className={cn(
                "flex flex-col items-center gap-1 rounded-2xl border-2 p-5 transition-colors",
                brain === v ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
              )}
            >
              <BrandLogo className="mb-2 size-9" />
              <span className="text-base font-semibold">{name}</span>
              <span className="text-xs text-muted-foreground">{desc}</span>
            </button>
          ))}
        </div>
      ),
    },
    {
      title: "Un petit test",
      sub: "Envoie-toi un message sur Teams, puis vérifie que Trame sait le lire.",
      body: (
        <div className="flex flex-col items-center gap-3">
          <Button
            size="lg"
            className="rounded-full px-8"
            disabled={probe === "running"}
            onClick={() => {
              setProbe("running");
              setTimeout(() => setProbe("ok"), 1500);
            }}
          >
            {probe === "running" ? <Loader2 className="size-4 animate-spin" /> : <PlayCircle className="size-4" />}
            Tester la lecture
          </Button>
          {probe === "ok" && (
            <div className="flex items-center gap-2 text-sm text-success">
              <Check className="size-4" /> Lecture OK · zone de saisie repérée
            </div>
          )}
        </div>
      ),
    },
    {
      title: "Qui surveiller ?",
      sub: "Coche les conversations que Trame doit suivre.",
      body: (
        <GroupList>
          {convs.map((c) => (
            <button
              key={c.threadId}
              onClick={() => toggleWatch(c.threadId)}
              className="flex w-full items-center gap-3 px-4 py-3 hover:bg-accent"
            >
              <div className="flex size-9 items-center justify-center rounded-full bg-secondary text-xs font-medium">
                {initials(c.displayName)}
              </div>
              <span className="flex-1 text-left">{c.displayName}</span>
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border",
                  c.watch ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
                )}
              >
                {c.watch && <Check className="size-3.5" />}
              </span>
            </button>
          ))}
        </GroupList>
      ),
    },
    {
      title: "Brouillon ou auto ?",
      sub: "Brouillon : tu valides. Auto : Trame envoie après un court délai annulable.",
      body: (
        <GroupList>
          {watched.map((c) => (
            <div key={c.threadId} className="flex items-center gap-3 px-4 py-3">
              <div className="flex size-9 items-center justify-center rounded-full bg-secondary text-xs font-medium">
                {initials(c.displayName)}
              </div>
              <span className="flex-1">{c.displayName}</span>
              <Segment value={c.mode} onChange={(v) => setMode(c.threadId, v)} />
            </div>
          ))}
        </GroupList>
      ),
    },
    {
      title: "Ta voix",
      sub: "Dépose ton SOUL.md — ta façon d'écrire, ton rôle, ce que Trame refuse. Ou plus tard.",
      body: (
        <div className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed p-8 text-muted-foreground transition-colors hover:border-primary hover:text-foreground">
          <UploadCloud className="size-7" />
          <span className="text-sm">Glisse ton SOUL.md ici</span>
        </div>
      ),
    },
    {
      title: "Contexte GitHub",
      sub: "En lecture seule, consulté quand un message parle code. Trame n'écrit jamais.",
      body: (
        <GroupList>
          <div className="flex items-center gap-3 px-4 py-3.5">
            <GitBranch className="size-5 text-muted-foreground" />
            <span className="flex-1">Activer le contexte GitHub</span>
            <Switch checked={github} onCheckedChange={setGithub} />
          </div>
        </GroupList>
      ),
    },
    {
      title: "Tout est prêt",
      sub: "Trame veille sur tes conversations et te propose des réponses. Tu gardes la main.",
      body: (
        <GroupList>
          <Summary label="Cerveau" value={brain === "claude" ? "Claude" : "Copilot"} />
          <Summary label="Surveillées" value={`${watched.length}`} />
          <Summary label="En auto" value={`${watched.filter((c) => c.mode === "auto").length}`} />
          <Summary label="GitHub" value={github ? "Activé" : "Désactivé"} />
        </GroupList>
      ),
    },
  ];

  const s = screens[step];

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 items-center justify-center overflow-auto px-6">
        <div
          key={step}
          className="flex w-full max-w-md flex-col items-center gap-6 py-8 text-center duration-300 animate-in fade-in slide-in-from-bottom-3"
        >
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-semibold tracking-tight text-balance">{s.title}</h1>
            <p className="text-balance text-muted-foreground">{s.sub}</p>
          </div>
          {s.body}
        </div>
      </div>

      <div className="flex flex-col items-center gap-4 px-6 pb-8">
        <Button
          size="lg"
          className="h-12 rounded-full px-10 text-base"
          disabled={!canContinue}
          onClick={() => (last ? onFinish() : setStep((n) => n + 1))}
        >
          {last ? "Activer Trame" : "Continuer"}
          {!last && <ArrowRight className="size-4" />}
        </Button>

        <div className="flex items-center gap-1.5">
          {Array.from({ length: TOTAL }).map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === step ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30"
              )}
            />
          ))}
        </div>

        <button
          onClick={() => setStep((n) => Math.max(0, n - 1))}
          className={cn("text-sm text-muted-foreground transition-opacity hover:text-foreground", step === 0 && "pointer-events-none opacity-0")}
        >
          Retour
        </button>
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
