import type { ReflectionAction, ReflectionRun } from "@/types";

const TITLES: Record<ReflectionAction, string> = {
  correct: "Corriger",
  check: "Vérifier",
  suggest: "Proposer une réponse",
  report: "Compte-rendu de réunion",
};

export interface DemoPlan {
  action: ReflectionAction;
  threadId: string | null;
  conversation: string | null;
  /** Étapes de Trame avant l'appel au modèle. */
  before: string[];
  /** Réflexion simulée, diffusée quelques mots à la fois. */
  thinking: string;
  after: string;
  result: string;
  /** Skill dont le texte est donné au modèle (démo du chargement à la demande). */
  skill?: string;
  /** Skill choisi par l'utilisateur, chargé d'office (compte-rendu). */
  loaded?: string;
}

let seq = 0;
const now = () => {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mode démo : rejoue une action comme le moteur la diffuse (étapes, réflexion au fil
 * de l'eau, résultat), pour voir le panneau Réflexion sans moteur. `publish` reçoit
 * chaque version de l'action ; `stopped` dit si l'utilisateur l'a annulée.
 */
export async function playDemoReflection(
  plan: DemoPlan,
  publish: (run: ReflectionRun) => void,
  stopped: (id: string) => boolean
): Promise<"done" | "cancelled"> {
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const run: ReflectionRun = {
    id: `demo-${++seq}`,
    action: plan.action,
    title: TITLES[plan.action],
    threadId: plan.threadId,
    conversation: plan.conversation,
    provider: "démo",
    model: "simulé",
    startedAt: now(),
    status: "running",
    steps: [],
    result: "",
    durationMs: null,
    reasoning: false,
    skills: [],
    rev: 0,
  };
  const push = () => publish({ ...run, steps: run.steps.map((s) => ({ ...s })), skills: [...(run.skills ?? [])], rev: ++run.rev });
  const cancelled = () => {
    if (!stopped(run.id)) return false;
    run.status = "cancelled";
    run.durationMs = at();
    run.steps.push({ atMs: at(), kind: "error", text: "Action annulée" });
    push();
    return true;
  };
  push();
  const steps = [...plan.before, ...(plan.loaded ? [`Skill chargé : ${plan.loaded}`] : []), "Appel envoyé au cerveau de démonstration"];
  if (plan.skill) steps.push("Skills proposés au modèle", `Skill chargé : ${plan.skill}`);
  for (const text of steps) {
    await wait(260);
    if (cancelled()) return "cancelled";
    run.steps.push({ atMs: at(), kind: "step", text });
    if (text.startsWith("Skill chargé : ")) run.skills = [text.slice("Skill chargé : ".length)];
    push();
  }
  const words = plan.thinking.split(" ");
  const thought = { atMs: at(), kind: "thinking" as const, text: "" };
  run.steps.push(thought);
  run.reasoning = true;
  for (let i = 0; i < words.length; i += 3) {
    await wait(90);
    if (cancelled()) return "cancelled";
    thought.text += words.slice(i, i + 3).join(" ") + (i + 3 < words.length ? " " : "");
    push();
  }
  await wait(220);
  if (cancelled()) return "cancelled";
  run.steps.push({ atMs: at(), kind: "step", text: plan.after });
  run.result = plan.result;
  run.status = "done";
  run.durationMs = at();
  push();
  return "done";
}
