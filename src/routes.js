import express, { Router } from "express";
import pacientesControllers from './controllers/pacientesControllers.js'; 
import raizControllers from './controllers/raizControllers.js'; 
import administradorControllers from "./controllers/administradorControllers.js";
import authorization from './middleware/autorizar.js' 
import postocoleta from './controllers/postocoleta.js'
import autorizarAdmin from "./middleware/autorizarAdmin.js";
import validarAcessoSolicitacao from "./middleware/autorizarADMrefposto.js"; 
import agendamentosControllers from "./controllers/agendamentosControllers.js";
import insumosControllers from "./controllers/insumosControllers.js";
import solicitacaoControllers from "./controllers/solicitacaoControllers.js";
import autorizadorControllers from "./controllers/autorizadorControllers.js";
import painelControllers from "./controllers/painelControllers.js";
import autorizarAut from "./middleware/autorizarAut.js";
import autorizarVisualizacaoPrescricao from "./middleware/autorizarVisualizacaoPrescricao.js";
import { limiteLogin } from "./middleware/limiteLogin.js";
import autorizarPaciente from "./middleware/autorizarPaciente.js";
import { idValido } from "./utils/validacoes.js";
import notificacoesControllers from "./controllers/notificacoesControllers.js";
import autorizarCron from "./middleware/autorizarCron.js";
import { limiteLeituraQR } from "./middleware/limiteLeituraQR.js";
import equipeControllers from "./controllers/equipeControllers.js";
import autorizarUniversal from "./middleware/autorizarUniversal.js";
import agendaControllers from "./controllers/agendaControllers.js";
import participacaoControllers from "./controllers/participacaoControllers.js";
import autorizadosControllers from "./controllers/autorizadosControllers.js";
import meusInsumosControllers from "./controllers/meusInsumosControllers.js";
import gestaoControllers from "./controllers/gestaoControllers.js";


const routes = express.Router();

// Todo ":id" das rotas precisa ser um número inteiro positivo; sem isso,
// "/solicitacao/abc" chegava ao banco e virava erro 500.
routes.param('id', (req, res, next, id) => {
    if (!idValido(id)) {
        return res.status(400).json({ error: 'Identificador inválido.' });
    }
    return next();
});

routes.get('/', raizControllers.index);

// Rotas do paciente
routes.get('/pacientesall', authorization, autorizarAdmin, pacientesControllers.pacientesall);

// Rota post do paciente
routes.post('/pacientes', pacientesControllers.createpaciente);

routes.get('/pacientes', authorization, autorizarAdmin, pacientesControllers.buscarPorCpf);
routes.put(
    "/pacientes/perfil", authorization, autorizarPaciente, pacientesControllers.atualizarPerfil
);
// ficha completa do paciente (dados, prescrições e agendamentos) para o admin
routes.get('/pacientes/:id/resumo', authorization, autorizarAdmin, pacientesControllers.resumoPaciente);
// prioridade legal: o paciente declara, a unidade confere
routes.patch('/pacientes/minha-prioridade', authorization, autorizarPaciente, pacientesControllers.minhaPrioridade);
routes.patch('/pacientes/:id/prioridade', authorization, autorizarAdmin, pacientesControllers.conferirPrioridade);
// pessoas autorizadas a retirar no lugar do paciente (a unidade cadastra; o paciente consulta)
routes.get('/pacientes/:id/autorizados', authorization, autorizarAdmin, autorizadosControllers.listar);
routes.post('/pacientes/:id/autorizados', authorization, autorizarAdmin, autorizadosControllers.criar);
routes.put('/pacientes/:id/autorizados/:pau', authorization, autorizarAdmin, autorizadosControllers.atualizar);
routes.delete('/pacientes/:id/autorizados/:pau', authorization, autorizarAdmin, autorizadosControllers.remover);
routes.get('/meus-autorizados', authorization, autorizarPaciente, autorizadosControllers.meus);
// insumos em uso do paciente, com "Indisponível" quando faltar na unidade
routes.get('/meus-insumos', authorization, autorizarPaciente, meusInsumosControllers.listar);

// Perfil pessoal do admin e do autorizador
const autorizarAdminOuAut = (req, res, next) =>
    ['ADMIN', 'AUTORIZADOR'].includes(req.session?.tipo)
        ? next()
        : res.status(403).json({ error: 'Acesso restrito a administradores e autorizadores' });
routes.get('/perfil', authorization, autorizarAdminOuAut, painelControllers.meuPerfil);
routes.put('/perfil', authorization, autorizarAdminOuAut, painelControllers.atualizarMeuPerfil);
// troca da própria senha (obrigatória no primeiro acesso com senha provisória)
routes.put('/minha-senha', authorization, autorizarAdminOuAut, equipeControllers.trocarSenha);

// Equipe da rede (só o admin universal): lista, cadastro direto com senha
// provisória, desativar/reativar e convites para o cadastro pelo link
routes.get('/equipe', authorization, autorizarUniversal, equipeControllers.listar);
routes.post('/equipe', authorization, autorizarUniversal, equipeControllers.cadastrar);
routes.patch('/equipe/:perfil/:id/ativo', authorization, autorizarUniversal, equipeControllers.alterarAtivo);
// público: dados do convite para o formulário do link (perfil e unidade)
routes.get('/convites/info', equipeControllers.infoConvite);
routes.get('/convites', authorization, autorizarUniversal, equipeControllers.listarConvites);
routes.post('/convites', authorization, autorizarUniversal, equipeControllers.criarConvite);
routes.delete('/convites/:id', authorization, autorizarUniversal, equipeControllers.cancelarConvite);

// Home do admin (fila de trabalho)
routes.get('/painel/admin', authorization, autorizarAdmin, painelControllers.painelAdmin);
// Home do autorizador
routes.get('/painel/autorizador', authorization, autorizarAut, autorizadorControllers.painelAutorizador);
// atividades da unidade (histórico geral de quem fez o quê)
// previsão de demanda por insumo (30, 60 ou 90 dias)
routes.get('/indicadores/previsao', authorization, autorizarAdmin, gestaoControllers.previsao);

routes.get('/atividades', authorization, autorizarAdmin, painelControllers.atividades);

routes.post('/login', limiteLogin, administradorControllers.loginGeral)

//Rota de Validação de Token
routes.get('/validar', authorization, (req, res)=>{
    res.status(200).send({ message: 'Token válido', session: req.session });
});

//Rotas do posto de coleta 

// horário da unidade: leitura pública; turnos, vagas e dias fechados pelo admin
routes.get('/postos/:id/horarios', agendaControllers.horarios);
routes.put('/postos/:id/horarios', authorization, autorizarAdmin, agendaControllers.salvarHorarios);
routes.post('/postos/:id/bloqueios', authorization, autorizarAdmin, agendaControllers.criarBloqueio);
routes.delete('/postos/:id/bloqueios/:bloqueio', authorization, autorizarAdmin, agendaControllers.removerBloqueio);
routes.get('/postos/:id/agenda', authorization, autorizarAdmin, agendaControllers.ocupacao);
routes.get('/postos/:id' , postocoleta.listarporid)
routes.get('/postos' , postocoleta.listar)


//rotas administrador

routes.get('/administradorall', authorization, autorizarAdmin, administradorControllers.administradorall);

// cadastro pelo link do convite (o controller exige um convite válido)
routes.post('/administrador', administradorControllers.createadministrador);

//rotas autorizador
routes.get('/autorizadorall',authorization,autorizarAut, autorizadorControllers.autorizadorrall);
// cadastro pelo link do convite (o controller exige um convite válido)
routes.post('/autorizador',  autorizadorControllers.createautorizador);
routes.get('/prescricao/aprovadas',authorization,autorizarAut, autorizadorControllers.buscarPrescricoesAprovadas);

routes.get(
  '/autorizador/solicitacao/:id',
  authorization,
  autorizarAut,
  autorizadorControllers.buscarSolicitacaoAprovada
);

routes.get(
  '/autorizador/solicitacao/:id/prescricao',
  authorization,
  autorizarAut,
  autorizarVisualizacaoPrescricao,
  autorizadorControllers.buscarPrescricaoAprovada
);

routes.patch(
  '/autorizador/solicitacao/:id',
  authorization,
  autorizarAut,
  autorizarVisualizacaoPrescricao,
  autorizadorControllers.alterarStatusAutorizador
);


//agendamento
routes.get('/agendamentos', authorization, autorizarAdmin, agendamentosControllers.listar);
// lista de separação do dia (por insumo e por paciente)
routes.get('/agendamentos/separacao', authorization, autorizarAdmin, gestaoControllers.separacao);
routes.get('/agendamentos/datas-sugeridas', authorization, autorizarAdmin, painelControllers.datasSugeridas);
routes.post('/agendamentos', authorization, autorizarAdmin, agendamentosControllers.criar);

// admin de posto só age nos agendamentos do próprio posto (validarAcessoSolicitacao);
// o admin universal age em todos
// leitor de QR Code do comprovante (texto lido em ?codigo=) e tela de
// atendimento aberta por ele (só concluir/cancelar)
routes.get('/agendamentos/qrcode', authorization, autorizarAdmin, limiteLeituraQR, agendamentosControllers.buscarPorQRCode);
routes.get('/agendamentos/:id/atendimento', authorization, autorizarAdmin, validarAcessoSolicitacao, agendamentosControllers.dadosAtendimento);
routes.patch('/agendamentos/:id/concluir', authorization, autorizarAdmin, validarAcessoSolicitacao, agendamentosControllers.concluir);
routes.patch('/agendamentos/:id/cancelar', authorization, autorizarAdmin, validarAcessoSolicitacao, agendamentosControllers.cancelar);
routes.patch('/agendamentos/:id/recado', authorization, autorizarAdmin, validarAcessoSolicitacao, agendamentosControllers.salvarRecado);
// nova data no mesmo agendamento (mesmo protocolo)
routes.patch('/agendamentos/:id/remarcar', authorization, autorizarAdmin, validarAcessoSolicitacao, agendamentosControllers.remarcar);
routes.patch('/agendamentos/:id/pedido-outra-data', authorization, autorizarAdmin, validarAcessoSolicitacao, participacaoControllers.responderPedido);

routes.get('/meus-agendamentos', authorization, agendamentosControllers.listarMeusAgendamentos);
routes.get('/meus-agendamentos/proximo', authorization, agendamentosControllers.proximoAgendamento);
// o paciente na agenda: outra data, presença e cancelamento do próprio agendamento
routes.get('/meus-agendamentos/:id/opcoes', authorization, autorizarPaciente, participacaoControllers.opcoes);
routes.post('/meus-agendamentos/:id/outra-data', authorization, autorizarPaciente, participacaoControllers.pedirOutraData);
routes.patch('/meus-agendamentos/:id/presenca', authorization, autorizarPaciente, participacaoControllers.presenca);
routes.patch('/meus-agendamentos/:id/cancelar', authorization, autorizarPaciente, participacaoControllers.cancelarPeloPaciente);

//rotas insumos
routes.patch('/insumos/:id', authorization,autorizarAdmin, insumosControllers.movimentar);

routes.get('/insumos/listar', authorization, autorizarAdmin, insumosControllers.listar);

routes.get('/insumos', authorization, autorizarAdmin, insumosControllers.buscar);

routes.post('/insumos', authorization, autorizarAdmin, insumosControllers.criarInsumo);


//rotas solicitaçao
routes.post('/solicitacoes', authorization, autorizarPaciente, solicitacaoControllers.createSolicitacao);

routes.get('/pendentes',authorization,autorizarAdmin,solicitacaoControllers.buscarprescricoespendetes);

routes.get(
    "/solicitacao/:id/prescricao",
    authorization, autorizarAdmin, validarAcessoSolicitacao,
    solicitacaoControllers.buscarPrescricao
  );

routes.get("/solicitacao/pacienteid", authorization, autorizarPaciente, solicitacaoControllers.prescicaodopaciente);
// prescrições do paciente com agendamento e linha do tempo (rastreio)
routes.get("/minhas-prescricoes", authorization, autorizarPaciente, solicitacaoControllers.minhasPrescricoes);


routes.get(
  "/solicitacao/:id/detalhes", authorization, autorizarPaciente, solicitacaoControllers.detalhesPrescricaoPaciente
);


routes.get(
  "/solicitacao/:id",
  authorization, autorizarAdmin, validarAcessoSolicitacao,
  solicitacaoControllers.buscarSolicitacaoPorId
);


// A transferência entre unidades foi removida (não faz parte da proposta
// atual). A rota responde 410 para chamadas antigas, sem alterar nada.
routes.patch("/solicitacao/:id/transferir", authorization, (req, res) =>
  res.status(410).json({ error: "A transferência entre unidades não está mais disponível." })
);

// reenvio feito pelo paciente, dentro da mesma solicitação
routes.patch("/solicitacao/:id/corrigir", authorization, autorizarPaciente, solicitacaoControllers.corrigirPrescricao);

// versões anteriores da prescrição (o controller confere o perfil e a posse)
routes.get("/solicitacao/:id/versoes", authorization, solicitacaoControllers.versoes);
routes.get("/solicitacao/:id/versoes/:versao/arquivo", authorization, solicitacaoControllers.arquivoVersao);

// histórico (quem fez o quê); o controller confere o perfil e a posse
routes.get("/solicitacao/:id/historico", authorization, solicitacaoControllers.historico);

// prescrição não autorizada volta ao autorizador, com observação da unidade
routes.patch(
  "/solicitacao/:id/refazer",
  authorization, autorizarAdmin, validarAcessoSolicitacao,
  solicitacaoControllers.refazerPedido
);

routes.patch(
  "/solicitacao/:id/reenvio",
  authorization, autorizarAdmin, validarAcessoSolicitacao,
  solicitacaoControllers.pedirReenvio
);

routes.get(
    "/prescricoes/historico",
    authorization, autorizarAdmin,
    solicitacaoControllers.buscarHistoricoPrescricoes
);

routes.patch(
  '/solicitacao/:id',
  authorization, autorizarAdmin, validarAcessoSolicitacao,solicitacaoControllers.alterarStatus
);

// Notificações do sino: sempre as da pessoa logada (paciente, admin ou autorizador)
routes.get('/notificacoes', authorization, notificacoesControllers.listar);
routes.get('/notificacoes/resumo', authorization, notificacoesControllers.resumo);
routes.patch('/notificacoes/lidas', authorization, notificacoesControllers.marcarTodas);
routes.patch('/notificacoes/:id/lida', authorization, notificacoesControllers.marcarLida);

// Tarefa diária (Vercel Cron): lembretes, pendências, não compareceu, vencidas
routes.get('/tarefas/diaria', autorizarCron, notificacoesControllers.tarefaDiaria);

export default routes;