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
import autorizarAut from "./middleware/autorizarAut.js";


const routes = express.Router();

routes.get('/', raizControllers.index);

// Rotas do paciente
routes.get('/pacientesall', pacientesControllers.pacientesall);

// Rota post do paciente
routes.post('/pacientes', pacientesControllers.createpaciente);

routes.get('/pacientes', authorization, autorizarAdmin, pacientesControllers.buscarPorCpf);
routes.put(
    "/pacientes/perfil", authorization, pacientesControllers.atualizarPerfil
);

routes.post('/login',administradorControllers.loginGeral)

//Rota de Validação de Token
routes.get('/validar', authorization, (req, res)=>{
    res.status(200).send({ message: 'Token válido', session: req.session });
});

//Rotas do posto de coleta 

routes.get('/postos/:id' , postocoleta.listarporid)
routes.get('/postos' , postocoleta.listar)


//rotas administrador

routes.get('/administradorall', administradorControllers.administradorall);

routes.post('/administrador', administradorControllers.createadministrador);

//rotas autorizador
routes.get('/autorizadorall',authorization,autorizarAut, autorizadorControllers.autorizadorrall);
routes.post('/autorizador', authorization, autorizarAut, autorizadorControllers.createautorizador);
routes.get('/prescricao/aprovadas',authorization,autorizarAut, autorizadorControllers.buscarPrescricoesAprovadas);


//agendamento
routes.get('/agendamentos', authorization, autorizarAdmin, agendamentosControllers.listar);
routes.post('/agendamentos', authorization, autorizarAdmin, agendamentosControllers.criar);

routes.patch('/agendamentos/:id/concluir', authorization, autorizarAdmin, 
agendamentosControllers.concluir);
routes.patch('/agendamentos/:id/cancelar', authorization, autorizarAdmin, agendamentosControllers.cancelar);

routes.get('/meus-agendamentos', authorization, agendamentosControllers.listarMeusAgendamentos);
routes.get('/meus-agendamentos/proximo', authorization, agendamentosControllers.proximoAgendamento);

//rotas insumos
routes.patch('/insumos/:id', authorization,autorizarAdmin, insumosControllers.movimentar);

routes.get('/insumos/listar', authorization, autorizarAdmin, insumosControllers.listar);

routes.get('/insumos', authorization, autorizarAdmin, insumosControllers.buscar);

routes.post('/insumos', authorization, autorizarAdmin, insumosControllers.criarInsumo);


//rotas solicitaçao
routes.post('/solicitacoes',authorization,solicitacaoControllers.createSolicitacao);

routes.get('/pendentes',authorization,autorizarAdmin,solicitacaoControllers.buscarprescricoespendetes);

routes.get(
    "/solicitacao/:id/prescricao",
    authorization, autorizarAdmin, validarAcessoSolicitacao,
    solicitacaoControllers.buscarPrescricao
  );

routes.get("/solicitacao/pacienteid", authorization, solicitacaoControllers.prescicaodopaciente);


routes.get(
  "/solicitacao/:id/detalhes",authorization,solicitacaoControllers.detalhesPrescricaoPaciente
);


routes.get(
  "/solicitacao/:id",
  authorization, autorizarAdmin, validarAcessoSolicitacao,
  solicitacaoControllers.buscarSolicitacaoPorId
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

export default routes;