// Integração com o macOS: Calendário e Lembretes (via jarvis-helper, EventKit)
// e captura de tela para a versão web.

import { execFile } from "node:child_process";
import { readFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const HELPER = process.env.JARVIS_HELPER || join(ROOT, "bin", "jarvis-helper");
const IS_MAC = process.platform === "darwin";

function run(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout);
    });
  });
}

// O primeiro uso pode abrir o pedido de permissão do macOS: espera o usuário responder.
export async function helper(command, args = {}) {
  if (!IS_MAC) return { erro: "indisponivel", mensagem: "Calendário e Lembretes só funcionam no Mac." };
  let stdout;
  try {
    stdout = await run(HELPER, [command, JSON.stringify(args)], 120_000);
  } catch (err) {
    if (/ENOENT/.test(err.message)) return { erro: "indisponivel", mensagem: "Componente do Mac não encontrado. Rode npm run helper." };
    return { erro: "falha", mensagem: err.message };
  }
  try {
    return JSON.parse(stdout);
  } catch {
    return { erro: "falha", mensagem: "Resposta inválida do componente do Mac." };
  }
}

// AppleScript com argumentos via argv: nada do usuário é interpolado no script.
function osa(lines, args = [], timeout = 15_000) {
  return run("/usr/bin/osascript", [...lines.flatMap((l) => ["-e", l]), ...args], timeout).then((s) => s.trim());
}

function automationError(err, app) {
  if (/-1743|not authorized|Not authorised/i.test(err.message)) {
    return {
      erro: "sem_permissao",
      mensagem: `Sem permissão para controlar ${app}. Libere em Ajustes do Sistema → Privacidade e Segurança → Automação.`,
    };
  }
  return { erro: "falha", mensagem: err.message };
}

const fold = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

const APP_DIRS = [
  "/Applications",
  "/Applications/Utilities",
  "/System/Applications",
  "/System/Applications/Utilities",
  join(homedir(), "Applications"),
];

async function installedApps() {
  const apps = [];
  for (const dir of APP_DIRS) {
    try {
      for (const name of await readdir(dir)) {
        if (name.endsWith(".app")) apps.push({ name: name.slice(0, -4), path: join(dir, name) });
      }
    } catch {}
  }
  return apps;
}

// Nomes falados para apps do sistema em português.
const APP_ALIASES = {
  calendario: "Calendar", lembretes: "Reminders", notas: "Notes", musica: "Music", mensagens: "Messages",
  fotos: "Photos", configuracoes: "System Settings", ajustes: "System Settings", "ajustes do sistema": "System Settings",
  calculadora: "Calculator", terminal: "Terminal", mapas: "Maps", contatos: "Contacts", finder: "Finder",
  "app store": "App Store", "loja de apps": "App Store", relogio: "Clock", "visualizacao": "Preview", preview: "Preview",
  atalhos: "Shortcuts", "vs code": "Visual Studio Code", vscode: "Visual Studio Code", chrome: "Google Chrome",
  outlook: "Microsoft Outlook", teams: "Microsoft Teams", "monitor de atividade": "Activity Monitor",
};

export async function findApp(name) {
  const wanted = fold(APP_ALIASES[fold(name)] || name);
  if (!wanted) return { erro: "argumento", mensagem: "Nome do app vazio." };
  const apps = await installedApps();
  const by = (fn) => apps.filter((a) => fn(fold(a.name)));
  const hits = by((n) => n === wanted).length ? by((n) => n === wanted)
    : by((n) => n.startsWith(wanted)).length ? by((n) => n.startsWith(wanted))
    : by((n) => n.includes(wanted));
  if (!hits.length) return { erro: "nao_encontrado", mensagem: `Não achei o app "${name}" instalado.` };
  if (hits.length > 1 && fold(hits[0].name) !== wanted) {
    return { erro: "varios", candidatos: hits.slice(0, 6).map((h) => h.name) };
  }
  return { app: hits[0] };
}

async function musicApp(preferred) {
  if (preferred) return fold(preferred).includes("spot") ? "Spotify" : "Music";
  // Prefere o que está aberto; senão o Spotify, se instalado.
  const isRunning = (name) => run("/usr/bin/pgrep", ["-x", name], 5_000).then((out) => Boolean(out.trim()), () => false);
  if (await isRunning("Spotify")) return "Spotify";
  if (await isRunning("Music")) return "Music";
  const apps = await installedApps();
  return apps.some((a) => a.name === "Spotify") ? "Spotify" : "Music";
}

export const macTools = {
  async abrir_app({ nome }) {
    const found = await findApp(nome);
    if (!found.app) return found;
    await run("/usr/bin/open", ["-a", found.app.path], 15_000);
    return { ok: true, aberto: found.app.name };
  },

  async fechar_app({ nome }) {
    const found = await findApp(nome);
    if (!found.app) return found;
    try {
      await osa(["on run argv", "tell application (item 1 of argv) to quit", "end run"], [found.app.name]);
      return { ok: true, fechado: found.app.name };
    } catch (err) {
      return automationError(err, found.app.name);
    }
  },

  async volume({ acao, valor }) {
    const current = async () => Number(await osa(["output volume of (get volume settings)"]));
    const muted = async () => (await osa(["output muted of (get volume settings)"])) === "true";
    const set = (v) => osa(["on run argv", "set volume output volume (item 1 of argv as integer)", "end run"], [String(Math.max(0, Math.min(100, Math.round(v))))]);
    const step = Number(valor) || 15;
    switch (acao) {
      case "definir": await set(Number(valor) || 0); break;
      case "aumentar": await set((await current()) + step); break;
      case "diminuir": await set((await current()) - step); break;
      case "mudo": await osa(["set volume with output muted"]); break;
      case "ativar_som": await osa(["set volume without output muted"]); break;
      case "consultar": break;
      default: return { erro: "argumento", mensagem: `Ação inválida: ${acao}` };
    }
    return { volume: await current(), mudo: await muted() };
  },

  async musica({ acao, busca, app }) {
    const player = await musicApp(app);
    try {
      switch (acao) {
        case "tocar_pausar": await osa(["on run argv", "tell application (item 1 of argv) to playpause", "end run"], [player]); break;
        case "tocar": await osa(["on run argv", "tell application (item 1 of argv) to play", "end run"], [player]); break;
        case "pausar": await osa(["on run argv", "tell application (item 1 of argv) to pause", "end run"], [player]); break;
        case "proxima": await osa(["on run argv", "tell application (item 1 of argv) to next track", "end run"], [player]); break;
        case "anterior": await osa(["on run argv", "tell application (item 1 of argv) to previous track", "end run"], [player]); break;
        case "buscar": {
          if (!busca) return { erro: "argumento", mensagem: "O que buscar?" };
          if (player === "Spotify") {
            // O Spotify não toca por busca via AppleScript: abre os resultados para o usuário escolher.
            await run("/usr/bin/open", [`spotify:search:${encodeURIComponent(busca)}`], 15_000);
            return { ok: true, app: player, aberto: "busca", nota: "Abri a busca no Spotify; o usuário escolhe o que tocar." };
          }
          const played = await osa([
            "on run argv",
            'tell application "Music"',
            "set hits to (search library playlist 1 for (item 1 of argv))",
            "if hits is {} then return \"\"",
            "play item 1 of hits",
            'return (name of item 1 of hits) & " — " & (artist of item 1 of hits)',
            "end tell",
            "end run",
          ], [busca]);
          return played ? { ok: true, app: player, tocando: played } : { erro: "nao_encontrado", mensagem: "Não achei isso na sua biblioteca do Music." };
        }
        case "o_que_toca": break;
        default: return { erro: "argumento", mensagem: `Ação inválida: ${acao}` };
      }
      const info = await osa([
        "on run argv",
        "tell application (item 1 of argv)",
        'if player state is stopped then return "parado"',
        'return (player state as text) & "|" & (name of current track) & "|" & (artist of current track)',
        "end tell",
        "end run",
      ], [player]);
      const [estado, faixa, artista] = info.split("|");
      return { app: player, estado: estado === "playing" ? "tocando" : estado === "paused" ? "pausado" : estado, faixa, artista };
    } catch (err) {
      return automationError(err, player);
    }
  },

  async modo_escuro({ ativo }) {
    try {
      const value = typeof ativo === "boolean" ? String(ativo) : "not dark mode";
      const out = await osa([
        'tell application "System Events" to tell appearance preferences',
        `set dark mode to ${value}`,
        "return dark mode",
        "end tell",
      ]);
      return { ok: true, modo_escuro: out === "true" };
    } catch (err) {
      return automationError(err, "a aparência do sistema");
    }
  },

  async atalhos({ acao, nome }) {
    if (acao === "listar") {
      const list = (await run("/usr/bin/shortcuts", ["list"], 15_000)).split("\n").map((s) => s.trim()).filter(Boolean);
      return { total: list.length, atalhos: list.slice(0, 100) };
    }
    if (acao === "executar") {
      const list = (await run("/usr/bin/shortcuts", ["list"], 15_000)).split("\n").map((s) => s.trim()).filter(Boolean);
      const match = list.find((s) => fold(s) === fold(nome)) || list.find((s) => fold(s).includes(fold(nome || "")));
      if (!nome || !match) return { erro: "nao_encontrado", mensagem: `Não achei o atalho "${nome}".`, disponiveis: list.slice(0, 30) };
      const out = await run("/usr/bin/shortcuts", ["run", match], 120_000);
      return { ok: true, executado: match, saida: out.trim().slice(0, 2000) || undefined };
    }
    return { erro: "argumento", mensagem: `Ação inválida: ${acao}` };
  },

  ver_agenda: (a) => helper("agenda", a),
  ver_lembretes: (a) => helper("lembretes", a),
  criar_lembrete: (a) => helper("criar_lembrete", a),
  concluir_lembrete: (a) => helper("concluir_lembrete", a),
  criar_evento: (a) => helper("criar_evento", a),

  // Versão web: captura a tela principal com o utilitário do macOS.
  // (No app desktop a captura é nativa, pelo Electron.)
  async capturar_tela() {
    if (!IS_MAC) return { erro: "indisponivel", mensagem: "Captura de tela só no Mac." };
    const dir = await mkdtemp(join(tmpdir(), "jarvis-tela-"));
    const file = join(dir, "tela.jpg");
    try {
      await run("/usr/sbin/screencapture", ["-x", "-m", "-t", "jpg", file], 15_000);
      await run("/usr/bin/sips", ["-Z", "1600", "-s", "formatOptions", "80", file], 15_000);
      const data = await readFile(file);
      return { imagem: `data:image/jpeg;base64,${data.toString("base64")}` };
    } catch (err) {
      return { erro: "falha", mensagem: `Não consegui capturar a tela: ${err.message}` };
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
};

const DATE_HINT = "Data e hora no fuso de São Paulo, formato AAAA-MM-DDTHH:MM (ex.: 2026-10-14T15:00) ou só AAAA-MM-DD para o dia inteiro.";

export const MAC_TOOL_DEFS = [
  {
    type: "function",
    name: "abrir_app",
    description: "Abre um aplicativo instalado no Mac (ex.: Spotify, Chrome, Outlook, Teams, VS Code, Calendário, Notas).",
    parameters: { type: "object", properties: { nome: { type: "string" } }, required: ["nome"] },
  },
  {
    type: "function",
    name: "fechar_app",
    description: "Fecha um aplicativo. O app pode ter trabalho não salvo: CONFIRME com o usuário antes de chamar, a menos que ele tenha pedido explicitamente para fechar aquele app.",
    parameters: { type: "object", properties: { nome: { type: "string" } }, required: ["nome"] },
  },
  {
    type: "function",
    name: "volume",
    description: "Controla o volume do Mac.",
    parameters: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["definir", "aumentar", "diminuir", "mudo", "ativar_som", "consultar"] },
        valor: { type: "number", description: "0 a 100 para definir; passo para aumentar/diminuir (padrão 15)." },
      },
      required: ["acao"],
    },
  },
  {
    type: "function",
    name: "musica",
    description:
      "Controla a música no Spotify ou no Music. 'buscar' no Spotify só abre a busca (o usuário escolhe); no Music toca da biblioteca.",
    parameters: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["tocar_pausar", "tocar", "pausar", "proxima", "anterior", "o_que_toca", "buscar"] },
        busca: { type: "string", description: "Música, artista ou playlist, para 'buscar'." },
        app: { type: "string", enum: ["spotify", "music"], description: "Opcional. Padrão: o que estiver aberto." },
      },
      required: ["acao"],
    },
  },
  {
    type: "function",
    name: "modo_escuro",
    description: "Liga, desliga ou alterna o modo escuro do Mac.",
    parameters: {
      type: "object",
      properties: { ativo: { type: "boolean", description: "true liga, false desliga. Omitir alterna." } },
    },
  },
  {
    type: "function",
    name: "atalhos",
    description:
      "Lista ou executa atalhos do app Atalhos (Shortcuts) do usuário — por exemplo, os que ligam um modo Foco. Execute só atalhos que o usuário pediu pelo nome ou depois de confirmar.",
    parameters: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["listar", "executar"] },
        nome: { type: "string", description: "Nome do atalho para executar." },
      },
      required: ["acao"],
    },
  },
  {
    type: "function",
    name: "ver_tela",
    description:
      "Tira um print da tela do usuário e te mostra a imagem. Use quando ele perguntar sobre algo que está vendo: 'o que é isso na minha tela?', 'lê esse erro', 'resume esse e-mail', 'o que acha desse layout?'.",
    parameters: {
      type: "object",
      properties: { foco: { type: "string", description: "O que o usuário quer saber da tela. Opcional." } },
    },
  },
  {
    type: "function",
    name: "ver_agenda",
    description: "Lista os eventos do Calendário do Mac (inclui contas Google, Outlook e iCloud adicionadas ao Mac). Sem datas, mostra hoje.",
    parameters: {
      type: "object",
      properties: {
        inicio: { type: "string", description: `Início do período. ${DATE_HINT}` },
        fim: { type: "string", description: `Fim do período (um dia inclui o dia todo). ${DATE_HINT}` },
      },
    },
  },
  {
    type: "function",
    name: "ver_lembretes",
    description: "Lista os lembretes pendentes do app Lembretes. Com 'ate', só os que vencem até essa data (inclui atrasados).",
    parameters: {
      type: "object",
      properties: { ate: { type: "string", description: `Opcional. ${DATE_HINT}` } },
    },
  },
  {
    type: "function",
    name: "criar_lembrete",
    description: "Cria um lembrete no app Lembretes, com alerta no horário. Use para 'me lembra de…'.",
    parameters: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "O que lembrar, curto e claro." },
        quando: { type: "string", description: `Quando avisar. ${DATE_HINT} Opcional.` },
        lista: { type: "string", description: "Nome da lista. Opcional." },
        notas: { type: "string", description: "Detalhes. Opcional." },
      },
      required: ["titulo"],
    },
  },
  {
    type: "function",
    name: "concluir_lembrete",
    description: "Marca um lembrete pendente como concluído, pelo título.",
    parameters: {
      type: "object",
      properties: { titulo: { type: "string" } },
      required: ["titulo"],
    },
  },
  {
    type: "function",
    name: "criar_evento",
    description: "Cria um evento no Calendário do Mac, com alerta 15 minutos antes. Confirme dia e horário com o usuário se houver qualquer dúvida.",
    parameters: {
      type: "object",
      properties: {
        titulo: { type: "string" },
        inicio: { type: "string", description: DATE_HINT },
        fim: { type: "string", description: `Opcional. ${DATE_HINT}` },
        duracao_min: { type: "number", description: "Duração em minutos se não houver fim. Padrão 60." },
        local: { type: "string", description: "Opcional." },
        calendario: { type: "string", description: "Nome do calendário. Opcional." },
        notas: { type: "string", description: "Opcional." },
      },
      required: ["titulo", "inicio"],
    },
  },
  {
    type: "function",
    name: "resumo_do_dia",
    description:
      "Monta o resumo do dia: clima, agenda de hoje, lembretes pendentes e principais notícias. Use para 'bom dia', 'meu resumo', 'como tá meu dia?'.",
    parameters: {
      type: "object",
      properties: {
        cidade: { type: "string", description: "Cidade do clima. Use a da memória se houver; senão São Paulo." },
        noticias_sobre: { type: "string", description: "Assuntos de interesse para as notícias (da memória, se houver). Opcional." },
      },
    },
  },
];
