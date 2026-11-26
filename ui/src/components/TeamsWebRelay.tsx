import { useEffect } from "react";
import { isDesktop, onDesktopEvent, teamsWebEval, teamsWebOpen } from "@/desktop";

const API = "http://127.0.0.1:8731";

/** Teams intégré : relaie les ordres du moteur vers la page Teams cachée, et ses
 *  réponses vers le moteur. Ne fait rien tant que le mode n'est pas activé. */
export function TeamsWebRelay() {
  useEffect(() => {
    if (!isDesktop()) return;
    let stopped = false;
    let opened = false;

    const offReply = onDesktopEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>("teams-bridge-reply", (payload) => {
      fetch(`${API}/api/teams-web/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => undefined);
    });

    const loop = async () => {
      while (!stopped) {
        let res: Response;
        try {
          res = await fetch(`${API}/api/teams-web/poll`);
        } catch {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        if (res.status === 409) {
          await new Promise((r) => setTimeout(r, 15000));
          continue;
        }
        if (!opened) {
          opened = true;
          await teamsWebOpen(false);
        }
        const data = await res.json().catch(() => null);
        const cmd = data?.command;
        if (!cmd) continue;
        const ran = await teamsWebEval(`window.__trame && window.__trame.run(${JSON.stringify(cmd)})`);
        if (!ran) {
          fetch(`${API}/api/teams-web/reply`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: cmd.id, ok: false, error: "fenêtre Teams de Trame indisponible" }),
          }).catch(() => undefined);
        }
      }
    };
    loop();
    return () => {
      stopped = true;
      offReply();
    };
  }, []);
  return null;
}
