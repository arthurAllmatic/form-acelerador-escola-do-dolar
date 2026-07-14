// Serverless function (Vercel) — atualiza o card do lead no GHL conforme o form.
// Recebe POST { fase, status, nome, email, whatsapp, respostas } e:
//  - acha a oportunidade JÁ existente do contato no pipeline "3 - Onboarding Acelerador"
//  - move a etapa
//  - cria tarefa pra Angélica (quando previsto)
//
// Config por variáveis de ambiente no Vercel (NUNCA no código):
//   GHL_TOKEN        -> Private Integration token (Contacts + Opportunities)  [SECRETO]
//   GHL_LOCATION_ID  -> id da location (fica na URL do GHL, não é secreto)
//   GHL_PIPELINE_NAME (opcional, default abaixo)
//   GHL_ASSIGNEE_NAME (opcional, default abaixo)

const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
const PIPELINE_NAME = process.env.GHL_PIPELINE_NAME || "3 - Onboarding Acelerador";
const ASSIGNEE_NAME = process.env.GHL_ASSIGNEE_NAME || "Angelica";

// (fase, status) -> etapa alvo + tarefa
const ACTIONS = {
  "fase1|novo_lead":  { stage: "Formulário / Dados Coletados" },
  "fase1|concluido":  { stage: "Loja em Produção",  task: { title: "Enviar link da Fase 2 (Sua Logo) pro lead" } },
  "fase2|concluido":  { stage: "Loja em ativação",  task: { title: "Enviar link da Fase 3 pro lead", dueInDays: 1 } },
  "fase3|concluido":  { stage: "Loja Entregue",     task: { title: "Enviar link da Fase 4 pro lead" } },
  "fase4|concluido":  { stage: "Domínio Acompanhado", task: { title: "Vender Hostgator pro lead", dueInDays: 1 } }
};

const norm = s => (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const digits = s => (s || "").replace(/\D/g, "");

function headers(){
  return {
    Authorization: "Bearer " + process.env.GHL_TOKEN,
    Version: VERSION,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
}
async function api(path, opts = {}){
  const r = await fetch(BASE + path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch(e){ json = { raw: text }; }
  return { ok: r.ok, status: r.status, json };
}

let CACHE = { at: 0, pipeline: null, stages: null, assignee: null };
async function loadConfig(loc){
  if (Date.now() - CACHE.at < 5 * 60 * 1000 && CACHE.pipeline) return CACHE;
  const p = await api(`/opportunities/pipelines?locationId=${loc}`);
  const pipelines = (p.json && p.json.pipelines) || [];
  const pipeline = pipelines.find(x => norm(x.name) === norm(PIPELINE_NAME))
                || pipelines.find(x => norm(x.name).includes(norm(PIPELINE_NAME)))
                || pipelines.find(x => norm(PIPELINE_NAME).includes(norm(x.name)));
  const stages = pipeline ? pipeline.stages || [] : [];

  let assignee = null;
  const u = await api(`/users/?locationId=${loc}`);
  const users = (u.json && u.json.users) || [];
  assignee = users.find(x => norm(`${x.firstName||""} ${x.lastName||""} ${x.name||""}`).includes(norm(ASSIGNEE_NAME)));

  CACHE = { at: Date.now(), pipeline, stages, assignee, pipelinesCount: pipelines.length, usersCount: users.length };
  return CACHE;
}
function stageId(stages, name){
  const s = stages.find(x => norm(x.name) === norm(name))
         || stages.find(x => norm(x.name).includes(norm(name)))
         || stages.find(x => norm(name).includes(norm(x.name)));
  return s ? (s.id) : null;
}

async function findContact(loc, email, phone){
  const tryQuery = async q => {
    if (!q) return null;
    const r = await api(`/contacts/?locationId=${loc}&query=${encodeURIComponent(q)}&limit=20`);
    return (r.json && r.json.contacts) || [];
  };
  let list = await tryQuery(email);
  let c = (list || []).find(x => email && norm(x.email) === norm(email));
  if (!c && phone) {
    list = await tryQuery(phone);
    const pd = digits(phone).slice(-8);
    c = (list || []).find(x => digits(x.phone).slice(-8) === pd);
  }
  if (!c && list && list.length) c = list[0];
  return c || null;
}

async function findOpportunity(loc, contactId, pipelineId){
  const r = await api(`/opportunities/search?location_id=${loc}&contact_id=${contactId}&limit=50`);
  const opps = (r.json && r.json.opportunities) || [];
  return opps.find(o => o.pipelineId === pipelineId) || opps[0] || null;
}

export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const loc = process.env.GHL_LOCATION_ID;
  if (!process.env.GHL_TOKEN || !loc)
    return res.status(200).json({ ok:false, error:"faltando GHL_TOKEN ou GHL_LOCATION_ID nas env vars do Vercel" });

  // GET = diagnóstico rápido: /api/ghl?debug=1
  if (req.method === "GET"){
    try {
      const cfg = await loadConfig(loc);
      return res.status(200).json({
        ok:true, diagnostico:true,
        pipeline: cfg.pipeline ? cfg.pipeline.name : null,
        pipeline_encontrado: !!cfg.pipeline,
        etapas: (cfg.stages||[]).map(s=>s.name),
        angelica_encontrada: !!cfg.assignee,
        angelica: cfg.assignee ? `${cfg.assignee.firstName||""} ${cfg.assignee.lastName||""}`.trim() : null,
        pipelines_na_conta: cfg.pipelinesCount, usuarios_na_conta: cfg.usersCount
      });
    } catch(e){ return res.status(200).json({ ok:false, error:String(e) }); }
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body||"{}") : (req.body||{});
    const fase = norm(body.fase);
    const status = norm(body.status);
    const action = ACTIONS[`${fase}|${status}`];
    if (!action) return res.status(200).json({ ok:true, skipped:true, motivo:`sem regra para ${fase}|${status}` });

    const cfg = await loadConfig(loc);
    if (!cfg.pipeline) return res.status(200).json({ ok:false, error:`pipeline "${PIPELINE_NAME}" não encontrado` });

    const contact = await findContact(loc, (body.email||"").trim(), body.whatsapp||"");
    if (!contact) return res.status(200).json({ ok:true, skipped:true, motivo:"contato não encontrado no GHL", email:body.email, whatsapp:body.whatsapp });

    const result = { contactId: contact.id, etapa: action.stage, moved:false, task:false };

    // move a etapa da oportunidade existente
    const opp = await findOpportunity(loc, contact.id, cfg.pipeline.id);
    const sid = stageId(cfg.stages, action.stage);
    if (opp && sid){
      const up = await api(`/opportunities/${opp.id}`, { method:"PUT", body: JSON.stringify({ pipelineId: cfg.pipeline.id, pipelineStageId: sid }) });
      result.moved = up.ok; result.oppId = opp.id;
      if (!up.ok) result.moveErr = up.json;
    } else {
      result.moveErr = opp ? `etapa "${action.stage}" não encontrada` : "oportunidade não encontrada nesse pipeline";
    }

    // cria tarefa pra Angélica — prazo 24h e sem duplicar (se já existe uma aberta igual, pula)
    if (action.task){
      const due = new Date();
      due.setDate(due.getDate() + (action.task.dueInDays || 1)); // prazo padrão: 24h
      const existing = await api(`/contacts/${contact.id}/tasks`);
      const tasks = (existing.json && existing.json.tasks) || [];
      const dup = tasks.find(t => norm(t.title) === norm(action.task.title) && !t.completed);
      if (dup){
        result.task = "ja_existia";
        result.taskId = dup.id;
      } else {
        const t = {
          title: action.task.title,
          body: `Lead: ${body.nome||""} — ${body.email||""} ${body.whatsapp||""}`.trim(),
          dueDate: due.toISOString(),
          completed: false
        };
        if (cfg.assignee) t.assignedTo = cfg.assignee.id;
        const tr = await api(`/contacts/${contact.id}/tasks`, { method:"POST", body: JSON.stringify(t) });
        result.task = tr.ok;
        if (!tr.ok) result.taskErr = tr.json;
      }
    }

    return res.status(200).json({ ok:true, ...result });
  } catch(e){
    return res.status(200).json({ ok:false, error:String(e) });
  }
}
