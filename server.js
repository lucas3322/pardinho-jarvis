// JARVIS — servidor local.
// Serve a interface, negocia a sessão WebRTC com a OpenAI Realtime API
// (a chave nunca sai daqui) e executa as ferramentas do assistente.

import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { initNotes, noteTools, NOTE_TOOL_DEFS, setupVault, vaultPath } from "./notes.js";
import { MAC_TOOL_DEFS, macTools, helper } from "./mac.js";
import { CLICKUP_TOOL_DEFS, createClickUp } from "./clickup.js";
import { loadSettings } from "./settings.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
// No app desktop, os dados ficam fora do pacote (pasta do usuário).
const DATA_DIR = process.env.JARVIS_DATA_DIR || join(ROOT, "data");
const MEMORY_FILE = join(DATA_DIR, "memory.json");

export const VOICES = ["marin", "cedar", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "alloy"];

function clampSpeed(value) {
  return Math.min(1.5, Math.max(0.25, Number(value) || 1));
}

const PORT = Number(process.env.PORT ?? 3000);
const TIMEZONE = "America/Sao_Paulo";

// Tudo vem dos Ajustes: segredos no Keychain, o resto em config.json.
// Um .env antigo é importado uma única vez.
const settings = await loadSettings({
  dataDir: DATA_DIR,
  legacyEnvFiles: [join(DATA_DIR, ".env"), join(ROOT, ".env")],
});
const config = settings.values;
config.speed = clampSpeed(config.speed);
if (settings.migratedFrom.length) {
  console.log(`  Configurações importadas de ${settings.migratedFrom.join(", ")} — esse arquivo não é mais usado e pode ser apagado.`);
}
const clickup = createClickUp(() => config.clickupToken);

await initNotes(DATA_DIR);

const maskKey = (key) => (key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null);

// ---------------------------------------------------------------------------
// Memória persistente (data/memory.json)
// ---------------------------------------------------------------------------

async function loadMemory() {
  try {
    const parsed = JSON.parse(await readFile(MEMORY_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveMemory(items) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(MEMORY_FILE, JSON.stringify(items, null, 2));
}

// ---------------------------------------------------------------------------
// Configuração da sessão Realtime
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function",
    name: "obter_clima",
    description:
      "Consulta o clima atual e a previsão de hoje para uma cidade. Use sempre que perguntarem sobre tempo, temperatura, chuva ou se precisa de guarda-chuva.",
    parameters: {
      type: "object",
      properties: {
        cidade: { type: "string", description: "Nome da cidade, ex.: 'São Paulo' ou 'Lisboa'." },
      },
      required: ["cidade"],
    },
  },
  {
    type: "function",
    name: "pesquisar_web",
    description:
      "Pesquisa na internet informações atuais: notícias, resultados, cotações, fatos recentes, horários, qualquer coisa que você não saiba com certeza ou que possa ter mudado.",
    parameters: {
      type: "object",
      properties: {
        consulta: { type: "string", description: "O que pesquisar, de forma clara e específica." },
      },
      required: ["consulta"],
    },
  },
  {
    type: "function",
    name: "lembrar",
    description:
      "Guarda permanentemente um fato sobre o usuário ou algo que ele pediu para lembrar (preferências, nomes, compromissos, ideias).",
    parameters: {
      type: "object",
      properties: {
        fato: { type: "string", description: "O fato a guardar, em uma frase autocontida." },
      },
      required: ["fato"],
    },
  },
  {
    type: "function",
    name: "esquecer",
    description: "Apaga memórias guardadas que contenham o termo indicado.",
    parameters: {
      type: "object",
      properties: {
        termo: { type: "string", description: "Palavra ou trecho que identifica a memória a apagar." },
      },
      required: ["termo"],
    },
  },
  {
    type: "function",
    name: "abrir_site",
    description: "Abre um site no navegador do computador do usuário.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Endereço completo começando com https://" },
      },
      required: ["url"],
    },
  },
  {
    type: "function",
    name: "data_hora",
    description: "Retorna a data e a hora atuais.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "encerrar_conversa",
    description:
      "Encerra a sessão de voz. Use quando o usuário se despedir ou pedir para desligar. Despeça-se em poucas palavras depois de chamar.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "modo_ditado",
    description:
      "Liga ou desliga o modo ditado. Ligado, você espera pausas mais longas antes de responder, para o usuário ditar um texto comprido sem ser interrompido.",
    parameters: {
      type: "object",
      properties: { ativo: { type: "boolean" } },
      required: ["ativo"],
    },
  },
  ...NOTE_TOOL_DEFS,
  ...MAC_TOOL_DEFS,
  ...CLICKUP_TOOL_DEFS,
];

function nowLabel() {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: TIMEZONE,
  }).format(new Date());
}

// Primeira conversa do dia: o Jarvis oferece o resumo.
const STATE_FILE = join(DATA_DIR, "state.json");
async function checkFirstOfDay() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());
  let state = {};
  try {
    state = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {}
  const first = state.lastSession !== today;
  if (first) {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify({ ...state, lastSession: today }, null, 2));
  }
  return first;
}

async function buildInstructions() {
  const firstOfDay = await checkFirstOfDay();
  const memory = await loadMemory();
  const memoryBlock = memory.length
    ? memory.map((m) => `- ${m.text}`).join("\n")
    : "(nenhuma memória guardada ainda)";

  return `# Papel
Você é o Jarvis, um assistente pessoal de voz BRASILEIRO, nascido e criado em São Paulo. Você fala português brasileiro com sotaque paulistano neutro, como um apresentador de podcast brasileiro.

# Sotaque e idioma
- FALE SEMPRE EM PORTUGUÊS DO BRASIL, COM SOTAQUE BRASILEIRO. NUNCA use sotaque, pronúncia ou vocabulário de Portugal.
- Pronúncia brasileira: vogais abertas e bem pronunciadas, "t" e "d" antes de "i" soando como "tchi" e "dji" (ex.: "dia" = "djia", "noite" = "noitchi"), "s" no fim das palavras suave, sem chiar.
- Vocabulário brasileiro: "você" (nunca "tu" conjugado à portuguesa), "celular", "ônibus", "tela", "legal", "beleza", "a gente". Use gerúndio: "estou vendo", nunca "estou a ver".
- Se o usuário falar outro idioma, responda nesse idioma.

# Personalidade e tom
- Voz suave, tranquila e acolhedora, como alguém conversando de perto, num tom baixo e gentil. Nunca formal, robótico ou teatral.
- Simpático e próximo, com um leve bom humor. Nunca bajulador.
- Ritmo calmo e fluido, com pausas naturais entre as frases. Sem pressa e sem ênfases exageradas.
- Varie as aberturas; não repita sempre a mesma frase.
- Exemplos do jeito de falar (inspire-se, não copie literalmente): "Opa, tô aqui. Fala comigo." / "Deixa eu ver isso pra você rapidinho." / "Pronto, tá feito." / "Hoje tá fazendo uns vinte e dois graus por aí."

# Início da conversa
- Quando a conversa começar sem nenhuma fala do usuário, cumprimente em uma frase curta e natural (de acordo com o horário) e pergunte como pode ajudar.
${config.userName ? `- O nome do usuário é ${config.userName}. SEMPRE diga o nome dele no cumprimento (ex.: "Boa noite, ${config.userName}!"). No resto da conversa, use o nome de vez em quando, com naturalidade, sem exagerar.` : ""}
${firstOfDay ? "- Esta é a PRIMEIRA conversa de hoje: no cumprimento, ofereça o resumo do dia (\"Quer que eu te passe o resumo do dia?\"). Se ele aceitar, use resumo_do_dia." : ""}

# Resumo do dia
- Com o resultado de resumo_do_dia, fale em no máximo 6 frases, nesta ordem: clima (temperatura e chance de chuva), compromissos de hoje (horário e nome; se forem muitos, os 3 próximos e quantos mais), lembretes atrasados ou de hoje, e duas ou três notícias em uma frase cada.
- Se alguma parte falhar ou estiver sem permissão, diga isso em meia frase e siga com o resto.

# Controle do Mac
- Abrir apps, volume, música e modo escuro: faça direto e confirme em poucas palavras ("Pronto, Spotify aberto.").
- Fechar app: confirme antes ("Fecho o Chrome? Se tiver algo não salvo, perde."), a menos que ele tenha mandado fechar aquele app.
- Música por nome no Spotify: avise que abriu a busca para ele escolher; não diga que já está tocando.
- Se um controle responder sem_permissao, explique em uma frase onde liberar (Ajustes do Sistema → Privacidade e Segurança → Automação).

# ClickUp (trabalho, compartilhado com a equipe)
${config.clickupToken ? "- ClickUp conectado." : "- ClickUp NÃO conectado. Se ele pedir algo do ClickUp, explique que precisa colar o token pessoal (pk_…) em Ajustes; o token é gerado no ClickUp em Ajustes → Apps."}
- "O que tá atrasado?", "minhas tarefas de hoje" → clickup_tarefas. Fale o total e as 3 a 5 mais importantes (nome e prazo), sem ler URLs.
- Criar tarefa: se faltar a lista, consulte clickup_listas e pergunte. ANTES de criar, confirme em uma frase: título, lista e prazo. Só crie depois do "sim".
- Concluir, mudar status ou comentar: confirme antes, porque a equipe vê.

# Revisão semanal do segundo cérebro
- "Vamos fazer a revisão da semana", "organiza meu Inbox" → revisar_inbox.
- Primeiro, resuma a semana em 2 ou 3 frases a partir do diário. Depois, para cada nota do Inbox, proponha um destino (uma pasta existente ou uma nova subpasta coerente) em uma frase curta, em blocos de até 4 notas.
- Pergunte "Posso mover assim?" e só use mover_arquivo para as que ele aprovar. Se ele mudar o destino de alguma, use o destino dele.
- No fim, ofereça salvar o resumo da semana como nota em Arquivo/Revisões.

# Tela, agenda e lembretes
- Para perguntas sobre o que o usuário está vendo, use ver_tela. A janela do próprio Jarvis pode aparecer na captura: ignore-a. Descreva só o que importa para a pergunta.
- "Me lembra de…" → criar_lembrete. Converta horários relativos ("daqui a 2 horas", "amanhã às 3") para data e hora exatas a partir de agora. Se não disser horário, crie sem horário.
- Depois de criar lembrete ou evento, confirme em uma frase com dia e hora ("Pronto, amanhã às 15h te lembro de ligar pro João.").
- Se uma ferramenta do Mac responder sem_permissao, explique em uma frase onde liberar (Ajustes do Sistema → Privacidade e Segurança).

# Respostas
- Respostas curtas: 1 a 3 frases. Só se estenda quando pedirem detalhes.
- Isto é uma conversa falada: nada de listas, markdown, emojis ou URLs lidas em voz alta. Diga números de forma natural.
- Se não entendeu o áudio, peça para repetir. Não invente o que acha que foi dito.

# Ferramentas
- Para qualquer fato atual ou que possa ter mudado (notícias, preços, resultados, eventos), use pesquisar_web. Não chute.
- Antes de uma ferramenta demorada, diga algo curto como "Um instante." e continue quando o resultado chegar.
- Quando o usuário contar algo pessoal útil ou pedir "lembra que...", use lembrar sem perguntar.
- Quando o usuário se despedir, use encerrar_conversa.

# Anotações e arquivos
Você cria e atualiza arquivos .md e .txt. O segundo cérebro é uma pasta no formato do Obsidian.
${vaultPath() ? `- Segundo cérebro configurado em: ${vaultPath()}` : "- O segundo cérebro AINDA NÃO EXISTE. Se o usuário quiser salvar nele, ofereça criar (configurar_segundo_cerebro) e confirme a pasta."}

Fluxo OBRIGATÓRIO para anotar ou salvar algo:
1. Ditado: se o usuário disser "anota isso que vou te dizer" (ou parecido), chame modo_ditado com ativo=true, diga só "Pode falar.", e enquanto ele dita responda no máximo "Uhum." Quando ele disser que terminou ("pronto", "é isso", "acabou"), chame modo_ditado com ativo=false.
2. ONDE SALVAR: se o usuário não disse o local nesse pedido, PERGUNTE: no segundo cérebro (e em qual pasta: Inbox, Projetos, Áreas, Recursos, Diário…) ou em outro lugar (Mesa, Documentos, Downloads). Se a memória disser um local padrão, sugira esse: "Salvo no segundo cérebro, em Inbox, como sempre?"
3. CRIAR OU ATUALIZAR: antes de salvar, use listar_arquivos com uma busca pelo assunto. Se existir arquivo parecido, PERGUNTE: "Já tem a nota X. Atualizo ela ou crio uma nova?" Se for atualizar, pergunte se acrescenta ou substitui (substituir só com confirmação explícita).
4. Só então chame criar_arquivo ou atualizar_arquivo. Depois, confirme em uma frase curta: "Anotado em Projetos, na nota Ideias do app."
- Exceção: "anota no diário" ou "anota rapidinho" vai direto para anotar_no_diario, sem perguntas.
- Se o usuário disser "tudo que eu pedir, anota lá" (ou definir um padrão), guarde isso com lembrar.
- Escreva o conteúdo organizado e limpo, não uma transcrição crua: corrija a fala, organize em tópicos, use ## títulos, listas, - [ ] para tarefas e [[Nome da nota]] para ligar a notas que existem. Nunca leia o markdown em voz alta.
- Para ler ou resumir uma nota, use ler_arquivo. Para mostrar um arquivo ou a pasta, use abrir_arquivo.

# Contexto
- Agora é ${nowLabel()} (fuso de São Paulo).
- O que você sabe sobre o usuário:
${memoryBlock}`;
}

async function buildSession() {
  return {
    type: "realtime",
    model: config.model,
    instructions: await buildInstructions(),
    audio: {
      input: {
        noise_reduction: { type: "near_field" },
        transcription: { model: "gpt-4o-mini-transcribe", language: "pt" },
        turn_detection: { type: "semantic_vad", eagerness: "auto" },
      },
      output: { voice: config.voice, speed: config.speed },
    },
    tools: TOOLS,
    tool_choice: "auto",
  };
}

// ---------------------------------------------------------------------------
// Ferramentas executadas no servidor
// ---------------------------------------------------------------------------

const WEATHER_CODES = {
  0: "céu limpo", 1: "predominantemente limpo", 2: "parcialmente nublado", 3: "nublado",
  45: "neblina", 48: "neblina com geada",
  51: "garoa fraca", 53: "garoa", 55: "garoa forte", 56: "garoa congelante", 57: "garoa congelante forte",
  61: "chuva fraca", 63: "chuva", 65: "chuva forte", 66: "chuva congelante", 67: "chuva congelante forte",
  71: "neve fraca", 73: "neve", 75: "neve forte", 77: "grãos de neve",
  80: "pancadas de chuva fracas", 81: "pancadas de chuva", 82: "pancadas de chuva fortes",
  85: "pancadas de neve", 86: "pancadas de neve fortes",
  95: "trovoadas", 96: "trovoadas com granizo", 99: "trovoadas com granizo forte",
};

async function getJSON(url, init) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

const serverTools = {
  ...noteTools,
  ...macTools,
  ...clickup.tools,
  async obter_clima({ cidade }) {
    if (!cidade) throw new Error("Cidade não informada.");
    const geo = await getJSON(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cidade)}&count=1&language=pt`
    );
    const place = geo.results?.[0];
    if (!place) return { erro: `Não encontrei a cidade "${cidade}".` };

    const forecast = await getJSON(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
        "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
        "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
        "&timezone=auto&forecast_days=1"
    );
    const c = forecast.current;
    const d = forecast.daily;
    return {
      local: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
      agora: {
        condicao: WEATHER_CODES[c.weather_code] ?? "indefinido",
        temperatura_c: c.temperature_2m,
        sensacao_c: c.apparent_temperature,
        umidade_pct: c.relative_humidity_2m,
        vento_kmh: c.wind_speed_10m,
      },
      hoje: {
        minima_c: d.temperature_2m_min?.[0],
        maxima_c: d.temperature_2m_max?.[0],
        chance_chuva_pct: d.precipitation_probability_max?.[0],
      },
    };
  },

  async pesquisar_web({ consulta }) {
    if (!consulta) throw new Error("Consulta vazia.");
    const body = await getJSON("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.webSearchModel,
        tools: [{ type: "web_search" }],
        reasoning: { effort: "low" },
        instructions:
          `Hoje é ${nowLabel()}. Responda em português do Brasil, de forma objetiva e factual, ` +
          "em no máximo 6 frases, pronto para ser lido em voz alta. Inclua números e datas relevantes.",
        input: consulta,
      }),
    });
    const message = body.output?.find((item) => item.type === "message");
    const part = message?.content?.find((c) => c.type === "output_text");
    if (!part?.text) return { erro: "A pesquisa não retornou resultado." };
    const fontes = [
      ...new Map(
        (part.annotations || [])
          .filter((a) => a.type === "url_citation")
          .map((a) => [a.url, { titulo: a.title, url: a.url }])
      ).values(),
    ].slice(0, 5);
    // Texto vai ser falado: tira links e marcação de markdown.
    const resposta = part.text
      .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`#]+/g, "")
      .replace(/\s+\n/g, "\n")
      .trim();
    return { resposta, fontes };
  },

  async resumo_do_dia({ cidade = "São Paulo", noticias_sobre = "" }) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());
    const settle = (p) => p.then((v) => v, (err) => ({ erro: err.message }));
    const [clima, agenda, lembretes, noticias] = await Promise.all([
      settle(serverTools.obter_clima({ cidade })),
      settle(helper("agenda", {})),
      settle(helper("lembretes", { ate: `${today}T23:59` })),
      config.apiKey
        ? settle(
            serverTools.pesquisar_web({
              consulta: `Principais notícias de hoje no Brasil${noticias_sobre ? ` e sobre ${noticias_sobre}` : ""}. Liste 4 manchetes com uma frase cada.`,
            })
          )
        : { erro: "sem chave" },
    ]);
    return { agora: nowLabel(), clima, agenda, lembretes, noticias: noticias.resposta ? { resumo: noticias.resposta } : noticias };
  },

  async lembrar({ fato }) {
    if (!fato?.trim()) throw new Error("Nada para lembrar.");
    const items = await loadMemory();
    items.push({ id: randomUUID(), text: fato.trim(), createdAt: new Date().toISOString() });
    await saveMemory(items);
    return { ok: true, total_memorias: items.length };
  },

  async esquecer({ termo }) {
    const needle = termo?.trim().toLowerCase();
    if (!needle) throw new Error("Termo vazio.");
    const items = await loadMemory();
    const kept = items.filter((m) => !m.text.toLowerCase().includes(needle));
    await saveMemory(kept);
    return { apagadas: items.length - kept.length };
  },

  async abrir_site({ url }) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { erro: "URL inválida." };
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return { erro: "Só abro links http ou https." };
    const opener =
      process.platform === "darwin" ? ["open", [parsed.href]]
      : process.platform === "win32" ? ["cmd", ["/c", "start", "", parsed.href]]
      : ["xdg-open", [parsed.href]];
    spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).unref();
    return { ok: true, aberto: parsed.href };
  },
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Corpo da requisição muito grande."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function handleSession(req, res) {
  if (!config.apiKey) {
    return sendJSON(res, 401, { error: "Configure sua chave da OpenAI nos ajustes.", code: "missing_key" });
  }
  const sdp = await readBody(req);
  if (!sdp.startsWith("v=")) return sendJSON(res, 400, { error: "Oferta SDP inválida." });

  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(await buildSession()));

  const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await upstream.text();
  if (!upstream.ok) {
    let message = text;
    try {
      message = JSON.parse(text)?.error?.message || text;
    } catch {}
    console.error(`[session] ${upstream.status}: ${message}`);
    return sendJSON(res, upstream.status, { error: message });
  }
  res.writeHead(200, { "Content-Type": "application/sdp", "Cache-Control": "no-store" });
  res.end(text);
}

async function handleTool(req, res, name) {
  const tool = serverTools[name];
  if (!tool) return sendJSON(res, 404, { error: `Ferramenta desconhecida: ${name}` });
  if (name === "pesquisar_web" && !config.apiKey) return sendJSON(res, 500, { error: "Chave da OpenAI ausente. Configure em Ajustes." });
  let args = {};
  try {
    args = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJSON(res, 400, { error: "Argumentos inválidos." });
  }
  const started = Date.now();
  try {
    const result = await tool(args);
    console.log(`[tool] ${name} ${Date.now() - started}ms`);
    sendJSON(res, 200, result);
  } catch (err) {
    if (err.code === "sem_cerebro") {
      return sendJSON(res, 200, { erro: "sem_cerebro", dica: "O segundo cérebro ainda não existe. Pergunte se o usuário quer criar agora." });
    }
    console.error(`[tool] ${name} falhou: ${err.message}`);
    sendJSON(res, 502, { erro: err.message });
  }
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + sep)) return sendJSON(res, 403, { error: "Proibido." });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    sendJSON(res, 404, { error: "Não encontrado." });
  }
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl/ferramentas locais não mandam Origin
  try {
    const { hostname, port } = new URL(origin);
    return ["localhost", "127.0.0.1"].includes(hostname) && Number(port) === server.address()?.port;
  } catch {
    return false;
  }
}

function publicConfig() {
  return { hasKey: Boolean(config.apiKey), key: maskKey(config.apiKey), voice: config.voice, speed: config.speed, voices: VOICES, vaultPath: vaultPath(), clickup: maskKey(config.clickupToken), wake: config.wake, userName: config.userName };
}

async function handleConfig(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req, 10_000));
  } catch {
    return sendJSON(res, 400, { error: "JSON inválido." });
  }
  const changes = {};
  if (typeof body.apiKey === "string" && body.apiKey.trim()) {
    const key = body.apiKey.trim();
    if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) return sendJSON(res, 400, { error: "Essa não parece uma chave da OpenAI (começa com sk-)." });
    changes.apiKey = key;
  }
  if (typeof body.clickupToken === "string" && body.clickupToken.trim()) {
    const token = body.clickupToken.trim();
    if (!/^pk_[A-Za-z0-9_]{10,}$/.test(token)) return sendJSON(res, 400, { error: "O token pessoal do ClickUp começa com pk_." });
    changes.clickupToken = token;
  }
  if (body.removeClickup === true) changes.clickupToken = null;
  if (typeof body.userName === "string") {
    // Vai para as instruções do modelo: uma linha curta, sem quebras nem símbolos de marcação.
    changes.userName = body.userName.replace(/[\r\n\t#`*_<>{}\[\]$\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  }
  if (typeof body.wake === "boolean") changes.wake = body.wake;
  if (body.voice !== undefined) {
    if (!VOICES.includes(body.voice)) return sendJSON(res, 400, { error: "Voz inválida." });
    changes.voice = body.voice;
  }
  if (body.speed !== undefined) changes.speed = clampSpeed(body.speed);
  if (typeof body.vaultPath === "string" && body.vaultPath.trim() && body.vaultPath.trim() !== vaultPath()) {
    try {
      await setupVault(body.vaultPath.trim());
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
  }
  try {
    if (Object.keys(changes).length) await settings.update(changes);
  } catch (err) {
    return sendJSON(res, 500, { error: `Não consegui salvar: ${err.message}` });
  }
  sendJSON(res, 200, publicConfig());
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    // Só a própria interface pode chamar a API local: bloqueia sites externos
    // abertos no navegador tentando usar o servidor em localhost.
    if (req.method === "POST" && !isSameOrigin(req)) return sendJSON(res, 403, { error: "Origem não permitida." });
    if (req.method === "GET" && pathname === "/config") return sendJSON(res, 200, publicConfig());
    if (req.method === "POST" && pathname === "/config") return await handleConfig(req, res);
    if (req.method === "POST" && pathname === "/session") return await handleSession(req, res);
    if (req.method === "POST" && pathname.startsWith("/tools/")) {
      return await handleTool(req, res, pathname.slice("/tools/".length));
    }
    if (req.method === "GET" && pathname === "/memory") return sendJSON(res, 200, await loadMemory());
    if (req.method === "GET" || req.method === "HEAD") return await serveStatic(req, res, pathname);
    sendJSON(res, 405, { error: "Método não permitido." });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJSON(res, 500, { error: err.message });
  }
});

export const ready = new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", () => {
    const { port } = server.address();
    console.log(`\n  J.A.R.V.I.S. online → http://localhost:${port}`);
    console.log(`  modelo: ${config.model} · voz: ${config.voice} · velocidade: ${config.speed}`);
    if (config.apiKey) console.log(`  chave: ${maskKey(config.apiKey)}`);
    else console.warn("  ⚠ Sem chave da OpenAI — abra os Ajustes do Jarvis e cole a chave.\n");
    resolve(port);
  });
});
