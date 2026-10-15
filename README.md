# J.A.R.V.I.S. 2.0

Assistente de voz em tempo real com a **OpenAI Realtime API** (`gpt-realtime-2.1`) via WebRTC.
Fala e escuta ao mesmo tempo, aceita interrupção, pesquisa na web, consulta o clima, abre sites e lembra de você entre conversas.

## Rodar

```bash
npm start   # http://localhost:3000 — na primeira vez, cole a chave da OpenAI em Ajustes
```

Requer Node 22.9+ e créditos na conta da OpenAI (platform.openai.com/settings/organization/billing).
A versão web não tem dependências.

## App para Mac

```bash
npm install
npm run app     # roda o app em modo desenvolvimento
npm run dist    # gera dist/Jarvis-2.0.0-arm64.dmg e dist/mac-arm64/Jarvis.app
npm run icon    # regenera build/icon.png a partir do orb
```

- **⌥⇧J** (Option+Shift+J) chama o Jarvis de qualquer app e liga/desliga a conversa.
- Fechar a janela só esconde o app; ⌘Q encerra.
- Tudo se configura em **Ajustes** (ícone no canto superior direito): seu nome, chave da OpenAI,
  "Ouvir Jarvis", token do ClickUp, segundo cérebro, voz e velocidade.
- O build tem assinatura local (ad-hoc): funciona neste Mac. Para distribuir para
  outras pessoas é preciso uma conta Apple Developer (assinatura + notarização).

## O que ele faz

| Ferramenta | Exemplo de fala |
| --- | --- |
| `pesquisar_web` | "Quais as notícias de hoje?" |
| `obter_clima` | "Vai chover em São Paulo?" |
| `lembrar` / `esquecer` | "Lembra que eu prefiro café sem açúcar." |
| `abrir_site` | "Abre o YouTube." (abre no navegador do Mac) |
| `data_hora` | "Que horas são?" |
| `encerrar_conversa` | "Valeu, Jarvis, pode desligar." |

### Controle do Mac

| Fala | O que acontece |
| --- | --- |
| "Abre o Spotify" / "Abre o Outlook" | Abre o app (entende nomes em português: Calendário, Notas, Ajustes…) |
| "Fecha o Chrome" | Fecha o app (pede confirmação se você não pediu explicitamente) |
| "Volume em 30" / "Aumenta o som" / "Muta" | Controla o volume |
| "Pausa a música" / "Próxima" / "O que tá tocando?" | Spotify ou Music, o que estiver aberto |
| "Toca Coldplay" | No Spotify abre a busca (o Spotify não permite tocar por busca via AppleScript); no Music toca da biblioteca |
| "Liga o modo escuro" | Aparência do sistema |
| "Roda o atalho Foco Trabalho" | Executa atalhos do app Atalhos (é assim que dá para ligar modos Foco) |

### ClickUp

Cole o token pessoal (`pk_…`, gerado no ClickUp em Ajustes → Apps → API Token) em **Ajustes**.
Usa a API REST v2, não o MCP oficial: o MCP exige login OAuth e, no plano gratuito, limita a 50 chamadas por dia.

| Fala | O que acontece |
| --- | --- |
| "O que tá atrasado no ClickUp?" / "Minhas tarefas de hoje" | Lista suas tarefas abertas |
| "Cria uma tarefa pra revisar a proposta até sexta na lista Comercial" | Confirma título, lista e prazo e cria atribuída a você |
| "Conclui a tarefa da proposta" / "Comenta que já enviei" | Confirma e atualiza (a equipe vê) |

### Revisão semanal

"Vamos fazer a revisão da semana": ele resume a semana a partir do Diário, propõe destino para cada nota do Inbox,
pergunta "Posso mover assim?" e só move o que você aprovar. Os links `[[…]]` continuam funcionando.

### Tela, agenda, lembretes e resumo do dia

| Fala | O que acontece |
| --- | --- |
| "O que é isso na minha tela?" / "Lê esse erro" | Tira um print da tela onde está o cursor e analisa a imagem |
| "O que eu tenho hoje?" / "E amanhã?" | Lê o Calendário do Mac (inclui contas Google/Outlook/iCloud adicionadas ao Mac) |
| "Me lembra de ligar pro João amanhã às 15h" | Cria no app Lembretes, com alerta |
| "Marca reunião com a Ana sexta às 10h" | Cria evento no Calendário, com alerta 15 min antes |
| "Bom dia" / "Meu resumo" | Clima + agenda + lembretes do dia + notícias. Na primeira conversa do dia ele oferece |

Na primeira vez, o macOS pede permissão de Calendário, Lembretes e Gravação de Tela.
O acesso ao Calendário e aos Lembretes usa `native/jarvis-helper.swift` (EventKit), compilado com `npm run helper`.

### Anotações e segundo cérebro

| Fala | O que acontece |
| --- | --- |
| "Cria um segundo cérebro pra mim" | Cria `~/Documents/Segundo Cérebro` com Inbox, Projetos, Áreas, Recursos, Arquivo e Diário (formato Obsidian) |
| "Anota isso que vou te dizer" | Liga o modo ditado (espera pausas longas), depois pergunta onde salvar |
| "Anota essa ideia…" | Pergunta o local; se já existe nota parecida, pergunta se atualiza ou cria outra |
| "Anota no diário: …" | Vai direto para `Diário/AAAA-MM-DD.md`, com horário |
| "Lê minha nota de projetos" / "Abre a pasta" | `ler_arquivo` / `abrir_arquivo` |

- Notas `.md` saem com propriedades do Obsidian (`criado`, `atualizado`, `tags`, `relacionados: "[[…]]"`).
- Também cria `.md`/`.txt` na Mesa, em Documentos e em Downloads, e **só** nessas pastas e no segundo cérebro.
- Nunca apaga nada: "substituir" guarda a versão anterior em `.jarvis-backup/` dentro da pasta.
- A pasta do segundo cérebro pode ser trocada em **Ajustes**. Para ver no Obsidian, abra a pasta como cofre.

As memórias ficam em `data/memory.json` e entram nas instruções de toda sessão nova.
Também dá para digitar pelo painel de conversa (ícone ☰).

## Arquitetura

```
navegador ──SDP offer──▶ server.js /session ──(API key)──▶ api.openai.com/v1/realtime/calls
    ▲  áudio ◀──────────── WebRTC direto com a OpenAI ────────────▶ áudio do mic
    └─ data channel "oai-events": transcrições, estados, chamadas de função
              └──▶ server.js /tools/* (clima, pesquisa, memória, abrir site)
```

- `server.js` — servidor HTTP sem dependências. A chave nunca vai para o navegador.
- `public/orb.js` — o orb: 64 anéis com ruído de Perlin 3D, mistura aditiva e brilho; reage ao volume e aos agudos da voz.
- `public/app.js` — sessão WebRTC, eventos da Realtime API, execução das ferramentas.

## Configuração

Não há `.env`: tudo é definido em **Ajustes**.

- **Chave da OpenAI e token do ClickUp** ficam no **Keychain do macOS** (itens "Jarvis — OpenAI" e
  "Jarvis — ClickUp", visíveis no app Acesso às Chaves). A versão web e o app compartilham a mesma chave.
- **O resto** (nome, voz, velocidade, "Ouvir Jarvis") fica em `config.json`: em `data/` na versão web
  e em `~/Library/Application Support/Jarvis/` no app, junto com memórias e estado.
- Um `.env` antigo é importado automaticamente uma única vez e depois pode ser apagado.

Abra `http://localhost:3000/?debug` para expor o orb no console (`orb.setState('speaking')`).
