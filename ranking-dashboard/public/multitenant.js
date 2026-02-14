const STORAGE_KEY = 'imavy_multitenant_token';

function getNextPath() {
  const params = new URLSearchParams(window.location.search || '');
  const next = (params.get('next') || '').trim();
  if (!next || !next.startsWith('/')) {
    return '';
  }
  return next;
}

function irParaProximaRotaSeExiste() {
  const next = getNextPath();
  if (next) {
    window.location.replace(next);
    return true;
  }
  return false;
}

function irParaDashboardPrincipal() {
  window.location.replace('/');
}

function byId(id) {
  return document.getElementById(id);
}

function setStatus(text, ok = true) {
  const el = byId('mtStatus');
  el.textContent = text;
  el.classList.remove('delta-pos', 'delta-neg');
  el.classList.add(ok ? 'delta-pos' : 'delta-neg');
}

function normalizeErrorMessage(error) {
  const msg = String((error && error.message) || 'Erro inesperado.');
  if (msg.toLowerCase().includes('jwt secret')) {
    return 'Erro de autenticacao temporario. Tente novamente em alguns segundos.';
  }
  if (msg.toLowerCase().includes('failed to fetch')) {
    return 'Falha de conexao com a API. Verifique o deploy.';
  }
  return msg;
}

function getToken() {
  return localStorage.getItem(STORAGE_KEY) || '';
}

function setToken(token) {
  if (token) {
    localStorage.setItem(STORAGE_KEY, token);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  byId('tokenStatus').textContent = token ? 'autenticado' : 'nao autenticado';
  toggleLoginOnlySections(Boolean(token));
}

function toggleLoginOnlySections(isAuthenticated) {
  const gruposCard = byId('gruposCard');
  if (gruposCard) {
    gruposCard.classList.toggle('hidden', !isAuthenticated);
  }

  const rankingCard = byId('rankingCard');
  if (rankingCard) {
    rankingCard.classList.toggle('hidden', !isAuthenticated);
  }
}

function formatResumoSync(sync) {
  if (!sync || typeof sync !== 'object') {
    return '';
  }

  if (!sync.ok) {
    return sync.erro ? ` Vinculo de grupos: ${sync.erro}` : ' Vinculo de grupos nao concluido.';
  }

  const resumo = sync.resumo || {};
  const criados = Number(resumo.criados || 0);
  const jaVinculados = Number(resumo.jaVinculadosAoCliente || 0);
  const bloqueados = Number(resumo.bloqueadosPorOutroCliente || 0);
  return ` Grupos sincronizados: +${criados}, existentes ${jaVinculados}, bloqueados ${bloqueados}.`;
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(path, {
    ...options,
    headers
  });

  const body = await response.json().catch(() => ({}));
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(body.error || 'Erro retornado pela API.');
  }

  if (!response.ok) {
    throw new Error(body.error || `Erro HTTP ${response.status}`);
  }

  return body;
}

async function registrar() {
  const nome = byId('regNome').value;
  const email = byId('regEmail').value;
  const senha = byId('regSenha').value;
  const plano = byId('regPlano').value;

  const body = await apiFetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ nome, email, senha, plano })
  });

  setToken(body.token || '');
  setStatus(`Cliente registrado com sucesso.${formatResumoSync(body.gruposAutorizadosSync)}`);
  if (irParaProximaRotaSeExiste()) {
    return;
  }
  irParaDashboardPrincipal();
}

async function login() {
  const email = byId('logEmail').value;
  const senha = byId('logSenha').value;

  const body = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, senha })
  });

  setToken(body.token || '');
  setStatus(`Login realizado com sucesso.${formatResumoSync(body.gruposAutorizadosSync)}`);
  if (irParaProximaRotaSeExiste()) {
    return;
  }
  irParaDashboardPrincipal();
}

function logout() {
  setToken('');
  byId('gruposLista').innerHTML = '';
  byId('rkGrupo').innerHTML = '<option value="">Todos os grupos do cliente</option>';
  byId('rankingOut').textContent = '';
  setStatus('Sessao encerrada.', true);
}

function renderGrupos(grupos) {
  const list = byId('gruposLista');
  list.innerHTML = '';

  const select = byId('rkGrupo');
  select.innerHTML = '<option value="">Todos os grupos do cliente</option>';

  for (const grupo of grupos) {
    const item = document.createElement('div');
    item.className = 'group-item';

    const inputNome = document.createElement('input');
    inputNome.type = 'text';
    inputNome.value = grupo.nome;

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Salvar';
    saveBtn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/grupos/${encodeURIComponent(grupo.id)}`, {
          method: 'PUT',
          body: JSON.stringify({ nome: inputNome.value })
        });
        setStatus(`Grupo ${grupo.id} atualizado.`);
        await carregarGrupos();
      } catch (e) {
        setStatus(e.message, false);
      }
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'ghost';
    removeBtn.textContent = 'Remover';
    removeBtn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/grupos/${encodeURIComponent(grupo.id)}`, {
          method: 'DELETE'
        });
        setStatus(`Grupo ${grupo.id} removido.`);
        await carregarGrupos();
      } catch (e) {
        setStatus(e.message, false);
      }
    });

    item.innerHTML = `<div class="small"><strong>${grupo.id}</strong></div>`;
    const row = document.createElement('div');
    row.className = 'inline';
    row.appendChild(inputNome);
    row.appendChild(saveBtn);
    row.appendChild(removeBtn);
    item.appendChild(row);
    list.appendChild(item);

    const opt = document.createElement('option');
    opt.value = grupo.id;
    opt.textContent = `${grupo.nome} (${grupo.id})`;
    select.appendChild(opt);
  }
}

async function carregarGrupos() {
  if (!getToken()) {
    return;
  }

  const body = await apiFetch('/api/grupos', { method: 'GET' });
  renderGrupos(body.grupos || []);
}

async function criarGrupo() {
  const id = byId('grupoId').value;
  const nome = byId('grupoNome').value;

  await apiFetch('/api/grupos', {
    method: 'POST',
    body: JSON.stringify({ id, nome })
  });

  setStatus('Grupo criado com sucesso.');
  await carregarGrupos();
}

async function gerarRanking() {
  const dataInicio = byId('rkInicio').value;
  const dataFim = byId('rkFim').value;
  const grupoId = byId('rkGrupo').value;

  const params = new URLSearchParams({ dataInicio, dataFim });
  if (grupoId) {
    params.set('grupoId', grupoId);
  }

  const body = await apiFetch(`/api/dashboard/ranking?${params.toString()}`, { method: 'GET' });
  byId('rankingOut').textContent = JSON.stringify(body, null, 2);
  setStatus('Ranking gerado com sucesso.');
}

function init() {
  byId('btnRegistrar').addEventListener('click', () => registrar().catch((e) => setStatus(normalizeErrorMessage(e), false)));
  byId('btnLogin').addEventListener('click', () => login().catch((e) => setStatus(normalizeErrorMessage(e), false)));
  byId('btnLogout').addEventListener('click', logout);
  byId('btnCriarGrupo').addEventListener('click', () => criarGrupo().catch((e) => setStatus(normalizeErrorMessage(e), false)));
  byId('btnRanking').addEventListener('click', () => gerarRanking().catch((e) => setStatus(normalizeErrorMessage(e), false)));

  const now = new Date();
  const end = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const startDate = new Date(now.getTime() - (6 * 24 * 60 * 60 * 1000));
  const start = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, '0')}-${String(startDate.getUTCDate()).padStart(2, '0')}`;

  byId('rkInicio').value = start;
  byId('rkFim').value = end;
  setToken(getToken());
  const token = getToken();
  if (token && !getNextPath()) {
    irParaDashboardPrincipal();
    return;
  }

  carregarGrupos().catch(() => {});
}

window.addEventListener('DOMContentLoaded', init);
