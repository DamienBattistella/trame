import { AnimatePresence, motion } from "motion/react";
import { Trame } from "@/api";
import { ClaudeConnect } from "@/components/ClaudeConnect";
import { GithubConnect } from "@/components/GithubConnect";
import { BrainId } from "@/components/BrainPicker";

/** Connexion du cerveau choisi, juste sous le choix : Claude Code, ou GitHub pour Copilot. */
export function BrainConnect({ trame, brain }: { trame: Trame; brain: BrainId }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={brain}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.18 }}
        className="flex w-full flex-col gap-2"
      >
        {brain === "claude" ? (
          <ClaudeConnect trame={trame} />
        ) : (
          <>
            <GithubConnect trame={trame} />
            <span className="text-xs text-muted-foreground">Copilot passe par ton compte GitHub, avec un abonnement Copilot.</span>
          </>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
