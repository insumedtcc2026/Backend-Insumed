import express, { Router } from "express";
import pacientesControllers from './controllers/pacientesControllers.js'; // Adicionado .js
import raizControllers from './controllers/raizControllers.js'; // Adicionado .js
import administradorControllers from "./controllers/administradorControllers.js";
import prescritorControllers from "./controllers/prescritorControllers.js";
import authorization from './middleware/autorizar.js' // Se for descomentar depois, adicione aqui também!
import postocoleta from './controllers/postocoleta.js'
import autorizarAdmin from "./middleware/autorizarAdmin.js";
import agendamentosControllers from "./controllers/agendamentosControllers.js";
import insumosControllers from "./controllers/insumosControllers.js";
import solicitacaoControllers from "./controllers/solicitacaoControllers.js";


const routes = express.Router();

//routes.get('/', raizControllers.raiz);

// Rotas do paciente
routes.get('/pacientesall', pacientesControllers.pacientesall);

// Rota post do paciente
routes.post('/pacientes', pacientesControllers.createpaciente);

routes.get('/pacientes', authorization, autorizarAdmin, pacientesControllers.buscarPorCpf);

routes.post('/login',pacientesControllers.login)

//Rota de Validação de Token
routes.get('/validar', authorization, (req, res)=>{
    res.status(200).send({ message: 'Token válido', session: req.session });
});

//Rotas do posto de coleta 
routes.get('/postos' , postocoleta.listar)


//rotas administrador

routes.get('/administradorall', administradorControllers.administradorall);

routes.post('/administrador', administradorControllers.createadministrador);

//rotas prescritor
routes.get('/prescritorall', prescritorControllers.prescritorall);

//agendamento
routes.get('/agendamentos', agendamentosControllers.listar);
routes.post('/agendamentos', agendamentosControllers.criar);

routes.patch('/agendamentos/:id/concluir', authorization, autorizarAdmin, 
agendamentosControllers.concluir);
routes.patch('/agendamentos/:id/cancelar', authorization, autorizarAdmin, agendamentosControllers.cancelar);

routes.get('/meus-agendamentos', authorization, agendamentosControllers.listarMeusAgendamentos);


routes.get('/insumos', authorization, autorizarAdmin, insumosControllers.buscar)


//rota solicitaçao
routes.post('/solicitacoes',authorization,solicitacaoControllers.createSolicitacao);


routes.get('/pendentes',authorization,autorizarAdmin,solicitacaoControllers.buscarprescricoespendetes);

routes.get(
    "/solicitacao/:id/prescricao",authorization, autorizarAdmin,
    solicitacaoControllers.buscarPrescricao
);
routes.get(
  "/solicitacao/:id",
  authorization,
  autorizarAdmin,
  solicitacaoControllers.buscarSolicitacaoPorId
);

routes.patch(
  "/solicitacao/:id/reenvio",
  authorization,
  autorizarAdmin,
  solicitacaoControllers.pedirReenvio
);

routes.patch('/solicitacoes/:id',authorization,autorizarAdmin,solicitacaoControllers.alterarStatus);

export default routes;