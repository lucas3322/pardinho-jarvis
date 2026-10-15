// Gera build/icon.png renderizando o orb numa janela invisível do Electron.
// Uso: npm run icon
import { app, BrowserWindow } from "electron";
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILES = {
  "/": join(ROOT, "build/icon.html"),
  "/orb.js": join(ROOT, "public/orb.js"),
};

app.whenReady().then(async () => {
  const server = http.createServer(async (req, res) => {
    const file = FILES[req.url];
    if (!file) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : "text/html" });
    res.end(await readFile(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const win = new BrowserWindow({ show: false, width: 1024, height: 1024 });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);

  let dataURL;
  for (let i = 0; i < 50 && !dataURL; i++) {
    dataURL = await win.webContents.executeJavaScript("window.iconDataURL || null");
    if (!dataURL) await new Promise((r) => setTimeout(r, 100));
  }
  if (!dataURL) throw new Error("O ícone não foi gerado.");

  const out = join(ROOT, "build/icon.png");
  await writeFile(out, Buffer.from(dataURL.split(",")[1], "base64"));
  console.log(`Ícone salvo em ${out}`);
  server.close();
  app.quit();
});
