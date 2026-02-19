(function attachPremiumAnalytics(global) {
    function round2(value) {
        return Math.round((value + Number.EPSILON) * 100) / 100;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function parseIsoDate(dateStr) {
        if (typeof dateStr !== 'string') {
            return null;
        }

        const parts = dateStr.split('-');
        if (parts.length !== 3) {
            return null;
        }

        const year = Number(parts[0]);
        const month = Number(parts[1]);
        const day = Number(parts[2]);
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

    function diffDaysInclusive(startDate, endDate) {
        const dayMs = 24 * 60 * 60 * 1000;
        return Math.floor((endDate.getTime() - startDate.getTime()) / dayMs) + 1;
    }

    // Calcula score de engajamento em escala 0-100 usando percentual e crescimento.
    function calcularScoreEngajamento(participante) {
        const participacao = clamp(Number(participante.percentual || 0), 0, 100);
        const crescimento = clamp(Number(participante.crescimento && participante.crescimento.percentual || 0), -100, 100);
        const crescimentoNormalizado = ((crescimento + 100) / 200) * 100;
        const score = (participacao * 0.6) + (crescimentoNormalizado * 0.4);
        return round2(clamp(score, 0, 100));
    }

    // Calcula indice de concentracao usando acumulado do top 3.
    function calcularIndiceConcentracao(rankingCompleto) {
        const top3 = (rankingCompleto || [])
            .slice(0, 3)
            .reduce((sum, item) => sum + Number(item.percentual || 0), 0);

        let classificacao = 'Saudavel';
        if (top3 >= 50 && top3 <= 70) {
            classificacao = 'Moderado';
        } else if (top3 > 70) {
            classificacao = 'Concentrado';
        }

        return {
            top3Percentual: round2(top3),
            classificacao
        };
    }

    // Projeta fechamento ate o fim do mes com base no ritmo diario atual.
    function calcularProjecao(totalAtual, dataInicio, dataFim) {
        const inicio = parseIsoDate(dataInicio);
        const fim = parseIsoDate(dataFim);

        if (!inicio || !fim || fim.getTime() < inicio.getTime()) {
            return {
                mediaDiaria: 0,
                totalProjetado: 0,
                diasRestantesNoMes: 0
            };
        }

        const diasPeriodo = diffDaysInclusive(inicio, fim);
        const mediaDiaria = diasPeriodo > 0 ? Number(totalAtual || 0) / diasPeriodo : 0;

        const fimDoMes = new Date(Date.UTC(fim.getUTCFullYear(), fim.getUTCMonth() + 1, 0));
        const diasRestantesNoMes = Math.max(0, diffDaysInclusive(fim, fimDoMes) - 1);

        const totalProjetado = Number(totalAtual || 0) + (mediaDiaria * diasRestantesNoMes);

        return {
            mediaDiaria: round2(mediaDiaria),
            totalProjetado: round2(totalProjetado),
            diasRestantesNoMes
        };
    }

    // Classifica nivel por distribuicao e sinal de risco.
    function classificarNivel(context) {
        const posicao = Number(context.posicao || 1);
        const totalParticipantes = Math.max(1, Number(context.totalParticipantes || 1));
        const emRisco = Boolean(context.emRisco);

        if (emRisco) {
            return '\u26A0 Em risco';
        }

        const percentualPosicao = (posicao / totalParticipantes) * 100;

        if (percentualPosicao <= 10) {
            return '\uD83C\uDFC6 Elite';
        }

        if (percentualPosicao <= 30) {
            return '\uD83D\uDD25 Alto Engajamento';
        }

        if (percentualPosicao <= 70) {
            return '\u26A1 Medio';
        }

        return '\uD83C\uDF31 Baixo';
    }

    function obterLider(ranking) {
        return Array.isArray(ranking) && ranking.length > 0 ? ranking[0] : null;
    }

    function participanteKey(participante) {
        if (!participante) {
            return '';
        }

        const nome = String(participante.nome || '').trim().toLowerCase();
        const grupo = String(participante.grupo || '').trim().toLowerCase();
        return `${nome}::${grupo}`;
    }

    function participanteLabel(participante) {
        if (!participante) {
            return '-';
        }

        const nome = String(participante.nome || '').trim() || '-';
        const grupo = String(participante.grupo || '').trim();
        return grupo ? `${nome} (${grupo})` : nome;
    }

    // Gera 8 insights premium com foco estrategico.
    function gerarInsightsPremium(payload) {
        const ranking = payload.ranking || [];
        const rankingAnterior = payload.rankingAnterior || [];
        const resumo = payload.resumo || {};
        const resumoAnterior = payload.resumoAnterior || {};
        const indiceConcentracao = payload.indiceConcentracao || { top3Percentual: 0, classificacao: 'Saudavel' };
        const projecaoLider = payload.projecaoLider || { totalProjetado: 0 };

        const liderAtual = obterLider(ranking);
        const liderAnterior = obterLider(rankingAnterior);

        const totalAtual = Number(resumo.totalGeral || 0);
        const totalAnterior = Number(resumoAnterior.totalGeral || 0);
        const crescimentoGeral = totalAnterior === 0
            ? (totalAtual > 0 ? 100 : 0)
            : ((totalAtual - totalAnterior) / totalAnterior) * 100;

        const mediaAtual = Number(payload.mediaDiariaAtual || 0);
        const mediaAnterior = Number(payload.mediaDiariaAnterior || 0);
        const crescimentoMediaDiaria = mediaAnterior === 0
            ? (mediaAtual > 0 ? 100 : 0)
            : ((mediaAtual - mediaAnterior) / mediaAnterior) * 100;

        const acelerado = ranking
            .filter((item) => Number(item.crescimento && item.crescimento.percentual || 0) > 0)
            .sort((a, b) => Number(b.crescimento.percentual || 0) - Number(a.crescimento.percentual || 0))[0] || null;

        const emRisco = ranking.filter((item) => item.emRisco);
        const abaixoDaMedia = ranking.filter((item) => Number(item.total || 0) < Number(resumo.mediaPorParticipante || 0)).length;

        const insights = [];

        if (liderAtual && liderAnterior && participanteKey(liderAtual) === participanteKey(liderAnterior)) {
            insights.push(`${participanteLabel(liderAtual)} lidera pelo segundo ciclo consecutivo.`);
        } else if (liderAtual) {
            insights.push(`${participanteLabel(liderAtual)} assumiu a lideranca neste ciclo.`);
        } else {
            insights.push('Nao houve lideranca definida neste ciclo.');
        }

        insights.push(`Top 3 concentram ${round2(indiceConcentracao.top3Percentual)}% das mensagens.`);

        if (crescimentoGeral >= 0) {
            insights.push(`O engajamento geral cresceu ${round2(crescimentoGeral)}%.`);
        } else {
            insights.push(`O engajamento geral retraiu ${round2(Math.abs(crescimentoGeral))}%.`);
        }

        if (acelerado) {
            insights.push(`${participanteLabel(acelerado)} apresenta crescimento acelerado.`);
        } else {
            insights.push('Nenhum participante apresentou crescimento acelerado neste ciclo.');
        }

        if (emRisco.length > 0) {
            insights.push(`${participanteLabel(emRisco[0])} apresenta risco de inatividade.`);
        } else {
            insights.push('Nao ha participantes em risco critico no periodo atual.');
        }

        if (crescimentoMediaDiaria >= 0) {
            insights.push(`A media diaria subiu ${round2(crescimentoMediaDiaria)}%.`);
        } else {
            insights.push(`A media diaria caiu ${round2(Math.abs(crescimentoMediaDiaria))}%.`);
        }

        insights.push(`O nivel de concentracao esta classificado como ${indiceConcentracao.classificacao}.`);
        insights.push(`${abaixoDaMedia} participantes estao abaixo da media.`);

        if (liderAtual) {
            insights.push(`Se o ritmo continuar, ${participanteLabel(liderAtual)} fechara o mes com ${round2(projecaoLider.totalProjetado)} mensagens.`);
        } else {
            insights.push('Sem atividade suficiente para projetar fechamento do mes.');
        }

        return insights.slice(0, 8);
    }

    const api = {
        calcularScoreEngajamento,
        calcularProjecao,
        calcularIndiceConcentracao,
        classificarNivel,
        gerarInsightsPremium
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    global.PremiumAnalytics = api;
})(typeof window !== 'undefined' ? window : globalThis);
