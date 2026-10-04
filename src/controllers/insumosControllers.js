import knex from "../database/index.js";

export default {
  async buscar(req, res) {
    try {
      const admin = req.session;
      const universal = Boolean(admin.tp_universal);

      if (!busca) {
        return res.status(200).send([]);
      }

      let consulta = knex("insumo").where(function () {
        this.whereILike("ins_nome", `%${busca}%`).orWhereRaw(
          "CAST(ins_id AS TEXT) LIKE ?",
          [`%${busca}%`],
        );
      });

      if (!universal) {
        consulta = req.session.posto_id
          ? consulta.where("pos_id", req.session.posto_id)
          : consulta.whereNull("pos_id");
      }

      const insumos = await consulta
        .select("ins_id", "ins_nome", "ins_quantidade", "ins_marca", "pos_id")
        .limit(10);

      return res.status(200).send(insumos);
    } catch (error) {
      return res
        .status(500)
        .send({ message: "Erro ao buscar insumos", error: error.message });
    }
  },

  async listar(req, res) {
    try {
      const {  } = req.query;
      const admin = req.session;
      const universal = Boolean(admin.tp_universal);

      let consulta = knex("insumo")
        .leftJoin("postosdesaude", "insumo.pos_id", "postosdesaude.pos_id")
        .select(
          "insumo.ins_id",
          "insumo.ins_nome",
          "insumo.ins_quantidade",
          "insumo.ins_marca",
          "postosdesaude.pos_nome as posto_nome",
        );

      if (!universal) {
        consulta = req.session.posto_id
          ? consulta.where("insumo.pos_id", req.session.posto_id)
          : consulta.whereNull("insumo.pos_id");
      }

      const insumos = await consulta
      .orderBy('insumo.ins_nome')

      return res.status(200).send(insumos);
    } catch (error) {
      return res
        .status(500)
        .send({ message: "Erro ao listar insumos", error: error.message });
    }
  },

  async criarInsumo(req, res) {
    try {
      const { nome, quantidade, marca } = req.body;

      const nomeLimpo = nome?.trim();
      const marcaLimpa = marca?.trim() || null;
      const quant = Number(quantidade);

      if (!nomeLimpo) {
        return res.status(400).send({ message: "O campo nome é obrigatório" });
      }
      if (!Number.isFinite(quant) || quant <= 0) {
        return res
          .status(400)
          .send({ message: "A quantidade deve ser um número maior que zero" });
      }

      const posId = req.session.posto_id ?? null;

      let consulta = knex("insumo")
        .whereRaw("LOWER(TRIM(ins_nome)) = LOWER(?)", [nomeLimpo])
        .whereRaw("LOWER(COALESCE(TRIM(ins_marca), '')) = LOWER(?)", [
          marcaLimpa || "",
        ]);

      consulta = posId
        ? consulta.where("pos_id", posId)
        : consulta.whereNull("pos_id");

      const existe = await consulta.first();

      if (existe && Number(existe.ins_quantidade) > 0) {
        return res
          .status(409)
          .send({
            message:
              "Este insumo já está cadastrado com essa marca e ainda tem estoque",
          });
      }

      if (existe) {
        await knex("insumo")
          .where("ins_id", existe.ins_id)
          .update({ ins_quantidade: quant });
        return res
          .status(200)
          .send({
            message: "Este insumo foi reabastecido com sucesso!",
            ins_id: existe.ins_id,
          });
      }

      const result = await knex("insumo")
        .insert({
          ins_nome: nomeLimpo,
          ins_quantidade: quant,
          ins_marca: marcaLimpa,
          pos_id: posId,
        })
        .returning("*");

      return res
        .status(201)
        .send({ message: "Insumo criado com sucesso", insumo: result[0] });
    } catch (error) {
      return res
        .status(500)
        .send({ message: "Erro ao criar insumo", error: error.message });
    }
  },
};
