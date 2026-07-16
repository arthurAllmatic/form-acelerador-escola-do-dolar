// Geração automática de logo via OpenAI.
// Chamada pelo fase2 ao concluir o briefing (fire-and-forget).
// A OPENAI_API_KEY vive em variável de ambiente do Vercel — nunca no client.

const SUPABASE_URL = "https://wiktreeseddzzhbsbwkz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpa3RyZWVzZWRkenpoYnNid2t6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5NDkwMDgsImV4cCI6MjA3NzUyNTAwOH0.U-X9n-SK0zLC7ZU_RBXYvXjRpLTnOAqTWJxMOmY5JFk";
const SB_HEADERS = { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY };

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "use POST" });

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY não configurada no Vercel" });
    }
    const { lead_id, respostas = {}, email = "", lead_id_origem = null, force = false } = req.body || {};
    if (!lead_id) return res.status(400).json({ error: "lead_id obrigatório" });

    // Se já tem logo gerada, não gera de novo (a não ser com force:true)
    const atual = await lerLead(lead_id);
    const base = (atual && atual.respostas) || {};
    if (!force && base.logo_gerada_url) {
      return res.status(200).json({ ok: true, ja_existia: true, url: base.logo_gerada_url });
    }

    // O briefing do banco manda (pode ter sido editado no painel); o body só completa
    const dados = { ...respostas, ...base };
    // Ajustes pedidos no chat do painel entram no prompt
    const ajustes = (Array.isArray(base.logo_chat) ? base.logo_chat : [])
      .map(m => (m && m.texto ? String(m.texto).trim() : "")).filter(Boolean);

    // Nicho vem do lead de origem (reconhecimento), por id ou por e-mail
    const nicho = await buscarNicho(lead_id_origem || base.lead_id_origem, email);

    const prompt = montarPrompt(dados, nicho, ajustes);
    const pngBase64 = await gerarImagem(prompt, "gpt-image-1");

    // Sobe no bucket público "logos" — nome versionado pra preservar o histórico
    const path = `${encodeURIComponent(lead_id)}-${Date.now()}.png`;
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/logos/${path}`, {
      method: "POST",
      headers: { ...SB_HEADERS, "Content-Type": "image/png", "x-upsert": "true" },
      body: Buffer.from(pngBase64, "base64"),
    });
    if (!up.ok) throw new Error("upload storage: " + (await up.text()));
    const url = `${SUPABASE_URL}/storage/v1/object/public/logos/${path}`;

    // Grava o link no lead (merge das respostas pra não perder nada)
    const agora = new Date().toISOString();
    // Histórico: guarda cada geração (url + prompt + ajustes usados). Mantém as 10 últimas.
    const hist = (Array.isArray(base.logo_historico) ? base.logo_historico : []).slice(-9);
    hist.push({ url, prompt, em: agora, ajustes });
    const novas = { ...dados, logo_prompt: prompt, logo_gerada_url: url, logo_gerada_em: agora, logo_historico: hist };
    delete novas.logo_erro; delete novas.logo_erro_em; // deu certo: limpa erro anterior
    const patch = await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${encodeURIComponent(lead_id)}`, {
      method: "PATCH",
      headers: { ...SB_HEADERS, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ respostas: novas, atualizado_em: new Date().toISOString() }),
    });
    if (!patch.ok) throw new Error("update lead: " + (await patch.text()));

    return res.status(200).json({ ok: true, url });
  } catch (e) {
    const msg = String((e && e.message) || e);
    // Grava o erro no lead pra aparecer no painel (sem derrubar a resposta)
    try {
      const lid = (req.body && (typeof req.body === "string" ? JSON.parse(req.body) : req.body).lead_id) || null;
      if (lid) {
        const at = await lerLead(lid);
        const rr = (at && at.respostas) || {};
        await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${encodeURIComponent(lid)}`, {
          method: "PATCH",
          headers: { ...SB_HEADERS, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ respostas: { ...rr, logo_erro: msg.slice(0, 300), logo_erro_em: new Date().toISOString() } }),
        });
      }
    } catch (_) {}
    return res.status(500).json({ error: msg });
  }
};

async function lerLead(id) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${encodeURIComponent(id)}&select=id,respostas`, { headers: SB_HEADERS });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

async function buscarNicho(origemId, email) {
  let origem = null;
  if (origemId) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${encodeURIComponent(origemId)}&select=respostas`, { headers: SB_HEADERS });
    if (r.ok) origem = (await r.json())[0] || null;
  }
  if (!origem && email) {
    const q = encodeURIComponent(email.trim());
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/leads?email=ilike.${q}&formulario=eq.reconhecimento&order=atualizado_em.desc&limit=1&select=respostas`,
      { headers: SB_HEADERS }
    );
    if (r.ok) origem = (await r.json())[0] || null;
  }
  const resp = (origem && origem.respostas) || {};
  const nicho = resp.nicho || resp.categoria || null;
  if (!nicho || /escolha/i.test(nicho)) return null; // "Escolha pra mim" não vira nicho
  return String(nicho).replace(/^[^\wÀ-ÿ]+/u, "").trim(); // tira o emoji
}

function montarPrompt(r, nicho, ajustes) {
  const loja = (r.nome_loja || "").trim() || "a loja";
  const p = [`Crie uma logo profissional para a loja online "${loja}"`];
  if (nicho) p[0] += `, do nicho de ${nicho.toLowerCase()}`;
  p[0] += ".";
  if (r.estilo) p.push(`Estilo visual: ${String(r.estilo).toLowerCase()}.`);
  if (r.cor_logo) p.push(`Cores da logo: ${String(r.cor_logo).trim()} — use SOMENTE essas cores nos elementos da logo.`);
  if (Array.isArray(r.sensacao) && r.sensacao.length) p.push(`A marca deve transmitir ${r.sensacao.join(" e ").toLowerCase()}.`);
  if ((r.conta_mais || "").trim()) p.push(`Observações do cliente: ${String(r.conta_mais).trim()}.`);
  // Ajustes pedidos pelo aluno (chat do painel) — os mais recentes têm prioridade
  if (Array.isArray(ajustes) && ajustes.length) {
    p.push(`AJUSTES PEDIDOS PELO CLIENTE (siga todos; em caso de conflito, o último vale): ${ajustes.map((a, i) => `(${i + 1}) ${a}`).join(" ")}.`);
  }
  p.push(`Requisitos: o nome "${loja}" bem legível como elemento principal com um símbolo simples acima ou ao lado, estilo vetorial flat com traços nítidos e bem definidos, alto contraste, design limpo e memorável, fundo 100% transparente (sem cor de fundo, sem gradiente de fundo), sem slogan e sem textos extras, adequado para um e-commerce premium de saúde e bem-estar voltado ao público europeu.`);
  return p.join(" ");
}

async function gerarImagem(prompt, model, erroAnterior) {
  // Sem response_format: gpt-image-1 já devolve b64_json e o dall-e-3 devolve url
  // (tratada logo abaixo). Passar response_format faz a API rejeitar a chamada.
  const body = { model, prompt, n: 1, size: "1024x1024" };
  if (model === "gpt-image-1") { body.background = "transparent"; body.quality = "high"; }
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) {
    const msg = (j.error && j.error.message) || ("OpenAI HTTP " + r.status);
    // gpt-image-1 pode exigir verificação da org — cai pro dall-e-3
    if (model === "gpt-image-1") return gerarImagem(prompt, "dall-e-3", msg);
    throw new Error(`dall-e-3: ${msg}` + (erroAnterior ? ` | gpt-image-1: ${erroAnterior}` : ""));
  }
  const d = j.data && j.data[0];
  if (d && d.b64_json) return d.b64_json;
  if (d && d.url) {
    const ir = await fetch(d.url);
    return Buffer.from(await ir.arrayBuffer()).toString("base64");
  }
  throw new Error("resposta da OpenAI sem imagem");
}
