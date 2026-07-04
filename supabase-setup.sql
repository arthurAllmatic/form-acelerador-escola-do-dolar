-- =====================================================================
-- Escola do Dólar · Acelerador — setup do Supabase
-- Rodar no SQL Editor do projeto Supabase (uma vez).
-- Cria a tabela `leads` usada pelos 4 forms e pelo painel /admin.
-- =====================================================================

create table if not exists public.leads (
  id            text primary key,            -- uuid gerado por sessão no form
  fase          text,                        -- fase1 | fase2 | fase3
  formulario    text,                        -- reconhecimento | briefing_logo | como_vai_receber
  status        text,                        -- novo_lead | em_andamento | concluido
  step          integer,                     -- número da última etapa respondida
  nome          text,
  email         text,
  whatsapp      text,
  respostas     jsonb default '{}'::jsonb,   -- respostas do form (pode conter logo_base64)
  criado_em     timestamptz default now(),
  atualizado_em timestamptz default now()
);

create index if not exists leads_atualizado_em_idx on public.leads (atualizado_em desc);
create index if not exists leads_formulario_idx on public.leads (formulario);

alter table public.leads enable row level security;

-- Sem login por enquanto: anon pode inserir, atualizar e ler.
-- (Trocar por Supabase Auth depois — a chave anon fica exposta no front.)
drop policy if exists "anon pode inserir" on public.leads;
create policy "anon pode inserir" on public.leads
  for insert to anon with check (true);

drop policy if exists "anon pode atualizar" on public.leads;
create policy "anon pode atualizar" on public.leads
  for update to anon using (true) with check (true);

drop policy if exists "anon pode ler" on public.leads;
create policy "anon pode ler" on public.leads
  for select to anon using (true);
