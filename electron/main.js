// Jarvis — app desktop (Electron).
// Sobe o servidor local dentro do próprio app, abre a janela e registra
// um atalho global para falar com o Jarvis de qualquer lugar.

import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, shell, systemPreferences } from "electron";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const SHORTCUT = "Alt+Shift+J";

// A conversa pode começar pelo atalho global, sem clique na página.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let win = null;
let origin = "";
let quitting = false;

async function ensureMicrophone() {
  if (process.platform !== "darwin") return;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return;
  if (status === "not-determined") {
    await systemPreferences.askForMediaAccess("microphone");
    return;
  }
  // Negado antes: o macOS não pergunta de novo, só pelos Ajustes do Sistema.
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: "O Jarvis precisa do microfone",
    detail: "Ative o Jarvis em Ajustes do Sistema → Privacidade e Segurança → Microfone e abra o app de novo.",
    buttons: ["Abrir Ajustes", "Agora não"],
    defaultId: 0,
  });
  if (response === 0) {
    shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 820,
    minWidth: 380,
    minHeight: 600,
    title: "Jarvis",
    backgroundColor: "#030409",
    titleBarStyle: "hiddenInset",
    show: false,
    webPreferences: {
      preload: join(DIR, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      // Áudio e data channel continuam responsivos com a janela escondida.
      backgroundThrottling: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.loadURL(origin);

  // Links (ex.: fontes da pesquisa) abrem no navegador padrão.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(origin)) e.preventDefault();
  });

  // Fechar a janela só esconde: o Jarvis continua disponível pelo atalho.
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

// ---------------------------------------------------------------------------
// "Ei, Jarvis": o jarvis-helper escuta o microfone e reconhece a palavra
// no próprio Mac. Fica pausado enquanto uma conversa está ativa.
// ---------------------------------------------------------------------------

const wake = { enabled: false, proc: null, live: false, restarts: 0, timer: null };

function helperPath() {
  return app.isPackaged ? join(process.resourcesPath, "jarvis-helper") : join(DIR, "..", "bin", "jarvis-helper");
}

function startWake() {
  if (wake.proc || !wake.enabled) return;
  const proc = spawn(helperPath(), ["escutar"], { stdio: ["pipe", "pipe", "ignore"] });
  wake.proc = proc;
  let fatal = false;
  createInterface({ input: proc.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.evento === "pronto") {
      wake.restarts = 0;
      if (wake.live) proc.stdin.write("pausar\n");
    } else if (msg.evento === "wake") {
      if (!wake.live) {
        if (!win.isVisible()) win.show();
        win.webContents.send("jarvis:wake");
      }
    } else if (msg.evento === "comando") {
      win.webContents.send("jarvis:wake-command", msg.texto || "");
    } else if (msg.evento === "erro") {
      fatal = Boolean(msg.codigo); // sem permissão: não adianta reiniciar
      win.webContents.send("jarvis:wake-error", msg.mensagem);
    }
  });
  proc.on("error", (err) => win?.webContents.send("jarvis:wake-error", `Detector indisponível: ${err.message}`));
  proc.on("exit", () => {
    if (wake.proc === proc) wake.proc = null;
    // Caiu sozinho: tenta de novo com espera crescente (até 5 vezes).
    if (wake.enabled && !fatal && !quitting && wake.restarts < 5) {
      wake.restarts += 1;
      wake.timer = setTimeout(startWake, 1000 * 2 ** wake.restarts);
    }
  });
}

function stopWake() {
  clearTimeout(wake.timer);
  if (wake.proc) {
    wake.proc.stdin.end(); // stdin fechado = o helper encerra
    wake.proc.kill();
    wake.proc = null;
  }
}

function showAndToggle() {
  if (!win) return;
  if (!win.isVisible()) win.show();
  win.focus();
  win.webContents.send("jarvis:toggle");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    win?.show();
    win?.focus();
  });

  app.whenReady().then(async () => {
    // Empacotado, os dados ficam em ~/Library/Application Support/Jarvis
    // (chaves no Keychain). Em desenvolvimento, usa a pasta data/ do projeto.
    if (app.isPackaged) {
      process.env.JARVIS_DATA_DIR = app.getPath("userData");
      process.env.JARVIS_HELPER = join(process.resourcesPath, "jarvis-helper");
    }
    process.env.PORT = "0"; // porta livre, sem conflito com a versão web

    const { ready } = await import("../server.js");
    const port = await ready;
    origin = `http://127.0.0.1:${port}`;

    // Microfone liberado só para a interface do próprio Jarvis.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
      callback(permission === "media" && (details.requestingUrl || "").startsWith(origin));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      return permission === "media" && (requestingOrigin || "").startsWith(origin);
    });

    ipcMain.handle("jarvis:choose-folder", async (_e, current) => {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: "Pasta do segundo cérebro",
        buttonLabel: "Usar esta pasta",
        defaultPath: typeof current === "string" && current ? current : app.getPath("documents"),
        properties: ["openDirectory", "createDirectory"],
      });
      return canceled ? null : filePaths[0];
    });

    // Captura da tela onde está o cursor (a primeira vez o macOS pede permissão).
    ipcMain.handle("jarvis:capture-screen", async () => {
      if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") === "denied") {
        return {
          erro: "sem_permissao",
          mensagem: "Sem permissão de gravação de tela. Libere o Jarvis em Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela e Áudio do Sistema.",
        };
      }
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const scale = Math.min(1, 1600 / display.size.width);
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: {
          width: Math.round(display.size.width * scale),
          height: Math.round(display.size.height * scale),
        },
      });
      const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
      if (!source || source.thumbnail.isEmpty()) {
        return { erro: "falha", mensagem: "Não consegui capturar a tela." };
      }
      return { imagem: `data:image/jpeg;base64,${source.thumbnail.toJPEG(85).toString("base64")}` };
    });

    ipcMain.on("jarvis:set-wake", (_e, enabled) => {
      wake.enabled = Boolean(enabled);
      wake.restarts = 0;
      if (wake.enabled) startWake();
      else stopWake();
    });
    ipcMain.on("jarvis:live", (_e, live) => {
      wake.live = Boolean(live);
      wake.proc?.stdin.write(wake.live ? "pausar\n" : "retomar\n");
    });

    await ensureMicrophone();
    createWindow();

    if (!globalShortcut.register(SHORTCUT, showAndToggle)) {
      console.warn(`Atalho ${SHORTCUT} já está em uso por outro app.`);
    }
  });

  app.on("activate", () => {
    win?.show();
  });

  app.on("before-quit", () => {
    quitting = true;
  });

  app.on("will-quit", () => {
    stopWake();
    globalShortcut.unregisterAll();
  });
}
