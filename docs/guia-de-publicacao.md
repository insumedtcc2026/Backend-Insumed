# Guia de publicação — melhorias de 13 a 15/10/2026

> **Atualização de 15/10 (rodada 3):** se a primeira publicação já foi feita,
> faça só os passos marcados com **(15/10)**: backup no Neon, rodar
> `database/migracoes/2026-10-15_reenvio_e_cadastros.sql` (seção 2.6) e
> depois juntar os dois branches no `main`, backend primeiro.

Como colocar no ar, de verdade (Neon de produção + `main` + Vercel), tudo o
que está no branch `claude/project-thread-vrxtwg` dos dois repositórios:

- Backend: `insumedtcc2026/Backend-Insumed`
- Frontend: `insumedtcc2026/INSUMED`

> **A ordem importa: banco → backend → frontend.**
> O backend novo lê colunas e uma tabela que só existem depois da migração.
> Se ele subir antes, a lista de agendamentos e várias telas quebram.
> O contrário é seguro: o backend antigo funciona normalmente com o banco já
> migrado, porque a migração só **adiciona** coisas.

Tempo estimado: 30 a 45 minutos, contando os testes no final.

---

## 0. Antes de começar

- [ ] Escolha um horário com pouco uso (o site fica no ar o tempo todo, mas é
      melhor não ter ninguém no meio de um agendamento).
- [ ] Tenha acesso de administrador ao **Neon**, à **Vercel** (os dois
      projetos) e ao **GitHub** da organização `insumedtcc2026`.
- [ ] Rode os testes automáticos do backend no branch (devem dar `pass 62`):

  ```
  cd Backend-Insumed
  git checkout claude/project-thread-vrxtwg
  git pull
  npm install
  npm test
  ```

- [ ] (Recomendado) Faça antes o roteiro de testes do nível 2 ou 3
      (`docs/roteiro-de-testes.md`) com uma cópia do banco.

---

## 1. Neon — cópia de segurança

No painel do Neon, no projeto do Insumed:

1. **Branches → Create branch**.
2. Parent: `main` (o banco de produção). Nome:
   `backup-antes-melhorias-2026-10-14`.
3. Crie. Esse branch é uma foto do banco agora; se algo der muito errado, dá
   para voltar a ele. Não aponte nada para ele, só guarde.

---

## 2. Neon — migração no banco de produção

1. Ainda no Neon, selecione o branch **`main`** (produção).
   **Confira duas vezes o nome do branch selecionado no topo do SQL Editor.**
2. Abra o **SQL Editor**.
3. Copie e cole o conteúdo inteiro de
   `database/migracoes/2026-10-13_melhorias_insumed.sql` e execute.

O que ela faz (nada é apagado ou alterado nos dados existentes):

| Onde | O quê | Para quê |
|---|---|---|
| `solicitacao` | `sol_motivo_cancelamento`, `sol_data_cancelamento`, `sol_cancelado_por` | Motivo, data e quem cancelou o agendamento |
| `solicitacao` | `sol_origem_id` + índice único | Ligar o agendamento à prescrição e impedir dois agendamentos ativos para ela |
| `solicitacao` | `sol_recado` | Recado do admin para o paciente |
| `postosdesaude` | `pos_whatsapp` | WhatsApp do posto ("Falar com a unidade") |
| nova tabela | `historico_solicitacao` | "Quem fez o quê" e Atividades da unidade |

4. Confira se deu certo (cole e rode):

   ```sql
   SELECT column_name FROM information_schema.columns
    WHERE table_name = 'solicitacao'
      AND column_name IN ('sol_motivo_cancelamento','sol_data_cancelamento',
                          'sol_cancelado_por','sol_origem_id','sol_recado');
   -- deve listar 5 linhas

   SELECT column_name FROM information_schema.columns
    WHERE table_name = 'postosdesaude' AND column_name = 'pos_whatsapp';
   -- deve listar 1 linha

   SELECT COUNT(*) FROM historico_solicitacao;
   -- deve responder 0 (a tabela existe e está vazia)
   ```

   Se der erro, **pare aqui** e não publique o backend. A migração pode ser
   rodada de novo sem problema (usa `IF NOT EXISTS`).

5. (Opcional agora, pode ser depois) WhatsApp de cada posto, só dígitos com
   55 + DDD + número:

   ```sql
   SELECT pos_id, pos_nome FROM postosdesaude ORDER BY pos_id;

   UPDATE postosdesaude SET pos_whatsapp = '5524999999999' WHERE pos_id = 1;
   -- repita para cada posto que tiver WhatsApp
   ```

   Posto sem número continua funcionando; só não aparece o botão
   "Falar com a unidade" para o paciente.

6. **(15/10)** Rode também o arquivo
   `database/migracoes/2026-10-15_reenvio_e_cadastros.sql`, no mesmo SQL Editor
   do branch `main`. Ele:

   | Onde | O quê | Para quê |
   |---|---|---|
   | `pacientes` | tira restrições antigas de `pac_sexo`/`pac_raca`, aceita vazio e aumenta `pac_raca` para 30 letras (só se for menor) | "Outro" e "Prefiro não responder" no cadastro |
   | `administrador` | índice único da matrícula (ignora maiúsculas e pontuação) | impedir matrícula repetida |
   | nova tabela | `prescricao_versao` | guardar o arquivo anterior quando o paciente reenvia |
   | `solicitacao`, `historico_solicitacao` | índices | listas paginadas rápidas |

   Nenhum dado é apagado. Se aparecer o aviso *"Há matrículas repetidas"*, o
   índice da matrícula não foi criado (o resto foi); o backend continua
   bloqueando novas repetições. A consulta do fim do arquivo lista as repetidas.

   Conferência:

   ```sql
   SELECT COUNT(*) FROM prescricao_versao;   -- deve responder 0
   SELECT column_name, character_maximum_length, is_nullable
     FROM information_schema.columns
    WHERE table_name = 'pacientes' AND column_name IN ('pac_sexo', 'pac_raca');
   -- is_nullable = YES nas duas
   ```

### 2.2 Migração de 18/10 (notificações)

Depois da de 15/10, rode `database/migracoes/2026-10-18_notificacoes.sql`.
Ela cria o número fixo do administrador (`adm_id`), as tabelas
`notificacao` e `notificacao_evento`, e as colunas `sol_data_anterior`
(remarcação) e `sol_observacao_equipe` (refazer pedido). O histórico que já
existe é marcado como processado, então ninguém recebe avisos antigos.

Conferência:

```sql
SELECT COUNT(*) FROM administrador WHERE adm_id IS NULL;  -- deve responder 0
SELECT COUNT(*) FROM notificacao;                         -- deve responder 0
```

Depois de publicar, os administradores precisam **sair e entrar de novo**
uma vez só para o token levar o `adm_id` (até lá o backend os reconhece pelo
e-mail, então nada quebra).

---

## 3. Backend — juntar no `main` e publicar

### 3.1 Variáveis de ambiente (Vercel → projeto do backend → Settings → Environment Variables)

Confira que **Production** continua com as duas de sempre e **crie a nova**
`CRON_SECRET`:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | string de conexão do branch **main** do Neon |
| `ACCESS_TOKEN_SECRET` | o segredo de sempre (não troque: trocar desloga todo mundo) |
| `CRON_SECRET` | **nova**: um texto aleatório longo (ex.: gerado por um gerenciador de senhas). A Vercel o envia sozinha ao chamar a tarefa diária |

O `vercel.json` do backend agenda a tarefa diária (`/tarefas/diaria`) para
todo dia às 10h UTC (7h de Brasília). No plano gratuito ela roda uma vez por
dia, em algum momento dessa hora. Ela gera os lembretes de coleta, os avisos
de pendência, marca "não compareceu" e trata as prescrições vencidas. Para
conferir: Vercel → projeto do backend → **Settings → Cron Jobs** (dá para
rodar na hora pelo botão **Run**).

Se você criou variáveis de **Preview** para testes (nível 3 do roteiro),
pode removê-las agora ou depois.

### 3.2 Juntar o branch no `main`

**Opção A — pelo GitHub (recomendado, fica registrado):**

1. Abra `https://github.com/insumedtcc2026/Backend-Insumed`.
2. **Pull requests → New pull request**: base `main`, compare
   `claude/project-thread-vrxtwg`.
3. Confira a lista de arquivos e clique em **Create pull request** e depois
   **Merge pull request** (não há conflitos: o `main` não mudou desde o início).

**Opção B — pelo terminal:**

```
cd Backend-Insumed
git checkout main
git pull
git merge claude/project-thread-vrxtwg
git push origin main
```

### 3.3 Acompanhar o deploy

1. Vercel → projeto do backend → **Deployments**: deve aparecer um deploy do
   `main` em andamento. Espere ficar **Ready**.
2. Teste rápido no navegador:
   - `https://backend-insumed-lhac.vercel.app/` deve responder (rota raiz).
   - `https://backend-insumed-lhac.vercel.app/postos` deve listar os postos.
   - `https://backend-insumed-lhac.vercel.app/pacientesall` agora deve
     responder **401** (antes era aberta a qualquer um; isso é esperado).

Se o deploy falhar ou as rotas derem erro 500, veja a seção 6 (voltar atrás).

---

## 4. Frontend — juntar no `main` e publicar

### 4.1 Variáveis de ambiente (Vercel → projeto do frontend)

- **Production**: não precisa de `VITE_API_URL`. Sem ela, o site usa o backend
  de produção, como sempre. Se preferir deixar explícito, crie
  `VITE_API_URL = https://backend-insumed-lhac.vercel.app`.
- Se existir `VITE_API_URL` de **Preview** apontando para teste, ela não afeta
  a produção (pode remover depois).

### 4.2 Juntar o branch no `main`

Igual ao backend, no repositório `insumedtcc2026/INSUMED`
(pull request de `claude/project-thread-vrxtwg` para `main` e merge), ou:

```
cd INSUMED
git checkout main
git pull
git merge claude/project-thread-vrxtwg
git push origin main
```

### 4.3 Acompanhar o deploy

Vercel → projeto do frontend → Deployments → esperar **Ready**. O build
instala uma dependência nova (`qrcode.react`), é normal.

---

## 5. Teste depois de publicar (produção)

Use contas reais da equipe. Para não deixar dados falsos no sistema, use um
paciente de teste da equipe e, no fim, cancele o agendamento de teste com o
motivo "teste de publicação".

**Abra o site numa aba anônima** (para não pegar arquivos antigos do cache).

- [ ] Página inicial abre rápido; no celular o título do banner é legível.
- [ ] Login dos três perfis. Senha errada mostra tentativas restantes.
- [ ] Paciente: enviar uma prescrição (foto) → aparece em "Minhas prescrições"
      com o rastreio em "Em análise".
- [ ] Admin: Home mostra os contadores; abrir a prescrição e **revisar**.
- [ ] Autorizador: menu próprio; a prescrição aparece em "Aguardando
      análise"; **autorizar**.
- [ ] Admin: em Solicitações, o botão vira **Agendar**; agendar (aparecem as
      datas sugeridas); tentar agendar de novo é recusado.
- [ ] Paciente: em "Meus agendamentos", a coleta aparece em destaque;
      "Ver comprovante" mostra o QR Code.
- [ ] Admin: "Deixar recado" e "Histórico" no card do agendamento; o recado
      aparece para o paciente.
- [ ] **(15/10)** Admin pede reenvio de uma prescrição de teste; o paciente
      reenvia em "Minhas prescrições" e ela volta para análise com o mesmo número.
- [ ] **(15/10)** No celular: barra de baixo com "Mais", sem rodapé; o
      comprovante abre inteiro.
- [ ] Admin: **Cancelar** o agendamento de teste com o motivo
      "teste de publicação"; o motivo aparece para o paciente e em
      "Atividades da unidade".
- [ ] Rodapé: Central de Ajuda, Fale Conosco e Suporte abrem o WhatsApp;
      redes sociais abrem em nova aba.
- [ ] Botão "Aa" (texto maior / alto contraste) e VLibras aparecem.
- [ ] "Sair" desloga de verdade (voltar não entra de novo sem login).

---

## 6. Se algo der errado (voltar atrás)

**Frontend ou backend com problema:**
Vercel → projeto → Deployments → escolha o último deploy de antes da
publicação → menu "⋯" → **Promote to Production** (ou "Instant Rollback").
Volta em segundos. O banco migrado **não precisa** ser desfeito: o código
antigo funciona com as colunas novas.

Depois, para o Git ficar igual ao que está no ar, desfaça o merge no `main`
(pelo GitHub: no pull request, botão **Revert**).

Se precisar voltar o backend da rodada de 15/10, o banco também pode ficar
como está: a tabela e os índices novos não atrapalham o código anterior.

**Banco (só em último caso):** o branch `backup-antes-melhorias-2026-10-14`
do Neon tem a foto de antes. Restaurar a partir dele perde o que foi gravado
depois da publicação, então só faça se houver dano real nos dados.

---

## 7. Depois de publicar

- [ ] Preencher o WhatsApp dos postos (passo 2.5), se ainda não fez.
- [ ] Apagar branches de teste do Neon (`teste-melhorias`, se criou). Manter o
      `backup-antes-melhorias-2026-10-14` por alguns dias e apagar depois.
- [ ] Remover variáveis de **Preview** da Vercel criadas para teste.
- [ ] Avisar a equipe das mudanças (resumo abaixo).

**Pendências conhecidas (não impedem a publicação):**
- Sessão de login dura **7 dias** (para um sistema de saúde, 8–12 h seria
  mais seguro).
- Tela "Meus Insumos" do paciente ainda mostra dados fixos.
- Notificações (sininho) ficaram para uma próxima etapa.
- Cadastro de administrador e autorizador continua público (decisão da equipe).
- A coluna `sol_cancelado_por` fica vazia quando quem cancela é admin (a tabela
  `administrador` não tem id); quem cancelou fica no histórico, pelo nome.

---

## Resumo do que muda para quem usa

**Paciente**
- Gênero e raça/cor opcionais no cadastro.
- "Minhas prescrições": acompanhamento em etapas (enviada → análise →
  autorização → agendamento → retirada), com motivos quando houver problema.
- "Meus agendamentos": Próximos (próxima coleta em destaque) e Anteriores;
  comprovante com QR Code; recado da unidade; "Falar com a unidade" no
  WhatsApp do posto; motivo quando cancelado.
- Envio de prescrição com arrastar e soltar e mensagens claras.

**Administrador**
- Home com o que precisa de atenção; "Coletas de hoje" para o balcão (lê o
  QR do comprovante com leitor USB ou digitando o protocolo).
- Cancelamento com motivo obrigatório; recado; histórico de cada item;
  "Atividades da unidade". (A transferência entre unidades foi removida em 15/10.)
- Ficha do paciente; busca por nome ou CPF; datas sugeridas ao agendar;
  "Meu perfil" com o posto.
- Solicitações e Histórico no mesmo visual de Agendamentos.

**Autorizador**
- Menu próprio, "Meu perfil", lista "Prescrições para análise" no padrão novo,
  histórico da prescrição.

**Todos**
- Segurança: rotas protegidas por perfil, "Sair" que realmente desloga,
  bloqueio de ações repetidas ou fora de ordem, sem dados pessoais nos logs.
- CPF e telefone sempre formatados; site muito mais leve (imagens de ~60 MB
  para ~1 MB); versão para celular revisada; VLibras e opções de acessibilidade.
