// Fil de démonstration (hors moteur) : plusieurs jours, des séries, des liens de chaque
// application (GitHub, Jira, GitLab, Teams, SharePoint, Confluence), un tableau. Données fictives.
import type { ThreadMessage } from "@/types";

const GH = "https://github.com/Wifsimster/passerelle";
const JIRA = "https://example.atlassian.net/browse";

/** Historique plus ancien que les messages du jour, au format d'heure de Teams. */
export function demoHistory(who: string): ThreadMessage[] {
  const other = (id: string, at: string, text: string, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({ id, sender: who, text, at, mine: false, ...extra });
  const me = (id: string, at: string, text: string, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({ id, sender: "Toi", text, at, mine: true, ...extra });
  return [
    other("h01", "24/11 09:02", "Bonjour ! On cale la recette du flux labo cette semaine ?"),
    other("h02", "24/11 09:03", `Le ticket de cadrage : ${JIRA}/HL7-9`),
    me("h03", "24/11 09:15", "Oui. Je reprends le mapping OBX d'abord, le reste suit."),
    me("h04", "24/11 09:16", `J'ai ouvert la branche ici : ${GH}/tree/feat/obx-mapping`),
    other("h05", "24/11 10:40", "Parfait. HL7-10 et HL7-11 dépendent du même correctif, tu peux les regarder dans la foulée ?"),
    me("h06", "24/11 10:52", "Je regarde HL7-10 cet après-midi, HL7-11 demain matin."),
    other("h07", "24/11 14:05", `La MR côté passerelle legacy : https://gitlab.example.com/integration/passerelle-legacy/-/merge_requests/87`),
    other("h08", "24/11 14:06", "Elle bloque sur un test d'intégration, rien de grave."),
    me("h09", "24/11 16:30", `Commit du correctif : ${GH}/commit/8a742d3f2b9c41d0e7a1`),
    other("h10", "24/11 17:48", "Merci, je relance la CI."),
    other("h11", "Hier 08:55", "Point rapide avant le comité :"),
    other(
      "h12",
      "Hier 08:56",
      [
        "| Sujet | Lien | État |",
        "| --- | --- | --- |",
        `| Typage OBX-2 | ${GH}/pull/214 | en revue |`,
        `| Unités UCUM | ${JIRA}/HL7-13 | à faire |`,
        `| Reprise legacy | https://gitlab.example.com/integration/passerelle-legacy/-/merge_requests/87 | bloquée par \`main\` |`,
        `| Dates de prélèvement | ${GH}/issues/198 | corrigée |`,
      ].join("\n")
    ),
    other("h13", "Hier 08:57", "Tu me dis si j'ai oublié quelque chose."),
    me("h14", "Hier 09:20", "Il manque HL7-12, le typage des valeurs numériques. Je l'ajoute au comité."),
    other("h15", "Hier 09:24", "Bien vu."),
    other("h16", "Hier 11:02", "Le compte rendu de la dernière réunion est là : https://example.sharepoint.com/sites/integration/Shared%20Documents/CR%20comit%C3%A9%20labo.docx"),
    other("h17", "Hier 11:03", "Et la page de recette : https://example.atlassian.net/wiki/spaces/INT/pages/4711/Recette+flux+labo"),
    me("h18", "Hier 11:30", "Lu. Je complète la section sur les unités."),
    other("h19", "Hier 14:00", "On se voit à 15 h pour la revue ? https://teams.microsoft.com/l/meetup-join/19%3ameeting_demo%40thread.v2/0"),
    me("h20", "Hier 14:02", "Oui, j'y serai."),
    other("h21", "Hier 15:58", "Merci pour la revue. Je mets à jour le ticket HL7-12."),
    other("h22", "Hier 15:59", "Et je passe la PR en prête."),
    me("h23", "Hier 17:10", "Top. La PR #214 attend encore un second relecteur."),
    other("h24", "Hier 17:12", "Je demande à Lucas."),
    me("h25", "Hier 18:05", "Bonne soirée !"),
    other("h26", "08:41", "Bonjour ! Lucas a relu, deux remarques mineures."),
    other("h27", "08:42", "La maquette de l'écran de suivi est prête aussi : https://www.figma.com/design/AbC123/Suivi-des-resultats"),
    me("h28", "08:58", "Je traite les remarques ce matin."),
  ];
}
