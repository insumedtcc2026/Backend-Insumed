import knex from '../database/index.js';
import bcrypt from 'bcrypt'

export default  {
//busca todos os dados da tabela pacientes
  async pacientesall(req, res) {
    try {
      const nome = await knex('pacientes');
      console.log(nome);
      return res.status(200).send(nome);
    } catch (error) {
      res.status(500).send({ message: 'Erro ao buscar pacientes', error: error.message });
    }
  },


//cria um novo paciente
  async createpaciente(req, res) {
  try {
    

    console.log("BODY:", req.body);

    const {
      nome,
      email,
      telefone,
      cpf,
      data_nasc,
      sexo,
      endereco,
      raca,
      senha
    } = req.body;
    const sexoLimpo = sexo?.trim().toLowerCase();

let sexoFormatado = null;
if (sexo?.toLowerCase() === "masculino") sexoFormatado = "M";
else if (sexo?.toLowerCase() === "feminino") sexoFormatado = "F";
else if (sexo?.toLowerCase() === "outro") sexoFormatado = "O";

    console.log("NOME:", nome);
    console.log("EMAIL:", email);
    console.log("SENHA:", senha);

    if (!senha) {
      throw new Error("Senha está undefined");
    }

    const hashSenha = await bcrypt.hash(senha, 10);

    const dadoscreate = {
      pac_nome: nome,
      pac_email: email,
      pac_telefone: telefone,
      pac_senha: hashSenha,
      pac_cpf: cpf,
      pac_data_nasc: data_nasc || null,
      pac_sexo: sexoFormatado || null,
      pac_endereco: endereco,
      pac_raca: raca || null
    };

    console.log("DADOS PARA INSERT:", dadoscreate);

    
    await knex('pacientes').insert(dadoscreate);

    console.log("SEXO ORIGINAL:", sexo);
console.log("SEXO FORMATADO:", sexoFormatado);

    res.status(201).json({ msg: "OK" });

  } catch (erro) {
    console.error(" ERRO NO BACKEND:", erro);
    res.status(500).json({ erro: erro.message });
  }
}
   

}