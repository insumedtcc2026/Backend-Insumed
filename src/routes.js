const express = require('express');
const pacientesControllers = require('./controllers/pacientesControllers');
const raizControllers = require('./controllers/raizControllers');
const routes = express.Router();
routes.get('/', raizControllers.raiz);
//routes.get('/pacientes:nome', pacientesControllers.pacientes);
routes.get('/pacientesall', pacientesControllers.pacientesall);


module.exports = routes;