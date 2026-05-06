const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const rootDir = process.cwd();
const auditPath = path.resolve(rootDir, 'fsx_presale_audit.json');
const htmlPath = path.resolve(rootDir, 'fsx_presale_report.html');
const pdfPath = path.resolve(rootDir, 'fsx_presale_report.pdf');

function readAudit() {
    return JSON.parse(fs.readFileSync(auditPath, 'utf8'));
}

function decimalRate(usdRaw, tokenRaw, decimals = 12) {
    const usd = BigInt(usdRaw);
    const tok = BigInt(tokenRaw);
    if (tok === 0n) return '0';
    const scale = 10n ** BigInt(decimals);
    const q = (usd * scale) / tok;
    const s = q.toString().padStart(decimals + 1, '0');
    const whole = s.slice(0, -decimals).replace(/^0+(?=\d)/, '');
    const frac = s.slice(-decimals).replace(/0+$/, '');
    return `${whole || '0'}${frac ? '.' + frac : ''}`;
}

function fmtUsd(value) {
    const numeric = Number(value);
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(numeric);
}

function fmtToken(value) {
    const numeric = Number(value);
    return new Intl.NumberFormat('pt-BR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(numeric);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function shortHash(value) {
    const safe = String(value || '');
    if (safe.length <= 18) return safe;
    return `${safe.slice(0, 10)}...${safe.slice(-8)}`;
}

function chunkArray(items, chunkSize) {
    const output = [];
    for (let index = 0; index < items.length; index += chunkSize) {
        output.push(items.slice(index, index + chunkSize));
    }
    return output;
}

function buildPhaseGroups(entries) {
    const prices = [...new Set(entries.map((entry) => decimalRate(entry.usdValueRaw, entry.tokensReceivedRaw, 12)))]
        .sort((a, b) => Number(a) - Number(b));

    const phaseByPrice = new Map(prices.map((price, index) => [price, `Fase Inferida ${index + 1}`]));

    const groups = prices.map((price, index) => ({
        phase: `Fase Inferida ${index + 1}`,
        inferredTokenPriceUsd: price,
        entries: [],
        totalUsd: 0,
        totalTokens: 0
    }));

    for (const entry of entries) {
        const price = decimalRate(entry.usdValueRaw, entry.tokensReceivedRaw, 12);
        const phaseName = phaseByPrice.get(price);
        const group = groups.find((item) => item.phase === phaseName);
        if (!group) continue;
        group.entries.push({
            ...entry,
            inferredTokenPriceUsd: price,
            inferredPhase: phaseName
        });
        group.totalUsd += Number(entry.usdValue);
        group.totalTokens += Number(entry.tokensReceived18);
    }

    return groups;
}

function buildHtml(audit) {
    const entries = audit.entries.slice().sort((a, b) => a.blockNumber - b.blockNumber);
    const phaseGroups = buildPhaseGroups(entries);
    const grandTotalUsd = phaseGroups.reduce((sum, group) => sum + group.totalUsd, 0);
    const grandTotalTokens = phaseGroups.reduce((sum, group) => sum + group.totalTokens, 0);
    const coveredFrom = entries[0]?.dateTime || '';
    const coveredTo = entries[entries.length - 1]?.dateTime || '';

    const phaseSummaryRows = phaseGroups.map((group) => `
        <tr>
            <td>${escapeHtml(group.phase)}</td>
            <td>${escapeHtml(group.inferredTokenPriceUsd)}</td>
            <td>${group.entries.length}</td>
            <td>${fmtUsd(group.totalUsd)}</td>
            <td>${fmtToken(group.totalTokens)}</td>
        </tr>
    `).join('');

    const detailSections = phaseGroups.map((group) => {
        const tables = chunkArray(group.entries, 40).map((entryChunk, chunkIndex) => {
            const rows = entryChunk.map((entry) => `
                <tr>
                    <td>${escapeHtml(entry.dateTime)}</td>
                    <td>${entry.blockNumber}</td>
                    <td>${escapeHtml(entry.method)}</td>
                    <td>${fmtUsd(entry.usdValue)}</td>
                    <td>${fmtToken(entry.tokensReceived18)}</td>
                    <td>${escapeHtml(entry.paymentAmount18)}</td>
                    <td>${escapeHtml(entry.inferredTokenPriceUsd)}</td>
                    <td class="hash">${escapeHtml(shortHash(entry.txHash))}</td>
                </tr>
            `).join('');

            return `
                <div class="table-block ${chunkIndex > 0 ? 'table-break' : ''}">
                    <table>
                        <thead>
                            <tr>
                                <th>Data/Hora</th>
                                <th>Bloco</th>
                                <th>Metodo</th>
                                <th>USD</th>
                                <th>FSX</th>
                                <th>Pagamento</th>
                                <th>Preco/FSX</th>
                                <th>Tx</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `;
        }).join('');

        return `
            <section class="phase-section">
                <h2>${escapeHtml(group.phase)} <span>Preco inferido: $${escapeHtml(group.inferredTokenPriceUsd)} por FSX</span></h2>
                <div class="phase-meta">
                    <div><strong>Compras:</strong> ${group.entries.length}</div>
                    <div><strong>Total USD:</strong> ${fmtUsd(group.totalUsd)}</div>
                    <div><strong>Total FSX:</strong> ${fmtToken(group.totalTokens)}</div>
                </div>
                ${tables}
            </section>
        `;
    }).join('');

    return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>FSX Presale Report</title>
  <style>
    :root {
      --bg: #f6f1e8;
      --paper: #fffdf9;
      --ink: #1f2a2e;
      --muted: #5c676b;
      --line: #d8ccc0;
      --accent: #b45f06;
      --accent-soft: #f2dfc2;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, #efe1cf, transparent 28%),
        linear-gradient(180deg, #f7f2ea 0%, #efe6da 100%);
      padding: 28px;
    }
    .page {
      background: var(--paper);
      border: 1px solid var(--line);
      padding: 28px 30px 34px;
    }
    h1, h2 {
      margin: 0;
      font-weight: 700;
    }
    h1 {
      font-size: 28px;
      letter-spacing: 0.3px;
    }
    h2 {
      font-size: 20px;
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 16px;
    }
    h2 span {
      font-size: 12px;
      color: var(--muted);
      font-weight: 400;
    }
    p {
      margin: 0;
      line-height: 1.45;
      color: var(--muted);
    }
    .hero {
      display: grid;
      grid-template-columns: 1.4fr 1fr;
      gap: 18px;
      margin-bottom: 22px;
      align-items: start;
    }
    .tag {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      background: var(--accent-soft);
      color: var(--accent);
      margin-bottom: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }
    .card {
      border: 1px solid var(--line);
      background: #fffaf2;
      padding: 14px;
      border-radius: 10px;
    }
    .card .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .card .value {
      font-size: 22px;
      font-weight: 700;
      color: var(--ink);
    }
    .note {
      margin-top: 14px;
      padding: 12px 14px;
      border-left: 4px solid var(--accent);
      background: #fff7ec;
      font-size: 13px;
    }
    code {
      background: rgba(0, 0, 0, 0.05);
      padding: 1px 4px;
      border-radius: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      margin-top: 12px;
    }
    th, td {
      border: 1px solid var(--line);
      padding: 7px 8px;
      font-size: 11px;
      vertical-align: top;
      word-break: break-word;
    }
    th {
      background: #f2e6d8;
      text-align: left;
    }
    .phase-section {
      margin-top: 22px;
      page-break-inside: avoid;
    }
    .table-block {
      page-break-inside: avoid;
    }
    .table-break {
      page-break-before: always;
      margin-top: 18px;
    }
    .phase-meta {
      display: flex;
      gap: 18px;
      flex-wrap: wrap;
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .hash {
      font-family: "Courier New", monospace;
      font-size: 10px;
    }
    .footer-total {
      margin-top: 26px;
      border-top: 2px solid var(--ink);
      padding-top: 14px;
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: baseline;
    }
    .footer-total .big {
      font-size: 26px;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <div>
        <div class="tag">Relatorio PDF estilo planilha</div>
        <h1>FSX Presale: compras por compra, totais por fase e total geral</h1>
        <p>Contrato auditado: ${escapeHtml(audit.summary.contract)}</p>
        <p>Base usada: ${escapeHtml(path.basename(audit.summary.sourceTxList))}</p>
        <p>Cobertura desta base: ${escapeHtml(coveredFrom)} ate ${escapeHtml(coveredTo)}</p>
        <div class="note">
          As fases abaixo foram <strong>inferidas pelo preco efetivo por token</strong> observado em cada evento on-chain
          <code>TokensPurchased</code>. Esta base nao inclui compras posteriores a 5 de abril de 2026.
        </div>
      </div>
      <div class="summary-grid">
        <div class="card">
          <div class="label">Compras auditadas</div>
          <div class="value">${audit.summary.tokensPurchasedEvents}</div>
        </div>
        <div class="card">
          <div class="label">Total arrecadado</div>
          <div class="value">${fmtUsd(audit.summary.totalUsd)}</div>
        </div>
        <div class="card">
          <div class="label">Total de FSX vendidos</div>
          <div class="value">${fmtToken(audit.summary.totalTokens)}</div>
        </div>
        <div class="card">
          <div class="label">Fases inferidas nesta base</div>
          <div class="value">${phaseGroups.length}</div>
        </div>
      </div>
    </section>

    <section>
      <h2>Resumo por Fase <span>agrupado por preco on-chain</span></h2>
      <table>
        <thead>
          <tr>
            <th>Fase</th>
            <th>Preco inferido por FSX (USD)</th>
            <th>Compras</th>
            <th>Total USD</th>
            <th>Total FSX</th>
          </tr>
        </thead>
        <tbody>${phaseSummaryRows}</tbody>
      </table>
    </section>

    ${detailSections}

    <section class="footer-total">
      <div>
        <div class="label">Total de todas as fases desta base</div>
        <div class="big">${fmtUsd(grandTotalUsd)}</div>
      </div>
      <div>
        <div class="label">Total de FSX</div>
        <div class="big">${fmtToken(grandTotalTokens)}</div>
      </div>
    </section>
  </main>
</body>
</html>`;
}

async function main() {
    const audit = readAudit();
    const html = buildHtml(audit);
    fs.writeFileSync(htmlPath, html, 'utf8');

    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' });
    await page.pdf({
        path: pdfPath,
        format: 'A4',
        printBackground: true,
        margin: {
            top: '10mm',
            right: '8mm',
            bottom: '10mm',
            left: '8mm'
        }
    });
    await browser.close();

    console.log(JSON.stringify({
        htmlPath,
        pdfPath
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
