export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  try {
    const { messages, system } = req.body;

    // ── BUSCA DADOS ECONÔMICOS EM PARALELO ──────────────────────────
    const [selic, ipca, cambio, ibovespa] = await Promise.allSettled([
      fetchSelic(),
      fetchIPCA(),
      fetchCambio(),
      fetchIbovespa()
    ]);

    // ── MONTA BLOCO DE CONTEXTO COM OS DADOS DO DIA ─────────────────
    const hoje = new Date().toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });

    const dadosEconomicos = `
--- DADOS ECONÔMICOS ATUALIZADOS (${hoje}) ---
${selic.status === 'fulfilled' ? `Selic Meta: ${selic.value}% a.a.` : 'Selic: dado indisponível no momento'}
${ipca.status === 'fulfilled' ? `IPCA acumulado (12 meses): ${ipca.value}%` : 'IPCA: dado indisponível no momento'}
${cambio.status === 'fulfilled' ? `Dólar (USD/BRL): R$ ${cambio.value.dolar} | Euro (EUR/BRL): R$ ${cambio.value.euro}` : 'Câmbio: dado indisponível no momento'}
${ibovespa.status === 'fulfilled' ? `Ibovespa: ${ibovespa.value.pontos} pontos (${ibovespa.value.variacao}% no dia)` : 'Ibovespa: dado indisponível no momento'}
CDI: aproximadamente ${selic.status === 'fulfilled' ? (parseFloat(selic.value) - 0.10).toFixed(2) : '—'}% a.a. (referência: Selic - 0,10%)
--- USE ESSES DADOS AO RESPONDER PERGUNTAS SOBRE INDICADORES ---`;

    // ── INJETA OS DADOS NO SYSTEM PROMPT ────────────────────────────
    const systemComDados = system + '\n\n' + dadosEconomicos;

    // ── CHAMA A API DO CLAUDE ────────────────────────────────────────
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemComDados,
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });
    return res.status(200).json(data);

  } catch (error) {
    console.error('Erro no handler:', error);
    return res.status(500).json({ error: 'Erro interno do servidor' });
  }
}

// ── FUNÇÕES DE BUSCA ─────────────────────────────────────────────────

// Selic Meta — Banco Central (série 432)
async function fetchSelic() {
  const res = await fetch(
    'https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json',
    { signal: AbortSignal.timeout(5000) }
  );
  const data = await res.json();
  return parseFloat(data[0].valor).toFixed(2);
}

// IPCA acumulado 12 meses — Banco Central (série 13522)
async function fetchIPCA() {
  const res = await fetch(
    'https://api.bcb.gov.br/dados/serie/bcdata.sgs.13522/dados/ultimos/1?formato=json',
    { signal: AbortSignal.timeout(5000) }
  );
  const data = await res.json();
  return parseFloat(data[0].valor).toFixed(2);
}

// Câmbio — Banco Central (dólar e euro)
async function fetchCambio() {
  const [resDolar, resEuro] = await Promise.all([
    fetch('https://api.bcb.gov.br/dados/serie/bcdata.sgs.10813/dados/ultimos/1?formato=json', { signal: AbortSignal.timeout(5000) }),
    fetch('https://api.bcb.gov.br/dados/serie/bcdata.sgs.21619/dados/ultimos/1?formato=json', { signal: AbortSignal.timeout(5000) })
  ]);
  const [dolarData, euroData] = await Promise.all([resDolar.json(), resEuro.json()]);
  return {
    dolar: parseFloat(dolarData[0].valor).toFixed(2),
    euro: parseFloat(euroData[0].valor).toFixed(2)
  };
}

// Ibovespa — Brapi
async function fetchIbovespa() {
  const res = await fetch(
    'https://brapi.dev/api/quote/%5EBVSP?token=anonymous',
    { signal: AbortSignal.timeout(5000) }
  );
  const data = await res.json();
  const ativo = data.results?.[0];
  if (!ativo) throw new Error('Sem dados do Ibovespa');
  return {
    pontos: ativo.regularMarketPrice?.toLocaleString('pt-BR') ?? '—',
    variacao: ativo.regularMarketChangePercent?.toFixed(2) ?? '0'
  };
}
