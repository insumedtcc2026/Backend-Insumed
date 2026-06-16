const express = require('express');
<<<<<<< HEAD
const pacientesControllers = require('./controllers/pacientesControllers');
const raizControllers = require('./controllers/raizControllers');
const routes = express.Router();
routes.get('/', raizControllers.raiz);
//routes.get('/pacientes:nome', pacientesControllers.pacientes);
routes.get('/pacientesall', pacientesControllers.pacientesall);


module.exports = routes;
=======

const routes = express.Router();
module.exports = routes;        
>>>>>>> 79f0a170dbcd44e51d946edcd5ec90f894222866
