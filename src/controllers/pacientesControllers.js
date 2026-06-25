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
    const { nome , email, telefone, cpf, data_nasc, sexo, endereco, raça, senha } = req.body;

//criptografa a senha do paciente
try {
 const hashSenha = await bcrypt.hash(req.body.senha, 10);

const dadoscreate = {
    'pac_nome': nome,
    'pac_email': email,
    'pac_telefone': telefone, 
    'pac_senha': hashSenha,
    'pac_cpf': cpf,
    'pac_data_nasc': data_nasc, 
    'pac_sexo': sexo,
    'pac_endereço': endereco, 
    'pac_raça': raça
};
     
     await knex('pacientes').insert(dadoscreate);
 
     return res.status(201).send({ message: 'Paciente cadastrado com sucesso!' });
   }
   catch (erro){
    return res.status(500).send({ message: 'Erro ao cadastrar novo paciente',error: erro.message });
   }
  
   },

}