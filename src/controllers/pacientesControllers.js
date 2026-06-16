const knex = require('../database/index.js');

module.exports = {
async pacientes(req, res) {
    const {pac_nome } = req.params;
    const nome = await knex('pacientes').where('pac_nome', '=', pac_nome);
    console.log(nome);
    
    return res.status(200).send(nome);
  },

  async pacientesall(req, res) {
    const nome = await knex('pacientes');
    console.log(nome);
    
    return res.status(200).send(nome);
  },
}