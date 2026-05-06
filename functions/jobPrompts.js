function normalizeSpace(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim();
}

export function buildJobExtractionPrompt(scrapedText) {
    const safeText = String(scrapedText || '').trim();
    return [
        'Voce e um sistema de processamento de vagas de emprego.',
        'Sua funcao e analisar dados coletados automaticamente por web scraping e transformar em um formato estruturado.',
        '',
        'Tarefas:',
        '1. Identifique cada vaga presente no texto.',
        '2. Extraia as seguintes informacoes:',
        '- titulo_da_vaga',
        '- empresa',
        '- localizacao',
        '- tipo_de_trabalho (remoto, hibrido ou presencial)',
        '- faixa_salarial (se existir)',
        '- tecnologias_principais',
        '- senioridade (junior, pleno, senior, etc)',
        '- descricao_resumida (maximo 200 caracteres)',
        '- link_da_vaga',
        '3. Normalize cargos parecidos.',
        'Exemplo: "Dev Python Jr", "Python Developer Junior" -> "Desenvolvedor Python Junior".',
        '4. Ignore conteudos irrelevantes como anuncios ou navegacao do site.',
        '5. Se algum campo nao existir no texto, retorne null.',
        '6. Retorne apenas JSON valido no formato:',
        '[',
        '{',
        '"titulo_da_vaga": "",',
        '"empresa": "",',
        '"localizacao": "",',
        '"tipo_de_trabalho": "",',
        '"faixa_salarial": "",',
        '"tecnologias_principais": [],',
        '"senioridade": "",',
        '"descricao_resumida": "",',
        '"link_da_vaga": ""',
        '}',
        ']',
        '',
        'Texto das vagas:',
        safeText || '{{DADOS_COLETADOS_PELO_SCRAPER}}'
    ].join('\n');
}

export function buildJobFilteringPrompt(jobs) {
    const serializedJobs = typeof jobs === 'string' ? jobs : JSON.stringify(jobs || [], null, 2);
    return [
        'Voce e um sistema que filtra vagas de emprego.',
        'Recebera uma lista JSON de vagas.',
        '',
        'Regras de filtragem:',
        '- Priorizar vagas remotas',
        '- Priorizar vagas de tecnologia',
        '- Priorizar cargos relacionados a Python, IA, automacao, backend e data',
        '- Remover vagas duplicadas',
        '- Retornar apenas as vagas mais relevantes',
        '',
        'Formato de saida: JSON.',
        '',
        'Lista JSON de vagas:',
        serializedJobs
    ].join('\n');
}

export function buildJobCompatibilityPrompt(profile = {}, job = null) {
    const safeProfile = {
        area: normalizeSpace(profile.area || 'tecnologia'),
        interesse: normalizeSpace(profile.interesse || 'automacao, IA, backend'),
        experiencia: normalizeSpace(profile.experiencia || 'Python, APIs, bots, scraping'),
        nivel: normalizeSpace(profile.nivel || 'pleno')
    };

    const serializedJob = job == null ? '{{VAGA_JSON}}' : JSON.stringify(job, null, 2);
    return [
        'Voce e um avaliador de compatibilidade de vagas.',
        '',
        'Perfil do candidato:',
        `- Area: ${safeProfile.area}`,
        `- Interesse: ${safeProfile.interesse}`,
        `- Experiencia: ${safeProfile.experiencia}`,
        `- Nivel: ${safeProfile.nivel}`,
        '',
        'Analise a vaga e gere:',
        '- score_de_compatibilidade (0 a 100)',
        '- motivo_da_classificacao',
        '',
        'Formato de saida:',
        '{',
        '"vaga": "...",',
        '"score": 0,',
        '"motivo": ""',
        '}',
        '',
        'Vaga:',
        serializedJob
    ].join('\n');
}
