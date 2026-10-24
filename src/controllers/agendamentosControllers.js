import { randomUUID } from 'node:crypto';
import knex from '../database/index.js';
import { cpfParcial, dataHojeBrasil, idValido, lerCodigoQR, validarDataISO, validarMotivo } from '../utils/validacoes.js';
import { registrarFalhaLeituraQR } from '../middleware/limiteLeituraQR.js';
import { ACOES, registrarHistorico } from '../utils/historico.js';
import { dataBR, gerarProtocolo, isoData, prescricaoVencida, STATUS_AGENDAMENTO, STATUS_AGENDAMENTO_ATIVO, STATUS_AGENDAMENTO_SEM_ENTREGA } from '../utils/status.js';
import { idDoAdmin } from '../utils/contas.js';
import { notificar } from '../notificacoes/processador.js';
import { avisarEstoque } from '../notificacoes/estoque.js';
import { reservados } from '../utils/estoque.js';
import { conferirVaga, ROTULO_TURNO } from '../utils/agenda.js';
import { autorizadosDoPaciente } from './autorizadosControllers.js';

const TAMANHO_MAX_RECADO = 300;

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
                // retirada recorrente: 1 = primeira, 2 = segunda...
                sol_ciclo: Number(linha.sol_ciclo ?? 1),
                sol_turno: linha.sol_turno ?? null,
                // pedido de outra data feito pelo paciente (pedido | aceito | recusado)
                pedido_outra_data: linha.sol_pedido_situacao
                    ? {
                        situacao: linha.sol_pedido_situacao,
                        data: linha.sol_pedido_data ?? null,
                        turno: linha.sol_pedido_turno ?? null,
                        motivo: linha.sol_pedido_motivo ?? null,
                        resposta: linha.sol_pedido_resposta ?? null,
                    }
                    : null,
                // confirmação de presença: 'vou' | 'nao_vou' | null (sem resposta)
                sol_presenca: linha.sol_presenca ?? null,
                // quem retirou no lugar do paciente (vazio = o próprio paciente)
                sol_retirado_por_nome: linha.sol_retirado_por_nome ?? null,
                sol_recado: linha.sol_recado ?? null,
                // data anterior quando o admin remarcou (aviso "remarcado")
                sol_data_anterior: linha.sol_data_anterior ?? null,
                // só vem nas rotas do próprio paciente (monta o QR do comprovante)
                ...(linha.sol_codigo_qr !== undefined && { sol_codigo_qr: linha.sol_codigo_qr }),

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
    'sol.sol_ciclo',
    'sol.sol_turno',
    'sol.sol_pedido_situacao',
    'sol.sol_pedido_data',
    'sol.sol_pedido_turno',
    'sol.sol_pedido_motivo',
    'sol.sol_pedido_resposta',
    'sol.sol_presenca',
    'sol.sol_retirado_por_nome',
    'sol.sol_recado',
    'sol.sol_data_anterior',

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

const TAMANHO_MAX_NOME_INSUMO = 100;

// comCodigoQR: inclui o código secreto do QR Code (só nas rotas do paciente)
function baseQueryAgendamentos({ comCodigoQR = false } = {}) {
    return knex('solicitacao as sol')
        .leftJoin('pacientes as pac', 'pac.pac_id', 'sol.pac_id')
        // permite manter as solicitações mesmo quando alguma informação relacionada não existe
        .leftJoin('postosdesaude as pos', 'pos.pos_id', 'sol.pos_id')
        .leftJoin('coleta as col', 'col.sol_id', 'sol.sol_id')
        .leftJoin('insumo as ins', 'ins.ins_id', 'col.ins_id')
        // a tabela solicitacao também guarda pedidos de prescrição (outro
        // status: Pendente/Aprovado/Reenvio) — nunca misturar com agendamento
        .whereIn('sol.sol_status', STATUS_AGENDAMENTO)
        .select(comCodigoQR ? [...SELECT_AGENDAMENTO, 'sol.sol_codigo_qr'] : SELECT_AGENDAMENTO);
}

// Paginação feita no banco: primeiro conta e busca só os ids da página
// (um por agendamento), depois os dados completos desses ids (que vêm
// "achatados", uma linha por insumo). Assim a página não carrega o
// histórico inteiro do posto ou do paciente.
async function listarPaginado(query, filtros, ordenar, maximoPorPagina = 100, opcoes = {}) {
    const porPagina = Math.min(Math.max(Number(query.porPagina) || 20, 1), maximoPorPagina);
    const pedida = Math.max(1, Number(query.page) || 1);

    const filtrada = knex('solicitacao as sol')
        .leftJoin('pacientes as pac', 'pac.pac_id', 'sol.pac_id')
        .whereIn('sol.sol_status', STATUS_AGENDAMENTO)
        .modify(filtros);

    const total = Number((await filtrada.clone().count({ total: 'sol.sol_id' }).first())?.total ?? 0);
    const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
    const paginaAtual = Math.min(pedida, totalPaginas);

    const ids = await filtrada.clone()
        .select('sol.sol_id')
        .modify(ordenar)
        .limit(porPagina)
        .offset((paginaAtual - 1) * porPagina)
        .then((linhas) => linhas.map((l) => l.sol_id));

    const linhas = ids.length ? await baseQueryAgendamentos(opcoes).whereIn('sol.sol_id', ids) : [];
    const porId = new Map(agruparPorAgendamento(linhas).map((a) => [a.sol_id, a]));

    return { itens: ids.map((id) => porId.get(id)).filter(Boolean), paginaAtual, totalPaginas, total };
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

            const admin = req.session;
            const filtros = (qb) => {
                // admin de posto vê só os agendamentos do próprio posto; o universal vê todos
                if (!admin.tp_universal) qb.where('sol.pos_id', admin.posto_id ?? null);

                if (status && status !== 'todos') qb.where('sol.sol_status', status);

                // aba "Pedidos de outra data": só os que esperam resposta
                if (req.query.pedido === 'pendente') {
                    qb.where('sol.sol_status', 'agendado').where('sol.sol_pedido_situacao', 'pedido');
                }

                if (busca && busca.trim()) {
                    const termo = busca.trim();
                    const termoCpf = termo.replace(/\D/g, '');

                    qb.where((w) => {
                        w.whereILike('pac.pac_nome', `%${termo}%`)
                            .orWhereILike('sol.sol_protocolo', `%${termo}%`);

                        if (termoCpf) {
                            w.orWhereRaw(
                                "REPLACE(REPLACE(pac.pac_cpf, '.', ''), '-', '') LIKE ?",
                                [`%${termoCpf}%`]
                            );
                        }
                    });
                }

                if (data_inicio) qb.where('sol.sol_data_de_coleta', '>=', data_inicio);
                if (data_fim) qb.where('sol.sol_data_de_coleta', '<=', data_fim);

                // --- compatibilidade com o formato antigo (hoje / exceto hoje) ---
                if (data === 'hoje') qb.where('sol.sol_data_de_coleta', dataHojeBrasil());
                if (excluir_data === 'hoje') qb.whereNot('sol.sol_data_de_coleta', dataHojeBrasil());
            };

            const ordenar = (qb) => {
                if (order === 'proximidade') {
                    qb.orderByRaw('ABS(sol.sol_data_de_coleta - ?::date)', [dataHojeBrasil()]);
                } else {
                    qb.orderBy('sol.sol_data_de_coleta', 'asc');
                }
                qb.orderBy('sol.sol_id', 'asc');
            };

            // Com ?page=, a resposta vem paginada pelo banco ({ itens, total, ... });
            // sem ele, a lista inteira, como antes (compatibilidade).
            if (req.query.page !== undefined) {
                return res.status(200).send(await listarPaginado(req.query, filtros, ordenar));
            }

            const resultado = await baseQueryAgendamentos().modify(filtros).modify(ordenar);

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

            const { paciente, sol_data_de_coleta, posto, itens, sol_origem_id, sol_turno } = req.body ?? {};

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

            // cada item vem com o ins_id (escolhido no estoque da unidade) ou,
            // em clientes antigos, só com o nome do insumo
            for (const item of itens) {
                const temId = item?.ins_id !== undefined && item?.ins_id !== null && item?.ins_id !== '';
                const nome = typeof item?.ins_nome === 'string' ? item.ins_nome.trim() : '';
                const quantidade = Number(item?.quantidade);

                if ((!temId && !nome) || !Number.isFinite(quantidade)) {
                    return falhar(400, 'Cada insumo precisa de nome e quantidade');
                }

                if (temId && !idValido(item.ins_id)) {
                    return falhar(400, 'Insumo inválido');
                }

                if (nome.length > TAMANHO_MAX_NOME_INSUMO) {
                    return falhar(400, `O nome do insumo deve ter no máximo ${TAMANHO_MAX_NOME_INSUMO} caracteres`);
                }

                if (!Number.isInteger(quantidade) || quantidade <= 0) {
                    return falhar(400, `Quantidade inválida para "${nome || 'o insumo'}". Informe um número inteiro maior que zero`);
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
            let ciclo = 1;

            if (sol_origem_id !== undefined && sol_origem_id !== null && sol_origem_id !== '') {
                origemId = Number(sol_origem_id);

                if (!Number.isInteger(origemId) || origemId <= 0) {
                    return falhar(400, 'Prescrição de origem inválida');
                }

                // trava a prescrição: dois cliques simultâneos esperam um pelo outro
                const origem = await trx('solicitacao')
                    .where('sol_id', origemId)
                    .forUpdate()
                    .first('sol_id', 'pac_id', 'sol_status', 'sol_data_vencimento', 'sol_periodicidade_dias');

                if (!origem) {
                    return falhar(404, 'Prescrição de origem não encontrada');
                }

                if (origem.sol_status !== 'Autorizado') {
                    return falhar(400, 'Só é possível agendar prescrições autorizadas');
                }

                if (Number(origem.pac_id) !== pac_id) {
                    return falhar(400, 'O paciente selecionado não é o paciente desta prescrição');
                }

                // a coleta tem de acontecer dentro da validade da prescrição
                const vencimento = isoData(origem.sol_data_vencimento);
                if (prescricaoVencida(vencimento, dataHojeBrasil())) {
                    return falhar(400, `A prescrição venceu em ${dataBR(vencimento)}. Peça uma prescrição nova ao paciente.`);
                }
                if (vencimento && sol_data_de_coleta > vencimento) {
                    return falhar(400, `A data da coleta não pode ser depois do vencimento da prescrição (${dataBR(vencimento)}).`);
                }

                // Um agendamento em aberto por prescrição. Retirada única: depois
                // de concluída, acabou. Uso contínuo: cada retirada concluída
                // libera o ciclo seguinte (até o vencimento).
                const ativos = await trx('solicitacao')
                    .where('sol_origem_id', origemId)
                    .whereIn('sol_status', STATUS_AGENDAMENTO_ATIVO)
                    .orderBy('sol_id', 'desc')
                    .select('sol_id', 'sol_protocolo', 'sol_status', 'sol_ciclo');
                const emAberto = ativos.find((a) => a.sol_status === 'agendado');
                const bloqueio = emAberto ?? (origem.sol_periodicidade_dias ? null : ativos[0]);

                if (bloqueio) {
                    return falhar(
                        409,
                        `Esta prescrição já possui um agendamento (protocolo ${bloqueio.sol_protocolo ?? bloqueio.sol_id})`
                    );
                }
                ciclo = ativos.reduce((maior, a) => Math.max(maior, Number(a.sol_ciclo) || 1), 0) + 1;
            }

            // DIA E TURNO: dentro do horário da unidade e com vaga. Sem turno
            // (clientes antigos), fica o primeiro turno do dia com vaga.
            const vaga = await conferirVaga(pos_id, sol_data_de_coleta, sol_turno, { db: trx });
            if (vaga.erro) {
                return falhar(409, vaga.erro);
            }

            // INSUMOS DO ESTOQUE DA UNIDADE
            // O insumo tem de ser da unidade do agendamento: assim a baixa na
            // conclusão sai do estoque certo. Nada é criado por aqui.
            const porInsumo = new Map();
            for (const item of itens) {
                const temId = item?.ins_id !== undefined && item?.ins_id !== null && item?.ins_id !== '';
                const nome = typeof item?.ins_nome === 'string' ? item.ins_nome.trim() : '';
                const consulta = trx('insumo').where('pos_id', pos_id);
                if (temId) consulta.where('ins_id', Number(item.ins_id));
                else consulta.whereRaw('LOWER(TRIM(ins_nome)) = LOWER(?)', [nome]).orderBy('ins_id');
                const insumo = await consulta.first('ins_id', 'ins_nome', 'ins_quantidade');

                if (!insumo) {
                    return falhar(400, `${nome ? `"${nome}"` : 'Este insumo'} não está cadastrado no estoque de ${postoExiste.pos_nome}. Cadastre o insumo antes de agendar.`);
                }

                // o mesmo insumo em duas linhas vira uma só, com a soma
                const anterior = porInsumo.get(insumo.ins_id);
                porInsumo.set(insumo.ins_id, {
                    ...insumo,
                    quantidade: (anterior?.quantidade ?? 0) + Number(item.quantidade),
                });
            }

            // ESTOQUE RESERVADO: o que já está prometido em outras coletas
            // agendadas não está livre. Faltando, o admin precisa confirmar
            // (confirmar_sem_estoque), porque o insumo pode chegar até a data.
            const reserva = await reservados([...porInsumo.keys()], { db: trx });
            const faltando = [...porInsumo.values()]
                .map((i) => ({
                    ins_id: i.ins_id,
                    ins_nome: i.ins_nome,
                    pedido: i.quantidade,
                    disponivel: Math.max(0, Number(i.ins_quantidade) - (reserva.get(Number(i.ins_id)) ?? 0)),
                }))
                .filter((i) => i.pedido > i.disponivel);

            if (faltando.length && req.body?.confirmar_sem_estoque !== true) {
                await trx.rollback();
                return res.status(409).send({
                    codigo: 'ESTOQUE_INSUFICIENTE',
                    message: 'Estoque disponível insuficiente: ' +
                        faltando.map((i) => `${i.ins_nome} (pedido ${i.pedido}, disponível ${i.disponivel})`).join(', ') +
                        '. Confirme para agendar mesmo assim.',
                    itens: faltando,
                });
            }

            // CRIAR SOLICITAÇÃO

            const resultado = await trx('solicitacao')
                .insert({
                    pac_id,
                    pos_id,
                    sol_data_de_coleta,
                    sol_status: 'agendado',
                    sol_insumo_quant: 0,
                    sol_origem_id: origemId,
                    sol_ciclo: ciclo,
                    sol_turno: vaga.turno,
                    sol_codigo_qr: randomUUID()
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

            // CRIAR ITENS DA COLETA (insumos já conferidos acima)

            const linhasColeta = [...porInsumo.values()]
                .map((i) => ({ sol_id, ins_id: i.ins_id, quantidade: i.quantidade }));

            await trx('coleta').insert(linhasColeta);

            // histórico: no agendamento e, se houver, na prescrição de origem.
            // Se a prescrição já teve um agendamento cancelado, este é uma
            // remarcação: o cancelamento continua registrado e a remarcação
            // vira outro evento, com o protocolo cancelado no detalhe.
            const cancelado = origemId
                ? await trx('solicitacao')
                    .where('sol_origem_id', origemId)
                    .where('sol_ciclo', ciclo)
                    .whereIn('sol_status', STATUS_AGENDAMENTO_SEM_ENTREGA)
                    .orderBy('sol_id', 'desc')
                    .first('sol_protocolo', 'sol_id')
                : null;
            const acao = cancelado ? ACOES.REAGENDADA : ACOES.AGENDADA;
            const detalheAgendamento =
                `${protocolo} · coleta em ${sol_data_de_coleta.split('-').reverse().join('/')} (${ROTULO_TURNO[vaga.turno]}) · ${postoExiste.pos_nome}` +
                (ciclo > 1 ? ` · ${ciclo}ª retirada` : '') +
                (cancelado ? ` · substitui o agendamento cancelado ${cancelado.sol_protocolo ?? cancelado.sol_id}` : '');
            await registrarHistorico(trx, req.session, {
                sol_id, acao, para: 'agendado', detalhe: detalheAgendamento,
            });
            if (origemId) {
                await registrarHistorico(trx, req.session, {
                    sol_id: origemId, acao, de: 'Autorizado', para: 'Autorizado', detalhe: detalheAgendamento,
                });
            }

            await trx.commit();

            await notificar();

            return res.status(201).send({
                message: 'Agendamento criado com sucesso',
                sol_id,
                sol_protocolo: protocolo,
                sol_ciclo: ciclo,
                sol_turno: vaga.turno
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
                .first('sol_id', 'sol_status', 'sol_protocolo', 'sol_origem_id', 'pac_id');

            if (solicitacao?.sol_status === 'nao_compareceu') {
                return falhar(409, { message: 'Este agendamento foi registrado como "não compareceu". Crie um novo agendamento.' });
            }

            if (!solicitacao) {
                return falhar(404, { message: 'Agendamento não encontrado' });
            }

            if (solicitacao.sol_status === 'concluido') {
                return falhar(409, { message: 'Este agendamento já foi concluído.' });
            }

            if (solicitacao.sol_status === 'cancelado') {
                return falhar(409, { message: 'Não é possível concluir um agendamento cancelado.' });
            }

            // prescrição vencida: a entrega não pode mais ser registrada
            if (solicitacao.sol_origem_id) {
                const origem = await trx('solicitacao').where('sol_id', solicitacao.sol_origem_id).first('sol_data_vencimento');
                if (prescricaoVencida(origem?.sol_data_vencimento, dataHojeBrasil())) {
                    return falhar(409, { message: `A prescrição deste agendamento venceu em ${dataBR(origem.sol_data_vencimento)}. Não é possível concluir a coleta.` });
                }
            }

            // quem está retirando: o próprio paciente (vazio) ou uma pessoa
            // autorizada na ficha dele
            let retirada = null;
            const retiradoPor = req.body?.retirado_por;
            if (retiradoPor !== undefined && retiradoPor !== null && retiradoPor !== '') {
                if (!idValido(retiradoPor)) return falhar(400, { message: 'Pessoa autorizada inválida.' });
                retirada = await trx('paciente_autorizado')
                    .where({ pau_id: Number(retiradoPor), pac_id: solicitacao.pac_id, pau_ativo: true })
                    .first('pau_id', 'pau_nome', 'pau_parentesco');
                if (!retirada) {
                    return falhar(400, { message: 'Esta pessoa não está autorizada a retirar por este paciente.' });
                }
            }

            const itensColeta = await trx('coleta').where('sol_id', id);

            if (!itensColeta.length) {
                return falhar(400, { message: 'Nenhum insumo encontrado para esta coleta.' });
            }

            const nomesInsumo = new Map();
            const mudancasEstoque = [];
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
                mudancasEstoque.push({ ins_id: item.ins_id, antes: estoqueAtual, depois: estoqueAtual - quantidadeRetirada });
            }

            await trx('solicitacao')
                .where('sol_id', id)
                .update({
                    sol_status: 'concluido',
                    sol_retirado_por: retirada?.pau_id ?? null,
                    sol_retirado_por_nome: retirada?.pau_nome ?? null,
                });

            const entregues = itensColeta.map((i) => `${i.quantidade}x ${nomesInsumo.get(i.ins_id) ?? 'insumo ' + i.ins_id}`).join(', ');
            const quem = retirada
                ? ` · Retirado por ${retirada.pau_nome}${retirada.pau_parentesco ? ` (${retirada.pau_parentesco})` : ''}`
                : '';
            const detalheColeta = `${solicitacao.sol_protocolo ?? 'Agendamento ' + id} · ${entregues}${quem}`;
            await registrarHistorico(trx, req.session, {
                sol_id: Number(id), acao: ACOES.CONCLUIDA, de: 'agendado', para: 'concluido', detalhe: detalheColeta,
            });
            if (solicitacao.sol_origem_id) {
                await registrarHistorico(trx, req.session, {
                    sol_id: solicitacao.sol_origem_id, acao: ACOES.CONCLUIDA, de: 'Autorizado', para: 'Autorizado', detalhe: detalheColeta,
                });
            }

            await trx.commit();

            await notificar();
            await avisarEstoque(mudancasEstoque);

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

            const canceladoPor = await idDoAdmin(req.session);

            const cancelado = await knex.transaction(async (trx) => {
                const [linha] = await trx('solicitacao')
                    .where('sol_id', id)
                    .where('sol_status', 'agendado')
                    .update({
                        sol_status: 'cancelado',
                        sol_motivo_cancelamento: motivo.trim(),
                        sol_data_cancelamento: trx.fn.now(),
                        sol_cancelado_por: canceladoPor
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
                        : atual.sol_status === 'nao_compareceu'
                            ? 'Este agendamento já foi registrado como "não compareceu".'
                            : 'Não é possível cancelar um agendamento já concluído.'
                });
            }

            await notificar();

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

            await notificar();

            return res.status(200).send({ message: recado ? 'Recado salvo' : 'Recado removido', sol_recado: resultado.sol_recado });

        } catch (error) {
            console.error('Erro ao salvar recado:', error);
            return res.status(500).send({ message: 'Erro ao salvar o recado' });
        }
    },


    // REMARCAR AGENDAMENTO (admin)
    //
    // Muda só a data, no MESMO agendamento (mesmo protocolo e itens). A data
    // anterior fica em sol_data_anterior (aviso "remarcado" para o paciente)
    // e no histórico. Também serve para a coleta que passou sem baixa.
    async remarcar(req, res) {
        try {
            const { id } = req.params;
            const { sol_data_de_coleta: novaData, motivo, sol_turno: turnoPedido } = req.body ?? {};

            if (!novaData || validarDataISO(novaData)) {
                return res.status(400).send({ message: 'Informe uma data válida para a coleta' });
            }
            if (novaData < dataHojeBrasil()) {
                return res.status(400).send({ message: 'A nova data não pode estar no passado' });
            }
            if (motivo != null && typeof motivo !== 'string') {
                return res.status(400).send({ message: 'Motivo inválido' });
            }
            const motivoLimpo = (motivo ?? '').trim();
            if (motivoLimpo.length > 500) {
                return res.status(400).send({ message: 'O motivo deve ter no máximo 500 caracteres' });
            }

            const resultado = await knex.transaction(async (trx) => {
                const ag = await trx('solicitacao')
                    .where('sol_id', id)
                    .whereIn('sol_status', STATUS_AGENDAMENTO)
                    .forUpdate()
                    .first('sol_id', 'sol_status', 'sol_protocolo', 'sol_data_de_coleta', 'sol_origem_id', 'sol_turno', 'pos_id');

                if (!ag) return { status: 404, corpo: { message: 'Agendamento não encontrado' } };
                if (ag.sol_status !== 'agendado') {
                    return { status: 409, corpo: { message: 'Só é possível remarcar agendamentos ainda não realizados.' } };
                }

                const dataAtual = isoData(ag.sol_data_de_coleta);
                const turnoAtual = ag.sol_turno ?? null;
                if (dataAtual === novaData && (!turnoPedido || turnoPedido === turnoAtual)) {
                    return { status: 400, corpo: { message: 'Escolha uma data ou um turno diferente do atual' } };
                }

                // o próprio agendamento não ocupa a vaga que está deixando
                const vaga = await conferirVaga(ag.pos_id, novaData, turnoPedido, { db: trx, ignorarSolId: Number(id) });
                if (vaga.erro) return { status: 409, corpo: { message: vaga.erro } };

                if (ag.sol_origem_id) {
                    const origem = await trx('solicitacao').where('sol_id', ag.sol_origem_id).first('sol_data_vencimento');
                    const vencimento = isoData(origem?.sol_data_vencimento);
                    if (vencimento && novaData > vencimento) {
                        return { status: 400, corpo: { message: `A nova data não pode ser depois do vencimento da prescrição (${dataBR(vencimento)}).` } };
                    }
                }

                const n = await trx('solicitacao')
                    .where({ sol_id: id, sol_status: 'agendado' })
                    .update({
                        sol_data_de_coleta: novaData, sol_turno: vaga.turno, sol_data_anterior: dataAtual,
                        // a confirmação de presença era da data antiga
                        sol_presenca: null, sol_presenca_em: null,
                    });
                if (!n) return { status: 409, corpo: { message: 'Só é possível remarcar agendamentos ainda não realizados.' } };

                const comTurno = (data, turno) => `${dataBR(data)}${turno ? ` (${ROTULO_TURNO[turno]})` : ''}`;
                const detalhe = `${ag.sol_protocolo ?? 'Agendamento ' + id} · de ${comTurno(dataAtual, turnoAtual)} para ${comTurno(novaData, vaga.turno)}` +
                    (motivoLimpo ? ` · Motivo: ${motivoLimpo}` : '');
                await registrarHistorico(trx, req.session, {
                    sol_id: Number(id), acao: ACOES.REMARCADA, de: 'agendado', para: 'agendado', detalhe,
                });
                if (ag.sol_origem_id) {
                    await registrarHistorico(trx, req.session, {
                        sol_id: ag.sol_origem_id, acao: ACOES.REMARCADA, de: 'Autorizado', para: 'Autorizado', detalhe,
                    });
                }

                return {
                    status: 200,
                    corpo: { message: 'Agendamento remarcado', sol_id: Number(id), sol_data_de_coleta: novaData, sol_turno: vaga.turno, sol_data_anterior: dataAtual },
                };
            });

            if (resultado.status === 200) await notificar();

            return res.status(resultado.status).send(resultado.corpo);

        } catch (error) {
            console.error('Erro ao remarcar agendamento:', error);
            return res.status(500).send({ message: 'Erro ao remarcar o agendamento' });
        }
    },


    // LEITOR DE QR CODE (admin): texto lido do comprovante -> sol_id.
    // Aceita "INSUMED:AG000042:<código>" e, dos comprovantes antigos, só
    // "AG000042". O admin de posto só encontra agendamentos do próprio posto.
    async buscarPorQRCode(req, res) {
        try {
            const lido = lerCodigoQR(req.query.codigo);
            if (!lido) {
                registrarFalhaLeituraQR(req);
                return res.status(400).send({ message: 'QR Code não reconhecido. Use o QR do comprovante de agendamento do INSUMED.' });
            }

            const ag = await knex('solicitacao')
                .whereIn('sol_status', STATUS_AGENDAMENTO)
                .modify((qb) => {
                    if (lido.codigo) qb.where('sol_codigo_qr', lido.codigo);
                    else qb.where('sol_protocolo', lido.protocolo);
                })
                .first('sol_id', 'sol_protocolo', 'sol_status', 'pos_id');

            // código certo com protocolo trocado também é "não encontrado"
            if (!ag || ag.sol_protocolo !== lido.protocolo) {
                registrarFalhaLeituraQR(req);
                return res.status(404).send({ message: 'Nenhum agendamento encontrado para este QR Code.' });
            }

            const admin = req.session;
            if (!admin.tp_universal && admin.posto_id !== ag.pos_id) {
                return res.status(403).send({ message: 'Este agendamento é de outra unidade.' });
            }

            return res.status(200).send({ sol_id: ag.sol_id, sol_protocolo: ag.sol_protocolo, status: ag.sol_status });

        } catch (error) {
            console.error('Erro ao ler QR Code:', error);
            return res.status(500).send({ message: 'Erro ao ler o QR Code' });
        }
    },


    // TELA DE ATENDIMENTO (admin, aberta pelo leitor de QR Code).
    // Só o necessário para conferir e concluir/cancelar no balcão: sem
    // telefone, endereço, prescrição nem histórico. O acesso ao posto já foi
    // conferido por validarAcessoSolicitacao.
    async dadosAtendimento(req, res) {
        try {
            const { id } = req.params;

            const linhas = await knex('solicitacao as sol')
                .leftJoin('pacientes as pac', 'pac.pac_id', 'sol.pac_id')
                .leftJoin('postosdesaude as pos', 'pos.pos_id', 'sol.pos_id')
                .leftJoin('coleta as col', 'col.sol_id', 'sol.sol_id')
                .leftJoin('insumo as ins', 'ins.ins_id', 'col.ins_id')
                .leftJoin('solicitacao as ori', 'ori.sol_id', 'sol.sol_origem_id')
                .where('sol.sol_id', id)
                .whereIn('sol.sol_status', STATUS_AGENDAMENTO)
                .select(
                    'sol.sol_id', 'sol.sol_protocolo', 'sol.sol_data_de_coleta', 'sol.sol_status',
                    'sol.sol_motivo_cancelamento', 'sol.sol_retirado_por_nome',
                    'pac.pac_id', 'pac.pac_nome', 'pac.pac_cpf', 'pos.pos_nome',
                    'ins.ins_id', 'ins.ins_nome', 'ins.ins_quantidade', 'col.quantidade',
                    'ori.sol_data_vencimento'
                );

            if (!linhas.length) {
                return res.status(404).send({ message: 'Agendamento não encontrado' });
            }

            const [ag] = linhas;
            // quem pode retirar no lugar do paciente (para conferir o documento no balcão)
            const autorizados = (await autorizadosDoPaciente(ag.pac_id)).map((a) => ({
                pau_id: a.pau_id,
                pau_nome: a.pau_nome,
                pau_cpf_parcial: cpfParcial(a.pau_cpf),
                pau_parentesco: a.pau_parentesco ?? null,
            }));
            return res.status(200).send({
                autorizados,
                sol_retirado_por_nome: ag.sol_retirado_por_nome ?? null,
                sol_id: ag.sol_id,
                sol_protocolo: ag.sol_protocolo,
                sol_data_de_coleta: isoData(ag.sol_data_de_coleta),
                status: ag.sol_status,
                sol_motivo_cancelamento: ag.sol_motivo_cancelamento ?? null,
                paciente: { pac_nome: ag.pac_nome, pac_cpf_parcial: cpfParcial(ag.pac_cpf) },
                posto: { pos_nome: ag.pos_nome },
                prescricao_vencida: prescricaoVencida(ag.sol_data_vencimento, dataHojeBrasil()),
                hoje: dataHojeBrasil(),
                insumos: linhas.filter((l) => l.ins_id !== null).map((l) => ({
                    ins_id: l.ins_id,
                    ins_nome: l.ins_nome,
                    quantidade: Number(l.quantidade),
                    estoque: Number(l.ins_quantidade)
                }))
            });

        } catch (error) {
            console.error('Erro ao buscar dados do atendimento:', error);
            return res.status(500).send({ message: 'Erro ao buscar o agendamento' });
        }
    },


    // MEUS AGENDAMENTOS (visão do PACIENTE, paginado)
    async listarMeusAgendamentos(req, res) {
        try {
            if (req.session.tipo !== 'PACIENTE') {
                return res.status(403).send({ error: 'Rota exclusiva de paciente' });
            }

            // ?situacao=proximos  -> só 'agendado', do mais próximo para o mais distante
            // ?situacao=anteriores -> concluídos e cancelados, do mais recente
            // (sem o parâmetro: todos, como antes)
            const { situacao, sol_id } = req.query;
            if (situacao && !['proximos', 'anteriores'].includes(situacao)) {
                return res.status(400).send({ message: 'Situação inválida' });
            }
            // ?sol_id= (link de uma notificação): só aquele agendamento, se for do paciente
            if (sol_id !== undefined && !idValido(sol_id)) {
                return res.status(400).send({ message: 'Agendamento inválido' });
            }

            const filtros = (qb) => {
                qb.where('sol.pac_id', req.session.id);
                if (sol_id !== undefined) qb.where('sol.sol_id', Number(sol_id));
                if (situacao === 'proximos') qb.where('sol.sol_status', 'agendado');
                if (situacao === 'anteriores') qb.whereIn('sol.sol_status', ['concluido', ...STATUS_AGENDAMENTO_SEM_ENTREGA]);
            };
            const ordenar = (qb) => {
                qb.orderBy('sol.sol_data_de_coleta', situacao === 'proximos' ? 'asc' : 'desc')
                    .orderBy('sol.sol_id', 'desc');
            };

            return res.status(200).send(
                await listarPaginado({ page: req.query.page || 1, porPagina: req.query.porPagina || 4 }, filtros, ordenar, 50, { comCodigoQR: true })
            );

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

            const resultado = await baseQueryAgendamentos({ comCodigoQR: true })
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