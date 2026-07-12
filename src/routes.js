import express from "express";
import pacientesControllers from './controllers/pacientesControllers.js'; // Adicionado .js
import raizControllers from './controllers/raizControllers.js'; // Adicionado .js
import authorization from './middleware/autorizar.js' // Se for descomentar depois, adicione aqui também!

const routes = express.Router();

routes.get('/', raizControllers.raiz);

// Rotas do paciente
routes.get('/pacientesall', pacientesControllers.pacientesall);

// Rota post do paciente
routes.post('/pacientes', pacientesControllers.createpaciente);

routes.post('/login',pacientesControllers.login)

//Rota de Validação de Token
routes.get('/validar', authorization,(req, res)=>{
    res.status(200).send({ message: 'Token válido', session: req.session });
});


export default routes;