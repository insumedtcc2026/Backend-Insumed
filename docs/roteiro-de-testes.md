# Roteiro de testes seguros — branch `claude/project-thread-vrxtwg`

Tudo aqui roda **sem tocar no banco de produção** e **sem mexer no `main`**.
Há três jeitos, do mais seguro para o mais parecido com a produção. Dá para
fazer só o primeiro, ou os três em sequência.

| Nível | Banco usado | Onde roda | Risco |
|---|---|---|---|
| 1. Banco em memória | dados fictícios, somem ao parar | seu computador | nenhum |
| 2. Cópia do banco (branch do Neon) | cópia da produção | seu computador | nenhum na produção; a cópia tem dados reais |
| 3. Prévia na Vercel | cópia da produção (branch do Neon) | link de prévia online | nenhum na produção |

Antes de qualquer nível, nos **dois** repositórios:

```
git fetch origin
git checkout claude/project-thread-vrxtwg
git pull
npm install
```

---

## Nível 1 — banco em memória (recomendado começar por aqui)

1. **Testes automáticos do backend** (53 cenários: solicitação, autorização,
   agendamento, coleta, segurança, regressão, histórico, transferência,
   rastreio do paciente, atividades da unidade):

   ```
   cd Backend-Insumed
   npm test
   ```

   Deve terminar com `pass 62` e `fail 0`.

2. **Backend com dados fictícios** (deixe esta janela aberta):

   ```
   cd Backend-Insumed
   npm run dev:memoria
   ```

   Sobe em `http://localhost:3344`, sem precisar de `.env`.

3. **Frontend apontando para esse backend**: crie o arquivo `INSUMED/.env.local`
   com a linha abaixo (ele não vai para o Git):

   ```
   VITE_API_URL=http://localhost:3344
   ```

   e rode:

   ```
   cd INSUMED
   npm run dev
   ```

4. Abra o endereço que o Vite mostrar (normalmente `http://localhost:5173`).

**Contas de teste** (senha `Teste@1234` para todas):

| Perfil | E-mail |
|---|---|
| Paciente | ana.teste@insumed.test |
| Administrador | admin.teste@insumed.test |
| Autorizador | aut.teste@insumed.test |

Limitações deste nível: as imagens de prescrição aparecem quebradas (o banco
em memória corrompe arquivos) e não há como testar duas pessoas clicando ao
mesmo tempo. Isso fica para o nível 2.

---

## Nível 2 — cópia do banco no Neon, rodando no seu computador

1. No painel do Neon: **Branches → Create branch**, a partir do `main`
   (produção). Nome sugerido: `teste-melhorias`.
   - A cópia tem os **dados reais dos pacientes**. Não compartilhe a string de
     conexão e apague o branch quando terminar.
   - Se preferir sem dados reais, escolha a opção **schema only** e crie as
     contas de teste pelo próprio site (cadastro).
2. Ainda no Neon, com o branch `teste-melhorias` selecionado, abra o
   **SQL Editor** e rode o arquivo
   `database/migracoes/2026-10-13_melhorias_insumed.sql` (se ainda não rodou)
   e depois `database/migracoes/2026-10-15_reenvio_e_cadastros.sql`.
   **Confira que o branch selecionado é o de teste antes de rodar.**
3. Copie a **connection string do branch de teste** e crie `Backend-Insumed/.env`:

   ```
   DATABASE_URL=<connection string do branch teste-melhorias>
   ACCESS_TOKEN_SECRET=<qualquer texto longo, só para teste>
   ```

4. Rode `npm start` no backend e o frontend como no nível 1
   (`VITE_API_URL=http://localhost:3344` no `.env.local`).

---

## Nível 3 — prévia online na Vercel (para a equipe testar pelo link)

A Vercel já gera prévias para o branch `claude/project-thread-vrxtwg` nos dois
projetos. Falta só apontá-las para o branch de teste do Neon.

1. **Projeto do backend** na Vercel → Settings → Environment Variables:
   - `DATABASE_URL` = connection string do branch `teste-melhorias`
     - Environment: **Preview**
     - Branch: `claude/project-thread-vrxtwg`
   - `ACCESS_TOKEN_SECRET` = um segredo de teste, com o mesmo escopo.
   - **Não altere as variáveis de Production.**
2. Faça um redeploy da prévia do backend (Deployments → a prévia do branch →
   Redeploy) e copie o **link do branch** (o que contém `git-claude-project-thread`).
3. **Projeto do frontend** → Environment Variables:
   - `VITE_API_URL` = link da prévia do backend do passo 2
     - Environment: **Preview**, Branch: `claude/project-thread-vrxtwg`
   - Redeploy da prévia do frontend.
4. Se a prévia do backend pedir login da Vercel (Deployment Protection), o
   frontend não consegue chamá-la. Em Settings → Deployment Protection, desligue
   a proteção para prévias **do backend** durante o teste (ou use o
   "Protection Bypass" da Vercel).

---

## Checklist do que testar

Marque cada item em celular (DevTools, 375 px) e no computador.

### Antes das melhorias de hoje (regressão — precisa continuar igual)
- [ ] Login dos três perfis; senha errada mostra tentativas restantes; após 5 erros, bloqueio de 15 min.
- [ ] Cadastro de paciente com validação de nome, CPF, telefone, CEP, data e força da senha.
- [ ] Paciente envia prescrição (imagem ou PDF até 5 MB) e vê em "Prescrições".
- [ ] Admin revisa a pendente (insumo, quantidade, vencimento) ou pede reenvio com motivo.
- [ ] Autorizador autoriza ou não autoriza (motivo obrigatório).
- [ ] Admin agenda a coleta a partir da prescrição autorizada.
- [ ] Admin conclui a coleta e o estoque do insumo diminui.
- [ ] Paciente vê o agendamento em "Meus agendamentos" e o próximo na Home.
- [ ] Insumos: entrada e saída de estoque.
- [ ] Pontos de coleta no mapa.

### Segurança e validações (rodada 1)
- [ ] "Sair" desloga de verdade (ao voltar, pede login).
- [ ] Admin não consegue marcar "Autorizado" (só o autorizador decide).
- [ ] Não dá para revisar, autorizar ou concluir duas vezes; não dá para concluir um cancelado.
- [ ] Mesma prescrição enviada duas vezes seguidas: a segunda é recusada.
- [ ] Data de coleta no passado é recusada.
- [ ] Agendar a mesma prescrição autorizada duas vezes: a segunda é recusada.

### Agendamentos do admin (rodada 1)
- [ ] Cancelar pede motivo; o motivo aparece no filtro "Cancelado" e para o paciente.
- [ ] Concluir pede confirmação.

### Menu do autorizador, contatos e redes (rodada 1)
- [ ] Menu lateral próprio do autorizador, com a página atual destacada.
- [ ] Rodapé: Central de Ajuda, Fale Conosco e Suporte abrem o WhatsApp certo.
- [ ] Instagram, LinkedIn e YouTube abrem em nova aba.

### Fase 1 — ajustes rápidos
- [ ] Cadastro aceita sem gênero e sem raça/cor.
- [ ] CPF e telefone sempre formatados em listas, cabeçalhos e perfil.
- [ ] Menu do admin: "Novo Agendamento" logo abaixo de "Agendamentos" e abre o formulário.
- [ ] Botão "Novo Agendamento" azul, no topo da página, sem cobrir o rodapé.
- [ ] Página inicial carrega rápido; no celular o título do banner é texto legível.

### Fase 2 — admin
- [ ] Home do admin com os contadores; cada um abre a lista certa.
- [ ] "Coletas de hoje": digitar o protocolo e apertar Enter duas vezes conclui a coleta.
- [ ] "Pacientes": busca por nome ou CPF e abre a ficha completa.
- [ ] "Meu perfil" do admin (com o posto) e do autorizador; editar nome, e-mail e telefone.
- [ ] No modal de agendamento, aparecem as 3 datas sugeridas para o posto.

### Fase 3 — histórico, recado, comprovante
- [ ] "Histórico" mostra cada etapa com data (e o nome de quem fez, para a equipe).
- [ ] Paciente vê o "andamento" sem o nome dos servidores.
- [ ] Recado do admin aparece no card do paciente e no comprovante.
- [ ] Comprovante com QR Code; "Imprimir / salvar PDF" imprime só o comprovante.
- [ ] "Falar com a unidade" só aparece se o posto tiver WhatsApp cadastrado
      (no branch de teste: `UPDATE postosdesaude SET pos_whatsapp = '55DDDNUMERO' WHERE pos_id = 1;`).

### Fase 4 — páginas do paciente
- [ ] "Minhas prescrições" (menu e barra de baixo): rastreio em 5 etapas com datas.
- [ ] Prescrição com reenvio pedido mostra o motivo e o botão "Reenviar prescrição"
      (o reenvio acontece na mesma prescrição; ver "Rodada 3").
- [ ] Prescrição não autorizada mostra o motivo; aparece em "Encerradas".
- [ ] Perfil não lista mais prescrições, só o atalho para a página nova.
- [ ] "Meus agendamentos": abas Próximos (próxima coleta em destaque) e Anteriores.

### Fase 5 — acessibilidade, atividades e envio de prescrição
- [ ] Botão "VLibras" (lado direito) abre o tradutor de Libras.
- [ ] Botão "Aa" (lado esquerdo): A+ / A− muda o tamanho do texto; "Alto contraste" liga e desliga; continua igual ao recarregar.
- [ ] Apertar Tab ao abrir uma página mostra "Pular para o conteúdo".
- [ ] Admin: "Atividades da unidade" lista quem fez o quê; filtros de data, tipo, pessoa e paciente funcionam.
- [ ] Enviar prescrição: visual igual ao das outras páginas; arrastar o arquivo funciona;
      arquivo errado ou maior que 5 MB e envio sem unidade mostram a mensagem na tela.

### Rodada 3 — 15/10 (cadastro, reenvio, celular, homes, listas longas)
- [ ] Cadastro de paciente com gênero "Outro", com "Prefiro não responder" e com
      gênero e cor/raça em branco: os três cadastram.
- [ ] Cadastro de admin: matrícula "ab" ou "A#1" é recusada; "sms-1234" vira
      "SMS-1234"; repetir "sms 1234" mostra "Matrícula já cadastrada".
- [ ] E-mail já usado por outro perfil (ex.: e-mail de paciente no cadastro de
      admin) mostra "E-mail já cadastrado". Erro do servidor não apaga o formulário.
- [ ] Admin revisa uma prescrição: a mensagem é "Prescrição revisada" (não "aprovada").
- [ ] Admin pede reenvio → paciente vê "Reenviar prescrição" em Minhas prescrições,
      manda o arquivo (e uma mensagem) → a prescrição continua com o mesmo número,
      volta para "Em análise" e o histórico mostra o pedido e a resposta.
- [ ] Na tela do admin/autorizador aparece "esta é a versão 2" com "Ver versão 1".
- [ ] Cancelar um agendamento e agendar de novo a mesma prescrição: o paciente vê
      "Coleta remarcada" e, no histórico completo, o cancelamento e a remarcação
      como eventos separados.
- [ ] Agendamento cancelado e prescrição não autorizada mostram "Falar com a
      unidade" (WhatsApp do posto) ou a orientação de procurar a unidade.
- [ ] Não existe mais "Transferir de unidade" em nenhuma tela.
- [ ] Nome com "de/da/dos" (ex.: "Maria de Souza") aparece certo no topo.
- [ ] Celular: sem botão de menu no topo e sem rodapé; barra de baixo com "Mais"
      (perfil, ajuda, termos, sair) nos três perfis; comprovante e botões do fim
      da página não ficam atrás da barra.
- [ ] Computador: em página curta o rodapé encosta na base da tela, sem faixa branca.
- [ ] Homes do admin e do autorizador mostram números reais (conferir com as listas).
- [ ] Histórico da prescrição, Prescrições para análise, Agendamentos (admin) e
      Minhas prescrições têm paginação; busca e filtros continuam funcionando.

---

## Depois de testar

- Apague o branch `teste-melhorias` no Neon (some com a cópia dos dados).
- Remova as variáveis de **Preview** que criou na Vercel.
- Apague o `.env.local` do frontend se não for mais usar.
- Para publicar de verdade: rodar a migração no **main** do Neon → juntar o
  backend no `main` → juntar o frontend no `main`.
