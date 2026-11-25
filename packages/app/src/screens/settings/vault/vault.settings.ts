import { defineSettingsPage } from "@/settings-index/define";

export const vaultSettings = defineSettingsPage({ kind: "host", section: "vault" }, ({ t }) => [
  {
    id: "vault.enabled",
    title: t("settings.vault.enable"),
    keywords: ["enable", "turn on", "turn off", "secrets", "security", "passphrase"],
  },
  {
    id: "vault.requests",
    title: t("settings.vault.requests.title"),
    keywords: ["approve", "approvals", "deny", "pending", "allow once"],
  },
  {
    id: "vault.secrets",
    title: t("settings.vault.secrets.title"),
    keywords: ["secret", "password", "token", "api key", "credential", "add secret"],
  },
  {
    id: "vault.import",
    title: t("settings.vault.import.title"),
    keywords: ["import", ".env", "dotenv", "paste", "csv", "apple passwords", "passwords export"],
  },
  {
    id: "vault.grants",
    title: t("settings.vault.grants.title"),
    keywords: ["approved commands", "always allow", "allowlist", "permissions"],
  },
  {
    id: "vault.env",
    title: t("settings.vault.env.title"),
    keywords: ["env", "environment", "scrub", "hide", "variables", "dotenv"],
  },
  {
    id: "vault.sources",
    title: t("settings.vault.sources.title"),
    keywords: [
      "bitwarden",
      "bw",
      "password manager",
      "login",
      "master password",
      "apple passwords",
    ],
  },
  {
    id: "vault.unlocking",
    title: t("settings.vault.unlocking.title"),
    keywords: ["touch id", "idle", "lock after", "auto lock", "timeout", "lock now", "biometric"],
  },
  {
    id: "vault.audit",
    title: t("settings.vault.audit.title"),
    keywords: ["audit", "audit log", "log", "history", "activity"],
  },
]);
