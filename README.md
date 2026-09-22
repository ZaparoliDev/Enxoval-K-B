# Lista de presentes — Clebson & Keila

Site de lista de presentes de enxoval. Front-end estático em um único `index.html`,
API serverless na Vercel e MongoDB Atlas como banco.

## Como trocar de casal

Tudo que é específico do cliente está no objeto `CONFIG`, no primeiro `<script>` do
`index.html`. Não existe nome, telefone ou texto hardcoded fora dele.

| Campo | O que muda |
|---|---|
| `casal.nomes` / `primeiro` / `segunda` | Nome do casal no título, no herói, no rodapé e nas mensagens do WhatsApp |
| `evento.titulo` / `chamada` | Cabeçalho do site e título da aba |
| `contato.whatsapp` | Número de destino (DDI + DDD, só números) |
| `textos.*` | Subtítulo, rodapé, chamadas do Pix, aviso de entrega, textos da contagem |
| `paleta` | As bolinhas de cor do cabeçalho |
| `categorias` | Filtros e a cor de fundo do ícone de cada card. O `id` precisa bater com o campo `categoria` no banco |
| `segundosReserva` | Duração da contagem antes de abrir o WhatsApp |
| `chaves` | Sufixo do `localStorage` / `sessionStorage`. Troque a cada projeto novo |

## Variáveis de ambiente

Configure na Vercel (Settings → Environment Variables) e faça **redeploy** — a Vercel
só aplica variáveis novas em um build novo. Veja `.env.example`.

```
MONGODB_URI       obrigatória
MONGODB_DB        opcional (padrão: enxoval)
MONGODB_PRODUCTS  opcional (padrão: products)
MONGODB_CLAIMED   opcional (padrão: claimed_items)
MONGODB_SUGGESTIONS opcional (padrão: suggestions)
ADMIN_PASSWORD    obrigatória — senha do painel
ADMIN_SECRET      obrigatória — segredo para assinar o token de sessão
ALLOWED_ORIGIN    opcional (padrão: *)
```

Gere o `ADMIN_SECRET` com:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Banco

Database `enxoval` (ou o nome em `MONGODB_DB`), com três coleções:

- **`products`** — `id`, `name` (ou `nome`), `categoria`, `emoji`
- **`claimed_items`** — `item_id`, `claimed_at`
- **`suggestions`** — `nome`, `titulo`, `mensagem`, `status`, `resposta`,
  `created_at`, `updated_at` (criada automaticamente no primeiro envio)

O campo `bg` da versão antiga não é mais usado: a cor de fundo do ícone agora vem
da categoria, definida em `CONFIG.categorias[].tint`. Isso evita que as cores
antigas briguem com a paleta nova.

> Se o casal novo for entrar no **mesmo database** do casal anterior, aponte
> `MONGODB_PRODUCTS` e `MONGODB_CLAIMED` para coleções próprias
> (ex.: `products_ck` e `claimed_ck`). Senão os dois conjuntos de itens se misturam.

## API

| Rota | Método | Descrição |
|---|---|---|
| `/api/products` | GET | Lista os itens com `isClaimed` já calculado |
| `/api/products` | POST `{ item_id }` | Reserva pública: só marca o que está livre, nunca desmarca |
| `/api/products` | POST `{ item_id, toggleAdmin: true }` | Marca ou libera. **Exige** header `x-admin-token` válido |
| `/api/auth` | POST `{ password }` | Valida a senha e devolve um token assinado, válido por 6 h |
| `/api/suggestions` | POST `{ nome?, titulo, mensagem }` | Recebe uma sugestão pública e a adiciona ao mural |
| `/api/suggestions` | GET | Lista publicamente as sugestões, seus andamentos e respostas |
| `/api/suggestions` | PUT `{ id, status, resposta }` | Atualiza o andamento e a resposta. **Exige** header `x-admin-token` válido |
| `/api/suggestions` | DELETE `{ id }` | Exclui uma sugestão. **Exige** header `x-admin-token` válido |

## Sugestões da primeira versão

O módulo de sugestões é temporário e controlado por `CONFIG.sugestoesAtivas`, no
`index.html`. O mural é público: qualquer pessoa pode ver as ideias, os status e
as respostas. No modo jardineiro, o botão **Ver sugestões** permite atualizar o
andamento, responder ou excluir uma ideia. Para esconder o módulo quando o site
estiver completo, troque o valor para `false`.

## Segurança do painel

Na versão anterior a senha estava no JavaScript do navegador e a API aceitava
`toggleAdmin: true` de qualquer origem. Agora:

- a senha vive só em `process.env.ADMIN_PASSWORD` e é comparada com
  `crypto.timingSafeEqual`;
- o login devolve um token `expiração.assinatura` (HMAC-SHA256 com `ADMIN_SECRET`),
  guardado em `sessionStorage` e expirando em 6 horas;
- toda ação administrativa revalida esse token no servidor;
- há limite de 6 tentativas por IP a cada 10 minutos, com atraso de 600 ms
  nas respostas erradas.

### Entrada do painel

Não existe botão de admin visível. No rodapé há uma pequena semente: **segure-a por
1,2 s** e um anel cresce ao redor até o portão abrir. No modal, cada caractere
digitado faz o caule subir e os brotos se abrirem; ao acertar a senha a planta
floresce antes de o painel aparecer, e ao errar ela murcha.

## Rodando local

```bash
npm install
vercel dev
```
