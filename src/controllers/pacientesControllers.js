const knex = require('../database/index.js');

module.exports = {
async create(req, res) {
    const { nome } = req.body;

    const dadosteste = {
        'nome' : nome,
    };
  },
}