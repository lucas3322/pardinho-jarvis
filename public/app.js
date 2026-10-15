// J.A.R.V.I.S. — cliente de voz.
// Conecta o navegador à OpenAI Realtime API por WebRTC (via /session no
// servidor local), desenha o orb e executa as ferramentas que o modelo chama.

import { Orb } from "./orb.js";

const $ = (id) => document.getElementById(id);
const ui = {
  stage: $("stage"),
  status: $("status"),
  caption: $("caption"),
  tool: $("tool"),
  toolLabel: $("tool-label"),
  connLabel: $("connection-label"),
  power: $("btn-power"),
  mute: $("btn-mute"),
  logBtn: $("btn-log"),
  logClose: $("btn-log-close"),
  log: $("log"),
  logList: $("log-list"),
  composer: $("composer"),
  input: $("composer-input"),
  send: $("composer-send"),
  toast: $("toast"),
};

const orb = new Orb($("orb"));
// ?debug expõe o orb no console para testar estados sem conectar.
if (new URLSearchParams(location.search).has("debug")) window.orb = orb;

const LABELS = {
  idle: "Toque para começar",
  connecting: "Conectando",
  listening: "Ouvindo",
  thinking: "Pensando",
  speaking: "Falando",
  error: "Algo deu errado",
};

const session = {
  pc: null,
  dc: null,
  mic: null,
  audioEl: null,
  audioCtx: null,
  live: false,
  starting: false,
  muted: false,
  responseActive: false,
  responseQueued: false,
  endAfterSpeech: false,
  endTimer: 0,
  handledCalls: new Set(),
  userItems: new Map(),      // item_id → { el, text }
  assistantItems: new Map(), // item_id → { el, text }
  pendingTools: 0,
  // "Ei, Jarvis": conversa iniciada pela voz, aguardando o comando falado.
  fromWake: false,
  wakeCommand: null,
  wakeTimer: 0,
};

let state = "idle";

// ---------------------------------------------------------------------------
// Estado visual
// ---------------------------------------------------------------------------

function setState(next) {
  state = next;
  document.body.dataset.state = next;
  orb.setState(next === "connecting" ? "thinking" : next);
  const dictating = document.body.classList.contains("dictating") && next === "listening";
  ui.status.textContent =
    session.muted && next === "listening" ? "Microfone mudo" : dictating ? "Ditado · pode falar" : LABELS[next];
}

function setCaption(text, who) {
  const clean = (text || "").trim();
  // Mostra o final da fala — é o que está sendo dito agora.
  let shown = clean;
  if (clean.length > 150) {
    const tail = clean.slice(-150);
    shown = "…" + tail.slice(tail.indexOf(" ") + 1);
  }
  ui.caption.textContent = shown;
  ui.caption.classList.toggle("user", who === "user");
}

let toastTimer = 0;
function toast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast.hidden = true), 7000);
}

function setControls(live) {
  document.body.classList.toggle("live", live);
  ui.mute.disabled = !live;
  ui.input.disabled = !live;
  ui.send.disabled = !live;
  ui.power.setAttribute("aria-label", live ? "Encerrar conversa" : "Iniciar conversa");
  ui.stage.setAttribute("aria-label", live ? "Encerrar conversa com o Jarvis" : "Iniciar conversa com o Jarvis");
  ui.connLabel.textContent = live ? "Online" : "Offline";
  // Com comando de voz pendente, o detector segue ouvindo até entregar o comando.
  if (!(live && session.fromWake)) window.jarvisDesktop?.setLive(live);
}

// ---------------------------------------------------------------------------
// Registro da conversa
// ---------------------------------------------------------------------------

function addLog(kind, text = "") {
  const li = document.createElement("li");
  li.className = `msg ${kind}`;
  li.textContent = text;
  ui.logList.append(li);
  scrollLog();
  return li;
}

function scrollLog() {
  ui.logList.scrollTop = ui.logList.scrollHeight;
}

function addSources(fontes) {
  if (!fontes?.length) return;
  const li = addLog("tool");
  li.append("Fontes: ");
  fontes.forEach((f, i) => {
    const a = document.createElement("a");
    a.href = f.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = f.titulo || new URL(f.url).hostname;
    li.append(a);
    if (i < fontes.length - 1) li.append(" · ");
  });
}

function addFileLink(local, caminho, backup) {
  const li = addLog("tool");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "file-link";
  btn.textContent = caminho;
  btn.title = "Abrir arquivo";
  btn.addEventListener("click", () => {
    fetch("/tools/abrir_arquivo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ local, caminho }),
    });
  });
  li.append("Salvo em ", btn);
  if (backup) li.append(` · versão anterior em ${backup}`);
}

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

function send(event) {
  if (session.dc?.readyState === "open") session.dc.send(JSON.stringify(event));
}

// Só pode haver uma resposta ativa por vez; se houver, agenda para quando terminar.
function requestResponse(extra) {
  if (session.responseActive) {
    session.responseQueued = true;
    return;
  }
  send(extra ? { type: "response.create", response: extra } : { type: "response.create" });
}

function friendlyError(err) {
  if (err?.name === "NotAllowedError") return "Permita o acesso ao microfone para conversar com o Jarvis.";
  if (err?.name === "NotFoundError") return "Nenhum microfone encontrado.";
  if (/credits|quota/i.test(err?.message || "")) {
    return "Sua conta da OpenAI está sem créditos. Adicione em platform.openai.com/settings/organization/billing e toque de novo.";
  }
  if (/api key/i.test(err?.message || "")) return "Chave da OpenAI inválida. Confira a chave em Ajustes.";
  return err?.message || "Não foi possível conectar.";
}

async function start() {
  if (session.live || session.starting) return;
  session.starting = true;
  setState("connecting");
  ui.connLabel.textContent = "Conectando";

  try {
    // AudioContext criado no gesto do usuário para não nascer suspenso.
    const audioCtx = new AudioContext();
    session.audioCtx = audioCtx;
    await audioCtx.resume();

    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    session.mic = mic;
    // Aberta por "Ei, Jarvis": o microfone da conversa fica mudo até o comando
    // falado chegar do detector, senão a mesma frase seria ouvida duas vezes.
    mic.getAudioTracks()[0].enabled = !session.muted && !session.fromWake;
    orb.setAnalyser("mic", makeAnalyser(audioCtx, mic));

    const pc = new RTCPeerConnection();
    session.pc = pc;

    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    session.audioEl = audioEl;
    pc.ontrack = (e) => {
      audioEl.srcObject = e.streams[0];
      orb.setAnalyser("out", makeAnalyser(audioCtx, e.streams[0]));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") fail(new Error("A conexão com o Jarvis caiu."));
    };

    pc.addTrack(mic.getAudioTracks()[0], mic);

    const dc = pc.createDataChannel("oai-events");
    session.dc = dc;
    dc.addEventListener("open", onOpen);
    dc.addEventListener("message", (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch (err) {
        console.error("Evento inválido", err);
      }
    });
    dc.addEventListener("close", () => {
      if (session.live) fail(new Error("A sessão foi encerrada pelo servidor."));
    });

    await pc.setLocalDescription(await pc.createOffer());
    const res = await fetch("/session", {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: pc.localDescription.sdp,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error || `Falha ao iniciar a sessão (HTTP ${res.status}).`);
      err.code = body.code;
      throw err;
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
  } catch (err) {
    fail(err);
  } finally {
    session.starting = false;
  }
}

function makeAnalyser(ctx, stream) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.6;
  ctx.createMediaStreamSource(stream).connect(analyser);
  return analyser;
}

function onOpen() {
  session.live = true;
  setControls(true);
  setState("listening");
  setCaption("");
  if (session.fromWake) {
    deliverWakeCommand();
    return;
  }
  // Sem "instructions" aqui: elas substituiriam as da sessão (sotaque, tom).
  requestResponse();
}

// Conversa aberta por "Ei, Jarvis, …": o que foi dito depois do nome vira a
// primeira mensagem. Se não veio nada em 4 s, ele só cumprimenta.
function deliverWakeCommand() {
  if (!session.fromWake || !session.live) return;
  if (session.wakeCommand === null) {
    clearTimeout(session.wakeTimer);
    session.wakeTimer = setTimeout(() => {
      if (session.wakeCommand === null) session.wakeCommand = "";
      deliverWakeCommand();
    }, 4000);
    return;
  }
  clearTimeout(session.wakeTimer);
  const text = session.wakeCommand.trim();
  session.fromWake = false;
  session.wakeCommand = null;
  // Comando entregue: a conversa assume o microfone e o detector pausa.
  const track = session.mic?.getAudioTracks()[0];
  if (track) track.enabled = !session.muted;
  window.jarvisDesktop?.setLive(true);
  if (!text) {
    requestResponse();
    return;
  }
  addLog("user", text);
  setCaption(text, "user");
  send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  requestResponse();
}

function teardown() {
  clearTimeout(session.endTimer);
  clearTimeout(session.wakeTimer);
  session.fromWake = false;
  session.wakeCommand = null;
  session.live = false;
  try { session.dc?.close(); } catch {}
  session.pc?.getSenders().forEach((s) => s.track?.stop());
  try { session.pc?.close(); } catch {}
  session.mic?.getTracks().forEach((t) => t.stop());
  if (session.audioEl) session.audioEl.srcObject = null;
  session.audioCtx?.close().catch(() => {});
  orb.setAnalyser("mic", null);
  orb.setAnalyser("out", null);
  Object.assign(session, {
    pc: null, dc: null, mic: null, audioEl: null, audioCtx: null,
    responseActive: false, responseQueued: false, endAfterSpeech: false, pendingTools: 0,
  });
  session.handledCalls.clear();
  session.userItems.clear();
  session.assistantItems.clear();
  ui.tool.hidden = true;
  document.body.classList.remove("dictating");
  setControls(false);
}

function stop() {
  teardown();
  setState("idle");
  setCaption("");
}

function fail(err) {
  console.error(err);
  teardown();
  if (err?.code === "missing_key") {
    setState("idle");
    openSettings("Cole sua chave da OpenAI para começar.");
    return;
  }
  setState("error");
  setCaption("");
  toast(friendlyError(err));
  setTimeout(() => state === "error" && setState("idle"), 4000);
}

// ---------------------------------------------------------------------------
// Eventos da Realtime API
// ---------------------------------------------------------------------------

function onEvent(ev) {
  switch (ev.type) {
    case "input_audio_buffer.speech_started": {
      setState("listening");
      setCaption("", "user");
      if (ev.item_id && !session.userItems.has(ev.item_id)) {
        session.userItems.set(ev.item_id, { el: addLog("user", "…"), text: "" });
      }
      break;
    }
    case "input_audio_buffer.speech_stopped":
      setState("thinking");
      break;

    case "conversation.item.input_audio_transcription.delta": {
      const item = session.userItems.get(ev.item_id);
      if (!item) break;
      item.text += ev.delta || "";
      item.el.textContent = item.text;
      if (state !== "speaking") setCaption(item.text, "user");
      break;
    }
    case "conversation.item.input_audio_transcription.completed": {
      const item = session.userItems.get(ev.item_id);
      const text = (ev.transcript || "").trim();
      if (!item) break;
      if (text) {
        item.text = text;
        item.el.textContent = text;
        if (state !== "speaking") setCaption(text, "user");
      } else {
        item.el.remove();
      }
      break;
    }

    case "response.created":
      session.responseActive = true;
      if (state !== "speaking") setState("thinking");
      break;

    case "output_audio_buffer.started":
      setState("speaking");
      break;
    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared":
      if (session.endAfterSpeech) return stop();
      if (state === "speaking") setState(session.pendingTools ? "thinking" : "listening");
      break;

    case "response.output_audio_transcript.delta": {
      let item = session.assistantItems.get(ev.item_id);
      if (!item) {
        item = { el: addLog("assistant"), text: "" };
        session.assistantItems.set(ev.item_id, item);
      }
      item.text += ev.delta || "";
      item.el.textContent = item.text;
      scrollLog();
      setCaption(item.text, "assistant");
      break;
    }
    case "response.output_audio_transcript.done": {
      const item = session.assistantItems.get(ev.item_id);
      if (item && ev.transcript) item.el.textContent = item.text = ev.transcript;
      break;
    }

    case "response.done":
      onResponseDone(ev.response);
      break;

    case "error":
      console.error("Realtime error:", ev.error);
      // Cancelar sem resposta ativa não é um problema real.
      if (ev.error?.code !== "response_cancel_not_active") toast(ev.error?.message || "Erro na sessão.");
      break;
  }
}

function onResponseDone(response) {
  session.responseActive = false;

  if (response?.status === "failed") {
    const message = response.status_details?.error?.message;
    toast(message || "O Jarvis não conseguiu responder.");
  }

  const calls = (response?.output || []).filter(
    (o) => o.type === "function_call" && !session.handledCalls.has(o.call_id)
  );
  if (calls.length) {
    calls.forEach((c) => session.handledCalls.add(c.call_id));
    runTools(calls);
  }

  if (session.responseQueued) {
    session.responseQueued = false;
    requestResponse();
  } else if (state === "thinking" && !calls.length && !session.pendingTools) {
    // Resposta sem áudio (ex.: cancelada): volta a ouvir.
    setState("listening");
  }
}

// ---------------------------------------------------------------------------
// Ferramentas
// ---------------------------------------------------------------------------

const PLACES = { cerebro: "o segundo cérebro", mesa: "a Mesa", documentos: "Documentos", downloads: "Downloads" };
const placeName = (local) => PLACES[local] || PLACES.cerebro;

function toolLabel(name, args) {
  switch (name) {
    case "obter_clima": return `Consultando o clima · ${args.cidade ?? ""}`;
    case "pesquisar_web": return `Pesquisando · ${args.consulta ?? ""}`;
    case "lembrar": return "Guardando na memória";
    case "esquecer": return "Apagando da memória";
    case "abrir_site": {
      try { return `Abrindo ${new URL(args.url).hostname}`; } catch { return "Abrindo site"; }
    }
    case "data_hora": return "Verificando a hora";
    case "modo_ditado": return args.ativo ? "Modo ditado ligado" : "Modo ditado desligado";
    case "configurar_segundo_cerebro": return "Criando o segundo cérebro";
    case "listar_arquivos": return args.busca ? `Procurando · ${args.busca}` : `Olhando ${placeName(args.local)}${args.pasta ? ` › ${args.pasta}` : ""}`;
    case "ler_arquivo": return `Lendo · ${args.caminho ?? ""}`;
    case "criar_arquivo": return `Criando · ${args.titulo ?? ""}`;
    case "atualizar_arquivo": return `Atualizando · ${args.caminho ?? ""}`;
    case "anotar_no_diario": return "Anotando no diário";
    case "abrir_arquivo": return `Abrindo ${args.caminho || placeName(args.local)}`;
    case "ver_tela": return "Olhando sua tela";
    case "ver_agenda": return "Consultando a agenda";
    case "ver_lembretes": return "Consultando os lembretes";
    case "criar_lembrete": return `Criando lembrete · ${args.titulo ?? ""}`;
    case "concluir_lembrete": return `Concluindo · ${args.titulo ?? ""}`;
    case "criar_evento": return `Agendando · ${args.titulo ?? ""}`;
    case "resumo_do_dia": return "Montando seu resumo do dia";
    case "abrir_app": return `Abrindo ${args.nome ?? ""}`;
    case "fechar_app": return `Fechando ${args.nome ?? ""}`;
    case "volume": return "Ajustando o volume";
    case "musica": return args.acao === "buscar" ? `Buscando · ${args.busca ?? ""}` : "Controlando a música";
    case "modo_escuro": return "Mudando a aparência";
    case "atalhos": return args.acao === "executar" ? `Rodando atalho · ${args.nome ?? ""}` : "Vendo seus atalhos";
    case "clickup_tarefas": return "Consultando o ClickUp";
    case "clickup_listas": return "Vendo as listas do ClickUp";
    case "clickup_criar_tarefa": return `Criando tarefa · ${args.titulo ?? ""}`;
    case "clickup_atualizar_tarefa": return `Atualizando tarefa · ${args.tarefa ?? ""}`;
    case "revisar_inbox": return "Revisando seu Inbox";
    case "mover_arquivo": return `Movendo · ${args.caminho ?? ""}`;
    case "encerrar_conversa": return "Encerrando";
    default: return name;
  }
}

// O data channel do WebRTC tem limite de tamanho por mensagem: reduz a
// resolução e a qualidade do JPEG até a captura caber.
async function fitImage(dataURL) {
  const limit = Math.min(session.pc?.sctp?.maxMessageSize || 262144, 1_000_000) - 8192;
  const bitmap = await createImageBitmap(await (await fetch(dataURL)).blob());
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  for (const width of [1600, 1280, 1024, 800, 640]) {
    const w = Math.min(width, bitmap.width);
    canvas.width = w;
    canvas.height = Math.round((bitmap.height * w) / bitmap.width);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const q of [0.8, 0.65, 0.5]) {
      const out = canvas.toDataURL("image/jpeg", q);
      if (out.length < limit) return out;
    }
  }
  throw new Error("A captura ficou grande demais para enviar.");
}

async function captureScreen() {
  const result = window.jarvisDesktop
    ? await window.jarvisDesktop.captureScreen()
    : await (await fetch("/tools/capturar_tela", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  if (!result?.imagem) return result || { erro: "falha" };
  return { ok: true, nota: "A captura da tela foi anexada logo a seguir, como imagem.", _imagem: await fitImage(result.imagem) };
}

async function callTool(name, args) {
  if (name === "ver_tela") return captureScreen();
  if (name === "data_hora") {
    return {
      agora: new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeStyle: "short" }).format(new Date()),
    };
  }
  if (name === "modo_ditado") {
    // Ditado: espera pausas maiores antes de considerar que o usuário terminou.
    send({
      type: "session.update",
      session: {
        type: "realtime",
        audio: { input: { turn_detection: { type: "semantic_vad", eagerness: args.ativo ? "low" : "auto" } } },
      },
    });
    document.body.classList.toggle("dictating", Boolean(args.ativo));
    return { ok: true, ativo: Boolean(args.ativo) };
  }
  if (name === "encerrar_conversa") {
    session.endAfterSpeech = true;
    // Se a despedida não gerar áudio, encerra mesmo assim.
    session.endTimer = setTimeout(() => session.live && stop(), 12000);
    return { ok: true };
  }
  const res = await fetch(`/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return res.json().catch(() => ({ erro: `HTTP ${res.status}` }));
}

async function runTools(calls) {
  session.pendingTools += calls.length;
  if (state !== "speaking") setState("thinking");

  const results = await Promise.all(
    calls.map(async (call) => {
      let args = {};
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {}
      const label = toolLabel(call.name, args);
      ui.toolLabel.textContent = label;
      ui.tool.hidden = false;
      addLog("tool", label);

      let output;
      try {
        output = await callTool(call.name, args);
      } catch (err) {
        output = { erro: err.message || "Falha ao executar a ferramenta." };
      }
      if (output?.erro) addLog("tool", `⚠ ${output.mensagem || output.erro}`);
      if (call.name === "pesquisar_web") addSources(output?.fontes);
      if (["criar_arquivo", "atualizar_arquivo", "anotar_no_diario"].includes(call.name) && output?.ok) {
        addFileLink(args.local || "cerebro", output.caminho, output.backup);
      }
      return { call, output };
    })
  );

  session.pendingTools -= calls.length;
  if (!session.pendingTools) ui.tool.hidden = true;
  if (!session.live) return;

  const images = [];
  for (const { call, output } of results) {
    // A imagem vai como mensagem própria; o resultado da função leva só o texto.
    const { _imagem, ...rest } = output || {};
    if (_imagem) images.push({ image: _imagem });
    send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(rest) },
    });
  }
  for (const { image } of images) {
    send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Captura da minha tela agora:" },
          { type: "input_image", image_url: image },
        ],
      },
    });
  }
  requestResponse();
}

// ---------------------------------------------------------------------------
// Interações
// ---------------------------------------------------------------------------

function toggle() {
  if (session.live) stop();
  else start();
}

ui.stage.addEventListener("click", toggle);
ui.power.addEventListener("click", toggle);

ui.mute.addEventListener("click", () => {
  session.muted = !session.muted;
  ui.mute.setAttribute("aria-pressed", String(session.muted));
  ui.mute.setAttribute("aria-label", session.muted ? "Ativar microfone" : "Silenciar microfone");
  const track = session.mic?.getAudioTracks()[0];
  if (track) track.enabled = !session.muted;
  setState(state);
});

function setLog(open) {
  document.body.classList.toggle("log-open", open);
  ui.log.inert = !open;
  ui.logBtn.setAttribute("aria-expanded", String(open));
  if (open) {
    scrollLog();
    if (!ui.input.disabled && matchMedia("(pointer: fine)").matches) ui.input.focus();
  } else {
    ui.logBtn.focus();
  }
}
ui.logBtn.addEventListener("click", () => setLog(!document.body.classList.contains("log-open")));
ui.logClose.addEventListener("click", () => setLog(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("log-open")) setLog(false);
});

ui.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = ui.input.value.trim();
  if (!text || !session.live) return;
  ui.input.value = "";
  addLog("user", text);
  // Se o Jarvis estiver falando, interrompe para responder ao texto.
  if (session.responseActive) send({ type: "response.cancel" });
  if (state === "speaking") send({ type: "output_audio_buffer.clear" });
  send({
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
  requestResponse();
});

window.addEventListener("pagehide", () => session.live && teardown());

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

const settings = {
  dialog: $("settings"),
  form: $("settings-form"),
  key: $("set-key"),
  keyHint: $("set-key-hint"),
  voice: $("set-voice"),
  speed: $("set-speed"),
  vault: $("set-vault"),
  name: $("set-name"),
  clickup: $("set-clickup"),
  wakeRow: $("set-wake-row"),
  wake: $("set-wake"),
  clickupHint: $("set-clickup-hint"),
  vaultPick: $("set-vault-pick"),
  speedOut: $("set-speed-out"),
  error: $("settings-error"),
  save: $("settings-save"),
};

const VOICE_NOTES = { marin: "suave e natural", cedar: "grave e calma" };

function renderConfig(cfg) {
  settings.key.value = "";
  settings.key.placeholder = cfg.hasKey ? `${cfg.key} (configurada)` : "sk-…";
  settings.keyHint.textContent = cfg.hasKey
    ? "Deixe em branco para manter a atual."
    : "Crie em platform.openai.com/api-keys. Fica salva só neste computador.";
  settings.voice.replaceChildren(
    ...cfg.voices.map((v) => {
      const label = v[0].toUpperCase() + v.slice(1);
      return new Option(VOICE_NOTES[v] ? `${label} — ${VOICE_NOTES[v]}` : label, v, false, v === cfg.voice);
    })
  );
  settings.vault.value = cfg.vaultPath || "";
  settings.name.value = cfg.userName || "";
  settings.wake.checked = Boolean(cfg.wake);
  settings.clickup.value = "";
  settings.clickup.placeholder = cfg.clickup ? `${cfg.clickup} (conectado)` : "pk_…";
  settings.clickupHint.textContent = cfg.clickup
    ? "Deixe em branco para manter o atual."
    : "Opcional. Gere no ClickUp em Ajustes → Apps → API Token.";
  settings.speed.value = cfg.speed;
  settings.speedOut.textContent = `${Number(cfg.speed).toFixed(2)}×`;
}

async function openSettings(message = "") {
  settings.error.textContent = message;
  try {
    renderConfig(await (await fetch("/config")).json());
  } catch {
    settings.error.textContent = "Não consegui ler os ajustes.";
  }
  if (!settings.dialog.open) settings.dialog.showModal();
  if (!settings.key.placeholder.includes("configurada")) settings.key.focus();
}

settings.speed.addEventListener("input", () => {
  settings.speedOut.textContent = `${Number(settings.speed.value).toFixed(2)}×`;
});

settings.form.addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") return; // fechar
  e.preventDefault();
  settings.save.disabled = true;
  settings.error.textContent = "";
  try {
    const body = { voice: settings.voice.value, speed: Number(settings.speed.value), userName: settings.name.value };
    if (window.jarvisDesktop) body.wake = settings.wake.checked;
    if (settings.key.value.trim()) body.apiKey = settings.key.value.trim();
    if (settings.vault.value.trim()) body.vaultPath = settings.vault.value.trim();
    if (settings.clickup.value.trim()) body.clickupToken = settings.clickup.value.trim();
    const res = await fetch("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Não foi possível salvar.");
    renderConfig(data);
    if (window.jarvisDesktop) applyWake(data.wake);
    settings.dialog.close();
  } catch (err) {
    settings.error.textContent = err.message;
  } finally {
    settings.save.disabled = false;
  }
});

$("btn-settings").addEventListener("click", () => openSettings());

// ---------------------------------------------------------------------------
// App desktop (Electron): atalho global liga/desliga a conversa
// ---------------------------------------------------------------------------

// Som curto e suave quando ouve "Jarvis": confirma que ouviu, sem precisar olhar.
function chime() {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    [660, 990].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.09;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    });
    setTimeout(() => ctx.close(), 600);
  } catch {}
}

function applyWake(enabled) {
  window.jarvisDesktop.setWake(Boolean(enabled));
  const key = window.jarvisDesktop.shortcut;
  LABELS.idle = enabled ? `Diga “Jarvis” ou toque` : `Toque ou ${key} para começar`;
  if (state === "idle") setState("idle");
}

if (window.jarvisDesktop) {
  document.body.classList.add("desktop");
  settings.wakeRow.hidden = false;
  LABELS.idle = `Toque ou ${window.jarvisDesktop.shortcut} para começar`;
  setState(state);
  fetch("/config").then((r) => r.json()).then((cfg) => applyWake(cfg.wake)).catch(() => {});

  window.jarvisDesktop.onWake(() => {
    if (session.live || session.starting) return;
    chime();
    session.fromWake = true;
    session.wakeCommand = null;
    start();
  });
  window.jarvisDesktop.onWakeCommand((text) => {
    if (!session.fromWake) return;
    session.wakeCommand = text;
    deliverWakeCommand();
  });
  window.jarvisDesktop.onWakeError((message) => toast(message));
  window.jarvisDesktop.onToggle(() => toggle());
  settings.vaultPick.hidden = false;
  settings.vaultPick.addEventListener("click", async () => {
    const folder = await window.jarvisDesktop.chooseFolder(settings.vault.value);
    if (folder) settings.vault.value = folder;
  });
}

setState("idle");
