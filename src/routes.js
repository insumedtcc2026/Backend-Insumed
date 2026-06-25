import express from "express";
import pacientesControllers from './controllers/pacientesControllers.js'; // Adicionado .js
import raizControllers from './controllers/raizControllers.js'; // Adicionado .js
// import autorizar from './middleware/autorizar.js' // Se for descomentar depois, adicione aqui também!

const routes = express.Router();

routes.get('/', raizControllers.raiz);

// Rotas do paciente
routes.get('/pacientesall', pacientesControllers.pacientesall);

// Rota post do paciente
routes.post('/pacientes', pacientesControllers.createpaciente);

export default routes;