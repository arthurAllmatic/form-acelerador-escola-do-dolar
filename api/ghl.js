// Serverless function (Vercel) — atualiza o card do lead no GHL conforme o form.
// Recebe POST { fase, status, nome, email, whatsapp, respostas, nota } e, para CADA
// workspace GHL configurado (comercial + suporte):
//  - acha a oportunidade do contato no pipeline "Onboarding Acelerador"
//  - move a etapa (ou CRIA o card, no workspace que permite)
//  - cria tarefa pra atendente (quando previsto) + nota da fase
//
// Config por variáveis de ambiente no Vercel (NUNCA no código):
//   Workspace COMERCIAL (original):
//     GHL_TOKEN                 -> Private Integration token  [SECRETO]
//     GHL_LOCATION_ID           -> id da location (não é secreto)
//     GHL_PIPELINE_NAME         (opcional, default "3 - Onboarding Acelerador")
//     GHL_ASSIGNEE_NAME         (opcional, default "Ritiele")
//   Workspace SUPORTE (novo — cria card se não existir):
//     GHL_TOKEN_SUPORTE         -> Private Integration token do suporte  [SECRETO]
//     GHL_LOCATION_ID_SUPORTE   -> id da location do suporte
//     GHL_PIPELINE_NAME_SUPORTE (opcional, default "Onboarding Acelerador")
//     GHL_ASSIGNEE_NAME_SUPORTE (opcional, default = GHL_ASSIGNEE_NAME || "Ritiele")

const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

// (fase, status) -> etapa alvo + tarefa (mesmas regras nos dois workspaces)
const ACTIONS = {
  "fase1|novo_lead":  { stage: "Formulário / Dados Coletados" },
  "fase1|concluido":  { stage: "Loja em Produção",  task: { title: "Enviar link da Fase 2 (Sua Logo) pro lead" } },
  "fase2|concluido":  { stage: "Loja em ativação",  task: { title: "Enviar link da Fase 3 pro lead", dueInDays: 1 } },
  "fase3|concluido":  { stage: "Loja Entregue",     task: { title: "Enviar link da Fase 4 pro lead" } },
  "fase4|concluido":  { stage: "Domínio Acompanhado", task: { title: "Vender Hostgator pro lead", dueInDays: 1 } }
};

// A oportunidade só fica "won" (ganho) na etapa final; qualquer outra etapa = "open".
// Assim toda movimentação TIRA o ganho se o card estiver marcado por engano.
const WON_STAGE = "Onboarding Concluído";

const norm = s => (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const digits = s => (s || "").replace(/\D/g, "");
const statusForStage = stage => norm(stage) === norm(WON_STAGE) ? "won" : "open";

// Lista de workspaces GHL ativos (só entra quem tiver token+location nas env vars)
function targets(){
  const list = [];
  if (process.env.GHL_TOKEN && process.env.GHL_LOCATION_ID){
    list.push({
      key: "comercial",
      token: process.env.GHL_TOKEN,
      loc: process.env.GHL_LOCATION_ID,
      pipelineName: process.env.GHL_PIPELINE_NAME || "3 - Onboarding Acelerador",
      assigneeName: process.env.GHL_ASSIGNEE_NAME || "Ritiele",
      createIfMissing: false // só move o card que já existe
    });
  }
  if (process.env.GHL_TOKEN_SUPORTE && process.env.GHL_LOCATION_ID_SUPORTE){
    list.push({
      key: "suporte",
      token: process.env.GHL_TOKEN_SUPORTE,
      loc: process.env.GHL_LOCATION_ID_SUPORTE,
      pipelineName: process.env.GHL_PIPELINE_NAME_SUPORTE || "Onboarding Acelerador",
      assigneeName: process.env.GHL_ASSIGNEE_NAME_SUPORTE || process.env.GHL_ASSIGNEE_NAME || "Ritiele",
      createIfMissing: true // cria contato + card se ainda não existir nesse workspace
    });
  }
  return list;
}

function headers(token){
  return {
    Authorization: "Bearer " + token,
    Version: VERSION,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
}
async function api(t, path, opts = {}){
  const r = await fetch(BASE + path, { ...opts, headers: { ...headers(t.token), ...(opts.headers || {}) } });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch(e){ json = { raw: text }; }
  return { ok: r.ok, status: r.status, json };
}

// cache de config por workspace (chave = location + nome do pipeline)
const CACHE = {};
async function loadConfig(t){
  const ck = `${t.loc}|${t.pipelineName}`;
  const hit = CACHE[ck];
  if (hit && Date.now() - hit.at < 5 * 60 * 1000 && hit.pipeline) return hit;

  const p = await api(t, `/opportunities/pipelines?locationId=${t.loc}`);
  const pipelines = (p.json && p.json.pipelines) || [];
  const pipeline = pipelines.find(x => norm(x.name) === norm(t.pipelineName))
                || pipelines.find(x => norm(x.name).includes(norm(t.pipelineName)))
                || pipelines.find(x => norm(t.pipelineName).includes(norm(x.name)));
  const stages = pipeline ? pipeline.stages || [] : [];

  const u = await api(t, `/users/?locationId=${t.loc}`);
  const users = (u.json && u.json.users) || [];
  const assignee = users.find(x => norm(`${x.firstName||""} ${x.lastName||""} ${x.name||""}`).includes(norm(t.assigneeName)));

  const cfg = { at: Date.now(), pipeline, stages, assignee, pipelinesCount: pipelines.length, usersCount: users.length };
  CACHE[ck] = cfg;
  return cfg;
}
function stageId(stages, name){
  const s = stages.find(x => norm(x.name) === norm(name))
         || stages.find(x => norm(x.name).includes(norm(name)))
         || stages.find(x => norm(name).includes(norm(x.name)));
  return s ? (s.id) : null;
}

async function findContact(t, email, phone){
  const tryQuery = async q => {
    if (!q) return null;
    const r = await api(t, `/contacts/?locationId=${t.loc}&query=${encodeURIComponent(q)}&limit=20`);
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

// acha o contato; se não existir e o workspace permitir, cria (upsert por e-mail/telefone)
async function findOrCreateContact(t, body){
  let contact = await findContact(t, (body.email||"").trim(), body.whatsapp||"");
  if (contact) return { contact, created: false };
  if (!t.createIfMissing) return { contact: null, created: false };
  if (!body.email && !body.whatsapp) return { contact: null, created: false };

  const payload = { locationId: t.loc, source: "Onboarding Acelerador (form)" };
  if ((body.email||"").trim())    payload.email = (body.email||"").trim();
  if ((body.whatsapp||"").trim()) payload.phone = (body.whatsapp||"").trim();
  if ((body.nome||"").trim())     { payload.firstName = (body.nome||"").trim(); payload.name = (body.nome||"").trim(); }

  const r = await api(t, `/contacts/upsert`, { method:"POST", body: JSON.stringify(payload) });
  const c = (r.json && (r.json.contact || (r.json.id ? r.json : null))) || null;
  return { contact: c, created: !!c, upsertErr: c ? null : r.json };
}

async function findOpportunity(t, contactId, pipelineId){
  const r = await api(t, `/opportunities/search?location_id=${t.loc}&contact_id=${contactId}&limit=50`);
  const opps = (r.json && r.json.opportunities) || [];
  return opps.find(o => o.pipelineId === pipelineId) || opps[0] || null;
}

// roda a regra (mover/criar card + tarefa + nota) em UM workspace
async function processTarget(t, body, action, status){
  const result = { workspace: t.key, etapa: action.stage, moved:false, task:false };

  const cfg = await loadConfig(t);
  if (!cfg.pipeline){ result.error = `pipeline "${t.pipelineName}" não encontrado`; return result; }

  const { contact, created, upsertErr } = await findOrCreateContact(t, body);
  if (!contact){
    result.skipped = true;
    result.motivo = t.createIfMissing ? "não consegui achar/criar o contato" : "contato não encontrado no GHL";
    if (upsertErr) result.upsertErr = upsertErr;
    return result;
  }
  result.contactId = contact.id;
  if (created) result.contatoCriado = true;

  // mover a etapa da oportunidade existente — ou criar o card (workspace suporte)
  const sid = stageId(cfg.stages, action.stage);
  const opp = await findOpportunity(t, contact.id, cfg.pipeline.id);
  if (!sid){
    result.moveErr = `etapa "${action.stage}" não encontrada`;
  } else if (opp){
    const oppBody = { pipelineId: cfg.pipeline.id, pipelineStageId: sid, status: statusForStage(action.stage) };
    if (cfg.assignee) oppBody.assignedTo = cfg.assignee.id;
    const up = await api(t, `/opportunities/${opp.id}`, { method:"PUT", body: JSON.stringify(oppBody) });
    result.moved = up.ok; result.oppId = opp.id;
    if (!up.ok) result.moveErr = up.json;
  } else if (t.createIfMissing){
    const create = {
      pipelineId: cfg.pipeline.id,
      locationId: t.loc,
      pipelineStageId: sid,
      contactId: contact.id,
      name: (body.nome || body.email || "Lead").trim(),
      status: statusForStage(action.stage)
    };
    if (cfg.assignee) create.assignedTo = cfg.assignee.id;
    const cr = await api(t, `/opportunities/`, { method:"POST", body: JSON.stringify(create) });
    result.moved = cr.ok; result.cardCriado = cr.ok;
    result.oppId = cr.json && cr.json.opportunity && cr.json.opportunity.id;
    if (!cr.ok) result.moveErr = cr.json;
  } else {
    result.moveErr = "oportunidade não encontrada nesse pipeline";
  }

  // tarefa pra atendente — prazo 24h e sem duplicar
  if (action.task){
    const due = new Date();
    due.setDate(due.getDate() + (action.task.dueInDays || 1));
    const existing = await api(t, `/contacts/${contact.id}/tasks`);
    const tasks = (existing.json && existing.json.tasks) || [];
    const dup = tasks.find(x => norm(x.title) === norm(action.task.title) && !x.completed);
    if (dup){
      result.task = "ja_existia";
      result.taskId = dup.id;
    } else {
      const task = {
        title: action.task.title,
        body: `Lead: ${body.nome||""} — ${body.email||""} ${body.whatsapp||""}`.trim(),
        dueDate: due.toISOString(),
        completed: false
      };
      if (cfg.assignee) task.assignedTo = cfg.assignee.id;
      const tr = await api(t, `/contacts/${contact.id}/tasks`, { method:"POST", body: JSON.stringify(task) });
      result.task = tr.ok;
      if (!tr.ok) result.taskErr = tr.json;
    }
  }

  // UMA nota por fase — só no concluído, com perguntas+respostas, sem duplicar
  if (status === "concluido" && body.nota){
    const primeira = norm((body.nota.split("\n")[0] || ""));
    const ex = await api(t, `/contacts/${contact.id}/notes`);
    const notes = (ex.json && ex.json.notes) || [];
    const jaTem = primeira && notes.some(nt => norm((nt.body || "").split("\n")[0]) === primeira);
    if (jaTem){
      result.nota = "ja_existia";
    } else {
      const nr = await api(t, `/contacts/${contact.id}/notes`, { method:"POST", body: JSON.stringify({ body: body.nota }) });
      result.nota = nr.ok;
      if (!nr.ok) result.notaErr = nr.json;
    }
  }

  return result;
}

export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const ts = targets();
  if (!ts.length)
    return res.status(200).json({ ok:false, error:"nenhum workspace GHL configurado (faltam GHL_TOKEN/GHL_LOCATION_ID nas env vars)" });

  // GET = diagnóstico. ?debug=1 (config de cada workspace) ou ?email=... (etapa atual do card)
  if (req.method === "GET"){
    try {
      const email = req.query && req.query.email;
      const workspaces = [];
      for (const t of ts){
        const cfg = await loadConfig(t);
        const info = {
          workspace: t.key,
          pipeline: cfg.pipeline ? cfg.pipeline.name : null,
          pipeline_encontrado: !!cfg.pipeline,
          etapas: (cfg.stages||[]).map(s=>s.name),
          cria_card_se_faltar: t.createIfMissing,
          atendente_encontrado: !!cfg.assignee,
          atendente: cfg.assignee ? `${cfg.assignee.firstName||""} ${cfg.assignee.lastName||""}`.trim() : null,
          pipelines_na_conta: cfg.pipelinesCount, usuarios_na_conta: cfg.usersCount
        };
        if (email){
          const contact = await findContact(t, email, (req.query.whatsapp)||"");
          info.contato_encontrado = !!contact;
          if (contact){
            const opp = await findOpportunity(t, contact.id, cfg.pipeline && cfg.pipeline.id);
            info.oportunidade_encontrada = !!opp;
            if (opp){
              const st = (cfg.stages||[]).find(s => s.id === opp.pipelineStageId);
              info.etapa_atual = st ? st.name : opp.pipelineStageId;
            }
          }
        }
        workspaces.push(info);
      }
      return res.status(200).json({ ok:true, diagnostico:true, email: email||undefined, workspaces });
    } catch(e){ return res.status(200).json({ ok:false, error:String(e) }); }
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body||"{}") : (req.body||{});
    const fase = norm(body.fase);
    const status = norm(body.status);
    const action = ACTIONS[`${fase}|${status}`];
    if (!action) return res.status(200).json({ ok:true, skipped:true, motivo:`sem regra para ${fase}|${status}` });

    // roda a mesma regra em todos os workspaces configurados (um erro num não derruba o outro)
    const workspaces = [];
    for (const t of ts){
      try { workspaces.push(await processTarget(t, body, action, status)); }
      catch(e){ workspaces.push({ workspace: t.key, error: String(e) }); }
    }
    return res.status(200).json({ ok:true, etapa: action.stage, workspaces });
  } catch(e){
    return res.status(200).json({ ok:false, error:String(e) });
  }
}
