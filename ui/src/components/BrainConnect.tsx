import { AnimatePresence, motion } from "motion/react";
import { Trame } from "@/api";
import { ClaudeConnect } from "@/components/ClaudeConnect";
import { GithubConnect } from "@/components/GithubConnect";
import { BrainId, BrainPicker, BrainState } from "@/components/BrainPicker";

/** Choix du cerveau avec son état de connexion dans chaque carte. La ligne de connexion
 *  n'apparaît sous les cartes que s'il reste quelque chose à faire pour le cerveau choisi. */
export function BrainChoice({
  trame,
  value,
  onChange,
  size,
}: {
  trame: Trame;
  value: BrainId;
  onChange: (v: BrainId) => void;
  size?: "lg" | "md";
}) {
  const c = trame.claudeStatus;
  const g = trame.githubStatus;
  const claude: BrainState = !c
    ? { tone: "wait", text: "Vérification…" }
    : !c.installed
      ? { tone: "todo", text: "Non installé" }
      : c.loggedIn
        ? { tone: "ok", text: c.plan ? `Connecté · ${c.plan}` : "Connecté" }
        : c.loginPending
          ? { tone: "wait", text: "Connexion en cours…" }
          : { tone: "todo", text: "Non connecté" };
  const copilot: BrainState = !g
    ? { tone: "wait", text: "Vérification…" }
    : !g.installed
      ? { tone: "todo", text: "gh non installé" }
      : g.loggedIn
        ? { tone: "ok", text: g.account ? `@${g.account}` : "Connecté" }
        : g.loginPending
          ? { tone: "wait", text: "Connexion en cours…" }
          : { tone: "todo", text: "Non connecté" };
  const ready = (value === "claude" ? claude : copilot).tone === "ok";

  return (
    <div className="flex w-full flex-col gap-3">
      <BrainPicker value={value} onChange={onChange} size={size} states={{ claude, copilot }} />
      <AnimatePresence mode="wait" initial={false}>
        {!ready && (
          <motion.div
            key={value}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="flex flex-col gap-2 overflow-hidden"
          >
            {value === "claude" ? (
              <ClaudeConnect trame={trame} />
            ) : (
              <>
                <GithubConnect trame={trame} />
                <span className="text-xs text-muted-foreground">Copilot passe par ton compte GitHub, avec un abonnement Copilot.</span>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
