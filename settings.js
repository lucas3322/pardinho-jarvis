// Configurações do Jarvis, definidas pela tela de Ajustes.
// - Segredos (chave da OpenAI, token do ClickUp) ficam no Keychain do macOS.
// - O resto fica em <dados>/config.json.
// Na primeira execução, importa um .env antigo, se existir.

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

const IS_MAC = process.platform === "darwin";
const ACCOUNT = "jarvis";
const SECRETS = { apiKey: "Jarvis — OpenAI", clickupToken: "Jarvis — ClickUp" };

export const DEFAULTS = {
  model: "gpt-realtime-2.1",
  voice: "cedar",
  speed: 1,
  webSearchModel: "gpt-5.5",
  wake: false,
  userName: "",
};

function security(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/security", args, { timeout: 15_000 }, (err, stdout) => {
      if (err) reject(Object.assign(err, { exitCode: child.exitCode }));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function keychainGet(service) {
  try {
    return (await security(["find-generic-password", "-a", ACCOUNT, "-s", service, "-w"])).trim() || null;
  } catch {
    return null; // 44 = não existe
  }
}

// Grava pelo modo interativo do `security` (comando enviado pela entrada padrão):
// o segredo não aparece na lista de processos e não é cortado. O modo que lê só
// a senha pela entrada padrão corta em 128 caracteres, e chaves sk-proj têm mais.
async function keychainSet(service, value) {
  if (!/^[A-Za-z0-9_\-.]+$/.test(value)) throw new Error("A chave tem caracteres inválidos.");
  await security(["-i"], `add-generic-password -U -a ${ACCOUNT} -s "${service}" -l "${service}" -w "${value}"\n`);
  if ((await keychainGet(service)) !== value) throw new Error("O Keychain não confirmou a gravação.");
}

async function keychainDelete(service) {
  try {
    await security(["delete-generic-password", "-a", ACCOUNT, "-s", service]);
  } catch {}
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export async function loadSettings({ dataDir, legacyEnvFiles = [] }) {
  const file = join(dataDir, "config.json");
  let stored = null;
  try {
    stored = JSON.parse(await readFile(file, "utf8"));
  } catch {}

  const values = { ...DEFAULTS, apiKey: null, clickupToken: null };
  const migratedFrom = [];

  async function persist() {
    const { apiKey, clickupToken, ...plain } = values;
    const data = { ...plain };
    // Fora do Mac não há Keychain: guarda no próprio arquivo (permissão só do usuário).
    if (!IS_MAC) data.secrets = { apiKey, clickupToken };
    await mkdir(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }

  async function setSecret(name, value) {
    values[name] = value || null;
    if (!IS_MAC) return;
    if (value) await keychainSet(SECRETS[name], value);
    else await keychainDelete(SECRETS[name]);
  }

  // O Keychain é compartilhado entre a versão web e o app: lê sempre primeiro.
  if (IS_MAC) {
    values.apiKey = await keychainGet(SECRETS.apiKey);
    values.clickupToken = await keychainGet(SECRETS.clickupToken);
  }

  if (stored) {
    for (const key of Object.keys(DEFAULTS)) if (stored[key] !== undefined) values[key] = stored[key];
    if (!IS_MAC) {
      values.apiKey = stored.secrets?.apiKey || null;
      values.clickupToken = stored.secrets?.clickupToken || null;
    }
  } else {
    // Primeira vez: importa o .env antigo, se houver.
    for (const envFile of legacyEnvFiles) {
      let text;
      try {
        text = await readFile(envFile, "utf8");
      } catch {
        continue;
      }
      const env = parseEnv(text);
      if (env.REALTIME_MODEL) values.model = env.REALTIME_MODEL;
      if (env.JARVIS_VOICE) values.voice = env.JARVIS_VOICE;
      if (env.JARVIS_SPEED) values.speed = Number(env.JARVIS_SPEED) || 1;
      if (env.WEB_SEARCH_MODEL) values.webSearchModel = env.WEB_SEARCH_MODEL;
      if (env.JARVIS_WAKE) values.wake = env.JARVIS_WAKE === "1";
      if (env.JARVIS_USER_NAME) values.userName = env.JARVIS_USER_NAME;
      // Só importa segredo se o Keychain ainda não tiver um (não sobrescreve).
      if (env.OPENAI_API_KEY && !values.apiKey) await setSecret("apiKey", env.OPENAI_API_KEY.trim());
      if (env.CLICKUP_TOKEN && !values.clickupToken) await setSecret("clickupToken", env.CLICKUP_TOKEN.trim());
      migratedFrom.push(envFile);
      break;
    }
    await persist();
  }

  return {
    values,
    migratedFrom,
    async update(changes) {
      for (const [key, value] of Object.entries(changes)) {
        if (key in SECRETS) await setSecret(key, value);
        else if (key in DEFAULTS) values[key] = value;
      }
      await persist();
    },
  };
}
