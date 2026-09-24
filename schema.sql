create table if not exists projects (
  id text primary key,
  user_id text,
  title text,
  r2_key text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists agent_messages (
  id text primary key,
  project_id text not null,
  role text not null,
  content text not null,
  selection_json text,
  operations_json text,
  created_at text not null
);
