const express = require('express');
const pacientesControllers = require('./controllers/pacientesControllers');
const raizControllers = require('./controllers/raizControllers');
const routes = express.Router();

routes.get('/', raizControllers.raiz);
//rotas do paciente
routes.get('/pacientesall', pacientesControllers.pacientesall);
//rota post do paciente
routes.post('/pacientes', pacientesControllers.createpaciente);

module.exports = routes;
    
