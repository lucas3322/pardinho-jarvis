// Anotações e arquivos do Jarvis.
// Escreve .md no formato do Obsidian (propriedades YAML, [[links]], tags)
// e .txt, sempre dentro de pastas permitidas: o segundo cérebro, Mesa,
// Documentos e Downloads. Nada é apagado: substituições guardam backup.

import { mkdir, readFile, readdir, realpath, rename, stat, writeFile, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const HOME = homedir();
const TIMEZONE = "America/Sao_Paulo";
const VAULT_FOLDERS = ["Inbox", "Projetos", "Áreas", "Recursos", "Arquivo", "Diário"];
const BACKUP_DIR = ".jarvis-backup";
const TEXT_EXT = new Set([".md", ".txt"]);

let settingsFile = "";
let settings = {};

export async function initNotes(dataDir) {
  settingsFile = join(dataDir, "settings.json");
  try {
    settings = JSON.parse(await readFile(settingsFile, "utf8"));
  } catch {
    settings = {};
  }
}

async function saveSettings() {
  await mkdir(dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, JSON.stringify(settings, null, 2));
}

export function vaultPath() {
  return settings.vaultPath || null;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function parts(date = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, seconds: p.second };
}

// Formatos de propriedade do Obsidian: data YYYY-MM-DD, data e hora YYYY-MM-DDTHH:MM:SS.
const nowStamp = () => {
  const p = parts();
  return `${p.date}T${p.time}:${p.seconds}`;
};

function safeName(title) {
  const name = String(title || "")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (!name || name.startsWith(".")) throw new Error("Nome de arquivo inválido.");
  return name;
}

// Tags do Obsidian não têm espaço nem "#".
const toTag = (t) =>
  String(t).replace(/^#/, "").trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_\-/]/gu, "").toLowerCase();

function roots() {
  const list = {
    mesa: join(HOME, "Desktop"),
    documentos: join(HOME, "Documents"),
    downloads: join(HOME, "Downloads"),
  };
  if (settings.vaultPath) list.cerebro = settings.vaultPath;
  return list;
}

function rootFor(local = "cerebro") {
  const key = fold(local).replace(/[^a-z]/g, "");
  const aliases = { cerebro: "cerebro", segundocerebro: "cerebro", cofre: "cerebro", vault: "cerebro", mesa: "mesa", desktop: "mesa", areadetrabalho: "mesa", documentos: "documentos", documents: "documentos", downloads: "downloads" };
  const id = aliases[key];
  if (!id) throw new Error(`Local desconhecido: ${local}. Use cerebro, mesa, documentos ou downloads.`);
  const root = roots()[id];
  if (!root) {
    const err = new Error("O segundo cérebro ainda não foi criado.");
    err.code = "sem_cerebro";
    throw err;
  }
  return { id, root };
}

// Resolve um caminho relativo garantindo que fica dentro da raiz,
// inclusive seguindo links simbólicos.
async function inside(root, rel = "") {
  const abs = resolve(root, String(rel).replace(/^[/\\]+/, ""));
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error("Caminho fora da pasta permitida.");
  let probe = abs;
  while (true) {
    try {
      const real = await realpath(probe);
      const realRoot = await realpath(root).catch(() => root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error("Caminho fora da pasta permitida.");
      break;
    } catch (err) {
      if (err.message.startsWith("Caminho")) throw err;
      if (probe === root || dirname(probe) === probe) break;
      probe = dirname(probe);
    }
  }
  return abs;
}

const exists = (p) => stat(p).then(() => true, () => false);

async function walk(dir, root, depth, out, limit) {
  if (depth < 0 || out.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ abs, rel: relative(root, abs), dir: true });
      await walk(abs, root, depth - 1, out, limit);
    } else if (TEXT_EXT.has(extname(e.name).toLowerCase())) {
      out.push({ abs, rel: relative(root, abs), dir: false });
    }
  }
}

// Acha uma pasta existente com nome parecido ("areas" → "Áreas").
async function matchFolder(root, folder) {
  if (!folder) return root;
  let current = root;
  for (const piece of String(folder).split(/[/\\]+/).filter(Boolean)) {
    let match = null;
    try {
      const entries = await readdir(current, { withFileTypes: true });
      match = entries.find((e) => e.isDirectory() && fold(e.name) === fold(piece));
    } catch {}
    current = join(current, match ? match.name : safeName(piece));
  }
  return inside(root, relative(root, current));
}

// Acha um arquivo pelo caminho exato ou, se não existir, pelo nome.
async function findFile(root, rel) {
  const direct = await inside(root, rel);
  if (await exists(direct)) return { abs: direct };
  for (const ext of [".md", ".txt"]) {
    if (!extname(direct) && (await exists(direct + ext))) return { abs: direct + ext };
  }
  const wanted = fold(basename(String(rel)).replace(/\.(md|txt)$/i, ""));
  const all = [];
  await walk(root, root, 6, all, 4000);
  const hits = all.filter((f) => !f.dir && fold(basename(f.rel).replace(/\.(md|txt)$/i, "")) === wanted);
  if (hits.length === 1) return { abs: hits[0].abs };
  if (hits.length > 1) return { candidates: hits.map((h) => h.rel) };
  return {};
}

function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return m ? { fm: m[1], body: text.slice(m[0].length) } : { fm: null, body: text };
}

function setProp(fm, name, value) {
  const line = `${name}: ${value}`;
  const re = new RegExp(`^${name}:.*$`, "m");
  return re.test(fm) ? fm.replace(re, line) : `${fm}\n${line}`;
}

function buildFrontmatter({ tags = [], links = [] }) {
  const stamp = nowStamp();
  const lines = [`criado: ${stamp}`, `atualizado: ${stamp}`];
  const cleanTags = [...new Set(tags.map(toTag).filter(Boolean))];
  if (cleanTags.length) lines.push("tags:", ...cleanTags.map((t) => `  - ${t}`));
  const cleanLinks = [...new Set(links.map((l) => String(l).replace(/^\[\[|\]\]$/g, "").trim()).filter(Boolean))];
  if (cleanLinks.length) lines.push("relacionados:", ...cleanLinks.map((l) => `  - "[[${l}]]"`));
  return `---\n${lines.join("\n")}\n---\n`;
}

async function backup(root, abs) {
  const p = parts();
  const dir = join(root, BACKUP_DIR);
  await mkdir(dir, { recursive: true });
  const name = `${basename(abs, extname(abs))} ${p.date} ${p.time.replace(":", "h")}${p.seconds}s${extname(abs)}`;
  await copyFile(abs, join(dir, name));
  return relative(root, join(dir, name));
}

// ---------------------------------------------------------------------------
// Segundo cérebro
// ---------------------------------------------------------------------------

function expandPath(p) {
  let out = String(p).trim();
  if (out === "~" || out.startsWith("~/")) out = join(HOME, out.slice(1));
  if (!isAbsolute(out)) out = join(HOME, "Documents", out);
  return resolve(out);
}

export async function setupVault(path) {
  const abs = expandPath(path || "Segundo Cérebro");
  if (abs === HOME || !abs.startsWith(HOME + sep)) throw new Error("Escolha uma pasta dentro da sua pasta de usuário.");
  await mkdir(abs, { recursive: true });

  // Pasta que já tem notas é um cofre existente: não mexe na organização.
  const existing = [];
  await walk(abs, abs, 2, existing, 50);
  const hasNotes = existing.some((f) => !f.dir);
  const created = [];
  if (!hasNotes) {
    for (const folder of VAULT_FOLDERS) {
      await mkdir(join(abs, folder), { recursive: true });
      created.push(folder);
    }
    const home = join(abs, "Início.md");
    if (!(await exists(home))) {
      await writeFile(
        home,
        buildFrontmatter({ tags: ["inicio"] }) +
          `# Início

Segundo cérebro criado pelo Jarvis. Abra esta pasta como cofre no Obsidian.

- [[Inbox]] — capturas rápidas, para organizar depois
- [[Projetos]] — coisas com objetivo e prazo
- [[Áreas]] — responsabilidades contínuas (saúde, finanças, trabalho)
- [[Recursos]] — referências e assuntos de interesse
- [[Arquivo]] — o que não está mais ativo
- [[Diário]] — uma nota por dia, com o que você pediu para anotar
`
      );
    }
  }
  settings.vaultPath = abs;
  await saveSettings();
  return { caminho: abs, cofre_existente: hasNotes, pastas_criadas: created };
}

// ---------------------------------------------------------------------------
// Ferramentas
// ---------------------------------------------------------------------------

export const noteTools = {
  async configurar_segundo_cerebro({ caminho }) {
    return setupVault(caminho);
  },

  async listar_arquivos({ local = "cerebro", pasta = "", busca = "" }) {
    const { root } = rootFor(local);
    const base = await matchFolder(root, pasta);
    const all = [];
    await walk(base, root, busca ? 6 : 2, all, busca ? 3000 : 80);
    let items = all;
    if (busca) {
      const q = fold(busca);
      const found = [];
      for (const f of all) {
        if (found.length >= 25) break;
        if (fold(basename(f.rel)).includes(q)) {
          found.push({ ...f, onde: "nome" });
          continue;
        }
        if (f.dir) continue;
        try {
          if ((await stat(f.abs)).size > 300_000) continue;
          const text = await readFile(f.abs, "utf8");
          const i = fold(text).indexOf(q);
          if (i >= 0) found.push({ ...f, onde: "conteudo", trecho: text.slice(Math.max(0, i - 60), i + 120).replace(/\s+/g, " ") });
        } catch {}
      }
      items = found;
    }
    const result = await Promise.all(
      items.slice(0, 80).map(async (f) => {
        const info = await stat(f.abs).catch(() => null);
        return {
          caminho: f.rel,
          tipo: f.dir ? "pasta" : "arquivo",
          modificado: info ? parts(info.mtime).date : undefined,
          ...(f.trecho ? { trecho: f.trecho } : {}),
        };
      })
    );
    return { local, raiz: root, total: result.length, itens: result };
  },

  async ler_arquivo({ local = "cerebro", caminho }) {
    const { root } = rootFor(local);
    const found = await findFile(root, caminho);
    if (found.candidates) return { erro: "varios_arquivos", candidatos: found.candidates };
    if (!found.abs) return { erro: "nao_encontrado", caminho };
    const text = await readFile(found.abs, "utf8");
    return {
      caminho: relative(root, found.abs),
      conteudo: text.length > 12_000 ? text.slice(0, 12_000) + "\n[…cortado]" : text,
    };
  },

  async criar_arquivo({ local = "cerebro", pasta = "", titulo, conteudo = "", formato = "md", tags = [], relacionados = [] }) {
    const { root } = rootFor(local);
    const ext = formato === "txt" ? ".txt" : ".md";
    const name = safeName(titulo);
    const dir = await matchFolder(root, pasta);
    const abs = await inside(root, relative(root, join(dir, name + ext)));
    if (await exists(abs)) {
      return {
        erro: "ja_existe",
        caminho: relative(root, abs),
        dica: "Pergunte ao usuário se quer atualizar esse arquivo (acrescentar ou substituir) ou criar com outro nome.",
      };
    }
    await mkdir(dirname(abs), { recursive: true });
    let body = String(conteudo).trim();
    if (ext === ".md") {
      if (!/^#\s/.test(body)) body = `# ${name}\n\n${body}`;
      body = buildFrontmatter({ tags, links: relacionados }) + body;
    }
    await writeFile(abs, body + "\n", { flag: "wx" });
    return { ok: true, local, caminho: relative(root, abs) };
  },

  async atualizar_arquivo({ local = "cerebro", caminho, conteudo = "", modo = "acrescentar", secao = "" }) {
    const { root } = rootFor(local);
    const found = await findFile(root, caminho);
    if (found.candidates) return { erro: "varios_arquivos", candidatos: found.candidates, dica: "Pergunte qual deles." };
    if (!found.abs) return { erro: "nao_encontrado", caminho, dica: "Pergunte se o usuário quer criar um arquivo novo." };
    const abs = found.abs;
    const isMd = extname(abs).toLowerCase() === ".md";
    const old = await readFile(abs, "utf8");
    const addition = String(conteudo).trim();
    let next;
    let copia;

    if (modo === "substituir") {
      copia = await backup(root, abs);
      const prev = splitFrontmatter(old);
      const incoming = splitFrontmatter(addition);
      next = isMd && prev.fm !== null && incoming.fm === null ? `---\n${prev.fm}\n---\n${addition}\n` : addition + "\n";
    } else if (secao) {
      const lines = old.replace(/\s+$/, "").split("\n");
      const target = fold(secao.replace(/^#+\s*/, ""));
      const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && fold(l.replace(/^#+\s*/, "")) === target);
      if (start === -1) {
        next = `${lines.join("\n")}\n\n## ${secao.replace(/^#+\s*/, "")}\n\n${addition}\n`;
      } else {
        const level = lines[start].match(/^#+/)[0].length;
        let end = lines.length;
        for (let i = start + 1; i < lines.length; i++) {
          const m = lines[i].match(/^(#+)\s/);
          if (m && m[1].length <= level) {
            end = i;
            break;
          }
        }
        while (end > start + 1 && lines[end - 1].trim() === "") end--;
        // Item de lista logo após outro item continua a mesma lista, sem linha em branco.
        const isItem = (l) => /^\s*([-*+]|\d+[.)])\s/.test(l);
        const glue = isItem(lines[end - 1] || "") && isItem(addition) ? [] : [""];
        lines.splice(end, 0, ...glue, addition);
        next = lines.join("\n") + "\n";
      }
    } else {
      const trimmed = old.replace(/\s+$/, "");
      const lastLine = trimmed.split("\n").pop() || "";
      const isItem = (l) => /^\s*([-*+]|\d+[.)])\s/.test(l);
      next = `${trimmed}${isItem(lastLine) && isItem(addition) ? "\n" : "\n\n"}${addition}\n`;
    }

    if (isMd) {
      const { fm, body } = splitFrontmatter(next);
      if (fm !== null) next = `---\n${setProp(fm, "atualizado", nowStamp())}\n---\n${body}`;
    }
    const tmp = `${abs}.jarvis-tmp`;
    await writeFile(tmp, next);
    await rename(tmp, abs);
    return { ok: true, local, caminho: relative(root, abs), modo, ...(copia ? { backup: copia } : {}) };
  },

  async anotar_no_diario({ conteudo }) {
    const { root } = rootFor("cerebro");
    const p = parts();
    const dir = await matchFolder(root, "Diário");
    const abs = await inside(root, relative(root, join(dir, `${p.date}.md`)));
    const entry = `- ${p.time} ${String(conteudo).trim().replace(/\n+/g, "\n  ")}`;
    if (!(await exists(abs))) {
      await mkdir(dirname(abs), { recursive: true });
      const title = new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, dateStyle: "full" }).format(new Date());
      await writeFile(abs, `${buildFrontmatter({ tags: ["diario"] })}# ${title}\n\n${entry}\n`);
    } else {
      const old = await readFile(abs, "utf8");
      const { fm, body } = splitFrontmatter(`${old.replace(/\s+$/, "")}\n${entry}\n`);
      await writeFile(abs, fm !== null ? `---\n${setProp(fm, "atualizado", nowStamp())}\n---\n${body}` : body);
    }
    return { ok: true, caminho: relative(root, abs) };
  },

  // Revisão semanal: o que está no Inbox, para onde pode ir, e o diário da semana.
  async revisar_inbox() {
    const { root } = rootFor("cerebro");
    const inbox = await matchFolder(root, "Inbox");
    const notes = [];
    await walk(inbox, root, 1, notes, 200);
    const inboxNotes = await Promise.all(
      notes.filter((f) => !f.dir).slice(0, 40).map(async (f) => {
        const text = await readFile(f.abs, "utf8").catch(() => "");
        const { body } = splitFrontmatter(text);
        const info = await stat(f.abs).catch(() => null);
        return {
          caminho: f.rel,
          modificado: info ? parts(info.mtime).date : undefined,
          inicio: body.replace(/\s+/g, " ").trim().slice(0, 400),
        };
      })
    );

    const dirs = [];
    await walk(root, root, 1, dirs, 300);
    const destinos = dirs.filter((d) => d.dir && fold(d.rel) !== fold(relative(root, inbox))).map((d) => d.rel);

    const diary = await matchFolder(root, "Diário");
    const semana = [];
    for (let i = 6; i >= 0; i--) {
      const day = parts(new Date(Date.now() - i * 86_400_000)).date;
      const text = await readFile(join(diary, `${day}.md`), "utf8").catch(() => null);
      if (text) semana.push({ dia: day, anotacoes: splitFrontmatter(text).body.trim().slice(0, 1500) });
    }
    return { total_inbox: notes.filter((f) => !f.dir).length, inbox: inboxNotes, destinos, diario_da_semana: semana };
  },

  async mover_arquivo({ local = "cerebro", caminho, pasta_destino }) {
    const { root } = rootFor(local);
    const found = await findFile(root, caminho);
    if (found.candidates) return { erro: "varios_arquivos", candidatos: found.candidates };
    if (!found.abs) return { erro: "nao_encontrado", caminho };
    const dir = await matchFolder(root, pasta_destino);
    const dest = await inside(root, relative(root, join(dir, basename(found.abs))));
    if (dest === found.abs) return { ok: true, caminho: relative(root, dest), nota: "Já estava nessa pasta." };
    if (await exists(dest)) return { erro: "ja_existe", mensagem: `Já existe ${relative(root, dest)}.` };
    await mkdir(dirname(dest), { recursive: true });
    await rename(found.abs, dest);
    // Links [[Nome]] do Obsidian apontam pelo nome: continuam funcionando.
    return { ok: true, de: relative(root, found.abs), para: relative(root, dest) };
  },

  async abrir_arquivo({ local = "cerebro", caminho = "" }) {
    const { root } = rootFor(local);
    let abs = root;
    if (caminho) {
      const found = await findFile(root, caminho);
      if (!found.abs) return { erro: "nao_encontrado", caminho };
      abs = found.abs;
    }
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [abs], { stdio: "ignore", detached: true }).unref();
    return { ok: true, aberto: relative(root, abs) || "(pasta)" };
  },
};

// Definições para a sessão Realtime.
const LOCAL = {
  type: "string",
  enum: ["cerebro", "mesa", "documentos", "downloads"],
  description: "Onde fica o arquivo: cerebro (segundo cérebro), mesa (Mesa/Desktop), documentos ou downloads.",
};

export const NOTE_TOOL_DEFS = [
  {
    type: "function",
    name: "configurar_segundo_cerebro",
    description:
      "Cria (ou passa a usar) a pasta do segundo cérebro no formato do Obsidian. Sem caminho, cria 'Segundo Cérebro' em Documentos com as pastas Inbox, Projetos, Áreas, Recursos, Arquivo e Diário. Se a pasta já tiver notas, só passa a usá-la.",
    parameters: {
      type: "object",
      properties: {
        caminho: { type: "string", description: "Pasta desejada. Relativo a Documentos ou absoluto. Opcional." },
      },
    },
  },
  {
    type: "function",
    name: "listar_arquivos",
    description:
      "Lista pastas e arquivos .md/.txt ou busca por nome e conteúdo. Use ANTES de criar uma anotação, para ver se já existe arquivo parecido e para conhecer as pastas.",
    parameters: {
      type: "object",
      properties: {
        local: LOCAL,
        pasta: { type: "string", description: "Subpasta para listar. Opcional." },
        busca: { type: "string", description: "Palavra para procurar no nome ou no conteúdo. Opcional." },
      },
      required: ["local"],
    },
  },
  {
    type: "function",
    name: "ler_arquivo",
    description: "Lê o conteúdo de um arquivo .md ou .txt.",
    parameters: {
      type: "object",
      properties: { local: LOCAL, caminho: { type: "string", description: "Caminho relativo ou nome do arquivo." } },
      required: ["local", "caminho"],
    },
  },
  {
    type: "function",
    name: "criar_arquivo",
    description:
      "Cria um arquivo novo. Em .md, o conteúdo deve ser markdown no estilo Obsidian: títulos ##, listas, - [ ] tarefas, [[Nome de outra nota]] para ligar notas. As propriedades (criado, tags) são adicionadas automaticamente. Só chame depois de o usuário confirmar onde salvar.",
    parameters: {
      type: "object",
      properties: {
        local: LOCAL,
        pasta: { type: "string", description: "Subpasta, ex.: 'Projetos' ou 'Projetos/App Jarvis'. Opcional." },
        titulo: { type: "string", description: "Título curto e claro; vira o nome do arquivo." },
        conteudo: { type: "string", description: "Conteúdo bem organizado, escrito por você a partir do que o usuário disse." },
        formato: { type: "string", enum: ["md", "txt"], description: "md (padrão) ou txt." },
        tags: { type: "array", items: { type: "string" }, description: "Tags curtas, sem #. Opcional." },
        relacionados: { type: "array", items: { type: "string" }, description: "Nomes de notas existentes para ligar. Opcional." },
      },
      required: ["local", "titulo", "conteudo"],
    },
  },
  {
    type: "function",
    name: "atualizar_arquivo",
    description:
      "Atualiza um arquivo existente. modo 'acrescentar' adiciona ao final (ou ao fim de uma seção); 'substituir' troca todo o conteúdo e guarda backup. Só chame depois de o usuário escolher atualizar em vez de criar outro.",
    parameters: {
      type: "object",
      properties: {
        local: LOCAL,
        caminho: { type: "string", description: "Caminho relativo ou nome do arquivo." },
        conteudo: { type: "string", description: "Texto a acrescentar, ou o conteúdo completo no modo substituir." },
        modo: { type: "string", enum: ["acrescentar", "substituir"] },
        secao: { type: "string", description: "Título da seção onde acrescentar, ex.: 'Ideias'. Criada se não existir. Opcional." },
      },
      required: ["local", "caminho", "conteudo", "modo"],
    },
  },
  {
    type: "function",
    name: "anotar_no_diario",
    description: "Acrescenta uma anotação rápida, com horário, na nota de hoje do Diário no segundo cérebro.",
    parameters: {
      type: "object",
      properties: { conteudo: { type: "string", description: "O que anotar." } },
      required: ["conteudo"],
    },
  },
  {
    type: "function",
    name: "revisar_inbox",
    description:
      "Revisão semanal do segundo cérebro: traz as notas do Inbox (com o começo de cada uma), as pastas de destino e o diário dos últimos 7 dias.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "mover_arquivo",
    description: "Move uma nota para outra pasta (sem sobrescrever). Só chame depois de o usuário aprovar a mudança.",
    parameters: {
      type: "object",
      properties: {
        local: LOCAL,
        caminho: { type: "string", description: "Caminho ou nome da nota." },
        pasta_destino: { type: "string", description: "Pasta de destino, ex.: 'Projetos/App Jarvis'." },
      },
      required: ["local", "caminho", "pasta_destino"],
    },
  },
  {
    type: "function",
    name: "abrir_arquivo",
    description: "Abre um arquivo (ou a pasta, sem caminho) no Mac do usuário.",
    parameters: {
      type: "object",
      properties: { local: LOCAL, caminho: { type: "string", description: "Arquivo a abrir. Opcional." } },
      required: ["local"],
    },
  },
];
