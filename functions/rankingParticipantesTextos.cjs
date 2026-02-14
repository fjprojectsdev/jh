const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Arredonda numeros para 2 casas para manter a saida consistente.
function round2(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Converte string YYYY-MM-DD para Date UTC valida.
function parseIsoDate(dateStr) {
    if (typeof dateStr !== 'string') {
        return null;
    }

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
    if (!match) {
        return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return null;
    }

    return date;
}

// Calcula crescimento percentual; quando o periodo anterior e zero, usa 100% se houve atividade.
function calcGrowthPercent(previousTotal, currentTotal) {
    if (previousTotal === 0) {
        return currentTotal === 0 ? 0 : 100;
    }

    return ((currentTotal - previousTotal) / previousTotal) * 100;
}

function formatSignedPercent(value) {
    const rounded = round2(value);
    if (rounded > 0) {
        return `+${rounded}%`;
    }

    return `${rounded}%`;
}

// Normaliza filtro de grupo; vazio ou "todos" significa sem filtro.
function normalizeGroupFilter(grupoSelecionado) {
    if (grupoSelecionado === undefined || grupoSelecionado === null) {
        return null;
    }

    const value = String(grupoSelecionado).trim();
    if (!value || value.toLowerCase() === 'todos') {
        return null;
    }

    return value.toLowerCase();
}

// Valida e normaliza o intervalo principal informado.
function normalizeRange(dataInicio, dataFim) {
    const startDate = parseIsoDate(dataInicio);
    const endDate = parseIsoDate(dataFim);

    if (!startDate || !endDate) {
        throw new Error('dataInicio e dataFim devem estar no formato YYYY-MM-DD.');
    }

    if (startDate.getTime() > endDate.getTime()) {
        throw new Error('dataInicio nao pode ser maior que dataFim.');
    }

    return { startDate, endDate };
}

// Calcula o periodo anterior com a mesma duracao do periodo atual.
function getPreviousRange(startDate, endDate) {
    const durationDays = Math.floor((endDate.getTime() - startDate.getTime()) / ONE_DAY_MS) + 1;
    const previousEndDate = new Date(startDate.getTime() - ONE_DAY_MS);
    const previousStartDate = new Date(previousEndDate.getTime() - (durationDays - 1) * ONE_DAY_MS);

    return {
        previousStartDate,
        previousEndDate
    };
}

// Filtra somente interacoes validas dentro do intervalo solicitado.
function filterInteractionsByRange(interacoes, startDate, endDate, groupFilter) {
    return interacoes
        .filter((registro) => {
            if (!registro || typeof registro.nome !== 'string') {
                return false;
            }

            const nome = registro.nome.trim();
            if (!nome) {
                return false;
            }

            const data = parseIsoDate(registro.data);
            if (!data) {
                return false;
            }

            if (groupFilter) {
                const grupoRegistro = typeof registro.grupo === 'string' ? registro.grupo.trim().toLowerCase() : '';
                if (grupoRegistro !== groupFilter) {
                    return false;
                }
            }

            return data.getTime() >= startDate.getTime() && data.getTime() <= endDate.getTime();
        })
        .map((registro) => ({
            nome: registro.nome.trim(),
            data: registro.data,
            grupo: typeof registro.grupo === 'string' ? registro.grupo.trim() : ''
        }));
}

// Soma 1 ponto por mensagem para cada participante.
function countMessagesByParticipant(interacoes) {
    const totals = new Map();

    for (const registro of interacoes) {
        const atual = totals.get(registro.nome) || 0;
        totals.set(registro.nome, atual + 1);
    }

    return totals;
}

// Ordena participantes: maior total e depois ordem alfabetica para desempate.
function sortByRankingRules(items) {
    return items.sort((a, b) => {
        if (b.total !== a.total) {
            return b.total - a.total;
        }

        return a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' });
    });
}

// Monta ranking com crescimento em relacao ao periodo anterior.
function buildRanking(currentTotals, previousTotals, totalGeral) {
    const ranking = [];

    for (const [nome, total] of currentTotals.entries()) {
        const previous = previousTotals.get(nome) || 0;
        const crescimentoAbsoluto = total - previous;
        const crescimentoPercentual = calcGrowthPercent(previous, total);
        const percentualParticipacao = totalGeral === 0 ? 0 : (total / totalGeral) * 100;

        ranking.push({
            nome,
            total,
            percentual: round2(percentualParticipacao),
            crescimento: {
                absoluto: crescimentoAbsoluto,
                percentual: round2(crescimentoPercentual)
            }
        });
    }

    const ordered = sortByRankingRules(ranking);

    return ordered.map((item, index) => ({
        posicao: index + 1,
        nome: item.nome,
        total: item.total,
        percentual: item.percentual,
        crescimento: item.crescimento
    }));
}

// Identifica maior crescimento e maior queda considerando todos os participantes dos dois periodos.
function analyzeMovement(currentTotals, previousTotals) {
    const nomes = new Set([...currentTotals.keys(), ...previousTotals.keys()]);
    let maiorCrescimento = null;
    let maiorQueda = null;

    for (const nome of nomes) {
        const atual = currentTotals.get(nome) || 0;
        const anterior = previousTotals.get(nome) || 0;
        const absoluto = atual - anterior;
        const percentual = round2(calcGrowthPercent(anterior, atual));
        const base = { nome, absoluto, percentual };

        if (
            absoluto > 0 &&
            (!maiorCrescimento ||
                absoluto > maiorCrescimento.absoluto ||
                (absoluto === maiorCrescimento.absoluto &&
                    nome.localeCompare(maiorCrescimento.nome, 'pt-BR', { sensitivity: 'base' }) < 0))
        ) {
            maiorCrescimento = base;
        }

        if (
            absoluto < 0 &&
            (!maiorQueda ||
                absoluto < maiorQueda.absoluto ||
                (absoluto === maiorQueda.absoluto &&
                    nome.localeCompare(maiorQueda.nome, 'pt-BR', { sensitivity: 'base' }) < 0))
        ) {
            maiorQueda = base;
        }
    }

    return { maiorCrescimento, maiorQueda };
}

// Gera frases automaticas para leitura rapida do dashboard.
function buildInsights(rankingCompleto, resumo, movement) {
    const insights = [];
    const lider = rankingCompleto[0];

    if (lider) {
        insights.push(`${lider.nome} lidera com ${lider.percentual}% das mensagens.`);
    } else {
        insights.push('Nao houve mensagens no periodo selecionado.');
    }

    const top3Total = rankingCompleto.slice(0, 3).reduce((sum, item) => sum + item.total, 0);
    const top3Percentual = resumo.totalGeral === 0 ? 0 : round2((top3Total / resumo.totalGeral) * 100);
    insights.push(`Top 3 concentram ${top3Percentual}% da participacao.`);

    if (movement.maiorCrescimento) {
        insights.push(`${movement.maiorCrescimento.nome} teve maior crescimento no periodo (${formatSignedPercent(movement.maiorCrescimento.percentual)}).`);
    } else {
        insights.push('Nenhum participante apresentou crescimento no periodo.');
    }

    if (movement.maiorQueda) {
        insights.push(`${movement.maiorQueda.nome} teve maior queda no periodo (${formatSignedPercent(movement.maiorQueda.percentual)}).`);
    } else {
        insights.push('Nao houve queda de mensagens em relacao ao periodo anterior.');
    }

    const usuariosComUmaMensagem = rankingCompleto.filter((item) => item.total === 1).length;
    insights.push(`${usuariosComUmaMensagem} participantes enviaram apenas 1 mensagem.`);

    insights.push(`A media geral foi de ${resumo.mediaPorParticipante} mensagens por participante.`);

    return insights;
}

// Funcao principal para gerar dashboard completo de ranking de participantes por texto.
function gerarRankingParticipantesTexto(interacoes, dataInicio, dataFim, grupoSelecionado) {
    if (!Array.isArray(interacoes)) {
        throw new Error('interacoes deve ser um array.');
    }

    const { startDate, endDate } = normalizeRange(dataInicio, dataFim);
    const { previousStartDate, previousEndDate } = getPreviousRange(startDate, endDate);
    const groupFilter = normalizeGroupFilter(grupoSelecionado);

    // 1) Filtra interacoes do periodo atual e do periodo anterior.
    const interacoesPeriodoAtual = filterInteractionsByRange(interacoes, startDate, endDate, groupFilter);
    const interacoesPeriodoAnterior = filterInteractionsByRange(interacoes, previousStartDate, previousEndDate, groupFilter);

    // 2) Calcula totais por participante e totais gerais.
    const totaisAtuais = countMessagesByParticipant(interacoesPeriodoAtual);
    const totaisAnteriores = countMessagesByParticipant(interacoesPeriodoAnterior);
    const totalGeral = interacoesPeriodoAtual.length;
    const totalParticipantes = totaisAtuais.size;
    const mediaPorParticipante = totalParticipantes === 0 ? 0 : round2(totalGeral / totalParticipantes);

    // 3) Gera ranking completo seguindo regras de ordenacao.
    const rankingCompleto = buildRanking(totaisAtuais, totaisAnteriores, totalGeral);

    // 4) Separa Top 15.
    const top15 = rankingCompleto.slice(0, 15);

    // 5) Gera insights com comparacao do periodo anterior.
    const movement = analyzeMovement(totaisAtuais, totaisAnteriores);
    const insights = buildInsights(
        rankingCompleto,
        { totalGeral, totalParticipantes, mediaPorParticipante },
        movement
    );

    return {
        resumo: {
            totalGeral,
            totalParticipantes,
            mediaPorParticipante
        },
        top15,
        rankingCompleto,
        insights
    };
}

module.exports = gerarRankingParticipantesTexto;
