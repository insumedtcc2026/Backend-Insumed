import express from "express";
import pacientesControllers from './controllers/pacientesControllers.js'; // Adicionado .js
import raizControllers from './controllers/raizControllers.js'; // Adicionado .js
import administradorControllers from "./controllers/administradorControllers.js";
import prescritorControllers from "./controllers/prescritorControllers.js";
import authorization from './middleware/autorizar.js' // Se for descomentar depois, adicione aqui também!
import postocoleta from './controllers/postocoleta.js'


const routes = express.Router();

//routes.get('/', raizControllers.raiz);

// Rotas do paciente
routes.get('/pacientesall', pacientesControllers.pacientesall);

// Rota post do paciente
routes.post('/pacientes', pacientesControllers.createpaciente);

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




export default routes;