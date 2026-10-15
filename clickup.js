// ClickUp via API REST v2 com token pessoal (pk_…).
// O MCP oficial do ClickUp exige login OAuth e limita chamadas por dia;
// a API com token pessoal não tem limite diário.

const BASE = "https://api.clickup.com/api/v2";
const PRIORITY = { urgente: 1, alta: 2, normal: 3, baixa: 4 };
const PRIORITY_NAME = { 1: "urgente", 2: "alta", 3: "normal", 4: "baixa" };

const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function localStamp(ms) {
  if (!ms) return null;
  const d = new Date(Number(ms));
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// "2026-10-14T15:00" (hora local do Mac) ou "2026-10-14" (dia, sem hora).
function parseDue(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const d = new Date(dateOnly ? `${s}T12:00` : s);
  if (Number.isNaN(d.getTime())) throw new Error(`Data inválida: ${s}. Use AAAA-MM-DDTHH:MM.`);
  return { due_date: d.getTime(), due_date_time: !dateOnly };
}

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function createClickUp(getToken) {
  let me = null;
  let team = null;
  let lists = null;
  let listsAt = 0;
  let cachedFor = null;

  async function api(path, { method = "GET", query, body } = {}) {
    const token = getToken();
    if (!token) {
      const err = new Error("ClickUp não configurado.");
      err.code = "sem_token";
      throw err;
    }
    // Trocou o token: descarta o que foi descoberto com o anterior.
    if (cachedFor !== token) {
      me = team = lists = null;
      cachedFor = token;
    }
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(`${k}[]`, x));
      else if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method,
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      const err = new Error("Token do ClickUp inválido.");
      err.code = "token_invalido";
      throw err;
    }
    if (!res.ok) throw new Error(data.err || data.error || `ClickUp respondeu HTTP ${res.status}`);
    return data;
  }

  async function whoAmI() {
    if (!me) me = (await api("/user")).user;
    return me;
  }

  async function workspace() {
    if (!team) {
      const { teams = [] } = await api("/team");
      if (!teams.length) throw new Error("Nenhum workspace no ClickUp.");
      team = teams[0];
    }
    return team;
  }

  async function allLists() {
    if (lists && Date.now() - listsAt < 10 * 60_000) return lists;
    const t = await workspace();
    const { spaces = [] } = await api(`/team/${t.id}/space`, { query: { archived: false } });
    const out = [];
    await Promise.all(
      spaces.map(async (space) => {
        const [{ folders = [] }, { lists: loose = [] }] = await Promise.all([
          api(`/space/${space.id}/folder`, { query: { archived: false } }),
          api(`/space/${space.id}/list`, { query: { archived: false } }),
        ]);
        for (const l of loose) out.push({ id: l.id, nome: l.name, caminho: `${space.name} › ${l.name}` });
        for (const f of folders) {
          for (const l of f.lists || []) out.push({ id: l.id, nome: l.name, caminho: `${space.name} › ${f.name} › ${l.name}` });
        }
      })
    );
    lists = out;
    listsAt = Date.now();
    return lists;
  }

  async function resolveList(name) {
    if (!name) return { erro: "sem_lista", mensagem: "Em qual lista do ClickUp?" };
    const all = await allLists();
    const q = fold(name);
    let hits = all.filter((l) => fold(l.nome) === q);
    if (!hits.length) hits = all.filter((l) => fold(l.caminho).includes(q));
    if (hits.length === 1) return { list: hits[0] };
    if (!hits.length) return { erro: "nao_encontrada", mensagem: `Não achei a lista "${name}".`, listas: all.slice(0, 30).map((l) => l.caminho) };
    return { erro: "varias", candidatas: hits.slice(0, 10).map((l) => l.caminho) };
  }

  function taskJSON(t) {
    const due = t.due_date ? Number(t.due_date) : null;
    return {
      id: t.id,
      nome: t.name,
      status: t.status?.status,
      prazo: localStamp(due),
      atrasada: Boolean(due && due < Date.now()),
      lista: t.list?.name,
      prioridade: PRIORITY_NAME[t.priority?.id] || undefined,
      url: t.url,
    };
  }

  async function myTasks(extra = {}) {
    const [user, t] = await Promise.all([whoAmI(), workspace()]);
    const tasks = [];
    for (let page = 0; page < 3; page++) {
      const data = await api(`/team/${t.id}/task`, {
        query: { page, order_by: "due_date", subtasks: true, include_closed: false, assignees: [user.id], ...extra },
      });
      tasks.push(...(data.tasks || []));
      if ((data.tasks || []).length < 100 || data.last_page) break;
    }
    return tasks;
  }

  async function resolveTask(ref) {
    const q = String(ref ?? "").trim();
    if (!q) return { erro: "argumento", mensagem: "Qual tarefa?" };
    if (/^[a-z0-9]{6,12}$/i.test(q) && /\d/.test(q)) {
      try {
        return { task: await api(`/task/${q}`) };
      } catch {}
    }
    const tasks = await myTasks();
    const f = fold(q);
    let hits = tasks.filter((t) => fold(t.name) === f);
    if (!hits.length) hits = tasks.filter((t) => fold(t.name).includes(f));
    if (hits.length === 1) return { task: hits[0] };
    if (!hits.length) return { erro: "nao_encontrada", mensagem: `Não achei tarefa aberta sua com "${q}".` };
    return { erro: "varias", candidatas: hits.slice(0, 8).map(taskJSON) };
  }

  const handle = (fn) => async (args = {}) => {
    try {
      return await fn(args);
    } catch (err) {
      if (err.code === "sem_token") {
        return { erro: "sem_token", mensagem: "O ClickUp não está conectado. Cole o token pessoal (pk_…) em Ajustes; ele é gerado no ClickUp em Ajustes → Apps." };
      }
      if (err.code === "token_invalido") return { erro: "token_invalido", mensagem: "O token do ClickUp foi recusado. Gere outro em ClickUp → Ajustes → Apps." };
      return { erro: "falha", mensagem: err.message };
    }
  };

  const tools = {
    clickup_tarefas: handle(async ({ filtro = "todas", busca = "" }) => {
      const now = Date.now();
      const extra = {};
      if (filtro === "atrasadas") extra.due_date_lt = now;
      if (filtro === "hoje") extra.due_date_lt = endOfToday();
      if (filtro === "semana") extra.due_date_lt = endOfToday() + 6 * 86_400_000;
      let tasks = await myTasks(extra);
      if (busca) tasks = tasks.filter((t) => fold(t.name).includes(fold(busca)));
      const list = tasks.map(taskJSON);
      return { filtro, total: list.length, atrasadas: list.filter((t) => t.atrasada).length, tarefas: list.slice(0, 25) };
    }),

    clickup_listas: handle(async ({ busca = "" }) => {
      const all = await allLists();
      const hits = busca ? all.filter((l) => fold(l.caminho).includes(fold(busca))) : all;
      return { workspace: (await workspace()).name, total: hits.length, listas: hits.slice(0, 60).map((l) => l.caminho) };
    }),

    clickup_criar_tarefa: handle(async ({ titulo, lista, descricao, prazo, prioridade, atribuir_a_mim = true }) => {
      if (!titulo) return { erro: "argumento", mensagem: "Título vazio." };
      const found = await resolveList(lista);
      if (!found.list) return found;
      const body = { name: titulo };
      if (descricao) body.markdown_content = descricao;
      if (prazo) Object.assign(body, parseDue(prazo));
      if (prioridade && PRIORITY[fold(prioridade)]) body.priority = PRIORITY[fold(prioridade)];
      if (atribuir_a_mim) body.assignees = [(await whoAmI()).id];
      const task = await api(`/list/${found.list.id}/task`, { method: "POST", body });
      return { ok: true, tarefa: { ...taskJSON(task), lista: found.list.caminho } };
    }),

    clickup_atualizar_tarefa: handle(async ({ tarefa, concluir, status, prazo, prioridade, comentario }) => {
      const found = await resolveTask(tarefa);
      if (!found.task) return found;
      const task = found.task;
      const body = {};
      if (concluir || status) {
        const { statuses = [] } = await api(`/list/${task.list.id}`);
        let target;
        if (concluir) {
          target = statuses.filter((s) => s.type === "closed" || s.type === "done").pop();
        } else {
          target = statuses.find((s) => fold(s.status) === fold(status)) || statuses.find((s) => fold(s.status).includes(fold(status)));
        }
        if (!target) return { erro: "status_invalido", mensagem: "Status não existe nessa lista.", opcoes: statuses.map((s) => s.status) };
        body.status = target.status;
      }
      if (prazo) Object.assign(body, parseDue(prazo));
      if (prioridade && PRIORITY[fold(prioridade)]) body.priority = PRIORITY[fold(prioridade)];
      let updated = task;
      if (Object.keys(body).length) updated = await api(`/task/${task.id}`, { method: "PUT", body });
      if (comentario) await api(`/task/${task.id}/comment`, { method: "POST", body: { comment_text: comentario, notify_all: false } });
      return { ok: true, tarefa: taskJSON(updated), comentou: Boolean(comentario) };
    }),
  };

  return { tools, workspace, whoAmI };
}

export const CLICKUP_TOOL_DEFS = [
  {
    type: "function",
    name: "clickup_tarefas",
    description: "Lista as tarefas abertas atribuídas ao usuário no ClickUp: atrasadas, de hoje, da semana ou todas. Pode filtrar por nome.",
    parameters: {
      type: "object",
      properties: {
        filtro: { type: "string", enum: ["atrasadas", "hoje", "semana", "todas"] },
        busca: { type: "string", description: "Parte do nome da tarefa. Opcional." },
      },
      required: ["filtro"],
    },
  },
  {
    type: "function",
    name: "clickup_listas",
    description: "Lista as listas do ClickUp (Espaço › Pasta › Lista), para saber onde criar uma tarefa.",
    parameters: { type: "object", properties: { busca: { type: "string", description: "Opcional." } } },
  },
  {
    type: "function",
    name: "clickup_criar_tarefa",
    description:
      "Cria uma tarefa no ClickUp, atribuída ao usuário. O ClickUp é compartilhado com a equipe: ANTES de chamar, confirme em uma frase o título, a lista e o prazo.",
    parameters: {
      type: "object",
      properties: {
        titulo: { type: "string" },
        lista: { type: "string", description: "Nome da lista. Se não souber, use clickup_listas e pergunte." },
        descricao: { type: "string", description: "Detalhes em markdown. Opcional." },
        prazo: { type: "string", description: "AAAA-MM-DDTHH:MM (horário local) ou AAAA-MM-DD. Opcional." },
        prioridade: { type: "string", enum: ["urgente", "alta", "normal", "baixa"] },
        atribuir_a_mim: { type: "boolean", description: "Padrão true." },
      },
      required: ["titulo", "lista"],
    },
  },
  {
    type: "function",
    name: "clickup_atualizar_tarefa",
    description:
      "Atualiza uma tarefa do ClickUp pelo nome ou id: concluir, mudar status, prazo ou prioridade, ou comentar. Confirme antes de concluir ou comentar (a equipe vê).",
    parameters: {
      type: "object",
      properties: {
        tarefa: { type: "string", description: "Nome (ou parte) ou id da tarefa." },
        concluir: { type: "boolean" },
        status: { type: "string", description: "Nome do status desejado. Opcional." },
        prazo: { type: "string", description: "AAAA-MM-DDTHH:MM ou AAAA-MM-DD. Opcional." },
        prioridade: { type: "string", enum: ["urgente", "alta", "normal", "baixa"] },
        comentario: { type: "string", description: "Comentário a adicionar. Opcional." },
      },
      required: ["tarefa"],
    },
  },
];
