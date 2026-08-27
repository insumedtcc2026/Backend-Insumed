import knex from '../database/index.js';
export default{

async buscar(req, res) {
  try {
    const { busca } = req.query;

    if (!busca) {
      return res.status(200).send([]);
    }

    const insumos = await knex('insumo')
      .where(function () {
        this.whereILike('ins_nome', `%${busca}%`)
          .orWhereRaw(
            'CAST(ins_id AS TEXT) LIKE ?',
            [`%${busca}%`]
          );
      })
      .select(
        'ins_id',
        'ins_nome',
        'ins_quantidade'
      )
      .limit(10);

    return res.status(200).send(insumos);

  } catch (error) {
    return res.status(500).send({
      message: 'Erro ao buscar insumos',
      error: error.message
    });
  }
}
}