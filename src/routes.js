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

// Perfil pessoal do admin e do autorizador
const autorizarAdminOuAut = (req, res, next) =>
    ['ADMIN', 'AUTORIZADOR'].includes(req.session?.tipo)
        ? next()
        : res.status(403).json({ error: 'Acesso restrito a administradores e autorizadores' });
routes.get('/perfil', authorization, autorizarAdminOuAut, painelControllers.meuPerfil);
routes.put('/perfil', authorization, autorizarAdminOuAut, painelControllers.atualizarMeuPerfil);

// Home do admin (fila de trabalho)
routes.get('/painel/admin', authorization, autorizarAdmin, painelControllers.painelAdmin);
// atividades da unidade (histórico geral de quem fez o quê)
routes.get('/atividades', authorization, autorizarAdmin, painelControllers.atividades);

routes.post('/login', limiteLogin, administradorControllers.loginGeral)

//Rota de Validação de Token
routes.get('/validar', authorization, (req, res)=>{
    res.status(200).send({ message: 'Token válido', session: req.session });
});

//Rotas do posto de coleta 

routes.get('/postos/:id' , postocoleta.listarporid)
routes.get('/postos' , postocoleta.listar)


//rotas administrador

routes.get('/administradorall', authorization, autorizarAdmin, administradorControllers.administradorall);

routes.post('/administrador', administradorControllers.createadministrador);

//rotas autorizador
routes.get('/autorizadorall',authorization,autorizarAut, autorizadorControllers.autorizadorrall);
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
routes.get('/agendamentos/datas-sugeridas', authorization, autorizarAdmin, painelControllers.datasSugeridas);
routes.post('/agendamentos', authorization, autorizarAdmin, agendamentosControllers.criar);

routes.patch('/agendamentos/:id/concluir', authorization, autorizarAdmin, 
agendamentosControllers.concluir);
routes.patch('/agendamentos/:id/cancelar', authorization, autorizarAdmin, agendamentosControllers.cancelar);
routes.patch('/agendamentos/:id/recado', authorization, autorizarAdmin, agendamentosControllers.salvarRecado);

routes.get('/meus-agendamentos', authorization, agendamentosControllers.listarMeusAgendamentos);
routes.get('/meus-agendamentos/proximo', authorization, agendamentosControllers.proximoAgendamento);

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


// transferir prescrição em andamento ou agendamento para outra unidade
routes.patch(
  "/solicitacao/:id/transferir",
  authorization, autorizarAdmin, validarAcessoSolicitacao,
  solicitacaoControllers.transferirUnidade
);

// histórico (quem fez o quê); o controller confere o perfil e a posse
routes.get("/solicitacao/:id/historico", authorization, solicitacaoControllers.historico);

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

export default routes;