// node --test tests/ : application d'une adresse et libellé court de sa pastille.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appRef, jiraBases, jiraNamed } from "../src/lib/apps.ts";

const label = (url: string) => {
  const r = appRef(url);
  return r ? `${r.app}:${r.kind}:${r.label}` : null;
};

test("GitHub : PR, issue, commit, dépôt", () => {
  assert.equal(label("https://github.com/acme/alliage/pull/4728"), "github:pr:alliage#4728");
  assert.equal(label("https://github.com/acme/alliage/issues/4849"), "github:issue:alliage#4849");
  assert.equal(label("https://github.com/acme/alliage/commit/8a742d3f00"), "github:commit:alliage@8a742d3");
  assert.equal(label("https://github.com/acme/alliage"), "github:repo:acme/alliage");
  assert.equal(label("https://github.com/acme/alliage/tree/main/ui"), "github:repo:acme/alliage");
  assert.equal(label("https://github.com/acme"), null);
  assert.equal(label("https://github.com/orgs/acme/projects"), null);
  assert.equal(label("https://github.com/acme/alliage/pull/12abc"), null);
});

test("GitLab : MR, issue, projet, quel que soit l'hôte GitLab", () => {
  assert.equal(label("https://gitlab.com/grp/sous/portail/-/merge_requests/12"), "gitlab:mr:portail!12");
  assert.equal(label("https://gitlab-erp.example.lan/grp/portail/-/issues/7"), "gitlab:issue:portail#7");
  assert.equal(label("https://gitlab.example.com/grp/portail"), "gitlab:repo:grp/portail");
});

test("Jira : ticket par /browse ou selectedIssue, Cloud ou serveur", () => {
  assert.equal(label("https://acme.atlassian.net/browse/ALL-103"), "jira:ticket:ALL-103");
  assert.equal(label("https://jira.example.com/browse/HEX-12"), "jira:ticket:HEX-12");
  assert.equal(label("https://acme.atlassian.net/jira/software/projects/ALL/boards/1?selectedIssue=ALL-94"), "jira:ticket:ALL-94");
  assert.equal(label("https://evil.example/browse/ALL-1"), null);
});

test("Confluence, Teams, SharePoint, OneDrive, Figma", () => {
  assert.equal(label("https://acme.atlassian.net/wiki/spaces/H10/pages/123/Plan+de+recette"), "confluence:page:Plan de recette");
  assert.equal(label("https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0"), "teams:meeting:Réunion Teams");
  assert.equal(label("https://teams.microsoft.com/l/message/19:abc@thread.v2/123"), "teams:message:Message Teams");
  assert.equal(label("https://acme.sharepoint.com/sites/h10/Shared%20Documents/Recette%20OBX.docx"), "sharepoint:file:Recette OBX.docx");
  assert.equal(label("https://acme-my.sharepoint.com/personal/x/Documents/Plan.xlsx"), "onedrive:file:Plan.xlsx");
  assert.equal(label("https://acme.sharepoint.com/sites/h10/SitePages/Accueil.aspx"), "sharepoint:file:SharePoint");
  assert.equal(label("https://www.figma.com/design/AbC123/Maquette-conversation"), "figma:file:Maquette conversation");
  assert.equal(label("https://example.com/page"), null);
  assert.equal(label("javascript:alert(1)"), null);
});

test("bases Jira par projet, pour reconnaître les clés seules", () => {
  assert.deepEqual(
    jiraBases(["https://acme.atlassian.net/browse/ALL-1", "https://jira.example.com/jira/browse/HEX-2", "https://example.com/browse/NOP-3"]),
    { ALL: "https://acme.atlassian.net", HEX: "https://jira.example.com/jira" }
  );
});

test("lien Jira nommé : clé et résumé", () => {
  assert.deepEqual(jiraNamed("[ALL-141] Recherche identité - Jira"), { key: "ALL-141", title: "Recherche identité" });
  assert.deepEqual(jiraNamed("ALL-141: Recherche identité"), { key: "ALL-141", title: "Recherche identité" });
  assert.equal(jiraNamed("Voir le ticket"), null);
});
