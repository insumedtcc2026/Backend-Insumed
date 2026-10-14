import knex from '../database/index.js';
import { dataHojeBrasil, validarDataISO, validarMotivo } from '../utils/validacoes.js';
import { ACOES, registrarHistorico } from '../utils/historico.js';

const TAMANHO_MAX_RECADO = 300;

// Monta o protocolo de atendimento a partir do sol_id, ex: sol_id 42 -> "AG000042"
function gerarProtocolo(sol_id) {
    return `AG${String(sol_id).padStart(6, '0')}`;
}

// Agrupa as linhas "achatadas" do JOIN (uma linha por insumo) no formato
// aninhado que o frontend espera (um objeto por agendamento, com um
// array de insumos dentro).
function agruparPorAgendamento(resultado) {
    const mapa = new Map();

    resultado.forEach((linha) => {
        if (!mapa.has(linha.sol_id)) {
            mapa.set(linha.sol_id, {
                sol_id: linha.sol_id,
                sol_protocolo: linha.sol_protocolo,
                sol_data_de_coleta: linha.sol_data_de_coleta,
                status: linha.sol_status,
                sol_motivo_cancelamento: linha.sol_motivo_cancelamento ?? null,
                sol_data_cancelamento: linha.sol_data_cancelamento ?? null,
                sol_origem_id: linha.sol_origem_id ?? null,
                sol_recado: linha.sol_recado ?? null,

                paciente: {
                    pac_id: linha.pac_id,
                    pac_nome: linha.pac_nome,
                    pac_cpf: linha.pac_cpf,
                    pac_telefone: linha.pac_telefone
                },

                posto: {
                    pos_id: linha.pos_id,
                    pos_nome: linha.pos_nome,
                    pos_endereco: linha.pos_endereco ?? null,
                    pos_whatsapp: linha.pos_whatsapp ?? null
                },

                insumos: []
            });
        }

        const agendamento = mapa.get(linha.sol_id);

        if (linha.ins_id !== null) {
            agendamento.insumos.push({
                ins_id: linha.ins_id,
                ins_nome: linha.ins_nome,
                quantidade: linha.quantidade
            });
        }
    });

    return Array.from(mapa.values());
}

const SELECT_AGENDAMENTO = [
    'sol.sol_id',
    'sol.sol_protocolo',
    'sol.sol_data_de_coleta',
    'sol.sol_status',
    'sol.sol_motivo_cancelamento',
    'sol.sol_data_cancelamento',
    'sol.sol_origem_id',
    'sol.sol_recado',

    'pac.pac_id',
    'pac.pac_nome',
    'pac.pac_cpf',
    'pac.pac_telefone',

    'pos.pos_id',
    'pos.pos_nome',
    'pos.pos_endereco',
    'pos.pos_whatsapp',

    'ins.ins_id',
    'ins.ins_nome',

    'col.quantidade'
];

const STATUS_AGENDAMENTO = ['agendado', 'concluido', 'cancelado'];

// Agendamento "ativo" = ainda conta como atendimento daquela prescrição.
const STATUS_AGENDAMENTO_ATIVO = ['agendado', 'concluido'];

const TAMANHO_MAX_NOME_INSUMO = 100;

function baseQueryAgendamentos() {
    return knex('solicitacao as sol')
        .leftJoin('pacientes as pac', 'pac.pac_id', 'sol.pac_id')
        // permite manter as solicitações mesmo quando alguma informação relacionada não existe
        .leftJoin('postosdesaude as pos', 'pos.pos_id', 'sol.pos_id')
        .leftJoin('coleta as col', 'col.sol_id', 'sol.sol_id')
        .leftJoin('insumo as ins', 'ins.ins_id', 'col.ins_id')
        // a tabela solicitacao também guarda pedidos de prescrição (outro
        // status: Pendente/Aprovado/Reenvio) — nunca misturar com agendamento
        .whereIn('sol.sol_status', ['agendado', 'concluido', 'cancelado'])
        .select(SELECT_AGENDAMENTO);
}

export default {

    // LISTAR AGENDAMENTOS (visão do ADM)
    //
    // Página única do admin, com filtro de status, busca por nome/CPF/
    // protocolo e intervalo de data. Substitui as antigas páginas
    // separadas de "hoje", "todos" e "histórico".
    async listar(req, res) {
        try {
            const {
                status,       // 'agendado' | 'concluido' | 'cancelado' | 'todos' | (vazio)
                busca,        // nome, CPF ou protocolo
                data_inicio,
                data_fim,
                // mantidos por compatibilidade com chamadas antigas:
                data,
                excluir_data,
                order
            } = req.query;

            if (status && !['todos', ...STATUS_AGENDAMENTO].includes(status)) {
                return res.status(400).send({ message: 'Filtro de status inválido.' });
            }

            if ((data_inicio && validarDataISO(data_inicio)) || (data_fim && validarDataISO(data_fim))) {
                return res.status(400).send({ message: 'Intervalo de datas inválido.' });
            }

            if (data_inicio && data_fim && data_inicio > data_fim) {
                return res.status(400).send({ message: 'A data inicial não pode ser maior que a data final.' });
            }

            let query = baseQueryAgendamentos();

            if (status && status !== 'todos') {
                query = query.where('sol.sol_status', status);
            }

            if (busca && busca.trim()) {
                const termo = busca.trim();
                const termoCpf = termo.replace(/\D/g, '');

                query = query.where((qb) => {
                    qb.whereILike('pac.pac_nome', `%${termo}%`)
                        .orWhereILike('sol.sol_protocolo', `%${termo}%`);

                    if (termoCpf) {
                        qb.orWhereRaw(
                            "REPLACE(REPLACE(pac.pac_cpf, '.', ''), '-', '') LIKE ?",
                            [`%${termoCpf}%`]
                        );
                    }
                });
            }

            if (data_inicio) {
                query = query.where('sol.sol_data_de_coleta', '>=', data_inicio);
            }

            if (data_fim) {
                query = query.where('sol.sol_data_de_coleta', '<=', data_fim);
            }

            // --- compatibilidade com o formato antigo (hoje / exceto hoje) ---
            if (data === 'hoje') {
                query = query.where('sol.sol_data_de_coleta', dataHojeBrasil());
            }
            if (excluir_data === 'hoje') {
                query = query.whereNot('sol.sol_data_de_coleta', dataHojeBrasil());
            }

            if (order === 'proximidade') {
                query = query.orderByRaw('ABS(sol.sol_data_de_coleta - ?::date)', [dataHojeBrasil()]);
            } else {
                query = query.orderBy('sol.sol_data_de_coleta', 'asc');
            }

            const resultado = await query;

            return res.status(200).send(agruparPorAgendamento(resultado));

        } catch (error) {
            console.error('Erro ao buscar agendamentos:', error);

            return res.status(500).send({
                message: 'Erro ao buscar agendamentos'
            });
        }
    },


    // CRIAR AGENDAMENTO
    async criar(req, res) {

        const trx = await knex.transaction();

        try {

            const { paciente, sol_data_de_coleta, posto, itens, sol_origem_id } = req.body ?? {};

            // VALIDAÇÕES

            const falhar = async (status, message) => {
                await trx.rollback();
                return res.status(status).send({ message });
            };

            const pac_id = Number(paciente?.pac_id);
            if (!Number.isInteger(pac_id) || pac_id <= 0) {
                return falhar(400, 'Paciente não informado');
            }

            const pos_id = Number(posto?.pos_id);
            if (!Number.isInteger(pos_id) || pos_id <= 0) {
                return falhar(400, 'Posto não informado');
            }

            if (!sol_data_de_coleta) {
                return falhar(400, 'Data de coleta não informada');
            }

            if (validarDataISO(sol_data_de_coleta)) {
                return falhar(400, 'Data de coleta inválida');
            }

            if (sol_data_de_coleta < dataHojeBrasil()) {
                return falhar(400, 'A data da coleta não pode estar no passado');
            }

            if (!Array.isArray(itens) || itens.length === 0) {
                return falhar(400, 'Nenhum insumo informado');
            }

            for (const item of itens) {
                const nome = typeof item?.ins_nome === 'string' ? item.ins_nome.trim() : '';
                const quantidade = Number(item?.quantidade);

                if (!nome || !Number.isFinite(quantidade)) {
                    return falhar(400, 'Cada insumo precisa de nome e quantidade');
                }

                if (nome.length > TAMANHO_MAX_NOME_INSUMO) {
                    return falhar(400, `O nome do insumo deve ter no máximo ${TAMANHO_MAX_NOME_INSUMO} caracteres`);
                }

                if (!Number.isInteger(quantidade) || quantidade <= 0) {
                    return falhar(400, `Quantidade inválida para "${nome}". Informe um número inteiro maior que zero`);
                }
            }

            const pacienteExiste = await trx('pacientes').where('pac_id', pac_id).first('pac_id');
            if (!pacienteExiste) {
                return falhar(404, 'Paciente não encontrado');
            }

            const postoExiste = await trx('postosdesaude').where('pos_id', pos_id).first('pos_id', 'pos_nome');
            if (!postoExiste) {
                return falhar(404, 'Posto de coleta não encontrado');
            }

            // VÍNCULO COM A PRESCRIÇÃO AUTORIZADA (quando o agendamento
            // nasce de "Agendar" numa prescrição autorizada)
            let origemId = null;

            if (sol_origem_id !== undefined && sol_origem_id !== null && sol_origem_id !== '') {
                origemId = Number(sol_origem_id);

                if (!Number.isInteger(origemId) || origemId <= 0) {
                    return falhar(400, 'Prescrição de origem inválida');
                }

                // trava a prescrição: dois cliques simultâneos esperam um pelo outro
                const origem = await trx('solicitacao')
                    .where('sol_id', origemId)
                    .forUpdate()
                    .first('sol_id', 'pac_id', 'sol_status');

                if (!origem) {
                    return falhar(404, 'Prescrição de origem não encontrada');
                }

                if (origem.sol_status !== 'Autorizado') {
                    return falhar(400, 'Só é possível agendar prescrições autorizadas');
                }

                if (Number(origem.pac_id) !== pac_id) {
                    return falhar(400, 'O paciente selecionado não é o paciente desta prescrição');
                }

                const agendamentoAtivo = await trx('solicitacao')
                    .where('sol_origem_id', origemId)
                    .whereIn('sol_status', STATUS_AGENDAMENTO_ATIVO)
                    .first('sol_id', 'sol_protocolo');

                if (agendamentoAtivo) {
                    return falhar(
                        409,
                        `Esta prescrição já possui um agendamento (protocolo ${agendamentoAtivo.sol_protocolo ?? agendamentoAtivo.sol_id})`
                    );
                }
            }

            // CRIAR SOLICITAÇÃO

            const resultado = await trx('solicitacao')
                .insert({
                    pac_id,
                    pos_id,
                    sol_data_de_coleta,
                    sol_status: 'agendado',
                    sol_insumo_quant: 0,
                    sol_origem_id: origemId
                })
                .returning('sol_id');

            const sol_id =
                typeof resultado[0] === 'object' ? resultado[0].sol_id : resultado[0];

            // GERAR PROTOCOLO DE ATENDIMENTO
            // Só dá pra montar depois de saber o sol_id gerado, então é um
            // segundo passo (update), dentro da mesma transação.

            const protocolo = gerarProtocolo(sol_id);

            await trx('solicitacao')
                .where('sol_id', sol_id)
                .update({ sol_protocolo: protocolo });

            // CRIAR ITENS DA COLETA
            // O admin digita o nome do produto (não escolhe um já
            // cadastrado). Por isso, pra cada item: se já existir um
            // insumo com esse nome (ignorando maiúsculas/minúsculas),
            // reaproveita o ins_id dele; senão, cria um insumo novo.

            const linhasColeta = [];

            for (const item of itens) {
                const nome = String(item.ins_nome).trim();

                let insumoExistente = await trx('insumo')
                    .whereRaw('LOWER(ins_nome) = LOWER(?)', [nome])
                    .first();

                let ins_id;

                if (insumoExistente) {
                    ins_id = insumoExistente.ins_id;
                } else {
                    const novoInsumo = await trx('insumo')
                        .insert({ ins_nome: nome, ins_quantidade: 0 })
                        .returning('ins_id');

                    ins_id =
                        typeof novoInsumo[0] === 'object' ? novoInsumo[0].ins_id : novoInsumo[0];
                }

                linhasColeta.push({ sol_id, ins_id, quantidade: Number(item.quantidade) });
            }

            await trx('coleta').insert(linhasColeta);

            // histórico: no agendamento e, se houver, na prescrição de origem
            const detalheAgendamento =
                `${protocolo} · coleta em ${sol_data_de_coleta.split('-').reverse().join('/')} · ${postoExiste.pos_nome}`;
            await registrarHistorico(trx, req.session, {
                sol_id, acao: ACOES.AGENDADA, para: 'agendado', detalhe: detalheAgendamento,
            });
            if (origemId) {
                await registrarHistorico(trx, req.session, {
                    sol_id: origemId, acao: ACOES.AGENDADA, de: 'Autorizado', para: 'Autorizado', detalhe: detalheAgendamento,
                });
            }

            await trx.commit();

            return res.status(201).send({
                message: 'Agendamento criado com sucesso',
                sol_id,
                sol_protocolo: protocolo
            });

        } catch (error) {
            if (!trx.isCompleted()) await trx.rollback();

            // índice único ux_solicitacao_origem_ativa: outra requisição
            // agendou a mesma prescrição ao mesmo tempo
            if (error.code === '23505') {
                return res.status(409).send({
                    message: 'Esta prescrição já possui um agendamento'
                });
            }

            console.error('Erro ao criar agendamento:', error);

            return res.status(500).send({
                message: 'Erro ao criar agendamento'
            });
        }
    },


    // CONCLUIR AGENDAMENTO
    //
    // Desconta o estoque de cada insumo e marca como concluído, tudo na
    // mesma transação. A linha do agendamento é travada (FOR UPDATE) para
    // que dois cliques/requisições simultâneos não descontem o estoque duas vezes.
    async concluir(req, res) {
        const trx = await knex.transaction();

        const falhar = async (status, corpo) => {
            await trx.rollback();
            return res.status(status).send(corpo);
        };

        try {
            const { id } = req.params;

            const solicitacao = await trx('solicitacao')
                .where('sol_id', id)
                .whereIn('sol_status', STATUS_AGENDAMENTO)
                .forUpdate()
                .first('sol_id', 'sol_status', 'sol_protocolo', 'sol_origem_id');

            if (!solicitacao) {
                return falhar(404, { message: 'Agendamento não encontrado' });
            }

            if (solicitacao.sol_status === 'concluido') {
                return falhar(409, { message: 'Este agendamento já foi concluído.' });
            }

            if (solicitacao.sol_status === 'cancelado') {
                return falhar(409, { message: 'Não é possível concluir um agendamento cancelado.' });
            }

            const itensColeta = await trx('coleta').where('sol_id', id);

            if (!itensColeta.length) {
                return falhar(400, { message: 'Nenhum insumo encontrado para esta coleta.' });
            }

            const nomesInsumo = new Map();
            for (const item of itensColeta) {
                const insumo = await trx('insumo')
                    .where('ins_id', item.ins_id)
                    .forUpdate()
                    .first();

                if (!insumo) {
                    return falhar(404, { message: `Insumo ${item.ins_id} não encontrado.` });
                }
                nomesInsumo.set(item.ins_id, insumo.ins_nome);

                const estoqueAtual = Number(insumo.ins_quantidade);
                const quantidadeRetirada = Number(item.quantidade);

                if (!(quantidadeRetirada > 0)) {
                    return falhar(400, { message: `Quantidade inválida para o insumo ${insumo.ins_nome}.` });
                }

                if (estoqueAtual < quantidadeRetirada) {
                    return falhar(400, {
                        message: `Estoque insuficiente de ${insumo.ins_nome}: disponível ${estoqueAtual}, necessário ${quantidadeRetirada}.`,
                        ins_id: item.ins_id,
                        estoqueAtual,
                        quantidadeRetirada
                    });
                }

                await trx('insumo')
                    .where('ins_id', item.ins_id)
                    .update({ ins_quantidade: estoqueAtual - quantidadeRetirada });
            }

            await trx('solicitacao')
                .where('sol_id', id)
                .update({ sol_status: 'concluido' });

            const entregues = itensColeta.map((i) => `${i.quantidade}x ${nomesInsumo.get(i.ins_id) ?? 'insumo ' + i.ins_id}`).join(', ');
            const detalheColeta = `${solicitacao.sol_protocolo ?? 'Agendamento ' + id} · ${entregues}`;
            await registrarHistorico(trx, req.session, {
                sol_id: Number(id), acao: ACOES.CONCLUIDA, de: 'agendado', para: 'concluido', detalhe: detalheColeta,
            });
            if (solicitacao.sol_origem_id) {
                await registrarHistorico(trx, req.session, {
                    sol_id: solicitacao.sol_origem_id, acao: ACOES.CONCLUIDA, de: 'Autorizado', para: 'Autorizado', detalhe: detalheColeta,
                });
            }

            await trx.commit();

            return res.status(200).send({
                message: 'Agendamento concluído e estoque atualizado'
            });

        } catch (error) {
            if (!trx.isCompleted()) await trx.rollback();

            console.error('Erro ao concluir agendamento:', error);

            return res.status(500).send({
                message: 'Erro ao concluir agendamento'
            });
        }
    },

    // CANCELAR AGENDAMENTO
    //
    // Mesmo padrão da "não autorização" do autorizador: motivo em texto
    // livre, obrigatório. Só agendamentos com status 'agendado' podem ser
    // cancelados; o UPDATE condicional garante isso mesmo com duas
    // requisições ao mesmo tempo (status + motivo gravados juntos).
    async cancelar(req, res) {
        try {
            const { id } = req.params;
            const motivo = req.body?.motivo;

            const erroMotivo = validarMotivo(motivo, 'do cancelamento');
            if (erroMotivo) {
                return res.status(400).send({ message: erroMotivo });
            }

            const cancelado = await knex.transaction(async (trx) => {
                const [linha] = await trx('solicitacao')
                    .where('sol_id', id)
                    .where('sol_status', 'agendado')
                    .update({
                        sol_status: 'cancelado',
                        sol_motivo_cancelamento: motivo.trim(),
                        sol_data_cancelamento: trx.fn.now(),
                        sol_cancelado_por: req.session?.id ?? null
                    })
                    .returning(['sol_id', 'sol_status', 'sol_motivo_cancelamento', 'sol_data_cancelamento', 'sol_protocolo', 'sol_origem_id']);

                if (linha) {
                    const detalhe = `${linha.sol_protocolo ?? 'Agendamento ' + id} · Motivo: ${motivo.trim()}`;
                    await registrarHistorico(trx, req.session, {
                        sol_id: Number(id), acao: ACOES.CANCELADA, de: 'agendado', para: 'cancelado', detalhe,
                    });
                    if (linha.sol_origem_id) {
                        await registrarHistorico(trx, req.session, {
                            sol_id: linha.sol_origem_id, acao: ACOES.CANCELADA, de: 'Autorizado', para: 'Autorizado', detalhe,
                        });
                    }
                }
                return linha;
            });

            if (!cancelado) {
                const atual = await knex('solicitacao')
                    .where('sol_id', id)
                    .whereIn('sol_status', STATUS_AGENDAMENTO)
                    .first('sol_status');

                if (!atual) {
                    return res.status(404).send({ message: 'Agendamento não encontrado' });
                }

                return res.status(409).send({
                    message: atual.sol_status === 'cancelado'
                        ? 'Este agendamento já foi cancelado.'
                        : 'Não é possível cancelar um agendamento já concluído.'
                });
            }

            return res.status(200).send({
                message: 'Agendamento cancelado',
                agendamento: cancelado
            });

        } catch (error) {
            console.error('Erro ao cancelar agendamento:', error);

            return res.status(500).send({
                message: 'Erro ao cancelar agendamento'
            });
        }
    },

    // RECADO DO ADMIN NO AGENDAMENTO (ex.: "traga documento com foto").
    // Aparece para o paciente no card e no comprovante. Texto vazio apaga.
    async salvarRecado(req, res) {
        try {
            const { id } = req.params;
            const bruto = req.body?.recado;

            if (bruto != null && typeof bruto !== 'string') {
                return res.status(400).send({ message: 'Recado inválido' });
            }

            const recado = (bruto ?? '').trim();
            if (recado.length > TAMANHO_MAX_RECADO) {
                return res.status(400).send({ message: `O recado deve ter no máximo ${TAMANHO_MAX_RECADO} caracteres` });
            }

            const resultado = await knex.transaction(async (trx) => {
                const [linha] = await trx('solicitacao')
                    .where('sol_id', id)
                    .where('sol_status', 'agendado')
                    .update({ sol_recado: recado || null })
                    .returning(['sol_id', 'sol_recado']);

                if (linha) {
                    await registrarHistorico(trx, req.session, {
                        sol_id: Number(id), acao: ACOES.RECADO, detalhe: recado || 'Recado removido',
                    });
                }
                return linha;
            });

            if (!resultado) {
                const existe = await knex('solicitacao').where('sol_id', id).whereIn('sol_status', STATUS_AGENDAMENTO).first('sol_status');
                return existe
                    ? res.status(409).send({ message: 'Só é possível deixar recado em agendamentos ainda não realizados.' })
                    : res.status(404).send({ message: 'Agendamento não encontrado' });
            }

            return res.status(200).send({ message: recado ? 'Recado salvo' : 'Recado removido', sol_recado: resultado.sol_recado });

        } catch (error) {
            console.error('Erro ao salvar recado:', error);
            return res.status(500).send({ message: 'Erro ao salvar o recado' });
        }
    },


    // MEUS AGENDAMENTOS (visão do PACIENTE, paginado)
    async listarMeusAgendamentos(req, res) {
        try {
            if (req.session.tipo !== 'PACIENTE') {
                return res.status(403).send({ error: 'Rota exclusiva de paciente' });
            }

            const page = Number(req.query.page) || 1;
            const porPagina = Math.min(Math.max(Number(req.query.porPagina) || 4, 1), 50);
            const offset = (page - 1) * porPagina;

            // ?situacao=proximos  -> só 'agendado', do mais próximo para o mais distante
            // ?situacao=anteriores -> concluídos e cancelados, do mais recente
            // (sem o parâmetro: todos, como antes)
            const { situacao } = req.query;
            if (situacao && !['proximos', 'anteriores'].includes(situacao)) {
                return res.status(400).send({ message: 'Situação inválida' });
            }

            let consulta = baseQueryAgendamentos().where('sol.pac_id', req.session.id);
            if (situacao === 'proximos') {
                consulta = consulta.where('sol.sol_status', 'agendado').orderBy('sol.sol_data_de_coleta', 'asc');
            } else if (situacao === 'anteriores') {
                consulta = consulta.whereIn('sol.sol_status', ['concluido', 'cancelado']).orderBy('sol.sol_data_de_coleta', 'desc');
            } else {
                consulta = consulta.orderBy('sol.sol_data_de_coleta', 'desc');
            }
            const resultado = await consulta.orderBy('sol.sol_id', 'desc');

            const todosAgendamentos = agruparPorAgendamento(resultado);

            const total = todosAgendamentos.length;
            const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
            const paginaValida = Math.min(Math.max(1, page), totalPaginas);
            const inicio = (paginaValida - 1) * porPagina;
            const itens = todosAgendamentos.slice(inicio, inicio + porPagina);

            return res.status(200).send({ itens, paginaAtual: paginaValida, totalPaginas, total });

        } catch (error) {
            console.error('Erro ao buscar meus agendamentos:', error);

            return res.status(500).send({
                message: 'Erro ao buscar seus agendamentos'
            });
        }
    },


    // PRÓXIMO AGENDAMENTO (visão do PACIENTE, usado na Home)
    //
    // Devolve só o agendamento mais próximo da data de hoje pra frente,
    // ainda com status 'agendado'. Se não houver nenhum, devolve null
    // (não é erro — só significa "sem próximo agendamento").
    async proximoAgendamento(req, res) {
        try {
            if (req.session.tipo !== 'PACIENTE') {
                return res.status(403).send({ error: 'Rota exclusiva de paciente' });
            }

            const resultado = await baseQueryAgendamentos()
                .where('sol.pac_id', req.session.id)
                .where('sol.sol_status', 'agendado')
                // "hoje" no fuso de Brasília (o banco roda em UTC)
                .where('sol.sol_data_de_coleta', '>=', dataHojeBrasil())
                .orderBy('sol.sol_data_de_coleta', 'asc');

            const agendamentos = agruparPorAgendamento(resultado);

            return res.status(200).send(agendamentos[0] ?? null);

        } catch (error) {
            console.error('Erro ao buscar próximo agendamento:', error);

            return res.status(500).send({
                message: 'Erro ao buscar próximo agendamento'
            });
        }
    }

};